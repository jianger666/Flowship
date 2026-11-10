"use strict";
/**
 * E2·P9 / B7 录制（真 Electron + 真 CDP）：start → 页面动画 / 导航 / AI 动作 → stop，真实 jpeg 帧、权限、timeline 标记、
 * 密码框可见时暂停写帧（像素断言：lime 色块 = 输入框背景）、到限自动停、mp4（有 / 无 ffmpeg 两条路径）、export_activity 脱敏、会话销毁收尾。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p9-record.cjs --timeout 150
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动；临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；
 * 不碰 Flowship / FlowshipTest 与 8676/8776/8876。到限用 createBrowserManager({ recordLimits }) 注入调小的时长上限，不真跑 600 帧 / 60 秒。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-p9-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const info = (id, name, detail) => console.log(`SMOKE INFO ${id} ${name} ${JSON.stringify(detail)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面：持续动画（保证有帧）+ 一个洋红色对照块（证明解码 / 像素统计可用）+ 一个 lime 背景的大输入框（先是 text，后改成 password，再隐藏）
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>P9</title><style>
body{margin:0;font:16px sans-serif;background:#fff}
#anim{width:200px;height:40px;animation:blink .25s infinite alternate}
@keyframes blink{from{background:#333}to{background:#889}}
#ctl{width:120px;height:60px;background:#ff00ff}
#f{display:block;width:300px;height:70px;background:#00ff00;border:0;font-size:28px}
</style></head><body>
<input id="f" type="text" value="">
<div id="anim"></div><div id="ctl"></div>
<button id="b" onclick="window.__c=(window.__c||0)+1">点我</button>
<div style="height:2500px">长内容</div>
</body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

/** 解码 jpeg → 统计 lime（#00ff00）与洋红（#ff00ff）像素数；两个颜色在 BGRA / RGBA 下都与通道顺序无关 */
const colorStats = (file) => {
  const img = nativeImage.createFromBuffer(fs.readFileSync(file));
  const { width, height } = img.getSize();
  if (!width || !height) return { lime: -1, magenta: -1, width, height };
  const bmp = img.toBitmap();
  let lime = 0;
  let magenta = 0;
  for (let i = 0; i + 3 < bmp.length; i += 8) {
    const a = bmp[i];
    const b = bmp[i + 1];
    const c = bmp[i + 2];
    // 阈值放宽：macOS 屏幕录制的帧带显示色彩空间（P3），纯 #00ff00 会变成约 (117,251,76)；R / B 对称，所以与 BGRA / RGBA 顺序无关
    if (b > 200 && a < 150 && c < 150 && b - a > 90 && b - c > 90) lime += 1;
    else if (a > 190 && c > 190 && b < 110) magenta += 1;
  }
  const o = (20 * width + 20) * 4;
  return { lime, magenta, width, height, px: [bmp[o + 2], bmp[o + 1], bmp[o]] };
};

