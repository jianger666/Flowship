"use strict";
/**
 * E2·P2 探针（真 Electron 42，只经启动器跑）：确认 `setWindowOpenHandler` 的 `createWindow` 在本版本里的真实行为，
 * 再决定 tab.mjs / session.mjs 的弹窗收养怎么写。契约要求「先确认再写」，文档与 d.ts 对细节语焉不详：
 *   Q1 createWindow(options) 里 options 有什么（是否带 Chromium 已建好的 webContents）？
 *   Q2 用 new WebContentsView({ webContents: options.webContents }) 收养后，window.opener / postMessage / window.close() 是否可用？
 *   Q3 弹窗 wc 的 session / webPreferences 是否继承 opener（partition、sandbox、contextIsolation）？overrideBrowserWindowOptions 能否改 backgroundThrottling？
 *   Q4 收养后不 loadURL，Chromium 是否仍把初始导航送进这个 wc？收养瞬间就 attach debugger 会不会挂住 / 破坏初始导航？
 *   Q5 window.close() 后 wc 'destroyed' 是否触发？
 *   Q6 createWindow 被调用的时机；noopener（`rel=noopener` / features 带 noopener）时 options.webContents 是否缺省？
 *   Q7 'input-event' 是否能同步看到真实输入 / CDP Input.dispatch*（用于手势判定，免去与录制器 binding 的乱序）？
 *   Q8 handler 与「录制器 binding 事件」的先后顺序（决定能不能只靠录制器手势做同步判定）。
 *   Q9 createWindow 里不收养直接 close 弹窗 wc：是否安全（回退路径）？
 *
 *   node scripts/browser-e2e/run.mjs scripts/spikes/e2-p2-popup-probe.cjs --timeout 90
 */
const { app, BrowserWindow, WebContentsView } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-p2-probe-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("PROBE", ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))));

const mkServer = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port }));
  });

const prefsOf = (wc) => {
  const p = wc.getLastWebPreferences();
  return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity, preload: p.preload, backgroundThrottling: p.backgroundThrottling, partition: p.partition };
};

