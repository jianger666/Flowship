"use strict";
/**
 * R7 真 Electron：「点本地 HTML 默认在内置浏览器打开」的端到端行为。
 *
 * 真 manager + 真 `browser:serveLocalHtml` / `browser:newTab` IPC 处理器（经记录式 ipcMain 直接调）+ 真 loopback 静态服务 + 真 Chromium 标签。
 * origin 模型（R7-07）：每次登记一个 token，URL = `http://<48 位小写 hex token>.localhost:<随机端口>/<入口文件名>`——**每个 token 是独立 origin**，
 * 路径相对该 token 的目录（根绝对路径 `/assets/x.js` 能用）。本脚本验证（括号里是验证的事实，不是推测）：
 * - 登记 → 新标签打开该 URL（不是 file:、不是 Flowship 自己的地址；`*.localhost` 在真 Chromium 里确实能解析并加载）
 * - 页面里的相对 / 根绝对 CSS · JS · 图片 · 子页都加载成功；AI 的 `browser_snapshot` 能读到页面内容并能点子页链接；`<audio>` 经 Range 能读到时长
 * - 跨 token 隔离：两个 token 的 localStorage / cookie 互不可见（同一标签依次打开 A → B → A）；A 页面读不到 B 的资源（fetch / 图片）
 * - 页面内 fetch：`../` 逃逸、`/../`、根绝对 `/.env`、`.env`、`.git/`、`*.pem`、`id_rsa*`、符号链接逃逸（文件 / 目录）全 404
 * - 原始 HTTP（绕开浏览器的 URL 归一化）：`%2e%2e` / `..%2f` / 反斜杠 / 目录 / 根 / POST / PUT 全拒；
 *   Host 变体（旧式 127.0.0.1、localhost、域名、无端口、错端口、前导零端口、大写 token、尾点、前后缀拼接、未知 token、[::1]、缺 Host）全拒；
 *   `Sec-Fetch-Site: cross-site` 拒、same-origin 放行；Range：单段 206 / 越界 416 / 多段·非法 200 / HEAD 无视 Range
 * - 同端口同时监听 `[::1]`（本机支持 IPv6 时）
 * - 页面对 Flowship 地址的跨端口请求带着 `Sec-Fetch-Site: same-site` / `cross-site`（Flowship 中间件据此 403，这里只验证请求头是预期的）
 * - 过宽目录（OS 临时目录根）退化为单文件：同目录的兄弟文件取不到
 * - 敏感 / 非 HTML 入口登记被拒；`file:` 仍被内置浏览器的 URL 策略拒绝；AI 导航到 Flowship 的地址（含 `<token>.localhost:<Flowship 端口>`、
 *   8676 / 8776 / 8876）仍被拦（红线没松）
 * - manager.destroy() 后服务关闭、URL 不可达
 *
 * 只能经启动器运行：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r7-local-html.cjs --timeout 150
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog, Menu, clipboard, shell } = require("electron");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-r7-")));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** 0.5 秒 8kHz 单声道 16-bit 静音 WAV（<audio> 经 Range 读时长用） */
const makeWav = () => {
  const samples = 4000;
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

/** 建 fixture：site/（页面所在目录）、outside/（符号链接目标）、site 的上一级放一个 secret.txt（`../secret.txt` 的落点） */
const buildFixture = () => {
  const fix = path.join(TMP, "fix");
  const site = path.join(fix, "site");
  const outside = path.join(fix, "outside");
  fs.mkdirSync(path.join(site, "sub"), { recursive: true });
  fs.mkdirSync(path.join(site, ".git"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(
    path.join(site, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>R7 页面</title><link rel="stylesheet" href="style.css"></head>
<body><h1 id="h">本地 HTML 标题</h1><img id="im" src="img.png" alt="pic"><p id="js">js-pending</p><p id="rootabs">rootabs-pending</p>
<a id="sub" href="sub/page.html">进入子页</a><div id="probe">probe-pending</div>
<script src="/rootabs.js"></script><script src="app.js"></script></body></html>`,
  );
  fs.writeFileSync(path.join(site, "style.css"), "#h{color:rgb(1,2,3)}");
  fs.writeFileSync(path.join(site, "rootabs.js"), "document.getElementById('rootabs').textContent='rootabs-loaded';");
  fs.writeFileSync(path.join(site, "tone.wav"), makeWav());
  fs.writeFileSync(
    path.join(site, "app.js"),
    `(async () => {
  document.getElementById('js').textContent = 'js-loaded';
  const status = async (u) => { try { return (await fetch(u)).status; } catch (e) { return 'ERR'; } };
  const qs = new URLSearchParams(location.search);
  const fs = qs.get('fs') || '';
  const other = qs.get('other') || '';
  let prev = 'n/a', cookieBefore = 'n/a';
  try {
    prev = localStorage.getItem('r7');
    cookieBefore = document.cookie;
    localStorage.setItem('r7', location.hostname);
    document.cookie = 'r7c=' + location.hostname.slice(0, 8) + '; path=/';
  } catch (e) { prev = 'ERR ' + e.name; }
  const audio = () => new Promise((resolve) => {
    const a = new Audio('/tone.wav');
    const t = setTimeout(() => resolve('timeout'), 6000);
    a.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(Math.round(a.duration * 10) / 10); });
    a.addEventListener('error', () => { clearTimeout(t); resolve('ERR'); });
    a.preload = 'auto';
    a.load();
  });
  const img = (u) => new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i.naturalWidth);
    i.onerror = () => resolve('ERR');
    i.src = u;
  });
  const probe = {
    origin: location.origin,
    prev, cookieBefore,
    rootAbs: await status('/rootabs.js'),
    rootEnv: await status('/.env'),
    rootSecret: await status('/secret.txt'),
    rootUp: await status('/../secret.txt'),
    audio: await audio(),
    crossFetch: other ? await status(other) : 'skipped',
    crossImg: other ? await img(other) : 'skipped',
    css: getComputedStyle(document.getElementById('h')).color,
    img: document.getElementById('im').naturalWidth,
    ok: await status('style.css'),
    sub: await status('sub/page.html'),
    up: await status('../secret.txt'),
    env: await status('.env'),
    git: await status('.git/config'),
    pem: await status('key.pem'),
    rsa: await status('id_rsa'),
    linkOut: await status('link-out'),
    linkDir: await status('link-dir/secret.txt'),
    flowship: fs ? await status(fs + '/api/ping') : 'skipped',
  };
  // 每个键一行（snapshot 会把过长的文本节点截断成「…」，所以不能把整个 JSON 塞进一个节点）
  const box = document.getElementById('probe');
  box.textContent = '';
  for (const [k, v] of Object.entries(probe)) {
    const d = document.createElement('p');
    d.textContent = 'PK ' + k + '=' + JSON.stringify(v);
    box.appendChild(d);
  }
  const done = document.createElement('p');
  done.textContent = 'PROBE-DONE';
  box.appendChild(done);
})();`,
  );
  fs.writeFileSync(path.join(site, "sub", "page.html"), `<!doctype html><meta charset="utf-8"><title>子页</title><h2>子页内容 SUBPAGE-OK</h2>`);
  fs.writeFileSync(path.join(site, "img.png"), PNG_1X1);
  fs.writeFileSync(path.join(site, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(site, ".git", "config"), "[core]");
  fs.writeFileSync(path.join(site, "key.pem"), "-----BEGIN PRIVATE KEY-----");
  fs.writeFileSync(path.join(site, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
  fs.writeFileSync(path.join(site, ".hidden.html"), "<p>hidden</p>");
  fs.writeFileSync(path.join(site, "notes.txt"), "not html");
  fs.writeFileSync(path.join(fix, "secret.txt"), "ABOVE-SITE-SECRET");
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET");
  let symlinks = true;
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(site, "link-out"));
    fs.symlinkSync(outside, path.join(site, "link-dir"));
  } catch {
    symlinks = false;
  }
  return { fix, site, outside, symlinks };
};

/** 假的 Flowship：记下收到的每个请求（只看 sec-fetch-site） */
const startFakeFlowship = () =>
  new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url, site: req.headers["sec-fetch-site"] ?? null, mode: req.headers["sec-fetch-mode"] ?? null });
      res.statusCode = 200;
      res.end("flowship");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, hits, port: server.address().port }));
  });

/**
 * 原始 HTTP（不经浏览器的 URL 归一化）：可改 method / Host / 原样路径 / 额外头 / 连接地址；`host: null` = 不发 Host 头。
 * 默认连 127.0.0.1；Host 缺省按 `defaultHost`（调用方给）。
 */
const raw = (port, rawPath, { method = "GET", host, headers = {}, addr = "127.0.0.1", defaultHost } = {}) =>
  new Promise((resolve) => {
    const sock = net.connect(port, addr);
    let buf = "";
    sock.on("connect", () => {
      const h = host === null ? "" : `Host: ${host ?? defaultHost ?? `127.0.0.1:${port}`}\r\n`;
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      sock.write(`${method} ${rawPath} HTTP/1.1\r\n${h}${extra}Connection: close\r\n\r\n`);
    });
    sock.on("data", (d) => (buf += d.toString("latin1")));
    sock.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), text: buf }));
    sock.on("error", () => resolve({ status: 0, text: "" }));
    setTimeout(() => sock.destroy(), 5000);
  });

const portOpen = (port, addr = "127.0.0.1") =>
  new Promise((resolve) => {
    const s = net.connect(port, addr);
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });

/** 本机能不能在 ::1 上监听（决定「同端口 [::1]」那条是断言还是跳过） */
const ipv6Supported = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.on("error", () => resolve(false));
    s.listen(0, "::1", () => s.close(() => resolve(true)));
  });

const TOKEN_HOST_RE = /^http:\/\/([0-9a-f]{48})\.localhost:(\d+)\/index\.html$/;

const main = async () => {
  await app.whenReady();
  const fx = buildFixture();
  const flow = await startFakeFlowship();
  const v6 = await ipv6Supported();
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const appOrigin = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/app-origin.mjs")).href);
  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");

  const handlers = new Map();
  const ipc = {
    handle: (n, f) => void handlers.set(n, f),
    on: () => {},
    removeHandler: (n) => void handlers.delete(n),
    removeListener: () => {},
  };
  // 真实的 isAppUrl（回环别名含 *.localhost + Flowship 端口 + 8676 / 8776 / 8876），不是端口相等的替身
  const isAppUrl = appOrigin.createIsAppUrl(() => flow.port);
  const logs = [];
  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain: ipc,
    nativeImage,
    Menu,
    clipboard,
    shell,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl,
    isTrustedIpcSender: () => true,
    log: (...a) => logs.push(a.join(" ")),
  });
  manager.registerIpc();
  const serve = (p) => handlers.get("browser:serveLocalHtml")({}, p);
  const newTab = (taskId, url) => handlers.get("browser:newTab")({}, taskId, url);

  const T = "r7-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  };
  const refOf = (text, name) => {
    for (const line of text.split("\n")) {
      if (line.includes(name)) {
        const m = /\[ref=(e\d+)\]/.exec(line);
        if (m) return m[1];
      }
    }
    return null;
  };
  const snapshotUntil = async (needle, ms = 15000) => {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < ms) {
      const r = await tryCall("snapshot", {});
      last = r.ok ? r.value.text : `ERR ${r.message}`;
      if (last.includes(needle)) return last;
      await sleep(300);
    }
    return last;
  };
  const readProbe = (snapText) => {
    if (!snapText.includes("PROBE-DONE")) return null;
    const o = {};
    for (const m of snapText.matchAll(/PK (\w+)=(.*)/g)) {
      try {
        o[m[1]] = JSON.parse(m[2]);
      } catch {
        /* 被截断的行：忽略，对应断言会失败 */
      }
    }
    return Object.keys(o).length > 0 ? o : null;
  };

  // ── 1. 登记两个 token（同一个文件 → 两个独立 origin） ──
  const served = await serve(path.join(fx.site, "index.html"));
  const servedB = await serve(path.join(fx.site, "index.html"));
  const mA = served.ok ? TOKEN_HOST_RE.exec(served.url) : null;
  const mB = servedB.ok ? TOKEN_HOST_RE.exec(servedB.url) : null;
  check("r7-serve-ok", "serveLocalHtml 返回 http://<48 位 hex token>.localhost:<端口>/index.html（不是 file:、没有 token 路径段）", !!mA && served.scope === "dir", served);
  check("r7-serve-two-origins", "同一文件再次登记 = 新 token（不同 origin）、同一个服务端口", !!mA && !!mB && mA[1] !== mB[1] && mA[2] === mB[2], { a: served.url, b: servedB.ok && servedB.url });
  if (!mA || !mB) throw new Error(`登记失败 ${JSON.stringify({ served, servedB })}`);
  const port = Number(mA[2]);
  const tokenA = mA[1];
  const tokenB = mB[1];
  const hostA = `${tokenA}.localhost:${port}`;
  const hostB = `${tokenB}.localhost:${port}`;
  check(
    "r7-serve-not-app-origin",
    "URL 不是 Flowship 自己的地址（真 isAppUrl 判 false；端口不是 Flowship 端口 / 8676 / 8776 / 8876）",
    !isAppUrl(served.url) && ![flow.port, 8676, 8776, 8876].includes(port),
    { port, flowshipPort: flow.port },
  );

  // ── 2. 新标签打开 A + 页面加载（A 的页面带上 B 的图片地址，探测跨 token 读取） ──
  const otherUrl = `http://${hostB}/img.png`;
  const tabId = await newTab(T, `${served.url}?fs=${encodeURIComponent(`http://127.0.0.1:${flow.port}`)}&other=${encodeURIComponent(otherUrl)}`);
  check("r7-newtab", "browser:newTab 打开该 URL 返回 tab id（真 Chromium 解析 *.localhost 并加载）", typeof tabId === "string" && tabId.length > 0, tabId);
  const snap = await snapshotUntil("PROBE-DONE");
  check("r7-ai-snapshot", "AI 的 browser_snapshot 能读到页面内容（标题 / 脚本改写的文字 / 子页链接）", /本地 HTML 标题/.test(snap) && /js-loaded/.test(snap) && /进入子页/.test(snap), snap.slice(0, 200));
  const probe = readProbe(snap);
  check("r7-probe-parsed", "页面自检结果可读（snapshot 里有 PROBE-DONE + 每个键一行 PK key=json）", !!probe, probe ? undefined : snap.slice(-1500));
  check("r7-css", "相对 CSS 生效（computed color = rgb(1, 2, 3)）", probe?.css === "rgb(1, 2, 3)", probe?.css);
  check("r7-img", "相对图片加载（naturalWidth = 1）", probe?.img === 1, probe?.img);
  check("r7-js", "相对 JS 加载并执行（文字被改写）", /js-loaded/.test(snap));
  check("r7-root-absolute", "根绝对路径 `/rootabs.js` 能加载并执行（页面里 <script src=\"/rootabs.js\">；fetch 200）", /rootabs-loaded/.test(snap) && probe?.rootAbs === 200, { rootAbs: probe?.rootAbs });
  check("r7-origin-shape", "页面 location.origin = http://<token>.localhost:<端口>（每个 token 一个 origin）", probe?.origin === `http://${hostA}`, probe?.origin);
  check("r7-audio-range", "<audio src=\"/tone.wav\"> 读到时长 0.5（Chromium 经本服务的 Range / 200 取到媒体）", probe?.audio === 0.5, probe?.audio);
  check("r7-storage-first", "token A 首次打开：localStorage / cookie 都是空的（上一个 origin 没有残留）", probe?.prev === null && probe?.cookieBefore === "", { prev: probe?.prev, cookie: probe?.cookieBefore });
  check("r7-cross-token-read", "页面 A 读不到 token B 的资源：fetch → ERR（无 CORS）、<img> → ERR（CORP same-origin）", probe?.crossFetch === "ERR" && probe?.crossImg === "ERR", { crossFetch: probe?.crossFetch, crossImg: probe?.crossImg });
  check("r7-fetch-ok", "同目录资源 / 子目录文件 fetch 200", probe?.ok === 200 && probe?.sub === 200, { ok: probe?.ok, sub: probe?.sub });
  check("r7-fetch-up", "页面 fetch('../secret.txt') / fetch('/../secret.txt') / fetch('/secret.txt')（站点目录之外或不存在）→ 404", probe?.up === 404 && probe?.rootUp === 404 && probe?.rootSecret === 404, { up: probe?.up, rootUp: probe?.rootUp, rootSecret: probe?.rootSecret });
  check("r7-fetch-dot", "页面 fetch('.env') / fetch('/.env') / fetch('.git/config') → 404", probe?.env === 404 && probe?.rootEnv === 404 && probe?.git === 404, { env: probe?.env, rootEnv: probe?.rootEnv, git: probe?.git });
  check("r7-fetch-sensitive", "页面 fetch('key.pem') / fetch('id_rsa') → 404", probe?.pem === 404 && probe?.rsa === 404, { pem: probe?.pem, rsa: probe?.rsa });
  if (fx.symlinks) check("r7-fetch-symlink", "符号链接逃逸（文件 / 目录）→ 404", probe?.linkOut === 404 && probe?.linkDir === 404, { linkOut: probe?.linkOut, linkDir: probe?.linkDir });
  await sleep(300);
  const apiHits = flow.hits.filter((h) => h.url === "/api/ping");
  check(
    "r7-cross-origin-header",
    "页面请求 Flowship 地址：要么被拦、要么带 Sec-Fetch-Site: same-site / cross-site（Flowship 中间件据此 403；绝不是 same-origin / none）",
    apiHits.every((h) => h.site === "same-site" || h.site === "cross-site"),
    { fetchResult: probe?.flowship, hits: apiHits },
  );

  // ── 3. 点子页链接（AI 的 click） ──
  const subRef = refOf(snap, "进入子页");
  if (subRef) await tryCall("click", { ref: subRef });
  const snap2 = await snapshotUntil("SUBPAGE-OK", 8000);
  check("r7-subpage-click", "AI 点页面里的相对链接 → 子页打开并可读", !!subRef && /SUBPAGE-OK/.test(snap2), { subRef });

  // ── 4. 原始 HTTP（绕开浏览器的 URL 归一化） ──
  const rq = (rawPath, opts = {}) => raw(port, rawPath, { defaultHost: hostA, ...opts });
  const rawCases = [
    ["正常入口", `/index.html`, {}, 200],
    ["根绝对资源", `/rootabs.js`, {}, 200],
    ["子目录文件", `/sub/page.html`, {}, 200],
    ["B 的 Host 访问同名文件", `/index.html`, { host: hostB }, 200],
    ["%2e%2e 逃逸", `/%2e%2e/secret.txt`, {}, 404],
    ["..%2f 逃逸", `/..%2fsecret.txt`, {}, 404],
    ["%2e%2e%2f 逃逸", `/%2e%2e%2fsecret.txt`, {}, 404],
    ["反斜杠逃逸", `/..%5Csecret.txt`, {}, 404],
    ["字面 ../ 逃逸", `/../secret.txt`, {}, 404],
    ["站点目录之上的文件", `/secret.txt`, {}, 404],
    [".env", `/.env`, {}, 404],
    [".git/config", `/.git/config`, {}, 404],
    ["id_rsa", `/id_rsa`, {}, 404],
    ["key.pem", `/key.pem`, {}, 404],
    ["目录（不列目录）", `/sub/`, {}, 404],
    ["根（不列目录）", `/`, {}, 404],
    ["老式 token 路径段", `/${tokenA}/index.html`, {}, 404],
    ["POST", `/index.html`, { method: "POST" }, 405],
    ["PUT", `/index.html`, { method: "PUT" }, 405],
    ["Host: 127.0.0.1（老写法）", `/index.html`, { host: `127.0.0.1:${port}` }, 403],
    ["Host: localhost", `/index.html`, { host: `localhost:${port}` }, 403],
    ["Host: 域名", `/index.html`, { host: "evil.example.com" }, 403],
    ["Host: 无端口", `/index.html`, { host: `${tokenA}.localhost` }, 403],
    ["Host: 错端口", `/index.html`, { host: `${tokenA}.localhost:1` }, 403],
    ["Host: 前导零端口", `/index.html`, { host: `${tokenA}.localhost:0${port}` }, 403],
    ["Host: 大写 token", `/index.html`, { host: `${tokenA.toUpperCase()}.localhost:${port}` }, 403],
    ["Host: 尾点", `/index.html`, { host: `${tokenA}.localhost.:${port}` }, 403],
    ["Host: 前缀拼接", `/index.html`, { host: `evil.${tokenA}.localhost:${port}` }, 403],
    ["Host: 后缀拼接", `/index.html`, { host: `${tokenA}.localhost.evil.com:${port}` }, 403],
    ["Host: token 多一位", `/index.html`, { host: `${tokenA}0.localhost:${port}` }, 403],
    ["Host: 未登记的 token", `/index.html`, { host: `${"0".repeat(48)}.localhost:${port}` }, 403],
    ["Host: [::1]", `/index.html`, { host: `[::1]:${port}` }, 403],
    ["Sec-Fetch-Site: cross-site", `/index.html`, { headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
    ["Sec-Fetch-Site: same-origin", `/index.html`, { headers: { "Sec-Fetch-Site": "same-origin" } }, 200],
    ["缺 Host 头", `/index.html`, { host: null }, 400],
  ];
  for (const [name, p, opts, want] of rawCases) {
    const r = await rq(p, opts);
    check(`r7-raw-${name}`, `原始请求「${name}」→ ${want}`, r.status === want, { status: r.status });
  }
  const head = await rq(`/index.html`, { method: "HEAD" });
  check("r7-raw-head", "HEAD 允许（200）", head.status === 200, head.status);
  const okResp = await rq(`/index.html`);
  check("r7-raw-headers", "响应头：nosniff / no-store / CORP same-origin，且没有 CORS 头 / CSP sandbox", /x-content-type-options: nosniff/i.test(okResp.text) && /cache-control: no-store/i.test(okResp.text) && /cross-origin-resource-policy: same-origin/i.test(okResp.text) && !/access-control-allow-origin/i.test(okResp.text) && !/content-security-policy/i.test(okResp.text));
  // Range（wav 一共 44 + 8000 字节）
  const wavSize = 44 + 8000;
  const r206 = await rq(`/tone.wav`, { headers: { Range: "bytes=0-9" } });
  check("r7-range-206", "Range: bytes=0-9 → 206 + Content-Range: bytes 0-9/总长", r206.status === 206 && new RegExp(`content-range: bytes 0-9/${wavSize}`, "i").test(r206.text) && /accept-ranges: bytes/i.test(r206.text), { status: r206.status });
  const r416 = await rq(`/tone.wav`, { headers: { Range: `bytes=${wavSize + 100}-` } });
  check("r7-range-416", "Range 起点越界 → 416 + Content-Range: bytes */总长", r416.status === 416 && new RegExp(`content-range: bytes \\*/${wavSize}`, "i").test(r416.text), { status: r416.status });
  const rMulti = await rq(`/tone.wav`, { headers: { Range: "bytes=0-1,5-6" } });
  const rBad = await rq(`/tone.wav`, { headers: { Range: "bytes=abc" } });
  const rHead = await rq(`/tone.wav`, { method: "HEAD", headers: { Range: "bytes=0-9" } });
  check("r7-range-ignored", "多段 / 非法 Range 当没有 → 200；HEAD 无视 Range → 200", rMulti.status === 200 && rBad.status === 200 && rHead.status === 200, { multi: rMulti.status, bad: rBad.status, head: rHead.status });
  // [::1]：同端口同时监听（本机支持 IPv6 时）
  const six = await rq(`/index.html`, { addr: "::1" });
  check("r7-ipv6-listen", "同端口 [::1] 也在监听（本机 IPv6 可用时 200；不可用时服务只听 IPv4 并打了日志）", v6 ? six.status === 200 : six.status === 0 && logs.some((l) => l.includes("只监听 IPv4")), { ipv6Supported: v6, status: six.status });

  // ── 5. 登记被拒 ──
  const rej = [
    ["敏感（.env）", path.join(fx.site, ".env")],
    ["点开头 html", path.join(fx.site, ".hidden.html")],
    ["非 html", path.join(fx.site, "notes.txt")],
    ["不存在", path.join(fx.site, "nope.html")],
    ["相对路径", "site/index.html"],
  ];
  for (const [name, p] of rej) {
    const r = await serve(p);
    check(`r7-reject-${name}`, `登记被拒：${name}`, r.ok === false, r);
  }

  // ── 6. 过宽目录 → 单文件 ──
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const rnd = `r7-e2e-${process.pid}-${Date.now()}`;
  const broadHtml = path.join(tmpRoot, `${rnd}.html`);
  const broadCss = path.join(tmpRoot, `${rnd}.css`);
  fs.writeFileSync(broadHtml, `<!doctype html><link rel="stylesheet" href="${rnd}.css"><p>broad</p>`);
  fs.writeFileSync(broadCss, "p{color:red}");
  try {
    const b = await serve(broadHtml);
    const bm = b.ok ? /^http:\/\/([0-9a-f]{48})\.localhost:(\d+)\/(.+)$/.exec(b.url) : null;
    check("r7-broad-scope", "OS 临时目录根下的 HTML：scope = file（只放这一个文件）", b.ok && b.scope === "file", b);
    if (bm) {
      const bh = `${bm[1]}.localhost:${bm[2]}`;
      const self = await raw(Number(bm[2]), `/${rnd}.html`, { host: bh });
      const sibling = await raw(Number(bm[2]), `/${rnd}.css`, { host: bh });
      check("r7-broad-sibling", "单文件模式：入口 200、同目录兄弟文件 404", self.status === 200 && sibling.status === 404, { self: self.status, sibling: sibling.status });
    }
  } finally {
    fs.rmSync(broadHtml, { force: true });
    fs.rmSync(broadCss, { force: true });
  }

  // ── 7. AI 的 browser_navigate 对这个服务地址的口径：放行 B；根路径 404；两个 origin 的 localStorage / cookie 互相隔离 ──
  const aiNav = await tryCall("navigate", { url: servedB.url });
  check("r7-ai-navigate-served", "AI 的 browser_navigate 访问该静态服务地址 → 放行（loopback http、非 Flowship origin）", aiNav.ok && aiNav.value?.status === 200, aiNav.ok ? { status: aiNav.value?.status, url: aiNav.value?.url } : aiNav);
  const snapB = await snapshotUntil("PROBE-DONE");
  const probeB = readProbe(snapB);
  check("r7-storage-isolated", "同一标签从 token A 导航到 token B：B 看不到 A 写的 localStorage / cookie（跨 token 存储隔离）", probeB?.prev === null && probeB?.cookieBefore === "" && probeB?.origin === `http://${hostB}`, { prev: probeB?.prev, cookie: probeB?.cookieBefore, origin: probeB?.origin });
  const aiBackA = await tryCall("navigate", { url: served.url });
  const snapA2 = await snapshotUntil("PROBE-DONE");
  const probeA2 = readProbe(snapA2);
  check("r7-storage-persists", "再导航回 token A：A 自己写的 localStorage / cookie 还在（说明上一条的「空」是真隔离、不是存储被禁用）", aiBackA.ok && probeA2?.prev === `${tokenA}.localhost` && String(probeA2?.cookieBefore).includes(`r7c=${tokenA.slice(0, 8)}`), { prev: probeA2?.prev, cookie: probeA2?.cookieBefore });
  const aiRoot = await tryCall("navigate", { url: `http://${hostA}/` });
  check("r7-ai-navigate-root-404", "AI 导航到服务根路径 → 404，没有目录列表", !aiRoot.ok || aiRoot.value?.status === 404, aiRoot.ok ? { status: aiRoot.value?.status } : aiRoot);
  const aiBare = await tryCall("navigate", { url: `http://127.0.0.1:${port}/index.html` });
  check("r7-ai-navigate-bare-ip", "AI 用 127.0.0.1（不是 token 主机名）访问同端口 → 403（Host 校验），没有内容", !aiBare.ok || aiBare.value?.status === 403, aiBare.ok ? { status: aiBare.value?.status } : aiBare);
  const aiFlow = await tryCall("navigate", { url: `http://127.0.0.1:${flow.port}/` });
  check("r7-ai-navigate-flowship-blocked", "AI 导航到 Flowship 自己的地址仍被拦（红线 1 没松）", !aiFlow.ok && aiFlow.code === "URL_BLOCKED", aiFlow);
  const aiFlowLocalhost = await tryCall("navigate", { url: `http://${tokenA}.localhost:${flow.port}/` });
  check("r7-ai-navigate-flowship-tokenhost-blocked", "AI 导航到 <token>.localhost:<Flowship 端口> 也被拦（*.localhost 是回环别名）", !aiFlowLocalhost.ok && aiFlowLocalhost.code === "URL_BLOCKED", aiFlowLocalhost);
  for (const p of [8676, 8776, 8876]) {
    const r = await tryCall("navigate", { url: `http://${tokenA}.localhost:${p}/` });
    check(`r7-ai-navigate-known-port-${p}`, `AI 导航到 <token>.localhost:${p}（其它 Flowship 实例的约定端口）被拦`, !r.ok && r.code === "URL_BLOCKED", r);
  }

  // ── 8. file: 仍被内置浏览器拒绝 ──
  const fileNav = await tryCall("navigate", { url: pathToFileURL(path.join(fx.site, "index.html")).href });
  check("r7-file-url-still-blocked", "AI 导航到 file: 仍被 URL 策略拒绝（这条没松）", !fileNav.ok, fileNav);
  const fileTab = await newTab(T, pathToFileURL(path.join(fx.site, "index.html")).href);
  check("r7-file-url-newtab-blocked", "browser:newTab 给 file: 返回 null", fileTab === null, fileTab);

  // ── 9. destroy ──
  await call("close_session");
  const before = await portOpen(port);
  const before6 = v6 ? await portOpen(port, "::1") : null;
  manager.destroy();
  await sleep(300);
  const after = await portOpen(port);
  const after6 = v6 ? await portOpen(port, "::1") : null;
  check("r7-destroy-closes-server", "manager.destroy() 之后服务关闭、端口不可达（IPv4 / IPv6 都是）", before === true && after === false && (!v6 || (before6 === true && after6 === false)), { before, after, before6, after6 });
  const lateServe = handlers.get("browser:serveLocalHtml");
  check("r7-destroy-removes-ipc", "destroy 之后 IPC 通道已摘掉", lateServe === undefined);

  flow.server.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`SMOKE SUMMARY ${passed}/${results.length} passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(passed === results.length ? 0 : 1);
};

main().catch((err) => {
  console.error("SMOKE FATAL", err && err.stack ? err.stack : err);
  const passed = results.filter((r) => r.ok).length;
  console.log(`SMOKE SUMMARY ${passed}/${results.length} passed (FATAL)`);
  app.exit(1);
});
