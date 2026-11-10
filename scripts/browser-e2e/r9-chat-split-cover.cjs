"use strict";
/**
 * R9 回归（真 Electron + 真 react-resizable-panels 4.11.1 + 真鼠标；R8-02 / R8-03 / R8-04）：聊天页「浏览器遮住对话」的分栏行为。
 *
 * 背景：聊天页浏览器栏可以「放大」到 100%，把对话栏折叠成 0（盖住态）。react-resizable-panels 有个特例——
 * 「对话栏已折叠时，对另一个（最后一个）Panel 调 resize / collapse 是静默无效」，所以盖住态下的「还原」/ 头部「浏览器」按钮 /
 * 面板里的 X 一度全部不起作用（R8-02）；挂载路径不夹取，记住 ≥85% 时窄容器里一打开就被盖住（R8-03）。
 * 这类「库命令式语义」node 环境里没有布局、测不出来，所以必须真库 + 真窗口。
 *
 * 做法：用 vite 把**真的** useChatBrowserPane + ChatBrowserSplit 打成页面（只把 BrowserPanel 换成桩，见 layout-harness/），
 * 放进无头 Electron 窗口，读真实布局像素、发真鼠标拖分隔条。vite 来自 vitest 的依赖（不是项目直接依赖），脚本自己定位、
 * 以 ELECTRON_RUN_AS_NODE 起一个子进程打包到临时目录——不往仓库里写任何产物。
 *
 * 断言：
 *   A  按钮路径：初始收起 → 打开到记住的 42% → 放大（对话折叠成 0、inert）→ 在盖住态下分别点「还原」/ 头部按钮 / X
 *      → 还原回约 42%；整栏收起、对话占满 → 关闭后再打开仍回到记住的宽度、不盖住；放大后窗口缩窄再还原仍夹在对话 ≥320px；
 *      新提问出现时 revealChat（R8-05 ①）：盖住才还原、没盖住 / 浏览器没开都不动
 *   B  挂载路径（R8-03）：记住的宽度大于容器放得下的值时，页面一打开对话栏 ≥320px、不盖住（1000px/85%、1000px/90%、1400px/90%）
 *   C  真鼠标拖分隔条：夹在对话 320px；拖过一半折叠 = 盖住（且 100% 不写进宽度记忆）；从盖住态拖出来；拖到很窄自己收起；大屏高占比写进记忆
 *   D  盖住态下容器缩窄仍盖住
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r9-chat-split-cover.cjs --timeout 120
 *
 * 临时 userData / 临时打包目录、窗口 show:false；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow } = require("electron");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REPO = path.resolve(__dirname, "..", "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-r9-split-"));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 320)}` : ""}`);
};
const info = (id, detail) => console.log(`SMOKE INFO ${id} ${JSON.stringify(detail).slice(0, 400)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 3) => typeof a === "number" && Math.abs(a - b) <= tol;

const HTML = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:12px sans-serif}
.hidden{display:none !important}
[data-separator]{width:6px !important;flex:0 0 6px !important;background:#999;position:relative}
[data-separator]>*{display:none !important}
[data-separator][aria-disabled="true"]{pointer-events:none}
</style><body><div id="root"></div><script src="harness.js"></script>`;

/** 打包 harness 到临时目录，返回 index.html 的 file URL 前缀 */
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
    [path.join(viteDir, "bin", "vite.js"), "build", "--config", path.join(__dirname, "layout-harness", "vite.config.mjs"), "--outDir", out],
    { cwd: REPO, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 90_000 },
  );
  if (r.status !== 0 || !fs.existsSync(path.join(out, "harness.js"))) {
    throw new Error(`harness 打包失败（exit ${r.status}）：${(r.stderr || r.stdout || "").slice(-800)}`);
  }
  fs.writeFileSync(path.join(out, "index.html"), HTML);
  return pathToFileURL(path.join(out, "index.html")).href;
};

