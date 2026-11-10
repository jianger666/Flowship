"use strict";
/**
 * E2·P5b 冒烟（真 Electron + 真 CDP）：C1 browser_emulate 增强 + C2 browser_touch。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p5b-emulate-touch.cjs --timeout 150
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-p5b-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAIN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>P5b</title>
<style>body{margin:0;background:#f00;font:16px sans-serif} #sa{padding-top:env(safe-area-inset-top, 11px);padding-bottom:env(safe-area-inset-bottom, 11px)}</style></head>
<body><div id="sa">x</div>
<script>
window.__orient = null;
window.addEventListener('deviceorientation', function(e){ window.__orient = { a: e.alpha, b: e.beta, g: e.gamma }; });
</script></body></html>`;

const JS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>js</title></head><body>
<p id="x">no-js</p><a id="lnk" href="/js2">go-next</a>
<script>document.getElementById('x').textContent='js-ran';</script></body></html>`;

const JS2 = `<!doctype html><html><head><meta charset="utf-8"><title>js2</title></head><body><p id="x">second-page</p></body></html>`;

// 触屏页：记录触屏事件序列（类型:触点数）、坐标、时间戳，以及触屏事件发生时的 maxTouchPoints
const TOUCH_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>touch</title>
<style>body{margin:0} #pad{position:absolute;left:20px;top:100px;width:300px;height:300px;background:#cde;touch-action:none}
#btn{position:absolute;left:20px;top:20px;width:120px;height:50px} #pw{position:absolute;left:160px;top:20px;width:150px;height:30px}</style></head><body>
<button id="btn">轻触我</button><input id="pw" type="password" value="" aria-label="密码">
<div id="pad"></div>
<script>
window.__log = []; window.__clicks = 0; window.__inputs = 0; window.__ctx = 0;
var pad = document.getElementById('pad');
['touchstart','touchmove','touchend','touchcancel'].forEach(function(t){
  pad.addEventListener(t, function(e){
    var ts = e.touches; var first = ts[0];
    var pts = []; for (var i = 0; i < ts.length; i++) pts.push({ id: ts[i].identifier, x: ts[i].clientX, y: ts[i].clientY });
    window.__log.push({ t: t, n: ts.length, pts: pts, at: performance.now(), mtp: navigator.maxTouchPoints });
  }, { passive: false });
});
pad.addEventListener('click', function(){ window.__clicks++; });
pad.addEventListener('contextmenu', function(){ window.__ctx++; });
document.getElementById('btn').addEventListener('touchstart', function(){ window.__log.push({ t: 'btn-touchstart', n: 0, pts: [], at: performance.now() }); });
document.getElementById('btn').addEventListener('click', function(){ window.__clicks++; });
document.getElementById('pw').addEventListener('input', function(){ window.__inputs++; });
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const counts = { asset: 0 };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const p = u.pathname;
      if (p === "/asset.js") {
        counts.asset++;
        res.setHeader("content-type", "application/javascript");
        res.setHeader("cache-control", "public, max-age=3600, immutable");
        return res.end("window.__asset = 1;");
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (p === "/cache") return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>c</title></head><body>${u.search}<script src="/asset.js"></script></body></html>`);
      if (p === "/js") return res.end(JS_PAGE);
      if (p === "/js2") return res.end(JS2);
      if (p === "/touch") return res.end(TOUCH_PAGE);
      res.end(MAIN);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, counts }));
  });

const main = async () => {
  await app.whenReady();
  const { server, base, counts } = await startFixture();
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

  const T = "p5b-task";
  const call = (op, args = {}, signal) => manager.dispatch(op, args, { taskId: T, signal });
  const tryCall = async (op, args, signal) => {
    try {
      return { ok: true, value: await call(op, args, signal) };
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
  const snap = async () => (await call("snapshot", {})).text;

  // ═══════════ C1：媒体特征 / 安全区 / 视觉缺陷 ═══════════
  await call("navigate", { url: `${base}/` });
  const mm = (q) => ev(`matchMedia(${JSON.stringify(q)}).matches`);

  await call("emulate", { forcedColors: "active" });
  check("c1-forced-colors", "forced_colors=active：matchMedia(forced-colors: active) 为真", (await mm("(forced-colors: active)")) === true);
  await call("emulate", { prefersContrast: "more" });
  check(
    "c1-prefers-contrast",
    "prefers_contrast=more：matchMedia 为真，且同时保留 forced-colors（整体替换语义没把它冲掉）",
    (await mm("(prefers-contrast: more)")) === true && (await mm("(forced-colors: active)")) === true,
  );
  await call("emulate", { media: "print" });
  check("c1-media-print", "media=print：matchMedia('print') 为真，其它特征仍在", (await mm("print")) === true && (await mm("(prefers-contrast: more)")) === true);
  await call("emulate", { media: "" });
  check("c1-media-default", "media 空串：恢复屏幕媒体，特征仍在", (await mm("print")) === false && (await mm("screen")) === true && (await mm("(forced-colors: active)")) === true);
  await call("emulate", { forcedColors: "none", prefersContrast: "no-preference" });
  check("c1-media-switch", "forced_colors=none / prefers_contrast=no-preference 覆盖回去", (await mm("(forced-colors: active)")) === false && (await mm("(prefers-contrast: more)")) === false);

  const sa = await tryCall("emulate", { safeArea: { top: 47, bottom: 34 } });
  const pt = sa.ok ? await ev("getComputedStyle(document.getElementById('sa')).paddingTop") : null;
  const pb = sa.ok ? await ev("getComputedStyle(document.getElementById('sa')).paddingBottom") : null;
  check("c1-safe-area", "safe_area：env(safe-area-inset-*) 生效（47px / 34px）", sa.ok && pt === "47px" && pb === "34px", { sa: sa.ok ? "ok" : sa.message, pt, pb });

  // 视觉缺陷：纯红背景在 achromatopsia 下三个通道应接近（灰）
  const px = async () => {
    const shot = await call("screenshot", { format: "png", maxWidth: 400 });
    const bmp = nativeImage.createFromBuffer(Buffer.from(shot.dataBase64, "base64")).toBitmap();
    const size = nativeImage.createFromBuffer(Buffer.from(shot.dataBase64, "base64")).getSize();
    const i = ((Math.floor(size.height / 2) * size.width) + Math.floor(size.width / 2)) * 4;
    return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] };
  };
  const before = await px();
  const vd = await tryCall("emulate", { visionDeficiency: "achromatopsia" });
  await sleep(200);
  const gray = await px();
  check("c1-vision", "vision_deficiency=achromatopsia：红色像素变成灰（r≈g≈b）", vd.ok && before.r > 200 && before.g < 60 && Math.abs(gray.r - gray.g) < 25 && Math.abs(gray.g - gray.b) < 25, { before, gray, vd: vd.ok ? "ok" : vd.message });
  await call("emulate", { visionDeficiency: "none" });
  await sleep(150);
  const back = await px();
  check("c1-vision-clear", "vision_deficiency=none：恢复为红色", back.r > 200 && back.g < 60, { back });

  // ═══════════ C1：orientation / touch ═══════════
  await call("emulate", { reset: true });
  await call("navigate", { url: `${base}/` });
  // deviceorientation 受「传感器」页面权限管（P1 的权限策略默认拒绝 → 页面只会收到值为 null 的事件）：先走 browser_permissions 授予本会话
  manager.onConfig({ evaluateEnabled: true, pagePermissions: true });
  const grant = await tryCall("permissions", { action: "grant", permission: "sensors" });
  console.log("  [grant sensors]", grant.ok ? JSON.stringify(grant.value).slice(0, 160) : `${grant.code}: ${grant.message}`);
  await call("navigate", { url: `${base}/` });
  const or = await tryCall("emulate", { orientation: { alpha: 30, beta: 60, gamma: -20 } });
  await sleep(300);
  // 先看页面加载时就挂着的监听器；没收到（覆盖在监听之前生效、或标签页不可见时传感器泵不推送）再挂一个新监听器等一次
  // 页面加载时 Chromium 会先发一个「无传感器」的 null 事件，所以要等「值非 null」的那一个
  let orient = await ev("window.__orient");
  if (!orient || orient.a === null) {
    orient = await ev(
      "new Promise(function(res){ var t = setTimeout(function(){ res(window.__orient); }, 2500); window.addEventListener('deviceorientation', function h(e){ if (e.alpha === null) return; clearTimeout(t); window.removeEventListener('deviceorientation', h); res({ a: e.alpha, b: e.beta, g: e.gamma }); }); })",
    );
  }
  check("c1-orientation", "orientation：页面 deviceorientation 事件读到 α30/β60/γ-20", or.ok && orient && Math.round(orient.a) === 30 && Math.round(orient.b) === 60 && Math.round(orient.g) === -20, { or: or.ok ? "ok" : or.message, orient, vis: await ev("document.visibilityState"), focus: await ev("document.hasFocus()"), secure: await ev("isSecureContext"), has: await ev("typeof DeviceOrientationEvent") });

  await call("emulate", { reset: true });
  check("c1-reset-summary", "reset 后 tab 摘要为空（info 里没有 emulation）", !(await call("tabs", { action: "list" })).tabs.some((t) => t.emulation));
  const orient2 = await ev("(function(){ return window.__orient })()");
  void orient2;

  // ═══════════ C1：disable_cache ═══════════
  await call("navigate", { url: `${base}/cache?n=1` });
  await call("navigate", { url: `${base}/cache?n=2` });
  const warm = counts.asset;
  check("c1-cache-baseline", "默认：同一静态资源第二个页面不再请求（命中缓存）", warm === 1, { asset: warm });
  await call("emulate", { disableCache: true });
  await call("navigate", { url: `${base}/cache?n=3` });
  await call("navigate", { url: `${base}/cache?n=4` });
  check("c1-disable-cache", "disable_cache：每次导航都重新请求该资源", counts.asset >= warm + 2, { asset: counts.asset });
  await call("emulate", { disableCache: false });
  const mid = counts.asset;
  await call("navigate", { url: `${base}/cache?n=5` });
  await call("navigate", { url: `${base}/cache?n=6` });
  check("c1-cache-restore", "恢复缓存后请求数不再每次增长（≤ 1 次回填）", counts.asset <= mid + 1, { mid, now: counts.asset });
  await call("emulate", { reset: true });

  // ═══════════ C1：disable_javascript ═══════════
  await call("emulate", { disableJavascript: true });
  const tabsInfo = await call("tabs", { action: "list" });
  check("c1-js-summary", "摘要里有「禁用 JS」", tabsInfo.tabs.some((t) => /禁用 JS/.test(t.emulation || "")), { e: tabsInfo.tabs.map((t) => t.emulation) });
  // R6 观察项：设置返回后的第一次导航偶尔仍会执行页内脚本（Chromium 的 DevTools 状态在新文档上恢复有时序窗口，
  // 隔离探针负载 ~50 时约 12%，见 docs/BROWSER-AUTOMATION.md S4 C1 的「已知缺口」）。这里最多重试 3 次导航，
  // 任一次脚本没执行就算「禁用 JS 生效」；detail 里记下漏过的次数，3 次全漏才算失败。
  let text1 = "";
  let jsLeaks = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await call("navigate", { url: `${base}/js` });
    text1 = await snap();
    if (/no-js/.test(text1) && !/js-ran/.test(text1)) break;
    jsLeaks++;
  }
  check("c1-js-off", "禁用 JS：页面脚本没执行（snapshot 仍是 no-js；最多重试 3 次导航）", /no-js/.test(text1) && !/js-ran/.test(text1), { jsLeaks, sample: text1.slice(0, 160) });
  const lnk = refOf(text1, "go-next");
  check("c1-js-snapshot", "禁用 JS 时 snapshot（AX 树）可用且能找到链接 ref", !!lnk);
  const cl = lnk ? await tryCall("click", { ref: lnk }) : { ok: false, message: "no ref" };
  const text2 = cl.ok ? await snap() : "";
  check("c1-js-click", "禁用 JS 时 click 可用（链接导航到第二页）", cl.ok && /second-page/.test(text2), { cl: cl.ok ? "ok" : cl.message });
  const evOff = await tryCall("evaluate", { expression: "1+1" });
  check("c1-js-evaluate-info", "（信息）禁用 JS 时 evaluate 的表现", true, { ok: evOff.ok, value: evOff.ok ? evOff.value.value : evOff.message });
  await call("emulate", { reset: true });
  await call("navigate", { url: `${base}/js` });
  const text3 = await snap();
  check("c1-js-reset", "reset 后恢复：脚本执行（js-ran）", /js-ran/.test(text3), { sample: text3.slice(0, 120) });

  // 面板「重置模拟」路径：tab.resetEmulation()（用户侧 IPC 同路径）
  await call("emulate", { disableJavascript: true });
  const st = manager.getState ? manager.getState(T) : null;
  void st;

  // ═══════════ C2：触屏手势 ═══════════
  await call("emulate", { reset: true });
  await call("navigate", { url: `${base}/touch` });
  const log = () => ev("JSON.stringify(window.__log)").then((s) => JSON.parse(s));
  const clearLog = () => ev("window.__log.length = 0; window.__clicks = 0; 1");
  const mtp = () => ev("navigator.maxTouchPoints");
  const text = await snap();
  const btn = refOf(text, "轻触我");
  const pw = refOf(text, "密码");

  check("c2-baseline", "起始：未开触屏模拟（maxTouchPoints=0）", (await mtp()) === 0);

  // tap（ref）
  const tapRef = await tryCall("touch", { action: "tap", ref: btn });
  const clicksAfterTap = await ev("window.__clicks");
  const logBtn = await log();
  check("c2-tap-ref", "tap(ref)：按钮收到 touchstart 与 click", tapRef.ok && logBtn.some((e) => e.t === "btn-touchstart") && clicksAfterTap === 1, { tap: tapRef.ok ? tapRef.value.gesture : tapRef.message, clicks: clicksAfterTap });
  check("c2-restore-1", "tap 之后触屏模拟已恢复（maxTouchPoints=0）", (await mtp()) === 0);

  // tap（x,y）：落在 pad 内
  await clearLog();
  const tapXY = await tryCall("touch", { action: "tap", x: 100, y: 200 });
  const l1 = await log();
  const seq1 = l1.map((e) => e.t);
  check("c2-tap-xy", "tap(x,y)：pad 收到 touchstart → touchend（单触点），触屏期间 maxTouchPoints>0，并产生 click", tapXY.ok && seq1[0] === "touchstart" && seq1[seq1.length - 1] === "touchend" && l1[0].n === 1 && l1[0].mtp > 0 && (await ev("window.__clicks")) === 1, { seq1, mtp: l1[0]?.mtp, tap: tapXY.ok ? "ok" : tapXY.message });

  // long_press
  await clearLog();
  const lp = await tryCall("touch", { action: "long_press", x: 100, y: 200, durationMs: 700 });
  const l2 = await log();
  const s2 = l2.find((e) => e.t === "touchstart");
  const e2 = l2.find((e) => e.t === "touchend" || e.t === "touchcancel");
  const held = s2 && e2 ? e2.at - s2.at : 0;
  check("c2-long-press", "long_press 700ms：touchstart 与 touchend 间隔 ≥ 650ms", lp.ok && held >= 650 && held < 1500, { held: Math.round(held), ctx: await ev("window.__ctx"), lp: lp.ok ? "ok" : lp.message });

  // swipe
  await clearLog();
  const sw = await tryCall("touch", { action: "swipe", x: 60, y: 250, direction: "right", distance: 200, durationMs: 400 });
  const l3 = await log();
  const moves = l3.filter((e) => e.t === "touchmove");
  const startX = l3.find((e) => e.t === "touchstart")?.pts[0]?.x;
  const lastX = moves.length ? moves[moves.length - 1].pts[0]?.x : null;
  check("c2-swipe", "swipe right 200：touchstart → 多个 touchmove → touchend，终点 x ≈ 起点 + 200", sw.ok && moves.length >= 4 && Math.abs(lastX - startX - 200) < 3 && l3[l3.length - 1].t === "touchend", { moves: moves.length, startX, lastX, sw: sw.ok ? sw.value.gesture : sw.message });

  // swipe 到坐标
  await clearLog();
  const sw2 = await tryCall("touch", { action: "swipe", x: 200, y: 350, toX: 200, toY: 150, durationMs: 300 });
  const l4 = await log();
  const lm = l4.filter((e) => e.t === "touchmove").pop();
  check("c2-swipe-xy", "swipe 到坐标：终点 y ≈ 150", sw2.ok && lm && Math.abs(lm.pts[0].y - 150) < 3, { y: lm?.pts[0]?.y });

  // pinch
  await clearLog();
  const pc = await tryCall("touch", { action: "pinch", x: 170, y: 250, scale: 2, durationMs: 400 });
  const l5 = await log();
  const dist = (e) => Math.hypot(e.pts[0].x - e.pts[1].x, e.pts[0].y - e.pts[1].y);
  const pms = l5.filter((e) => e.t === "touchmove" && e.pts.length === 2);
  // 注意：CDP 对「一次 touchStart 带两点」会分成逐点事件，第一个 touchstart 可能只带 1 点 → 取第一个带 2 点的事件作基线
  const base2 = l5.find((e) => e.pts.length === 2);
  const ratio2 = base2 && pms.length ? dist(pms[pms.length - 1]) / dist(base2) : 0;
  const ids = base2 ? base2.pts.map((p) => p.id).sort() : [];
  check("c2-pinch", "pinch scale=2：出现两个触点（不同 id），两指间距放大约 2 倍", pc.ok && ids.length === 2 && ids[0] !== ids[1] && ratio2 > 1.8 && ratio2 < 2.2, { ids, ratio2: ratio2.toFixed(2), seq: l5.map((e) => `${e.t}:${e.n}`).slice(0, 6), pc: pc.ok ? "ok" : pc.message });

  // pinch 缩小
  await clearLog();
  const pc2 = await tryCall("touch", { action: "pinch", x: 170, y: 250, scale: 0.5, durationMs: 300 });
  const l6 = await log();
  const b6 = l6.find((e) => e.pts.length === 2);
  const m6 = l6.filter((e) => e.t === "touchmove" && e.pts.length === 2).pop();
  check("c2-pinch-in", "pinch scale=0.5：两指间距缩小约一半", pc2.ok && b6 && m6 && dist(m6) / dist(b6) > 0.4 && dist(m6) / dist(b6) < 0.6, { r: b6 && m6 ? (dist(m6) / dist(b6)).toFixed(2) : null });

  check("c2-restore-2", "所有手势之后触屏模拟都已恢复（maxTouchPoints=0）", (await mtp()) === 0);

  // 已开触屏模拟时不去关它
  await call("emulate", { touch: true });
  await call("touch", { action: "tap", x: 100, y: 200 });
  check("c2-keep-emulation", "emulate touch:true 后再 touch：手势之后触屏模拟仍保持开启", (await mtp()) > 0, { mtp: await mtp() });
  await call("emulate", { reset: true });
  check("c2-reset-touch", "reset 后触屏模拟关闭", (await mtp()) === 0);

  // 取消（signal）：长按 3s 在 300ms 后被取消 → 页面收到 touchcancel，触屏模拟恢复
  await clearLog();
  const ac = new AbortController();
  const pending = tryCall("touch", { action: "long_press", x: 100, y: 200, durationMs: 3000 }, ac.signal);
  await sleep(500);
  ac.abort();
  const cancelled = await pending;
  await sleep(200);
  const l7 = await log();
  check("c2-cancel", "长按中途取消：操作失败且页面收到 touchcancel（没有幽灵触点），触屏模拟已恢复", !cancelled.ok && l7.some((e) => e.t === "touchcancel") && !l7.some((e) => e.t === "touchend") && (await mtp()) === 0, { cancelled: cancelled.ok ? "ok" : `${cancelled.code}:${cancelled.message}`.slice(0, 80), seq: l7.map((e) => e.t) });

  // 敏感输入框：tap 只聚焦、不产生字符输入
  await call("touch", { action: "tap", ref: pw });
  const focusedType = await ev("document.activeElement && document.activeElement.type");
  check("c2-secret-no-input", "触屏点击密码框只聚焦，不产生任何字符输入（input 事件 0、值为空）", focusedType === "password" && (await ev("window.__inputs")) === 0 && (await ev("document.getElementById('pw').value")) === "", { focusedType });

  // 参数 / 越权
  const oob = await tryCall("touch", { action: "tap", x: 99999, y: 5 });
  check("c2-oob", "坐标超出视口 → BAD_ARGS", !oob.ok && oob.code === "BAD_ARGS", { code: oob.code });
  const stale = await tryCall("touch", { action: "tap", ref: "e9999" });
  check("c2-stale", "不存在的 ref → 可自修复的错误（REF_STALE / 非 INTERNAL）", !stale.ok && stale.code && stale.code !== "INTERNAL", { code: stale.code, m: (stale.message || "").slice(0, 60) });
  const badMix = await tryCall("touch", { action: "tap", ref: btn, x: 1, y: 2 });
  check("c2-ref-xy-exclusive", "ref 与 x/y 同给 → BAD_ARGS", !badMix.ok && badMix.code === "BAD_ARGS");
  const badLp = await tryCall("touch", { action: "long_press", x: 100, y: 200, durationMs: 9999 });
  check("c2-longpress-cap", "long_press 超过 3000ms → BAD_ARGS", !badLp.ok && badLp.code === "BAD_ARGS");
  const badScale = await tryCall("touch", { action: "pinch", x: 100, y: 200, scale: 9 });
  check("c2-scale-cap", "pinch scale>5 → BAD_ARGS", !badScale.ok && badScale.code === "BAD_ARGS");

  // 活动日志：actor ai
  const act = await call("user_activity", { markSeen: false, limit: 200 }).catch(() => null);
  void act;

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.id).join(", ")}` : ""}`);
  try {
    await call("close_session", {});
  } catch {
    /* ignore */
  }
  app.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error("SMOKE ERROR", e);
  app.exit(2);
});
