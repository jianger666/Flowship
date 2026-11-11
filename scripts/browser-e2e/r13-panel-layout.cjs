"use strict";
/**
 * R13 回归（真 Electron + 真 BrowserPanel + 真 Tailwind + 真 react-resizable-panels + 真鼠标）：内置浏览器面板的真实排版（R9-05 / R9-06）。
 *
 * 背景：此前没有任何自动化钉着真实排版——单测只能测纯函数，r9-chat-split-cover 的 harness 把 BrowserPanel 换成了桩。
 * reviewer 手搭的一次性 harness 量出了两类问题，这里把它沉进仓库：
 *   R9-05  设备模拟标签（含「适应 xx%」）原先挤在工具栏同一行，和地址栏抢宽度：聊天页默认宽度（428px）地址栏被压到 22px，
 *          任务页最小窗口下「更多 / 放大 / 关闭」被挤出面板（点不到）、面板还多出一条横向滚动条。现在模拟标签独占一行（模拟条），
 *          窄于 360px 时缩放标签让位、间距收紧，工具栏自己 overflow-hidden 兜底。
 *   R9-06  分栏抓手（w-4）比分隔条本体（w-1.5）宽，伸进浏览器那一侧的 5px 被原生视图盖住（原生视图永远盖在 HTML 之上）。
 *          现在抓手宽度收进分隔条。侧栏手柄压在浏览器占位上的部分**没改**（见下面 INFO），理由写在 REVIEW 文档 R9-06 的「处理」栏。
 *
 * 做法：用 vite 把**真的** BrowserPanel + ResizablePanelGroup / ResizableHandle + SidebarResizeHandle 打成页面
 * （panel-layout-harness/，`window.__browser` 换成桩），放进无头 Electron 窗口读真实布局像素、发真鼠标拖分隔条。
 * vite 来自 vitest 的依赖（不是项目直接依赖），脚本自己定位、以 ELECTRON_RUN_AS_NODE 起子进程打包到临时目录——不往仓库里写产物。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r13-panel-layout.cjs --timeout 170
 *
 * 临时 userData / 临时打包目录、窗口 show:false；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 * 局限：没有真原生视图（无头环境做不了「原生视图盖在 HTML 之上」的真实命中测试），只量几何相交；字体是本机系统字体。
 */
const { app, BrowserWindow } = require("electron");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REPO = path.resolve(__dirname, "..", "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-r13-layout-"));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 360)}` : ""}`);
};
const info = (id, detail) => console.log(`SMOKE INFO ${id} ${JSON.stringify(detail).slice(0, 500)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 3) => typeof a === "number" && Math.abs(a - b) <= tol;

const HTML = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="harness.css"><body style="margin:0"><div id="root"></div><script src="harness.js"></script>`;

/** 打包 harness 到临时目录，返回 index.html 的 file URL */
const buildHarness = () => {
  const req = createRequire(require.resolve("vitest/package.json", { paths: [REPO] }));
  let viteDir;
  try {
    viteDir = path.dirname(req.resolve("vite/package.json"));
  } catch {
    // 个别版本不导出 package.json：从入口往上找名为 vite 的包根
    let d = path.dirname(req.resolve("vite"));
    while (d !== path.dirname(d)) {
      try {
        if (JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).name === "vite") break;
      } catch {}
      d = path.dirname(d);
    }
    viteDir = d;
  }
  const out = path.join(TMP, "harness");
  const r = spawnSync(
    process.execPath,
    [path.join(viteDir, "bin", "vite.js"), "build", "--config", path.join(__dirname, "panel-layout-harness", "vite.config.mjs"), "--outDir", out],
    { cwd: REPO, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 120_000 },
  );
  if (r.status !== 0 || !fs.existsSync(path.join(out, "harness.js")) || !fs.existsSync(path.join(out, "harness.css"))) {
    throw new Error(`harness 打包失败（exit ${r.status}）：${(r.stderr || r.stdout || "").slice(-800)}`);
  }
  fs.writeFileSync(path.join(out, "index.html"), HTML);
  return pathToFileURL(path.join(out, "index.html")).href;
};

