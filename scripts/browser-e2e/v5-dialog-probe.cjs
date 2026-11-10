"use strict";
/**
 * V5 对话框探针（只验证 CDP 语义，不依赖 electron-app/browser 的任何实现）：
 *   Q1 页面按钮 onclick 里 alert('x') 时，Input.dispatchMouseEvent（mouseReleased）会不会一直挂到对话框被处理？
 *   Q2 收到 Page.javascriptDialogOpening 后，Page.handleJavaScriptDialog 能不能解除阻塞、让原 dispatch promise 自然结束？
 *   Q3 「动作 promise 与对话框挂起竞速」能不能让动作提前返回、之后原 promise 自然结束且无未处理异常？
 *   Q4 confirm 的返回值（accept / dismiss）能不能被页面拿到？
 *   Q6 prompt() 在 Electron 里是什么行为？（实测：直接抛 "prompt() is not supported."，根本不会挂起对话框）
 *   Q5 对话框打开期间，Runtime.evaluate 是不是也被阻塞（决定 status / snapshot 在弹窗时的可用性）？
 *
 * 只能经启动器运行：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/v5-dialog-probe.cjs --timeout 60
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）。
 */
const { app, BrowserWindow, WebContentsView, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-v5-probe-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

// 启动器的 bootstrap 会把 dialog.showMessageBox 桩成「立刻返回」——那等于 Electron 原生框瞬间被点掉，测不出真实阻塞。
// 这里换成「永不返回」来模拟「原生框弹着、没人点」，这才是生产里对话框挂起时的真实状态；同时记录它被调用的参数形状。
let nativeBoxCalls = 0;
dialog.showMessageBox = (...args) => {
  nativeBoxCalls += 1;
  const first = args[0];
  console.log("PROBE 原生 dialog.showMessageBox 被调用，参数个数", args.length, "首参类型", first && first.constructor && first.constructor.name);
  return new Promise(() => {});
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log("PROBE", ...a);

const PAGE = `<!doctype html><meta charset="utf-8"><title>probe</title>
<button id="a" style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="window.__ret = alert('x'); window.__after = 'alert-done'">alert</button>
<button id="c" style="position:absolute;left:20px;top:80px;width:120px;height:40px" onclick="window.__ret = confirm('sure?')">confirm</button>
<button id="p" style="position:absolute;left:20px;top:140px;width:120px;height:40px" onclick="window.__ret = prompt('name?', 'dflt')">prompt</button>`;

const main = async () => {
  await app.whenReady();
  const server = await new Promise((resolve) => {
    const s = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/`;

  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const view = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  const wc = view.webContents;
  await wc.loadURL(url);
  wc.debugger.attach("1.3");
  const send = (m, p = {}) => wc.debugger.sendCommand(m, p);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  let opening = null;
  const waiters = [];
  wc.debugger.on("message", (_e, method, params) => {
    if (method === "Page.javascriptDialogOpening") {
      opening = { ...params, at: Date.now() };
      for (const w of waiters.splice(0)) w(opening);
    }
  });
  const nextDialog = () => (opening ? Promise.resolve(opening) : new Promise((r) => waiters.push(r)));
  const evalPage = (expr) => send("Runtime.evaluate", { expression: expr, returnByValue: true });

  const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    // 返回的是 mouseReleased 的 promise：click 事件在它里面触发，alert 在 click 里
    return send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  };
  const settledWithin = (p, ms) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

  // ── 自检：点击到底有没有落到页面（排除「点空」造成的假阴性） ──
  await evalPage("window.__cl = 0; document.addEventListener('mousedown', () => { window.__cl++; }, true)");
  await click(300, 400);
  say("自检 空白处点击后页面收到 mousedown 数", (await evalPage("window.__cl")).result?.value);

  // ── Q1 / Q2：alert ──
  opening = null;
  const t0 = Date.now();
  const released = click(80, 40);
  const dlg = await Promise.race([nextDialog(), sleep(3000).then(() => null)]);
  say("Q0 javascriptDialogOpening 到达", !!dlg, dlg && { type: dlg.type, message: dlg.message, hasUrl: !!dlg.url, ms: Date.now() - t0 });
  const hungBefore = !(await settledWithin(released, 2000));
  say("Q1 对话框未处理 2s 后，mouseReleased 仍挂着？", hungBefore);

  // Q5：对话框打开期间 evaluate 会不会阻塞
  const evalP = evalPage("1+1");
  const evalHung = !(await settledWithin(evalP, 1500));
  say("Q5 对话框打开期间 Runtime.evaluate 被阻塞？", evalHung);

  await send("Page.handleJavaScriptDialog", { accept: true });
  const releasedAfter = await settledWithin(released, 3000);
  say("Q2 handleJavaScriptDialog 后 mouseReleased 自然结束？", releasedAfter);
  const evalAfter = await settledWithin(evalP, 3000);
  say("Q5b 处理后被阻塞的 evaluate 恢复？", evalAfter);
  say("Q2b 页面 JS 继续执行（alert 之后的语句）", (await evalPage("window.__after")).result?.value);

  // ── Q3：竞速 ──
  opening = null;
  let unhandled = 0;
  const onUnhandled = () => (unhandled += 1);
  process.on("unhandledRejection", onUnhandled);
  const actionP = click(80, 40).then(() => "action-done");
  const winner = await Promise.race([actionP, nextDialog().then(() => "dialog-first")]);
  say("Q3 竞速赢家", winner);
  await send("Page.handleJavaScriptDialog", { accept: true });
  const natural = await Promise.race([actionP, sleep(3000).then(() => "stuck")]);
  say("Q3b 原动作 promise 之后自然结束？", natural);
  await sleep(200);
  process.off("unhandledRejection", onUnhandled);
  say("Q3c 竞速期间未处理的 rejection 数", unhandled);

  // ── Q6：prompt 在 Electron 里到底是什么行为（直接在页面里调） ──
  opening = null;
  const pr = await Promise.race([
    evalPage("(() => { try { var r = prompt('q','d'); return 'returned:' + String(r); } catch (e) { return 'threw:' + e.message; } })()"),
    sleep(2500).then(() => "blocked"),
  ]);
  say("Q6 页面直接调 prompt()：", JSON.stringify(pr?.result?.value ?? pr), "是否收到 opening 事件", !!opening, opening && opening.type);

  // ── Q4：confirm / prompt 的返回值 ──
  for (const [label, y, accept, text, expr] of [
    ["confirm accept", 100, true, undefined, "window.__ret"],
    ["confirm dismiss", 100, false, undefined, "window.__ret"],
  ]) {
    opening = null;
    await evalPage("window.__ret = 'unset'");
    const p = click(80, y);
    const d = await Promise.race([nextDialog(), sleep(3000).then(() => null)]);
    // 未处理前先看 600ms：click promise 还挂着吗？（prompt 若被 Electron 原生直接取消，这里就已经结束了）
    const hungEarly = !(await settledWithin(p, 600));
    let handleErr = null;
    await send("Page.handleJavaScriptDialog", { accept, ...(text !== undefined ? { promptText: text } : {}) }).catch((e) => {
      handleErr = String(e?.message || e);
    });
    await settledWithin(p, 3000);
    if (handleErr || hungEarly === false) say(`Q4' ${label}：处理前 600ms 仍挂着=${hungEarly}，handle 报错=${handleErr}`);
    say(`Q4 ${label}（type=${d?.type}, defaultPrompt=${d?.defaultPrompt ?? "-"}）→ 页面拿到`, JSON.stringify((await evalPage(expr)).result?.value));
  }

  say("原生 dialog.showMessageBox 总调用次数", nativeBoxCalls);
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(0);
};

main().catch((err) => {
  console.error("PROBE FATAL", err && err.stack ? err.stack : err);
  app.exit(1);
});
