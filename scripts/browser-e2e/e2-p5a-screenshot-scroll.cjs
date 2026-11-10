"use strict";
/**
 * E2·P5a 冒烟（真 Electron + 真 CDP）：B6 截图增强（format / quality / max_width / clip / scale / omit_background / annotate）
 * 与 C3 滚动增强（scroll_into_view / until_stable）。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p5a-screenshot-scroll.cjs --timeout 150
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-p5a-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAIN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>P5a</title>
<style>body{margin:0;font:16px sans-serif;background:#fff} #blk{position:absolute;left:100px;top:300px;width:120px;height:60px;background:#f00}
#bottom{position:absolute;left:40px;top:4000px;width:160px;height:40px} #hid{position:absolute;left:300px;top:200px;width:100px;height:30px}</style></head><body>
<h1>截图与滚动</h1>
<button id="b1" style="position:absolute;left:20px;top:120px;width:120px;height:40px">提交</button>
<input id="pw" type="password" value="supersecret123" style="position:absolute;left:200px;top:120px;width:180px;height:30px" aria-label="密码">
<a href="#x" style="position:absolute;left:20px;top:200px">一个链接</a>
<div id="blk"></div>
<button id="hid">会被隐藏</button>
<button id="bottom">底部按钮</button>
<div style="height:4200px"></div>
<script>
window.__mut = 0;
new MutationObserver(function(m){ window.__mut += m.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
</script></body></html>`;

const PLAIN = `<!doctype html><html><head><meta charset="utf-8"><title>plain</title></head><body><h1>plain</h1></body></html>`;

// 无限滚动：滚到底后 300ms 追加一块，最多追加 limit 次
const infinite = (limit) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>inf</title>
<style>body{margin:0} .blk{height:800px;border-bottom:1px solid #ccc}</style></head><body><div class="blk">0</div><div class="blk">1</div>
<script>
window.__count = 0; var loading = false;
function atBottom(){ return innerHeight + scrollY >= document.documentElement.scrollHeight - 5; }
window.addEventListener('scroll', function(){
  if (!atBottom() || loading || window.__count >= ${limit}) return;
  loading = true;
  setTimeout(function(){ var d = document.createElement('div'); d.className = 'blk'; d.textContent = String(2 + window.__count); document.body.appendChild(d); window.__count++; loading = false; }, 300);
});
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (p === "/plain") return res.end(PLAIN);
      if (p === "/infinite") return res.end(infinite(3));
      if (p === "/forever") return res.end(infinite(100000));
      res.end(MAIN);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

const main = async () => {
  await app.whenReady();
  const { server, base } = await startFixture();
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const kit = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/screenshot-kit.mjs")).href);

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

  const T = "p5a-task";
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
  const buf = (r) => Buffer.from(r.dataBase64, "base64");
  const bitmapOf = (r) => nativeImage.createFromBuffer(buf(r)).toBitmap();
  const BIG = 4096;

  // ═══════════ B6 截图 ═══════════
  await call("navigate", { url: `${base}/` });
  const dpr = await ev("devicePixelRatio");

  const def = await call("screenshot", {});
  check("shot-default", "默认：jpeg（文件头 jpeg、mime、format 字段），宽 ≤1280", def.mimeType === "image/jpeg" && kit.readImageSize(buf(def))?.format === "jpeg" && def.format === "jpeg" && def.width <= 1280 && def.width > 0, { w: def.width, h: def.height, fmt: def.format });

  const png = await call("screenshot", { format: "png", maxWidth: BIG });
  const pngSize = kit.readImageSize(buf(png));
  check("shot-png", "format=png：文件头 png，尺寸与结果一致", png.mimeType === "image/png" && pngSize?.format === "png" && pngSize.width === png.width && pngSize.height === png.height, { pngSize, w: png.width });

  const webp = await call("screenshot", { format: "webp", maxWidth: BIG });
  const webpSize = kit.readImageSize(buf(webp));
  check("shot-webp", "format=webp：RIFF/WEBP 文件头，mime image/webp，尺寸可解析", webp.mimeType === "image/webp" && webpSize?.format === "webp" && webpSize.width > 0, { webpSize });

  const lo = await call("screenshot", { format: "jpeg", quality: 10, maxWidth: BIG });
  const hi = await call("screenshot", { format: "jpeg", quality: 95, maxWidth: BIG });
  check("shot-quality", "quality：q10 的 jpeg 体积明显小于 q95", buf(lo).length < buf(hi).length, { lo: buf(lo).length, hi: buf(hi).length });

  const mwJ = await call("screenshot", { format: "jpeg", maxWidth: 400 });
  const mwP = await call("screenshot", { format: "png", maxWidth: 400 });
  const mwW = await call("screenshot", { format: "webp", maxWidth: 400 });
  const wJ = kit.readImageSize(buf(mwJ)).width;
  const wP = kit.readImageSize(buf(mwP)).width;
  const wW = kit.readImageSize(buf(mwW)).width;
  check("shot-maxwidth", "max_width=400：jpeg / png / webp 的真实图片宽都 ≤400", wJ <= 400 && wP <= 400 && wW <= 400 && wJ >= 300 && wW >= 300, { wJ, wP, wW });

  // clip 的坐标系是「视口 CSS 像素」：先滚动 250px，红块在页面 (100,300) → 视口 (100,50)
  await call("scroll", { direction: "top" });
  await ev("window.scrollTo(0, 250)");
  await sleep(200);
  const clipped = await call("screenshot", { format: "png", maxWidth: BIG, clip: { x: 100, y: 50, width: 120, height: 60 } });
  const cs = kit.readImageSize(buf(clipped));
  const cbmp = bitmapOf(clipped);
  const mid = ((Math.floor(cs.height / 2) * cs.width) + Math.floor(cs.width / 2)) * 4;
  // BGRA / RGBA 顺序因平台而异：红块 = 两个分量大、一个接近 0 的一端；这里只判「红色通道（B 或 R 之一为大、另外两个小）」
  const px = [cbmp[mid], cbmp[mid + 1], cbmp[mid + 2]];
  const isRedish = Math.max(px[0], px[2]) > 200 && px[1] < 60 && Math.min(px[0], px[2]) < 60;
  check("shot-clip-size", "clip 120×60：输出像素尺寸 = 120×60 × dpr", cs.width === Math.round(120 * dpr) && cs.height === Math.round(60 * dpr), { cs, dpr });
  check("shot-clip-viewport", "clip 用视口坐标（滚动后仍截到红块）：中心像素是红色", isRedish, px);
  await ev("window.scrollTo(0, 0)");

  const base1 = await call("screenshot", { format: "png", maxWidth: BIG });
  const half = await call("screenshot", { format: "png", scale: 0.5 });
  const big = await call("screenshot", { format: "png", scale: 1.5 });
  const sh = kit.readImageSize(buf(half)).width;
  const sd = kit.readImageSize(buf(big)).width;
  check("shot-scale", "scale 0.5 / 1.5：宽度约为基线的 0.5× / 1.5×（±3px）", Math.abs(sh - base1.width / 2) <= 3 && Math.abs(sd - base1.width * 1.5) <= 3, { base: base1.width, sh, sd });
  // 显式 scale 且没给 max_width：上限放宽到 4096（scale 2 在 2560 的基线上被 4096 封顶，而不是被默认 1280 缩回去）
  const capped = await call("screenshot", { format: "png", scale: 2 });
  check("shot-scale-cap", "scale=2 无 max_width：宽度 = min(2×基线, 4096)", kit.readImageSize(buf(capped)).width === Math.min(base1.width * 2, 4096), { w: kit.readImageSize(buf(capped)).width });

  // 既有的 ref 截图在页面滚动后也要截对地方（CDP clip 是文档坐标）：#bottom 是绿块，滚到顶再按 ref 截它
  await ev("document.getElementById('bottom').style.background = '#0f0'");
  const snapG = await call("snapshot", {});
  const greenRef = refOf(snapG.text, "底部按钮");
  await call("scroll", { direction: "top" });
  const refShot = await call("screenshot", { ref: greenRef, format: "png", maxWidth: BIG });
  const rs = kit.readImageSize(buf(refShot));
  const rb = bitmapOf(refShot);
  const rmid = (Math.floor(rs.height / 2) * rs.width + Math.floor(rs.width / 2)) * 4;
  check("shot-ref-scrolled", "ref 截图（滚动后）截到该元素：中心像素是绿色", rb[rmid + 1] > 200 && rb[rmid + 1] > Math.max(rb[rmid], rb[rmid + 2]) + 60, [rb[rmid], rb[rmid + 1], rb[rmid + 2]]);
  await call("scroll", { direction: "top" });

  // omit_background：无背景的页面截出透明像素；截完背景覆盖已还原（再截一张是不透明的）
  await call("navigate", { url: `${base}/plain` });
  const tr = await call("screenshot", { format: "png", omitBackground: true, maxWidth: BIG });
  const trSize = kit.readImageSize(buf(tr));
  const trb = bitmapOf(tr);
  const lastPx = ((trSize.height - 5) * trSize.width + (trSize.width - 5)) * 4;
  const hist = { zero: 0, full: 0, other: 0 };
  for (let i = 3; i < trb.length; i += 4) {
    if (trb[i] === 0) hist.zero++;
    else if (trb[i] === 255) hist.full++;
    else hist.other++;
  }
  check("shot-omit-bg", "omit_background：右下角像素近乎透明（alpha<64，实测约 14 的抗锯齿残留），且过半像素 alpha=0", trb[lastPx + 3] < 64 && hist.zero > (hist.full + hist.other + hist.zero) * 0.5, { alpha: trb[lastPx + 3], hist });
  const op = await call("screenshot", { format: "png", maxWidth: BIG });
  const opb = bitmapOf(op);
  const opLast = ((kit.readImageSize(buf(op)).height - 5) * kit.readImageSize(buf(op)).width + (kit.readImageSize(buf(op)).width - 5)) * 4;
  check("shot-omit-bg-restored", "截完背景覆盖已还原：普通 png 同位置 alpha=255", opb[opLast + 3] === 255, { alpha: opb[opLast + 3] });
  const omitBad = await tryCall("screenshot", { omitBackground: true });
  check("shot-omit-bg-jpeg", "omit_background 配 jpeg → BAD_ARGS", !omitBad.ok && omitBad.code === "BAD_ARGS", omitBad.message);

  // annotate
  await call("navigate", { url: `${base}/` });
  const noRef = await tryCall("screenshot", { annotate: true });
  check("annotate-no-refs", "ref 表为空 → REF_STALE，提示先 snapshot", !noRef.ok && noRef.code === "REF_STALE" && /browser_snapshot/.test(noRef.message), noRef.message);

  const snap = await call("snapshot", {});
  const submitRef = refOf(snap.text, "提交");
  const sess = manager.getSession(T);
  const lastRefBefore = sess.activeTab.refTable.last;
  const stateExpr =
    "JSON.stringify({ n: document.querySelectorAll('*').length, g: Object.getOwnPropertyNames(window).length, mut: window.__mut, len: document.documentElement.outerHTML.length })";
  const domBefore = await ev(stateExpr);
  const plain = await call("screenshot", { format: "png", maxWidth: BIG });
  const ann = await call("screenshot", { format: "png", maxWidth: BIG, annotate: true });
  const domAfter = await ev(stateExpr);
  check("annotate-result", "annotate：annotated=true、legend 含 `[eN] button \"提交\"`，数量 ≥3", ann.annotated === true && ann.annotatedCount >= 3 && ann.legend.some((l) => l === `[${submitRef}] button "提交"`), { n: ann.annotatedCount, legend: ann.legend });
  check("annotate-no-residue", "annotate 前后页面 DOM / 全局变量 / MutationObserver 记录完全一致（主世界零残留）", domBefore === domAfter, { domBefore, domAfter });
  const pb = bitmapOf(plain);
  const ab = bitmapOf(ann);
  let diff = 0;
  for (let i = 0; i < pb.length; i += 4) if (pb[i] !== ab[i] || pb[i + 1] !== ab[i + 1] || pb[i + 2] !== ab[i + 2]) diff++;
  check("annotate-pixels", "标注后的截图与未标注的不同（有 ≥200 个像素变化）、尺寸相同", diff >= 200 && plain.width === ann.width && plain.height === ann.height, { diff, w: ann.width });
  check("annotate-ref-table", "annotate 不污染 ref 表（refTable.last 不变）", sess.activeTab.refTable.last === lastRefBefore, { before: lastRefBefore, after: sess.activeTab.refTable.last });
  const annJpeg = await call("screenshot", { annotate: true });
  check("annotate-jpeg", "annotate + 默认 jpeg：返回 jpeg 文件头", kit.readImageSize(buf(annJpeg))?.format === "jpeg" && annJpeg.mimeType === "image/jpeg");
  const annBad = await tryCall("screenshot", { annotate: true, fullPage: true });
  check("annotate-fullpage-rejected", "annotate + full_page → BAD_ARGS", !annBad.ok && annBad.code === "BAD_ARGS", annBad.message);

  // 敏感字段：密码框的值不会进结果（legend / 元数据），页面里仍是 password 类型（浏览器自己的圆点遮罩不被动过）
  const meta = JSON.stringify({ ...ann, dataBase64: undefined });
  const pwType = await ev("document.getElementById('pw').type");
  check("annotate-secret", "密码框：结果里不含密码值，且 input 仍是 type=password（遮罩渲染未被动过）", !meta.includes("supersecret123") && pwType === "password", { pwType });

  // ═══════════ C3 滚动 ═══════════
  await call("scroll", { direction: "top" });
  const snap2 = await call("snapshot", {});
  const bottomRef = refOf(snap2.text, "底部按钮");
  const siv = await call("scroll", { ref: bottomRef, scrollIntoView: true });
  await sleep(200);
  const rect = JSON.parse(await ev("JSON.stringify((function(){var r=document.getElementById('bottom').getBoundingClientRect();return {t:r.top,b:r.bottom,h:innerHeight}})())"));
  check("siv-visible", "scroll_into_view：页面最底部元素进入视口，且大致居中", rect.t >= 0 && rect.b <= rect.h && Math.abs((rect.t + rect.b) / 2 - rect.h / 2) < rect.h * 0.25, rect);
  check("siv-result", "结果带 scroll 位置", siv.scroll && siv.scroll.y > 3000, siv.scroll);

  const hidRef = refOf(snap2.text, "会被隐藏");
  await ev("document.getElementById('hid').style.display = 'none'");
  const hidden = await tryCall("scroll", { ref: hidRef, scrollIntoView: true });
  check("siv-hidden", "元素被隐藏后 scroll_into_view：沿用 NOT_INTERACTABLE / REF_STALE（不假装成功）", !hidden.ok && ["NOT_INTERACTABLE", "REF_STALE"].includes(hidden.code), hidden);
  const sivBad = await tryCall("scroll", { scrollIntoView: true });
  check("siv-no-ref", "scroll_into_view 没有 ref → BAD_ARGS", !sivBad.ok && sivBad.code === "BAD_ARGS");

  // until_stable：有限无限滚动页（追加 3 次后不再增长）
  await call("navigate", { url: `${base}/infinite` });
  const us = await call("scroll", { untilStable: { maxSteps: 12, stepTimeoutMs: 1500 } });
  const count = await ev("window.__count");
  check("us-stable", "until_stable：停在稳定点（reason=stable，追加了 3 次，高度增长，已在底部）", us.untilStable.reason === "stable" && count === 3 && us.untilStable.heightAfter > us.untilStable.heightBefore && us.untilStable.atBottom === true, us.untilStable);
  check("us-steps", "步数 = 3 轮增长 + 2 轮稳定（4–6 步容忍调度抖动）", us.untilStable.steps >= 4 && us.untilStable.steps <= 6, us.untilStable.steps);

  // 步数上限：永远在增长
  await call("navigate", { url: `${base}/forever` });
  const cap = await call("scroll", { untilStable: { maxSteps: 3, stepTimeoutMs: 1000 } });
  check("us-max-steps", "永远在增长：到 max_steps=3 就停（reason=max_steps，steps=3）", cap.untilStable.reason === "max_steps" && cap.untilStable.steps === 3, cap.untilStable);

  // 取消：signal 中止后在 ~1 个轮询间隔内退出，而不是跑完 30 步 × 5s
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(Object.assign(new Error("cancelled by test"), { code: "CANCELLED" })), 800);
  const aborted = await tryCall("scroll", { untilStable: { maxSteps: 30, stepTimeoutMs: 5000 } }, ac.signal);
  const abortMs = Date.now() - t0;
  check("us-abort", "signal 中止：until_stable 迅速结束（<3s）并报错", !aborted.ok && abortMs < 3000, { abortMs, code: aborted.code });

  // 接管打断：用户接管后 AI 的滚动被拒（USER_CONTROL），不会继续滚
  await call("navigate", { url: `${base}/forever` });
  const usLong = call("scroll", { untilStable: { maxSteps: 30, stepTimeoutMs: 5000 } }).then(
    (v) => ({ ok: true, value: v }),
    (e) => ({ ok: false, code: e?.code }),
  );
  await sleep(600);
  manager.getSession(T).takeover?.();
  const tk0 = Date.now();
  const usRes = await usLong;
  check("us-takeover", "用户接管：进行中的 until_stable 被打断（<3s）", !usRes.ok && Date.now() - tk0 < 3000, usRes);

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
