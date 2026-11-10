"use strict";
/**
 * V5 冒烟（真 Electron + 真 CDP）：设备模拟（emulate）与 JS 对话框（挂起 / 处理 / 超时兜底 / 动作竞速）。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/v5-smoke.cjs --timeout 120
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动（等价于 server 经 ipc 通道发 req）。
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 *
 * 关于原生对话框：启动器 bootstrap 把 dialog.showMessageBox 桩成「立刻返回」，等于 Electron 原生框瞬间被点掉，页面不会被阻塞，
 * 测不出挂起行为。这里换成「永不返回」来模拟生产里「原生框弹着、没人点」的真实状态（探针 v5-dialog-probe.cjs 同款）。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-v5-smoke-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>V5</title></head><body>
<h1>V5</h1>
<button id="plain">普通按钮</button>
<button id="alertBtn">弹提示</button>
<button id="confirmBtn">弹确认</button>
<script>
window.__plain = 0; window.__ret = 'unset'; window.__after = null;
document.getElementById('plain').addEventListener('click', function(){ window.__plain++; });
document.getElementById('alertBtn').addEventListener('click', function(){ window.__ret = alert('你好，这是提示'); window.__after = 'alert-done'; });
document.getElementById('confirmBtn').addEventListener('click', function(){ window.__ret = confirm('确定删除吗？'); window.__after = 'confirm-done'; });
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/ping") {
        res.setHeader("content-type", "text/plain");
        return res.end("ok");
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (p === "/page2") return res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page2</title><h1>第二页</h1>');
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port }));
  });

const main = async () => {
  await app.whenReady();
  const { server, base, port } = await startFixture();
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
    isAppUrl: (u) => /:9\//.test(u),
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  manager.onConfig({ evaluateEnabled: true });

  const T = "v5-task";
  const call = (op, args = {}, signal) => manager.dispatch(op, args, { taskId: T, signal });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
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
  const env = () =>
    ev(
      "JSON.stringify({ w: innerWidth, dpr: devicePixelRatio, ua: navigator.userAgent, dark: matchMedia('(prefers-color-scheme: dark)').matches, online: navigator.onLine, touch: navigator.maxTouchPoints, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })",
    ).then((v) => JSON.parse(v));

  // ═══════════ 设备模拟 ═══════════
  await call("navigate", { url: `${base}/` });
  const baseline = await env();
  check("emu-baseline", "基线：无模拟时 tab 摘要为 null", (await call("tabs", { action: "list" })).tabs[0].emulation === null, baseline);

  const r1 = await call("emulate", { device: "iPhone 15", colorScheme: "dark" });
  check("emu-result", "emulate 返回 applied + 摘要「iPhone 15 · 暗色」", r1.emulation === "iPhone 15 · 暗色" && r1.applied.length === 2, r1);
  const e1 = await env();
  check("emu-viewport", "页内 innerWidth=393、devicePixelRatio=3", e1.w === 393 && e1.dpr === 3, e1);
  check("emu-ua", "navigator.userAgent 含 iPhone", /iPhone/.test(e1.ua), e1.ua);
  check("emu-dark", "matchMedia(prefers-color-scheme: dark) 为 true", e1.dark === true);
  check("emu-touch", "移动端模拟开启触摸（maxTouchPoints>0）", e1.touch > 0, e1.touch);
  check("emu-taburl", "TabInfo.emulation 带摘要", (await call("tabs", { action: "list" })).tabs[0].emulation === "iPhone 15 · 暗色");

  // 增量叠加：再叠一个弱网，设备 / 暗色仍在
  const r2 = await call("emulate", { network: "slow3g" });
  check("emu-merge", "增量叠加：摘要变成「iPhone 15 · 暗色 · 弱网 3G」", r2.emulation === "iPhone 15 · 暗色 · 弱网 3G", r2.emulation);
  const t0 = Date.now();
  await ev("fetch('/ping', { cache: 'no-store' }).then(r => r.text())");
  const slowMs = Date.now() - t0;
  check("emu-slow3g", "弱网 3G 下一次 fetch 明显变慢（≥300ms）", slowMs >= 300, { slowMs });
  await call("emulate", { network: "none" });
  const t1 = Date.now();
  await ev("fetch('/ping', { cache: 'no-store' }).then(r => r.text())");
  const fastMs = Date.now() - t1;
  check("emu-net-none", "network:none 后恢复快速", fastMs < 300, { fastMs });

  // 换页后仍生效：同站 + 跨站（localhost 与 127.0.0.1 是不同站，渲染进程会换）
  await call("navigate", { url: `${base}/page2` });
  const e2 = await env();
  check("emu-after-nav-same", "同站换页后仍生效", e2.w === 393 && e2.dpr === 3 && /iPhone/.test(e2.ua) && e2.dark === true, e2);
  await call("navigate", { url: `http://localhost:${port}/page2` });
  const e3 = await env();
  check("emu-after-nav-cross", "跨站换页（换渲染进程）后仍生效", e3.w === 393 && e3.dpr === 3 && /iPhone/.test(e3.ua) && e3.dark === true, e3);

  // 离线
  await call("emulate", { offline: true });
  check("emu-offline", "offline:true → navigator.onLine=false", (await env()).online === false);
  const off = await call("tabs", { action: "list" });
  check("emu-offline-summary", "摘要含「离线」", /离线/.test(off.tabs[0].emulation), off.tabs[0].emulation);
  await call("emulate", { offline: false });
  check("emu-online", "offline:false → navigator.onLine=true", (await env()).online === true);

  // 时区 / 语言 / reducedMotion 抽查
  await call("emulate", { timezone: "Asia/Tokyo", reducedMotion: true });
  const e4 = await env();
  check("emu-timezone", "时区模拟生效（Asia/Tokyo）", e4.tz === "Asia/Tokyo", e4.tz);
  check("emu-reduced-motion", "prefers-reduced-motion: reduce 生效", (await ev("matchMedia('(prefers-reduced-motion: reduce)').matches")) === true);

  // 预设覆盖 + 换设备
  await call("emulate", { device: "Desktop 1440" });
  const e5 = await env();
  check("emu-switch-device", "换成 Desktop 1440：宽 1440、UA 回到非 iPhone、触摸关", e5.w === 1440 && !/iPhone/.test(e5.ua) && e5.dark === true, e5);

  // 参数错误
  const bad = await tryCall("emulate", { device: "Nokia 3310" });
  check("emu-bad-device", "未知预设 BAD_ARGS 并列出可选项", !bad.ok && bad.code === "BAD_ARGS" && /iPhone 15/.test(bad.message) && /Desktop 1920/.test(bad.message), bad);
  const badRange = await tryCall("emulate", { width: 50 });
  check("emu-bad-range", "宽度越界 BAD_ARGS", !badRange.ok && badRange.code === "BAD_ARGS", badRange);

  // 控制权：接管时 emulate（动作类）被拒
  const sess = manager.getSession(T);
  sess.takeover();
  const denied = await tryCall("emulate", { colorScheme: "light" });
  check("emu-user-control", "用户接管时 emulate 被 USER_CONTROL 拒绝", !denied.ok && denied.code === "USER_CONTROL", denied);
  sess.handback();

  // reset
  const rr = await call("emulate", { reset: true });
  // 清掉设备指标覆盖后，视口尺寸由浏览器进程异步通知渲染进程，轮询最多 3 秒等它落地（记下耗时）
  const resetAt = Date.now();
  let e6 = await env();
  while (e6.w !== baseline.w && Date.now() - resetAt < 3000) {
    await sleep(100);
    e6 = await env();
  }
  const resetSettleMs = Date.now() - resetAt;
  check("emu-reset-summary", "reset 后摘要为 null", rr.emulation === null && (await call("tabs", { action: "list" })).tabs[0].emulation === null, rr);
  check(
    "emu-reset-restored",
    "reset 后页内环境恢复到基线（宽 / 像素比 / UA / 暗色 / 联网 / 时区）",
    e6.w === baseline.w && e6.dpr === baseline.dpr && e6.ua === baseline.ua && e6.dark === baseline.dark && e6.online === true && e6.tz === baseline.tz,
    { e6, baseline, resetSettleMs },
  );

  // ═══════════ 对话框 ═══════════
  await call("navigate", { url: `${base}/` });
  // 只拍一次快照：每次 snapshot 都会让上一代 ref 失效
  const snapText = (await call("snapshot", {})).text;
  const alertRef = refOf(snapText, "弹提示");
  const confirmRef = refOf(snapText, "弹确认");
  const plainRef = refOf(snapText, "普通按钮");
  check("dlg-refs", "拿到三个按钮的 ref", !!alertRef && !!confirmRef && !!plainRef);

  check("dlg-none", "没有对话框时 status.pending=null", (await call("dialog", { action: "status" })).pending === null);

  // 1) AI 点击触发 alert：动作提前返回（不被阻塞），带 dialog 字段
  const c0 = Date.now();
  const clickRes = await call("click", { ref: alertRef });
  const clickMs = Date.now() - c0;
  check("dlg-race", "AI 点击被 alert 阻塞时动作提前返回，结果带 dialog", clickRes.dialog?.type === "alert" && clickRes.dialog?.message === "你好，这是提示" && clickMs < 6000, { clickMs, dialog: clickRes.dialog });

  // 2) 挂起：status 看得到；再点别的动作 → 不执行（notExecuted）
  const st = await call("dialog", { action: "status" });
  check("dlg-status", "status 返回挂起的 alert（含 since / url）", st.pending?.type === "alert" && typeof st.pending.since === "number" && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(st.pending.url), st.pending);
  const second = await call("click", { ref: plainRef });
  check("dlg-not-executed", "挂起期间再发动作：不执行，直接带 dialog + notExecuted", second.notExecuted === true && second.dialog?.type === "alert", second);

  // 3) 状态推送里有 dialog；用户接管时 dialog status 仍可看，但 accept / dismiss 被拒（R1-28：它可能是用户操作触发的确认框，AI 不能替用户点）
  check("dlg-state", "session.getState().dialog 带出挂起的对话框", sess.getState().dialog?.type === "alert", sess.getState().dialog);
  sess.takeover();
  check("dlg-under-takeover", "用户接管时 dialog status 仍可用", (await call("dialog", { action: "status" })).pending?.type === "alert");
  const refusedAccept = await call("dialog", { action: "accept" }).then(() => null, (e) => e);
  const refusedDismiss = await call("dialog", { action: "dismiss" }).then(() => null, (e) => e);
  check(
    "dlg-takeover-refused",
    "用户接管时 dialog accept / dismiss 被 USER_CONTROL 拒绝，对话框仍挂起",
    refusedAccept?.code === "USER_CONTROL" && refusedDismiss?.code === "USER_CONTROL" && sess.getState().dialog?.type === "alert",
    { accept: refusedAccept?.code, dismiss: refusedDismiss?.code, dialog: sess.getState().dialog?.type },
  );

  // 4) 用户交还后 accept → 页面继续执行
  sess.handback();
  const acc = await call("dialog", { action: "accept" });
  check("dlg-accept", "accept：handled=true 且不再有挂起", acc.handled === true && acc.pending === null, acc);
  await sleep(300);
  check("dlg-page-continue", "页面 alert 之后的 JS 继续执行（__after=alert-done），被拦下的点击没有发生", (await ev("window.__after")) === "alert-done" && (await ev("window.__plain")) === 0);
  const noPending = await call("dialog", { action: "accept" });
  check("dlg-accept-none", "没有挂起时 accept 返回 handled:false（不是错误）", noPending.handled === false && noPending.pending === null, noPending);

  // 5) 原动作自然收尾后，下一个动作能正常执行（队列等了 stale 的原 promise）
  const afterClick = await call("click", { ref: plainRef });
  check("dlg-queue-ok", "对话框处理后下一个动作正常执行、不带 dialog", !afterClick.dialog && (await ev("window.__plain")) === 1, afterClick);

  // 6) confirm：accept → true；dismiss → false
  await ev("window.__ret = 'unset'; window.__after = null");
  const cc = await call("click", { ref: confirmRef });
  check("dlg-confirm-open", "confirm 挂起：类型 confirm", cc.dialog?.type === "confirm" && cc.dialog.message === "确定删除吗？", cc.dialog);
  await call("dialog", { action: "accept" });
  await sleep(300);
  check("dlg-confirm-true", "accept → 页面 confirm() 返回 true", (await ev("window.__ret")) === true);

  await ev("window.__ret = 'unset'");
  await call("click", { ref: confirmRef });
  await call("dialog", { action: "dismiss" });
  await sleep(300);
  check("dlg-confirm-false", "dismiss → 页面 confirm() 返回 false", (await ev("window.__ret")) === false);

  // 7) 用户在面板上点「确定」（V4 的 IPC 转调 tab.answerDialog(accept, text)）：等价路径，日志记 system 条目
  await ev("window.__ret = 'unset'");
  await call("click", { ref: confirmRef });
  const userRes = await sess.activeTab.answerDialog(true, undefined, { by: "user" });
  await sleep(300);
  check("dlg-user-answer", "tab.answerDialog(by:user) 处理后页面拿到 true、挂起清掉", userRes.handled === true && (await ev("window.__ret")) === true && sess.getState().dialog === null);
  const entries0 = (await call("user_activity", { markSeen: false, limit: 100 })).entries;
  check("dlg-user-log", "用户处理写入活动日志「用户已确定」", entries0.some((e) => e.kind === "dialog" && /用户已确定/.test(e.summary)), entries0.filter((e) => e.kind === "dialog").map((e) => e.summary));

  // 8) 超时兜底：不处理 → 约 20 秒后自动取消（confirm → false），并写 system 活动日志
  await ev("window.__ret = 'unset'");
  await call("click", { ref: confirmRef });
  const openAt = Date.now();
  const stillPending = (await call("dialog", { action: "status" })).pending !== null;
  check("dlg-hold", "未处理时对话框保持挂起", stillPending);
  let cleared = false;
  while (Date.now() - openAt < 30_000) {
    await sleep(500);
    if ((await call("dialog", { action: "status" })).pending === null) {
      cleared = true;
      break;
    }
  }
  const heldMs = Date.now() - openAt;
  check("dlg-timeout", "约 20 秒后兜底自动处置（19–26 秒内清掉挂起）", cleared && heldMs >= 19_000 && heldMs <= 26_000, { heldMs });
  await sleep(300);
  check("dlg-timeout-result", "confirm 超时兜底 = 取消（页面拿到 false）", (await ev("window.__ret")) === false);
  const entries = (await call("user_activity", { markSeen: false, limit: 100 })).entries;
  check(
    "dlg-timeout-log",
    "活动日志有「20 秒内无人处理，已自动取消」",
    entries.some((e) => e.kind === "dialog" && /20 秒内无人处理，已自动取消/.test(e.summary)),
    entries.filter((e) => e.kind === "dialog").map((e) => e.summary),
  );

  await call("close_session");
  server.close();

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
