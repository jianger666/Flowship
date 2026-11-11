"use strict";
/**
 * R11 真 Electron：本地 HTML 里的 `file://` 引用（local-html-server.mjs 头部第 11 条）。
 *
 * 复现的用户现象：AI / 脚本生成的 HTML 把封面图写成 `file:///Users/…/封面.jpg`，在内置浏览器（页面来源是
 * `http://<token>.localhost:<端口>/`）里是裂图——Chromium 不允许 http 来源的页面加载 `file:` 子资源。
 *
 * 同一个页面里放对照：
 *   - 根目录之内的 `file://`（全编码 / 只编码中文一段 / `<link>` 样式 / `<script>` / JS 数据里拼出来的 `new Image().src`）→ 应当加载成功；
 *   - 根目录之外的 `file://` 图 → **必须仍然是裂图**（同时证明「这个环境确实会拦 file:」，以及翻译只作用于根目录之内）；
 *   - 页面里给用户复制用的普通绝对路径文本原样不变。
 * 再核对：页面里没有残留的「根目录内」file:// 引用；根目录内的敏感文件即使被写成 file:// 也取不到；`file:` 仍被内置浏览器的 URL 策略拒绝。
 *
 * 只能经启动器运行：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r11-local-html-file-url.cjs --timeout 120
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog, Menu, clipboard, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-r11-")));
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

const main = async () => {
  await app.whenReady();

  // 站点目录放在一个「不过宽」的位置：<TMP>/episodes/2026-11-09-欧美 歌单/（带中文 + 空格，和真实案例同款）
  const site = path.join(TMP, "episodes", "2026-11-09-欧美 歌单");
  const outside = path.join(TMP, "outside");
  fs.mkdirSync(path.join(site, "发布_180"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(site, "发布_180", "封面 x.png"), PNG_1X1);
  fs.writeFileSync(path.join(site, "plain.png"), PNG_1X1);
  fs.writeFileSync(path.join(outside, "o.png"), PNG_1X1);
  fs.writeFileSync(path.join(site, "s.css"), "#h{color:rgb(4,5,6)}");
  fs.writeFileSync(path.join(site, "app.js"), "document.getElementById('js').textContent='file-js-loaded';");
  fs.writeFileSync(path.join(site, ".env"), "TOKEN=SECRET");
  fs.writeFileSync(path.join(site, "key.pem"), "-----BEGIN PRIVATE KEY-----");

  const fu = (p) => pathToFileURL(p).href; // 全编码
  // 只编码「带中文 / 空格」的那一段，其余明文（真实页面就是这样拼出来的）
  const siteParent = path.dirname(site);
  const mixed = `${fu(siteParent)}/${encodeURIComponent(path.basename(site))}/${encodeURIComponent("发布_180")}/${encodeURIComponent("封面 x.png")}`;
  const fileCss = `${fu(site)}/s.css`;
  const fileJs = `${fu(site)}/app.js`;
  const data = JSON.stringify({ uri: `${fu(site)}/plain.png`, path: path.join(site, "plain.png"), out: fu(path.join(outside, "o.png")) });
  fs.writeFileSync(
    path.join(site, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>R11</title>
<link rel="stylesheet" href="${fileCss}">
<style>#bg{width:10px;height:10px;background:url(${fu(site)}/plain.png)}</style></head>
<body><h1 id="h">file 引用</h1>
<img id="in-full" src="${fu(path.join(site, "plain.png"))}">
<img id="in-mixed" src="${mixed}">
<img id="outside" src="${fu(path.join(outside, "o.png"))}">
<div id="bg"></div><p id="js">js-pending</p><code id="path">${path.join(site, "plain.png")}</code>
<img id="secret-env" src="${fu(path.join(site, ".env"))}"><img id="secret-pem" src="${fu(path.join(site, "key.pem"))}">
<script src="${fileJs}"></script>
<script>
const D = ${data};
window.__dyn = 'pending';
const i = new Image(); i.onload = () => { window.__dyn = 'loaded:' + i.naturalWidth; }; i.onerror = () => { window.__dyn = 'error'; }; i.src = D.uri;
window.__D = D;
</script></body></html>`,
  );

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const appOrigin = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/app-origin.mjs")).href);
  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");
  const handlers = new Map();
  const ipc = { handle: (n, f) => void handlers.set(n, f), on: () => {}, removeHandler: (n) => void handlers.delete(n), removeListener: () => {} };
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
    isAppUrl: appOrigin.createIsAppUrl(() => 1),
    isTrustedIpcSender: () => true,
    log: () => {},
  });
  manager.registerIpc();
  manager.onConfig({ evaluateEnabled: true });
  const T = "r11-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const ev = async (expr) => (await call("evaluate", { expression: expr })).value;

  const served = await handlers.get("browser:serveLocalHtml")({}, path.join(site, "index.html"));
  check("r11-serve", "登记本地 HTML 成功（目录模式）", served.ok && served.scope === "dir", served);
  if (!served.ok) throw new Error(`登记失败 ${JSON.stringify(served)}`);
  const origin = new URL(served.url).origin;

  await handlers.get("browser:newTab")({}, T, served.url);
  // 等页面脚本跑完（__dyn 不再是 pending）
  let dyn = "pending";
  for (let i = 0; i < 60 && dyn === "pending"; i++) {
    await sleep(250);
    try {
      dyn = await ev("window.__dyn");
    } catch {
      /* 页面还没就绪 */
    }
  }
  await sleep(500); // 给其余图片 / 样式一点时间

  const natural = async (id) => await ev(`document.getElementById('${id}').naturalWidth`);
  check("r11-in-full", "根目录内、全编码的 file:// 图片加载成功（naturalWidth = 1）", (await natural("in-full")) === 1, await natural("in-full"));
  check("r11-in-mixed", "根目录里有中文 / 空格、只编码了其中一段（真实案例同款）的 file:// 图片加载成功", (await natural("in-mixed")) === 1, await natural("in-mixed"));
  check("r11-dyn-image", "JS 数据里 JSON 带出的 file:// URI（`new Image().src = D.uri`，真实页面的写法）加载成功", dyn === "loaded:1", dyn);
  check("r11-outside-stays-broken", "根目录之外的 file:// 图片仍是裂图（naturalWidth = 0）——证明环境确实拦 file:，翻译只作用于根目录之内", (await natural("outside")) === 0, await natural("outside"));
  check("r11-link-css", "`<link href=file://…/s.css>` 样式生效（color = rgb(4, 5, 6)）", (await ev("getComputedStyle(document.getElementById('h')).color")) === "rgb(4, 5, 6)", await ev("getComputedStyle(document.getElementById('h')).color"));
  check("r11-script", "`<script src=file://…/app.js>` 加载并执行", (await ev("document.getElementById('js').textContent")) === "file-js-loaded", await ev("document.getElementById('js').textContent"));
  const bg = await ev("getComputedStyle(document.getElementById('bg')).backgroundImage");
  check("r11-css-url", "内联 CSS 的 `url(file://…)` 已被翻译成本服务的 http 地址", typeof bg === "string" && bg.includes(`${origin}/plain.png`), bg);

  const html = await ev("document.documentElement.outerHTML");
  const remaining = [...html.matchAll(/file:\/\/[^"')\s<]+/g)].map((m) => m[0]);
  check(
    "r11-no-inroot-file-url",
    "页面里残留的 file:// 只剩根目录之外那一个（根目录内的引用都已翻译）",
    remaining.length === 2 && remaining.every((u) => u.includes("/outside/")), // 出现两次：<img> 属性 + JSON 数据里的 out
    remaining,
  );
  check("r11-path-text-intact", "页面里给用户看 / 复制的普通绝对路径文本原样不变", (await ev("document.getElementById('path').textContent")) === path.join(site, "plain.png"), await ev("document.getElementById('path').textContent"));
  check("r11-data-path-intact", "JSON 数据里的 `path` 字段（不是 file:// URL）原样不变", (await ev("window.__D.path")) === path.join(site, "plain.png"), await ev("window.__D.path"));

  // 敏感文件即使被写成 file:// 也取不到（翻译后的请求仍被 404）
  const sec = {
    env: await ev("(async()=>{try{return (await fetch('/.env')).status}catch(e){return 'ERR'}})()"),
    pem: await ev("(async()=>{try{return (await fetch('/key.pem')).status}catch(e){return 'ERR'}})()"),
    envImg: await natural("secret-env"),
    pemImg: await natural("secret-pem"),
  };
  check("r11-sensitive-still-404", "根目录里的 .env / 私钥即使被写成 file:// 也加载不到（翻译后的请求仍 404、图片裂）", sec.env === 404 && sec.pem === 404 && sec.envImg === 0 && sec.pemImg === 0, sec);

  // 红线没松：内置浏览器仍拒绝直接导航到 file:
  let fileBlocked = false;
  try {
    await call("navigate", { url: fu(path.join(site, "plain.png")) });
  } catch (e) {
    fileBlocked = e?.code === "URL_BLOCKED";
  }
  check("r11-file-nav-still-blocked", "AI 直接导航到 file: 仍被 URL 策略拒绝（红线没松）", fileBlocked);

  manager.destroy();
};

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 清不掉不影响结果 */
    }
    app.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error("SMOKE ERROR", e);
    app.exit(2);
  });
