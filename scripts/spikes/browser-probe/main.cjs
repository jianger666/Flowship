"use strict";
/**
 * 内嵌浏览器 P0 技术探针（一次性、不进主干）
 *
 * 目的：在写任何正式代码前，用实测回答 5 个会改架构的问题——
 *   T1 WebContentsView 能不能被「截图占位」替换（浮层遮挡问题）、宿主截图是否包含视图
 *   T2 CDP：无障碍树 → ref → 点击 / 输入 / 回车；页内录制器（隔离世界 + binding）在严格 CSP 与敌意页面下能否拿到用户操作
 *   T3 视图挂在可见窗口 / 隐藏窗口 / 不挂窗口（后台任务）时，截图与交互是否还正常，哪些缓解手段有效
 *   T4 server 子进程的 Node ipc 通道：ELECTRON_RUN_AS_NODE 下双向通不通、延迟、大 payload、会不会泄漏给孙进程
 *   T5 CDP 派发的输入 isTrusted 是否为 true；「AI 动作 / 用户动作」归因方案是否准确
 *   T6 iframe（跨站 OOPIF）：无障碍树 / 坐标 / 点击怎么处理
 *   T7 大页面（3000 个可交互元素）的快照耗时与体积
 *
 * 运行（agent shell 会注入 ELECTRON_RUN_AS_NODE 等变量，必须清洗，见 AGENTS.md）：
 *   env -u ELECTRON_RUN_AS_NODE -u FLOWSHIP_DATA_DIR -u FLOWSHIP_PORT -u PORT -u HOSTNAME \
 *     -u __NEXT_PRIVATE_STANDALONE_CONFIG -u __NEXT_PRIVATE_ORIGIN -u NEXT_DEPLOYMENT_ID \
 *     node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/spikes/browser-probe
 *
 * 不打开可见 UI：窗口一律 show:false，或「opacity=0 + 忽略鼠标」的透明窗口（让 Chromium 认为它可见，但用户看不到）。
 * userData 指向临时目录，不碰 Flowship 的数据与进程。
 */
const { app, BrowserWindow, WebContentsView, nativeImage } = require("electron");
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-probe-"));
app.setPath("userData", TMP);
if (process.platform === "darwin") app.dock?.hide();
// 各测试会反复建 / 毁窗口：显式声明「所有窗口关了也不退出」，避免默认行为在窗口全关时收掉 app
app.on("window-all-closed", () => {});

// ───────────────────────── 结果收集 ─────────────────────────

/** @type {Array<{ id: string, name: string, status: "PASS"|"FAIL"|"INFO"|"ERROR", detail: unknown }>} */
const results = [];
const record = (id, name, status, detail) => {
  results.push({ id, name, status, detail });
  console.log(`PROBE ${status} ${id} ${name} ${JSON.stringify(detail)}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout(${ms}ms) ${label}`)), ms)),
  ]);
const safe = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return { error: String(e?.message || e) };
  }
};

// ───────────────────────── 固定页面服务 ─────────────────────────
// A：127.0.0.1:portA（主页面，带严格 CSP：只允许同源脚本 → 内联注入会被挡）
// B：localhost:portB（iframe 内容；与 A 不同 site → 站点隔离下是 OOPIF）

const startFixture = () =>
  new Promise((resolve) => {
    const serverB = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html><body style="margin:0"><button id="fbtn" style="margin:8px">框架内按钮</button>` +
          `<script>document.getElementById('fbtn').onclick=()=>parent.postMessage('framed-click','*')</script></body></html>`,
      );
    });
    serverB.listen(0, "127.0.0.1", () => {
      const portB = serverB.address().port;
      const serverA = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        if (u.pathname === "/page.js") {
          res.setHeader("content-type", "application/javascript");
          res.end(`
window.__clicks = 0; window.__submitted = null; window.__frameClicks = 0; window.__swallowClicks = 0;
document.getElementById('btn').addEventListener('click', () => { window.__clicks++; });
document.getElementById('swallow').addEventListener('click', (e) => { e.stopPropagation(); window.__swallowClicks++; });
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.__submitted = document.getElementById('q').value; });
window.addEventListener('message', (e) => { if (e.data === 'framed-click') window.__frameClicks++; });
// 敌意页面：事后把 addEventListener 废掉（录制器先于页面脚本注册，应不受影响）
EventTarget.prototype.addEventListener = function () {};
`);
          return;
        }
        if (u.pathname === "/big") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          let body = "";
          for (let i = 0; i < 1500; i++) body += `<div><button>按钮 ${i}</button> <a href="#a${i}">链接 ${i}</a></div>`;
          for (let i = 0; i < 500; i++) body += `<p>段落 ${i} 一些不可交互的文本内容。</p>`;
          res.end(`<!doctype html><html><body>${body}</body></html>`);
          return;
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader(
          "content-security-policy",
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://localhost:${portB}`,
        );
        res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>probe</title>
