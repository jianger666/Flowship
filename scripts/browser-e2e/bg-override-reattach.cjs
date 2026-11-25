"use strict";
/**
 * 透明截图「还原默认背景」的欠账（`#bgDirty`）在 debugger 重新 attach 时的去留（真 Electron + 真 CDP；第十八轮 B5）。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/bg-override-reattach.cjs --timeout 240
 *
 * 背景：`tab.mjs` 的 `omit_background` 截图是「设透明默认背景 → 截 → 还原」；还原没成功（CDP 报错 / 超时）就在 `#bgDirty` 里记一笔欠账，下一条截图开头补发一次 `{}`。
 * 问题是：debugger 掉线后重新 attach，这笔欠账还要不要留？不清 = 多发一条幂等的 `{}`；清错了 = 覆盖其实还在、页面一直留着透明底。两边风险不对称，
 * 所以先实测、再按实测定（第十八轮，实测结果）：
 *   ① detach → 重新 attach 之后，默认背景色覆盖**不在了**（页面回到不透明默认底）→ 欠账作废，`#attachDebugger` 在「真的新 attach」时清掉它；
 *   ② 渲染进程崩溃再重载、debugger **没掉线**时覆盖**还在** → 欠账必须留着，下一条截图开头补发的 `{}` 才能把页面还原。
 * 这是 Chromium 内部行为，可能随 Electron 升级变化——本脚本把两边都钉成断言（升级后跑一遍即可发现）；`tests/browser-emulation-fit.test.ts` 用假 CDP 钉「新 attach 才清」的分支。
 *
 * 证据范围（第十八轮 R19-13）：**证据只在 macOS、Electron 42.4.0 / Chrome 148 上取得**。这几条是 Chromium 层的行为、不依赖操作系统，所以脚本**不加 `process.platform` 硬守卫**（别的平台 / 版本上跑也能跑），
 * 但没在别处验证过——脚本一启动就打一行 `SMOKE INFO platform=… arch=… electron=… chrome=…`，对不上上面这组版本就别把结果当成证据（红了先怀疑版本差异，而不是直接怀疑 tab.mjs）。
 *
 * 判据（取样：在截图的 5 个点——四个角往里缩 6 像素、再加底边中点——取 alpha，**多数（≥3 个点）**判定；页面是空白页，没有任何内容，这些点就是「默认背景」）：
 *   - bg-01 / bg-01b / bg-02 是 Chromium 行为的前提（不经 tab，原始 debugger）：透明覆盖生效；**清掉覆盖后取样读到不透明（取样器的正向对照：既读得到透明、也读得到不透明）**；detach → attach 之后覆盖不在；
 *   - bg-03ctl / bg-03：欠账 + 真新 attach → 下一条截图不再补发 `{}`，且截图是不透明底。**bg-03ctl 是 bg-03b 的正向对照**：同样的欠账、但**不** re-attach，下一条截图必须补发恰好一次 `{}`——证明「数补发命令」的插桩有效，bg-03b 的「0 条」才有意义；
 *     bg-03d：主动 detach 场景计数——detach 事件恰好 1 次、`attach` 调用恰好 +1 次（确实发生了一次真的新 attach，不是别的路径）；
 *   - bg-04：欠账 + 渲染进程崩溃重载（debugger 没掉线）→ 覆盖仍在（前提）、下一条截图开头补发一次 `{}`（先于截图命令）、补发之后截图回到不透明底。
 *     「debugger 没掉线」在 `ensureCdp()` **之前**读 `isAttached()`（之后读会被自愈本身污染）；bg-04d 计数——崩溃到自愈结束期间 detach 事件 0 次、`attach` 调用 0 次。
 * 「还原被拒」靠插桩造：对 `Emulation.setDefaultBackgroundColorOverride` 且参数为空的命令直接 reject、不发给 Chromium（页面里的覆盖原样留着，就像真的没还原成）。
 * 等待一律轮询（有总超时）而不是固定 sleep；会卡住的异步调用都带总超时、卡住就报错进 SMOKE ERROR 路径（仍会清理临时目录）：
 * 脚本直发的原始 CDP 命令（rawSend，含 rawShot / innerWidth）15 秒、`manager.dispatch(navigate)` 30 秒、两处 `loadURL` 15 秒、tab 自己的 `send(captureScreenshot)` 20 秒、`ensureCdp` 15 秒（第二十轮评审 R20-19：此前只有 rawShot / innerWidth 带超时，其余卡住会一直挂到启动器的总超时）。
 * 三条退出路径（通过 / 断言失败 / 抛错）共用同一个 cleanupAll：先关 fixture 服务、destroy manager、销毁剩下的窗口，再清临时 userData——抛错路径也不会把服务和 manager 留着。
 *
 * 顺带观察（INFO 行，不是断言）：同一次 detach → attach 之后，设备模拟的视口覆盖（setDeviceMetricsOverride）仍在——`#replayEmulation` 因此是冗余的幂等重发。
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-bg-reattach-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BG = "Emulation.setDefaultBackgroundColorOverride";
const CAP = "Page.captureScreenshot";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>bg-override</title><style>html,body{margin:0}</style></head><body></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

/**
 * 截图（base64 png）上 5 个取样点的 alpha（四个角往里缩 6 像素 + 底边中点），多数（≥3 个点）判定「透明 / 不透明」（第十八轮 R19-13：原先只取右下角一个像素，单点噪声就能翻转结论）。
 * 返回 { alphas, clearVotes, opaqueVotes, size }；判定用 isClear / isOpaque。
 */
