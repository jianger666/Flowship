"use strict";
/**
 * R17 回归（真 Electron + 真 react-resizable-panels 4.11.1 + 真鼠标）：任务页分栏「哪一栏被收起」的记忆与恢复
 * （用户 2026-11-12：「这个展开收起的状态麻烦也记一下，不然每次切回来就又展开了」）。
 *
 * 这类「库命令式语义」在 node 里没有布局、测不出来（tests/task-split-memory.test.ts 只能测记忆读写与源码接线），
 * 所以用 vite 把真的 ResizablePanelGroup / ResizablePanel / ResizableHandle + 真的 src/lib/task-split-memory 打成页面
 * （照 page.tsx 的结构摆，见 split-restore-harness/harness.tsx），放进无头 Electron 窗口量真实像素、发真鼠标。
 * vite 来自 vitest 的依赖（不是项目直接依赖），脚本自己定位、以 ELECTRON_RUN_AS_NODE 起子进程打包到临时目录——不往仓库里写产物。
 *
 * 断言：
 *   A  默认（没有记忆）：两栏都展开、按默认比例（70/30），记忆为空
 *   B  产物栏收起 → 重新挂载（= 切走再切回）：挂载后产物栏宽 0、事件流占满，记忆没被恢复动作冲掉；再点分栏按钮 → 回到默认比例、记忆清空
 *   C  事件流收起（放大）→ 重新挂载：事件流宽 0、产物 / 浏览器占满；再点分栏按钮 → 回到分栏、记忆清空
 *   D  窄窗口（900px）带记忆挂载：仍然收起
 *   E  恢复后浏览器标签的像素下限（minSize 20% → 300px）生效：栏仍然收着、不被库弹开；再展开能 ≥ 下限
 *   F  真鼠标拖分隔条：拖到事件流下限一半以下自动折叠 → 记下 event-stream；拖回来 → 清掉；
 *      拖到产物栏下限一半以下 → 记下 artifact；拖回来 → 清掉
 *   G  没有用户意图的折叠（容器缩窄，库自己折叠）不写记忆
 *   H  损坏的记忆（脏 JSON）挂载：照常两栏展开、不抛
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r17-task-split-restore.cjs --timeout 120
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-r17-split-"));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 360)}` : ""}`);
};
const info = (id, detail) => console.log(`SMOKE INFO ${id} ${JSON.stringify(detail).slice(0, 400)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 6) => typeof a === "number" && Math.abs(a - b) <= tol;

const HTML = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:12px sans-serif}
[data-separator]{width:6px !important;flex:0 0 6px !important;background:#999;position:relative}
[data-separator]>*{display:none !important}
</style><body><div id="root"></div><script src="harness.js"></script>`;

/** 打包 harness 到临时目录，返回 index.html 的 file URL */
const buildHarness = () => {
  const req = createRequire(require.resolve("vitest/package.json", { paths: [REPO] }));
  let viteDir;
  try {
    viteDir = path.dirname(req.resolve("vite/package.json"));
  } catch {
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
    [path.join(viteDir, "bin", "vite.js"), "build", "--config", path.join(__dirname, "split-restore-harness", "vite.config.mjs"), "--outDir", out],
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
    if (level >= 3) console.log("  [page-console]", String(msg).slice(0, 300));
  });
  await win.loadURL(`${PAGE}?${query}`);
  await sleep(500);
  const ex = (js) => win.webContents.executeJavaScript(js, true);
  /** 切走再切回 = 页面重新挂载，记忆（localStorage）保留 */
  const remount = async (q) => {
    await win.loadURL(`${PAGE}?${q}`);
    await sleep(500);
  };
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
    await sleep(350);
  };
  return { win, ex, drag, remount };
};

