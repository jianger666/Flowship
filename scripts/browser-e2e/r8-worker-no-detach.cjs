"use strict";
/**
 * R8 回归（真 Electron + 真 CDP；2026-11-10 v1.9.46 事故）：用户在内置浏览器地址栏输入 baidu.com，Flowship 主进程 SIGSEGV 闪退。
 *
 * 根因：tab 初始化开了 `Target.setAutoAttach { flatten: true }`（为了拿到跨站 iframe 子会话）却没带 filter，页面每创建一个 Web Worker
 * Chromium 就发 `Target.attachedToTarget`；旧的 `#onAttached` 对非 iframe 目标立刻回 `Target.detachFromTarget`——
 * Electron 42.4.0（Chromium 148）上这条命令直接让主进程崩掉。baidu.com 首页会起 `blob:` Worker，所以必现。
 *
 * 本脚本**不联网**也能复现：本地页面创建 dedicated worker（blob:）+ shared worker + service worker（旧代码会 detach 的三类目标），
 * 页面里还嵌一个跨 site（localhost vs 127.0.0.1）的 iframe 保证是 OOPIF。旧代码在这里 SIGSEGV（启动器会报「被信号 SIGSEGV 结束」）；
 * 修复后应全绿：
 *   ① 页面里的 worker 真的在跑（说明不附加 worker 并不影响页面功能）
 *   ② 跨 site iframe 的内容仍能被 snapshot 读到（说明 filter 没误伤 OOPIF）
 *   ③ 整个过程没有发出 Target.detachFromTarget（旁路记录主 tab 的 CDP 命令）
 *   ④ 子会话上发出的 Target.setAutoAttach 都带「只放行 iframe」的 filter
 *   ⑤ 没有主进程 uncaughtException
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r8-worker-no-detach.cjs --timeout 90
 *
 * 临时 userData、窗口 show:false、fixture 都在回环随机端口；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-r8-worker-"));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const info = (id, name, detail) => console.log(`SMOKE INFO ${id} ${name} ${JSON.stringify(detail)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return !!(await fn());
};

const uncaught = [];
process.on("uncaughtException", (e) => {
  uncaught.push(String((e && e.message) || e));
  console.log("  [uncaughtException]", (e && e.stack) || e);
});

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

const JS = "text/javascript; charset=utf-8";
const HTML = "text/html; charset=utf-8";

const main = async () => {
  await app.whenReady();

  // iframe 站点：用 localhost 访问（主页面用 127.0.0.1），两者是不同 site → 站点隔离下 iframe 一定是 OOPIF
  const inner = await listen((req, res) => {
    res.setHeader("content-type", HTML);
    res.end('<!doctype html><meta charset="utf-8"><title>inner</title><button>iframe内按钮</button>');
  });
  const innerUrl = `http://localhost:${inner.port}/inner`;

  const PAGE = `<!doctype html><meta charset="utf-8"><title>worker-page</title>
<h1>Worker 页面</h1>
<iframe src="${innerUrl}" width="400" height="120"></iframe>
<script>
window.__r = { worker: null, shared: null, sw: null };
// ① dedicated worker（blob:，baidu.com 首页就是这种）
var src = "onmessage=function(e){postMessage(e.data*2)}";
var w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
w.onmessage = function (e) { window.__r.worker = e.data; };
w.postMessage(21);
// ② shared worker
try {
  var sw = new SharedWorker("/shared.js");
  sw.port.onmessage = function (e) { window.__r.shared = e.data; };
  sw.port.postMessage(5);
} catch (e) { window.__r.shared = "unsupported"; }
// ③ service worker
if (navigator.serviceWorker) {
  navigator.serviceWorker.register("/sw.js").then(function () { return navigator.serviceWorker.ready; })
    .then(function () { window.__r.sw = "ready"; })
    .catch(function (e) { window.__r.sw = "err:" + e.message; });
} else { window.__r.sw = "unsupported"; }
</script>`;
  const site = await listen((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/shared.js") {
      res.setHeader("content-type", JS);
      return res.end("onconnect=function(e){var p=e.ports[0];p.onmessage=function(m){p.postMessage(m.data+1)}};");
    }
    if (p === "/sw.js") {
      res.setHeader("content-type", JS);
      return res.end('self.addEventListener("install",function(){self.skipWaiting()});self.addEventListener("activate",function(e){e.waitUntil(self.clients.claim())});');
    }
    if (p === "/favicon.ico") {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-type", HTML);
    res.end(p === "/blank" ? '<!doctype html><title>blank</title><p>blank</p>' : PAGE);
  });
  const base = `http://127.0.0.1:${site.port}`;

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
  manager.onConfig({ evaluateEnabled: true });

  const T = "r8-worker-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const ev = async (expr) => (await call("evaluate", { expression: expr })).value;

  // 先导航到一个空白页把 tab 建出来，再对它的 debugger.sendCommand 做旁路记录（之后才进 worker 页面）
  await call("navigate", { url: `${base}/blank` });
  const tab = manager.getSession(T).activeTab;
  const dbg = tab.wc.debugger;
  const sent = [];
  const origSend = dbg.sendCommand.bind(dbg);
  let tapped = true;
  try {
    dbg.sendCommand = (method, params, sessionId) => {
      sent.push({ method, params, sessionId: sessionId || null });
      return origSend(method, params, sessionId);
    };
  } catch {
    tapped = false;
  }
  if (!tapped || dbg.sendCommand === origSend) {
    tapped = false;
    info("tap", "debugger.sendCommand 不可旁路记录，③④ 降级为只看不崩", {});
  }

  await call("navigate", { url: `${base}/` });

  // ① worker 真的在跑
  const workerOk = await until(async () => (await ev("window.__r.worker")) === 42, 8000);
  check("worker-runs", "页面里的 blob worker 正常运行（postMessage 往返得到 42）", workerOk, workerOk ? undefined : await ev("JSON.stringify(window.__r)"));

  // ② 跨 site iframe 仍可读（OOPIF 子会话没被误伤）
  let snapText = "";
  const oopifOk = await until(async () => {
    snapText = (await call("snapshot", {})).text;
    return /iframe内按钮/.test(snapText);
  }, 8000);
  check("oopif-readable", "跨 site iframe 里的元素仍能被 snapshot 读到（filter 没误伤 OOPIF）", oopifOk, oopifOk ? undefined : snapText.slice(0, 300));

  // 再多等一会儿：旧代码的崩溃发生在 worker 创建后约 1 秒内，shared / service worker 也给足时间起来
  await sleep(2500);
  const r = JSON.parse((await ev("JSON.stringify(window.__r)")) || "{}");
  info("workers", "三类 worker 的起来情况（仅留痕；崩溃与否看进程是否还在）", r);

  // ③ 没发过 Target.detachFromTarget
  if (tapped) {
    const detaches = sent.filter((c) => c.method === "Target.detachFromTarget");
    check("no-detach", "整个过程没有发出 Target.detachFromTarget（旧代码对 worker 会话发它 → SIGSEGV）", detaches.length === 0, detaches.slice(0, 3));
    // ④ 子会话的 setAutoAttach 都带 iframe-only filter
    const autos = sent.filter((c) => c.method === "Target.setAutoAttach");
    const want = JSON.stringify([{ type: "iframe" }, { exclude: true }]);
    const allFiltered = autos.every((c) => JSON.stringify(c.params && c.params.filter) === want);
    check("child-autoattach-filter", "子会话上的 Target.setAutoAttach 都带「只放行 iframe」的 filter（且至少发过一条）", autos.length >= 1 && allFiltered, { n: autos.length });
  }

  // ⑤ 无主进程未捕获异常；能走到这里本身就说明主进程没有 SIGSEGV
  check("no-uncaught", "没有主进程 uncaughtException", uncaught.length === 0, uncaught.slice(0, 3));
  check("process-alive", "主进程存活至收尾（没有被信号结束）", true);

  const failed = results.filter((x) => !x.ok);
  console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed`);
  inner.server.close();
  site.server.close();
  app.exit(failed.length === 0 ? 0 : 1);
};

main().catch((e) => {
  console.log("SMOKE FAIL fatal", (e && e.stack) || e);
  app.exit(3);
});
