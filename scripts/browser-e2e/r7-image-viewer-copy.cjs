"use strict";
/**
 * R7-10 真 Electron：文件预览窗里「图片查看器」的复制图片（按钮 / 右键菜单 / ⌘C）端到端。
 *
 * 页面是**真实的** `ImageViewer` + **真实的** `Dialog`（与 local-file-preview 同一套外壳）+ **真实的** Tailwind 样式
 * （`scripts/browser-e2e/lib/build-image-viewer-fixture.mjs` 打包，见该文件头注释），放进真 Chromium 的**默认 session**
 * （不装任何权限处理器，与 Flowship 主窗口一致），经本地 http（127.0.0.1 随机端口——安全上下文，`navigator.clipboard` 可用）加载。
 * 输入全是真输入事件（`webContents.sendInputEvent`：真鼠标左 / 右键、真键盘），结果读**真系统剪贴板**（主进程 `clipboard.readImage()`）。
 *
 * 验证的事实：
 * - 工具栏按钮 / 右键菜单项 / ⌘C 都能把原图写进系统剪贴板，尺寸与源图一致（jpg 2250×1494、带透明的 png 300×200，透明通道还在）
 * - 先旋转再复制，复制的仍是原图尺寸（不是旋转后的视图）
 * - SVG：24×24 图标 → 长边放大到 1024；无固有尺寸的 SVG → 按显示用的兜底尺寸放大；8000×4000 → 封顶 4096
 * - 右键菜单在**真 CSS** 下盖得住弹窗（elementFromPoint）；Esc 先关菜单、不把预览弹窗一起关掉；再按一次 Esc 才关弹窗
 * - 右键不开始拖拽 / 平移；点菜单项不触发图片区的双击缩放；菜单项点完弹窗仍开着
 * - 键盘：⌘C / Ctrl+C 命中时 preventDefault，其它按键不动；mac 口径下 Ctrl+C 不复制、提示写 ⌘C
 * - 置灰：图片加载失败 / 环境不支持（`nocb=1` 删掉 ClipboardItem）时按钮置灰、菜单项禁用、不写剪贴板；置灰按钮 hover 真的弹出解释性提示
 *
 * 会动系统剪贴板：开头保存（文本 / HTML / RTF / 图片）、结尾还原（文件列表等其它格式还原不了）。
 * 不碰 Flowship / FlowshipTest 与 8676 / 8776 / 8876；userData 指向临时目录；窗口 show:false。
 *
 * 只能经启动器运行：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r7-image-viewer-copy.cjs --timeout 170
 */
const { app, BrowserWindow, clipboard, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-iv-copy-")));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const info = (msg, detail) => console.log(`SMOKE INFO ${msg}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn 返回真值（返回该值）或超时（返回 null） */
const waitFor = async (fn, ms = 4000, step = 50) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
};

// ───────────────────────── 测试图片（用 nativeImage 现造，不依赖外部文件）─────────────────────────
const makeBitmapImage = (w, h, pixel) => {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = (y * w + x) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
};

const IMAGES = {};
const buildImages = () => {
  // 2250×1494 渐变 jpg（用户截图里那张的尺寸）
  IMAGES["photo.jpg"] = {
    type: "image/jpeg",
    body: makeBitmapImage(2250, 1494, (x, y) => [(x * 255) / 2250, (y * 255) / 1494, 128, 255]).toJPEG(90),
  };
  // 300×200 png：左半透明、右半不透明红
  IMAGES["alpha.png"] = {
    type: "image/png",
    body: makeBitmapImage(300, 200, (x) => (x < 150 ? [0, 0, 0, 0] : [255, 0, 0, 255])).toPNG(),
  };
  IMAGES["icon.svg"] = {
    type: "image/svg+xml",
    body: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="red"/></svg>',
    ),
  };
  // 没有 width / height（只有 viewBox）：Chromium 可能报 0×0，也可能给缺省尺寸——脚本按页面实际显示的尺寸推导期望值
  IMAGES["nosize.svg"] = {
    type: "image/svg+xml",
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="blue"/></svg>'),
  };
  IMAGES["big.svg"] = {
    type: "image/svg+xml",
    body: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="4000" viewBox="0 0 8000 4000"><rect width="8000" height="4000" fill="green"/></svg>',
    ),
  };
};