/** 读真实布局：两栏像素宽、React 里的折叠态、记忆、恢复动作的返回值 */
const SZ = `(() => {
  const r = (id) => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().width * 10) / 10 : null; };
  const st = window.__h.state();
  return { artifact: r('artifact'), event: r('event-stream'), aCol: st.artifactCollapsed, eCol: st.eventStreamCollapsed,
    memo: window.__h.memo(), restore: window.__restoreResult === undefined ? null : window.__restoreResult };
})()`;
const SEP = `(() => { const r = document.querySelector('[data-separator]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;
const TOGGLE = `window.__h.toggleSplit()`;
const MAXIMIZE = `window.__h.toggleMaximize()`;

const run = async () => {
  PAGE = buildHarness();
  let c;
  let s;

  // ─── A：默认 ───
  c = await open("w=1400");
  s = await c.ex(SZ);
  check("A1", "没有记忆：两栏都展开、按默认 70/30、记忆为空", !s.aCol && !s.eCol && near(s.artifact, 976, 12) && near(s.event, 418, 12) && s.memo === null, s);
  c.win.close();

  // ─── B：产物栏收起 → 重新挂载 ───
  c = await open("w=1400");
  const act = await c.ex(TOGGLE);
  await sleep(300);
  s = await c.ex(SZ);
  check("B1", "点分栏按钮收起产物栏：产物栏 0、事件流占满、记忆 = artifact", act === "collapse-artifact" && s.artifact === 0 && near(s.event, 1394, 8) && s.aCol && s.memo === "artifact", { act, ...s });
  await c.remount("w=1400&keep=1");
  s = await c.ex(SZ);
  check(
    "B2",
    "重新挂载（切走再切回）：挂载后产物栏 0、事件流占满、React 里的折叠态同步、恢复动作返回 true、记忆没被冲掉",
    s.artifact === 0 && near(s.event, 1394, 8) && s.aCol && !s.eCol && s.restore === true && s.memo === "artifact",
    s,
  );
  const act2 = await c.ex(TOGGLE);
  await sleep(400);
  s = await c.ex(SZ);
  check("B3", "恢复后的收起态再点分栏按钮：展开回默认 70/30、记忆清空", act2 === "expand-artifact" && !s.aCol && near(s.artifact, 976, 14) && near(s.event, 418, 14) && s.memo === null, { act2, ...s });
  await c.remount("w=1400&keep=1");
  s = await c.ex(SZ);
  check("B4", "展开之后再次重新挂载：两栏都展开（记忆已清，不会再收起）", !s.aCol && !s.eCol && near(s.artifact, 976, 12) && s.restore === null, s);
  c.win.close();

  // ─── C：事件流收起（放大）→ 重新挂载 ───
  c = await open("w=1400");
  await c.ex(MAXIMIZE);
  await sleep(300);
  s = await c.ex(SZ);
  check("C1", "放大（折叠事件流）：事件流 0、产物 / 浏览器占满、记忆 = event-stream", s.event === 0 && near(s.artifact, 1394, 8) && s.eCol && s.memo === "event-stream", s);
  await c.remount("w=1400&keep=1");
  s = await c.ex(SZ);
  check("C2", "重新挂载：事件流 0、产物 / 浏览器占满、恢复动作返回 true、记忆没被冲掉", s.event === 0 && near(s.artifact, 1394, 8) && s.eCol && !s.aCol && s.restore === true && s.memo === "event-stream", s);
  const act3 = await c.ex(TOGGLE);
  await sleep(400);
  s = await c.ex(SZ);
  check("C3", "恢复后的收起态点分栏按钮：回到分栏（事件流 ≥ 下限 320px）、记忆清空", act3 === "expand-event-stream" && !s.eCol && s.event >= 318 && s.artifact > 300 && s.memo === null, { act3, ...s });
  c.win.close();

  // ─── D：窄窗口带记忆挂载 ───
  c = await open("w=900&memo=artifact");
  s = await c.ex(SZ);
  check("D1", "900px 窄窗口带「产物栏收起」记忆挂载：产物栏 0、事件流占满", s.artifact === 0 && near(s.event, 894, 8) && s.aCol && s.restore === true, s);
  c.win.close();
  c = await open("w=900&memo=event-stream");
  s = await c.ex(SZ);
  check("D2", "900px 窄窗口带「事件流收起」记忆挂载：事件流 0、产物 / 浏览器占满", s.event === 0 && near(s.artifact, 894, 8) && s.eCol && s.restore === true, s);
  c.win.close();

  // ─── E：恢复后换成浏览器标签的像素下限 ───
  c = await open("w=1000&memo=artifact");
  s = await c.ex(SZ);
  const collapsedBefore = s.artifact === 0 && s.aCol;
  await c.ex(`window.__h.setBrowserTab(true)`);
  await sleep(500);
  s = await c.ex(SZ);
  check("E1", "收起态下 minSize 从 20% 换成 300px：栏仍然收着（库不会把它弹开）", collapsedBefore && s.artifact === 0 && s.aCol && s.memo === "artifact", s);
  await c.ex(TOGGLE);
  await sleep(500);
  s = await c.ex(SZ);
  check("E2", "此时再点分栏按钮展开：栏宽 ≥ 浏览器下限 298px、事件流 ≥ 318px、记忆清空", !s.aCol && s.artifact >= 298 && s.event >= 318 && s.memo === null, s);
  c.win.close();

  // ─── F：真鼠标拖分隔条 ───
  c = await open("w=1400");
  let sep = await c.ex(SEP);
  await c.drag(sep.x, sep.y, 1340, sep.y);
  s = await c.ex(SZ);
  check("F1", "把分隔条拖到事件流只剩 ~60px（< 下限 320 的一半）：事件流自动折叠、记忆 = event-stream", s.event === 0 && s.eCol && s.memo === "event-stream", s);
  sep = await c.ex(SEP);
  await c.drag(sep.x, sep.y, 900, sep.y);
  s = await c.ex(SZ);
  check("F2", "再把它从右缘拖出来：事件流展开、记忆清掉", !s.eCol && s.event >= 318 && s.memo === null, s);
  sep = await c.ex(SEP);
  await c.drag(sep.x, sep.y, 60, sep.y);
  s = await c.ex(SZ);
  check("F3", "把分隔条拖到产物栏只剩 ~60px（< 下限 20% 的一半）：产物栏自动折叠、记忆 = artifact", s.artifact === 0 && s.aCol && s.memo === "artifact", s);
  await c.remount("w=1400&keep=1");
  s = await c.ex(SZ);
  check("F4", "拖出来的折叠态也会在重新挂载后恢复", s.artifact === 0 && s.aCol && s.restore === true, s);
  sep = await c.ex(SEP);
  await c.drag(sep.x, sep.y, 700, sep.y);
  s = await c.ex(SZ);
  check("F5", "从最左缘把分隔条拖出来：产物栏展开、记忆清掉", !s.aCol && s.artifact > 250 && s.memo === null, s);
  c.win.close();

  // ─── G：没有用户意图的折叠不写记忆 ───
  c = await open("w=1400");
  await c.ex(`document.getElementById('box').style.width='500px'`);
  await sleep(600);
  s = await c.ex(SZ);
  info("G-scan", { artifact: s.artifact, event: s.event, aCol: s.aCol, eCol: s.eCol, memo: s.memo });
  check("G1", "容器从 1400 缩到 500（没有鼠标操作）：库若自己折叠了某一栏，也不写记忆", s.memo === null, s);
  c.win.close();

  // ─── H：损坏的记忆 ───
  c = await open("w=1400&keep=1");
  await c.ex(`localStorage.setItem("flowship.task-split-collapsed", "{oops")`);
  await c.remount("w=1400&keep=1");
  s = await c.ex(SZ);
  check("H1", "记忆是脏 JSON：挂载照常两栏展开、不抛", !s.aCol && !s.eCol && near(s.artifact, 976, 12) && s.memo === null, s);
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
