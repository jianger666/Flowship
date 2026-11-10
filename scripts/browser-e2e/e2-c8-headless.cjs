"use strict";
/**
 * E2·P10 · C8 冒烟（真 Electron）：面板没打开 / 没有主窗口 / 主窗口关闭后（定时任务无人值守）浏览器还能不能跑。
 *
 * A 段：getMainWindow() 恒为 null（从没有主窗口）——tab 全部挂在隐藏的停车场窗口里，各 op 应全部可用。
 * B 段：先有主窗口并 attach（面板挂载），再把主窗口 destroy，之后继续 dispatch 不崩、不挂；会话销毁后不残留 webContents。
 * 另：ask_user_to_act 无面板时的行为（记录现状）、挂起的提示在其它 op 的结果里带 pendingPrompts。
 *
 * 只能经启动器运行：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-c8-headless.cjs --timeout 150
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog, webContents } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-c8-"));
app.setPath("userData", TMP);
fs.mkdirSync(path.join(TMP, "dl"), { recursive: true });
app.setPath("downloads", path.join(TMP, "dl"));
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>C8</title></head><body>
<h1>headless</h1><button id="b" onclick="window.__clicked=(window.__clicked||0)+1">点我</button>
<input id="i" aria-label="名字框">
<script>console.log('hello-console'); fetch('/api').catch(function(){});</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/api")) {
        res.setHeader("content-type", "application/json");
        return res.end('{"ok":true}');
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
  let mainWin = null; // A 段恒为 null；B 段换成真窗口
  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain,
    nativeImage,
    getMainWindow: () => mainWin,
    isAppUrl: (u) => /:9\//.test(u),
    isTrustedIpcSender: () => true,
    log: () => {},
  });
  manager.onConfig({ evaluateEnabled: true });

  const wcCount = () => webContents.getAllWebContents().length;
  const refOf = (text, name) => {
    for (const line of text.split("\n")) {
      if (line.includes(name)) {
        const m = /\[ref=(e\d+)\]/.exec(line);
        if (m) return m[1];
      }
    }
    return null;
  };
  const mk = (T) => {
    const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
    const tryCall = async (op, args) => {
      try {
        return { ok: true, value: await call(op, args) };
      } catch (e) {
        return { ok: false, code: e?.code, message: e?.message };
      }
    };
    return { call, tryCall };
  };

  // ═══════════ A 段：从没有主窗口 ═══════════
  const base0 = wcCount();
  const A = mk("c8-a");
  const nav = await A.tryCall("navigate", { url: `${base}/` });
  check("a-navigate", "无主窗口：navigate 可用", nav.ok && /C8/.test(nav.value?.title ?? ""), nav.message);
  const snap = await A.tryCall("snapshot", {});
  const btn = snap.ok ? refOf(snap.value.text, "点我") : null;
  const inp = snap.ok ? refOf(snap.value.text, "名字框") : null;
  check("a-snapshot", "无主窗口：snapshot 有 ref", snap.ok && !!btn && !!inp, snap.message);
  const clk = await A.tryCall("click", { ref: btn });
  const clicked = await A.tryCall("evaluate", { expression: "window.__clicked" });
  check("a-click", "无主窗口：click 生效", clk.ok && clicked.ok && clicked.value?.value === 1, clk.message ?? clicked.value);
  const typ = await A.tryCall("type", { ref: inp, text: "abc" });
  const typed = await A.tryCall("evaluate", { expression: "document.getElementById('i').value" });
  check("a-type", "无主窗口：type 生效", typ.ok && typed.value?.value === "abc", typ.message);
  const shot = await A.tryCall("screenshot", {});
  check("a-screenshot", "无主窗口（离屏 / 停车场窗口）：screenshot 可用且有像素", shot.ok && (shot.value?.dataBase64?.length ?? 0) > 1000 && shot.value.width > 0, shot.ok ? { w: shot.value.width, h: shot.value.height, len: shot.value.dataBase64.length } : shot.message);
  const net = await A.tryCall("network", {});
  check("a-network", "无主窗口：network 有条目", net.ok && (net.value?.entries?.length ?? 0) >= 1, net.message);
  const con = await A.tryCall("console", {});
  check("a-console", "无主窗口：console 抓到 hello-console", con.ok && JSON.stringify(con.value).includes("hello-console"), con.message);
  const evr = await A.tryCall("evaluate", { expression: "1+1" });
  check("a-evaluate", "无主窗口：evaluate（开关开）", evr.ok && evr.value?.value === 2, evr.message);
  const pdf = await A.tryCall("save", { kind: "pdf" });
  const pdfPath = pdf.ok ? (pdf.value?.path ?? pdf.value?.filePath ?? "") : "";
  check("a-save-pdf", "无主窗口：save pdf 可用且是 PDF", pdf.ok && pdfPath && fs.existsSync(pdfPath) && fs.readFileSync(pdfPath).subarray(0, 4).toString() === "%PDF", pdf.ok ? pdfPath : pdf.message);
  const t2 = await A.tryCall("tabs", { action: "new", url: `${base}/` });
  const lst = await A.tryCall("tabs", { action: "list" });
  check("a-tabs", "无主窗口：tabs new / list", t2.ok && lst.ok && lst.value.tabs.length === 2, lst.message);
  const st = await A.tryCall("status", {});
  // controller 可能还在 AI 动作后的宽限期（AI_GRACE_MS）里显示 "ai"，不是缺陷；只要不是 "user" 即可
  check("a-status", "无主窗口：status 正常（exists，controller 不是 user）", st.ok && st.value?.exists === true && ["idle", "ai"].includes(st.value?.controller), st.message ?? st.value);
  const state = manager.getSession("c8-a")?.getState?.();
  check("a-getstate", "无主窗口：getState 可取且 attached=false", !!state && state.attached === false, state && { attached: state.attached, tabs: state.tabs?.length });

  // ask_user_to_act 无面板：现状是照常挂起（用户靠系统通知回到面板）；timeoutMs 下限 1s，超时回 timeout 且控制权归还
  const t0 = Date.now();
  const ask = await A.tryCall("ask_user_to_act", { message: "请登录", timeoutMs: 1000 });
  const askMs = Date.now() - t0;
  const st2 = await A.tryCall("status", {});
  check("a-ask-timeout", "无面板 ask_user_to_act：按 timeoutMs 超时返回 outcome=timeout，控制权回 idle", ask.ok && ask.value?.outcome === "timeout" && st2.value?.controller === "idle", { askMs, outcome: ask.value?.outcome, controller: st2.value?.controller });

  // 挂起的提示 → 其它 op 的结果带 pendingPrompts（AI 不空等）
  manager.onConfig({ evaluateEnabled: false });
  const sessA = manager.getSession("c8-a");
  const pendingEval = A.tryCall("evaluate", { expression: "2+2" });
  await sleep(400);
  const snap2 = await A.tryCall("snapshot", {});
  const hints = snap2.ok ? snap2.value?.pendingPrompts : null;
  check("a-pending-prompts", "挂起的 evaluate 授权提示：其它 op 的结果里带 pendingPrompts", Array.isArray(hints) && hints.length === 1 && hints[0].kind === "evaluate", hints);
  const pid = sessA.getState().prompts?.[0]?.id;
  sessA.prompts.answer(pid, { action: "deny" });
  const evDenied = await pendingEval;
  check("a-eval-denied", "提示被拒后 evaluate 以 DENIED 结束（不悬挂）", !evDenied.ok && evDenied.code === "DENIED", evDenied);
  manager.onConfig({ evaluateEnabled: true });

  await A.call("close_session");
  await sleep(600);
  const afterA = wcCount();
  check("a-no-residue", "会话销毁后 tab 的 webContents 全清（只剩停车场窗口自己的 1 个）", afterA <= base0 + 1, { base0, afterA });
  check("a-session-gone", "close_session 后会话不存在", manager.getSession("c8-a") === undefined || manager.getSession("c8-a") === null);

  // ═══════════ B 段：有主窗口并 attach，然后主窗口被销毁 ═══════════
  mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");
  const B = mk("c8-b");
  await B.call("navigate", { url: `${base}/` });
  const sessB = manager.getSession("c8-b");
  sessB.attach({ x: 0, y: 0, width: 800, height: 600 });
  check("b-attached", "有主窗口：attach 后 attached=true", sessB.getState().attached === true);
  const snapB = await B.tryCall("snapshot", {});
  check("b-snapshot-attached", "主窗口在时 snapshot 可用", snapB.ok);

  const dying = mainWin;
  mainWin = null; // getMainWindow 随后返回 null（main.js 的真实做法是返回 null / 已销毁窗口，两种都测）
  dying.destroy();
  await sleep(500);
  const nav2 = await B.tryCall("navigate", { url: `${base}/?again` });
  const snapB2 = await B.tryCall("snapshot", {});
  const btnB = snapB2.ok ? refOf(snapB2.value.text, "点我") : null;
  const clkB = await B.tryCall("click", { ref: btnB });
  const shotB = await B.tryCall("screenshot", {});
  check("b-after-destroy", "主窗口销毁后 navigate / snapshot / click / screenshot 不崩不挂", nav2.ok && snapB2.ok && clkB.ok && shotB.ok && (shotB.value?.dataBase64?.length ?? 0) > 1000, { nav: nav2.message, snap: snapB2.message, clk: clkB.message, shot: shotB.message });

  // 已销毁但仍被 getMainWindow 返回的窗口（isDestroyed()=true）：index.mjs 的 liveMainWindow 会把它当 null
  const zombie = new BrowserWindow({ show: false, width: 400, height: 300 });
  await zombie.loadURL("about:blank");
  mainWin = zombie;
  zombie.destroy();
  const snapZ = await B.tryCall("snapshot", {});
  const tabsZ = await B.tryCall("tabs", { action: "new", url: `${base}/` });
  check("b-zombie-window", "getMainWindow 返回已销毁窗口：snapshot / tabs new 不崩", snapZ.ok && tabsZ.ok, { snap: snapZ.message, tabs: tabsZ.message });
  mainWin = null;

  const stateB = sessB.getState();
  check("b-getstate", "主窗口销毁后 getState 仍可取（tabs 在）", Array.isArray(stateB.tabs) && stateB.tabs.length >= 2, stateB.tabs?.length);

  await B.call("close_session");
  await sleep(600);
  const afterB = wcCount();
  check("b-no-residue", "B 段会话销毁后无残留 webContents（≤ 基线 + 停车场窗口）", afterB <= base0 + 1, { base0, afterB });

  // manager.destroy：停车场窗口也销毁，webContents 回到基线
  manager.destroy();
  await sleep(500);
  check("manager-destroy", "manager.destroy 后 webContents 回到基线", wcCount() <= base0, { base0, now: wcCount() });

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