// ───────────────────────── 构建夹具 + 起静态服务 ─────────────────────────
const buildFixture = (outDir) => {
  const builder = path.resolve(__dirname, "lib/build-image-viewer-fixture.mjs");
  // 本进程是 Electron：ELECTRON_RUN_AS_NODE=1 让同一个二进制按纯 node 跑构建脚本（只在这个子进程里设，不影响本进程）
  const r = spawnSync(process.execPath, [builder, outDir], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 150_000,
  });
  if (r.status !== 0) throw new Error(`夹具构建失败（exit ${r.status}）：\n${r.stderr || r.stdout}`);
};

const FORBIDDEN_PORTS = new Set([8676, 8776, 8876]);
const startServer = (dir) =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const name = decodeURIComponent(u.pathname);
      if (name === "/" || name === "/index.html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(fs.readFileSync(path.join(dir, "index.html")));
      }
      if (name === "/app.js" || name === "/app.css") {
        res.setHeader("content-type", name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
        return res.end(fs.readFileSync(path.join(dir, name.slice(1))));
      }
      if (name.startsWith("/img/") && IMAGES[name.slice(5)]) {
        const img = IMAGES[name.slice(5)];
        res.setHeader("content-type", img.type);
        res.setHeader("cache-control", "no-store");
        return res.end(img.body);
      }
      res.statusCode = 404;
      res.end("not found");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      if (FORBIDDEN_PORTS.has(port)) {
        server.close();
        return startServer(dir).then(resolve, reject);
      }
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });

// ───────────────────────── 剪贴板：保存 / 还原 ─────────────────────────
const saveClipboard = () => ({
  text: clipboard.readText(),
  html: clipboard.readHTML(),
  rtf: clipboard.readRTF(),
  image: clipboard.readImage(),
});
const restoreClipboard = (saved) => {
  clipboard.clear();
  const data = {};
  if (saved.text) data.text = saved.text;
  if (saved.html) data.html = saved.html;
  if (saved.rtf) data.rtf = saved.rtf;
  if (saved.image && !saved.image.isEmpty()) data.image = saved.image;
  if (Object.keys(data).length) clipboard.write(data);
};
/** 剪贴板里的图片尺寸（没有图 = null） */
const clipSize = () => {
  const img = clipboard.readImage();
  return img.isEmpty() ? null : img.getSize();
};
const waitClipSize = async (ms = 4000) => waitFor(() => clipSize(), ms, 60);

// ───────────────────────── 主流程 ─────────────────────────
let theWin = null;
/**
 * 先销毁窗口再 app.exit：窗口带 `backgroundThrottling:false`（隐藏窗口里 CSS 动画 / rAF 也要走）时，
 * 直接 app.exit 会让 Electron 进程卡住不退（实测：连只开一个空窗口都会，直到看门狗 SIGKILL），destroy 之后正常退出。
 */
const finish = (code) => {
  try {
    if (theWin && !theWin.isDestroyed()) theWin.destroy();
  } catch {
    /* 已经没了 */
  }
  app.exit(code);
};