<style>html{background:#f00}body{margin:0;font:14px sans-serif}#top{position:absolute;left:0;top:0;padding:8px;background:#fff;width:400px}</style></head>
<body><div id="top">
<h1>Probe</h1>
<button id="btn">提交订单</button> <a id="lnk" href="#x">更多链接</a>
<div id="custom" role="button" tabindex="0">自定义按钮</div>
<button id="swallow">吞事件按钮</button>
<form id="f"><input id="q" aria-label="搜索框"><button type="submit">搜索</button></form>
<input id="txt" type="text" aria-label="用户名"><input id="pwd" type="password" aria-label="密码">
<iframe id="fr" src="http://localhost:${portB}/frame" title="子框架" width="380" height="60"></iframe>
</div><script src="/page.js"></script></body></html>`);
      });
      serverA.listen(0, "127.0.0.1", () => {
        const portA = serverA.address().port;
        resolve({
          url: `http://127.0.0.1:${portA}/`,
          bigUrl: `http://127.0.0.1:${portA}/big`,
          close: () => {
            serverA.close();
            serverB.close();
          },
        });
      });
    });
  });

// ───────────────────────── CDP 小工具（就是将来正式层的雏形） ─────────────────────────

const makeCdp = (wc) => {
  const listeners = new Set();
  wc.debugger.attach("1.3");
  wc.debugger.on("message", (_e, method, params, sessionId) => {
    for (const l of listeners) l(method, params, sessionId);
  });
  const send = (method, params, sessionId) =>
    sessionId ? wc.debugger.sendCommand(method, params ?? {}, sessionId) : wc.debugger.sendCommand(method, params ?? {});
  const on = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  /** 在主世界（或指定 contextId）求值，返回 value；异常抛出 */
  const ev = async (expression, contextId, sessionId) => {
    const r = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  return { send, on, ev, detach: () => safe(() => wc.debugger.detach()) };
};

const pixelInfo = (img) => {
  if (!img || img.isEmpty()) return { empty: true };
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  const x = width - 6;
  const y = height - 6;
  const idx = (y * width + x) * 4;
  const b = bmp[idx];
  const g = bmp[idx + 1];
  const r = bmp[idx + 2];
  return { w: width, h: height, rgb: [r, g, b], isRed: r > 200 && g < 70 && b < 70 };
};

// ───────────────────────── 测试台：窗口 + 视图 ─────────────────────────

/** mode: visible（透明但「可见」的窗口）| hidden（show:false）| detached（视图不挂任何窗口） */
const createRig = async (mode, url, bounds) => {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, partition: "persist:probe" },
  });
  let win = null;
  if (mode !== "detached") {
    win = new BrowserWindow({
      width: 900,
      height: 700,
      show: false,
      skipTaskbar: true,
      webPreferences: { sandbox: true },
    });
    await win.loadURL("data:text/html,<body style='margin:0;background:%2300ff00'></body>");
    win.contentView.addChildView(view);
    view.setBounds(bounds ?? { x: 0, y: 0, width: 900, height: 700 });
    if (mode === "visible") {
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
      win.showInactive();
      await sleep(300);
    }
  }
  await view.webContents.loadURL(url);
  const cdp = makeCdp(view.webContents);
  return {
    mode,
    win,
    view,
    wc: view.webContents,
    cdp,
    teardown: async () => {
      await cdp.detach();
      safe(() => view.webContents.close());
      if (win && !win.isDestroyed()) win.destroy();
    },
  };
};