const SAMPLE_VOTES = 3;
const cornerOf = (b64) => {
  const img = nativeImage.createFromBuffer(Buffer.from(b64, "base64"));
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const m = 6;
  const pts = [
    [width - m, height - m],
    [m, height - m],
    [width - m, m],
    [m, m],
    [Math.floor(width / 2), height - m],
  ];
  const alphas = pts.map(([x, y]) => bmp[(y * width + x) * 4 + 3]);
  return { alphas, clearVotes: alphas.filter((a) => a < 64).length, opaqueVotes: alphas.filter((a) => a >= 250).length, size: `${width}x${height}` };
};
const isClear = (c) => c.clearVotes >= SAMPLE_VOTES; // 透明（本机实测 alpha 为 0 或 20 上下，不是严格的 0，所以阈值取 <64）
const isOpaque = (c) => c.opaqueVotes >= SAMPLE_VOTES;

/** 轮询直到 pred 为真（返回 true）或超过总超时（返回 false）；pred 可以是 async，抛错按「还没好」算 */
const waitFor = async (pred, timeoutMs, stepMs = 50) => {
  const t0 = Date.now();
  for (;;) {
    if (await Promise.resolve(pred()).catch(() => false)) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(stepMs);
  }
};
/** 给一个 promise 加总超时：超时抛错（脚本进 SMOKE ERROR 路径，仍清理临时目录） */
const withTimeout = (p, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms} 毫秒）`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

/**
 * 收尾登记表：main 里一建好就登记，三条退出路径（通过 / 断言失败 / 抛错）共用下面的 cleanupAll 释放（第二十轮评审 R20-19：此前抛错路径不关 server / manager）。
 */
const live = { server: null, manager: null };

const main = async () => {
  await app.whenReady();
  // 证据范围：只在 macOS / Electron 42.4.0 / Chrome 148 上取得（见头注释）；这一行让每次运行的环境一目了然
  console.log(`SMOKE INFO platform=${process.platform} arch=${process.arch} electron=${process.versions.electron} chrome=${process.versions.chrome}（证据仅取自 macOS / Electron 42.4.0 / Chrome 148）`);
  const { server, base } = await startFixture();
  live.server = server;
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);

  const mainWin = new BrowserWindow({ show: false, width: 1700, height: 1100, webPreferences: { sandbox: true } });
  await withTimeout(mainWin.loadURL("about:blank"), 15000, "mainWin.loadURL(about:blank)");
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
  live.manager = manager;
  manager.onConfig({ evaluateEnabled: true });

  const T = "bg-reattach-task";
  await withTimeout(manager.dispatch("navigate", { url: `${base}/` }, { taskId: T }), 30000, "manager.dispatch(navigate)");
  const sess = manager.getSession(T);
  const tab = () => sess.activeTab;
  const wc = () => tab().wc;

  // ── 插桩：记每条 CDP 命令；「还原」（BG 且参数为空）可按开关直接拒掉、不发给 Chromium ──
  const cmds = []; // { method, empty }
  const failRestore = { on: false };
  const dbg = wc().debugger;
  // 插桩前的原始发送（无超时）：只给下面的插桩转发用——tab 自己的 CDP 调用经插桩落到它，超时语义归 tab 自己，脚本不替它加
  const sendUnbounded = dbg.sendCommand.bind(dbg);
  // 脚本自己直发的原始命令（感知用的截图 / innerWidth / 设覆盖等）：不经 tab 的队列、不触发补发、不进 cmds；带 15 秒总超时，卡住报错而不是一直挂着
  const rawSend = (method, params, sessionId) => withTimeout(sendUnbounded(method, params, sessionId), 15000, `rawSend(${method})`);
  dbg.sendCommand = (method, params, sessionId) => {
    const empty = !params || Object.keys(params).length === 0;
    cmds.push({ method, empty });
    if (failRestore.on && method === BG && empty) return Promise.reject(new Error("Session with given id not found"));
    return sendUnbounded(method, params, sessionId);
  };
  // 计 attach 调用次数与 detach 事件次数（第十八轮 R19-13：只看「isAttached() 之后是什么」证明不了到底有没有发生真的新 attach）。
  // attach 在 debugger 对象上包一层（tab 经同一个 `wc.debugger` 调它）；detach 靠事件，主动 `dbg.detach()` 与 Chromium 自己断开都会计
  const counts = { attach: 0, detach: 0 };
  const rawAttach = dbg.attach.bind(dbg);
  dbg.attach = (...args) => {
    counts.attach += 1;
    return rawAttach(...args);
  };
  dbg.on("detach", () => {
    counts.detach += 1;
  });
  const isRestore = (c) => c.method === BG && c.empty;
  const rawShot = async () => cornerOf((await rawSend(CAP, { format: "png" })).data);
  const tabShot = async () => cornerOf((await withTimeout(tab().send(CAP, { format: "png" }), 20000, "tab.send(captureScreenshot)")).data);
  const transparentShot = () => withTimeout(tab().send(CAP, { format: "png" }, null, undefined, { transparentBackground: true }), 20000, "tab.send(captureScreenshot, transparentBackground)");
  /** 主动 detach 再经 ensureCdp 自愈（真的新 attach）；返回这一轮 detach 事件 / attach 调用各发生了几次 */
  const redetach = async () => {
    const m0 = { attach: counts.attach, detach: counts.detach };
    dbg.detach();
    const sawDetach = await waitFor(() => counts.detach > m0.detach, 3000);
    await withTimeout(tab().ensureCdp(), 15000, "tab.ensureCdp"); // 自愈：isAttached() 为假 → 真的新 attach
    return { sawDetach, detachDelta: counts.detach - m0.detach, attachDelta: counts.attach - m0.attach };
  };
  const innerW = async () => (await rawSend("Runtime.evaluate", { expression: "innerWidth", returnByValue: true })).result.value;

  // ── bg-01 / bg-01b / bg-02：Chromium 行为的前提（原始 debugger，不经 tab 的欠账逻辑）──
  await rawSend(BG, { color: { r: 0, g: 0, b: 0, a: 0 } });
  const c1 = await rawShot();
  check("bg-01", "前提：设了透明默认背景覆盖，5 点取样多数是透明的", isClear(c1), c1);
  await rawSend(BG, {});
  const c1b = await rawShot();
  check("bg-01b", "取样器正向对照：清掉覆盖之后，5 点取样多数读到不透明（取样器既读得到透明、也读得到不透明）", isOpaque(c1b), c1b);
  await rawSend(BG, { color: { r: 0, g: 0, b: 0, a: 0 } }); // 重新设上，供 bg-02 验证 detach 丢覆盖
  const r2 = await redetach();
  const c2 = await rawShot();
  check("bg-02", "前提：detach → 重新 attach 之后，默认背景色覆盖不在了（回到不透明默认底）——所以欠账作废是对的", isOpaque(c2), { c2, ...r2 });

  // 顺带观察（不是断言）：视口覆盖在同一次 detach → attach 之后是否还在
  {
    await rawSend("Emulation.setDeviceMetricsOverride", { width: 500, height: 400, deviceScaleFactor: 1, mobile: false });
    const before = await innerW();
    await redetach();
    const after = await innerW();
    await rawSend("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    console.log(`SMOKE INFO 视口覆盖 detach → attach：之前 innerWidth=${before}，之后 innerWidth=${after}（${before === after ? "仍在" : "已丢"}；不影响判定）`);
  }

  // ── bg-03ctl：bg-03b 的正向对照——同样的欠账、但不 re-attach：下一条截图必须补发恰好一次 {}（证明「数补发命令」的插桩有效）──
  failRestore.on = true;
  await transparentShot(); // 设透明 → 截 → 还原被拒（记欠）
  failRestore.on = false;
  const dirtyCtl = await rawShot();
  check("bg-03ctl-a", "对照前提：还原被拒后页面确实留着透明默认背景（欠账是真的）", isClear(dirtyCtl), dirtyCtl);
  cmds.length = 0;
  const cCtl = await tabShot(); // 没有 re-attach：欠账还在，排他段开头会先补发一次 {}
  check("bg-03ctl", "正向对照：没有 re-attach 时，下一条截图补发恰好一次 {}（先于截图命令），补发之后是不透明底", cmds.filter(isRestore).length === 1 && cmds.findIndex(isRestore) < cmds.findIndex((c) => c.method === CAP) && isOpaque(cCtl), { restores: cmds.filter(isRestore).length, shot: cCtl });

  // ── bg-03：欠账 + 真新 attach → 欠账作废 ──
  failRestore.on = true;
  await transparentShot(); // 设透明 → 截 → 还原被拒（记欠）
  failRestore.on = false;
  const dirty3 = await rawShot();
  check("bg-03a", "前提：还原被拒后页面确实留着透明默认背景（欠账是真的）", isClear(dirty3), dirty3);
  const r3 = await redetach();
  check("bg-03d", "主动 detach 场景计数：detach 事件恰好 1 次、attach 调用恰好 +1 次（确实发生了一次真的新 attach）", r3.detachDelta === 1 && r3.attachDelta === 1, r3);
  cmds.length = 0;
  const c3 = await tabShot(); // 普通截图：欠账若还在，排他段开头会先补发一次 {}
  check("bg-03b", "真新 attach 之后：欠账作废——下一条截图不再补发 {}（对照见 bg-03ctl：没 re-attach 时补发 1 次）", cmds.filter(isRestore).length === 0, cmds.map((c) => c.method + (c.empty ? "{}" : "")));
  check("bg-03c", "且这条截图是不透明底", isOpaque(c3), c3);

  // ── bg-04：欠账 + 渲染进程崩溃重载、debugger 没掉线 → 覆盖还在，欠账要留着 ──
  failRestore.on = true;
  await transparentShot();
  failRestore.on = false;
  const m4 = { attach: counts.attach, detach: counts.detach }; // 崩溃之前的计数基线
  const gone = new Promise((resolve) => wc().once("render-process-gone", (_e, d) => resolve(d?.reason || "gone")));
  wc().forcefullyCrashRenderer();
  const goneReason = await Promise.race([gone, sleep(8000).then(() => "timeout")]);
  await withTimeout(wc().loadURL(`${base}/`), 15000, "wc.loadURL(崩溃后重载)");
  // 重载之后等页面真的可以应答（轮询，总超时 8 秒），代替原先固定 sleep(300) + sleep(500)
  const pageBack = await waitFor(async () => (await withTimeout(rawSend("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }), 3000, "readyState")).result.value === "complete", 8000, 100);
  // 在 ensureCdp() **之前**读 isAttached()：之后读会被自愈本身污染（原先读在 ensureCdp 之后，「没掉线」那一半是空转的）
  const attachedBeforeEnsure = wc().debugger.isAttached();
  const cdpReadyBeforeEnsure = tab().cdpReady; // 预期为 false：render-process-gone 置的；只作为详情，不作断言
  await withTimeout(tab().ensureCdp(), 15000, "tab.ensureCdp（崩溃重载后）"); // render-process-gone 只置 cdpReady = false；debugger 还连着 → 不是新 attach
  const attachedAfterEnsure = wc().debugger.isAttached();
  const dirty4 = await rawShot();
  check("bg-04a", "前提：渲染进程崩溃 + 重载、debugger 没掉线（ensureCdp 之前读 isAttached()）——透明覆盖还在", goneReason !== "timeout" && pageBack && attachedBeforeEnsure && isClear(dirty4), { goneReason, pageBack, attachedBeforeEnsure, cdpReadyBeforeEnsure, attachedAfterEnsure, dirty4 });
  check("bg-04d", "崩溃重载场景计数：从崩溃到自愈结束，detach 事件 0 次、attach 调用 0 次（没有发生新 attach，所以欠账该留着）", counts.detach === m4.detach && counts.attach === m4.attach, { detachDelta: counts.detach - m4.detach, attachDelta: counts.attach - m4.attach });
  cmds.length = 0;
  const c4 = await tabShot();
  const iRestore = cmds.findIndex(isRestore);
  const iCap = cmds.findIndex((c) => c.method === CAP);
  check("bg-04b", "欠账留着：下一条截图开头补发一次 {}（先于截图命令）", cmds.filter(isRestore).length === 1 && iRestore >= 0 && iRestore < iCap, cmds.map((c) => c.method + (c.empty ? "{}" : "")));
  check("bg-04c", "补发之后这条截图回到不透明底", isOpaque(c4), c4);
};

/**
 * 退出前统一收尾；成功 / 断言失败 / 脚本抛错三条路径都走这里（失败路径也不留 fs-browser-bg-reattach-* 目录、不把 fixture 服务和 manager 留着）。
 * 每一步独立 try、互不拖累，且幂等（manager.destroy 有 destroyed 守卫、server.close 重复调不抛）。
 */
const cleanupAll = () => {
  try {
    live.server?.close();
  } catch {
    /* 已关 */
  }
  try {
    live.manager?.destroy();
  } catch {
    /* 已销毁 */
  }
  // 先销毁剩下的窗口（Chromium 还在往 userData 写缓存时 rmSync 会撞 ENOTEMPTY），再重试着清；仍清不掉只告警——但要说出来，别吞
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.destroy();
    } catch {
      /* 已销毁 */
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn("SMOKE WARN 临时 userData 没清掉（不影响结果）：", TMP, err && err.message ? err.message : err);
  }
};

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`);
    cleanupAll();
    app.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error("SMOKE ERROR", e);
    cleanupAll();
    app.exit(2);
  });
