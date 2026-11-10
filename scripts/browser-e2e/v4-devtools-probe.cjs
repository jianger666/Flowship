"use strict";
// 只能经启动器运行：node scripts/browser-e2e/run.mjs scripts/browser-e2e/v4-devtools-probe.cjs --timeout 60
// 探针（契约 §14.3 要求先验证）：webContents.debugger（CDP）attach 后 openDevTools({mode:"detach"}) 能否并存——
//   attach debugger → openDevTools → 再发 CDP 命令（evaluate / screenshot / 鼠标点击 / 输入锁）是否仍正常 → closeDevTools 后再验一次。
// DevTools 窗口无头环境里也会被真创建：用 activate:false 不抢前台，且用完一定 closeDevTools。
const { app, BrowserWindow, WebContentsView } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "fs-v4-devtools-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${x ? " — " + x : ""}`);
};
const HTML = `<!doctype html><html><body><button id="b" style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="window.__n=(window.__n||0)+1">点我</button></body></html>`;

app.whenReady().then(async () => {
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  const view = new WebContentsView({
    webPreferences: { partition: "persist:flowship-browser", sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  const wc = view.webContents;
  await wc.loadURL(url);

  const dbg = wc.debugger;
  const evalNum = async (expr) => (await dbg.sendCommand("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
  const clickButton = async () => {
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 60, y: 40 });
    await sleep(100);
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 });
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 });
    await sleep(150);
  };

  dbg.attach("1.3");
  await dbg.sendCommand("Page.enable");
  await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  check("基线：debugger 已 attach，evaluate 正常", dbg.isAttached() && (await evalNum("1+1")) === 2);
  await clickButton();
  check("基线：CDP 鼠标点击生效", (await evalNum("window.__n||0")) === 1);

  const closedEvents = [];
  dbg.on("detach", (_e, reason) => closedEvents.push(reason));
  wc.openDevTools({ mode: "detach", activate: false });
  await sleep(2000);
  check("openDevTools 后 wc.isDevToolsOpened()==true", wc.isDevToolsOpened());
  check("openDevTools 后 debugger 没被踢掉（isAttached、没有 detach 事件）", dbg.isAttached() && closedEvents.length === 0, `isAttached=${dbg.isAttached()} detach=${JSON.stringify(closedEvents)}`);
  check("DevTools 打开时 CDP evaluate 仍正常", (await evalNum("2+3")) === 5);
  const shot = await dbg.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 50 });
  check("DevTools 打开时 CDP 截图仍正常", typeof shot.data === "string" && shot.data.length > 100);
  await clickButton();
  check("DevTools 打开时 CDP 鼠标点击仍生效", (await evalNum("window.__n||0")) === 2);
  await dbg.sendCommand("Input.setIgnoreInputEvents", { ignore: true });
  await dbg.sendCommand("Input.setIgnoreInputEvents", { ignore: false });
  check("DevTools 打开时输入锁命令（Input.setIgnoreInputEvents）仍可发", true);
  await dbg.sendCommand("Runtime.evaluate", { expression: "window.__n=0" });

  wc.closeDevTools();
  await sleep(800);
  check("closeDevTools 后 wc.isDevToolsOpened()==false", !wc.isDevToolsOpened());
  check("closeDevTools 后 debugger 仍 attach、CDP 仍正常", dbg.isAttached() && (await evalNum("7*6")) === 42 && closedEvents.length === 0, `detach=${JSON.stringify(closedEvents)}`);

  // 反向：先开 DevTools、再 attach debugger（面板里用户先开了开发者工具、AI 才第一次驱动该 tab 的情形）
  dbg.detach();
  wc.openDevTools({ mode: "detach", activate: false });
  await sleep(1500);
  let reattachOk = true;
  try {
    dbg.attach("1.3");
    await dbg.sendCommand("Page.enable");
    reattachOk = (await evalNum("1+2")) === 3;
  } catch (e) {
    reattachOk = false;
    console.log("  [info] 先开 DevTools 再 attach 失败：", e?.message);
  }
  check("先开 DevTools、后 attach debugger 也能并存", reattachOk);
  wc.closeDevTools();
  await sleep(500);

  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\nPROBE SUMMARY ${passed}/${results.length} passed`);
  app.exit(passed === results.length ? 0 : 1);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
