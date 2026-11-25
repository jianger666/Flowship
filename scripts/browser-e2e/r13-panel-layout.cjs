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
// 清临时目录（含 userData 与 vite 打包出的 harness；第十七轮评审 B-2 补了正常收尾；第十八轮评审 R-1：vite 打包失败 / 异常路径也要清，不留 TMP/harness）。
// best-effort：Chromium 退出前可能还在写缓存，偶发 ENOTEMPTY / EBUSY——重试几次，仍清不掉只告警，不改退出码、不吞原始错误；可重复调用
const cleanupTmp = () => {
  // 先销毁剩下的窗口（Chromium 还抱着 userData 时 rmSync 容易 ENOTEMPTY），再清
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
    console.warn("SMOKE WARN 临时目录没清掉（不影响结果）：", err && err.message ? err.message : err);
  }
};
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
/** 同 probe，但打开后多等一会儿再取值（给异步加载的数据——比如收藏列表——落地的时间） */
const probeAfter = async (query, js, waitMs, size) => {
  const c = await open(query, size);
  try {
    await sleep(waitMs);
    return await c.ex(js);
  } finally {
    c.win.close();
  }
};
/** 页内第一个（含指定文字的）选择器命中元素的中心坐标（视口 CSS 像素） */
const centerOf = (c, selector, text) =>
  c.ex(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const e = ${text ? `els.find((x) => x.textContent.includes(${JSON.stringify(text)}))` : "els[0]"};
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
/** 真鼠标（Chromium 输入管线）：移动 / 单击 */
const mouseMove = async (c, p) => {
  if (!p) throw new Error("mouseMove: 目标元素不存在");
  c.win.webContents.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y });
  await sleep(40);
};
const mouseClick = async (c, p) => {
  await mouseMove(c, p);
  c.win.webContents.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await sleep(30);
  c.win.webContents.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await sleep(120);
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
/** 地址栏星标：是否画出来、在不在输入框右端内侧、点得到自己吗、有没有盖住别的按钮、输入框的左右内边距与文字区宽度、已收藏态（标签 / aria-pressed / 图标填色） */
const STAR = `(() => {
  const bar = document.querySelector('[data-slot="browser-toolbar"]');
  const form = bar.querySelector('form');
  const input = form && form.querySelector('input');
  if (!input) return { error: 'no address input' };
  const star = form.querySelector('button[aria-pressed]');
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const ir = R(input);
  const cs = getComputedStyle(input);
  const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
  const sr = star ? R(star) : null;
  const visible = !!sr && sr.w > 0 && sr.h > 0;
  const hit = visible ? document.elementFromPoint(sr.l + sr.w / 2, sr.t + sr.h / 2) : null;
  const overlaps = !visible ? [] : [...bar.querySelectorAll('button')].filter((b) => b !== star).filter((b) => {
    const o = R(b);
    return o.w > 0 && Math.min(o.r, sr.r) - Math.max(o.l, sr.l) > 0.5 && Math.min(o.b, sr.b) - Math.max(o.t, sr.t) > 0.5;
  }).map((b) => b.getAttribute('aria-label') || b.textContent.trim().slice(0, 12));
  const icon = star && star.querySelector('svg');
  return {
    visible,
    label: star ? star.getAttribute('aria-label') : null,
    pressed: star ? star.getAttribute('aria-pressed') : null,
    insideInput: visible && sr.l >= ir.l - 0.5 && sr.r <= ir.r + 0.5 && sr.t >= ir.t - 0.5 && sr.b <= ir.b + 0.5,
    gapToRight: visible ? Math.round(ir.r - sr.r) : null,
    w: visible ? Math.round(sr.w) : null,
    h: visible ? Math.round(sr.h) : null,
    hitSelf: visible && !!hit && (hit === star || star.contains(hit)),
    overlaps,
    padR,
    textW: Math.round(ir.w - padL - padR),
    filled: icon ? getComputedStyle(icon).fill !== 'none' : null,
  };
})()`;
/** 收藏夹对话框：在不在窗口内、行数、有没有过滤框、列表的限高 / 滚动、对话框文字（用来看空 / 无匹配提示） */
const DIALOG = `(() => {
  const d = document.querySelector('[data-slot="dialog-content"]');
  if (!d) return null;
  const dr = d.getBoundingClientRect();
  const ul = d.querySelector('ul[aria-label="收藏列表"]');
  return {
    inViewport: dr.left >= 0 && dr.top >= 0 && dr.right <= innerWidth && dr.bottom <= innerHeight,
    w: Math.round(dr.width), h: Math.round(dr.height),
    rows: ul ? ul.children.length : 0,
    hasFilter: !!d.querySelector('input[aria-label="搜索收藏"]'),
    listOverflowY: ul ? getComputedStyle(ul).overflowY : null,
    listClientH: ul ? ul.clientHeight : null,
    listScrollH: ul ? ul.scrollHeight : null,
    text: d.textContent,
  };
})()`;
/**
 * 地址联想弹层：弹层是否在且有尺寸、行（文字 / 星标 / 「×」按钮及其可见性 / 高亮）、弹层与工具栏的几何差（左缘 / 宽 / 弹层上沿 − 工具栏下沿，
 * 都应 ≈ 0）、第一行中心点命中的是不是它自己、输入框焦点与文字。弹层 Portal 到 body，所以从 document 找
 */
const SUGGEST = `(() => {
  const bar = document.querySelector('[data-slot="browser-toolbar"]');
  const input = bar.querySelector('form input');
  const popup = document.querySelector('[data-slot="autocomplete-content"]');
  const list = document.querySelector('[data-slot="autocomplete-list"]');
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const rows = list ? [...list.querySelectorAll('[role="option"]')] : [];
  const br = R(bar);
  const pr = popup ? R(popup) : null;
  const first = rows[0] ? R(rows[0]) : null;
  const hit = first ? document.elementFromPoint(first.l + first.w / 2, first.t + first.h / 2) : null;
  const removeBtn = (r) => r.querySelector('button[aria-label^="从联想中删除"]');
  return {
    open: !!pr && pr.w > 0 && pr.h > 0,
    rows: rows.length,
    texts: rows.map((r) => r.textContent.trim()),
    highlighted: rows.map((r, i) => (r.hasAttribute('data-highlighted') ? i : -1)).filter((i) => i >= 0),
    stars: rows.map((r) => !!r.querySelector('svg.fill-warning')),
    removeBtns: rows.map((r) => !!removeBtn(r)),
    removeVisible: rows.map((r) => (removeBtn(r) ? getComputedStyle(removeBtn(r)).visibility : null)),
    geo: pr && { dl: Math.round(pr.l - br.l), dw: Math.round(pr.w - br.w), dtop: +(pr.t - br.b).toFixed(1), inViewport: pr.l >= 0 && pr.r <= innerWidth && pr.t >= 0 && pr.b <= innerHeight },
    hitFirstRow: !!hit && !!rows[0] && rows[0].contains(hit),
    inputFocused: document.activeElement === input,
    inputValue: input.value,
  };
})()`;
/** 每一行右侧「新标签页打开 / 删除」容器的不透明度（0 = 看不见） */
const ROW_OPACITY = `[...document.querySelectorAll('[data-slot="dialog-content"] ul[aria-label="收藏列表"] > li')].map((li) => Number(getComputedStyle(li.children[1]).opacity))`;
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

  // ═══════════ 收藏：地址栏星标 / 「更多」菜单 / 收藏夹对话框（真 Tailwind、真鼠标；收藏接口由 harness 桩应答）═══════════

  // 星标在地址栏输入框右端（≥ 360px）：不盖别的按钮、点得到自己、输入框留了右内边距、文字区仍够用
  const starAt = async (w, extra = "") => probeAfter(`mode=toolbar&w=${w}&h=500&${extra}`, STAR, 300);
  const starOk = (m) => m.visible && m.insideInput && m.gapToRight <= 8 && m.hitSelf && m.overlaps.length === 0 && m.padR >= 28 && m.textW >= 40 && m.w >= 16 && m.w <= 28 && m.h >= 16 && m.h <= 28;
  // 星标与「更多」菜单等都要等收藏列表（桩接口）加载完才有最终状态，所以量测前多等 300ms
  const wideStars = {};
  for (const w of [380, 428, 560]) wideStars[w] = await starAt(w);
  check("r13-16", "地址栏星标（380 / 428 / 560px）：在输入框右端内侧、点得到自己、不盖别的按钮；输入框留了右内边距、文字区 ≥ 40px", Object.values(wideStars).every(starOk), wideStars);

  // 窄于 360px 让位（和缩放标签同一条规则）：星标不占位，输入框的右内边距一并收回；工具栏本身不受影响
  const narrowStars = {};
  for (const w of [300, 340]) narrowStars[w] = await starAt(w);
  const narrowBars = [];
  for (const w of [300, 340]) narrowBars.push(await probe(`mode=toolbar&w=${w}&h=500`, BAR));
  check(
    "r13-17",
    "地址栏星标（300 / 340px）：窄于 360px 让位——星标不画、输入框右内边距收回（≤ 12px）；工具栏不溢出、地址栏仍 ≥ 80px",
    Object.values(narrowStars).every((m) => m.visible === false && m.padR <= 12) && narrowBars.every((b) => b.over === 0 && b.cut.length === 0 && b.unhit.length === 0 && b.addr >= 80),
    { narrowStars, narrowBars },
  );

  // 已收藏态：标签 / aria-pressed / 图标填色三者一致
  const unstarred = await starAt(428, "bm=3");
  const starred = await starAt(428, "bm=3&bmcur=1");
  check(
    "r13-18",
    "星标状态：当前页不在收藏里 → 「收藏此页」、未按下、图标不填色；在收藏里 → 「取消收藏」、已按下、图标填色",
    unstarred.label === "收藏此页" && unstarred.pressed === "false" && unstarred.filled === false && starred.label === "取消收藏" && starred.pressed === "true" && starred.filled === true,
    { unstarred: [unstarred.label, unstarred.pressed, unstarred.filled], starred: [starred.label, starred.pressed, starred.filled] },
  );

  // 真鼠标：点星标 → POST 进收藏 → 星标变已收藏；再点 → DELETE → 变回未收藏（经真 store + 真 fetch + 桩接口）
  c = await open(`mode=toolbar&w=428&h=500&bm=3`, [900, 700]);
  await sleep(300);
  const starPoint = await centerOf(c, 'form button[aria-pressed]');
  await mouseClick(c, starPoint);
  await sleep(250);
  const afterAdd = await c.ex(STAR);
  await mouseClick(c, starPoint);
  await sleep(250);
  const afterRemove = await c.ex(STAR);
  c.win.close();
  check("r13-19", "真鼠标点星标：收藏 → 已收藏态；再点 → 取消收藏回到未收藏态", afterAdd.label === "取消收藏" && afterAdd.pressed === "true" && afterRemove.label === "收藏此页" && afterRemove.pressed === "false", { afterAdd: [afterAdd.label, afterAdd.pressed], afterRemove: [afterRemove.label, afterRemove.pressed] });

  // 「更多」菜单 → 「收藏夹…」→ 对话框：12 条收藏（> 8 条出过滤框）、列表限高可滚动、行内操作悬停 / 键盘聚焦才显示、过滤、删除
  c = await open(`mode=toolbar&w=428&h=640&bm=12`, [900, 760]);
  await sleep(300);
  await mouseClick(c, await centerOf(c, 'button[aria-label="更多"]'));
  await sleep(300);
  const menu = await c.ex(`[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].map((e) => ({ text: e.textContent.trim(), disabled: e.hasAttribute('data-disabled') || e.getAttribute('aria-disabled') === 'true' }))`);
  const menuAdd = menu.find((m) => m.text === "收藏此页");
  const menuManage = menu.find((m) => /^收藏夹…\s*12$/.test(m.text));
  check("r13-20", "「更多」菜单：有可点的「收藏此页」和带数量的「收藏夹…12」，无痕入口仍在", !!menuAdd && !menuAdd.disabled && !!menuManage && menu.some((m) => m.text === "新建无痕标签页"), menu);

  await mouseClick(c, await centerOf(c, '[data-slot="dropdown-menu-item"]', "收藏夹…"));
  await sleep(400);
  const dlg = await c.ex(DIALOG);
  check(
    "r13-21",
    "收藏夹对话框：在窗口内、12 行 + 过滤框；列表限高（≤ 24rem）且可滚动，不把对话框撑出窗口",
    !!dlg && dlg.inViewport && dlg.rows === 12 && dlg.hasFilter && dlg.listOverflowY === "auto" && dlg.listClientH <= 385 && dlg.listScrollH > dlg.listClientH,
    dlg,
  );

  // 行内操作：静止时不可见；悬停该行显示；键盘聚焦到行内按钮同样显示（group-focus-within）
  await mouseMove(c, { x: 4, y: 4 });
  await sleep(150);
  const rest = await c.ex(ROW_OPACITY);
  await mouseMove(c, await centerOf(c, '[data-slot="dialog-content"] ul[aria-label="收藏列表"] > li:nth-child(2) > button'));
  await sleep(200);
  const hover = await c.ex(ROW_OPACITY);
  await mouseMove(c, { x: 4, y: 4 });
  await c.ex(`document.querySelector('[data-slot="dialog-content"] ul[aria-label="收藏列表"] > li:nth-child(1) button[aria-label^="在新标签页打开"]').focus()`);
  await sleep(150);
  const focused = await c.ex(ROW_OPACITY);
  check(
    "r13-22",
    "行内「新标签页打开 / 删除」：静止隐藏；悬停该行显示；键盘聚焦行内按钮同样显示",
    rest[0] === 0 && rest[1] === 0 && hover[0] === 0 && hover[1] === 1 && focused[0] === 1 && focused[1] === 0,
    { rest: rest.slice(0, 2), hover: hover.slice(0, 2), focused: focused.slice(0, 2) },
  );

  // 过滤：真键盘输入（受控输入框）→ 只剩匹配的一行；删掉它 → 没有匹配的提示，总数少一个
  await c.ex(`document.querySelector('[data-slot="dialog-content"] input[aria-label="搜索收藏"]').focus()`);
  c.win.webContents.insertText("收藏标题 7");
  await sleep(200);
  const filtered = await c.ex(DIALOG);
  await mouseMove(c, await centerOf(c, '[data-slot="dialog-content"] ul[aria-label="收藏列表"] > li:nth-child(1) > button'));
  await sleep(150);
  await mouseClick(c, await centerOf(c, '[data-slot="dialog-content"] ul[aria-label="收藏列表"] > li:nth-child(1) button[aria-label^="删除收藏"]'));
  await sleep(300);
  const afterDelete = await c.ex(DIALOG);
  check("r13-23", "过滤 + 删除：输入「收藏标题 7」只剩 1 行；删掉后列表空、出「没有匹配」提示，（菜单计数 12 → 11 见下一条）", !!filtered && filtered.rows === 1 && !!afterDelete && afterDelete.rows === 0 && /没有匹配「收藏标题 7」的收藏/.test(afterDelete.text), { filteredRows: filtered && filtered.rows, afterDelete: afterDelete && { rows: afterDelete.rows, text: afterDelete.text.slice(-40) } });

  // Esc 关闭对话框；再打开「更多」菜单，数量是 11（删除在 store 里生效，菜单跟着变）
  c.win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  c.win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await sleep(400);
  const closed = await c.ex(`!document.querySelector('[data-slot="dialog-content"]')`);
  await mouseClick(c, await centerOf(c, 'button[aria-label="更多"]'));
  await sleep(300);
  const menuAfter = await c.ex(`[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].map((e) => e.textContent.trim())`);
  check("r13-24", "Esc 关闭对话框；删除后「更多」菜单里的数量变成 11", closed === true && menuAfter.some((t) => /^收藏夹…\s*11$/.test(t)), { closed, menuAfter });
  c.win.close();

  // ═══════════ 地址栏记忆：联想下拉（真 Tailwind、真鼠标 / 真键盘；历史接口由 harness 桩应答，桩里 0 号最常去 / 最近）═══════════
  // 这几条钉的是「真实 Chromium 里」才能确定的行为：弹层的几何、焦点没被抢、遮盖原生视图、Enter / Esc / × 的次序。
  // 局限：harness 里没有真原生视图（只量几何 + 看 setCovered 是否被调用）；历史接口是桩，服务端存储由单测覆盖

  const openSuggest = async (query, size = [900, 700]) => {
    const w = await open(query, size);
    // 窗口是 show:false：页面没有「焦点」时 focus / focusin 事件不触发（activeElement 会变，但 React 的 onFocus 不跑，地址栏就进不了编辑态），
    // 所以先让页面拿到焦点——这是无头环境的补课，真实窗口里点输入框本来就会有焦点事件
    w.win.webContents.focus();
    await sleep(250);
    await mouseClick(w, await centerOf(w, '[data-slot="browser-toolbar"] form input'));
    await sleep(300);
    return w;
  };
  const typeText = async (w, text) => {
    w.win.webContents.insertText(text);
    await sleep(300);
  };
  const pressKey = async (w, keyCode, modifiers = []) => {
    w.win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter") w.win.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers }); // 回车触发表单隐式提交靠 char 事件
    w.win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await sleep(200);
  };
  const navCalls = (w) => w.ex(`window.__navCalls.slice()`);
  const histIds = (w) => w.ex(`window.__historyIds()`);

  // 基本：聚焦后还没敲字不弹；敲字后弹出，按「常去 + 最近」排序，最多 6 条；弹层与工具栏同宽、贴着工具栏下沿、在窗口内、没被别的东西盖住；输入框焦点没被抢走
  c = await openSuggest(`mode=toolbar&w=428&h=500&hist=8`);
  const sgFocused = await c.ex(SUGGEST);
  await typeText(c, "site");
  const sgTyped = await c.ex(SUGGEST);
  check(
    "r13-25",
    "地址联想：聚焦未敲字不弹；敲「site」后弹出最多 6 条、最常去的在最前；弹层与工具栏同宽、贴着工具栏下沿、在窗口内、第一行点得到自己；输入框仍持有焦点且文字没被联想改写",
    sgFocused.open === false &&
      sgTyped.open === true &&
      sgTyped.rows === 6 &&
      /历史标题 0/.test(sgTyped.texts[0]) &&
      Math.abs(sgTyped.geo.dl) <= 1 &&
      Math.abs(sgTyped.geo.dw) <= 1 &&
      Math.abs(sgTyped.geo.dtop) <= 1.5 &&
      sgTyped.geo.inViewport &&
      sgTyped.hitFirstRow &&
      sgTyped.inputFocused &&
      sgTyped.inputValue === "site",
    { sgFocused: sgFocused.open, sgTyped },
  );

  // 联想弹层带 role=listbox：use-overlay-cover 据此让主进程遮盖原生视图（否则弹层会被盖在浏览器页面下面看不见）
  await sleep(300);
  const coverOpen = await c.ex(`window.__coverCalls.slice()`);
  check("r13-26", "联想弹层打开时：面板请求遮盖原生视图（setCovered(true) 已被调用，最后一次是 true）", coverOpen.length > 0 && coverOpen[coverOpen.length - 1] === true, coverOpen);

  // 键盘：↓ 选中、输入框文字不变；Enter 打开高亮项并收起弹层、输入框失焦
  await pressKey(c, "Down");
  await pressKey(c, "Down");
  const sgDown = await c.ex(SUGGEST);
  await pressKey(c, "Enter");
  const sgPicked = await c.ex(SUGGEST);
  const pickedCalls = await navCalls(c);
  check(
    "r13-27",
    "键盘：↓↓ 高亮第 2 行且输入框文字不变；Enter 打开高亮项（navigate 收到该行地址）、弹层收起、输入框失焦",
    sgDown.highlighted.length === 1 && sgDown.highlighted[0] === 1 && sgDown.inputValue === "site" && pickedCalls.length === 1 && pickedCalls[0] === "https://site1.example.com/page/1" && sgPicked.open === false && sgPicked.inputFocused === false,
    { highlighted: sgDown.highlighted, inputValue: sgDown.inputValue, pickedCalls, afterOpen: sgPicked.open, afterFocused: sgPicked.inputFocused },
  );
  await sleep(400);
  const coverAfterPick = await c.ex(`window.__coverCalls.slice()`);
  check("r13-28", "联想弹层关闭后：面板请求恢复原生视图（setCovered 最后一次是 false）", coverAfterPick[coverAfterPick.length - 1] === false, coverAfterPick);
  c.win.close();

  // 没有高亮项时 Enter：照旧提交输入框里的文字（不是第一条联想）
  c = await openSuggest(`mode=toolbar&w=428&h=500&hist=8`);
  await typeText(c, "site3");
  const sgBeforeEnter = await c.ex(SUGGEST);
  await pressKey(c, "Enter");
  const enterCalls = await navCalls(c);
  check("r13-29", "没有高亮项时 Enter：提交的是输入框里的文字「site3」（不是联想第一条）；弹层收起", sgBeforeEnter.open === true && enterCalls.length === 1 && enterCalls[0] === "site3" && (await c.ex(SUGGEST)).open === false, { open: sgBeforeEnter.open, enterCalls });
  c.win.close();

  // 没有匹配：不弹；Esc 两段式：下拉开着时第一下只收下拉（输入框保持焦点与文字），再按才退出编辑并还原成当前地址
  c = await openSuggest(`mode=toolbar&w=428&h=500&hist=8`);
  const addrBefore = await c.ex(`document.querySelector('[data-slot="browser-toolbar"] form input').value`); // 聚焦时输入框里是当前页地址（草稿 = currentUrl）
  await typeText(c, "zzzz-no-such-site");
  const sgNone = await c.ex(SUGGEST);
  await c.ex(`(() => { const i = document.querySelector('[data-slot="browser-toolbar"] form input'); i.select(); })()`);
  await typeText(c, "site");
  const sgReopen = await c.ex(SUGGEST);
  await pressKey(c, "Escape");
  const sgEsc1 = await c.ex(SUGGEST);
  await pressKey(c, "Escape");
  const sgEsc2 = await c.ex(SUGGEST);
  check(
    "r13-30",
    "没有匹配不弹；Esc 两段式：第一下只收弹层（输入框保持焦点与文字「site」），第二下退出编辑、输入框失焦并还原成当前页地址",
    sgNone.open === false &&
      sgReopen.open === true &&
      sgEsc1.open === false &&
      sgEsc1.inputFocused === true &&
      sgEsc1.inputValue === "site" &&
      sgEsc2.inputFocused === false &&
      sgEsc2.inputValue === addrBefore &&
      addrBefore.length > 0 &&
      (await navCalls(c)).length === 0,
    { none: sgNone.open, reopen: sgReopen.open, esc1: [sgEsc1.open, sgEsc1.inputFocused, sgEsc1.inputValue], esc2: [sgEsc2.inputFocused, sgEsc2.inputValue] },
  );
  c.win.close();

  // 「×」：只有悬停 / 键盘高亮的那一行才露出；真鼠标点 ×：从记忆里删掉那一条、弹层不关、输入框不失焦、也不会触发「打开这一行」
  c = await openSuggest(`mode=toolbar&w=428&h=500&hist=8`);
  await typeText(c, "site");
  const sgRest = await c.ex(SUGGEST);
  await mouseMove(c, await centerOf(c, '[data-slot="autocomplete-list"] [role="option"]:nth-child(3)'));
  await sleep(200);
  const sgHover = await c.ex(SUGGEST);
  const xPoint = await centerOf(c, '[data-slot="autocomplete-list"] [role="option"]:nth-child(3) button[aria-label^="从联想中删除"]');
  await mouseClick(c, xPoint);
  await sleep(350);
  const sgRemoved = await c.ex(SUGGEST);
  const idsAfterX = await histIds(c);
  check(
    "r13-31",
    "「×」：静止时都隐藏、悬停第 3 行只露出它的；点 × 删掉这条记忆（h2）、弹层保持打开（仍 6 行，补上了后面的）、输入框不失焦、没有触发导航",
    sgRest.removeVisible.every((v) => v === "hidden") &&
      sgHover.highlighted[0] === 2 &&
      sgHover.removeVisible.map((v, i) => (i === 2 ? v === "visible" : v === "hidden")).every(Boolean) &&
      !idsAfterX.includes("h2") &&
      idsAfterX.length === 7 &&
      sgRemoved.open === true &&
      sgRemoved.rows === 6 &&
      !sgRemoved.texts.some((t) => t.includes("site2.example.com")) &&
      sgRemoved.inputFocused === true &&
      (await navCalls(c)).length === 0,
    { rest: sgRest.removeVisible, hover: sgHover.removeVisible, hl: sgHover.highlighted, idsAfterX, removed: [sgRemoved.open, sgRemoved.rows, sgRemoved.inputFocused] },
  );

  // 同一个弹层里再用 Shift+Delete 删当前高亮项（键盘版的 ×）：↓ 高亮第 1 行 → Shift+Delete → h0 没了
  await mouseMove(c, { x: 4, y: 640 }); // 鼠标挪出弹层：悬停会改变高亮，↓ 是从当前高亮往下走
  await sleep(200);
  await pressKey(c, "Down");
  const sgBeforeShiftDel = await c.ex(SUGGEST);
  await pressKey(c, "Delete", ["shift"]);
  await sleep(250);
  const idsAfterShiftDel = await histIds(c);
  const sgAfterShiftDel = await c.ex(SUGGEST);
  check(
    "r13-32",
    "键盘版删除：↓ 高亮第 1 行后 Shift+Delete 删掉它（h0）；弹层仍开着、输入框仍有焦点、没有触发导航",
    sgBeforeShiftDel.highlighted[0] === 0 && !idsAfterShiftDel.includes("h0") && sgAfterShiftDel.open === true && sgAfterShiftDel.inputFocused === true && (await navCalls(c)).length === 0,
    { before: sgBeforeShiftDel.highlighted, idsAfterShiftDel, after: [sgAfterShiftDel.open, sgAfterShiftDel.inputFocused] },
  );
  c.win.close();

  // 真鼠标点联想行（不是 ×）：打开那一行的地址、弹层收起、输入框失焦
  c = await openSuggest(`mode=toolbar&w=428&h=500&hist=8`);
  await typeText(c, "site");
  await mouseClick(c, await centerOf(c, '[data-slot="autocomplete-list"] [role="option"]:nth-child(4) span.font-medium'));
  await sleep(250);
  const sgClickPick = await c.ex(SUGGEST);
  const clickCalls = await navCalls(c);
  check(
    "r13-33",
    "真鼠标点第 4 行：navigate 收到该行地址（且只调了一次）、弹层收起、输入框失焦（点选没有先让输入框 blur 把弹层收掉）",
    clickCalls.length === 1 && clickCalls[0] === "https://site3.example.com/page/3" && sgClickPick.open === false && sgClickPick.inputFocused === false,
    { clickCalls, open: sgClickPick.open, focused: sgClickPick.inputFocused },
  );
  c.win.close();

  // 收藏参与联想：只在收藏里的网址有星标、没有「×」（删收藏在收藏夹里做）
  c = await openSuggest(`mode=toolbar&w=428&h=500&bm=3`);
  await typeText(c, "收藏标题");
  const sgBm = await c.ex(SUGGEST);
  check("r13-34", "收藏参与联想：输入「收藏标题」出 3 行，都带星标、都没有「×」", sgBm.open === true && sgBm.rows === 3 && sgBm.stars.every(Boolean) && sgBm.removeBtns.every((x) => x === false), { rows: sgBm.rows, stars: sgBm.stars, removeBtns: sgBm.removeBtns });
  c.win.close();

  // 窄面板（栏宽下限 300px）：弹层与工具栏同宽、在窗口内、没有横向溢出；行内文字被截断而不是撑出弹层
  c = await openSuggest(`mode=toolbar&w=300&h=500&hist=8`, [700, 700]);
  await typeText(c, "site");
  const sgNarrow = await c.ex(SUGGEST);
  const narrowOverflow = await c.ex(`(() => { const p = document.querySelector('[data-slot="autocomplete-content"]'); const rows = [...p.querySelectorAll('[role="option"]')]; return { page: document.documentElement.scrollWidth - innerWidth, popup: p.scrollWidth - p.clientWidth, rows: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length }; })()`);
  check(
    "r13-35",
    "窄面板（300px）：弹层与工具栏同宽（≤ 1px 误差）、在窗口内；页面 / 弹层 / 各行都没有横向溢出",
    sgNarrow.open === true && Math.abs(sgNarrow.geo.dw) <= 1 && sgNarrow.geo.inViewport && narrowOverflow.page <= 0 && narrowOverflow.popup <= 0 && narrowOverflow.rows === 0,
    { geo: sgNarrow.geo, narrowOverflow },
  );
  c.win.close();

  // 「更多」菜单：「清除浏览历史」在「清除登录数据」之前；取消 = 记忆原样；确认 = 清空（DELETE ?all=1）
  c = await open(`mode=toolbar&w=428&h=640&hist=5`, [900, 760]);
  await sleep(300);
  const openMenu = async () => {
    await mouseClick(c, await centerOf(c, 'button[aria-label="更多"]'));
    await sleep(300);
  };
  const confirmButtons = `(() => { const d = document.querySelector('[role="alertdialog"]'); return d ? { title: d.querySelector('[data-slot="alert-dialog-title"]')?.textContent ?? d.textContent.slice(0, 20), buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })()`;
  await openMenu();
  const items = await c.ex(`[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].map((e) => e.textContent.trim())`);
  await mouseClick(c, await centerOf(c, '[data-slot="dropdown-menu-item"]', "清除浏览历史"));
  await sleep(400);
  const dlgClear = await c.ex(confirmButtons);
  await mouseClick(c, await centerOf(c, '[role="alertdialog"] button', "取消"));
  await sleep(400);
  const idsAfterCancel = await histIds(c);
  await openMenu();
  await mouseClick(c, await centerOf(c, '[data-slot="dropdown-menu-item"]', "清除浏览历史"));
  await sleep(400);
  await mouseClick(c, await centerOf(c, '[role="alertdialog"] button', "清除"));
  await sleep(500);
  const idsAfterClear = await histIds(c);
  const dlgGone = await c.ex(`!document.querySelector('[role="alertdialog"]')`);
  check(
    "r13-36",
    "「更多」→「清除浏览历史」：排在「清除登录数据」之前；弹确认框（带「取消 / 清除」）；取消后 5 条记忆原样；确认后记忆清空（桩里 0 条）、确认框关闭",
    items.indexOf("清除浏览历史") >= 0 &&
      items.indexOf("清除浏览历史") < items.indexOf("清除登录数据") &&
      !!dlgClear &&
      dlgClear.buttons.includes("取消") &&
      dlgClear.buttons.includes("清除") &&
      idsAfterCancel.length === 5 &&
      idsAfterClear.length === 0 &&
      dlgGone === true,
    { items, dlgClear, idsAfterCancel: idsAfterCancel.length, idsAfterClear: idsAfterClear.length, dlgGone },
  );
  c.win.close();

  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` FAILED: ${failed.join(", ")}` : ""}`);
  cleanupTmp(); // 清不掉只告警（不让「全部通过」被清理失败变成 FATAL exit 1；第十七轮评审 B-2：此前这个脚本建了临时目录却从不清）
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(run).catch((e) => {
  console.error("SMOKE ERROR", e);
  cleanupTmp(); // 错误已先打出（含 vite 打包失败）；清理只告警，退出码仍是 1
  app.exit(1);
});