let PAGE = "";
const open = async (query, size = [1400, 800]) => {
  const win = new BrowserWindow({ show: false, width: size[0], height: size[1], useContentSize: true, webPreferences: { sandbox: true } });
  win.webContents.on("console-message", (...args) => {
    // 新旧两种签名都兼容：老的 (event, level, message)，新的 (event 对象)
    const e = args[0];
    const level = typeof args[1] === "number" ? args[1] : e?.level;
    const msg = typeof args[2] === "string" ? args[2] : e?.message;
    if ((level === 3 || level === "error") && !/Electron Security Warning/.test(String(msg))) console.log("  [page-console]", String(msg).slice(0, 300));
  });
  await win.loadURL(`${PAGE}?${query}`);
  await win.webContents.executeJavaScript(`new Promise((r) => { const t0 = Date.now(); const f = () => document.querySelector('[data-slot="browser-toolbar"]') || Date.now() - t0 > 3000 ? r(true) : setTimeout(f, 30); f(); })`, true);
  await sleep(350);
  const ex = (js) => win.webContents.executeJavaScript(js, true);
  const drag = async (fromX, fromY, toX, toY, steps = 12) => {
    const wc = win.webContents;
    wc.sendInputEvent({ type: "mouseMove", x: fromX, y: fromY });
    await sleep(30);
    wc.sendInputEvent({ type: "mouseDown", x: fromX, y: fromY, button: "left", clickCount: 1, modifiers: ["leftButtonDown"] });
    for (let i = 1; i <= steps; i++) {
      wc.sendInputEvent({
        type: "mouseMove",
        x: Math.round(fromX + ((toX - fromX) * i) / steps),
        y: Math.round(fromY + ((toY - fromY) * i) / steps),
        button: "left",
        modifiers: ["leftButtonDown"],
      });
      await sleep(16);
    }
    wc.sendInputEvent({ type: "mouseUp", x: toX, y: toY, button: "left", clickCount: 1 });
    await sleep(250);
  };
  return { win, ex, drag };
};

/** 一次性打开 → 取值 → 关窗 */
const probe = async (query, js, size) => {
  const c = await open(query, size);
  try {
    return await c.ex(js);
  } finally {
    c.win.close();
  }
};

// ───────── 页内量测脚本 ─────────
const LABEL = `(k) => k.getAttribute('aria-label') || k.textContent.trim().slice(0, 12) || k.tagName`;
/** 工具栏：宽度、被裁掉的宽度（内层 overflow-hidden，scrollWidth − clientWidth）、地址栏宽度、右缘越过工具栏的子项、每个子项是否点得到自己 */
const BAR = `(() => {
  const label = ${LABEL};
  const bar = document.querySelector('[data-slot="browser-toolbar"]');
  const br = bar.getBoundingClientRect();
  const input = bar.querySelector('input');
  const ir = input ? input.getBoundingClientRect() : null;
  const kids = [...bar.children].filter((k) => k.getBoundingClientRect().width > 0 && getComputedStyle(k).position !== 'absolute');
  const cut = kids.filter((k) => k.getBoundingClientRect().right > br.right + 0.5).map(label);
  // disabled 的按钮带 pointer-events-none，本来就点不到（如没有可前进的历史时的「前进」），不算「被盖住」
  const unhit = kids.filter((k) => !k.disabled).filter((k) => {
    const r = k.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.min(r.left + r.width / 2, window.innerWidth - 1), r.top + r.height / 2);
    return !(hit && (k === hit || k.contains(hit)));
  }).map(label);
  return { w: Math.round(br.width), over: bar.scrollWidth - bar.clientWidth, addr: ir ? Math.round(ir.width) : null, cut, unhit };
})()`;
/** 面板里有没有「横向滚动条」：子树里 overflow-x 为 auto / scroll 且内容比自己宽的元素（再加面板自身） */
const HSCROLL = `(() => {
  const panel = document.getElementById('artifact') || document.getElementById('chat-browser') || document.getElementById('box');
  const bad = [];
  for (const e of [panel, ...panel.querySelectorAll('*')]) {
    const cs = getComputedStyle(e);
    if (e.clientWidth > 0 && (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 0.5) bad.push((e.getAttribute('data-slot') || e.className || e.tagName).toString().slice(0, 40));
  }
  return { panelW: Math.round(panel.getBoundingClientRect().width), scrollOver: panel.scrollWidth - panel.clientWidth, bad };
})()`;
/** 模拟条：是不是独立一行（在工具栏下面、不在工具栏里）、摘要是否被截、「适应 xx%」徽标是否完整可见、重置钮是否在条内 */
const EMU = `(() => {
  const e = document.querySelector('[data-slot="browser-emulation-bar"]');
  if (!e) return null;
  const tb = document.querySelector('[data-slot="browser-toolbar"]');
  const er = e.getBoundingClientRect(), tr = tb.getBoundingClientRect();
  const label = e.querySelector('.truncate');
  const fit = [...e.querySelectorAll('span')].find((s) => /^适应 \\d+%$/.test(s.textContent.trim()));
  const fr = fit ? fit.getBoundingClientRect() : null;
  const reset = e.querySelector('button[aria-label="重置设备模拟"]');
  const rr = reset ? reset.getBoundingClientRect() : null;
  return {
    separateRow: er.top >= tr.bottom - 0.5 && !tb.contains(e),
    h: Math.round(er.height), w: Math.round(er.width),
    labelClipped: !!label && label.scrollWidth > label.clientWidth,
    fitText: fit ? fit.textContent.trim() : null,
    fitVisible: !!fr && fr.width > 0 && fr.right <= er.right + 0.5 && fit.scrollWidth <= fit.clientWidth,
    resetInside: !!rr && rr.right <= er.right + 0.5 && rr.left >= er.left - 0.5,
  };
})()`;
const ZOOM_VISIBLE = `(() => { const b = document.querySelector('button[aria-label^="缩放"]'); return !!b && b.getBoundingClientRect().width > 0; })()`;
/** 分隔条 / 抓手 / 侧栏手柄与浏览器视口占位的几何相交（宽高都 > 0 才算被原生视图盖住） */
const GEO = `(() => {
  const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const vp = R(document.querySelector('[data-browser-viewport]'));
  const sepEl = document.querySelector('[data-separator]');
  const grip = R(sepEl && sepEl.querySelector('[data-slot="resize-grip"]'));
  const sep = R(sepEl);
  const sb = R(document.querySelector('[role=separator][aria-label^="调整侧栏"]'));
  const over = (a, b) => { if (!a || !b) return null; const w = Math.min(a.r, b.r) - Math.max(a.l, b.l); const h = Math.min(a.b, b.b) - Math.max(a.t, b.t); return w > 0.5 && h > 0.5 ? { w: +w.toFixed(1), h: +h.toFixed(1) } : 0; };
  return { gripW: grip && +grip.w.toFixed(1), sepW: sep && +sep.w.toFixed(1), gripOverVp: over(grip, vp), sepOverVp: over(sep, vp), sbOverVp: over(sb, vp),
    sep: sep && { x: Math.round(sep.l + sep.w / 2), y: Math.round(sep.t + sep.h / 2) },
    gripCenter: grip && { x: Math.round(grip.l + grip.w / 2), y: Math.round(grip.t + grip.h / 2) } };
})()`;
const WIDTHS = `(() => { const r = (id) => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().width * 10) / 10 : null; }; return { chat: r('chat-main'), browser: r('chat-browser'), artifact: r('artifact') }; })()`;