const main = async () => {
  await app.whenReady();
  let portB = 0;
  const A = await mkServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset=utf-8><title>A</title>
<button id=open style="position:absolute;left:10px;top:10px;width:200px;height:60px">open</button>
<a id=noop href="http://127.0.0.1:${portB}/cb?noopener=1" target="_blank" rel="noopener" style="position:absolute;left:10px;top:100px;width:200px;height:40px;display:block">noopener-link</a>
<a id=blank href="http://127.0.0.1:${portB}/cb?blank=1" target="_blank" style="position:absolute;left:10px;top:160px;width:200px;height:40px;display:block">blank-link</a>
<script>
window.msgs = [];
window.addEventListener('message', function(e){ window.msgs.push({ data: e.data, origin: e.origin }); });
document.getElementById('open').addEventListener('click', function(){ window.pop = window.open('http://127.0.0.1:${portB}/cb?x=1', 'oauth'); });
</script>`);
  });
  const B = await mkServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset=utf-8><title>B-cb</title>
<script>
window.__info = { hasOpener: !!window.opener, name: window.name };
try { window.opener && window.opener.postMessage({ hello: 'from-popup' }, '*'); } catch (e) { window.__info.err = String(e); }
</script>`);
  });
  portB = B.port;

  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await win.loadURL("about:blank");
  const view = new WebContentsView({
    webPreferences: { partition: "persist:p2probe", sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.showInactive();
  const wc = view.webContents;

  const inputs = [];
  wc.on("input-event", (_e, ie) => inputs.push({ via: "input-event", type: ie.type, t: Date.now(), keyCode: ie.keyCode }));

  let handlerAt = 0;
  let createWindowAt = 0;
  let createdOptions = null;
  let popView = null;
  let popWc = null;
  let mode = "adopt"; // adopt | return-and-close
  let attachInCreate = true;
  const createCalls = [];
  const handlerCalls = [];
  const popCdp = { ok: null, ms: null, err: null };
  wc.setWindowOpenHandler((details) => {
    handlerAt = Date.now();
    handlerCalls.push({ url: details.url, disposition: details.disposition, features: details.features });
    return {
      action: "allow",
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } },
      createWindow(options) {
        createWindowAt = Date.now();
        createdOptions = options;
        createCalls.push({ keys: Object.keys(options), hasWc: !!options.webContents, prefKeys: options.webPreferences ? Object.keys(options.webPreferences) : null, wp: options.webPreferences });
        if (!options.webContents) return undefined;
        if (mode === "return-and-close") {
          popWc = options.webContents;
          popWc.once("destroyed", () => log("Q9 un-adopted popup destroyed event"));
          setImmediate(() => {
            try {
              popWc.close({ waitForBeforeUnload: false });
            } catch (e) {
              log("Q9 close threw", e.message);
            }
          });
          return options.webContents;
        }
        popView = new WebContentsView({ webContents: options.webContents });
        win.contentView.addChildView(popView);
        popView.setBounds({ x: 0, y: 0, width: 400, height: 300 });
        popWc = popView.webContents;
        popWc.on("destroyed", () => log("Q5 popup wc destroyed event"));
        if (attachInCreate) {
          const t0 = Date.now();
          try {
            popWc.debugger.attach("1.3");
            Promise.all([
              popWc.debugger.sendCommand("Page.enable"),
              popWc.debugger.sendCommand("Runtime.enable"),
              popWc.debugger.sendCommand("DOM.enable"),
              popWc.debugger.sendCommand("Network.enable"),
              popWc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }),
            ])
              .then(() => {
                popCdp.ok = true;
                popCdp.ms = Date.now() - t0;
              })
              .catch((e) => {
                popCdp.ok = false;
                popCdp.err = e.message;
              });
          } catch (e) {
            popCdp.ok = false;
            popCdp.err = e.message;
          }
        }
        return options.webContents;
      },
    };
  });

  const dbg = wc.debugger;
  await wc.loadURL("about:blank");
  dbg.attach("1.3");
  const bindingEvents = [];
  dbg.on("message", (_e, method, params) => {
    if (method === "Runtime.bindingCalled") bindingEvents.push({ t: Date.now(), p: params.payload });
  });
  await dbg.sendCommand("Page.enable");
  await dbg.sendCommand("Runtime.enable");
  await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  await dbg.sendCommand("Runtime.addBinding", { name: "__rec", executionContextName: "flowship" });
  await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    worldName: "flowship",
    source: `window.addEventListener('mousedown', function(e){ if (e.isTrusted) __rec('down'); }, true); window.addEventListener('click', function(e){ if (e.isTrusted) __rec('click'); }, true);`,
  });
  await wc.loadURL(`http://127.0.0.1:${A.port}/`);
  await sleep(600);

  const evalMain = async (expression) => (await dbg.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  const click = (x, y) => {
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  };
  const cdpClick = async (x, y) => {
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const closePop = async () => {
    if (popWc && !popWc.isDestroyed()) {
      try {
        popWc.close({ waitForBeforeUnload: false });
      } catch {
        /* ignore */
      }
    }
    await sleep(200);
  };

  // ── 第一次：真实输入（sendInputEvent）点按钮 ──
  inputs.length = 0;
  bindingEvents.length = 0;
  handlerAt = 0;
  click(60, 40);
  await sleep(1500);
  log("Q1 createWindow options", createCalls[0]);
  log("Q6 handler→createWindow 间隔 ms", createWindowAt && handlerAt ? createWindowAt - handlerAt : null, "handler 入参", handlerCalls[0]);
  log("Q7 sendInputEvent 观察到的输入", inputs.map((i) => `${i.via}:${i.type}`));
  log("Q8 binding 事件 vs handler（负 = binding 先到）", bindingEvents.map((b) => `${b.p}:${b.t - handlerAt}`));
  log("Q4 attach 在 createWindow 里：CDP 就绪", popCdp);
  if (popWc && !popWc.isDestroyed()) {
    await sleep(300);
    log("Q4 popup url（没 loadURL）", popWc.getURL());
    log("Q2 popup 页内信息", await popWc.executeJavaScript("JSON.stringify(window.__info)").catch((e) => `ERR ${e.message}`));
    log("Q2 parent 收到的 message", await evalMain("JSON.stringify(window.msgs)"));
    log("Q3 session 相同？", popWc.session === wc.session);
    log("Q3 popup prefs", prefsOf(popWc));
    log("Q3 parent prefs", prefsOf(wc));
    if (popCdp.ok) {
      const r = await popWc.debugger.sendCommand("Runtime.evaluate", { expression: "location.href + ' opener=' + !!window.opener", returnByValue: true });
      log("Q4 popup CDP evaluate", r.result.value);
      const t = await popWc.debugger.sendCommand("Page.getFrameTree");
      log("Q4 popup frameTree url", t.frameTree.frame.url);
    }
    await popWc.executeJavaScript("window.close()").catch(() => {});
    await sleep(500);
    log("Q5 popWc.isDestroyed()", popWc.isDestroyed(), "parent window.pop.closed", await evalMain("window.pop && window.pop.closed"));
  } else {
    log("没有弹窗 wc");
  }

  // ── CDP 派发（AI 点击同款）──
  inputs.length = 0;
  bindingEvents.length = 0;
  handlerAt = 0;
  createWindowAt = 0;
  popWc = null;
  popCdp.ok = null;
  await cdpClick(60, 40);
  await sleep(1200);
  log("Q7 CDP 派发观察到的输入", inputs.map((i) => `${i.via}:${i.type}`));
  log("Q8 CDP 点击 binding vs handler（负 = binding 先到）", bindingEvents.map((b) => `${b.p}:${b.t - handlerAt}`));
  log("Q6 CDP 点击 popup 创建", !!popWc, "CDP 就绪", popCdp);
  await closePop();

  // ── 乱序统计：连点 16 次（交替真实输入 / CDP），统计 click-binding 是否先于 handler ──
  let bindingFirst = 0;
  let handlerFirst = 0;
  let noPop = 0;
  for (let i = 0; i < 16; i++) {
    bindingEvents.length = 0;
    handlerAt = 0;
    popWc = null;
    if (i % 2 === 0) click(60, 40);
    else await cdpClick(60, 40);
    await sleep(600);
    const click2 = bindingEvents.find((b) => b.p === "click");
    if (!handlerAt) noPop++;
    else if (click2) {
      if (click2.t <= handlerAt) bindingFirst++;
      else handlerFirst++;
    }
    await closePop();
  }
  log("Q8 16 次点击：click-binding 先于 handler", bindingFirst, "晚于 handler", handlerFirst, "没触发", noPop);

  // ── noopener 路径 ──
  for (const [id, y] of [["noop", 110], ["blank", 170]]) {
    createCalls.length = 0;
    handlerCalls.length = 0;
    popWc = null;
    click(60, y);
    await sleep(1000);
    log(`Q6 ${id} 链接：handler`, handlerCalls[0] ?? null, "createWindow", createCalls[0] ? { hasWc: createCalls[0].hasWc } : null);
    await closePop();
  }

  // ── 无手势脚本 window.open ──
  createCalls.length = 0;
  handlerCalls.length = 0;
  popWc = null;
  await evalMain(`setTimeout(function(){ window.open('http://127.0.0.1:${portB}/cb?script=1') }, 10); 1`);
  await sleep(700);
  log("无手势 window.open：handler", handlerCalls[0] ?? null, "popup 创建", !!popWc);
  await closePop();

  // ── Q9：不收养、直接返回并 close ──
  mode = "return-and-close";
  popWc = null;
  createCalls.length = 0;
  click(60, 40);
  await sleep(1200);
  log("Q9 回退路径：createWindow 调用", createCalls.length, "popWc.isDestroyed()", popWc ? popWc.isDestroyed() : null);

  A.s.close();
  B.s.close();
  try {
    win.destroy();
  } catch {
    /* ignore */
  }
  app.exit(0);
};

main().catch((e) => {
  console.error("PROBE FAIL", e);
  app.exit(1);
});
