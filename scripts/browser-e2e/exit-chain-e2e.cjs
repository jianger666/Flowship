"use strict";
// 只能经启动器运行：node scripts/browser-e2e/run.mjs scripts/browser-e2e/exit-chain-e2e.cjs --timeout 60
// 注意：它验证的是「Electron 语义假设 + 补发判定逻辑」，用假停车场窗口复刻了 main.js 的写法，并没有加载 main.js 本身；
// main.js 字面量由 tests/electron-browser-wiring.test.ts 钉住。
// 验证 main.js 退出链的 Electron 语义假设（逻辑与 main.js 的 hasUserWindows / browser-window-created 补发一致，用假停车场窗口）：
// 1) 停车场（隐藏窗口）活着时，关光用户窗口 Electron 不会自己发 window-all-closed
// 2) 补发逻辑：只剩停车场 → emit 一次；还有用户窗口 → 不 emit；quitting → 不 emit；窗口全无 → 不重复 emit
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "fs-exit-e2e-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${x ? " — " + x : ""}`); };

app.whenReady().then(async () => {
  let parking = null;
  const browserManager = { isParkingWindow: (w) => !!w && w === parking };
  let quitting = false;
  let emitted = 0;
  const hasUserWindows = () =>
    BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && !browserManager.isParkingWindow(w));
  // ↓ 与 main.js 一致
  app.on("window-all-closed", () => {
    if (hasUserWindows()) return;
    emitted++;
  });
  let nativeCount = 0; // 真正由 Electron 自己发的次数（emulation 走 app.emit 也会进上面的监听，这里单独数）
  const realEmit = app.emit.bind(app);
  let manual = 0;
  app.emit = (name, ...a) => { if (name === "window-all-closed") manual++; return realEmit(name, ...a); };
  app.on("browser-window-created", (_e, win) => {
    win.once("closed", () => {
      if (quitting || hasUserWindows()) return;
      if (BrowserWindow.getAllWindows().every((w) => w.isDestroyed())) return;
      app.emit("window-all-closed");
    });
  });
  const mk = (show = false) => new BrowserWindow({ show, width: 300, height: 200 });

  parking = mk();
  await parking.loadURL("about:blank");

  // 场景 1：单个用户窗口关掉 → 只剩停车场 → 补发一次（emitted=1, manual=1）
  const m1 = mk(); await m1.loadURL("about:blank");
  m1.close(); await sleep(400);
  check("只剩停车场 → 补发 window-all-closed 一次", emitted === 1 && manual === 1, `emitted=${emitted} manual=${manual}`);

  // 场景 2：两个用户窗口，关一个不补发，关第二个才补发
  const m2 = mk(); const m3 = mk();
  await Promise.all([m2.loadURL("about:blank"), m3.loadURL("about:blank")]);
  m2.close(); await sleep(300);
  check("还有用户窗口 → 不补发", emitted === 1, `emitted=${emitted}`);
  m3.close(); await sleep(300);
  check("最后一个用户窗口关 → 补发", emitted === 2, `emitted=${emitted}`);

  // 场景 3：quitting=true 时不补发
  quitting = true;
  const m4 = mk(); await m4.loadURL("about:blank");
  m4.close(); await sleep(300);
  check("quitting=true → 不补发", emitted === 2, `emitted=${emitted}`);
  quitting = false;

  // 场景 4：停车场被销毁（窗口全无）→ 不重复补发（Electron 自己会发；这里 emitted 不增加）
  parking.destroy(); await sleep(300);
  check("停车场销毁、已无窗口 → 只由 Electron 原生补一次（我们的补发不重复）", emitted === 3, `emitted=${emitted} manual=${manual}`);

  console.log(`\n结果：${results.filter(Boolean).length}/${results.length}`);
  app.exit(results.every(Boolean) ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(1); });