const main = async () => {
  await app.whenReady();
  const { server, base } = await startFixture();
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
    // 只缩时长上限（到限自动停的真机路径）；帧数 / 体积上限的到限由 start 的 max_frames 与单测覆盖
    recordLimits: { maxMs: 9000 },
  });
  manager.onConfig({ evaluateEnabled: true });

  const T = "p9-task";
  const root = path.join(TMP, "data", "tasks", T, "browser-recordings");
  const exportsDir = path.join(TMP, "data", "tasks", T, "browser-exports");
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const rec = (args) => call("record", args);
  const tryRec = async (args) => {
    try {
      return { ok: true, value: await rec(args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  };
  const ev = async (expr) => (await call("evaluate", { expression: expr })).value;
  const unix = process.platform !== "win32";
  const modeOf = (p) => fs.statSync(p).mode & 0o777;

  // ═══════════ 参数 / 前置 ═══════════
  await call("navigate", { url: `${base}/?token=URLSECRET9876543210` });
  await sleep(800);
  info("page-probe", "输入框样式 / 位置 / 视口", await ev("var f=document.getElementById('f'); var r=f.getBoundingClientRect(); JSON.stringify({bg:getComputedStyle(f).backgroundColor, r:[r.left,r.top,r.width,r.height], iw:innerWidth, ih:innerHeight, dpr:devicePixelRatio})"));
  const noStop = await tryRec({ action: "stop" });
  check("stop-none", "没有进行中的录制时 stop → BAD_ARGS", !noStop.ok && noStop.code === "BAD_ARGS", noStop.message);
  const noExport = await tryRec({ action: "export" });
  check("export-none", "还没有录制时 export → BAD_ARGS", !noExport.ok && noExport.code === "BAD_ARGS", noExport.message);
  const gif = await tryRec({ action: "export", format: "gif" });
  check("export-gif", "gif → UNSUPPORTED（并提示 frames / mp4）", !gif.ok && gif.code === "UNSUPPORTED" && /frames/.test(gif.message), gif.message);
  const trav = await tryRec({ action: "export", recId: "../../../etc/passwd" });
  check("export-traversal", "rec_id 路径穿越 → BAD_ARGS（不碰文件系统）", !trav.ok && trav.code === "BAD_ARGS", trav.message);
  const noop = await tryRec({ action: "rm -rf" });
  check("action-enum", "非法 action → BAD_ARGS", !noop.ok && noop.code === "BAD_ARGS", noop.message);

  // ═══════════ 主录制：动画 + 导航 + AI 动作 + 密码框 ═══════════
  const start = await rec({ action: "start", everyNth: 2 });
  check("start", "start 成功：recId 形状 / 上限 / 目录路径", /^rec-\d{8}-\d{6}-[0-9a-f]{6}$/.test(start.recId) && start.maxSeconds === 9 && start.dir === path.join(root, start.recId), { recId: start.recId, maxSeconds: start.maxSeconds });
  if (unix) check("dir-mode", "录制目录 0700（含 browser-recordings 根）", modeOf(start.dir) === 0o700 && modeOf(root) === 0o700, { dir: modeOf(start.dir).toString(8), root: modeOf(root).toString(8) });
  const dup = await tryRec({ action: "start" });
  check("mutex", "同会话再 start → BAD_ARGS（互斥）", !dup.ok && dup.code === "BAD_ARGS", dup.message);
  const stateBar = manager.getState ? manager.getState(T) : null;
  if (stateBar) check("state-bar", "状态贡献者：recording:{frames,startedAt}", !!stateBar.recording && Number.isFinite(stateBar.recording.startedAt), stateBar.recording);
  else info("state-bar", "manager 没有 getState，跳过", {});

  // 阶段 A：text 型 lime 输入框可见 + 动画 + 导航 + AI 动作
  await sleep(500);
  await call("navigate", { url: `${base}/?page=2` });
  await sleep(500);
  await call("scroll", { direction: "down", amount: 200 }).catch((e) => info("scroll", "scroll 失败（不影响主断言）", { m: e?.message }));
  await sleep(300);
  await ev("window.scrollTo(0,0); 1"); // 滚回顶部：lime 输入框与洋红块要回到视口里，后面的像素对照才有意义
  await sleep(500);
  const stA = await rec({ action: "status" });
  check("frames-flow", "动画页面在录制中持续出帧", stA.recording && stA.recording.frames >= 3, stA.recording);

  // 阶段 B：lime 输入框变成密码框并输入内容 → 应该暂停写帧
  // R6-04：evaluate 的表达式开头（脱敏后）会进活动日志 / timeline，所以密码字面量拆开拼，别让「夹具里的假口令」出现在 AI 写的脚本源码里
  await ev("var f=document.getElementById('f'); f.type='password'; f.value=['hunter'+2,'TOP'+'SECRET'].join('-'); f.focus(); 1");
  await sleep(500);
  const b1 = (await rec({ action: "status" })).recording;
  await sleep(1200);
  const b2 = (await rec({ action: "status" })).recording;
  check("gap-pause", "密码框可见 + 聚焦期间帧数不增长（暂停写帧）", b2 && b1 && b2.frames === b1.frames && b2.redactedGaps >= 1, { b1: b1?.frames, b2: b2?.frames, gaps: b2?.redactedGaps });

  // 阶段 B2：密码框换进 closed shadow root 里并聚焦（页内探针只认 open root；靠 closed-shadow.mjs 的 CDP 复核才挡得住）→ 仍应暂停写帧
  await ev(
    "document.getElementById('f').style.display='none'; document.activeElement && document.activeElement.blur(); " +
      "var h=document.createElement('div'); h.id='ch'; document.body.insertBefore(h, document.body.firstChild); " +
      "var r=h.attachShadow({mode:'closed'}); var i=document.createElement('input'); i.type='password'; " +
      "i.style.cssText='display:block;width:300px;height:70px;background:#00ff00;border:0;font-size:28px'; r.appendChild(i); i.focus(); i.value='closed-hunter-SECRET'; 1",
  );
  await sleep(600);
  const bs1 = (await rec({ action: "status" })).recording;
  await sleep(1500);
  const bs2 = (await rec({ action: "status" })).recording;
  check("gap-closed-shadow", "closed shadow root 里的密码框聚焦期间帧数不增长（CDP 复核生效）", bs2 && bs1 && bs2.frames === bs1.frames, { b1: bs1?.frames, b2: bs2?.frames, gaps: bs2?.redactedGaps });

  // 阶段 C：密码框隐藏 → 恢复写帧
  await ev("var ch=document.getElementById('ch'); if (ch) ch.remove(); document.getElementById('f').style.display='none'; document.activeElement && document.activeElement.blur(); 1");
  await sleep(1000);
  const c1 = (await rec({ action: "status" })).recording;
  check("gap-resume", "密码框消失后恢复写帧", c1 && b2 && c1.frames > b2.frames, { before: b2?.frames, after: c1?.frames });

  const stop = await rec({ action: "stop" });
  check("stop", "stop 返回摘要：帧数 / 时长 / 总大小 / 标记数 / 目录", stop.action === "stop" && stop.frames >= 6 && stop.durationMs > 2000 && stop.totalBytes > 0 && stop.markerCount > 0 && stop.dir === start.dir, {
    frames: stop.frames,
    ms: stop.durationMs,
    bytes: stop.totalBytes,
    markers: stop.markerCount,
    counts: stop.markerCounts,
    reason: stop.stopReason,
  });
  check("stop-twice", "再 stop → BAD_ARGS（结果只能取一次）", (await tryRec({ action: "stop" })).code === "BAD_ARGS");

  // 帧文件：真实 jpeg（魔数）、0600、连续编号、没有 .tmp
  const names = fs.readdirSync(stop.dir).sort();
  const jpgs = names.filter((n) => /^frame-\d{4}\.jpg$/.test(n));
  const magicOk = jpgs.every((n) => {
    const b = fs.readFileSync(path.join(stop.dir, n));
    return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b.length > 500;
  });
  check("jpeg-magic", "N 帧全是真实 jpeg（FF D8 FF）且连续编号", jpgs.length === stop.frames && magicOk && jpgs.every((n, i) => n === `frame-${String(i + 1).padStart(4, "0")}.jpg`), { n: jpgs.length });
  check("no-tmp", "目录里没有 .tmp 残留，且有 timeline.json", !names.some((n) => n.endsWith(".tmp")) && names.includes("timeline.json"), names.slice(-3));
  if (unix) check("file-mode", "帧与 timeline.json 均为 0600", names.every((n) => modeOf(path.join(stop.dir, n)) === 0o600), names.map((n) => `${n}:${modeOf(path.join(stop.dir, n)).toString(8)}`).slice(0, 3));

  // timeline：导航 / AI 动作 / redacted-gap
  const tl = JSON.parse(fs.readFileSync(stop.timelineFile, "utf8"));
  const types = tl.markers.map((m) => m.type);
  check("tl-nav", "timeline 含导航标记", types.includes("navigation"), types);
  check("tl-ai", "timeline 含 AI 动作标记", types.includes("ai-action"), types);
  const gap = tl.markers.find((m) => m.type === "redacted-gap");
  check("tl-gap", "timeline 含 redacted-gap 段（有起止、跳过帧数）", !!gap && gap.endT >= gap.t && stop.redactedFrames >= 2, { gap: gap && { t: gap.t, endT: gap.endT }, skipped: stop.redactedFrames });
  check("tl-order", "markers 按时间排序、frames 的 t 单调", tl.markers.every((m, i, a) => i === 0 || a[i - 1].t <= m.t) && tl.frames.every((f, i, a) => i === 0 || a[i - 1].t <= f.t));
  const tlText = JSON.stringify(tl);
  const leakCtx = (text, needles) => needles.filter((n) => text.includes(n)).map((n) => text.slice(Math.max(0, text.indexOf(n) - 80), text.indexOf(n) + 60));
  check("tl-redact", "timeline 里没有密码内容 / URL 查询串令牌", !tlText.includes("hunter2") && !tlText.includes("TOPSECRET") && !tlText.includes("URLSECRET9876543210"), leakCtx(tlText, ["hunter2", "TOPSECRET", "URLSECRET9876543210"]));

  // 像素断言：gap 之前的帧里能看见 lime 输入框与洋红对照块（证明解码可用）；gap 起始之后写盘的帧里一个 lime 像素都没有
  const stats = tl.frames.map((f) => ({ ...f, ...colorStats(path.join(stop.dir, f.file)) }));
  info("frame-size", "首帧尺寸 / 颜色统计", stats[0] && { w: stats[0].width, h: stats[0].height, lime: stats[0].lime, magenta: stats[0].magenta, px: stats[0].px });
  // 暂停开始时刻 gap.t 之前的帧（输入框还是 text 型）→ 对照；gap 结束之后的帧（密码框已隐藏）→ 一个 lime 像素都不该有；
  // gap 区间内（gap.t, gap.endT]：根本不该有帧写盘。gap.t 当刻的边界帧是「抓取早于变成密码框」的帧（探针晚于抓取），内容是空的 text 框，不计入
  const before = stats.filter((s) => gap && s.t < gap.t);
  const inside = stats.filter((s) => gap && s.t > gap.t && s.t <= gap.endT);
  const after = stats.filter((s) => gap && s.t > gap.endT);
  const scrolledAway = before.filter((s) => s.lime <= 5).length;
  check("px-control", "对照：暂停之前有相当一部分帧里能看到 lime 输入框与洋红块（解码 / 统计可用）", before.length >= 2 && before.filter((s) => s.lime > 300).length >= 3 && before.some((s) => s.magenta > 100), { n: before.length, withLime: before.length - scrolledAway, lime: before.map((s) => s.lime).slice(0, 4), magenta: before.map((s) => s.magenta).slice(0, 4) });
  check("px-masked", "暂停区间内没有任何帧写盘；之后（输入框已隐藏）写盘的帧里没有任何 lime 像素", inside.length === 0 && after.length >= 1 && after.every((s) => s.lime <= 5), { inside: inside.length, after: after.length, lime: after.map((s) => s.lime).slice(0, 8) });

  // ═══════════ export ═══════════
  const exFrames = await rec({ action: "export", format: "frames" });
  check("export-frames", "export frames：目录 + timeline.json + 摘要", exFrames.dir === stop.dir && fs.existsSync(exFrames.timelineFile) && exFrames.frames === stop.frames, { dir: exFrames.dir });

  let ffmpegPath = "";
  try {
    ffmpegPath = execFileSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  } catch {
    ffmpegPath = "";
  }
  if (ffmpegPath) {
    const mp4 = await tryRec({ action: "export", format: "mp4" });
    const mp4Path = mp4.ok ? mp4.value.path : "";
    const head = mp4Path && fs.existsSync(mp4Path) ? fs.readFileSync(mp4Path).subarray(4, 8).toString("latin1") : "";
    check("mp4", "本机有 ffmpeg：mp4 产出 ftyp 文件、0600、无 tmp 残留", mp4.ok && head === "ftyp" && (!unix || modeOf(mp4Path) === 0o600) && !fs.readdirSync(stop.dir).some((n) => n.includes(".tmp.")), mp4.ok ? { bytes: mp4.value.bytes, fps: mp4.value.fps } : mp4);
  } else {
    info("mp4", "本机没有 ffmpeg，跳过「有 ffmpeg」路径", {});
  }
  const oldPath = process.env.PATH;
  process.env.PATH = "";
  const noFf = await tryRec({ action: "export", format: "mp4" });
  process.env.PATH = oldPath;
  check("mp4-unsupported", "PATH 为空（模拟没有 ffmpeg）：mp4 → UNSUPPORTED 并提示 frames", !noFf.ok && noFf.code === "UNSUPPORTED" && /frames/.test(noFf.message), noFf.message);

  // ═══════════ 到限自动停 ═══════════
  await ev("var f=document.getElementById('f'); f.style.display='block'; f.type='text'; f.value=''; 1");
  await sleep(200);
  await rec({ action: "start", everyNth: 1, maxFrames: 4 });
  await sleep(1500);
  const autoFrames = await rec({ action: "stop" });
  check("limit-frames", "到帧数上限（max_frames=4）自动停，stop 取回结果并说明原因", autoFrames.frames === 4 && autoFrames.stopReason === "max_frames" && autoFrames.auto === true && /帧数上限/.test(autoFrames.stopReasonText), { frames: autoFrames.frames, reason: autoFrames.stopReason });

  await rec({ action: "start", everyNth: 6 });
  const t0 = Date.now();
  // 注入的时长上限 9s：不调用 stop，等它自己到点
  await sleep(9800);
  const st = await rec({ action: "status" });
  const autoMs = await rec({ action: "stop" });
  check("limit-duration", "到时长上限（注入 9s）自动停：状态已清空、stop 取回结果 max_duration", st.recording === null && autoMs.stopReason === "max_duration" && autoMs.auto === true && Date.now() - t0 >= 9000, { reason: autoMs.stopReason, frames: autoMs.frames });

  // ═══════════ export_activity ═══════════
  const act = await rec({ action: "export_activity", format: "json" });
  // R6-34：结果不再带绝对路径（只有 file + 子目录名 dir）；脚本用已知的 exportsDir 拼出真实路径来验文件
  const actPath = path.join(exportsDir, act.file);
  const actText = fs.readFileSync(actPath, "utf8");
  let actJson = null;
  try {
    actJson = JSON.parse(actText);
  } catch {
    actJson = null;
  }
  check("act-json", "export_activity json：合法、条目数 > 0、含 AI 与系统条目", !!actJson && actJson.entries.length > 0 && actJson.entries.some((e) => e.actor === "ai") && act.path === undefined && act.dir === "browser-exports" && /^activity-\d{8}-\d{6}(-\d+)?\.json$/.test(act.file) && !JSON.stringify(act).includes(TMP) && !actText.includes(TMP), { entries: act.entries, file: act.file, dir: act.dir });
  check("act-redact", "活动日志导出里没有 URL 查询串令牌 / 密码内容", !actText.includes("URLSECRET9876543210") && !actText.includes("hunter2"), leakCtx(actText, ["URLSECRET9876543210", "hunter2"]));
  if (unix) check("act-mode", "导出文件 0600、目录 0700", modeOf(actPath) === 0o600 && modeOf(exportsDir) === 0o700, { file: modeOf(actPath).toString(8), dir: modeOf(exportsDir).toString(8) });
  const actMd = await rec({ action: "export_activity", format: "markdown" });
  const mdPath = path.join(exportsDir, actMd.file);
  const mdText = fs.readFileSync(mdPath, "utf8");
  check("act-md", "export_activity markdown：.md、有标题、同样脱敏", mdPath.endsWith(".md") && mdText.includes("浏览器活动日志") && !mdText.includes("URLSECRET9876543210"), { bytes: actMd.bytes });

  // ═══════════ 会话销毁收尾 ═══════════
  const before2 = fs.readdirSync(root).sort();
  const s3 = await rec({ action: "start", everyNth: 2 });
  await sleep(600);
  await call("close_session");
  await sleep(300);
  const dirNames = fs.existsSync(s3.dir) ? fs.readdirSync(s3.dir) : [];
  let closedTl = null;
  try {
    closedTl = JSON.parse(fs.readFileSync(path.join(s3.dir, "timeline.json"), "utf8"));
  } catch {
    closedTl = null;
  }
  check("destroy", "录制中 close_session：写完 timeline（session_closed）、无 .tmp 残留、新会话状态干净", !!closedTl && closedTl.stopReason === "session_closed" && !dirNames.some((n) => n.endsWith(".tmp")) && fs.readdirSync(root).length === before2.length + 1, { reason: closedTl?.stopReason, frames: closedTl?.frames?.length });
  await call("navigate", { url: `${base}/` });
  const again = await tryRec({ action: "start" });
  check("destroy-restart", "销毁后的新会话可以重新 start（旧状态没有残留）", again.ok === true, again.ok ? { recId: again.value.recId } : again);
  await rec({ action: "stop" }).catch(() => {});

  // 目录名都是主进程生成的 recId（没有路径穿越）
  check("dirs-clean", "browser-recordings 下只有 recId 目录", fs.readdirSync(root).every((n) => /^rec-\d{8}-\d{6}-[0-9a-f]{6}$/.test(n)), fs.readdirSync(root));

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
