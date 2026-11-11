"use strict";
/**
 * R10（真 Electron + 真 CDP）：设备模拟下的视图适配（契约 §14.4「设备模拟下的视图适配」）。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r10-emulation-fit.cjs --timeout 180
 *
 * 要证实的事（单测里的假视图证明不了的）：
 *   A 视图比模拟视口大：视图收窄居中，页面视口 = 视图（没有白板）；
 *   B 视图比模拟视口小：整体缩小（scale + dontSetVisibleSize）——
 *     - 整页恰好铺满视图（蓝块贴着视图右下角、绿块贴着左上角、没有白像素），拖面板每一步都成立；
 *     - 页面看到的不变：innerWidth / innerHeight、媒体查询、DOM 几何、CDP 截图尺寸与内容（含 clip）、滚动距离；
 *     - 点击落点：AI 的 mouse / click(ref) / touch tap 经 Tab.send 补偿后落在 CSS 坐标上；用户真实点击由 Chromium 自己映射；
 *     - 页面缩放叠加、遮盖截图宽高比、停车场往返、debugger 重连重放、reset 后补偿归位（不残留）。
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-r10-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const skip = (id, name, why) => console.log(`SMOKE SKIP ${id} ${name} ${JSON.stringify(why)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 红底（按钮也涂红：白像素 = 视图里没被页面铺满的地方）；绿块贴左上、蓝块贴右下（fixed，随视口走）；黄色目标 #tgt 在 CSS (150..190, 200..240)；
// #btn / #far 是两个按钮（近 / 远，远的在 CSS 1200 附近——补偿错了会差几百像素）；
// 页面记录：mousedown / touchstart 的 clientX / clientY / 目标 id、click 计数、resize 次数。
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>R10</title>
<style>html,body{margin:0;background:#f00}.sq{position:fixed;width:100px;height:100px}#tl{left:0;top:0;background:#0f0}#br{right:0;bottom:0;background:#00f}
#tgt{position:fixed;left:150px;top:200px;width:40px;height:40px;background:#ff0}
button{background:#f00;border:0;color:#f00}#btn{position:fixed;left:300px;top:200px;width:80px;height:40px}#far{position:fixed;left:1200px;top:700px;width:80px;height:40px}</style></head>
<body><div class="sq" id="tl"></div><div class="sq" id="br"></div><div id="tgt"></div><button id="btn">近按钮</button><button id="far">远按钮</button>
<script>
window.__md = []; window.__ts = []; window.__resize = 0; window.__btn = 0; window.__far = 0;
var rec = function (list) { return function (e) { var p = (e.touches && e.touches[0]) || e; list.push([Math.round(p.clientX * 10) / 10, Math.round(p.clientY * 10) / 10, (e.target && e.target.id) || '']); }; };
document.addEventListener('mousedown', rec(window.__md), true);
document.addEventListener('touchstart', rec(window.__ts), true);
window.addEventListener('resize', function () { window.__resize++; });
document.getElementById('btn').addEventListener('click', function () { window.__btn++; });
document.getElementById('far').addEventListener('click', function () { window.__far++; });
</script></body></html>`;
const PAGE_TALL = `<!doctype html><html><head><meta charset="utf-8"><title>R10 tall</title><style>html,body{margin:0;background:#f00}</style></head><body><div style="height:4000px"></div></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(req.url.startsWith("/tall") ? PAGE_TALL : PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

const eqRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const near = (a, b, eps = 0.0005) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= eps;

// ── 期望值：这里刻意再写一遍公式（不 import 被测的纯函数），让 e2e 独立于实现 ──
const expScale = (slot, w, h) => Math.floor(Math.min(1, slot.width / w, slot.height / h) * 1000) / 1000;
const expView = (slot, w, h, s) => {
  const width = Math.min(slot.width, s < 1 ? Math.floor(w * s) : w);
  const height = Math.min(slot.height, s < 1 ? Math.floor(h * s) : h);
  return { x: slot.x + Math.floor((slot.width - width) / 2), y: slot.y, width, height };
};

const main = async () => {
  await app.whenReady();
  const { server, base } = await startFixture();
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const { PARKING_BOUNDS } = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/tab.mjs")).href);

  const mainWin = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");
  // R9-03：记下真正推给渲染端的 browser:state（manager 经 mainWindow.webContents.send 推），
  // 验证「槽位变了但缩放比例没变」时 viewFit 也推出去了——光看 session.getState() 看不出有没有推
  const pushed = [];
  {
    const wcMain = mainWin.webContents;
    const origSend = wcMain.send.bind(wcMain);
    wcMain.send = (channelName, ...payload) => {
      if (channelName === "browser:state") pushed.push(payload);
      return origSend(channelName, ...payload);
    };
  }
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

  const T = "r10-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
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
  const waitFor = async (fn, ms = 3000) => {
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
  const stateFit = () => stTab()?.viewFit;
  const stateScale = () => stTab()?.fitScale;
  const rawEv = async (expr) => (await tab().send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
  const lastMd = async () => JSON.parse((await ev("JSON.stringify(window.__md)")) || "[]");
  const clearMd = () => ev("window.__md.length = 0; window.__ts.length = 0");

  // 抓视图画面，取绿块 / 蓝块 / 白像素（BGRA；颜色管理会让 RGB 漂移，按主通道分类）
  const geo = async (vw) => {
    const cap = await wc().capturePage();
    const sz = cap.getSize();
    const bm = cap.toBitmap();
    const k = sz.width / vw;
    let bx1 = -1, by1 = -1, gx0 = 1e9, gy0 = 1e9, white = 0, wx0 = 1e9, wy0 = 1e9, wx1 = -1, wy1 = -1, sample = null;
    for (let y = 0; y < sz.height; y++) {
      for (let x = 0; x < sz.width; x++) {
        const i = (y * sz.width + x) * 4;
        const b = bm[i], g = bm[i + 1], r = bm[i + 2];
        if (b > 180 && r < 100 && g < 120) {
          if (x > bx1) bx1 = x;
          if (y > by1) by1 = y;
        } else if (g > 180 && r < 150 && b < 170) {
          if (x < gx0) gx0 = x;
          if (y < gy0) gy0 = y;
        } else if (r > 200 && g > 200 && b > 200) {
          white++;
          if (x < wx0) wx0 = x;
          if (y < wy0) wy0 = y;
          if (x > wx1) wx1 = x;
          if (y > wy1) wy1 = y;
          if (!sample) sample = [r, g, b];
        }
      }
    }
    return {
      blue: bx1 < 0 ? null : { x1: +((bx1 + 1) / k).toFixed(1), y1: +((by1 + 1) / k).toFixed(1) },
      green: gx0 > 1e8 ? null : { x0: +(gx0 / k).toFixed(1), y0: +(gy0 / k).toFixed(1) },
      white,
      ...(white ? { whiteBox: [wx0 / k, wy0 / k, wx1 / k, wy1 / k].map((n) => +n.toFixed(1)), sample } : {}),
    };
  };
  const fitsView = (g, vw, vh) =>
    !!g.blue && Math.abs(g.blue.x1 - vw) <= 1.5 && Math.abs(g.blue.y1 - vh) <= 1.5 && !!g.green && g.green.x0 <= 3 && g.green.y0 <= 3 && g.white === 0;
  // 等重绘稳定后再抓
  const fitNow = async () => {
    await tab().overlayHide(); // Flowship 注入页面的「AI 操作中」徽标 / 点击标记是白色的，属于页面内容，抓图前收掉免得被当成白板
    await sleep(450);
    const b = viewBounds();
    const g = await geo(b.width);
    return { ok: fitsView(g, b.width, b.height), g, b };
  };

  // 用户真实点击：接管后 sendInputEvent（视图局部坐标），读完页面记录再还给 AI
  const userClick = async (vx, vy) => {
    await rawEv("window.__md.length = 0");
    sess.takeover();
    await sleep(100);
    wc().sendInputEvent({ type: "mouseMove", x: vx, y: vy });
    await sleep(50);
    wc().sendInputEvent({ type: "mouseDown", x: vx, y: vy, button: "left", clickCount: 1 });
    wc().sendInputEvent({ type: "mouseUp", x: vx, y: vy, button: "left", clickCount: 1 });
    await sleep(150);
    const hit = JSON.parse(await rawEv("JSON.stringify(window.__md)"));
    sess.handback("r10");
    return hit[0] ?? null;
  };
  const aiClick = async (x, y) => {
    await clearMd();
    await call("mouse", { action: "click", x, y });
    await sleep(120);
    return (await lastMd())[0] ?? null;
  };
  const hits = (h, x, y, id, eps = 2) => !!h && Math.abs(h[0] - x) <= eps && Math.abs(h[1] - y) <= eps && h[2] === id;

  const SLOT = { x: 50, y: 40, width: 900, height: 500 };

  // ═══════════ 无模拟 ═══════════
  sess.attach(SLOT);
  await sleep(200);
  check("r10-01", "没有模拟：视图就是槽位，TabInfo 不带 viewFit / fitScale", eqRect(viewBounds(), SLOT) && stateFit() === undefined && stateScale() === undefined, { b: viewBounds() });

  // ═══════════ A：600×400（视图比模拟大）：居中收窄，不缩放 ═══════════
  await call("emulate", { width: 600, height: 400 });
  await sleep(300);
  const bA = viewBounds();
  check("r10-02", "A：emulate 600×400（槽位 900×500）：视图水平居中、顶部对齐收窄成 600×400", eqRect(bA, { x: 200, y: 40, width: 600, height: 400 }), bA);
  const vpA = { w: await ev("window.innerWidth"), h: await ev("window.innerHeight") };
  check("r10-03", "A：页面真实视口 = 视图尺寸（视图里没有白板），也没有缩放", vpA.w === 600 && vpA.h === 400 && stateScale() === undefined, { vpA, scale: stateScale() });
  const fA = stateFit();
  check("r10-04", "A：session.getState() 带出 viewFit（占槽位的比例）", !!fA && near(fA.left, 150 / 900) && fA.top === 0 && near(fA.width, 600 / 900) && near(fA.height, 400 / 500), fA);
  const gA = await fitNow();
  check("r10-05", "A：整页恰好铺满视图（蓝块贴右下角、绿块贴左上角、无白像素）", gA.ok, gA);
  check("r10-06", "A：AI 鼠标点击不被补偿（scale=1）：CSS (170,220) 命中 #tgt", hits(await aiClick(170, 220), 170, 220, "tgt", 1.5));

  // ═══════════ B：Desktop 尺寸 1440×900 放进 900×500 的槽位：整体缩小 ═══════════
  await call("emulate", { width: 1440, height: 900 });
  const sB = expScale(SLOT, 1440, 900);
  await waitFor(() => stateScale() === sB);
  await sleep(300);
  const eB = expView(SLOT, 1440, 900, sB);
  check("r10-07", `B：视图 = floor(模拟 × ${sB})、居中、顶部对齐；TabInfo.fitScale = ${sB}`, eqRect(viewBounds(), eB) && stateScale() === sB, { b: viewBounds(), expect: eB, scale: stateScale() });
  const fB = stateFit();
  check("r10-08", "B：viewFit 占槽位比例（遮盖图靠它摆位置）", !!fB && near(fB.left, (eB.x - SLOT.x) / SLOT.width) && fB.top === 0 && near(fB.width, eB.width / SLOT.width) && near(fB.height, eB.height / SLOT.height), fB);
  // 页面看到的不变：视口仍是 1440×900 CSS 像素、媒体查询按 1440 判断、DOM 几何不变
  const pageB = {
    w: await ev("window.innerWidth"),
    h: await ev("window.innerHeight"),
    mq: await ev("window.matchMedia('(min-width: 1400px)').matches"),
    rect: JSON.parse(await ev("JSON.stringify(document.getElementById('tgt').getBoundingClientRect())")),
  };
  check(
    "r10-09",
    "B：页面看到的不变——innerWidth/Height = 1440×900、媒体查询按 1440 判断、#tgt 的 getBoundingClientRect = (150,200,40,40)",
    pageB.w === 1440 && pageB.h === 900 && pageB.mq === true && pageB.rect.x === 150 && pageB.rect.y === 200 && pageB.rect.width === 40 && pageB.rect.height === 40,
    pageB,
  );
  const gB = await fitNow();
  check("r10-10", "B：整页恰好铺满缩小后的视图（蓝块贴右下角、绿块贴左上角、无白像素）", gB.ok, gB);

  // AI 输入补偿
  check("r10-11", "B：AI browser_mouse 点击 CSS (170,220) 命中 #tgt（落点 = CSS 坐标）", hits(await aiClick(170, 220), 170, 220, "tgt", 1.5));
  check("r10-12", "B：AI 点击远端 CSS (1400,880)（离原点最远，补偿错了差几百像素）命中右下角蓝块 #br", hits(await aiClick(1400, 880), 1400, 880, "br", 1.5));
  const snapB = (await call("snapshot", {})).text;
  const near_ = refOf(snapB, "近按钮");
  const far_ = refOf(snapB, "远按钮");
  const b0 = [await ev("window.__btn"), await ev("window.__far")];
  if (near_) await call("click", { ref: near_ });
  if (far_) await call("click", { ref: far_ });
  const b1 = [await ev("window.__btn"), await ev("window.__far")];
  check("r10-13", "B：AI 按 ref 点击近 / 远两个按钮（DOM.getContentQuads 的 CSS 坐标 → 补偿 → 命中）", !!near_ && !!far_ && b1[0] === b0[0] + 1 && b1[1] === b0[1] + 1, { near_, far_, b0, b1 });
  // 用户真实点击：Chromium 自己按 scale 反向映射（view 局部坐标 = CSS × scale）
  const uh1 = await userClick(Math.round(170 * sB), Math.round(220 * sB));
  const uh2 = await userClick(Math.round(1400 * sB), Math.round(880 * sB));
  check("r10-14", "B：用户真实点击（视图局部坐标）被映射回 CSS 坐标，近点命中 #tgt、远点命中 #br", hits(uh1, 170, 220, "tgt", 2.5) && hits(uh2, 1400, 880, "br", 2.5), { uh1, uh2 });

  // 截图 / clip / 内容：与缩放比例无关
  const shot1 = await call("screenshot", {});
  const png = await tab().send("Page.captureScreenshot", { format: "png" });
  const img = nativeImage.createFromBuffer(Buffer.from(png.data, "base64"));
  const isz = img.getSize();
  const ibm = img.toBitmap();
  const px = (x, y) => {
    const i = (y * isz.width + x) * 4;
    return { b: ibm[i], g: ibm[i + 1], r: ibm[i + 2] };
  };
  const kk = isz.width / 1440;
  const tl = px(Math.round(20 * kk), Math.round(20 * kk));
  const br = px(isz.width - Math.round(20 * kk), isz.height - Math.round(20 * kk));
  check(
    "r10-15",
    "B：CDP 整页截图 = 1440×900 CSS 像素的完整页面（左上角绿块、右下角蓝块，宽高比 1.6）",
    near(isz.width / isz.height, 1440 / 900, 0.01) && tl.g > 180 && tl.r < 150 && br.b > 180 && br.r < 100,
    { isz, tl, br },
  );
  const dpr = await ev("window.devicePixelRatio");
  const clip = await tab().send("Page.captureScreenshot", { format: "png", clip: { x: 150, y: 200, width: 40, height: 40, scale: 1 } });
  const cimg = nativeImage.createFromBuffer(Buffer.from(clip.data, "base64"));
  const csz = cimg.getSize();
  const cbm = cimg.toBitmap();
  const ci = (Math.floor(csz.height / 2) * csz.width + Math.floor(csz.width / 2)) * 4;
  check(
    "r10-16",
    "B：clip 截图 #tgt (40×40 CSS 像素) 的尺寸 = 40 × dpr 且中心是黄色——clip 坐标仍是 CSS",
    csz.width === Math.round(40 * dpr) && csz.height === Math.round(40 * dpr) && cbm[ci + 2] > 180 && cbm[ci + 1] > 180 && cbm[ci] < 120,
    { csz, dpr },
  );
  // 另一个比例下 screenshot op 的尺寸不变（对比的是同一模拟、不同 scale）
  sess.setBounds({ ...SLOT, width: 700 });
  const sB2 = expScale({ ...SLOT, width: 700 }, 1440, 900);
  await waitFor(() => stateScale() === sB2);
  await sleep(300);
  const shot2 = await call("screenshot", {});
  check(
    "r10-17",
    `B：screenshot op 的尺寸不随缩放比例变（比例 ${sB} → ${sB2} 前后一致）`,
    sB !== sB2 && shot1.width === shot2.width && shot1.height === shot2.height && near(shot1.width / shot1.height, 1440 / 900, 0.01),
    { s1: [shot1.width, shot1.height], s2: [shot2.width, shot2.height] },
  );

  // ═══════════ 拖面板：连续改槽位宽度 → 每一步都铺满、页面不被打扰 ═══════════
  sess.setBounds(SLOT);
  await waitFor(() => stateScale() === sB);
  await sleep(300);
  await ev("window.__resize = 0");
  let dragOk = true;
  const dragLog = [];
  for (const w of [820, 760, 700, 640, 580, 520, 480]) {
    const slot = { ...SLOT, width: w };
    sess.setBounds(slot);
    const syncW = viewBounds().width; // 同步：视图不能超出槽位（缩放应答之前也不能伸出面板）
    const s = expScale(slot, 1440, 900);
    const e = expView(slot, 1440, 900, s);
    const okScale = await waitFor(() => stateScale() === s && eqRect(viewBounds(), e));
    const f = await fitNow();
    const row = { w, s, syncW, okScale: !!okScale, view: f.b, fits: f.ok };
    dragLog.push(row);
    if (syncW > w || !okScale || !f.ok) dragOk = false;
  }
  check("r10-18", "拖窄面板（槽位宽 820→480）：每一步视图 ≤ 槽位（含同步那一刻）、比例跟着变、整页都恰好铺满视图", dragOk, dragLog);
  const resizeCount = await ev("window.__resize");
  const vpDrag = { w: await ev("window.innerWidth"), h: await ev("window.innerHeight") };
  check("r10-19", "拖面板期间页面视口始终 1440×900，不触发 resize 事件", vpDrag.w === 1440 && vpDrag.h === 900 && resizeCount === 0, { vpDrag, resizeCount });

  // 拖宽到不需要缩放：回到 A（scale 回 1，视图 = 模拟尺寸）
  const wide = { x: 0, y: 0, width: 1600, height: 1000 };
  sess.setBounds(wide);
  await waitFor(() => stateScale() === undefined);
  await sleep(300);
  const gWide = await fitNow();
  check("r10-20", "槽位大到放得下 1440×900：fitScale 消失、视图 = 1440×900 居中、页面仍铺满", stateScale() === undefined && eqRect(viewBounds(), expView(wide, 1440, 900, 1)) && gWide.ok, { b: viewBounds(), fit: gWide });
  check("r10-21", "拖回不缩放后 AI 点击不再补偿：CSS (170,220) 命中 #tgt", hits(await aiClick(170, 220), 170, 220, "tgt", 1.5));
  sess.setBounds(SLOT);
  await waitFor(() => stateScale() === sB);
  await sleep(300);

  // ═══════════ R9-03：槽位变了、缩放比例没变 → viewFit 也要推给渲染端 ═══════════
  // SLOT 900×500 对 1440×900 是「高度限制」（比例 0.555）；把槽位拉宽到 1000 仍是高度限制，比例不变，
  // 但视图占槽位的比例（viewFit）变了。渲染端遮盖图靠 viewFit 摆位置，漏推 = 遮盖图错位直到下一次别的变化
  const pushedFit = () => {
    const last = pushed.filter((p) => p[0] === T).at(-1);
    return last?.[1]?.tabs?.find((t) => t.isActive)?.viewFit;
  };
  const fitBeforeR9 = pushedFit();
  const scaleBeforeR9 = stateScale();
  const slotR9 = { ...SLOT, width: 1000 };
  const expFitR9 = (() => {
    const e = expView(slotR9, 1440, 900, sB);
    return { left: (e.x - slotR9.x) / slotR9.width, top: (e.y - slotR9.y) / slotR9.height, width: e.width / slotR9.width, height: e.height / slotR9.height };
  })();
  sess.setBounds(slotR9);
  const pushedOk = await waitFor(() => {
    const f = pushedFit();
    return !!f && near(f.left, expFitR9.left) && near(f.width, expFitR9.width) && near(f.height, expFitR9.height);
  });
  check(
    "r10-21b",
    "R9-03：槽位拉宽、缩放比例不变（高度限制）时，推给渲染端的 viewFit 也跟着更新",
    !!fitBeforeR9 && !!pushedOk && stateScale() === scaleBeforeR9 && scaleBeforeR9 === sB && !near(pushedFit().left, fitBeforeR9.left),
    { before: fitBeforeR9, after: pushedFit(), expected: expFitR9, scaleBefore: scaleBeforeR9, scaleAfter: stateScale() },
  );
  sess.setBounds(SLOT);
  await waitFor(() => near(stateFit()?.left, fitBeforeR9?.left));
  await sleep(300);

  // ═══════════ 页面缩放叠加 ═══════════
  for (const level of [1, -1]) {
    wc().setZoomLevel(level);
    await sleep(500);
    const factor = 1.2 ** level;
    const w = await ev("window.innerWidth");
    const f = await fitNow();
    const h = await aiClick(170, 220);
    check(
      `r10-22-z${level}`,
      `B + 页面缩放 ${Math.round(factor * 100)}%：视图不变、页面 CSS 视口 × 缩放 = 1440 DIP、整页铺满、AI 点击 CSS (170,220) 仍命中`,
      eqRect(viewBounds(), eB) && Math.abs(w * factor - 1440) < 2 && f.ok && hits(h, 170, 220, "tgt", 1.5),
      { w, factor, fit: f.ok, hit: h },
    );
  }
  wc().setZoomLevel(0);
  await sleep(400);

  // ═══════════ 滚动距离与比例无关 ═══════════
  await call("navigate", { url: `${base}/tall` });
  await sleep(300);
  await call("scroll", { direction: "down", amount: 300 });
  await sleep(300);
  const sy = await ev("window.scrollY");
  check("r10-23", "B：scroll down 300 → scrollY ≈ 300（滚轮距离不被缩放放大 / 缩小）", Math.abs(sy - 300) <= 2, { scrollY: sy });
  await call("navigate", { url: `${base}/` });
  await sleep(300);
  await waitFor(() => stateScale() === sB);

  // ═══════════ 遮盖：占位图宽高比 = 缩小后的视图 ═══════════
  const cover = await sess.setCovered(true);
  const coveredFit = stateFit();
  check("r10-24", "遮盖期间 viewFit 仍在", !!coveredFit && near(coveredFit.width, eB.width / SLOT.width), coveredFit);
  if (cover) {
    const size = nativeImage.createFromDataURL(cover).getSize();
    check("r10-25", `遮盖截图的宽高比 = 缩小后的视图（${eB.width}×${eB.height}）`, near(size.width / size.height, eB.width / eB.height, 0.02), size);
  } else {
    skip("r10-25", "遮盖截图宽高比", "无头隐藏窗口里 capturePage 没有返回图（不影响其它项）");
  }
  await sess.setCovered(false);

  // ═══════════ debugger 重连：重放带上缩放 ═══════════
  wc().debugger.detach();
  await sleep(300);
  await ev("1"); // 下一次 CDP 调用会重连并重放模拟
  await waitFor(() => stateScale() === sB && eqRect(viewBounds(), eB), 4000);
  const gRe = await fitNow();
  const hRe = await aiClick(1400, 880);
  check("r10-26", "debugger 断开重连后：缩放重放、视图不变、整页铺满、AI 点击补偿仍对", stateScale() === sB && eqRect(viewBounds(), eB) && gRe.ok && hits(hRe, 1400, 880, "br", 1.5), { scale: stateScale(), b: viewBounds(), fit: gRe.ok, hit: hRe });

  // ═══════════ 停车场往返 ═══════════
  sess.detach();
  await sleep(200);
  check("r10-27", "detach（搬进停车场）：用固定停车场矩形、viewFit 消失、已生效比例保留", eqRect(viewBounds(), PARKING_BOUNDS) && stateFit() === undefined && stateScale() === sB, { b: viewBounds(), scale: stateScale() });
  const hPark = await aiClick(170, 220);
  check("r10-28", "停车场里 AI 照常工作且补偿一致：CSS (170,220) 命中 #tgt（面板收起时 AI 不能点歪）", hits(hPark, 170, 220, "tgt", 1.5), hPark);
  await call("emulate", { width: 1000, height: 700 }); // 停车场里改模拟：不能把停车场视图改成槽位矩形
  await sleep(300);
  check("r10-29", "停车场里改模拟不动视图矩形、不为看不见的视图重算比例", eqRect(viewBounds(), PARKING_BOUNDS), { b: viewBounds(), scale: stateScale() });
  const slotBack = { x: 0, y: 0, width: 800, height: 400 };
  sess.attach(slotBack);
  const sBack = expScale(slotBack, 1000, 700);
  await waitFor(() => stateScale() === sBack);
  await sleep(300);
  const fBack = await fitNow();
  check("r10-30", `重新 attach：按新槽位 800×400 和当前模拟 1000×700 重算（比例 ${sBack}）、整页铺满`, stateScale() === sBack && eqRect(viewBounds(), expView(slotBack, 1000, 700, sBack)) && fBack.ok, { scale: stateScale(), b: viewBounds(), fit: fBack.ok });
  sess.setBounds(SLOT);
  await sleep(300);

  // ═══════════ 移动预设：iPhone 15（393×852，mobile）+ 触摸 ═══════════
  await call("emulate", { device: "iPhone 15" });
  const sP = expScale(SLOT, 393, 852);
  await waitFor(() => stateScale() === sP);
  await sleep(400);
  const eP = expView(SLOT, 393, 852, sP);
  const scr = { w: await ev("screen.width"), h: await ev("screen.height") };
  const fP = await fitNow();
  check("r10-31", `iPhone 15：比例 ${sP}、视图 ${eP.width}×${eP.height} 居中、screen = 393×852、整页铺满`, stateScale() === sP && eqRect(viewBounds(), eP) && scr.w === 393 && scr.h === 852 && fP.ok, { scale: stateScale(), b: viewBounds(), scr, fit: fP.ok });
  await clearMd();
  await call("touch", { action: "tap", x: 170, y: 220 });
  await sleep(200);
  const ts = JSON.parse((await ev("JSON.stringify(window.__ts)")) || "[]");
  check("r10-32", "iPhone 15 + 缩放：AI touch tap CSS (170,220) 命中 #tgt（触点坐标也补偿）", hits(ts[0], 170, 220, "tgt", 2.5), ts);

  // ═══════════ 只给宽、不给高：不缩放（只走 A 的收窄），页面仍按给定宽排版 ═══════════
  await call("emulate", { reset: true });
  await call("emulate", { width: 1440 });
  await sleep(400);
  const vpW = await ev("window.innerWidth");
  check("r10-33", "只给宽 1440（没给高）：不缩放、无 fitScale，页面按 1440 排版（面板窄时被裁切，契约里的已知边界）", stateScale() === undefined && vpW === 1440 && viewBounds().width <= SLOT.width, { b: viewBounds(), vpW, scale: stateScale() });

  // ═══════════ reset：全部归位，补偿不残留 ═══════════
  await call("emulate", { width: 1440, height: 900 });
  await waitFor(() => stateScale() === sB);
  await call("emulate", { reset: true });
  await waitFor(() => stateScale() === undefined && eqRect(viewBounds(), SLOT));
  await sleep(400);
  const vpReset = { w: await ev("window.innerWidth"), h: await ev("window.innerHeight") };
  const gReset = await fitNow();
  const hReset = await aiClick(170, 220);
  check(
    "r10-34",
    "reset：视图放回整个槽位、viewFit / fitScale 消失、页面视口回到槽位大小、整页铺满，AI 点击不再补偿（CSS (170,220) 仍命中）",
    eqRect(viewBounds(), SLOT) && stateFit() === undefined && stateScale() === undefined && vpReset.w === SLOT.width && vpReset.h === SLOT.height && gReset.ok && hits(hReset, 170, 220, "tgt", 1.5),
    { b: viewBounds(), vpReset, fit: gReset.ok, hit: hReset },
  );

  sess.detach();
  manager.destroy();
  server.close();
};

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结果 */
    }
    app.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error("SMOKE ERROR", e);
    app.exit(2);
  });
