"use strict";
/**
 * R1 评审回归（真 Electron + 真 CDP + 真 IPC）：生命周期与「执行点」类修复，单测里只能用假对象验证的部分在这里落到真引擎上。
 *
 *   R1-09  页面 window.close()（点击触发 / 无手势自动）：不再 uncaughtException、tab 被摘掉、会话补空白页、状态可读、活动日志有记录
 *   R1-10  下载手势闸：AI 点击触发的下载放行；页面无手势自动下载被拦（不落盘、日志写「下载被拦截」）；点击后延迟触发的放行
 *   R1-33① URL 策略执行点（用真 createIsAppUrl）：直接导航 / 302 跳应用端口 / window.open 到应用端口 / 历史回退到「现在被禁」的页面
 *   R1-06  页面声明的 http favicon（指向应用端口）不会出现在 tab.favicon
 *   R1-08  标签页总数上限 20；页面脚本一次 window.open 多个，只放行窗口内前 3 个
 *   R1-38  浏览器缩放后坐标点击是否偏移（证据）
 *   R1-14  主窗口整页导航（reload）/ 渲染进程退出时收回原生视图（真 browser:attach IPC）
 *   R1-35  attach / 状态里带 windowFocused（布尔）
 *   R1-32  面板开着（attached，经真 IPC）且停车场窗口已先关时 app.quit() 能走到 will-quit、退出途中不新建窗口，manager.destroy() 只做一次，不挂住退出
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r1-lifecycle.cjs --timeout 150
 *
 * 临时 userData / downloads、窗口 show:false、fixture 都是 127.0.0.1 随机端口；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-r1-lifecycle-"));
const DL = path.join(TMP, "downloads");
fs.mkdirSync(DL, { recursive: true });
app.setPath("userData", path.join(TMP, "userData"));
app.setPath("downloads", DL);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const info = (id, name, detail) => console.log(`SMOKE INFO ${id} ${name} ${JSON.stringify(detail)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000, step = 50) => {
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

// ── fixture：app（假装是 Flowship 应用自己）+ 两个普通站点 B / C ──
const appHits = [];
const siteBHits = [];
const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

const html = (res, body) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
};

const main = async () => {
  await app.whenReady();

  const A = await listen((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    appHits.push(p);
    if (p === "/favicon.png") {
      res.setHeader("content-type", "image/png");
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    }
    html(res, `<!doctype html><title>APP</title><body>flowship-app-page</body>`);
  });
  const appBase = `http://127.0.0.1:${A.port}`;
  let appPortVar = A.port; // isAppUrl 读它：R1-33 的「现在被禁」场景靠改它模拟

  let B;
  B = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    siteBHits.push(u.pathname);
    switch (u.pathname) {
      case "/file.bin":
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="f.bin"', "content-length": 100 });
        return res.end(Buffer.alloc(100, 65));
      case "/redir-app":
        res.writeHead(302, { location: `${appBase}/` });
        return res.end();
      case "/open-app":
        return html(res, `<!doctype html><title>OPENAPP</title><body><button id="o" onclick="window.open('${appBase}/')">开应用页</button></body>`);
      case "/opens":
        return html(
          res,
          `<!doctype html><title>OPENS</title><body><button id="o6" onclick="for(var i=0;i<6;i++){window.open('/blank?i='+i)}">开六个</button></body>`,
        );
      case "/blank":
        return html(res, `<!doctype html><title>BLANK</title><body>b</body>`);
      case "/close-click":
        return html(res, `<!doctype html><title>CC</title><body><button id="c" onclick="window.close()">关闭我</button></body>`);
      case "/close-auto":
        return html(res, `<!doctype html><title>CA</title><body>auto<script>setTimeout(function(){window.close()},300)</script></body>`);
      case "/dl-link":
        return html(res, `<!doctype html><title>DL</title><body><a id="a" href="/file.bin">下载</a></body>`);
      case "/dl-auto":
        return html(
          res,
          `<!doctype html><title>DA</title><body>auto<script>setTimeout(function(){var a=document.createElement('a');a.href='/file.bin?auto';a.download='';document.body.appendChild(a);a.click()},300)</script></body>`,
        );
      case "/dl-late":
        return html(
          res,
          `<!doctype html><title>DLATE</title><body><button id="d" onclick="setTimeout(function(){var a=document.createElement('a');a.href='/file.bin?late';a.download='';document.body.appendChild(a);a.click()},1200)">延迟下载</button></body>`,
        );
      case "/dl-blank":
        return html(res, `<!doctype html><title>DB</title><body><a id="a" target="_blank" href="/file.bin?blank">新标签下载</a></body>`);
      case "/dl-open":
        return html(res, `<!doctype html><title>DO</title><body><button id="o" onclick="window.open('/file.bin?open')">window.open 下载</button></body>`);
      case "/dl-label":
        // R3-01：页面无需任何真实输入就 label.click()（UA 转发给隐藏 checkbox 一个 click）再 window.open(下载URL)——不能被当成「用户手势」放行
        return html(
          res,
          `<!doctype html><title>DLBL</title><body><label id="l" for="c">x</label><input id="c" type="checkbox" hidden><script>setTimeout(function(){document.getElementById('l').click();window.open('/file.bin?label')},300)</script></body>`,
        );
      case "/dl-open-auto":
        return html(res, `<!doctype html><title>DOA</title><body>auto<script>setTimeout(function(){window.open('/file.bin?openauto')},300)</script></body>`);
      case "/fav":
        return html(res, `<!doctype html><title>FAV</title><link rel="icon" href="${appBase}/favicon.png"><body>fav</body>`);
      case "/x":
        return html(res, `<!doctype html><title>PAGE-X</title><body>page x</body>`);
      case "/zoom":
        return html(
          res,
          `<!doctype html><title>Z</title><body style="margin:0"><div style="margin:200px 0 0 300px"><button id="zb" style="width:120px;height:40px">目标</button></div>
<script>window.__md=[];addEventListener('mousedown',function(e){window.__md.push({x:e.clientX,y:e.clientY,t:e.target.id||e.target.tagName})},true)</script></body>`,
        );
      default:
        return html(res, `<!doctype html><title>B</title><body>site b</body>`);
    }
  });
  const C = await listen((req, res) => html(res, `<!doctype html><title>PAGE-Y</title><body>page y</body>`));
  const base = `http://127.0.0.1:${B.port}`;
  const baseC = `http://127.0.0.1:${C.port}`;

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const appOrigin = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/app-origin.mjs")).href);

  // 主窗口：真 http 页面（reload 才是真的跨文档导航）+ preload 暴露 invoke（走真 browser:* IPC）
  const preloadPath = path.join(TMP, "preload.cjs");
  fs.writeFileSync(
    preloadPath,
    `const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("__t", { invoke: (c, ...a) => ipcRenderer.invoke(c, ...a) });\n`,
  );
  const mainWin = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, preload: preloadPath },
  });
  await mainWin.loadURL(`${appBase}/`);

  let destroyCalls = 0;
  // 包一层真 ipcMain：照常注册，同时留一份处理函数，脚本里可以像渲染进程那样调 browser:navigate / browser:newTab（R1-10 复审：用户自己的导航）
  const ipcHandlers = new Map();
  const ipcSpy = {
    handle: (n, f) => {
      ipcHandlers.set(n, f);
      return ipcMain.handle(n, f);
    },
    on: (...a) => ipcMain.on(...a),
    removeHandler: (...a) => {
      ipcHandlers.delete(a[0]);
      return ipcMain.removeHandler(...a);
    },
    removeListener: (...a) => ipcMain.removeListener(...a),
  };
  const ipcCall = (n, ...a) => ipcHandlers.get(n)({ senderFrame: { url: "x" } }, ...a);
  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain: ipcSpy,
    nativeImage,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: appOrigin.createIsAppUrl(() => appPortVar),
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  const realDestroy = manager.destroy.bind(manager);
  manager.destroy = () => {
    destroyCalls += 1;
    return realDestroy();
  };
  manager.onConfig({ evaluateEnabled: true });
  manager.registerIpc();

  const T = "r1-task";
  const callOn = (taskId, op, args = {}) => manager.dispatch(op, args, { taskId });
  const call = (op, args = {}) => callOn(T, op, args);
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e && e.code, message: e && e.message };
    }
  };
  const ev = async (expr) => (await call("evaluate", { expression: expr })).value;
  const refOf = (text, name) => {
    for (const line of text.split("\n")) {
      if (line.includes(name)) {
        const m = /\[ref=(e\d+)\]/.exec(line);
        if (m) return m[1];
      }
    }
    return null;
  };
  const refFor = async (name) => refOf((await call("snapshot", {})).text, name);
  const tabsList = async () => (await call("tabs", { action: "list" })).tabs;
  const activity = async () => (await call("user_activity", { markSeen: false, limit: 200 })).entries;
  const listDl = async () => (await call("downloads", { action: "list" })).downloads;
  const dlFiles = () => fs.readdirSync(DL).sort();

  // ═══════════ R1-09：window.close() ═══════════
  await call("navigate", { url: `${base}/close-click` });
  const sess = manager.getSession(T);
  const tab0 = sess.activeTab;
  await call("click", { ref: await refFor("关闭我") }).catch(() => {});
  const gone1 = await until(() => !sess.tabs.includes(tab0), 4000);
  check("close-click-removed", "点击触发 window.close()：原 tab 被摘掉（不残留已销毁的 tab）", gone1, { tabs: sess.tabs.map((t) => t.id) });
  check("close-click-no-uncaught", "没有 uncaughtException（修复前是 Object has been destroyed）", uncaught.length === 0, uncaught);
  // 必须在任何 AI 动作之前查：user_activity 只返回「AI 上次动作之后」的条目，tabs list / snapshot 都会推进这个游标
  const closeLog = (await activity()).map((e) => e.summary);
  check("close-click-log", "活动日志有「页面关闭了标签页」（AI 控制期内也要记）", closeLog.some((s) => /^页面关闭了标签页：127\.0\.0\.1/.test(s)), closeLog);
  const l1 = await tryCall("tabs", { action: "list" });
  check("close-click-list", "之后 tabs list 正常、会话补了一个空白标签页", l1.ok && l1.value.tabs.length === 1 && /^about:blank/.test(l1.value.tabs[0].url), l1.ok ? l1.value.tabs.map((t) => t.url) : l1);
  const s1 = await tryCall("snapshot", {});
  check("close-click-snapshot", "之后 snapshot 在补出的空白页上可用", s1.ok, s1.ok ? s1.value.url : s1);
  await call("navigate", { url: `${base}/close-auto` });
  const tab1 = manager.getSession(T).activeTab;
  const gone2 = await until(() => !manager.getSession(T).tabs.includes(tab1), 4000);
  check("close-auto-removed", "无手势的自动 window.close()：同样被摘掉", gone2);
  const l2 = await tryCall("tabs", { action: "list" });
  check("close-auto-list", "之后状态仍可读且至少有一个标签页", l2.ok && l2.value.tabs.length >= 1, l2.ok ? l2.value.tabs.length : l2);
  check("close-no-uncaught-final", "整个过程没有 uncaughtException", uncaught.length === 0, uncaught);

  // ═══════════ R1-10：下载手势闸 ═══════════
  await call("navigate", { url: `${base}/dl-link` });
  await call("click", { ref: await refFor("下载") });
  const dlOne = await call("downloads", { action: "wait", sinceId: 0, timeoutMs: 8000 });
  check("dl-ai-click-allowed", "AI 点击触发的下载放行并完成", dlOne.downloads.length === 1 && dlOne.downloads[0].state === "completed", dlOne.downloads.map((d) => d.state));
  check("dl-ai-click-file", "文件落在下载目录", dlFiles().length === 1, dlFiles());

  await call("navigate", { url: `${base}/dl-auto` });
  await sleep(1500);
  check("dl-auto-blocked-nofile", "页面无手势自动下载：被拦、不落盘", dlFiles().length === 1, dlFiles());
  check("dl-auto-blocked-registry", "下载登记表里没有新增", (await listDl()).length === 1, (await listDl()).length);
  const blockedLog = (await activity()).filter((e) => /下载被拦截/.test(e.summary));
  check("dl-auto-blocked-log", "活动日志写「下载被拦截」，带原因、不含 query 与目录", blockedLog.length >= 1 && !blockedLog.some((e) => e.summary.includes(DL) || /auto/.test(e.summary)), blockedLog.map((e) => e.summary));

  await call("navigate", { url: `${base}/dl-late` });
  await call("click", { ref: await refFor("延迟下载") });
  const late = await call("downloads", { action: "wait", sinceId: dlOne.downloads[0].id, timeoutMs: 8000 });
  check("dl-late-click-allowed", "点击后 1.2 秒才由页面脚本触发的下载：仍属用户手势，放行", late.downloads.length === 1 && late.downloads[0].state === "completed", late.downloads.map((d) => d.state));

  // ═══════════ R1-10 补测（评审打回①）：browser-initiated 的下载（navigate 直达附件 / target=_blank / window.open）═══════════
  // 旁路监听同一 partition 的 will-download，把 Chromium 对每个下载给出的 hasUserGesture() 原样记下来（只观察、不干预）
  const gestureSeen = [];
  session.fromPartition("persist:flowship-browser").on("will-download", (_e, item) => {
    let g;
    try {
      g = item.hasUserGesture();
    } catch (err) {
      g = `throw:${err && err.message}`;
    }
    gestureSeen.push({ url: item.getURL().replace(/^https?:\/\/[^/]+/, ""), gesture: g });
  });
  const lastDlId = async () => Math.max(0, ...(await listDl()).map((d) => d.id)); // list 是新→旧排序，取最大 id
  const blockedBefore = (await activity()).filter((e) => /下载被拦截/.test(e.summary)).length;

  let sinceId = await lastDlId();
  const filesBeforeNav = dlFiles().length;
  const navDl = await tryCall("navigate", { url: `${base}/file.bin?nav` });
  info("dl-nav-direct-call", "browser_navigate 直达附件 URL 的调用结果", navDl.ok ? { url: navDl.value.url } : navDl);
  const navWait = await call("downloads", { action: "wait", sinceId, timeoutMs: 6000 });
  await sleep(800);
  info("dl-nav-direct", "hasUserGesture 观测", gestureSeen.filter((g) => /nav$/.test(g.url)));
  check("dl-nav-direct-allowed", "browser_navigate 直达附件 URL：下载放行并完成（AI 自己要下载，不能被手势闸误拦）", navWait.downloads.length === 1 && navWait.downloads[0].state === "completed" && dlFiles().length === filesBeforeNav + 1, { dl: navWait.downloads.map((d) => d.state), files: dlFiles().length });

  sinceId = await lastDlId();
  await call("navigate", { url: `${base}/dl-blank` });
  await call("click", { ref: await refFor("新标签下载") });
  const blankWait = await call("downloads", { action: "wait", sinceId, timeoutMs: 6000 });
  info("dl-blank", "hasUserGesture 观测（target=_blank）", gestureSeen.filter((g) => /blank$/.test(g.url)));
  check("dl-blank-allowed", "AI 点击 target=_blank 的下载链接：放行、完成并落盘（hasUserGesture 虽为 false，但是浏览器发起的导航）", blankWait.downloads.length === 1 && blankWait.downloads[0].state === "completed" && dlFiles().length === filesBeforeNav + 2, { dl: blankWait.downloads.map((d) => d.state), files: dlFiles().length });
  for (const x of await tabsList()) if (!x.isActive) await call("tabs", { action: "close", tabId: x.id }).catch(() => {});

  sinceId = await lastDlId();
  await call("navigate", { url: `${base}/dl-open` });
  await call("click", { ref: await refFor("window.open 下载") });
  const openWait = await call("downloads", { action: "wait", sinceId, timeoutMs: 6000 });
  info("dl-open", "hasUserGesture 观测（点击里 window.open(下载URL)）", gestureSeen.filter((g) => /open$/.test(g.url)));
  check("dl-open-allowed", "AI 点击后页面 window.open(下载URL)：放行、完成并落盘", openWait.downloads.length === 1 && openWait.downloads[0].state === "completed" && dlFiles().length === filesBeforeNav + 3, { dl: openWait.downloads.map((d) => d.state), files: dlFiles().length });
  for (const x of await tabsList()) if (!x.isActive) await call("tabs", { action: "close", tabId: x.id }).catch(() => {});

  const filesBeforeAuto = dlFiles().length;
  await call("navigate", { url: `${base}/dl-open-auto` });
  await sleep(1500);
  info("dl-open-auto", "hasUserGesture 观测（无手势 window.open(下载URL)）", gestureSeen.filter((g) => /openauto$/.test(g.url)));
  check("dl-open-auto-blocked", "页面无手势 window.open(下载URL)：不落盘（对照）", dlFiles().length === filesBeforeAuto, dlFiles());
  // 一次性：navigate 引出的放行不能被页面脚本借去再放行第二个下载（同 URL 的后续无手势下载仍被拦）
  const filesBeforeReplay = dlFiles().length;
  await call("navigate", { url: `${base}/dl-auto` }); // 页面 300ms 后自动 a.click() 下载 /file.bin?auto
  await sleep(1500);
  check("dl-auto-still-blocked-after-nav", "放行是一次性的：之后页面无手势自动下载照样被拦", dlFiles().length === filesBeforeReplay, dlFiles());
  for (const x of await tabsList()) if (!x.isActive) await call("tabs", { action: "close", tabId: x.id }).catch(() => {});

  // R3-01：label.click()（UA 转发 click）+ 无手势 window.open(下载URL)：不放行
  const filesBeforeLabel = dlFiles().length;
  await call("navigate", { url: `${base}/dl-label` });
  await sleep(1500);
  info("dl-label", "hasUserGesture 观测（label.click() + 无手势 window.open(下载URL)）", gestureSeen.filter((g) => /label$/.test(g.url)));
  check("dl-label-forward-blocked", "页面 label.click() + window.open(下载URL)（无真实输入）：不落盘", dlFiles().length === filesBeforeLabel, dlFiles());
  for (const x of await tabsList()) if (!x.isActive) await call("tabs", { action: "close", tabId: x.id }).catch(() => {});

  // R1-10 复审 ①：用户自己的导航（地址栏 / 新建标签带 URL）也走 wc.loadURL、hasUserGesture 同样是 false——必须放行；对照：放行一次性
  sinceId = await lastDlId();
  const filesBeforeUserNav = dlFiles().length;
  const userNav = await ipcCall("browser:navigate", T, `${base}/file.bin?usernav`);
  const userNavWait = await call("downloads", { action: "wait", sinceId, timeoutMs: 6000 });
  await sleep(500);
  info("dl-user-nav", "hasUserGesture 观测（用户地址栏导航到附件）", gestureSeen.filter((g) => /usernav$/.test(g.url)));
  check("dl-user-nav-allowed", "用户在地址栏导航到附件直链：下载放行并完成", userNav && userNav.ok === true && userNavWait.downloads.length === 1 && userNavWait.downloads[0].state === "completed" && dlFiles().length === filesBeforeUserNav + 1, { userNav, dl: userNavWait.downloads.map((d) => d.state), files: dlFiles().length });

  sinceId = await lastDlId();
  const newTabId = await ipcCall("browser:newTab", T, `${base}/file.bin?usernewtab`);
  const newTabWait = await call("downloads", { action: "wait", sinceId, timeoutMs: 6000 });
  await sleep(500);
  info("dl-user-newtab", "hasUserGesture 观测（用户新建标签直接带附件 URL）", gestureSeen.filter((g) => /usernewtab$/.test(g.url)));
  check("dl-user-newtab-allowed", "用户新建标签并输入附件直链：下载放行并完成", typeof newTabId === "string" && newTabWait.downloads.length === 1 && newTabWait.downloads[0].state === "completed" && dlFiles().length === filesBeforeUserNav + 2, { newTabId, dl: newTabWait.downloads.map((d) => d.state), files: dlFiles().length });
  for (const x of await tabsList()) if (!x.isActive) await call("tabs", { action: "close", tabId: x.id }).catch(() => {});
  info("dl-blocked-log-delta", "本段新增「下载被拦截」条目数", (await activity()).filter((e) => /下载被拦截/.test(e.summary)).length - blockedBefore);

  // ═══════════ R1-33①：URL 策略执行点（真 createIsAppUrl）═══════════
  const hitsBefore = appHits.length;
  const direct = await tryCall("navigate", { url: `${appBase}/` });
  check("url-direct", "直接导航到应用端口：URL_BLOCKED", !direct.ok && direct.code === "URL_BLOCKED", direct);

  await call("navigate", { url: `${base}/x` });
  const redir = await tryCall("navigate", { url: `${base}/redir-app` });
  const curUrl1 = manager.getSession(T).activeTab.wc.getURL();
  check("url-302", "302 跳应用端口：URL_BLOCKED，且 wc 没有落在应用页", !redir.ok && redir.code === "URL_BLOCKED" && !curUrl1.startsWith(appBase), { redir, curUrl1 });

  await call("navigate", { url: `${base}/open-app` });
  const tabsBeforeOpen = (await tabsList()).length;
  await call("click", { ref: await refFor("开应用页") });
  await sleep(1200);
  const after = await tabsList();
  const wcUrls = manager.getSession(T).tabs.map((t) => t.wc.getURL());
  check("url-window-open", "window.open 到应用端口：不开新标签页，所有 tab 都不在应用页", after.length === tabsBeforeOpen && wcUrls.every((u) => !u.startsWith(appBase)), { tabsBeforeOpen, now: after.length, wcUrls });

  // 历史回退到「现在被禁」的页面：先正常访问 B/x → C/y，再把 B 置为「应用端口」，后退
  await call("navigate", { url: `${base}/x` });
  await call("navigate", { url: `${baseC}/` });
  appPortVar = B.port;
  const back = await tryCall("nav_history", { direction: "back" });
  const t = manager.getSession(T).activeTab;
  const settled = await until(() => /^about:blank/.test(t.wc.getURL()), 5000);
  appPortVar = A.port;
  info("url-history-back", "后退调用结果", back);
  check("url-history-back", "后退到现在被禁的页面：事后兜底把 tab 退回 about:blank，没停在被禁地址", settled && t.lastBlocked && t.lastBlocked.source === "post-commit", { url: t.wc.getURL(), lastBlocked: t.lastBlocked && t.lastBlocked.source });
  check("url-app-never-hit", "整个 URL 策略场景中，应用端口从未收到任何请求", appHits.length === hitsBefore, appHits.slice(hitsBefore));

  // ═══════════ R1-06：http favicon 指向应用端口 ═══════════
  const favBefore = appHits.length;
  await call("navigate", { url: `${base}/fav` });
  await sleep(1500);
  const favTab = (await tabsList()).find((x) => x.isActive);
  check("favicon-http-app", "页面声明指向应用端口的 http favicon：tab.favicon 为空（不会交给渲染进程去加载）", favTab && !favTab.favicon, favTab && favTab.favicon);
  info("favicon-fetch", "Chromium 自己是否仍会去拉那个 favicon（主进程网络栈，非渲染进程）", { appHitsDelta: appHits.length - favBefore });

  // ═══════════ R1-08：标签页上限 / 页面开多个窗口限流 ═══════════
  // 先回到干净状态：只留一个 tab
  for (const x of await tabsList()) if (!x.isActive) await call("tabs", { action: "close", tabId: x.id }).catch(() => {});
  await call("navigate", { url: `${base}/opens` });
  const baseCount = (await tabsList()).length;
  await call("click", { ref: await refFor("开六个") });
  await sleep(1800);
  const opened = (await tabsList()).length - baseCount;
  check("page-tab-limit", "页面一次 window.open 六个：窗口内最多放行 3 个（且至少开了 1 个，用例有效）", opened >= 1 && opened <= 3, { opened });
  for (const x of await tabsList()) if (!x.isActive) await call("tabs", { action: "close", tabId: x.id }).catch(() => {});

  let cap = null;
  let created = (await tabsList()).length;
  for (let i = 0; i < 25; i++) {
    const r = await tryCall("tabs", { action: "new" });
    if (!r.ok) {
      cap = r;
      break;
    }
    created += 1;
  }
  check("tab-cap", "标签页上限 20：第 21 个被拒（BAD_ARGS，带指引）", created === 20 && cap && cap.code === "BAD_ARGS" && /20/.test(cap.message), { created, cap });
  for (const x of await tabsList()) if (!x.isActive) await call("tabs", { action: "close", tabId: x.id }).catch(() => {});
  check("tab-cap-recover", "关掉多余标签页后又能开新的", (await tryCall("tabs", { action: "new" })).ok);
  for (const x of await tabsList()) if (!x.isActive) await call("tabs", { action: "close", tabId: x.id }).catch(() => {});

  // ═══════════ R1-38：缩放后坐标点击偏移（证据）═══════════
  // 复审要求：① 先证明「缩放真的生效」（innerWidth / getZoomFactor 三档不同），否则三档会真空通过；
  //           ② browser_click（ref 路径）与 browser_mouse（原始视口坐标）都测，后者还要测靠近视口边缘的点（checkMousePoint 用 viewportW）。
  await call("navigate", { url: `${base}/zoom` });
  const ztab = manager.getSession(T).activeTab;
  const pageMetrics = async () => JSON.parse((await call("evaluate", { expression: "JSON.stringify({ iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio })" })).value);
  const resetMd = () => call("evaluate", { expression: "window.__md.length=0" });
  const readMd = async () => JSON.parse((await call("evaluate", { expression: "JSON.stringify(window.__md)" })).value);
  const targetRect = async () => JSON.parse((await call("evaluate", { expression: "JSON.stringify(document.getElementById('zb').getBoundingClientRect())" })).value);
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
  const probeZoom = async () => {
    const m = await pageMetrics();
    const rect = await targetRect();
    // ① browser_click：ref → DOM.getContentQuads → CDP 点击
    await resetMd();
    await call("click", { ref: await refFor("目标") });
    const mdRef = (await readMd())[0];
    const refHit = !!mdRef && mdRef.t === "zb" && mdRef.x >= rect.left && mdRef.x <= rect.right && mdRef.y >= rect.top && mdRef.y <= rect.bottom;
    // ② browser_mouse：目标按钮中心的原始视口坐标
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    await resetMd();
    const mc = await tryCall("mouse", { action: "click", x: cx, y: cy });
    const mdCenter = (await readMd())[0];
    const centerHit = mc.ok && !!mdCenter && mdCenter.t === "zb" && near(mdCenter.x, cx) && near(mdCenter.y, cy);
    // ③ browser_mouse：靠近视口右边缘 / 下边缘的点（视口尺寸取自 layoutMetrics，缩放后它是否仍是 CSS 像素）
    const ex = m.iw - 4;
    const ey = m.ih - 4;
    await resetMd();
    const me = await tryCall("mouse", { action: "click", x: ex, y: ey });
    const mdEdge = (await readMd())[0];
    const edgeHit = me.ok && !!mdEdge && near(mdEdge.x, ex) && near(mdEdge.y, ey);
    return { m, refHit, centerHit, edgeHit, mdRef, mdCenter, mdEdge, mc: mc.ok ? "ok" : mc, me: me.ok ? "ok" : me, zoomFactor: ztab.wc.getZoomFactor() };
  };
  const z0 = await probeZoom();
  ztab.wc.setZoomLevel(2);
  await sleep(300);
  const zUp = await probeZoom();
  ztab.wc.setZoomLevel(-2);
  await sleep(300);
  const zDown = await probeZoom();
  ztab.wc.setZoomLevel(0);
  info("zoom", "各缩放档位探测（innerWidth / 缩放系数 / 三种点击落点）", { z0, zUp, zDown });
  check(
    "zoom-effective",
    "缩放确实生效：getZoomFactor 为 1 / 1.44 / 0.69，innerWidth 三档互不相同且方向正确（放大变小、缩小变大）",
    near(z0.zoomFactor, 1, 0.01) && near(zUp.zoomFactor, 1.44, 0.02) && near(zDown.zoomFactor, 0.69, 0.02) && zUp.m.iw < z0.m.iw && z0.m.iw < zDown.m.iw,
    { iw: [z0.m.iw, zUp.m.iw, zDown.m.iw], dpr: [z0.m.dpr, zUp.m.dpr, zDown.m.dpr], factor: [z0.zoomFactor, zUp.zoomFactor, zDown.zoomFactor] },
  );
  check("zoom-click-no-offset", "browser_click（ref 路径）：缩放 ×1.44 / ×0.69 后 CDP 点击仍命中目标元素矩形内（无坐标偏移）", z0.refHit && zUp.refHit && zDown.refHit, { z0: z0.refHit, zUp: zUp.refHit, zDown: zDown.refHit });
  check("zoom-mouse-no-offset", "browser_mouse（原始视口坐标，按钮中心）：三档下 mousedown 的 clientX / clientY 与请求坐标一致（±2px）", z0.centerHit && zUp.centerHit && zDown.centerHit, { z0: z0.mdCenter, zUp: zUp.mdCenter, zDown: zDown.mdCenter });
  check("zoom-mouse-edge", "browser_mouse 靠近视口右下边缘的点：三档下都未被越界检查误拒、落点一致（视口尺寸与坐标同为 CSS 像素）", z0.edgeHit && zUp.edgeHit && zDown.edgeHit, { z0: z0.mdEdge, zUp: zUp.mdEdge, zDown: zDown.mdEdge, errs: [z0.me, zUp.me, zDown.me] });

  // ═══════════ R1-14 / R1-35：主窗口整页导航与真 IPC ═══════════
  const TM = "r1-main";
  const invoke = (channel, ...args) =>
    mainWin.webContents.executeJavaScript(`window.__t.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`);
  const bounds = { x: 10, y: 10, width: 600, height: 400 };
  await callOn(TM, "navigate", { url: `${base}/x` });
  const st = await invoke("browser:attach", TM, bounds);
  const sessM = manager.getSession(TM);
  check("attach-ipc", "真 IPC 的 browser:attach 成功，视图挂到主窗口", sessM.attached === true && st && st.attached === true, { attached: sessM.attached });
  check("attach-windowFocused", "R1-35：attach 返回的状态带 windowFocused（布尔）", typeof st.windowFocused === "boolean", st.windowFocused);
  const got = await invoke("browser:getState", TM);
  check("getState-windowFocused", "R1-35：browser:getState 带 windowFocused（布尔）", got && typeof got.windowFocused === "boolean", got && got.windowFocused);

  const reloaded = new Promise((r) => mainWin.webContents.once("did-finish-load", r));
  mainWin.webContents.reload();
  await reloaded;
  check("main-reload-detach", "主窗口 reload：原生视图被收回（attached=false），标签页还在", sessM.attached === false && sessM.tabs.length >= 1, { attached: sessM.attached, tabs: sessM.tabs.length });
  await invoke("browser:attach", TM, bounds);
  check("main-reattach", "渲染端重新 attach 后恢复", sessM.attached === true);

  const gonePromise = new Promise((r) => mainWin.webContents.once("render-process-gone", r));
  mainWin.webContents.forcefullyCrashRenderer();
  await Promise.race([gonePromise, sleep(4000)]);
  await sleep(300);
  check("main-crash-detach", "主窗口渲染进程退出：原生视图被收回", sessM.attached === false, { attached: sessM.attached });

  // ═══════════ 收尾 + R1-32：退出链 ═══════════
  check("no-uncaught-overall", "全程没有 uncaughtException", uncaught.length === 0, uncaught);
  await call("close_session").catch(() => {});
  // 开一个 tab 保证停车场窗口存在（close_session 可能已销毁它）
  await callOn("r1-quit", "navigate", { url: `${base}/x` });
  const windowsBefore = BrowserWindow.getAllWindows().length;
  check("quit-parking-alive", "退出前停车场窗口活着（主窗口 + 停车场）", windowsBefore >= 2, windowsBefore);

  // R1-32 复审：「面板开着时直接退出」——会话仍处于 attached（视图挂在主窗口上），且停车场窗口已经先于主窗口被关掉
  // （Windows 关窗顺序据信是逆序）：app.quit() 关主窗口 → closed → detach → moveToParking → getParkingWindow。
  // 没有护栏时 getParkingWindow 会在退出途中 new 一个原生窗口。主窗口的渲染进程前面被故意弄崩过，先 reload 恢复再经真 IPC attach。
  await mainWin.loadURL(`${appBase}/`);
  const reAttached = await invoke("browser:attach", TM, bounds);
  check("quit-attached-precondition", "退出前会话经真 browser:attach IPC 处于 attached", sessM.attached === true && reAttached && reAttached.attached === true, { attached: sessM.attached });
  const parkingWin = BrowserWindow.getAllWindows().find((w) => manager.isParkingWindow(w));
  check("quit-parking-found", "能找到停车场窗口", !!parkingWin);
  if (parkingWin) parkingWin.destroy(); // 模拟「停车场先于主窗口被关」
  await sleep(200);
  // R3-06：app.quit() 之前必须确认「此刻停车场窗口确实不存在」——中间这 200ms 里若有路径把它重建了，
  // 后面的护栏断言（退出途中没有新建窗口）就是在测一个已经不成立的前提。
  const aliveWins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  check(
    "quit-parking-absent-precondition",
    "app.quit() 之前停车场窗口确实不存在（没被重建；窗口里只剩主窗口）",
    !aliveWins.some((w) => manager.isParkingWindow(w)) && aliveWins.length === 1 && aliveWins[0] === mainWin,
    { alive: aliveWins.length },
  );
  let quitPhase = false;
  let createdDuringQuit = 0;
  // 与 main.js 同构：before-quit 置 quitting 标志
  app.on("before-quit", () => {
    quitPhase = true;
    manager.setQuitting(true);
  });
  app.on("browser-window-created", () => {
    if (quitPhase) createdDuringQuit += 1;
  });
  [A, B, C].forEach((s) => s.server.close());

  let willQuitSeen = false;
  const finish = (extra) => {
    const passed = results.filter((r) => r.ok).length;
    console.log(`SMOKE SUMMARY ${passed}/${results.length} passed${extra || ""}`);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
    app.exit(passed === results.length ? 0 : 1);
  };
  // 与 main.js 同构：will-quit 里销毁（不可逆），只做一次
  let destroyed = false;
  app.on("will-quit", () => {
    willQuitSeen = true;
    if (!destroyed) {
      destroyed = true;
      try {
        manager.destroy();
      } catch (err) {
        console.log("  [destroy error]", err && err.message);
      }
    }
    check("quit-will-quit", "面板开着（attached）且停车场窗口已先关时 app.quit() 走到了 will-quit（没被拖住）", true);
    check("quit-no-new-windows", "退出途中没有新建任何原生窗口（getParkingWindow 不再新建）", createdDuringQuit === 0, createdDuringQuit);
    check("quit-destroy-once", "manager.destroy() 只调了一次", destroyCalls === 1, destroyCalls);
    check("quit-parking-destroyed", "退出后只剩主窗口（没有残留的停车场窗口）", BrowserWindow.getAllWindows().filter((w) => w !== mainWin).length === 0, BrowserWindow.getAllWindows().length);
    finish();
  });
  setTimeout(() => {
    if (willQuitSeen) return;
    check("quit-will-quit", "面板开着（attached）且停车场窗口已先关时 app.quit() 走到了 will-quit（没被拖住）", false, "6 秒内没有触发 will-quit：退出被挂住");
    finish(" (QUIT HUNG)");
  }, 6000);
  app.quit();
};

main().catch((err) => {
  console.error("SMOKE FATAL", err && err.stack ? err.stack : err);
  const passed = results.filter((r) => r.ok).length;
  console.log(`SMOKE SUMMARY ${passed}/${results.length} passed (FATAL)`);
  app.exit(1);
});
