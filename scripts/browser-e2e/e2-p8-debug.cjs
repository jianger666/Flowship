"use strict";
/**
 * E2·P8 真机冒烟（真 Electron + 真 CDP）：B5 `debug`（断点 / 作用域脱敏 / 单步 / 异常暂停 / 暂停期间不死锁 / 自动 resume / 收尾）。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p8-debug.cjs --timeout 150
 *
 * createBrowserManager(...).dispatch 直接驱动；临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）。
 * 重点是「死锁风险点」：暂停期间页面主线程被冻结，AI 的 click / read 等必须快速失败（而不是挂住），debug 的 resume 必须立刻成功。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-p8-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const info = (id, detail) => console.log(`SMOKE INFO ${id} ${JSON.stringify(detail)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP_JS = [
  /* 1 */ "function compute() {",
  /* 2 */ '  const password = "hunter2secret";',
  /* 3 */ '  const apiToken = "tok-abcdefghijklmnop";',
  /* 4 */ "  let total = 0;",
  /* 5 */ "  for (let i = 0; i < 3; i++) {",
  /* 6 */ "    total += i;",
  /* 7 */ "  }",
  /* 8 */ "  return total;",
  /* 9 */ "}",
  /* 10 */ 'function boom() { throw new Error("kaboom-uncaught"); }',
  /* 11 */ "function withDebugger() { const note = 1; debugger; return note; }",
  "",
].join("\n");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>P8</title></head><body>
<button id="calc" onclick="window.__calcResult = compute()">calc</button>
<button id="boom" onclick="boom()">boom</button>
<button id="dbg" onclick="window.__dbgResult = withDebugger()">dbg</button>
<script src="/app.js"></script>
</body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/app.js") {
        res.setHeader("content-type", "application/javascript");
        return res.end(APP_JS);
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

  const mkManager = (extra = {}) =>
    mod.createBrowserManager({
      app,
      BrowserWindow,
      WebContentsView,
      session,
      ipcMain,
      nativeImage,
      getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
      isAppUrl: () => false,
      isTrustedIpcSender: () => true,
      log: (m) => console.log("  [log]", m),
      ...extra,
    });
  const manager = mkManager();
  // 总闸关：条件断点 / scope 必须走审批；第一次 scope 时批准「仅本任务」
  manager.onConfig({ evaluateEnabled: false });

  const T = "p8-task";
  const call = (op, args = {}, task = T, m = manager) => m.dispatch(op, args, { taskId: task });
  const tryCall = async (op, args, task = T, m = manager) => {
    try {
      return { ok: true, value: await call(op, args, task, m) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  };
  const timed = async (fn) => {
    const t0 = Date.now();
    const r = await fn();
    return { ...r, ms: Date.now() - t0 };
  };
  const dbg = (args, task = T, m = manager) => call("debug", args, task, m);
  const sess = (task = T, m = manager) => m.getSession(task);
  const waitFor = async (fn, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await fn();
      if (v) return v;
      await sleep(80);
    }
    return null;
  };
  const answerNext = async (task, action, m = manager) => {
    const pr = await waitFor(() => sess(task, m).prompts.list()[0], 4000);
    if (!pr) return null;
    sess(task, m).prompts.answer(pr.id, { action });
    return pr;
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
  const APP_URL = `${base}/app.js`;

  // ═══════════ 准备：页面 + 快照 ═══════════
  await call("navigate", { url: `${base}/` });
  const snapText = (await call("snapshot", {})).text;
  const refCalc = refOf(snapText, "calc");
  const refBoom = refOf(snapText, "boom");
  const refDbg = refOf(snapText, "dbg");
  check("setup-refs", "快照里拿到 calc / boom / dbg 三个按钮的 ref", !!refCalc && !!refBoom && !!refDbg, { refCalc, refBoom, refDbg });

  // ═══════════ 没 acquire 时 debugger; 不暂停 ═══════════
  const st0 = await dbg({ action: "status" });
  check("status-idle", "未使用调试器：status 未暂停、断点 0、调试器未启用", st0.paused === false && st0.breakpointCount === 0 && st0.debuggerActive === false, st0);
  manager.onConfig({ evaluateEnabled: true });
  const noPause = await Promise.race([call("evaluate", { expression: "withDebugger()" }), sleep(4000).then(() => "HANG")]);
  manager.onConfig({ evaluateEnabled: false });
  check("no-acquire-no-pause", "没 acquire 时页面的 debugger; 语句不暂停（evaluate 正常返回 1）", noPause !== "HANG" && noPause?.value === 1, noPause);

  // ═══════════ 断点 + 与 sources 共用 hub ═══════════
  const bad1 = await tryCall("debug", { action: "set_breakpoint", url: APP_URL, line: 0 });
  check("bp-bad-line", "行号 0 / 缺 url 被拒（BAD_ARGS）", !bad1.ok && bad1.code === "BAD_ARGS", bad1.message);
  const bad2 = await tryCall("debug", { action: "set_breakpoint", urlRegex: "(a+)+b", line: 1 });
  check("bp-redos", "嵌套量词的 url_regex 被拒（ReDoS 防护）", !bad2.ok && bad2.code === "BAD_ARGS", bad2.message);
  const bp1 = await dbg({ action: "set_breakpoint", url: APP_URL, line: 6 });
  check("bp-set", "set_breakpoint（第 6 行）成功并绑定到第 6 行", bp1.bound === true && bp1.breakpoint?.locations?.[0]?.line === 6 && bp1.count === 1, bp1.breakpoint);
  const srcList = await call("sources", { action: "list" });
  check("hub-shared-sources", "sources list 与 debug 共用 hub：能列出 app.js，且之后断点仍有效", srcList.items.some((i) => i.url.endsWith("/app.js")));
  const lst = await dbg({ action: "list_breakpoints" });
  check("bp-list", "list_breakpoints 返回 1 个断点", lst.count === 1 && lst.breakpoints[0].id === bp1.breakpoint.id, lst.breakpoints);

  // ═══════════ 真实点击触发断点：在途动作与暂停竞速，不挂住 ═══════════
  const clickHit = await timed(() => tryCall("click", { ref: refCalc }));
  check("click-race", "点击触发断点：click 带「调试器暂停」错误提前返回（没有挂住）", !clickHit.ok && /调试器暂停/.test(clickHit.message ?? "") && clickHit.ms < 6000, { ms: clickHit.ms, code: clickHit.code, msg: (clickHit.message ?? "").slice(0, 60) });
  const st1 = await dbg({ action: "status" });
  check("status-paused", "status：暂停于第 6 行、原因 breakpoint、命中了我们的断点", st1.paused === true && st1.reason === "breakpoint" && st1.line === 6 && st1.hitBreakpoints?.[0]?.id === bp1.breakpoint.id, st1);
  const state1 = sess().getState();
  check("state-debug", "状态 debug:{paused,reason,url,line,since} 已贡献，且不含任何变量值", state1.debug?.paused === true && state1.debug.reason === "breakpoint" && state1.debug.line === 6 && typeof state1.debug.since === "number" && !/hunter2secret|tok-abcdef/.test(JSON.stringify(state1)), state1.debug);

  // ═══════════ 暂停期间：其它 op 快速失败、读缓冲类放行 ═══════════
  const gated = {};
  for (const [name, op, args] of [
    ["click", "click", { ref: refCalc }],
    ["read", "read", {}],
    ["snapshot", "snapshot", {}],
    ["evaluate", "evaluate", { expression: "1+1" }],
    ["screenshot", "screenshot", {}],
    ["navigate", "navigate", { url: `${base}/x` }],
  ]) {
    gated[name] = await timed(() => tryCall(op, args));
  }
  const allFast = Object.values(gated).every((g) => !g.ok && g.ms < 1500 && /调试器暂停/.test(g.message ?? ""));
  check("paused-gate-fast", "暂停期间 click / read / snapshot / evaluate / screenshot / navigate 全部 1.5s 内快速失败（文案含「调试器暂停」）", allFast, Object.fromEntries(Object.entries(gated).map(([k, v]) => [k, { ok: v.ok, ms: v.ms, code: v.code }])));
  const passOps = await Promise.all([tryCall("console", { limit: 5 }), tryCall("network", { limit: 5 }), tryCall("tabs", { action: "list" }), tryCall("status", {})]);
  check("paused-allowlist", "暂停期间 console / network / tabs / status 放行（读缓冲不依赖页面主线程）", passOps.every((r) => r.ok), passOps.map((r) => r.ok || r.message));
  // 探测：绕过闸门直接发 CDP，看暂停时哪些真的会挂住（只记录，不作断言；闸门策略已按「会挂」保守处理）
  const tabRaw = sess().activeTab;
  const probe = async (label, p) => info(`probe-${label}`, await Promise.race([p.then(() => "返回", () => "报错"), sleep(2000).then(() => "挂住(>2s)")]));
  await probe("Page.captureScreenshot", tabRaw.send("Page.captureScreenshot", { format: "jpeg", quality: 30 }));
  await probe("Runtime.evaluate", tabRaw.send("Runtime.evaluate", { expression: "1+1" }));
  // 绕过闸门（暂时清掉镜像）跑一次完整的 screenshot op，看暂停时它会不会挂住——只记录，供决定是否把 screenshot 放进暂停白名单
  {
    const saved = tabRaw.debugPause;
    tabRaw.debugPause = null;
    const shot = await timed(() => Promise.race([tryCall("screenshot", {}), sleep(3000).then(() => "HANG")]));
    tabRaw.debugPause = saved;
    info("probe-screenshot-op-bypassing-gate", { result: shot === "HANG" || shot.ok === undefined ? "挂住(>3s)" : shot.ok ? "成功" : shot.message?.slice(0, 60), ms: shot.ms });
  }

  // ═══════════ scope：审批 + 脱敏 ═══════════
  const scopeDenied = tryCall("debug", { action: "scope" });
  const pr0 = await answerNext(T, "deny");
  const sd = await scopeDenied;
  check("scope-denied", "总闸关 + 用户拒绝：scope 被拒（DENIED），审批卡提示是调试器读变量", pr0?.kind === "evaluate" && !sd.ok && sd.code === "DENIED" && /调试器·读取暂停帧变量/.test(pr0?.detail?.summary ?? ""), { kind: pr0?.kind, summary: pr0?.detail?.summary, code: sd.code });
  const scopeP = tryCall("debug", { action: "scope" });
  await answerNext(T, "task");
  const sc = await scopeP;
  const vars = sc.ok ? sc.value.scopes.flatMap((s) => s.vars) : [];
  const total = vars.find((v) => v.name === "total");
  const pw = vars.find((v) => v.name === "password");
  const tk = vars.find((v) => v.name === "apiToken");
  const dump = JSON.stringify(sc.ok ? sc.value : sc);
  check("scope-total", "批准后 scope：看得到 total 数值（循环第 1 轮 = 0）", sc.ok && total?.value === "0" && total?.type === "number", { total, types: sc.ok ? sc.value.scopes.map((s) => s.type) : sc });
  check("scope-hidden", "password / apiToken 变量显示 [已隐藏]，整个结果里搜不到明文", pw?.value === "[已隐藏]" && tk?.value === "[已隐藏]" && !dump.includes("hunter2secret") && !dump.includes("tok-abcdefghijklmnop") && sc.value?.hiddenCount >= 2, { pw, tk });
  check("scope-no-global", "scope 不展开 global（只有 local / closure / block）", sc.ok && sc.value.scopes.every((s) => ["local", "closure", "block", "catch"].includes(s.type)), sc.ok ? sc.value.scopes.map((s) => s.type) : sc);

  // ═══════════ step_over / resume（resume 必须立刻成功 = 不死锁） ═══════════
  const stepped = await timed(() => dbg({ action: "step_over" }));
  check("step-over", "step_over：仍暂停且位置前进（不再停在第 6 行同一列）", stepped.paused === true && (stepped.line !== 6 || stepped.column !== st1.column), { line: stepped.line, column: stepped.column, from: st1.column, ms: stepped.ms });
  const resumed1 = await timed(() => dbg({ action: "resume" }));
  check("resume-next-hit", "resume 立刻成功（<2s，不死锁），循环下一轮又命中第 6 行断点", resumed1.paused === true && resumed1.line === 6 && resumed1.ms < 2000, { paused: resumed1.paused, line: resumed1.line, ms: resumed1.ms });
  const sc2 = await dbg({ action: "scope" });
  const total2 = sc2.scopes.flatMap((s) => s.vars).find((v) => v.name === "total");
  check("scope-second-hit", "第二次命中时 total 仍为数值（0 + 0），scope 已批准后免弹卡", total2?.type === "number", total2);
  await dbg({ action: "remove_breakpoint", id: bp1.breakpoint.id });
  const resumed2 = await timed(() => dbg({ action: "resume" }));
  check("resume-run", "删除断点后 resume：页面继续运行、不再暂停", resumed2.paused === false && resumed2.ms < 2000, resumed2);
  check("state-cleared", "resume 后状态 debug 清空（面板条消失）", (await waitFor(() => sess().getState().debug === null)) === true || sess().getState().debug === null);
  const calcDone = await waitFor(async () => (await tryCall("evaluate", { expression: "window.__calcResult" })).value?.value === 3, 6000);
  check("page-continued", "页面脚本继续跑完（compute() 返回 3），队列未被卡死、evaluate 恢复可用", !!calcDone);

  // ═══════════ 条件断点：审批 + 只在条件为真时停 ═══════════
  // 另一任务（未批准过）：条件断点被拒，且根本没有设置
  await call("navigate", { url: `${base}/` }, "p8-task2");
  const cdDeny = tryCall("debug", { action: "set_breakpoint", url: APP_URL, line: 6, condition: "i === 2" }, "p8-task2");
  const prc = await answerNext("p8-task2", "deny");
  const cd = await cdDeny;
  const lst2 = await dbg({ action: "list_breakpoints" }, "p8-task2");
  check("cond-denied", "未批准 evaluate 时设条件断点被拒（DENIED），审批卡标明是条件断点，且断点没有设上", !cd.ok && cd.code === "DENIED" && /条件断点/.test(prc?.detail?.summary ?? "") && lst2.count === 0, { code: cd.code, summary: prc?.detail?.summary, count: lst2.count });
  const cdOk = tryCall("debug", { action: "set_breakpoint", url: APP_URL, line: 6, condition: "i === 2" });
  await answerNext(T, "task").catch(() => null); // 本任务已批准：不会有提示（answerNext 等 4s 超时返回 null）
  const bpc = await cdOk;
  check("cond-set", "本任务已批准后：条件断点设置成功（带条件）", bpc.ok && bpc.value.breakpoint?.conditional === true, bpc.ok ? bpc.value.breakpoint : bpc);
  const hitC = await timed(() => tryCall("click", { ref: refCalc }));
  const stc = await dbg({ action: "status" });
  const scc = stc.paused ? await dbg({ action: "scope" }) : null;
  const totalC = scc?.scopes.flatMap((s) => s.vars).find((v) => v.name === "total");
  const iC = scc?.scopes.flatMap((s) => s.vars).find((v) => v.name === "i");
  check("cond-hit", "条件 i===2：只在第 3 轮才停（i=2、total=1）", stc.paused === true && iC?.value === "2" && totalC?.value === "1", { hitMs: hitC.ms, i: iC, total: totalC });
  const ids = (await dbg({ action: "list_breakpoints" })).breakpoints.map((b) => b.id);
  for (const id of ids) await dbg({ action: "remove_breakpoint", id });
  await dbg({ action: "resume" });

  // ═══════════ pause_on_exception ═══════════
  await dbg({ action: "pause_on_exception", state: "uncaught" });
  const boomHit = await timed(() => tryCall("click", { ref: refBoom }));
  const stb = await waitFor(async () => {
    const s = await dbg({ action: "status" });
    return s.paused ? s : null;
  });
  check("exception-pause", "pause_on_exception=uncaught：未捕获异常触发暂停（reason=exception，异常描述含 kaboom-uncaught）", stb?.reason === "exception" && /kaboom-uncaught/.test(stb?.exception ?? ""), { reason: stb?.reason, exception: stb?.exception, clickMs: boomHit.ms });
  await dbg({ action: "resume" });
  await dbg({ action: "pause_on_exception", state: "none" });

  // ═══════════ debugger; 语句（AI 没设断点）+ 用户接管 ═══════════
  const dbgHit = await timed(() => tryCall("click", { ref: refDbg }));
  const std = await waitFor(async () => {
    const s = await dbg({ action: "status" });
    return s.paused ? s : null;
  });
  check("debugger-statement", "页面里的 debugger; 语句：按暂停机制处理（reason=debugger_statement，click 提前返回）", std?.reason === "debugger_statement" && !dbgHit.ok, { reason: std?.reason, clickMs: dbgHit.ms });
  sess().takeover();
  const uc = await Promise.all([tryCall("debug", { action: "resume" }), tryCall("debug", { action: "step_over" }), tryCall("debug", { action: "set_breakpoint", url: APP_URL, line: 2 })]);
  const ro = await Promise.all([tryCall("debug", { action: "status" }), tryCall("debug", { action: "list_breakpoints" })]);
  check("user-control", "用户接管时：resume / step / set_breakpoint → USER_CONTROL；status / list_breakpoints 放行；接管不自动 resume", uc.every((r) => !r.ok && r.code === "USER_CONTROL") && ro.every((r) => r.ok) && ro[0].value.paused === true && sess().getState().debug?.paused === true, { uc: uc.map((r) => r.code), ro: ro.map((r) => r.ok) });
  sess().handback("done");
  const rUser = await timed(() => tryCall("debug", { action: "resume" }));
  check("handback-resume", "交还后 AI 的 resume 成功", rUser.ok && rUser.value.paused === false && rUser.ms < 2000, { ms: rUser.ms });

  // ═══════════ 断点上限 20 ═══════════
  const many = [];
  for (let n = 1; n <= 20; n++) many.push(await tryCall("debug", { action: "set_breakpoint", url: APP_URL, line: n % 2 === 0 ? 8 : 4, column: n }));
  const over = await tryCall("debug", { action: "set_breakpoint", url: APP_URL, line: 8, column: 99 });
  check("bp-limit", "每 tab 最多 20 个断点：第 21 个被拒（BAD_ARGS，文案指向 remove_breakpoint）", many.filter((r) => r.ok).length === 20 && !over.ok && over.code === "BAD_ARGS" && /remove_breakpoint/.test(over.message ?? ""), { okCount: many.filter((r) => r.ok).length, msg: over.message });
  for (const b of (await dbg({ action: "list_breakpoints" })).breakpoints) await dbg({ action: "remove_breakpoint", id: b.id });

  // ═══════════ tab 关闭 / 会话销毁：无残留暂停 ═══════════
  await dbg({ action: "set_breakpoint", url: APP_URL, line: 6 });
  await tryCall("click", { ref: refCalc });
  const pausedBeforeClose = (await dbg({ action: "status" })).paused === true;
  await call("tabs", { action: "new", url: `${base}/` });
  const tabsList = await call("tabs", { action: "list" });
  const firstTab = tabsList.tabs?.[0]?.id ?? sess().tabs[0].id;
  const closeR = await tryCall("tabs", { action: "close", tabId: firstTab });
  check("tab-close-clean", "暂停中关闭该 tab：不挂住，状态里不再有暂停", pausedBeforeClose && closeR.ok && (await waitFor(() => sess().getState().debug === null, 3000)) !== null, { pausedBeforeClose, close: closeR.ok ? "ok" : closeR.message });
  const closeSess = await timed(() => tryCall("close_session", {}));
  check("close-session", "close_session 正常结束", closeSess.ok && closeSess.ms < 5000, closeSess.ms);
  await tryCall("close_session", {}, "p8-task2");

  // ═══════════ 120s 兜底（缩短成 1.5s 的注入）自动 resume ═══════════
  const manager2 = mkManager({ debugAutoResumeMs: 1500 });
  manager2.onConfig({ evaluateEnabled: true });
  const T3 = "p8-task3";
  await call("navigate", { url: `${base}/` }, T3, manager2);
  const snap3 = (await call("snapshot", {}, T3, manager2)).text;
  const ref3 = refOf(snap3, "calc");
  await dbg({ action: "set_breakpoint", url: APP_URL, line: 6 }, T3, manager2);
  await tryCall("click", { ref: ref3 }, T3, manager2);
  const p3 = (await dbg({ action: "status" }, T3, manager2)).paused === true;
  const t0 = Date.now();
  // 先删断点（暂停中也能删），这样自动 resume 之后不会在循环下一轮又停下来，计时才是「一次兜底」的时长
  const bps3 = (await dbg({ action: "list_breakpoints" }, T3, manager2)).breakpoints;
  for (const b of bps3) await dbg({ action: "remove_breakpoint", id: b.id }, T3, manager2);
  const auto = await waitFor(async () => (await dbg({ action: "status" }, T3, manager2)).paused === false, 5000);
  const sinceAuto = Date.now() - t0;
  const recent3 = sess(T3, manager2).activityLog.recent(30).map((e) => e.summary);
  check("auto-resume", "暂停满兜底时长自动 resume（注入 1.5s；生产为 120s）：约 1.5s 后状态清空", p3 && !!auto && sinceAuto >= 800 && sinceAuto < 4000 && sess(T3, manager2).getState().debug === null, { sinceMs: sinceAuto });
  check("auto-resume-log", "自动 resume 写了活动日志（「已自动继续运行」）", recent3.some((s) => /已自动继续运行/.test(s)), recent3.slice(-4));
  const done3 = await waitFor(async () => (await tryCall("evaluate", { expression: "typeof window.__calcResult" }, T3, manager2)).value?.value !== undefined, 4000);
  check("auto-resume-page", "自动 resume 之后 AI 的 op 恢复可用", !!done3);
  await tryCall("close_session", {}, T3, manager2);

  server.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`E2P8 SUMMARY ${passed}/${results.length} passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(passed === results.length ? 0 : 1);
};

main().catch((err) => {
  console.error("E2P8 FATAL", err && err.stack ? err.stack : err);
  const passed = results.filter((r) => r.ok).length;
  console.log(`E2P8 SUMMARY ${passed}/${results.length} passed (FATAL)`);
  app.exit(1);
});