const emuQ = (label, fit, extra = "") => `emu=${encodeURIComponent(label)}${fit ? `&fit=${fit}` : ""}${extra}`;
const EMU_FIT = emuQ("Desktop 1440", 0.4);

const run = async () => {
  PAGE = buildHarness();
  let c;

  // ═══════════ R9-05：设备模拟标签不再和地址栏抢工具栏宽度 ═══════════

  // 聊天页默认窗口 1280×800、侧栏 256、浏览器默认 42%（428px）：以前 `Desktop 1440 · 适应 40%` 把地址栏压到 22px
  c = await open(`mode=chat&w=1280&h=700&sidebar=256&bp=42&${EMU_FIT}`);
  const chatBar = await c.ex(BAR);
  const chatEmu = await c.ex(EMU);
  const chatScroll = await c.ex(HSCROLL);
  c.win.close();
  const chatPlain = await probe("mode=chat&w=1280&h=700&sidebar=256&bp=42", BAR);
  check("r13-01", "聊天页默认宽度（428px）+ 设备模拟 + 「适应 40%」：地址栏 ≥ 100px、工具栏不溢出、没有按钮被挤出、面板无横向滚动条", near(chatScroll.panelW, 428, 2) && chatBar.addr >= 100 && chatBar.over === 0 && chatBar.cut.length === 0 && chatBar.unhit.length === 0 && chatScroll.scrollOver === 0 && chatScroll.bad.length === 0, { chatBar, chatScroll });
  check("r13-02", "模拟标签是独立一行（在工具栏下方、不在工具栏里），带完整的「适应 40%」徽标和重置钮", !!chatEmu && chatEmu.separateRow && chatEmu.fitText === "适应 40%" && chatEmu.fitVisible && chatEmu.resetInside && chatEmu.h <= 32, chatEmu);
  check("r13-03", "有没有模拟，地址栏一样宽（模拟标签不再占工具栏的宽度）", chatPlain.addr === chatBar.addr, { plain: chatPlain.addr, emulated: chatBar.addr });

  // 任务页最小窗口 960×600、侧栏 256、默认布局（浏览器栏 ≈ 321px）：以前「更多 / 放大 / 关闭」被挤出面板、点不到
  c = await open(`mode=task&w=960&h=700&sidebar=256&art=46&${EMU_FIT}`);
  const taskBar = await c.ex(BAR);
  const taskScroll = await c.ex(HSCROLL);
  c.win.close();
  check("r13-04", "任务页最小窗口（浏览器栏 ≈ 321px）+ 设备模拟 + 「适应 40%」：工具栏不溢出、「更多 / 放大 / 关闭」都在面板内且点得到、面板无横向滚动条", taskBar.over === 0 && taskBar.cut.length === 0 && taskBar.unhit.length === 0 && taskScroll.scrollOver === 0 && taskScroll.bad.length === 0 && taskScroll.panelW >= 300, { taskBar, taskScroll });

  // 聊天页 960 窗口：浏览器栏只有 300px（栏宽下限）
  c = await open(`mode=chat&w=960&h=700&sidebar=256&bp=42&${emuQ("iPad", 0.5)}`);
  const narrowBar = await c.ex(BAR);
  const narrowScroll = await c.ex(HSCROLL);
  c.win.close();
  check("r13-05", "聊天页 960 窗口（浏览器栏 300px）+ iPad + 「适应 50%」：「放大 / 关闭」仍在面板内且点得到，无横向滚动条", near(narrowScroll.panelW, 300, 2) && narrowBar.over === 0 && narrowBar.cut.length === 0 && narrowBar.unhit.length === 0 && narrowScroll.bad.length === 0, { narrowBar, narrowScroll });

  // 最坏组合：栏宽下限 300px + 模拟 + 适应 + 页面缩放 125% + 有下载记录
  const worst = await probe(`mode=toolbar&w=300&h=500&${emuQ("Desktop 1920 · 暗色 · 慢速 3G", 0.35, "&zoom=125&dl=1")}`, `({ bar: ${BAR}, scroll: ${HSCROLL}, zoom: ${ZOOM_VISIBLE} })`);
  check("r13-06", "最坏组合（300px + 模拟 + 适应 + 缩放 125% + 有下载）：工具栏不溢出、无按钮被裁、地址栏仍有 ≥ 40px、无横向滚动条", worst.bar.over === 0 && worst.bar.cut.length === 0 && worst.bar.unhit.length === 0 && worst.bar.addr >= 40 && worst.scroll.bad.length === 0, worst);

  // 宽度扫描：4 种组合 × 6 个宽度，工具栏都不溢出、地址栏不小于 40px
  const combos = [
    ["无模拟", ""],
    ["模拟 + 适应", EMU_FIT],
    ["模拟 + 适应 + 缩放 125%", `${EMU_FIT}&zoom=125`],
    ["模拟 + 适应 + 缩放 125% + 下载", `${EMU_FIT}&zoom=125&dl=1`],
  ];
  const sweep = [];
  let sweepOk = true;
  for (const [name, extra] of combos) {
    for (const w of [300, 340, 380, 420, 480, 560]) {
      const m = await probe(`mode=toolbar&w=${w}&h=500&${extra}`, BAR);
      const ok = m.over === 0 && m.cut.length === 0 && m.unhit.length === 0 && m.addr >= 40;
      if (!ok) sweepOk = false;
      sweep.push(`${name}@${w}:${m.addr}${ok ? "" : "!"}`);
    }
  }
  check("r13-07", "宽度扫描（300 ~ 560px × 4 种组合）：工具栏都不溢出、无按钮被裁或被盖、地址栏 ≥ 40px", sweepOk, sweep);

  // 同宽下「有无模拟」地址栏宽度相等（模拟条不占工具栏）——逐个宽度
  let sameOk = true;
  const sameLog = [];
  for (const w of [300, 380, 428, 560]) {
    const a = await probe(`mode=toolbar&w=${w}&h=500`, BAR);
    const b = await probe(`mode=toolbar&w=${w}&h=500&${EMU_FIT}`, BAR);
    if (a.addr !== b.addr) sameOk = false;
    sameLog.push(`${w}:${a.addr}/${b.addr}`);
  }
  check("r13-08", "逐个宽度对比：有模拟与无模拟的地址栏宽度完全相同（plain/emulated）", sameOk, sameLog);

  // 缩放标签：窄于 360px 让位（「更多」菜单里仍有重置缩放）、够宽时显示
  const zNarrow = await probe(`mode=toolbar&w=340&h=500&zoom=125`, ZOOM_VISIBLE);
  const zWide = await probe(`mode=toolbar&w=380&h=500&zoom=125`, ZOOM_VISIBLE);
  check("r13-09", "缩放标签：工具栏窄于 360px 时让位，≥ 360px 时显示", zNarrow === false && zWide === true, { w340: zNarrow, w380: zWide });

  // 长摘要：摘要被截断，但「适应 xx%」徽标不被截
  const longEmu = await probe(`mode=toolbar&w=300&h=500&${emuQ("iPhone 15 · 暗色 · 慢速 3G · 减少动态效果 · 强制颜色", 0.72)}`, `({ emu: ${EMU}, bar: ${BAR} })`);
  check("r13-10", "模拟摘要很长（300px）：摘要被截断，「适应 72%」徽标与重置钮仍完整可见；地址栏宽度不受影响", !!longEmu.emu && longEmu.emu.labelClipped && longEmu.emu.fitText === "适应 72%" && longEmu.emu.fitVisible && longEmu.emu.resetInside && longEmu.bar.addr >= 40, longEmu);

  // 没有模拟：没有模拟条、不多占一行
  const noEmu = await probe(`mode=toolbar&w=428&h=500`, `({ has: !!document.querySelector('[data-slot="browser-emulation-bar"]') })`);
  check("r13-11", "没有设备模拟时不画模拟条（不多占一行）", noEmu.has === false, noEmu);

  // 兜底：比栏宽下限（300px）还窄的极端宽度（真实使用里到不了——分栏有 300px 下限）。放不下的按钮会被裁掉，
  // 但绝不能把面板撑出横向滚动条（工具栏内层 overflow-hidden）；这条钉的就是这道兜底，上面的用例里它从不触发
  const tiny = await probe(`mode=toolbar&w=240&h=500&${EMU_FIT}&zoom=125&dl=1`, `({ bar: ${BAR}, scroll: ${HSCROLL} })`);
  check("r13-15", "兜底：比栏宽下限还窄（240px）时放不下的按钮被裁，但面板不被撑出横向滚动条", tiny.bar.over > 0 && tiny.scroll.scrollOver === 0 && tiny.scroll.bad.length === 0, tiny);

  // ═══════════ R9-06：抓手宽度收进分隔条 ═══════════
  let g;
  c = await open(`mode=task&w=1280&h=700&sidebar=256&art=62.8`);
  g = await c.ex(GEO);
  c.win.close();
  check("r13-12", "任务页（浏览器在左栏）：抓手宽度 ≤ 分隔条本体，与浏览器占位不相交", g.gripW !== null && g.gripW <= g.sepW + 0.01 && g.gripOverVp === 0 && g.sepOverVp === 0, g);
  info("r13-info-sidebar-handle-task", { expanded: g.sbOverVp, note: "侧栏手柄压在任务页浏览器占位上的部分：已知并接受（R9-06 ②，理由见 REVIEW 文档），非浏览器行（工具栏 / 标签条 / 操作记录）仍整条 6px 可抓" });
  const collapsed = await probe(`mode=task&w=1280&h=700&sbopen=0&art=62.8`, GEO);
  info("r13-info-sidebar-handle-collapsed", { overVp: collapsed.sbOverVp });
  c = await open(`mode=chat&w=1280&h=700&sidebar=256&bp=42`);
  g = await c.ex(GEO);
  check("r13-13", "聊天页（浏览器在右栏）：抓手宽度 ≤ 分隔条本体，与浏览器占位不相交；侧栏手柄与浏览器不相交", g.gripW !== null && g.gripW <= g.sepW + 0.01 && g.gripOverVp === 0 && g.sepOverVp === 0 && g.sbOverVp === 0, g);

  // 真鼠标按在抓手中心往左拖 80px：浏览器栏应变宽约 80px（抓手是分隔条的子元素，事件冒泡到分隔条）
  const before = await c.ex(WIDTHS);
  await c.drag(g.gripCenter.x, g.gripCenter.y, g.gripCenter.x - 80, g.gripCenter.y);
  const after = await c.ex(WIDTHS);
  check("r13-14", "真鼠标按在抓手上往左拖 80px：浏览器栏变宽约 80px、对话栏变窄（抓手仍然可拖）", near(after.browser - before.browser, 80, 6) && near(before.chat - after.chat, 80, 6), { before, after });
  c.win.close();

  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` FAILED: ${failed.join(", ")}` : ""}`);
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(run).catch((e) => {
  console.error("SMOKE ERROR", e);
  app.exit(1);
});
