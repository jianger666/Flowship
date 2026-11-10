"use strict";
/**
 * V2（读取与检查）真 Electron 冒烟：read / inspect / network id + network_detail / save。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/v2-smoke.cjs --timeout 120
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动（等价于 server 经 ipc 通道发 req）。
 * 临时 userData、临时 downloads（save 落盘到这里，不碰用户真实下载目录）、窗口 show:false、本地 http fixture（随机端口，仅 127.0.0.1）；
 * 不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-v2-smoke-"));
const DOWNLOADS = path.join(TMP, "downloads");
fs.mkdirSync(DOWNLOADS, { recursive: true });
app.setPath("userData", path.join(TMP, "userData"));
app.setPath("downloads", DOWNLOADS);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 透明 PNG（图片请求的响应体是二进制，用来验证「非文本 mime 不给 body」）
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>V2 Fixture</title>
<style>
  #styled{color:rgb(255,0,0);font-size:20px;padding:4px 8px;display:inline-block;width:120px;height:30px;box-sizing:border-box}
  .hidden-css{display:none}
</style></head><body>
<header><nav><a href="/nav">导航链接</a></nav></header>
<main>
<article id="art">
<h1>文章标题</h1>
<p>这是第一段，包含 <strong>加粗</strong> 和 <a href="/rel/path?q=1">相对链接</a> 以及 <a href="javascript:alert(1)">危险链接</a>。</p>
<p>${"长文内容".repeat(30)}</p>
<img src="/img.png" alt="示意图">
<ul><li>苹果<ul><li>富士</li></ul></li><li>香蕉</li></ul>
<table><thead><tr><th>名称</th><th>价格</th></tr></thead><tbody><tr><td>笔</td><td>3</td></tr><tr><td>a|b</td><td>9</td></tr></tbody></table>
<pre><code class="language-js">const a = 1;
console.log(a);</code></pre>
<p style="display:none">隐藏的段落</p><p hidden>hidden段落</p><p aria-hidden="true">装饰文字</p><div class="hidden-css">css隐藏</div>
<script>var evil = "不应出现的脚本文本";</script>
<p>文章结尾。</p>
</article>
</main>
<aside>侧栏广告</aside>
<form id="f" onsubmit="return false"><input id="user" name="user" aria-label="用户名" value="alice"><input id="pwd" type="password" aria-label="密码" value="hunter2" onclick="void 0"><button id="btn" type="button">登录</button></form>
<button id="styled" data-note="n" onclick="void 0">样式盒</button>
<p id="para">正文段落</p>
<script>
fetch('/api/echo', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer secret-token-xyz','X-Api-Key':'k-123'}, body: JSON.stringify({user:'alice', password:'hunter2'})}).catch(function(){});
fetch('/api/fail').catch(function(){});
fetch('http://127.0.0.1:1/dead').catch(function(){});
fetch('/img.png?f=1').catch(function(){});
</script>
</body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/api/echo") {
        res.setHeader("content-type", "application/json");
        res.setHeader("set-cookie", "sid=abc123; HttpOnly");
        return res.end('{"ok":true,"echo":"hello"}');
      }
      if (p === "/api/fail") {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain");
        return res.end("boom");
      }
      if (p === "/img.png") {
        res.setHeader("content-type", "image/png");
        return res.end(PNG_1PX);
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

const main = async () => {
  await app.whenReady();
  const { server, base } = await startFixture();
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);

  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");

  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain,
    nativeImage,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: (u) => /:9\//.test(u), // 假的「应用端口」9：fixture 的随机端口不会被拦
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });

  const T = "v2-smoke-task";
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
  // 取最近一次页面加载里的请求：导航后旧文档的响应体会被浏览器回收（getResponseBody 取不到，这是预期，见 net-body-gone）
  const lastOf = (arr) => arr[arr.length - 1];
  const ciGet = (obj, key) => {
    const k = Object.keys(obj || {}).find((x) => x.toLowerCase() === key.toLowerCase());
    return k === undefined ? undefined : obj[k];
  };

  // ── 打开页面 ──
  manager.onConfig({ evaluateEnabled: false });
  const nav = await call("navigate", { url: base + "/" });
  check("nav", "navigate 打开 fixture", nav.url.startsWith(base) && nav.status === 200 && nav.title === "V2 Fixture", nav);
  await sleep(800); // 等页面里的 fetch 都落进网络缓冲

  // ── read：markdown 结构 ──
  const rd = await call("read", {});
  const t = rd.text;
  check("read-shape", "read 返回契约字段", rd.format === "markdown" && typeof rd.length === "number" && rd.length === t.length && rd.truncated === false && !!rd.tabId && rd.url.startsWith(base) && rd.title === "V2 Fixture", {
    format: rd.format, length: rd.length, root: rd.root,
  });
  check("read-main", "mainContent：默认只读 article / main 正文，不含侧栏 / 导航", (rd.root === "article" || rd.root === "main") && !t.includes("侧栏广告") && !t.includes("导航链接"), { root: rd.root });
  check("read-heading", "标题转 # markdown、加粗转 **", t.includes("# 文章标题") && t.includes("**加粗**"));
  check("read-link-abs", "链接转绝对 URL；javascript: 链接只留文字", t.includes(`[相对链接](${base}/rel/path?q=1)`) && t.includes("危险链接") && !/javascript:/i.test(t), t.slice(0, 200));
  check("read-img-alt", "图片只留 alt、不带 src", t.includes("[图片：示意图]") && !t.includes("img.png"));
  check("read-list", "嵌套列表按缩进", t.includes("- 苹果\n  - 富士\n- 香蕉"), t);
  check("read-table", "表格转 markdown 表（| 转义）", t.includes("| 名称 | 价格 |\n| --- | --- |\n| 笔 | 3 |\n| a\\|b | 9 |"), t);
  check("read-code", "代码块转围栏并带语言", t.includes("```js\nconst a = 1;\nconsole.log(a);\n```"), t);
  check("read-skip", "跳过 script / hidden / aria-hidden / display:none", !t.includes("不应出现的脚本文本") && !t.includes("隐藏的段落") && !t.includes("hidden段落") && !t.includes("装饰文字") && !t.includes("css隐藏"));

  // mainContent=false：整个 body；表单控件的值一概不出现（password 的 hunter2 / 文本框的 alice）
  const all = await call("read", { mainContent: false });
  check("read-body", "mainContent=false 读整页，且不含表单控件的值", all.root === "body" && all.text.includes("侧栏广告") && all.text.includes("导航链接") && !all.text.includes("hunter2") && !all.text.includes("alice"), { root: all.root });

  const plain = await call("read", { format: "text" });
  check("read-text", "format=text：无 markdown 记号、链接不带 URL", plain.format === "text" && plain.text.includes("文章标题") && !plain.text.includes("# 文章标题") && !plain.text.includes("**") && !plain.text.includes("](") && !plain.text.includes("http"), plain.text.slice(0, 160));

  const small = await call("read", { mainContent: false, maxChars: 1000 });
  check("read-truncate", "maxChars=1000 时截断：truncated=true 且 ≤1000", small.truncated === true ? small.text.length <= 1000 : all.text.length <= 1000, { len: small.text.length, truncated: small.truncated, total: all.text.length });
  // 页面本身只有几百字，再造一个长页验证真截断
  await call("navigate", { url: base + "/?long=1" });
  // （E2·A7：这里原来有一句总闸关着时的 evaluate「探路」——它现在会弹审批卡并挂起 120 秒，已删除）
  manager.onConfig({ evaluateEnabled: true });
  await call("evaluate", { expression: "document.body.innerHTML = Array.from({length:300},function(_,i){return '<p>第'+i+'段 '+'字'.repeat(30)+'</p>'}).join('')" });
  const longRead = await call("read", { mainContent: false, maxChars: 1000 });
  check("read-truncate-long", "长页真截断：truncated=true、长度 ≤1000", longRead.truncated === true && longRead.text.length <= 1000 && longRead.text.length > 700, { len: longRead.text.length, total: longRead.totalLength });
  manager.onConfig({ evaluateEnabled: false });

  // ── 回到 fixture：ref 读取 / inspect ──
  await call("navigate", { url: base + "/" });
  await sleep(500);
  const snap = await call("snapshot", {});
  const refStyled = refOf(snap.text, "样式盒");
  const refPwd = refOf(snap.text, "密码");
  const refLogin = refOf(snap.text, "登录");
  const refLink = refOf(snap.text, "相对链接");
  check("snap-refs", "snapshot 拿到 ref", !!(refStyled && refPwd && refLogin && refLink), { refStyled, refPwd, refLogin, refLink });

  const rr = await call("read", { ref: refLink });
  check("read-ref", "read 指定 ref 只读该元素", rr.root === "element" && rr.text === `[相对链接](${base}/rel/path?q=1)`, rr.text);
  const rrBtn = await call("read", { ref: refLogin });
  check("read-ref-button", "read 指定按钮 ref → 按钮文字", rrBtn.text === "登录", rrBtn.text);

  // ── inspect ──
  const ins = await call("inspect", { ref: refStyled });
  check(
    "inspect-box",
    "inspect：tag / role / name / 盒模型",
    ins.tag === "button" && ins.role === "button" && ins.name === "样式盒" && ins.box && Math.abs(ins.box.width - 120) <= 1 && Math.abs(ins.box.height - 30) <= 1 && ins.box.visible === true && typeof ins.box.inViewport === "boolean",
    { tag: ins.tag, role: ins.role, name: ins.name, box: ins.box },
  );
  check("inspect-styles", "inspect：计算样式（默认 15 项 + 值正确）", ins.styles && Object.keys(ins.styles).length === 15 && ins.styles["font-size"] === "20px" && ins.styles.color === "rgb(255, 0, 0)" && ins.styles.display === "inline-block", ins.styles);
  check("inspect-attrs", "inspect：attrs 含 data-note，不含 on* 属性", ins.attrs && ins.attrs["data-note"] === "n" && ins.attrs.id === "styled" && !("onclick" in ins.attrs), ins.attrs);
  check("inspect-no-html", "inspect 默认不带 html", ins.html === undefined);

  const insCustom = await call("inspect", { ref: refStyled, include: ["styles", "html"], styleProps: ["font-size", "--none", "box-sizing"] });
  check(
    "inspect-custom",
    "inspect：include / styleProps 生效；html 清掉 on* 属性",
    insCustom.box === undefined && insCustom.attrs === undefined && Object.keys(insCustom.styles).sort().join() === "--none,box-sizing,font-size" && insCustom.styles["box-sizing"] === "border-box" && typeof insCustom.html === "string" && insCustom.html.startsWith("<button") && !insCustom.html.includes("onclick"),
    { styles: insCustom.styles, html: insCustom.html },
  );

  const insPwd = await call("inspect", { ref: refPwd, include: ["attrs", "html"] });
  check(
    "inspect-password",
    "inspect：password 的 value 缺席（attrs 与 html 都没有），on* 属性不给",
    insPwd.attrs.type === "password" && !("value" in insPwd.attrs) && !("onclick" in insPwd.attrs) && !JSON.stringify(insPwd).includes("hunter2"),
    insPwd.attrs,
  );
  const bad = await tryCall("inspect", { ref: "e99999" });
  check("inspect-bad-ref", "inspect：不存在 / 抄错的 ref → REF_STALE / REF_NOT_FOUND", !bad.ok && (bad.code === "REF_STALE" || bad.code === "REF_NOT_FOUND"), bad);
  const badArgs = await tryCall("inspect", { ref: refStyled, styleProps: ["color;evil"] });
  check("inspect-bad-args", "inspect：非法 CSS 属性名 → BAD_ARGS", !badArgs.ok && badArgs.code === "BAD_ARGS", badArgs);

  // ── network：id / detail / 脱敏 / body 开关 ──
  manager.onConfig({ evaluateEnabled: true });
  const diag = await call("evaluate", { expression: "JSON.stringify({img: document.images.length ? {complete: document.images[0].complete, w: document.images[0].naturalWidth} : null, res: performance.getEntriesByType('resource').map(function(e){return e.name.split('/').pop() + ':' + e.initiatorType})})" });
  console.log("  [diag] 页面资源时序：", diag.value);
  manager.onConfig({ evaluateEnabled: false });
  const net = await call("network", { limit: 100 });
  const ids = net.entries.map((e) => e.id);
  check("net-ids", "network 条目都带 id 且严格递增", ids.length >= 4 && ids.every((n) => Number.isInteger(n) && n >= 1) && ids.every((n, i) => i === 0 || n > ids[i - 1]), net.entries.map((e) => `${e.id}:${e.type}:${e.status}:${e.url.replace(base, "").slice(0, 24)}`));
  const echo = lastOf(net.entries.filter((e) => e.url.endsWith("/api/echo")));
  const fail = lastOf(net.entries.filter((e) => e.url.endsWith("/api/fail")));
  const dead = lastOf(net.entries.filter((e) => e.url.includes("127.0.0.1:1/dead")));
  const png = lastOf(net.entries.filter((e) => e.url.includes("/img.png?f=1")));
  check("net-entries", "network 列表含 POST / 500 / 连接失败 / 二进制 fetch 请求", !!(echo && fail && dead && png) && echo.method === "POST" && echo.status === 200 && fail.status === 500 && fail.failed === true && dead.failed === true, { echo: !!echo, fail: !!fail, dead: !!dead, png: !!png });

  const det = await call("network_detail", { id: echo.id });
  check(
    "net-detail-redact",
    "network_detail：Authorization / X-Api-Key / Set-Cookie 头 [已隐藏]，Content-Type 保留",
    det.id === echo.id && det.method === "POST" && det.status === 200 && ciGet(det.requestHeaders, "authorization") === "[已隐藏]" && ciGet(det.requestHeaders, "x-api-key") === "[已隐藏]" && ciGet(det.requestHeaders, "content-type") === "application/json" && [undefined, "[已隐藏]"].includes(ciGet(det.responseHeaders, "set-cookie")) && det.mimeType === "application/json" && !JSON.stringify(det).includes("secret-token-xyz") && !JSON.stringify(det).includes("abc123"),
    det,
  );
  check("net-detail-nobody", "不带 includeBody 时不含 body 字段（也不需要开关）", !("requestBody" in det) && !("responseBody" in det) && !("bodyUnavailableReason" in det));

  // E2·A7：响应体读取改看独立开关 networkBodyRead（关着 → ACCESS_DISABLED），与 evaluate 总闸无关
  manager.onConfig({ networkBodyRead: false });
  const gated = await tryCall("network_detail", { id: echo.id, includeBody: true });
  check("net-body-gate", "networkBodyRead 关：includeBody → ACCESS_DISABLED", !gated.ok && gated.code === "ACCESS_DISABLED", gated);

  manager.onConfig({ networkBodyRead: true });
  const withBody = await call("network_detail", { id: echo.id, includeBody: true });
  check("net-body", "networkBodyRead 开（evaluate 关着也行）：给出响应体与请求体（文本类）", withBody.responseBody === '{"ok":true,"echo":"hello"}' && typeof withBody.requestBody === "string" && withBody.requestBody.includes('"user":"alice"'), { responseBody: withBody.responseBody, requestBody: withBody.requestBody, reason: withBody.bodyUnavailableReason });
  const failBody = await call("network_detail", { id: fail.id, includeBody: true });
  check("net-body-500", "500 响应：status=500，响应体 boom（text/plain）", failBody.status === 500 && failBody.responseBody === "boom" && failBody.failed === true, failBody);
  const deadDet = await call("network_detail", { id: dead.id, includeBody: true });
  check("net-detail-failed", "连接失败的请求：failed + errorText，body 不可用", deadDet.failed === true && /ERR_/.test(deadDet.errorText || "") && typeof deadDet.bodyUnavailableReason === "string", deadDet);
  if (png) {
    const pngDet = await call("network_detail", { id: png.id, includeBody: true });
    check("net-body-binary", "二进制响应（image/png）不给 body，给 bodyUnavailableReason", !("responseBody" in pngDet) && /image\/png/.test(pngDet.bodyUnavailableReason || ""), pngDet);
  } else {
    check("net-body-binary", "二进制响应（image/png）不给 body", false, "没找到图片请求");
  }
  const missing = await tryCall("network_detail", { id: 99999 });
  check("net-detail-missing", "不存在的 id → BAD_ARGS", !missing.ok && missing.code === "BAD_ARGS", missing);
  manager.onConfig({ evaluateEnabled: false });

  // clear：清空列表与详情；新请求 id 继续递增
  const lastId = Math.max(...ids);
  await call("network", { clear: true });
  const afterClear = await call("network", {});
  const gone = await tryCall("network_detail", { id: echo.id });
  check("net-clear", "clear 后列表为空、旧 id 的详情也没了", afterClear.entries.length === 0 && !gone.ok && gone.code === "BAD_ARGS", { n: afterClear.entries.length, code: gone.code });
  manager.onConfig({ evaluateEnabled: true });
  await call("evaluate", { expression: "fetch('/api/echo').then(function(r){return r.text()})" });
  manager.onConfig({ evaluateEnabled: false });
  await sleep(300);
  const next = await call("network", {});
  check("net-id-monotonic", "clear 后新请求的 id 继续递增（不回绕）", next.entries.length >= 1 && next.entries[0].id > lastId, { first: next.entries[0]?.id, lastId });

  // ── save：pdf / screenshot / html ──
  const sess = manager.getSession(T);
  const checkFile = (id, name, r, kind, magic) => {
    const inDir = r && typeof r.path === "string" && path.dirname(r.path) === path.join(DOWNLOADS, "Flowship-browser");
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      size = fs.statSync(r.path).size;
      head = fs.readFileSync(r.path).subarray(0, 16);
    } catch {
      /* 文件不存在 → size 为 0 */
    }
    check(id, name, !!inDir && r.kind === kind && size > 0 && size === r.bytes && magic(head), { path: r?.path && path.basename(r.path), bytes: r?.bytes, size });
  };
  const savedPdf = await tryCall("save", { kind: "pdf" });
  if (savedPdf.ok) checkFile("save-pdf", "save pdf：文件落在 downloads/Flowship-browser、大小 > 0、以 %PDF 开头", savedPdf.value, "pdf", (h) => h.toString("latin1").startsWith("%PDF"));
  else check("save-pdf", "save pdf", false, savedPdf);
  const savedPng = await tryCall("save", { kind: "screenshot", fullPage: true });
  if (savedPng.ok) checkFile("save-png", "save screenshot（整页 png）：文件存在、大小 > 0、PNG 魔数", savedPng.value, "screenshot", (h) => h[0] === 0x89 && h.toString("latin1", 1, 4) === "PNG");
  else check("save-png", "save screenshot", false, savedPng);
  const savedHtml = await tryCall("save", { kind: "html", nameHint: "../../etc/pass wd?*" });
  if (savedHtml.ok) {
    checkFile("save-html", "save html：文件存在、大小 > 0", savedHtml.value, "html", () => true);
    const content = fs.readFileSync(savedHtml.value.path, "utf8");
    check("save-html-content", "html 含 doctype 与正文，且 nameHint 被清洗（不能穿出目录）", /^<!DOCTYPE html>/i.test(content) && content.includes("文章标题") && !path.basename(savedHtml.value.path).includes("/") && path.dirname(savedHtml.value.path) === path.join(DOWNLOADS, "Flowship-browser") && /etc_pass wd/.test(path.basename(savedHtml.value.path)), path.basename(savedHtml.value.path));
  } else {
    check("save-html", "save html", false, savedHtml);
  }
  const names = fs.existsSync(path.join(DOWNLOADS, "Flowship-browser")) ? fs.readdirSync(path.join(DOWNLOADS, "Flowship-browser")) : [];
  check("save-filenames", "文件名形如 YYYYMMDD-HHmmss-<名>.<扩展名>", names.length >= 3 && names.every((n) => /^\d{8}-\d{6}-.+\.(pdf|png|html)$/.test(n)), names);
  const savedAgain = await tryCall("save", { kind: "html", nameHint: "same" });
  const savedAgain2 = await tryCall("save", { kind: "html", nameHint: "same" });
  check("save-no-overwrite", "同一秒同名保存不覆盖（加序号）", savedAgain.ok && savedAgain2.ok && savedAgain.value.path !== savedAgain2.value.path && fs.existsSync(savedAgain.value.path) && fs.existsSync(savedAgain2.value.path), { a: savedAgain.value?.path && path.basename(savedAgain.value.path), b: savedAgain2.value?.path && path.basename(savedAgain2.value.path) });
  const recent = sess.getState().recent.map((e) => e.summary);
  check("save-activity", "活动日志记了「保存了页面（pdf）」", recent.includes("保存了页面（pdf）"), recent.slice(-5));
  const badKind = await tryCall("save", { kind: "docx" });
  check("save-bad-kind", "kind 非法 → BAD_ARGS", !badKind.ok && badKind.code === "BAD_ARGS", badKind);

  // ── 感知类不受 USER_CONTROL 限制 ──
  sess.takeover();
  const underUser = await tryCall("read", {});
  const saveUnderUser = await tryCall("save", { kind: "html" });
  check("read-under-takeover", "用户接管期间 read / save 仍可用（感知类）", underUser.ok && saveUnderUser.ok, { read: underUser.ok, save: saveUnderUser.ok, code: underUser.code || saveUnderUser.code });
  sess.handback();

  // ── 隔离世界：页面把 DOM / 内建原型弄坏，read 仍然正常 ──
  manager.onConfig({ evaluateEnabled: true });
  await call("evaluate", {
    expression:
      "Element.prototype.getAttribute = function(){ throw new Error('pwned') }; Element.prototype.hasAttribute = function(){ throw new Error('pwned') }; Node.prototype.cloneNode = function(){ throw new Error('pwned') }; String.prototype.replace = function(){ return 'broken' }; Array.prototype.join = function(){ return 'broken' }; Object.entries = function(){ return [] }; 1",
  });
  const polluted = await call("evaluate", { expression: "document.body.firstElementChild.hasAttribute('x')" });
  check("polluted-main-world", "（前置）页面主世界的原型确实被改坏了", polluted.type === "error" || /pwned/.test(polluted.exceptionText || ""), polluted);
  const afterPollute = await tryCall("read", {});
  check("read-isolated-world", "页面改坏原型后 read 仍正常（隔离世界执行）", afterPollute.ok && afterPollute.value.text.includes("# 文章标题") && afterPollute.value.text.includes("| 名称 | 价格 |"), afterPollute.ok ? afterPollute.value.text.slice(0, 80) : afterPollute);
  const snap2 = await call("snapshot", {});
  const insAfter = await tryCall("inspect", { ref: refOf(snap2.text, "样式盒"), include: ["attrs", "html"] });
  check("inspect-isolated-world", "页面改坏原型后 inspect 仍正常", insAfter.ok && insAfter.value.attrs["data-note"] === "n" && insAfter.value.html.startsWith("<button"), insAfter.ok ? insAfter.value.attrs : insAfter);
  manager.onConfig({ evaluateEnabled: false });

  manager.destroy();
  server.close();
};

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结果 */
    }
    app.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error("SMOKE ERROR", (e && e.stack) || e);
    app.exit(1);
  });