const centerOf = async (cdp, id) => {
  const r = await cdp.ev(
    `(() => { const b = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  return r;
};

const cdpClickAt = async (cdp, x, y, sessionId) => {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
};

// ───────────────────────── T4：Node ipc 通道 ─────────────────────────

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of [
    "ELECTRON_RUN_AS_NODE",
    "FLOWSHIP_DATA_DIR",
    "FLOWSHIP_PORT",
    "PORT",
    "HOSTNAME",
    "__NEXT_PRIVATE_STANDALONE_CONFIG",
    "__NEXT_PRIVATE_ORIGIN",
    "NEXT_DEPLOYMENT_ID",
  ])
    delete env[k];
  return env;
};

const probeIpc = async (variant) => {
  // variant: "unix"（stdin ignore，对应真 server 在 mac/linux 的 stdio）| "win-like"（stdin pipe，对应 win32 的 stdio）
  const stdio = [variant === "win-like" ? "pipe" : "ignore", "pipe", "pipe", "ipc"];
  const child = spawn(process.execPath, [path.join(__dirname, "ipc-child.cjs")], {
    env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: "1" },
    stdio,
    detached: variant === "unix" && process.platform !== "win32", // 真 server 在 unix 是 detached（setsid）
    windowsHide: true,
  });
  child.stdin?.on("error", () => {});
  const out = {};
  const waiters = [];
  child.on("message", (m) => {
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.res(m);
    }
  });
  const waitMsg = (pred, ms = 5000) =>
    withTimeout(new Promise((res) => waiters.push({ pred, res })), ms, "ipc message");
  try {
    const ready = await waitMsg((m) => m.type === "ready");
    out.ready = ready;

    // 往返延迟：500 次小消息
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 500; i++) {
      const p = waitMsg((m) => m.type === "echo" && m.n === i);
      child.send({ type: "echo", n: i });
      await p;
    }
    out.smallRoundTripAvgMs = Number(process.hrtime.bigint() - t0) / 1e6 / 500;

    // 大 payload：一张 3MB 的 base64「截图」往返
    const big = "A".repeat(3 * 1024 * 1024);
    const t1 = Date.now();
    const p = waitMsg((m) => m.type === "echo" && m.n === 9999, 15000);
    child.send({ type: "echo", n: 9999, payload: big });
    const echoed = await p;
    out.bigPayloadMs = Date.now() - t1;
    out.bigPayloadOk = echoed.size === big.length;

    // 孙进程是否继承 NODE_CHANNEL_FD / process.send
    const gp = waitMsg((m) => m.type === "grandchild");
    child.send({ type: "grandchild" });
    out.grandchild = (await gp).out;

    // 通道关闭 / 子进程退出时主进程能感知
    const exited = new Promise((res) => child.once("exit", (code, signal) => res({ code, signal })));
    child.send({ type: "exit" });
    out.exit = await withTimeout(exited, 5000, "child exit");
    return out;
  } finally {
    safe(() => child.kill("SIGKILL"));
  }
};

// ───────────────────────── 快照构造（AX tree → 文本 + ref） ─────────────────────────

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "option",
  "listbox",
  "heading",
]);

const buildSnapshot = (nodes) => {
  const refs = new Map(); // ref -> { backendNodeId, role, name }
  const lines = [];
  let n = 0;
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value;
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const name = String(node.name?.value ?? "");
    if (role !== "heading" && !node.backendDOMNodeId) continue;
    const ref = `e${++n}`;
    refs.set(ref, { backendNodeId: node.backendDOMNodeId, role, name });
    lines.push(`${role} "${name}" [ref=${ref}]`);
  }
  const text = lines.join("\n");
  return { text, refs, lineCount: lines.length, bytes: Buffer.byteLength(text) };
};

const findRef = (snap, role, name) => {
  for (const [ref, v] of snap.refs) if (v.role === role && v.name === name) return { ref, ...v };
  return null;
};

const refCenter = async (cdp, backendNodeId, sessionId) => {
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId);
  const { quads } = await cdp.send("DOM.getContentQuads", { backendNodeId }, sessionId);
  const q = quads[0];
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
};

// ───────────────────────── 各测试 ─────────────────────────

const runT3Matrix = async (fixture) => {
  // 视图挂在三种位置下，加上逐步叠加的缓解手段，看哪些指标正常
  const measure = async (rig) => {
    const { wc, cdp } = rig;
    const m = {};
    m.visibility = await safe(() => cdp.ev("document.visibilityState + '|focus=' + document.hasFocus()"));
    m.raf400ms = await safe(() =>
      withTimeout(
        cdp.ev(
          `new Promise(r => { let n = 0; const end = performance.now() + 400; const f = () => { n++; performance.now() < end ? requestAnimationFrame(f) : r(n); }; requestAnimationFrame(f); setTimeout(() => r(-n), 1500); })`,
        ),
        4000,
        "raf",
      ),
    );
    m.timers20Ms = await safe(() =>
      cdp.ev(
        `new Promise(async r => { const t = performance.now(); for (let i = 0; i < 20; i++) await new Promise(s => setTimeout(s, 0)); r(Math.round(performance.now() - t)); })`,
      ),
    );
    m.cdpShot = await safe(async () => {
      const t = Date.now();
      const r = await withTimeout(cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }), 4000, "cdpShot");
      const img = nativeImage.createFromBuffer(Buffer.from(r.data, "base64"));
      return { ms: Date.now() - t, kb: Math.round((r.data.length * 0.75) / 1024), ...pixelInfo(img) };
    });
    m.capturePage = await safe(async () => {
      const t = Date.now();
      const img = await withTimeout(wc.capturePage(), 4000, "capturePage");
      return { ms: Date.now() - t, ...pixelInfo(img) };
    });
    m.capturePageStay = await safe(async () => {
      const t = Date.now();
      const img = await withTimeout(wc.capturePage(undefined, { stayHidden: true, stayAwake: true }), 4000, "capturePageStay");
      return { ms: Date.now() - t, ...pixelInfo(img) };
    });
    m.cdpClickWorks = await safe(async () => {
      const before = await cdp.ev("window.__clicks");
      const c = await centerOf(cdp, "btn");
      await withTimeout(cdpClickAt(cdp, c.x, c.y), 4000, "cdpClick");
      await sleep(100);
      return (await cdp.ev("window.__clicks")) - before === 1;
    });
    return m;
  };

  const matrix = {};
  for (const mode of ["visible", "hidden", "detached"]) {
    const rig = await createRig(mode, fixture.url);
    try {
      await rig.cdp.send("Page.enable");
      await rig.cdp.send("Runtime.enable");
      const steps = [
        ["none", async () => {}],
        ["+backgroundThrottling=false", async () => rig.wc.setBackgroundThrottling(false)],
        ["+focusEmulation", async () => rig.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })],
        ["+lifecycleActive", async () => rig.cdp.send("Page.setWebLifecycleState", { state: "active" })],
      ];
      matrix[mode] = {};
      for (const [label, apply] of steps) {
        const applied = await safe(apply);
        matrix[mode][label] = { applyError: applied?.error, ...(await measure(rig)) };
      }
    } finally {
      await rig.teardown();
    }
  }
  return matrix;
};

const runT1 = async (fixture) => {
  // 宿主窗口铺绿色，视图（红色页）只盖右半；验证 ①宿主截图是否包含视图 ②视图自己的截图能拿到红色
  const rig = await createRig("visible", fixture.url, { x: 450, y: 0, width: 450, height: 700 });
  try {
    await sleep(300);
    const hostImg = await withTimeout(rig.win.webContents.capturePage(), 4000, "host capturePage");
    const hostSize = hostImg.getSize();
    const bmp = hostImg.toBitmap();
    const sample = (xRatio, yRatio) => {
      const x = Math.floor(hostSize.width * xRatio);
      const y = Math.floor(hostSize.height * yRatio);
      const i = (y * hostSize.width + x) * 4;
      return [bmp[i + 2], bmp[i + 1], bmp[i]];
    };
    const viewImg = await withTimeout(rig.wc.capturePage(), 4000, "view capturePage");
    // 置换式浮层方案的关键动作：视图截图 → setVisible(false) → 再 setVisible(true)
    rig.view.setVisible(false);
    await sleep(100);
    const hiddenOk = rig.view.getVisible() === false;
    rig.view.setVisible(true);
    await sleep(100);
    return {
      hostRightHalfPixelRGB: sample(0.9, 0.9),
      hostLeftHalfPixelRGB: sample(0.1, 0.9),
      viewCapture: pixelInfo(viewImg),
      setVisibleToggle: hiddenOk && rig.view.getVisible() === true,
    };
  } finally {
    await rig.teardown();
  }
};

const runT2T5T6 = async (fixture) => {
  const rig = await createRig("visible", fixture.url);
  const { cdp, wc } = rig;
  const out = { t2: {}, t5: {}, t6: {} };
  try {
    const recorded = [];
    const ctx = { id: null }; // 录制器所在隔离世界的 contextId（主 frame）
    let mainFrameId = null;
    const attached = []; // Target.attachedToTarget 事件

    cdp.on((method, params, sessionId) => {
      if (method === "Runtime.bindingCalled" && params.name === "__fsRec" && !sessionId) {
        try {
          recorded.push(JSON.parse(params.payload));
        } catch {
          /* 忽略坏载荷 */
        }
      } else if (method === "Runtime.executionContextCreated" && !sessionId) {
        const c = params.context;
        if (c.name === "flowship-rec" && (!mainFrameId || c.auxData?.frameId === mainFrameId)) ctx.id = c.id;
      } else if (method === "Target.attachedToTarget") {
        attached.push({ sessionId: params.sessionId, type: params.targetInfo?.type, url: params.targetInfo?.url });
      } else if (method === "Target.detachedFromTarget") {
        // 页面重载 / 导航后旧 iframe 会话即失效：只保留活着的
        const i = attached.findIndex((a) => a.sessionId === params.sessionId);
        if (i >= 0) attached.splice(i, 1);
      }
    });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const tree = await cdp.send("Page.getFrameTree");
    mainFrameId = tree.frameTree.frame.id;

    // 录制器：隔离世界 + binding；严格 CSP 的页面里内联脚本会被挡，这里验证它不受影响
    const recorderSource = `(() => {
  if (window.__fsRecInstalled) return;
  window.__fsRecInstalled = true;
  window.__fsAgent = 0;
  const emit = (o) => { try { __fsRec(JSON.stringify(o)); } catch (_) {} };
  const desc = (el) => ({ tag: el && el.tagName, id: (el && el.id) || undefined });
  const base = (e) => ({ type: e.type, trusted: e.isTrusted, by: window.__fsAgent ? 'agent' : 'user', target: desc(e.target) });
  addEventListener('click', (e) => emit({ ...base(e), x: e.clientX, y: e.clientY }), true);
  addEventListener('input', (e) => { const t = e.target; emit({ ...base(e), masked: t.type === 'password', len: (t.value || '').length, value: t.type === 'password' ? undefined : t.value }); }, true);
  addEventListener('keydown', (e) => emit({ ...base(e), key: e.key }), true);
  addEventListener('submit', (e) => emit({ ...base(e) }), true);
})();`;
    await cdp.send("Runtime.addBinding", { name: "__fsRec", executionContextName: "flowship-rec" });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: recorderSource, worldName: "flowship-rec" });
    await wc.loadURL(fixture.url);
    await sleep(500);

    out.t2.recorderInstalledInIsolatedWorld = ctx.id
      ? await safe(() => cdp.ev("typeof window.__fsRecInstalled", ctx.id))
      : "no-context";
    out.t2.recorderVisibleToPage = await cdp.ev("typeof window.__fsRecInstalled + '|' + typeof window.__fsRec");
    out.t2.cspBlocksInlineInMainWorld = await cdp.ev(
      `new Promise(r => { try { r(String(eval('1+1'))); } catch (e) { r('blocked:' + e.name); } })`,
    );

    // ── 快照 ──
    const t0 = Date.now();
    const ax = await cdp.send("Accessibility.getFullAXTree");
    const snap = buildSnapshot(ax.nodes);
    out.t2.snapshotMs = Date.now() - t0;
    out.t2.snapshotLines = snap.lineCount;
    out.t2.snapshotSample = snap.text.split("\n").slice(0, 12);
    const submitBtn = findRef(snap, "button", "提交订单");
    const customBtn = findRef(snap, "button", "自定义按钮");
    const userBox = findRef(snap, "textbox", "用户名");
    const pwdBox = findRef(snap, "textbox", "密码");
    const searchBox = findRef(snap, "textbox", "搜索框");
    out.t2.refsFound = {
      submitBtn: !!submitBtn,
      customRoleButton: !!customBtn,
      userBox: !!userBox,
      pwdBox: !!pwdBox,
      searchBox: !!searchBox,
    };

    const asAgent = async (fn) => {
      await cdp.ev("window.__fsAgent = 1", ctx.id);
      try {
        return await fn();
      } finally {
        await cdp.ev("window.__fsAgent = 0", ctx.id);
      }
    };

    // ── 点击（按 ref） ──
    const beforeClicks = await cdp.ev("window.__clicks");
    await asAgent(async () => {
      const c = await refCenter(cdp, submitBtn.backendNodeId);
      await cdpClickAt(cdp, c.x, c.y);
    });
    await sleep(150);
    out.t2.clickByRefWorks = (await cdp.ev("window.__clicks")) - beforeClicks === 1;

    // ── 输入（按 ref）+ 密码不泄漏 ──
    await asAgent(async () => {
      await cdp.send("DOM.focus", { backendNodeId: userBox.backendNodeId });
      await cdp.send("Input.insertText", { text: "hello" });
      await cdp.send("DOM.focus", { backendNodeId: pwdBox.backendNodeId });
      await cdp.send("Input.insertText", { text: "s3cret-PASSWORD" });
    });
    await sleep(150);
    out.t2.typeByRefWorks = (await cdp.ev("document.getElementById('txt').value")) === "hello";
    out.t2.passwordLeakedInRecorder = JSON.stringify(recorded).includes("s3cret-PASSWORD");
    out.t2.passwordEventMasked = recorded.some((e) => e.type === "input" && e.target?.id === "pwd" && e.masked === true);

    // ── 回车提交（按键） ──
    await asAgent(async () => {
      await cdp.send("DOM.focus", { backendNodeId: searchBox.backendNodeId });
      await cdp.send("Input.insertText", { text: "abc" });
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          ...(type === "keyDown" ? { text: "\r" } : {}),
        });
      }
    });
    await sleep(150);
    out.t2.enterSubmitsForm = (await cdp.ev("window.__submitted")) === "abc";

    // ── 自定义 role=button（div）：能否点中 ──
    out.t2.customRoleButtonClickable = !!customBtn;

    // ── 敌意页面：事件被 stopPropagation，录制器仍应收到 ──
    const swallowCenter = await centerOf(cdp, "swallow");
    const n0 = recorded.length;
    wc.sendInputEvent({ type: "mouseDown", x: swallowCenter.x, y: swallowCenter.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: swallowCenter.x, y: swallowCenter.y, button: "left", clickCount: 1 });
    await sleep(300);
    out.t2.recorderSeesStopPropagationClick = recorded
      .slice(n0)
      .some((e) => e.type === "click" && e.target?.id === "swallow");
    out.t2.pageHandlerStillRanForSwallow = (await cdp.ev("window.__swallowClicks")) >= 1;

    // ── T5：isTrusted + 归因准确率 ──
    const btnC = await centerOf(cdp, "btn");
    const N = 40;
    let wrong = 0;
    const trustedStat = { user: [], agent: [] };
    for (let i = 0; i < N; i++) {
      const isAgent = i % 2 === 1;
      const before = recorded.length;
      if (isAgent) {
        await asAgent(() => cdpClickAt(cdp, btnC.x, btnC.y));
      } else {
        wc.sendInputEvent({ type: "mouseDown", x: btnC.x, y: btnC.y, button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseUp", x: btnC.x, y: btnC.y, button: "left", clickCount: 1 });
      }
      const deadline = Date.now() + 2000;
      while (recorded.slice(before).filter((e) => e.type === "click").length < 1 && Date.now() < deadline) await sleep(10);
      const ev = recorded.slice(before).find((e) => e.type === "click");
      if (!ev) {
        wrong++;
        continue;
      }
      trustedStat[isAgent ? "agent" : "user"].push(ev.trusted);
      if ((isAgent ? "agent" : "user") !== ev.by) wrong++;
    }
    out.t5.sequentialSamples = N;
    out.t5.sequentialMisattributed = wrong;
    out.t5.cdpClickIsTrusted = trustedStat.agent.every((v) => v === true);
    out.t5.sendInputIsTrusted = trustedStat.user.every((v) => v === true);

    // 对抗：用户点击紧贴着 AI 动作发出（不 await），量化竞态窗口（真实产品里有玻璃层锁住用户，不会这样）
    let overlapWrong = 0;
    const M = 30;
    for (let i = 0; i < M; i++) {
      const before = recorded.length;
      wc.sendInputEvent({ type: "mouseDown", x: btnC.x, y: btnC.y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: btnC.x, y: btnC.y, button: "left", clickCount: 1 });
      await asAgent(() => cdpClickAt(cdp, btnC.x, btnC.y));
      await sleep(80);
      const clicks = recorded.slice(before).filter((e) => e.type === "click");
      const byUser = clicks.filter((e) => e.by === "user").length;
      const byAgent = clicks.filter((e) => e.by === "agent").length;
      if (!(byUser === 1 && byAgent === 1)) overlapWrong++;
    }
    out.t5.overlapSamples = M;
    out.t5.overlapMisattributed = overlapWrong;

    // ── T6：iframe（跨站 OOPIF） ──
    await sleep(300);
    const frameTargets = attached.filter((a) => a.type === "iframe");
    out.t6.attachedIframeTargets = frameTargets.length;
    out.t6.mainTreeContainsFramedButton = !!findRef(snap, "button", "框架内按钮");
    if (frameTargets[0]) {
      const sid = frameTargets[0].sessionId;
      await safe(() => cdp.send("Accessibility.enable", {}, sid));
      const fax = await safe(() => cdp.send("Accessibility.getFullAXTree", {}, sid));
      if (fax.error) {
        out.t6.childSessionAxError = fax.error;
      } else {
        const fsnap = buildSnapshot(fax.nodes);
        const fbtn = findRef(fsnap, "button", "框架内按钮");
        out.t6.childTreeContainsFramedButton = !!fbtn;
        if (fbtn) {
          await safe(() => cdp.send("DOM.enable", {}, sid));
          const local = await refCenter(cdp, fbtn.backendNodeId, sid);
          const frameRect = await cdp.ev(
            `(() => { const b = document.getElementById('fr').getBoundingClientRect(); return { x: b.x, y: b.y }; })()`,
          );
          out.t6.childQuadLocal = local;
          const before = await cdp.ev("window.__frameClicks");
          await cdpClickAt(cdp, frameRect.x + local.x, frameRect.y + local.y);
          await sleep(200);
          out.t6.clickIntoOopifWorks = (await cdp.ev("window.__frameClicks")) - before === 1;
        }
      }
    }
    out.t2.recordedEventCount = recorded.length;
    return out;
  } finally {
    await rig.teardown();
  }
};

const runT7 = async (fixture) => {
  const rig = await createRig("visible", fixture.bigUrl);
  try {
    await rig.cdp.send("Accessibility.enable");
    const t = Date.now();
    const ax = await rig.cdp.send("Accessibility.getFullAXTree");
    const ms = Date.now() - t;
    const snap = buildSnapshot(ax.nodes);
    return { axNodes: ax.nodes.length, getFullAXTreeMs: ms, snapshotLines: snap.lineCount, snapshotKB: Math.round(snap.bytes / 1024) };
  } finally {
    await rig.teardown();
  }
};

/**
 * T8：后台任务的「停车场」方案——视图平时挂在一个隐藏窗口里（保持可渲染 / 可截图 / 可交互），
 * 任务页打开时搬到主窗口，离开时搬回。验证：搬移后页面状态是否保留、setVisible(false) 的影响、
 * 多视图并发驱动、每个视图的内存成本。
 */
const runT8 = async (fixture) => {
  const out = { reparent: {}, setVisible: {}, multi: {} };
  const parking = new BrowserWindow({ width: 900, height: 700, show: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } });
  await parking.loadURL("data:text/html,<body></body>");
  const stage = new BrowserWindow({ width: 900, height: 700, show: false, skipTaskbar: true });
  await stage.loadURL("data:text/html,<body style='background:%2300ff00'></body>");
  stage.setOpacity(0);
  stage.setIgnoreMouseEvents(true);
  stage.showInactive();
  await sleep(300);

  const mk = async () => {
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, partition: "persist:probe", backgroundThrottling: false },
    });
    parking.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    await view.webContents.loadURL(fixture.url);
    const cdp = makeCdp(view.webContents);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    return { view, cdp, wc: view.webContents };
  };
  const health = async (r) => {
    const h = {};
    h.visibility = await safe(() => r.cdp.ev("document.visibilityState"));
    h.timers20Ms = await safe(() =>
      r.cdp.ev(`new Promise(async res => { const t = performance.now(); for (let i = 0; i < 20; i++) await new Promise(s => setTimeout(s, 0)); res(Math.round(performance.now() - t)); })`),
    );
    h.shot = await safe(async () => {
      const img = await withTimeout(r.wc.capturePage(), 4000, "capturePage");
      return pixelInfo(img).isRed === true ? "ok-red" : "BAD";
    });
    h.click = await safe(async () => {
      const before = await r.cdp.ev("window.__clicks");
      const c = await centerOf(r.cdp, "btn");
      await withTimeout(cdpClickAt(r.cdp, c.x, c.y), 4000, "click");
      await sleep(80);
      return (await r.cdp.ev("window.__clicks")) - before === 1;
    });
    return h;
  };

  try {
    const r1 = await mk();
    out.reparent.parked = await health(r1);
    await r1.cdp.ev("window.__marker = 42; document.getElementById('txt').value = 'kept';");

    stage.contentView.addChildView(r1.view); // 搬到「前台」窗口
    r1.view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    await sleep(300);
    out.reparent.removedFromParkingAutomatically = !parking.contentView.children.includes(r1.view);
    out.reparent.stateKept = await r1.cdp.ev("(window.__marker === 42) && document.getElementById('txt').value === 'kept'");
    out.reparent.onStage = await health(r1);

    r1.view.setVisible(false); // 前台窗口里「隐藏但仍挂着」
    await sleep(300);
    out.setVisible.hiddenOnStage = await health(r1);
    r1.view.setVisible(true);

    parking.contentView.addChildView(r1.view); // 搬回停车场
    r1.view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    await sleep(300);
    out.reparent.backToParking = await health(r1);
    out.reparent.stateKeptAfterRoundTrip = await r1.cdp.ev("(window.__marker === 42) && document.getElementById('txt').value === 'kept'");

    // ── 多视图并发 + 内存 ──
    const rendererKB = () =>
      app
        .getAppMetrics()
        .filter((m) => m.type === "Tab")
        .reduce((s, m) => s + (m.memory?.workingSetSize ?? 0), 0);
    const rendererCount = () => app.getAppMetrics().filter((m) => m.type === "Tab").length;
    const baseKB = rendererKB();
    const baseCount = rendererCount();
    const rigs = [r1];
    for (let i = 0; i < 4; i++) rigs.push(await mk());
    await sleep(800);
    out.multi.views = rigs.length;
    out.multi.rendererProcessesAdded = rendererCount() - baseCount;
    out.multi.rendererMBAdded = Math.round((rendererKB() - baseKB) / 1024);
    const t0 = Date.now();
    const clicked = await Promise.all(
      rigs.map(async (r) => {
        const before = await r.cdp.ev("window.__clicks");
        const c = await centerOf(r.cdp, "btn");
        await cdpClickAt(r.cdp, c.x, c.y);
        await sleep(80);
        return (await r.cdp.ev("window.__clicks")) - before === 1;
      }),
    );
    out.multi.concurrentClicksAllOk = clicked.every(Boolean);
    out.multi.concurrentMs = Date.now() - t0;
    for (const r of rigs) {
      await r.cdp.detach();
      safe(() => r.wc.close());
    }
    return out;
  } finally {
    if (!stage.isDestroyed()) stage.destroy();
    if (!parking.isDestroyed()) parking.destroy();
  }
};

/**
 * T9：AI 操作期间怎么锁住「用户输入」。
 * 原生视图盖在 HTML 之上，React 里的透明玻璃层挡不住它——验证 CDP Input.setIgnoreInputEvents 能否
 * 只挡用户（sendInputEvent）、不挡 AI（Input.dispatch*）。
 */
const runT9 = async (fixture) => {
  const rig = await createRig("visible", fixture.url);
  const { cdp, wc } = rig;
  const out = {};
  try {
    await cdp.send("Page.enable");
    const c = await centerOf(cdp, "btn");
    const clicks = () => cdp.ev("window.__clicks");
    const userClick = async () => {
      const before = await clicks();
      wc.sendInputEvent({ type: "mouseDown", x: c.x, y: c.y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: c.x, y: c.y, button: "left", clickCount: 1 });
      await sleep(150);
      return (await clicks()) - before;
    };
    const agentClick = async () => {
      const before = await clicks();
      await cdpClickAt(cdp, c.x, c.y);
      await sleep(150);
      return (await clicks()) - before;
    };
    const userType = async (ch) => {
      await cdp.ev("document.getElementById('txt').focus(); document.getElementById('txt').value = '';");
      wc.sendInputEvent({ type: "keyDown", keyCode: ch });
      wc.sendInputEvent({ type: "char", keyCode: ch });
      wc.sendInputEvent({ type: "keyUp", keyCode: ch });
      await sleep(150);
      return cdp.ev("document.getElementById('txt').value");
    };
    const agentType = async (text) => {
      await cdp.ev("document.getElementById('txt').focus(); document.getElementById('txt').value = '';");
      await cdp.send("Input.insertText", { text });
      await sleep(100);
      return cdp.ev("document.getElementById('txt').value");
    };

    out.baseline = { userClick: await userClick(), agentClick: await agentClick(), userType: await userType("a"), agentType: await agentType("z") };
    const r = await safe(() => cdp.send("Input.setIgnoreInputEvents", { ignore: true }));
    out.setIgnoreResult = r?.error ? r : "ok";
    out.locked = { userClick: await userClick(), agentClick: await agentClick(), userType: await userType("b"), agentType: await agentType("y") };
    await safe(() => cdp.send("Input.setIgnoreInputEvents", { ignore: false }));
    out.unlocked = { userClick: await userClick(), agentClick: await agentClick(), userType: await userType("c") };

    // 锁在页面导航后是否仍然有效（决定每次 did-navigate 要不要重新上锁）
    await cdp.send("Input.setIgnoreInputEvents", { ignore: true });
    await wc.loadURL(fixture.url);
    await sleep(300);
    const c2 = await centerOf(cdp, "btn");
    wc.sendInputEvent({ type: "mouseDown", x: c2.x, y: c2.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: c2.x, y: c2.y, button: "left", clickCount: 1 });
    await sleep(150);
    out.lockPersistsAcrossNavigation = (await cdp.ev("window.__clicks")) === 0;
    await cdp.send("Input.setIgnoreInputEvents", { ignore: false });
    return out;
  } finally {
    await rig.teardown();
  }
};

// ───────────────────────── 主流程 ─────────────────────────

const main = async () => {
  const watchdog = setTimeout(() => {
    console.log("PROBE ERROR watchdog 120s 超时、强制退出");
    app.exit(2);
  }, 120_000);

  await app.whenReady();
  const fixture = await startFixture();
  const meta = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
  };
  record("META", "运行环境", "INFO", meta);

  // PROBE_ONLY=T1,T3 只跑指定测试（排查用）
  const only = process.env.PROBE_ONLY ? process.env.PROBE_ONLY.split(",") : null;
  const run = async (id, name, fn, judge) => {
    if (only && !only.some((o) => id.startsWith(o))) return;
    try {
      const detail = await fn();
      record(id, name, judge ? judge(detail) : "INFO", detail);
    } catch (e) {
      record(id, name, "ERROR", String(e?.stack || e));
    }
  };

  await run("T4a", "ipc 通道（unix 形态 stdio）", () => probeIpc("unix"), (d) =>
    d.bigPayloadOk && d.exit?.code === 0 && d.grandchild?.includes('"fd":null') ? "PASS" : "FAIL",
  );
  await run("T4b", "ipc 通道（win32 形态 stdio：stdin=pipe）", () => probeIpc("win-like"), (d) =>
    d.bigPayloadOk && d.exit?.code === 0 ? "PASS" : "FAIL",
  );
  await run("T1", "视图截图占位 / 宿主截图是否含视图", () => runT1(fixture));
  await run("T2/5/6", "CDP 快照 / 点击 / 输入 / 录制器 / 归因 / iframe", () => runT2T5T6(fixture));
  await run("T3", "视图挂载位置 × 缓解手段 矩阵", () => runT3Matrix(fixture));
  await run("T7", "大页面快照", () => runT7(fixture));
  await run("T8", "停车场：搬移 / 并发 / 内存", () => runT8(fixture));
  await run("T9", "AI 操作时锁用户输入", () => runT9(fixture));

  fs.writeFileSync(path.join(os.tmpdir(), "flowship-browser-probe-result.json"), JSON.stringify(results, null, 2));
  console.log(`PROBE DONE 结果已写入 ${path.join(os.tmpdir(), "flowship-browser-probe-result.json")}`);
  clearTimeout(watchdog);
  fixture.close();
  app.exit(0);
};

main().catch((e) => {
  console.log(`PROBE ERROR main ${String(e?.stack || e)}`);
  app.exit(1);
});