const main = async () => {
  await app.whenReady();
  buildImages();
  const fixtureDir = path.join(TMP, "fixture");
  buildFixture(fixtureDir);
  const { server, base } = await startServer(fixtureDir);
  const saved = saveClipboard();

  // 默认 session、不装权限处理器（与 Flowship 主窗口一致）；不节流（隐藏窗口里 CSS 动画 / rAF 也要走，Base UI 的弹层开关依赖它）
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  theWin = win;
  const wc = win.webContents;
  const ev = (code) => wc.executeJavaScript(code, true);
  const rectOf = (sel) =>
    ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
  const mouse = (type, x, y, button = "left", clickCount = 1) =>
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button, clickCount });
  const click = async (x, y, button = "left") => {
    mouse("mouseMove", x, y);
    await sleep(40);
    mouse("mouseDown", x, y, button);
    await sleep(40);
    mouse("mouseUp", x, y, button);
    await sleep(80);
  };
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    await sleep(40);
    wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await sleep(80);
  };
  const dialogOpen = () => ev("!!(window.__fx && window.__fx.open)");
  const menuOpen = () => ev(`!!document.querySelector('[data-slot="context-menu-content"]')`);
  const imgTransform = () => ev(`(() => { const i = document.querySelector('img[alt="fixture"]'); return i ? i.style.transform : null; })()`);
  const bodyText = () => ev("document.body.innerText");
  /** 鼠标移到 (x,y)：先移到角落再分两步进入——和真鼠标一样会产生进入事件（原地「移到」同一点不会，刚点击过的按钮上尤其如此） */
  const hoverAt = async (x, y) => {
    mouse("mouseMove", 5, 5);
    await sleep(150);
    mouse("mouseMove", x - 12, y);
    await sleep(40);
    mouse("mouseMove", x, y);
  };
  const BTN = 'button[aria-label="复制图片"]';

  /** 打开夹具页并等图片区就绪（失败页等「图片加载失败」） */
  const openPage = async (query, { expectFail = false } = {}) => {
    await win.loadURL(`${base}/?${query}`);
    const ready = await waitFor(
      () =>
        ev(`(() => {
          if (!window.__fx || !document.querySelector(${JSON.stringify(BTN)})) return false;
          if (${expectFail}) return document.body.innerText.includes("图片加载失败");
          const i = document.querySelector('img[alt="fixture"]');
          return !!i && i.complete && i.naturalWidth > 0 && i.style.visibility === "visible";
        })()`),
      8000,
    );
    wc.focus();
    await sleep(150);
    return !!ready;
  };
  const naturalLabel = () => ev(`(document.querySelector(".tabular-nums") || {}).textContent || ""`);
  const parseSize = (s) => {
    const m = /(\d+)\s*×\s*(\d+)/.exec(s);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  };
  const btnRect = () => rectOf(BTN);
  const boxRect = () => rectOf('div[tabindex="0"]');
  const clearClip = () => clipboard.clear();
  const sizeIs = (s, w, h) => !!s && s.width === w && s.height === h;

  try {
    // ── 0. 环境 ──
    const ready0 = await openPage("src=/img/photo.jpg");
    check("iv-page-ready", "夹具页（真 ImageViewer + 真 Dialog + 真样式）加载完成，图片已显示", ready0);
    info("document.hasFocus()", await ev("document.hasFocus()"));
    info("navigator.clipboard 可用", await ev("typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined' && isSecureContext"));
    const nat = parseSize(await naturalLabel());
    check("iv-natural-size-shown", "工具栏显示图片尺寸 2250 × 1494", sizeIs(nat && { width: nat.w, height: nat.h }, 2250, 1494), nat);

    // ── 1. 按钮：jpg ──
    const hit = await ev(`(() => {
      const b = document.querySelector(${JSON.stringify(BTN)});
      const close = document.querySelector('[data-slot="dialog-close"]');
      const br = b.getBoundingClientRect();
      const cr = close.getBoundingClientRect();
      const top = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
      const overlap = !(br.right <= cr.left || br.left >= cr.right || br.bottom <= cr.top || br.top >= cr.bottom);
      return { hitIsCopyBtn: b.contains(top), overlapsClose: overlap };
    })()`);
    check("iv-btn-not-covered-by-close", "在真弹窗外壳里，工具栏的复制按钮没有被 Dialog 右上角的关闭键盖住（命中的是复制按钮、两者不重叠）", hit.hitIsCopyBtn && !hit.overlapsClose, hit);
    const btn0 = await ev(`(() => { const b = document.querySelector(${JSON.stringify(BTN)}); return b ? { disabled: b.disabled, inSpan: b.parentElement.tagName } : null; })()`);
    check("iv-btn-exists-enabled", "工具栏有「复制图片」按钮，图片加载后可点（不是置灰）；外面的 span 是 Tooltip 的 trigger——传了 disabled 的按钮一直套着它，加载前后是同一个元素", !!btn0 && btn0.disabled === false && btn0.inSpan === "SPAN", btn0);
    clearClip();
    let r = await btnRect();
    await click(r.cx, r.cy);
    let size = await waitClipSize();
    check("iv-btn-copy-jpg", "真点工具栏按钮 → 系统剪贴板里是 2250×1494 的图（jpg 经 canvas 重编码成 PNG）", sizeIs(size, 2250, 1494), size);
    const toast1 = await waitFor(async () => (await bodyText()).includes("已复制图片"), 2500);
    check("iv-btn-toast", "成功后出现 toast「已复制图片」", !!toast1);
    const iconAfter = await ev(`(() => { const b = document.querySelector(${JSON.stringify(BTN)}); return b ? { check: !!b.querySelector("svg.lucide-check"), copy: !!b.querySelector("svg.lucide-copy") } : null; })()`);
    check("iv-btn-check-icon", "成功后按钮图标换成对勾", !!iconAfter && iconAfter.check && !iconAfter.copy, iconAfter);
    await sleep(1800);
    const iconBack = await ev(`(() => { const b = document.querySelector(${JSON.stringify(BTN)}); return b ? { check: !!b.querySelector("svg.lucide-check"), copy: !!b.querySelector("svg.lucide-copy") } : null; })()`);
    check("iv-btn-icon-restores", "约 1.5 秒后图标回落成复制图标", !!iconBack && iconBack.copy && !iconBack.check, iconBack);

    // ── 2. 先旋转再复制：复制的是原图 ──
    const rot = await rectOf('button[aria-label="向右旋转 90°"]');
    await click(rot.cx, rot.cy);
    const tfRot = await imgTransform();
    clearClip();
    r = await btnRect();
    await click(r.cx, r.cy);
    size = await waitClipSize();
    check("iv-rotated-copies-original", "旋转 90° 之后复制，剪贴板里仍是 2250×1494（原图），不是旋转后的 1494×2250", sizeIs(size, 2250, 1494) && /rotate\(90deg\)/.test(tfRot || ""), { size, tfRot });

    // ── 3. hover 提示 ──
    r = await btnRect();
    await hoverAt(r.cx, r.cy);
    const tip = await waitFor(async () => (await bodyText()).includes("复制原图"), 2500);
    const tipText = await bodyText();
    check("iv-tooltip-original", "hover 按钮出现提示「复制原图（Ctrl+C）」（真壳里 mac 会是 ⌘C；本夹具没有 preload，平台未知）", !!tip && tipText.includes("复制原图（Ctrl+C）"), tipText.match(/复制原图[^\n]*/)?.[0]);
    mouse("mouseMove", 5, 5);
    await sleep(300);

    // ── 4. 右键菜单：真 CSS 下的层级、Esc、不拖拽、点菜单项 ──
    clearClip();
    const tfBefore = await imgTransform();
    const box = await boxRect();
    const px = box.cx - 120;
    const py = box.cy - 80;
    mouse("mouseMove", px, py);
    await sleep(40);
    mouse("mouseDown", px, py, "right");
    await sleep(60);
    const grabbingDuringRight = await ev(`!!(document.querySelector('div[tabindex="0"]') || {}).className?.includes("cursor-grabbing")`);
    mouse("mouseMove", px + 90, py + 60);
    await sleep(40);
    mouse("mouseUp", px + 90, py + 60, "right");
    const opened = await waitFor(menuOpen, 3000);
    check("iv-menu-opens-on-right-click", "在图片区（不是只在 <img> 上）右键 → 弹出菜单（Trigger 的 render 合并生效）", !!opened);
    const tfAfterRight = await imgTransform();
    check("iv-right-click-no-drag", "右键按下 / 拖动 / 松开不开始拖拽：没有 cursor-grabbing、图片没有被平移", grabbingDuringRight === false && tfBefore === tfAfterRight, { grabbingDuringRight, tfBefore, tfAfterRight });

    const layer = await ev(`(() => {
      const menu = document.querySelector('[data-slot="context-menu-content"]');
      if (!menu) return null;
      const item = menu.querySelector('[data-slot="context-menu-item"]');
      const ir = item.getBoundingClientRect();
      const mr = menu.getBoundingClientRect();
      const hit = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && menu.contains(t); };
      const positioner = menu.parentElement;
      const dlg = document.querySelector('[data-slot="dialog-content"]');
      const wrap = dlg && dlg.parentElement;
      return {
        itemText: item.textContent.trim(),
        itemDisabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true",
        menuTopAtItem: hit(ir.x + ir.width / 2, ir.y + ir.height / 2),
        menuTopAtCorner: hit(mr.x + 4, mr.y + 4),
        positionerZ: getComputedStyle(positioner).zIndex,
        dialogWrapperZ: wrap ? getComputedStyle(wrap).zIndex : null,
        dialogWrapperPos: wrap ? getComputedStyle(wrap).position : null,
      };
    })()`);
    check("iv-menu-above-dialog", "菜单在真 CSS 下盖在预览弹窗之上（菜单项 / 菜单角落 elementFromPoint 命中的都是菜单；positioner z-60 > 弹窗外层 z-50）",
      !!layer && layer.menuTopAtItem && layer.menuTopAtCorner && Number(layer.positionerZ) > Number(layer.dialogWrapperZ), layer);
    check("iv-menu-item-label", "菜单只有一项「复制图片」且可用", !!layer && layer.itemText === "复制图片" && layer.itemDisabled === false, layer && { itemText: layer.itemText, itemDisabled: layer.itemDisabled });

    // Esc：先关菜单，不关弹窗
    await key("Escape");
    const menuGone = await waitFor(async () => !(await menuOpen()), 3000);
    const dlgStillOpen = await dialogOpen();
    const dlgDom = await ev(`!!document.querySelector('[data-slot="dialog-content"]')`);
    check("iv-esc-closes-menu-only", "菜单开着按一次 Esc：菜单关了，预览弹窗还开着", !!menuGone && dlgStillOpen === true && dlgDom === true, { menuGone: !!menuGone, dlgStillOpen, dlgDom });

    // 再开菜单 → 真点菜单项 → 复制成功、弹窗仍开、图片没被双击缩放
    mouse("mouseMove", px, py);
    await sleep(40);
    mouse("mouseDown", px, py, "right");
    await sleep(40);
    mouse("mouseUp", px, py, "right");
    await waitFor(menuOpen, 3000);
    await sleep(600); // 过了 Base UI 的「长按保护」窗口，避免把开菜单那次的 mouseup 当成选择
    const itemRect = await rectOf('[data-slot="context-menu-item"]');
    clearClip();
    await click(itemRect.cx, itemRect.cy);
    size = await waitClipSize();
    check("iv-menu-item-copies", "真点菜单项「复制图片」→ 剪贴板里是 2250×1494 的原图", sizeIs(size, 2250, 1494), size);
    const menuClosedAfterPick = await waitFor(async () => !(await menuOpen()), 3000);
    const tfAfterPick = await imgTransform();
    check("iv-menu-pick-side-effects", "点菜单项之后：菜单关闭、预览弹窗仍开、图片没有被缩放 / 平移（没触发图片区的双击 / 拖拽）",
      !!menuClosedAfterPick && (await dialogOpen()) === true && tfAfterPick === tfAfterRight, { tfAfterPick, tfAfterRight });

    // ── 5. 键盘 ⌘C / Ctrl+C ──
    await ev(`(() => { window.__keys = []; document.addEventListener("keydown", (e) => { window.__keys.push({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, prevented: e.defaultPrevented }); }); })()`);
    const focusBox = () => ev(`document.querySelector('div[tabindex="0"]').focus()`);
    await focusBox();
    clearClip();
    await key("C", ["meta"]);
    size = await waitClipSize(3000);
    check("iv-key-cmd-c", "图片区聚焦时按 ⌘C → 剪贴板里是 2250×1494 的原图", sizeIs(size, 2250, 1494), size);
    await sleep(400);
    await focusBox();
    clearClip();
    await key("C", ["control"]);
    size = await waitClipSize(3000);
    check("iv-key-ctrl-c", "按 Ctrl+C（平台未知 / 非 mac）同样复制", sizeIs(size, 2250, 1494), size);
    await sleep(400);
    const keys = await ev("window.__keys");
    const cKeys = keys.filter((k) => k.key.toLowerCase() === "c");
    check("iv-key-prevented", "⌘C / Ctrl+C 命中时 preventDefault（浏览器默认的复制命令不再跑）", cKeys.length >= 2 && cKeys.every((k) => k.prevented === true), cKeys);
    // 其它按键不被吞
    await focusBox();
    await ev("window.__keys.length = 0");
    await key("X");
    await key("A", ["meta"]);
    const otherKeys = await ev("window.__keys");
    check("iv-key-others-not-prevented", "其它按键（x / ⌘A）不 preventDefault", otherKeys.length >= 2 && otherKeys.every((k) => k.prevented === false), otherKeys);
    // 现有快捷键没坏：+ 放大
    const tfPlus0 = await imgTransform();
    await key("=");
    await sleep(100);
    const tfPlus1 = await imgTransform();
    check("iv-key-zoom-still-works", "原有快捷键没被影响：按 = 仍然放大", tfPlus0 !== tfPlus1, { tfPlus0, tfPlus1 });

    // 菜单栏路径：Edit ▸ 拷贝（mac 的 role: copy）= webContents.copy()，不经 keydown，而是给聚焦元素派发 copy 事件。
    // 没有 onCopy 时这条路径什么也不复制（实测：剪贴板里没有图）；有了之后应复制原图，并且事件被 preventDefault
    await ev(`(() => { window.__copyEv = null; document.addEventListener("copy", (e) => { window.__copyEv = { target: e.target && (e.target.tagName + (e.target.getAttribute("tabindex") ? "[tabindex]" : "")), prevented: e.defaultPrevented }; }); })()`);
    await focusBox();
    clearClip();
    wc.copy();
    size = await waitClipSize(3000);
    const copyEv = await ev("window.__copyEv");
    check("iv-menu-copy-event", "菜单栏「拷贝」（webContents.copy()）→ 聚焦的图片区收到 copy 事件并 preventDefault，剪贴板里是 2250×1494 的原图", sizeIs(size, 2250, 1494) && !!copyEv && copyEv.target === "DIV[tabindex]" && copyEv.prevented === true, { size, copyEv });

    // 对照：没有菜单时 Esc 关弹窗（证明上面「Esc 只关菜单」不是因为 Esc 根本不起作用）
    await key("Escape");
    const dlgClosed = await waitFor(async () => (await dialogOpen()) === false, 3000);
    check("iv-esc-closes-dialog-without-menu", "对照：没有菜单时按 Esc 会关预览弹窗（上面「Esc 只关菜单」不是 Esc 失效造成的）", !!dlgClosed);

    // ── 6. png（透明通道） ──
    await openPage("src=/img/alpha.png");
    clearClip();
    r = await btnRect();
    await click(r.cx, r.cy);
    size = await waitClipSize();
    check("iv-png-size", "png：剪贴板里是 300×200", sizeIs(size, 300, 200), size);
    const px2 = (() => {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
      const bm = img.toBitmap();
      const s = img.getSize();
      const at = (x, y) => bm[(y * s.width + x) * 4 + 3];
      return { alphaLeft: at(10, 100), alphaRight: at(290, 100), len: bm.length };
    })();
    check("iv-png-alpha-kept", "png：透明通道保留（左半 alpha=0，右半 alpha=255）", !!px2 && px2.alphaLeft === 0 && px2.alphaRight === 255, px2);

    // ── 7. SVG ──
    await openPage("src=/img/icon.svg&vector=1");
    clearClip();
    r = await btnRect();
    await click(r.cx, r.cy);
    size = await waitClipSize();
    check("iv-svg-small-upscaled", "SVG 24×24 图标：复制出来长边放大到 1024（1024×1024）", sizeIs(size, 1024, 1024), size);

    await openPage("src=/img/nosize.svg&vector=1");
    const shown = parseSize(await naturalLabel());
    const longEdge = shown ? Math.max(shown.w, shown.h) : 0;
    const scale = longEdge < 1024 ? 1024 / longEdge : longEdge > 4096 ? 4096 / longEdge : 1;
    const expect = shown ? { w: Math.max(1, Math.round(shown.w * scale)), h: Math.max(1, Math.round(shown.h * scale)) } : null;
    info("无固有尺寸的 SVG：查看器显示的尺寸", shown);
    clearClip();
    r = await btnRect();
    await click(r.cx, r.cy);
    size = await waitClipSize();
    check("iv-svg-nosize-copies", "无固有尺寸的 SVG：能复制（以前会报「读不到图片尺寸」），尺寸 = 显示用的兜底尺寸按放大规则推导的值",
      !!size && !!expect && sizeIs(size, expect.w, expect.h), { shown, expect, size });
    const nosizeToastErr = (await bodyText()).includes("读不到图片尺寸");
    check("iv-svg-nosize-no-error-toast", "没有出现「读不到图片尺寸」的错误提示", nosizeToastErr === false);

    await openPage("src=/img/big.svg&vector=1");
    clearClip();
    r = await btnRect();
    await click(r.cx, r.cy);
    size = await waitClipSize();
    check("iv-svg-huge-capped", "SVG 8000×4000：长边封顶 4096（4096×2048）", sizeIs(size, 4096, 2048), size);

    // ── 8. mac 口径：Ctrl+C 不复制、⌘C 复制、提示写 ⌘C ──
    await openPage("src=/img/photo.jpg&platform=darwin");
    r = await btnRect();
    await hoverAt(r.cx, r.cy);
    const macTip = await waitFor(async () => (await bodyText()).includes("复制原图"), 2500);
    check("iv-mac-tooltip", "mac：提示写「复制原图（⌘C）」", !!macTip && (await bodyText()).includes("复制原图（⌘C）"));
    mouse("mouseMove", 5, 5);
    await sleep(300);
    await ev(`document.querySelector('div[tabindex="0"]').focus()`);
    clearClip();
    await key("C", ["control"]);
    await sleep(700);
    check("iv-mac-ctrl-c-ignored", "mac：Ctrl+C 不复制（在 mac 上那是别的意思，不拦）", clipSize() === null);
    await key("C", ["meta"]);
    size = await waitClipSize(3000);
    check("iv-mac-cmd-c", "mac：⌘C 复制", sizeIs(size, 2250, 1494), size);

    // ── 9. 置灰：图片加载失败 ──
    await openPage("src=/img/missing.png", { expectFail: true });
    const failedBtn = await ev(`(() => { const b = document.querySelector(${JSON.stringify(BTN)}); return b ? { disabled: b.disabled, inSpan: b.parentElement.tagName } : null; })()`);
    check("iv-failed-btn-disabled", "图片加载失败：按钮置灰，外面套了 span（让 hover 提示能弹出）", !!failedBtn && failedBtn.disabled === true && failedBtn.inSpan === "SPAN", failedBtn);
    r = await btnRect();
    await hoverAt(r.cx, r.cy);
    const failTip = await waitFor(async () => (await bodyText()).includes("图片加载失败，无法复制"), 3000);
    check("iv-failed-tooltip-shows-on-disabled", "置灰的按钮 hover 真的弹出解释「图片加载失败，无法复制」（套 span 之前这种提示永远弹不出来）", !!failTip);
    mouse("mouseMove", 5, 5);
    await sleep(300);
    clearClip();
    await click(r.cx, r.cy);
    check("iv-failed-click-noop", "点置灰的按钮不写剪贴板", clipSize() === null);
    const fb = await boxRect();
    mouse("mouseMove", fb.cx, fb.cy);
    await sleep(40);
    mouse("mouseDown", fb.cx, fb.cy, "right");
    await sleep(40);
    mouse("mouseUp", fb.cx, fb.cy, "right");
    const failMenu = await waitFor(menuOpen, 3000);
    const failItem = await ev(`(() => { const i = document.querySelector('[data-slot="context-menu-item"]'); return i ? { disabled: i.hasAttribute("data-disabled") || i.getAttribute("aria-disabled") === "true" } : null; })()`);
    check("iv-failed-menu-item-disabled", "加载失败时右键仍能开菜单，但「复制图片」项是禁用的", !!failMenu && !!failItem && failItem.disabled === true, failItem);
    await sleep(600);
    const fi = await rectOf('[data-slot="context-menu-item"]');
    clearClip();
    if (fi) await click(fi.cx, fi.cy);
    await sleep(500);
    check("iv-failed-menu-click-noop", "点禁用的菜单项不写剪贴板", clipSize() === null);

    // ── 10. 置灰：环境不支持 ──
    await openPage("src=/img/photo.jpg&nocb=1");
    const noCb = await ev(`(() => { const b = document.querySelector(${JSON.stringify(BTN)}); return b ? { disabled: b.disabled, hasClipboardItem: typeof ClipboardItem !== "undefined" } : null; })()`);
    check("iv-unsupported-btn-disabled", "环境不支持（ClipboardItem 不存在）：图片加载好了按钮也置灰", !!noCb && noCb.disabled === true && noCb.hasClipboardItem === false, noCb);
    r = await btnRect();
    await hoverAt(r.cx, r.cy);
    const noCbTip = await waitFor(async () => (await bodyText()).includes("当前环境不支持复制图片"), 3000);
    check("iv-unsupported-tooltip", "hover 置灰按钮显示「当前环境不支持复制图片」", !!noCbTip);
    mouse("mouseMove", 5, 5);
    await sleep(300);
    clearClip();
    await ev(`document.querySelector('div[tabindex="0"]').focus()`);
    await key("C", ["meta"]);
    await sleep(500);
    check("iv-unsupported-key-noop", "环境不支持时 ⌘C 也不复制（也不报错）", clipSize() === null);
  } finally {
    restoreClipboard(saved);
    server.close();
  }

  const passed = results.filter((x) => x.ok).length;
  console.log(`SMOKE SUMMARY ${passed}/${results.length} passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  finish(passed === results.length ? 0 : 1);
};

main().catch((err) => {
  console.error("SMOKE FATAL", err && err.stack ? err.stack : err);
  const passed = results.filter((x) => x.ok).length;
  console.log(`SMOKE SUMMARY ${passed}/${results.length} passed (FATAL)`);
  finish(1);
});
