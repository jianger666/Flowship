"use strict";
/**
 * 截图 × 设备模拟 / 视图尺寸 的互斥（真 Electron + 真 CDP）。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/capture-emulation-race.cjs --timeout 300
 *
 * 背景（用户记录的 bug：面板上写着「模拟 Desktop 1440 · 适应 79%」，原生视图里的画面却是没缩放的 1440 宽，越出面板盖住了事件流）：
 *   设备模拟生效时，Chromium 处理一条 `Page.captureScreenshot` 会**临时**把页面改成模拟尺寸、截完再把「开始时记下的模拟参数 + 视图尺寸」写回去。
 *   感知类 op（browser_screenshot / browser_save …）不走 runAction，AI 并行发两条就会交叉——第二条记下的「原始值」是第一条临时改过的值，
 *   两条都结束后页面被留在 1440×900 未缩放、原生视图却仍是缩放后的小矩形；截图在飞时拖面板（缩放重算 / 视图矩形变化）或 emulate 也会被截图结束时写回的旧值盖掉。
 *   这些只有真 Chromium 才复现得出来（单测的假 CDP 不会「写回旧值」），本脚本在真 Chromium 里证实 Tab 现在把截图和它们互斥。
 *
 * 判据：
 *   - 画面几何（几何判据，不看主进程的账）：视图合成面 = 视图矩形 × 显示器倍率；蓝块贴合成面右下角、绿块贴左上角（页面恰好铺满视图）；
 *     画面比视图大 / 小、或没缩放，这两条一定有一条不成立；
 *   - 页面看到的视口：innerWidth 等于当前模拟宽（emulate 没被截图结束时写回的旧参数盖掉）；
 *   - CDP 层互斥（插桩 debugger.sendCommand 记每条命令的在飞区间）：任何时刻最多一条 Page.captureScreenshot 在飞，
 *     且没有 Emulation.setDeviceMetricsOverride 与截图的区间重叠——与时序运气无关，修复前的代码在并发截图时必然重叠。
 *   - 视图在父窗口之间搬动（cx-08 / cx-09，第九轮评审 B1 / P3-4）：截图在飞时面板被打开 / 关闭——每个采样点上
 *     「挂在主窗口 + 可见 + 矩形仍是停车场的 1280×800」一次都不能出现；截完视图矩形 = 该有的矩形、页面视口跟视图走。
 *   - 截图在飞时缩放（cx-10，第十轮评审 B-4）：user-features.applyZoom 直接调 wc.setZoomLevel、不经模拟队列；
 *     判据是最终状态与「只缩放」逐项一致。实测一致（缩放不是截图结束时被写回的那类状态），所以缩放路径不进队列。
 *
 * 用例总数：cx-01 … cx-10 共 10 条，另有 cx-03b / 05b / 08b / 10b 四条「测试有效性」检查。
 * 前三条（03b / 05b / 08b）本机截图太快、没有一次交叉上时输出 SKIP 而不是 PASS（不进结果、不影响退出码，最后的 SUMMARY 行会列出被 SKIP 的 id）；
 * cx-10b 不一样（第十一轮评审 P3-6）：每个用例交叉不上会再来，最多试 4 次（含第一次；重试是轮询 spans 等到有截图命令在飞再缩放，不是更短的延迟，见下），仍交叉不上就是 FAIL——否则 cx-10 在「缩放根本没落在截图期间」时空转也报绿。
 *   相位（第十五轮评审 P3-4）：第 1、2 次重试（第 2、3 次尝试）在命令在飞之后**再等各用例自己的偏移 d** 才缩放（名义相位）；**最后一次（第 4 次尝试）放弃保留偏移**、命令一在飞就缩放（偏移 0）——
 *   前几次都交叉不上说明这个相位在本机太晚，「交叉上」比「落在第几毫秒」更要紧。detail 里的 `crossedAt` 记的是**实测**相位（缩放那一刻距这条截图命令发出多少毫秒），
 *   不是名义偏移；`fallbackOffset0` 为真 = 这个用例是靠最后一次放弃偏移才交叉上的（d 本来就是 0 的用例，最后一次没有放弃任何东西，不标）。
 *   如实（第十六轮评审 P3-B4）：放弃偏移之后 cx-10b 实质上只会在「等满 5 秒仍没有截图命令发出」时 FAIL，它保证的是「缩放落在一条在飞的截图命令期间」这个交叉事实、不是第几毫秒；
 *   失败时 detail 里的 `uncrossedTrace` 逐次记 `crossed` / `late`（命令发出过、缩放时它已应答；带 `commandRoundTripMs` 命令往返、`lateByMs` 缩放距它应答已过去多久）/
 *   `not_yet_sent`（第 0 次尝试：只等了 `sleep(d)`、命令还没发出——不是卡住，后面还有重试）/ `never_sent`（重试尝试：轮询等满 5 秒仍没有命令发出），分得清是哪一种；
 *   另记 `waitedMs`（判交叉前实际等了多久）与 `captureCount`（**判交叉那一刻已发出**的 Page.captureScreenshot 条数——不是这次 op 最终会发的总数，判完后可能还有后续命令；`late` 取**最后**一条已应答的，不是第一条）（第十七轮评审 B-4）。
 *   「取最后一条」是**防御性**写法，在本脚本里目前等价于「取唯一一条」（第十八轮评审 R-3 订正；第十七轮原先写的理由「saveFull 连发多条」不成立）：核实 `tab.mjs` 的 `screenshot()`，
 *   png / jpeg 路径只发一条 `Page.captureScreenshot`（本脚本的 saveFull 是 `format: "png"`、`maxWidth: 100000`，一条）；只有 **webp 且宽度超过 maxWidth** 的缩小分支才会按比例缩小 scale 再截第二条——本脚本没有用 webp。
 *   留着「取最后一条」是因为将来用例若换成 webp 缩小分支，第一条（很早就结束）会被误当成「太晚的那条」；改不改它不影响现有用例的结果。
 *   「交叉上」的判据（第十二轮评审 P3-8）：调 `setZoomLevel` 的同一个同步步骤里，插桩的 `spans` 里有一条 `Page.captureScreenshot` 还在飞（t1 仍为 null）——
 *   原先看「外层 promise 还没结算」，那段时间可能还在排队 / 取布局 / 解码图片，没有任何一条 CDP 截图命令在飞，缩放根本没落在 Chromium 处理截图的那一刻。
 * 所以一次完整运行 PASS 的条数在 11~14 之间；SKIP 的那几条说明那一类交叉这一轮没测到，不是失败。
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog, screen } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-capture-race-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const skipped = [];
const skip = (id, name, why) => {
  skipped.push(id);
  console.log(`SMOKE SKIP ${id} ${name} ${JSON.stringify(why)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 红底；绿块贴视口左上、蓝块贴视口右下（fixed，随视口走）；后面拖一段 4000px 的高度，让整页截图够慢、够有机会和别的事交叉；
// 滚动条宽度设为 0（否则长页面的滚动条会让蓝块够不到合成面右缘，几何判据就不准了）
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>capture-race</title>
<style>html,body{margin:0;background:#f00}::-webkit-scrollbar{width:0;height:0}.sq{position:fixed;width:100px;height:100px}#tl{left:0;top:0;background:#0f0}#br{right:0;bottom:0;background:#00f}</style></head>
<body><div class="sq" id="tl"></div><div class="sq" id="br"></div><div style="height:4000px"></div></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

// ── 期望值：这里刻意再写一遍公式（不 import 被测的纯函数），让 e2e 独立于实现 ──
const expScale = (slot, w, h) => Math.floor(Math.min(1, slot.width / w, slot.height / h) * 1000) / 1000;
const expView = (slot, w, h, s) => {
  const width = Math.min(slot.width, s < 1 ? Math.floor(w * s) : w);
  const height = Math.min(slot.height, s < 1 ? Math.floor(h * s) : h);
  return { x: slot.x + Math.floor((slot.width - width) / 2), y: slot.y, width, height };
};
const eqRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const main = async () => {
  await app.whenReady();
  const { server, base } = await startFixture();
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const dsf = screen.getPrimaryDisplay().scaleFactor || 1;

  const mainWin = new BrowserWindow({ show: false, width: 1700, height: 1100, webPreferences: { sandbox: true } });
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

  const T = "capture-race-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        /* 继续等 */
      }
      if (Date.now() - t0 > ms) return false;
      await sleep(40);
    }
  };

  await call("navigate", { url: `${base}/` });
  const sess = manager.getSession(T);
  const tab = () => sess.activeTab;
  const wc = () => tab().wc;
  const viewBounds = () => tab().view.getBounds();
  const stTab = () => sess.getState().tabs.find((t) => t.isActive);
  const rawEv = async (expr) => (await tab().send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

  // ── 插桩：记每条 CDP 命令的在飞区间（只记截图与视口覆盖），用来判「是否交叉」 ──
  const spans = []; // { m, t0, t1 }
  const slotEvents = []; // 槽位变化的时刻（setBounds 调用）
  {
    const dbg = wc().debugger;
    const orig = dbg.sendCommand.bind(dbg);
    dbg.sendCommand = (method, ...rest) => {
      const watch = method === "Page.captureScreenshot" || method === "Emulation.setDeviceMetricsOverride" || method === "Emulation.clearDeviceMetricsOverride";
      const span = watch ? { m: method, t0: performance.now(), t1: null } : null;
      if (span) spans.push(span);
      const p = orig(method, ...rest);
      if (span) {
        const done = () => {
          span.t1 = performance.now();
        };
        p.then(done, done);
      }
      return p;
    };
  }
  const resetSpans = () => {
    spans.length = 0;
    slotEvents.length = 0;
  };
  const overlap = (a, b) => a.t1 !== null && b.t1 !== null && a.t0 < b.t1 && b.t0 < a.t1;
  const analyse = () => {
    const caps = spans.filter((s) => s.m === "Page.captureScreenshot");
    const metrics = spans.filter((s) => s.m !== "Page.captureScreenshot");
    let capCap = 0;
    let capMetrics = 0;
    for (let i = 0; i < caps.length; i++) {
      for (let j = i + 1; j < caps.length; j++) if (overlap(caps[i], caps[j])) capCap++;
      for (const m of metrics) if (overlap(caps[i], m)) capMetrics++;
    }
    // 有多少次槽位变化真的落在某条截图在飞期间（测试有效性：没有的话，这一轮没测到「截图在飞时拖面板」）
    const slotInFlight = slotEvents.filter((t) => caps.some((c) => c.t1 !== null && t > c.t0 && t < c.t1)).length;
    return { captures: caps.length, capCap, capMetrics, slotInFlight };
  };
  const setBounds = (b) => {
    slotEvents.push(performance.now());
    sess.setBounds(b);
  };

  // ── 画面几何：抓视图合成面的原始像素 ──
  const geoRaw = async () => {
    await tab().overlayHide(); // 注入页面的「AI 操作中」徽标 / 点击标记是白色的，抓图前收掉
    await sleep(350);
    const cap = await wc().capturePage();
    const sz = cap.getSize();
    const bm = cap.toBitmap();
    let bx1 = -1;
    let by1 = -1;
    let gx0 = 1e9;
    let gy0 = 1e9;
    for (let y = 0; y < sz.height; y++) {
      for (let x = 0; x < sz.width; x++) {
        const i = (y * sz.width + x) * 4;
        const b = bm[i];
        const g = bm[i + 1];
        const r = bm[i + 2];
        if (b > 180 && r < 100 && g < 120) {
          if (x > bx1) bx1 = x;
          if (y > by1) by1 = y;
        } else if (g > 180 && r < 150 && b < 170) {
          if (x < gx0) gx0 = x;
          if (y < gy0) gy0 = y;
        }
      }
    }
    return { cap: sz, blueEnd: bx1 < 0 ? null : [bx1 + 1, by1 + 1], greenStart: gx0 > 1e8 ? null : [gx0, gy0] };
  };
  const healthy = async () => {
    const b = viewBounds();
    const g = await geoRaw();
    const surface = Math.abs(g.cap.width - b.width * dsf) <= 2 && Math.abs(g.cap.height - b.height * dsf) <= 2;
    const content =
      !!g.blueEnd && Math.abs(g.blueEnd[0] - g.cap.width) <= 3 && Math.abs(g.blueEnd[1] - g.cap.height) <= 3 && !!g.greenStart && g.greenStart[0] <= 3 && g.greenStart[1] <= 3;
    return { ok: surface && content, surface, content, b, g };
  };

  // ── 几种截图 ──
  const shotVp = () => call("screenshot", {});
  const saveFull = () => tab().screenshot({ fullPage: true, format: "png", maxWidth: 100000 });
  const shotClip = () => call("screenshot", { clip: { x: 100, y: 100, width: 200, height: 200 } });
  // 直接发的整页长图：命令立刻在飞，且够慢（4000px 高），用来卡「截图在飞时」这个窗口
  const rawSlow = () =>
    tab().send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: 4000, scale: 1 } });

  const SLOT = { x: 50, y: 40, width: 1156, height: 711 };
  sess.attach(SLOT);
  await sleep(300);
  const setupBase = async () => {
    setBounds({ ...SLOT });
    await sleep(200);
    await call("emulate", { reset: true }).catch(() => {});
    await call("emulate", { device: "Desktop 1440" }); // 1440×900
    await waitFor(() => stTab()?.fitScale === expScale(SLOT, 1440, 900), 5000);
    await sleep(500);
    resetSpans();
  };

  // ═══════════ 基线 ═══════════
  await setupBase();
  const sBase = expScale(SLOT, 1440, 900);
  const h0 = await healthy();
  check(
    "cx-01",
    "基线：Desktop 1440 放进 1156×711（用户现场）：适应 79%、视图 = floor(模拟尺寸 × 比例) 居中、画面恰好铺满视图",
    sBase === 0.79 && stTab()?.fitScale === sBase && eqRect(viewBounds(), expView(SLOT, 1440, 900, sBase)) && h0.ok,
    { fit: stTab()?.fitScale, b: viewBounds(), geo: h0.g },
  );

  // ═══════════ A：并发截图 ═══════════
  const concurrentCases = [
    ["两路视口截图", () => Promise.all([shotVp(), shotVp()])],
    ["三路视口截图 + snapshot", () => Promise.all([shotVp(), shotVp(), shotVp(), call("snapshot", {})])],
    ["视口截图 + 整页 save", () => Promise.all([shotVp(), saveFull()])],
    ["两路整页 save", () => Promise.all([saveFull(), saveFull()])],
    ["视口截图 + clip 截图", () => Promise.all([shotVp(), shotClip()])],
    ["整页 save + clip 截图 + 视口截图", () => Promise.all([saveFull(), shotClip(), shotVp()])],
  ];
  const aBad = [];
  let aCaps = 0;
  for (const [label, fn] of concurrentCases) {
    await setupBase();
    await fn();
    await sleep(700);
    const an = analyse();
    aCaps += an.captures;
    const h = await healthy();
    const iw = await rawEv("innerWidth");
    if (an.capCap !== 0 || !h.ok || iw !== 1440 || stTab()?.fitScale !== sBase) aBad.push({ label, an, ok: h.ok, surface: h.surface, content: h.content, cap: h.g.cap, iw, fit: stTab()?.fitScale });
  }
  check("cx-02", "并发截图（6 组共 14 条）：任何时刻最多一条 Page.captureScreenshot 在飞；结束后画面铺满视图、页面视口仍是 1440、适应比例不变", aBad.length === 0 && aCaps >= 14, { bad: aBad, captures: aCaps });

  // ═══════════ R：截图在飞时槽位变化（缩放重算 + 视图矩形变化）═══════════
  const SMALL = { ...SLOT, width: 1000, height: 600 };
  const sSmall = expScale(SMALL, 1440, 900);
  const rBad = [];
  let rSlotInFlight = 0;
  for (const [name, shot] of [
    ["视口截图", () => tab().send("Page.captureScreenshot", { format: "png", fromSurface: true })],
    ["整页长图", rawSlow],
  ]) {
    for (const d of [0, 8, 30, 80, 200]) {
      await setupBase();
      const p = shot();
      await sleep(d);
      setBounds({ ...SMALL });
      await p;
      await waitFor(() => stTab()?.fitScale === sSmall, 6000);
      await sleep(700);
      const an = analyse();
      rSlotInFlight += an.slotInFlight;
      const h = await healthy();
      const wantView = expView(SMALL, 1440, 900, sSmall);
      if (an.capMetrics !== 0 || !h.ok || !eqRect(viewBounds(), wantView) || stTab()?.fitScale !== sSmall) {
        rBad.push({ name, d, an, ok: h.ok, surface: h.surface, content: h.content, cap: h.g.cap, view: viewBounds(), wantView, fit: stTab()?.fitScale });
      }
    }
  }
  check("cx-03", "截图在飞时槽位变小（拖面板）：缩放重算 / 视图矩形都等截图结束后才落地，最终视图 = 新槽位算出的矩形、画面铺满视图（视口截图 / 整页长图 × 延迟 0~200ms）", rBad.length === 0, { bad: rBad });
  if (rSlotInFlight > 0) check("cx-03b", "测试有效性：确实有槽位变化落在截图在飞期间", true, { slotInFlight: rSlotInFlight });
  else skip("cx-03b", "测试有效性：确实有槽位变化落在截图在飞期间", "本机截图太快，没有一次交叉上（cx-03 仍然成立，但这一轮没测到交叉）");

  // ═══════════ E：截图在飞时 emulate ═══════════
  const sE = expScale(SLOT, 1280, 800);
  const eBad = [];
  for (const [name, shot] of [
    ["视口截图", () => tab().send("Page.captureScreenshot", { format: "png", fromSurface: true })],
    ["整页长图", rawSlow],
  ]) {
    for (const d of [0, 15, 60, 150]) {
      await setupBase();
      const p = shot();
      await sleep(d);
      await call("emulate", { width: 1280, height: 800 });
      await p;
      await sleep(700);
      const an = analyse();
      const h = await healthy();
      const iw = await rawEv("innerWidth");
      if (an.capMetrics !== 0 || !h.ok || iw !== 1280 || stTab()?.fitScale !== sE || !eqRect(viewBounds(), expView(SLOT, 1280, 800, sE))) {
        eBad.push({ name, d, an, ok: h.ok, cap: h.g.cap, iw, view: viewBounds(), fit: stTab()?.fitScale });
      }
    }
  }
  check("cx-04", "截图在飞时 emulate 1280×800：新的视口覆盖不被截图结束时写回的旧参数盖掉（页面 innerWidth = 1280、适应比例与视图跟新模拟、画面铺满视图）", eBad.length === 0, { bad: eBad });

  // ═══════════ V：截图在飞时只有「视图矩形」变了（没有视口覆盖命令跟着发）═══════════
  // 视图尺寸变了但没有 setDeviceMetricsOverride 随后重新同步：截图结束时 Chromium 把「开始时记下的视图尺寸」写回去，
  // 画面就停在旧尺寸（比新视图大就越出面板），直到下一次布局变化。没有设备模拟时（拖面板 × 整页截图）同样会发生。
  const sizeOk = async () => {
    const b = viewBounds();
    const g = await geoRaw();
    return { ok: Math.abs(g.cap.width - b.width * dsf) <= 2 && Math.abs(g.cap.height - b.height * dsf) <= 2, b, cap: g.cap };
  };
  const NARROW = { ...SLOT, width: 900, height: 600 };
  const vCases = [
    ["没有模拟：槽位 →900×600", async () => {}, NARROW, NARROW],
    ["只给宽 1000（不缩放）：槽位 →900×600", () => call("emulate", { width: 1000 }), NARROW, NARROW],
    ["Desktop 1440 高度限制：槽位宽 1156→1300（比例不变）", () => call("emulate", { device: "Desktop 1440" }), { ...SLOT, width: 1300 }, expView({ ...SLOT, width: 1300 }, 1440, 900, sBase)],
    ["600×400 小模拟：槽位 →500×300", () => call("emulate", { width: 600, height: 400 }), { ...SLOT, width: 500, height: 300 }, expView({ ...SLOT, width: 500, height: 300 }, 600, 400, expScale({ ...SLOT, width: 500, height: 300 }, 600, 400))],
  ];
  const vBad = [];
  let vSlotInFlight = 0;
  for (const [label, setup, slot, wantView] of vCases) {
    setBounds({ ...SLOT });
    await sleep(200);
    await call("emulate", { reset: true }).catch(() => {});
    await setup();
    await sleep(600);
    resetSpans();
    const p = rawSlow();
    await sleep(30);
    setBounds({ ...slot });
    await p;
    await sleep(800);
    vSlotInFlight += analyse().slotInFlight;
    const r = await sizeOk();
    if (!r.ok || !eqRect(viewBounds(), wantView)) vBad.push({ label, ok: r.ok, view: r.b, wantView, cap: r.cap });
  }
  check("cx-05", "截图在飞时只有视图矩形变化（没有模拟 / 只给宽 / 高度限制下只改宽 / 小模拟变小）：视图矩形等截图结束后才落地，画面合成面 = 视图矩形（不停在旧尺寸）", vBad.length === 0, { bad: vBad });
  if (vSlotInFlight > 0) check("cx-05b", "测试有效性：确实有视图矩形变化落在截图在飞期间", true, { slotInFlight: vSlotInFlight });
  else skip("cx-05b", "测试有效性：确实有视图矩形变化落在截图在飞期间", "本机截图太快，没有一次交叉上");

  // ═══════════ 失败 / 无模拟 ═══════════
  await setupBase();
  const failed = await tab()
    .send("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: 0, y: 0, width: 0, height: 10, scale: 1 } })
    .then(
      () => null,
      (e) => String(e?.message || e),
    );
  setBounds({ ...SMALL });
  await waitFor(() => stTab()?.fitScale === sSmall, 6000);
  await sleep(600);
  const hFail = await healthy();
  check(
    "cx-06",
    "截图失败（Chromium 拒绝：clip 宽 0）不堵队列、不留「截图中」状态：随后的槽位变化 / 缩放重算照常落地，画面铺满视图",
    typeof failed === "string" && stTab()?.fitScale === sSmall && eqRect(viewBounds(), expView(SMALL, 1440, 900, sSmall)) && hFail.ok,
    { failed, fit: stTab()?.fitScale, view: viewBounds(), geo: hFail.g },
  );

  await call("emulate", { reset: true });
  await waitFor(() => stTab()?.fitScale === undefined, 4000);
  setBounds({ ...SLOT });
  await sleep(500);
  resetSpans();
  const plain = await Promise.all([shotVp(), shotVp(), saveFull()]);
  const hPlain = await healthy();
  check(
    "cx-07",
    "没有设备模拟时并发截图照常各自返回、视图 = 整个槽位、画面铺满视图",
    plain.length === 3 && plain.every((r) => r && typeof r === "object") && eqRect(viewBounds(), SLOT) && hPlain.ok,
    { view: viewBounds(), geo: hPlain.g },
  );

  // ═══════════ B：截图在飞时面板被打开（视图从停车场搬进主窗口）═══════════
  // 视图在停车场时矩形固定是 1280×800（PARKING_BOUNDS）。截图在飞时 `#applySlot` 被推迟（不改矩形：截完 Chromium 会把旧尺寸写回去），
  // 但 `moveToMain` 照常把视图加进主窗口并显示——一块 1280×800 的视图盖在主窗口左上角，直到截图结束才缩成槽位大小（第九轮评审 B1）。
  // 判据：截图在飞的每个采样点上，「挂在主窗口 + 可见 + 矩形 = 停车场尺寸」一次都不能出现；截完视图 = 槽位矩形、可见、画面铺满视图。
  const PARKING = { x: 0, y: 0, width: 1280, height: 800 };
  const inPark = (b) => eqRect(b, PARKING);
  /** 截图 promise 落地之前，每隔几毫秒记一次视图的「挂在哪个窗口 / 可见 / 矩形」 */
  const sampleWhile = async (p) => {
    let done = false;
    p.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    const samples = [];
    while (!done) {
      const v = tab().view;
      samples.push({ inMain: mainWin.contentView.children.includes(v), visible: v.getVisible(), b: v.getBounds() });
      await sleep(4);
    }
    return samples;
  };
  const bBad = [];
  let bSamplesInMain = 0;
  for (const d of [0, 10, 40]) {
    sess.detach(); // 面板关着：视图在停车场、矩形 = 1280×800
    await call("emulate", { reset: true }).catch(() => {});
    await sleep(500);
    resetSpans();
    const p = rawSlow();
    await sleep(d);
    sess.attach({ ...SLOT }); // 用户此刻打开面板（moveToMain）
    const samples = await sampleWhile(p);
    await sleep(600);
    const inMain = samples.filter((s) => s.inMain);
    bSamplesInMain += inMain.length;
    const cover = inMain.filter((s) => s.visible && inPark(s.b));
    const v = tab().view;
    const after = { visible: v.getVisible(), b: v.getBounds() };
    const h = await healthy();
    if (cover.length > 0 || !after.visible || !eqRect(after.b, SLOT) || !h.ok) bBad.push({ d, cover: cover.length, samples: samples.length, after, ok: h.ok, geo: h.g });
  }
  check("cx-08", "截图在飞时打开面板（视图从停车场搬进主窗口）：在飞期间视图不会以停车场的 1280×800 可见地盖在主窗口上；截完视图 = 槽位矩形、可见、画面铺满视图（延迟 0 / 10 / 40ms）", bBad.length === 0, { bad: bBad });
  if (bSamplesInMain > 0) check("cx-08b", "测试有效性：确实有采样点落在「截图在飞 + 视图已挂在主窗口」期间", true, { samplesInMain: bSamplesInMain });
  else skip("cx-08b", "测试有效性：确实有采样点落在「截图在飞 + 视图已挂在主窗口」期间", "本机截图太快，没有一次交叉上");

  // ═══════════ P：截图在飞时面板被关闭（视图被停进停车场）═══════════
  // 反方向：视图在主窗口里（矩形 = 槽位，截图开始时 Chromium 记下的就是它），截图在飞时面板关掉 → `#park` 立刻把矩形设成 1280×800，
  // 截完 Chromium 若把「开始时的旧尺寸」写回去，停车场里的视图就停在槽位大小（页面视口跟着是槽位宽，不是 1280）。第九轮评审 P3-4 说「推测、没验证」，这里实测。
  const pBad = [];
  for (const d of [10, 40]) {
    sess.attach({ ...SLOT });
    await call("emulate", { reset: true }).catch(() => {});
    await sleep(500);
    const p = rawSlow();
    await sleep(d);
    sess.detach();
    await p;
    await sleep(800);
    const iw = await rawEv("innerWidth");
    const ih = await rawEv("innerHeight");
    const b = viewBounds();
    if (!inPark(b) || iw !== PARKING.width || ih !== PARKING.height) pBad.push({ d, view: b, iw, ih });
  }
  check("cx-09", "截图在飞时关闭面板（视图停进停车场）：截完视图矩形 = 停车场的 1280×800、页面视口也是 1280×800（不停在面板槽位的旧尺寸）（延迟 10 / 40ms）", pBad.length === 0, { bad: pBad });

  // ═══════════ Z：截图在飞时缩放（wc.setZoomLevel）═══════════
  // user-features.applyZoom 直接调 wc.setZoomLevel、不经模拟队列（第十轮评审 B-4：怀疑它与在飞的截图交叉、同样会被截图结束时的写回盖掉，当时未实测）。
  // 判据：每个用例的最终状态与「只缩放、没有截图」逐项一致——视图矩形 / 适应比例 / 缩放级别 / 页面 innerWidth·innerHeight / 画面几何。
  // 实测结果是一致：缩放是独立的 HostZoomMap 属性，Chromium 处理截图时记下、结束时写回的是「视图尺寸 + 模拟参数」，不碰缩放，所以这条路径不需要进队列。
  sess.attach({ ...SLOT });
  const zoomState = async () => {
    const h = await healthy();
    return { view: viewBounds(), fit: stTab()?.fitScale, zoom: wc().getZoomLevel(), iw: await rawEv("innerWidth"), ih: await rawEv("innerHeight"), geoOk: h.ok };
  };
  const prepZoom = async (emulated) => {
    if (emulated) {
      await setupBase();
      return;
    }
    await call("emulate", { reset: true }).catch(() => {});
    await waitFor(() => stTab()?.fitScale === undefined, 4000);
    setBounds({ ...SLOT });
    await sleep(600);
  };
  const resetZoom = async () => {
    wc().setZoomLevel(0);
    await sleep(600);
  };
  /** 此刻在飞的那条 Page.captureScreenshot（插桩的 spans 里 t1 仍为 null；没有则 undefined）；它的 t0 是命令发出的时刻，用来**实测**缩放落在命令在飞后第几毫秒 */
  const inFlightCapture = () => spans.find((sp) => sp.m === "Page.captureScreenshot" && sp.t1 === null);
  /** 此刻有没有一条 Page.captureScreenshot 的 CDP 命令在飞 */
  const captureInFlight = () => inFlightCapture() !== undefined;
  /** 轮询到有截图命令在飞（或超时）就返回；每轮用 setImmediate 让出事件循环，CDP 应答 / 新发出的命令才进得来 */
  const waitCaptureInFlight = async (timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline && !captureInFlight()) await new Promise((r) => setImmediate(r));
  };
  const zoomAlone = {};
  for (const emulated of [true, false]) {
    await prepZoom(emulated);
    wc().setZoomLevel(1);
    await sleep(1200);
    zoomAlone[emulated] = await zoomState();
    await resetZoom();
  }
  const zBad = [];
  // 每个用例都要「缩放确实落在截图在飞期间」才算测到：没交叉上就重来（最多试 ZOOM_MAX_ATTEMPTS 次，含第一次；重试轮询 spans 等到截图命令在飞，第十三轮评审 P3-2）；仍交叉不上的用例记进 zUncrossed，
  // cx-10b 据此判失败（以前 cx-10b 交叉不上只输出 SKIP、不影响退出码，等于什么都没测也报绿——第十一轮评审 P3-6）
  // 如实（第十六轮评审 P3-B4）：最后一次尝试放弃偏移（命令一在飞就缩放）之后，cx-10b 实质上只会在「等满 5 秒仍没有截图命令发出」时失败——
  // 缩放落在命令在飞期间几乎必然（t1 要等应答才置位），所以它保证的是「缩放确实落在一条在飞的截图命令期间」这个**交叉事实**，不再保证「落在第几毫秒」；
  // 相位覆盖看 crossedAt 里的实测 afterCommandMs。这是第十五轮评审 P3-4 取的取舍（宁可交叉上、也不为一个太晚的名义相位判失败），不是疏忽。
  // 失败时 detail 里的 uncrossedTrace 逐次给出每次尝试的结果：not_yet_sent = 第 0 次尝试里 sleep(d) 之后命令还没发出（没有等满 5 秒、不是卡住）；never_sent = 重试里轮询等满 5 秒仍没有截图命令发出；
  // late = 命令发出过、但缩放时它已应答（太晚；lateByMs = 缩放距它应答多久，commandRoundTripMs = 它的往返）。waitedMs = 判交叉前实际等了多久，captureCount = 判交叉那一刻已发出的截图命令条数（不是 op 的总条数；第十七轮评审 B-4，第十八轮评审 R-3 订正文案）。
  const ZOOM_MAX_ATTEMPTS = 4;
  const zCrossed = {};
  const zTrace = {};
  // 每个用例是第几次尝试、在什么相位交叉上的（第十四轮评审 P3-4 ④：以前只记 0 / 1，看不出是首次还是重试）；汇总进 cx-10b 的 detail。
  // 第十五轮评审 P3-4：记的是**实测**相位（afterCommandMs：缩放那一刻距这条截图命令发出多少毫秒），不是名义偏移——
  // 之前这里写的 `截图命令在飞后 ${d}ms` 只是代码里的 sleep(d)，中间还隔着 setImmediate 轮询与 sleep 的调度误差，并没有量
  const zWhere = {};
  for (const [label, emulated, mk, d] of [
    ["有模拟 × 整页长图截图", true, rawSlow, 0],
    ["有模拟 × 整页长图截图", true, rawSlow, 20],
    ["有模拟 × 整页 save", true, saveFull, 5],
    ["无模拟 × 整页长图截图", false, rawSlow, 5],
  ]) {
    const key = `${label}@${d}ms`;
    zCrossed[key] = 0;
    zTrace[key] = [];
    for (let attempt = 0; attempt < ZOOM_MAX_ATTEMPTS && zCrossed[key] === 0; attempt++) {
      await prepZoom(emulated);
      resetSpans(); // 只看这一次的截图命令（前面 prepZoom 里的命令都已结算，清不清都不影响，这里图个判据自洽）
      const p = mk();
      const waitFrom = performance.now(); // 判交叉前等了多久（waitedMs）从这里量起
      if (attempt === 0) {
        await sleep(d); // 第一次保留各用例自己的延迟：覆盖「缩放落在截图的第几毫秒」（从 op 开始算）
      } else {
        // 重试**不是**换成更短的延迟（第十三轮评审 P3-2：原先 sleep(0) 与「交叉」判据反方向——延迟越短越早，截图命令越没发出去，
        // 只会更交叉不上）；而是轮询插桩的 spans，等到有一条 Page.captureScreenshot 在飞，再等各用例自己的偏移 d
        // （第十四轮评审 P3-4 ④：原先等到命令在飞就立刻缩放，四个用例的相位全塌缩成「命令刚发出」，d=20 要测的「截图中段」在重试后丢了）。
        // 最后一次尝试放弃这个偏移（第十五轮评审 P3-4：前几次都交叉不上，说明名义相位在本机已经太晚——「交叉上」比「落在第几毫秒」更要紧，
        // 与其让 cx-10b 因为一个太晚的相位判失败，不如命令一在飞就缩放；这样的用例在 detail 里标 fallbackOffset0）
        await waitCaptureInFlight(5000);
        if (attempt < ZOOM_MAX_ATTEMPTS - 1) await sleep(d);
      }
      // 「交叉上」= 此刻有一条 Page.captureScreenshot 的 CDP 命令正在飞（已发出、未应答）。先判、再同步调 setZoomLevel，中间没有 await；
      // 不能看外层 promise 是否结算（第十二轮评审 P3-8）：它没结算时可能还在排队 / 取布局 / 解码，没有截图命令在飞，缩放就没落在 Chromium 处理截图的那一刻。
      // 上面的 sleep 返回后到这里只隔着 await 的微任务，CDP 应答（宏任务）插不进来
      const flying = inFlightCapture();
      if (flying) {
        zCrossed[key]++;
        zWhere[key] = {
          attempt,
          anchor: attempt === 0 ? "op 开始后的名义偏移" : "命令在飞后的名义偏移",
          nominalOffsetMs: attempt === ZOOM_MAX_ATTEMPTS - 1 ? 0 : d,
          // 只有 d 本来大于 0 的用例，最后一次才算「放弃了偏移」（第十六轮评审 P3-B4：d=0 的用例最后一次与第一次的偏移相同，标 true 有误导）
          fallbackOffset0: attempt === ZOOM_MAX_ATTEMPTS - 1 && d > 0,
          afterCommandMs: Math.round(performance.now() - flying.t0),
        };
      }
      // 逐次记账（第十六轮评审 P3-B4：zWhere 只在交叉成功时写，失败时分不清「命令从未发出」还是「每次都太晚」）。同步、无 await，不影响上面「判交叉 → 缩放」的原子性
      // 第十七轮评审 B-4：在飞的优先，否则取**最后一条**已应答的（原先 find 取第一条，会把「很早就结束的那条」当成「太晚的那条」）。
      // 第十八轮评审 R-3 订正理由：这是防御性写法——本脚本的 saveFull 是 png、只发一条 Page.captureScreenshot，「取最后一条」目前等价于取唯一一条；
      // 只有 webp 且超宽的缩小分支（tab.mjs screenshot()）才会再发第二条。captureCount 是「判交叉那一刻已发出的条数」，不是 op 总数
      const captures = spans.filter((sp) => sp.m === "Page.captureScreenshot");
      const seen = flying ?? captures[captures.length - 1];
      zTrace[key].push({
        attempt,
        nominalOffsetMs: attempt === ZOOM_MAX_ATTEMPTS - 1 ? 0 : d,
        // attempt 0 只等了 sleep(d)、命令没发出叫 not_yet_sent（不是卡住）；重试里轮询等满 5 秒仍没有才叫 never_sent
        result: flying ? "crossed" : seen ? "late" : attempt === 0 ? "not_yet_sent" : "never_sent",
        waitedMs: Math.round(performance.now() - waitFrom),
        captureCount: captures.length,
        ...(!flying && seen ? { commandRoundTripMs: Math.round(seen.t1 - seen.t0), lateByMs: Math.round(performance.now() - seen.t1) } : {}),
      });
      wc().setZoomLevel(1); // 与 applyZoom 一样直接调，不经模拟队列
      await p.catch(() => {});
      await sleep(1200);
      const st = await zoomState();
      if (JSON.stringify(st) !== JSON.stringify(zoomAlone[emulated])) zBad.push({ label, d, attempt, crossed: zCrossed[key] > 0, st, want: zoomAlone[emulated] });
      await resetZoom();
    }
  }
  check("cx-10", "截图在飞时缩放（wc.setZoomLevel，不经队列）：最终状态与「只缩放」逐项一致（视图矩形 / 适应比例 / 缩放级别 / 页面视口 / 画面几何）——缩放不被截图结束时的写回盖掉", zBad.length === 0, { alone: zoomAlone, bad: zBad });
  const zUncrossed = Object.keys(zCrossed).filter((k) => zCrossed[k] === 0);
  check("cx-10b", "测试有效性：4 个用例每个都有缩放落在一条 Page.captureScreenshot 在飞的瞬间（spans 判；没交叉上会轮询到截图命令在飞再来，最多试 4 次含第一次、最后一次不保留偏移——所以实质上只在「等满 5 秒仍没有截图命令发出」时失败，保证的是交叉事实、不是第几毫秒；仍交叉不上 = 失败，不再 SKIP；crossedAt 里是实测相位，失败时 uncrossedTrace 逐次给出 not_yet_sent / never_sent / late，另带 waitedMs / captureCount / lateByMs）", zUncrossed.length === 0, { crossed: zCrossed, crossedAt: zWhere, uncrossed: zUncrossed, uncrossedTrace: Object.fromEntries(zUncrossed.map((k) => [k, zTrace[k]])) });

  sess.detach();
  manager.destroy();
  server.close();
};

/** 退出前清临时 userData；成功 / 断言失败 / 脚本抛错三条路径都走这里（失败路径也不留 fs-browser-capture-race-* 目录） */
const cleanupTmp = () => {
  // 先销毁剩下的窗口（Chromium 还在往 userData 写缓存时 rmSync 会撞 ENOTEMPTY），再重试着清；仍清不掉只告警——但要说出来，别吞（第十五轮评审 P3-4）
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
    // SKIP 不进 results、不影响退出码：汇总行把它们列出来，免得「N/N passed」被读成「全部交叉都测到了」（第十一轮评审 P3-6）
    console.log(
      `SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}${skipped.length ? ` SKIPPED(${skipped.length}，该类交叉这一轮没测到): ${skipped.join(",")}` : ""}`,
    );
    cleanupTmp();
    app.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error("SMOKE ERROR", e);
    cleanupTmp();
    app.exit(2);
  });