let PAGE = "";
const open = async (query, size = [1600, 800]) => {
  const win = new BrowserWindow({ show: false, width: size[0], height: size[1], webPreferences: { sandbox: true } });
  win.webContents.on("console-message", (_e, level, msg) => {
    if (level >= 2) console.log("  [page-console]", String(msg).slice(0, 300));
  });
  await win.loadURL(`${PAGE}?${query}`);
  await sleep(500);
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

/** 读真实布局：两栏像素宽、hook 状态、对话栏内层 overflow / inert、浏览器面板是否挂载、宽度记忆 */
const SZ = `(() => {
  const r = (id) => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().width * 10) / 10 : null; };
  const p = window.pane;
  const inner = document.getElementById("chat-main").firstElementChild;
  return { main: r("chat-main"), browser: r("chat-browser"), open: p.open, covered: p.chatCovered,
    memo: window.__lib.readChatBrowserPercent(), innerOverflow: inner.style.overflow,
    chatInert: inner.firstElementChild.hasAttribute("inert"), panelMounted: !!document.getElementById("bp") };
})()`;
const SEP = `(() => { const r = document.querySelector('[data-separator]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;
const CLICK_MAX = `document.getElementById('bp-max').click()`;
const CLICK_X = `document.getElementById('bp-x').click()`;
const TOGGLE = `window.pane.toggle()`;

/** 全新页面 + 点一下「浏览器」打开（记住的宽度默认 42%，可用 pct 指定） */
const fresh = async (q = "w=1400&h=600") => {
  const c = await open(q);
  await c.ex(TOGGLE);
  await sleep(300);
  return c;
};
/** 放大并等稳定 */
const cover = async (c) => {
  await c.ex(CLICK_MAX);
  await sleep(300);
};

const run = async () => {
  PAGE = buildHarness();
  let c;
  let s;

  // ─── A：按钮路径 ───
  c = await open("w=1400&h=600");
  s = await c.ex(SZ);
  check("A1", "初始：收起、对话占满、没盖住", near(s.main, 1400) && s.browser === 0 && !s.open && !s.covered, s);
  await c.ex(TOGGLE);
  await sleep(300);
  s = await c.ex(SZ);
  check("A2", "点浏览器：开到记住的 42%（对话 ≥320、没被折叠）", s.open && !s.covered && near(s.browser, 588, 8) && s.main >= 320, s);
  await cover(c);
  s = await c.ex(SZ);
  check(
    "A3",
    "放大：浏览器占满、对话折叠成 0、盖住态为真、内层 overflow:hidden、对话子树 inert",
    s.open && s.covered && near(s.browser, 1400, 8) && s.main === 0 && s.innerOverflow === "hidden" && s.chatInert,
    s,
  );
  c.win.close();

  // 盖住态下的三个出口（R8-02：以前全部静默无效）。各自从全新页面开始，互不污染
  for (const [id, name, js] of [
    ["A4", "盖住态点面板里的「还原」→ 回到放大前的 42%（逐像素）", CLICK_MAX],
    ["A5", "盖住态点头部「浏览器」按钮 → 整栏收起、对话占满", TOGGLE],
    ["A6", "盖住态点面板里的 X → 整栏收起、对话占满", CLICK_X],
  ]) {
    c = await fresh();
    const before = await c.ex(SZ);
    await cover(c);
    await c.ex(js);
    await sleep(900);
    s = await c.ex(SZ);
    const ok =
      id === "A4"
        ? !s.covered && s.open && near(s.main, before.main, 1) && near(s.browser, before.browser, 1) && !s.chatInert && s.innerOverflow === "auto"
        : !s.open && !s.covered && near(s.main, 1400) && s.browser === 0;
    check(id, name, ok, { before: { main: before.main, browser: before.browser }, after: s });
    c.win.close();
  }

  // A7：盖住 → X 关闭 → 再点「浏览器」打开：回到记住的宽度、不盖住（不能残留盖住态）
  c = await fresh();
  const base7 = await c.ex(SZ);
  await cover(c);
  await c.ex(CLICK_X);
  await sleep(700);
  await c.ex(TOGGLE);
  await sleep(500);
  s = await c.ex(SZ);
  check("A7", "盖住 → X 关闭 → 再打开：回到记住的宽度、不盖住、对话可交互", s.open && !s.covered && !s.chatInert && near(s.main, base7.main, 2), { base: base7.main, after: s });
  c.win.close();

  // A8：放大后窗口缩窄再还原：仍夹在对话 ≥320px
  c = await fresh();
  await cover(c);
  await c.ex(`document.getElementById('box').style.width='700px'`);
  await sleep(400);
  await c.ex(CLICK_MAX);
  await sleep(700);
  s = await c.ex(SZ);
  check("A8", "放大后容器缩到 700 再还原：不盖住、对话 ≥318px、浏览器 ≥298px", s.open && !s.covered && s.main >= 318 && s.browser >= 298, s);
  c.win.close();

  // A9–A11：新提问出现时还原被盖住的对话栏（R8-05 ①，pane.revealChat 只还原、不会反过来盖住）
  c = await fresh();
  const base9 = await c.ex(SZ);
  await cover(c);
  await c.ex(`window.pane.revealChat()`);
  await sleep(700);
  s = await c.ex(SZ);
  check("A9", "盖住态下 revealChat：还原到放大前的宽度、对话可交互", !s.covered && !s.chatInert && near(s.main, base9.main, 1) && near(s.browser, base9.browser, 1), s);
  await c.ex(`window.pane.revealChat()`);
  await sleep(500);
  s = await c.ex(SZ);
  check("A10", "没盖住时 revealChat：什么都不做（不会反过来把对话盖上）", !s.covered && s.open && near(s.main, base9.main, 1), s);
  c.win.close();
  c = await open("w=1400&h=600");
  await c.ex(`window.pane.revealChat()`);
  await sleep(400);
  s = await c.ex(SZ);
  check("A11", "浏览器没开时 revealChat：什么都不做（不会把浏览器弹出来）", !s.open && !s.covered && near(s.main, 1400), s);
  c.win.close();

  // ─── B：宽度记忆比容器放得下的大 ───
  c = await fresh("w=1000&h=600&pct=85");
  s = await c.ex(SZ);
  check("B1", "点按钮打开：1000px 宽、记住 85% → 对话 ≥318px、没被折叠（夹取生效）", s.open && !s.covered && s.main >= 318 && near(s.browser, 680, 10), s);
  c.win.close();

  // 挂载即开着（切任务 / 重进聊天页）：R8-03 修之前 1000/85 → 对话 0（被盖住）
  for (const [id, w, pct] of [
    ["B2", 1000, 85],
    ["B3", 1000, 90],
    ["B4", 1400, 90],
    ["B5", 800, 76],
  ]) {
    c = await open(`w=${w}&h=600&pct=${pct}&preopen=1`);
    s = await c.ex(SZ);
    check(id, `挂载即开着：${w}px / 记住 ${pct}% → 对话 ≥318px、不盖住、浏览器 ≥298px`, s.open && !s.covered && s.main >= 318 && s.browser >= 298, s);
    c.win.close();
  }
  c = await open("w=1000&h=600&pct=42&preopen=1");
  s = await c.ex(SZ);
  check("B6", "挂载即开着：1000px / 42%（放得下）→ 按记住的比例，不被夹取改写", s.open && !s.covered && near(s.browser, 417, 8), s);
  c.win.close();

  // ─── C：真鼠标拖分隔条 ───
  c = await fresh();
  let sep = await c.ex(SEP);
  await c.drag(sep.x, sep.y, 250, sep.y);
  s = await c.ex(SZ);
  check("C1", "拖到对话只剩 250px：夹在 320px、不折叠", !s.covered && s.main >= 318 && s.main <= 330, s);
  const memoBefore = s.memo;
  sep = await c.ex(SEP);
  await c.drag(sep.x, sep.y, 100, sep.y);
  s = await c.ex(SZ);
  check("C2", "再拖到对话只剩 100px（< 320 的一半）：对话栏折叠成 0 = 盖住", s.covered && s.main === 0 && near(s.browser, 1400, 8), s);
  check("C3", "拖出来的盖住（100%）不写进宽度记忆：与拖之前一致、且 ≠ 100", s.memo === memoBefore && s.memo !== 100, { memoBefore, memoAfter: s.memo });
  sep = await c.ex(SEP);
  await c.drag(sep.x, sep.y, 700, sep.y);
  s = await c.ex(SZ);
  check("C4", "盖住态下从最左缘把分隔条拖出来：对话展开、盖住态复位", !s.covered && s.main > 300, s);
  c.win.close();

  c = await fresh();
  sep = await c.ex(SEP);
  await c.drag(sep.x, sep.y, 1380, sep.y);
  s = await c.ex(SZ);
  check("C5", "把浏览器栏拖到很窄：自己收起（open=false）、对话占满", !s.open && !s.covered && near(s.main, 1400), s);
  c.win.close();

  c = await fresh();
  sep = await c.ex(SEP);
  await c.drag(sep.x, sep.y, 330, sep.y);
  s = await c.ex(SZ);
  check("C6", "拖到大屏高占比（对话 ≈320px）：写进记忆，且 > 旧上限 70、≤ 90", s.memo > 70 && s.memo <= 90, s);
  c.win.close();

  // ─── D：窗口缩窄 ───
  c = await fresh();
  await cover(c);
  await c.ex(`document.getElementById('box').style.width='800px'`);
  await sleep(400);
  s = await c.ex(SZ);
  check("D1", "盖住态下容器缩到 800：仍盖住、浏览器占满", s.covered && near(s.browser, 794, 8) && s.main === 0, s);
  c.win.close();

  // 记录项：42% 状态下容器逐级缩窄，对话栏从多宽开始被折叠（只记录、不判定）
  c = await fresh();
  const scan = [];
  for (const w of [1100, 900, 800, 700, 640]) {
    await c.ex(`document.getElementById('box').style.width='${w}px'`);
    await sleep(350);
    const t = await c.ex(SZ);
    scan.push({ w, main: t.main, browser: t.browser, covered: t.covered });
  }
  info("D2-scan", scan.map((x) => `${x.w}:${x.main}/${x.browser}${x.covered ? "(盖住)" : ""}`).join("  "));
  c.win.close();

  // 记住的浏览器占比很大（76%）时容器一步跳窄（取消最大化 / 换显示器）：对话栏按比例掉到一半以下（约 154px，不到 160）会被库折叠成盖住态。
  // 这是预期行为（不是 bug），关键是有出口：点「还原」回到对话 320px 以上
  c = await fresh("w=1400&h=600&pct=76");
  await c.ex(`document.getElementById('box').style.width='640px'`);
  await sleep(500);
  s = await c.ex(SZ);
  check("D3", "占比 76% 时容器 1400 到 640 一步跳窄：对话栏被折叠成盖住态（预期）", s.covered && s.main === 0, s);
  await c.ex(CLICK_MAX);
  await sleep(700);
  s = await c.ex(SZ);
  check("D4", "上面这种盖住态下点「还原」：能出来（不盖住、对话 ≥318px、浏览器 ≥298px）", !s.covered && s.main >= 318 && s.browser >= 298, s);
  c.win.close();

  const failed = results.filter((x) => !x.ok);
  console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
};

app
  .whenReady()
  .then(run)
  .catch((e) => {
    console.log("SMOKE FAIL fatal", (e && e.stack) || e);
    app.exit(3);
  });
