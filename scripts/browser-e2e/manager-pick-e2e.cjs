"use strict";
// 只能经启动器运行：node scripts/browser-e2e/run.mjs scripts/browser-e2e/manager-pick-e2e.cjs --timeout 60
// 集成冒烟：真 createBrowserManager（A 组 index.mjs）+ 真 BrowserTab + 我的 picker.mjs：
// browser:navigate → attach → startPick → 点选 → 主窗口 webContents 收到 browser:picked；state.picking 变化；Esc 取消；window 关闭语义
const { app, BrowserWindow, WebContentsView, session, nativeImage, webContents } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const REPO = path.resolve(__dirname, "../..");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "fs-mgr-e2e-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${x ? " — " + x : ""}`); };
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>集成页</title></head><body style="margin:0">
<button id="go" style="position:absolute;left:50px;top:50px;width:200px;height:60px">去结算</button></body></html>`;

app.whenReady().then(async () => {
  const server = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(HTML); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const win = new BrowserWindow({ show: false, width: 1000, height: 700 });
  await win.loadURL("about:blank");
  const sent = [];
  const origSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, ...a) => { sent.push([ch, ...a]); return origSend(ch, ...a); };

  const handlers = new Map(); const listeners = new Map();
  const ipcMain = {
    handle: (n, f) => handlers.set(n, f), on: (n, f) => listeners.set(n, f),
    removeHandler: (n) => handlers.delete(n), removeListener: (n) => listeners.delete(n),
  };
  const { createBrowserManager } = await import(pathToFileURL(path.join(REPO, "electron-app/browser/index.mjs")).href);
  const { createIsAppUrl } = await import(pathToFileURL(path.join(REPO, "electron-app/browser/app-origin.mjs")).href);
  const mgr = createBrowserManager({
    app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage,
    getMainWindow: () => win, isAppUrl: createIsAppUrl(() => 8876), isTrustedIpcSender: () => true, log: (m) => console.log("  [log]", m),
  });
  mgr.registerIpc();
  const call = (n, ...a) => handlers.get(n)({ senderFrame: { url: "x" } }, ...a);

  const nav = await call("browser:navigate", "t1", url);
  check("navigate（本地 fixture 端口≠应用端口）放行", nav?.ok === true, JSON.stringify(nav));
  const st = await call("browser:attach", "t1", { x: 0, y: 0, width: 800, height: 600 });
  check("attach 返回 state", st?.taskId === "t1");
  await sleep(1500);
  const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
  check("找到浏览器 view 的 webContents 且已加载", !!wc, wc?.getURL());
  if (!wc) { app.exit(1); return; }

  listeners.get("browser:startPick")({ senderFrame: { url: "x" } }, "t1");
  await sleep(600);
  const s1 = await call("browser:getState", "t1");
  check("startPick 后 state.picking=true", s1?.picking === true, `picking=${s1?.picking}`);

  const dbg = wc.debugger;
  await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 80 });
  await sleep(100);
  await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 80, button: "left", clickCount: 1 });
  await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 80, button: "left", clickCount: 1 });
  await sleep(1200);
  const picked = sent.find((m) => m[0] === "browser:picked");
  check("主窗口收到 browser:picked（taskId + PickedElement）", !!picked && picked[1] === "t1" && picked[2]?.selector === "#go", picked ? JSON.stringify({ ...picked[2], screenshot: picked[2].screenshot ? "<jpeg>" : undefined }).slice(0, 300) : "无");
  const s2 = await call("browser:getState", "t1");
  check("拾取结束后 state.picking=false，activity 里有 pick 条目", s2?.picking === false && s2.recent.some((e) => e.kind === "pick"), `picking=${s2?.picking}`);

  // 第二次拾取：Esc 取消
  listeners.get("browser:startPick")({ senderFrame: { url: "x" } }, "t1");
  await sleep(600);
  check("再次 startPick → picking=true", (await call("browser:getState", "t1"))?.picking === true);
  wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await sleep(600);
  check("Esc → state.picking=false", (await call("browser:getState", "t1"))?.picking === false);

  // 第三次：cancelPick IPC
  listeners.get("browser:startPick")({ senderFrame: { url: "x" } }, "t1");
  await sleep(500);
  listeners.get("browser:cancelPick")({ senderFrame: { url: "x" } }, "t1");
  await sleep(400);
  check("cancelPick → picking=false", (await call("browser:getState", "t1"))?.picking === false);

  check("isParkingWindow：停车场窗口为真、主窗口为假", BrowserWindow.getAllWindows().filter((w) => mgr.isParkingWindow(w)).length === 1 && !mgr.isParkingWindow(win));
  mgr.destroy(); mgr.destroy();
  await sleep(300);
  check("destroy() 幂等；停车场窗口已销毁", BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).every((w) => w === win));
  server.close();
  console.log(`\n结果：${results.filter(Boolean).length}/${results.length}`);
  app.exit(results.every(Boolean) ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(1); });
