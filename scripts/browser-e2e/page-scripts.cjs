"use strict";
/**
 * R 组独立无头 e2e：验证 page-scripts.mjs 的录制器 + 覆盖层在真实 Chromium 里的行为。
 *
 * 参照探针 scripts/spikes/browser-probe/main.cjs 的做法：临时 userData、窗口 show:false
 * 起步（随后 opacity=0 显示以免隐藏窗口节流）、本地 http fixture（随机端口）、
 * 用 webContents.debugger 注入隔离世界脚本、用 webContents.sendInputEvent 模拟真实用户输入。
 * 不启动 Flowship / FlowshipTest、不碰 8676/8776/8876。
 *
 * 运行（必须清洗宿主注入的环境变量，见 AGENTS.md）：
 *   env -u ELECTRON_RUN_AS_NODE -u FLOWSHIP_DATA_DIR -u FLOWSHIP_PORT -u PORT -u HOSTNAME \
 *     -u __NEXT_PRIVATE_STANDALONE_CONFIG -u __NEXT_PRIVATE_ORIGIN -u NEXT_DEPLOYMENT_ID \
 *     node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/browser-e2e/page-scripts.cjs
 */
const { app, BrowserWindow, WebContentsView } = require("electron");
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

// 被测模块是 ESM（electron-app 为 type:module），CJS 侧只能读文件后动态 import；
// 这里直接读源码文本在主进程里取导出是不行的（主进程是 CJS 上下文跑 Electron 时可 dynamic import）
let buildPageScript;
let RECORDER_BINDING;
let PAGE_WORLD_NAME;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2e-"));
app.setPath("userData", TMP);
if (process.platform === "darwin") app.dock?.hide();
app.on("window-all-closed", () => {});

const results = [];
const record = (id, name, ok, detail) => {
  results.push({ id, name, ok });
  console.log(`E2E ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return { error: String(e?.message || e) };
  }
};
async function waitFor(pred, ms = 4000, label = "") {
  const t0 = Date.now();
  for (;;) {
    const v = await safe(pred);
    if (v && !v.error) return v;
    if (Date.now() - t0 > ms) throw new Error(`waitFor 超时 ${label}`);
    await sleep(50);
  }
}

/**
 * 轮询到 pred 为真或超时（不抛错，返回是否成立）。给「触发后事件要过一两帧才到」的断言用：
 * 机器忙 / 窗口刚显示时渲染被节流，固定 sleep(300~400) 偶发不够（评审后一次全量里 scroll / oopif-click 各丢过一次），
 * 轮询只放宽「等多久」，断言本身不放松——事件始终不来照样红。
 */
async function settle(pred, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = await safe(pred);
    if (v && !v.error) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(50);
  }
}

// ───────────────────────── fixture ─────────────────────────
function startFixture() {
  return new Promise((resolve) => {
    const serverB = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html><body style="margin:0"><button id="fbtn" style="margin:8px">框架内按钮</button>` +
          `<script>document.getElementById('fbtn').onclick=function(){parent.postMessage('framed-click','*');};</script></body></html>`,
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
document.getElementById('btn').addEventListener('click', function(){ window.__clicks++; });
document.getElementById('swallow').addEventListener('click', function(e){ e.stopPropagation(); window.__swallowClicks++; });
document.getElementById('f').addEventListener('submit', function(e){ e.preventDefault(); window.__submitted = document.getElementById('q').value; });
window.addEventListener('message', function(e){ if (e.data === 'framed-click') window.__frameClicks++; });
// 敌意动作：页面脚本最后把 addEventListener 废掉（录制器先注册、且在隔离世界，应不受影响）
EventTarget.prototype.addEventListener = function () {};
`);
          return;
        }
        if (u.pathname === "/style.css") {
          res.setHeader("content-type", "text/css");
          res.end(
            `body{margin:0;font:14px sans-serif}#top{position:absolute;left:0;top:0;padding:8px;width:500px}` +
              `#spacer{height:2600px}`,
          );
          return;
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        // 严格 CSP：脚本/样式都只许同源、且 style-src 没有 unsafe-inline
        res.setHeader(
          "content-security-policy",
          `default-src 'self'; script-src 'self'; style-src 'self'; frame-src http://localhost:${portB}`,
        );
        res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>e2e</title><link rel="stylesheet" href="/style.css"></head>
<body><div id="top">
<h1>E2E</h1>
<button id="btn">提交订单</button> <a id="lnk" href="#x">更多链接</a>
<button id="swallow">吞事件按钮</button>
<form id="f"><input id="q" aria-label="搜索框"><button type="submit">搜索</button></form>
<label>用户名 <input id="txt" type="text"></label>
<input id="pwd" type="password" aria-label="密码">
<input id="otp" type="text" autocomplete="one-time-code" aria-label="验证码">
<select id="city" aria-label="城市"><option value="">请选择</option><option value="bj">北京</option><option value="sh">上海</option></select>
<label><input id="agree" type="checkbox"> 同意条款</label>
<label id="lbl" for="hidchk" style="display:inline-block;margin:4px">转发标签</label><input id="hidchk" type="checkbox" hidden>
<textarea id="ghost" aria-label="幽灵框" style="position:absolute;left:-9999px;top:0;width:40px;height:20px"></textarea>
<textarea id="ghost2" aria-label="幽灵框二" style="position:absolute;left:-9999px;top:30px;width:40px;height:20px"></textarea>
<div id="editor" contenteditable="true" style="min-height:24px;border:1px solid #ccc">我的私密草稿：银行卡 6222-0000</div>
<iframe id="fr" src="http://localhost:${portB}/frame" title="子框架" width="380" height="60"></iframe>
</div><div id="spacer"></div><script src="/page.js"></script></body></html>`);
      });
      serverA.listen(0, "127.0.0.1", () => {
        resolve({
          url: `http://127.0.0.1:${serverA.address().port}/`,
          close: () => {
            serverA.close();
            serverB.close();
          },
        });
      });
    });
  });
}

async function main() {
  const watchdog = setTimeout(() => {
    console.log("E2E FAIL watchdog 超时");
    app.exit(2);
  }, 120000);

  const mod = await import(path.join(__dirname, "../../electron-app/browser/page-scripts.mjs"));
  buildPageScript = mod.buildPageScript;
  RECORDER_BINDING = mod.RECORDER_BINDING;
  PAGE_WORLD_NAME = mod.PAGE_WORLD_NAME;
  const source = buildPageScript();

  await app.whenReady();
  const fixture = await startFixture();

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    skipTaskbar: true,
    // 与产品一致（index.mjs 的停车场窗口 / tab.mjs 的视图都是 backgroundThrottling:false）：窗口被系统判定为遮挡 / 不可见时仍要出帧。
    // 夹具曾经没设，于是机器上有别的窗口盖住它时整个渲染生命周期停摆——滚动事件不派发（scroll 步骤）、
    // OOPIF 的命中测试数据不更新（oopif-click 步骤点击根本送不进子文档），表现成「偶发 / 只在某个时段」的失败
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  await win.loadURL("data:text/html,<body></body>");
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, partition: "persist:e2e-page-scripts", backgroundThrottling: false },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.showInactive();
  const wc = view.webContents;
  // 探针顺序：先让 view 加载一次再 attach debugger，空白 view 的 target 会在首次导航时被替换
  await wc.loadURL(fixture.url);

  const recorded = []; // 主 frame 录制事件
  const childRecorded = []; // OOPIF 子 frame 录制事件
  let mainFrameId = null;
  let mainCtx = null; // 主 frame 隔离世界 contextId
  const childCtx = new Map(); // sessionId -> 隔离世界 contextId
  const childSetup = new Map(); // sessionId -> Promise

  wc.debugger.attach("1.3");
  const send = (method, params, sessionId) =>
    sessionId
      ? wc.debugger.sendCommand(method, params ?? {}, sessionId)
      : wc.debugger.sendCommand(method, params ?? {});
  const ev = async (expression, contextId, sessionId) => {
    const r = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };

  wc.debugger.on("message", (_e, method, params, sessionId) => {
    if (method === "Runtime.bindingCalled" && params.name === RECORDER_BINDING) {
      try {
        const item = JSON.parse(params.payload);
        if (sessionId) childRecorded.push(item);
        else recorded.push(item);
      } catch {
        /* 坏载荷忽略 */
      }
    } else if (method === "Runtime.executionContextCreated") {
      const c = params.context;
      if (c.name === PAGE_WORLD_NAME) {
        if (sessionId) childCtx.set(sessionId, c.id);
        else if (!mainFrameId || c.auxData?.frameId === mainFrameId) mainCtx = c.id;
      }
    } else if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      const sid = params.sessionId;
      // OOPIF 是独立会话：binding 与注入脚本都要在子会话里再装一遍
      childSetup.set(
        sid,
        (async () => {
          await safe(() => send("Runtime.enable", {}, sid));
          await safe(() => send("Page.enable", {}, sid));
          await safe(() =>
            send("Runtime.addBinding", { name: RECORDER_BINDING, executionContextName: PAGE_WORLD_NAME }, sid),
          );
          await safe(() =>
            send("Page.addScriptToEvaluateOnNewDocument", { source, worldName: PAGE_WORLD_NAME }, sid),
          );
        })(),
      );
    } else if (method === "Target.detachedFromTarget") {
      childCtx.delete(params.sessionId);
      childSetup.delete(params.sessionId);
    }
  });

  const centerOf = (id) =>
    ev(
      `(() => { const b = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
    );
  const userClick = async (x, y) => {
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    await sleep(180);
  };
  const cdpClick = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(180);
  };
  const inIsolated = (expr) => ev(expr, mainCtx);
  const since = (arr, n, type, pred) =>
    arr.slice(n).filter((e) => (!type || e.type === type) && (!pred || pred(e)));

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    // 与产品 tab.mjs 一致：让页面始终认为自己有焦点。锁屏 / 熄屏 / 被别的窗口盖住时窗口被系统判成遮挡（visibilityState=hidden、
    // 无焦点），不开它主 frame 的真实点击 / 按键全部送不进页面（整套主 frame 用例红，只有 oopif-click 绿）
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    mainFrameId = (await send("Page.getFrameTree")).frameTree.frame.id;
    await send("Runtime.addBinding", { name: RECORDER_BINDING, executionContextName: PAGE_WORLD_NAME });
    await send("Page.addScriptToEvaluateOnNewDocument", { source, worldName: PAGE_WORLD_NAME });
    // 第一次加载只是为了让 debugger 能 attach，这里重新加载一次让注入脚本生效
    await wc.loadURL(fixture.url);
    await waitFor(async () => (mainCtx && (await inIsolated("typeof __flowship")) === "object") || null, 5000, "隔离世界装好");

    // 1 ── 严格 CSP 页里录制器装上了、且主世界看不见它
    record(
      "recorder-install",
      "隔离世界录制器安装成功且页面主世界不可见",
      (await inIsolated("typeof __flowship.setAI")) === "function" &&
        (await ev("typeof window.__flowship")) === "undefined" &&
        // R1-04：binding 只绑到隔离世界（executionContextName），页面主世界看不到 __flowshipRec，也枚举不到任何 flowship 相关全局
        (await ev(`typeof window.${RECORDER_BINDING}`)) === "undefined" &&
        (await ev(`Object.getOwnPropertyNames(window).filter((k) => /flowship/i.test(k)).length`)) === 0 &&
        (await inIsolated(`typeof ${RECORDER_BINDING}`)) === "function",
    );

    // 2 ── 真实用户点击被录到（目标描述/归因/frame）
    // 冷启动时（首次起 Electron、窗口 opacity=0 刚显示）紧接着 sendInputEvent 偶发被吞，先等页面与窗口稳定一下
    await sleep(500);
    let mark = recorded.length;
    let c = await centerOf("btn");
    await userClick(c.x, c.y);
    let evts = since(recorded, mark, "click");
    record(
      "user-click",
      "真实点击被录到（role/name/ai:false/frame:main）",
      evts.length === 1 &&
        evts[0].ai === false &&
        evts[0].frame === "main" &&
        evts[0].target?.role === "button" &&
        evts[0].target?.name === "提交订单",
      evts[0],
    );

    // 3 ── 页面 stopPropagation 的点击仍被录到
    mark = recorded.length;
    c = await centerOf("swallow");
    await userClick(c.x, c.y);
    evts = since(recorded, mark, "click", (e) => e.target?.name === "吞事件按钮");
    record(
      "stop-propagation",
      "页面 stopPropagation 后点击仍被录到",
      evts.length === 1 && (await ev("window.__swallowClicks")) >= 1,
    );

    // 4 ── 页面已废掉 addEventListener，录制器仍能录（上两步已在其后发生，这里显式钉住页面状态）
    const hostile = await ev(
      `(() => { let threw = false; try { document.body.addEventListener('click', () => {}); } catch (e) { threw = true; } return { src: String(EventTarget.prototype.addEventListener).slice(0, 40) }; })()`,
    );
    mark = recorded.length;
    c = await centerOf("lnk");
    await userClick(c.x, c.y);
    evts = since(recorded, mark, "click");
    record(
      "hostile-addEventListener",
      "页面废掉 addEventListener 后录制器仍工作",
      hostile && evts.length === 1 && evts[0].target?.role === "link",
      hostile,
    );

    // 5 ── 密码/验证码不泄值；普通框默认不带 value、configure(true) 后带
    await ev(`document.getElementById('pwd').focus()`);
    await send("Input.insertText", { text: "s3cret-PASSWORD" });
    await ev(`document.getElementById('otp').focus()`);
    await send("Input.insertText", { text: "123456" });
    await ev(`document.getElementById('txt').focus()`);
    await send("Input.insertText", { text: "hello" });
    await sleep(200);
    const pwdEvt = recorded.filter((e) => e.type === "input" && e.target?.isPassword).slice(-2);
    const txtEvt = recorded.filter((e) => e.type === "input" && e.target?.fieldName === "txt").pop();
    const leaked = JSON.stringify(recorded).includes("s3cret-PASSWORD");
    record(
      "password-masked",
      "密码框与验证码框不发 value、只发 isPassword+valueLength",
      !leaked &&
        pwdEvt.length >= 1 &&
        pwdEvt.every((e) => e.value === undefined && typeof e.valueLength === "number") &&
        !!txtEvt &&
        txtEvt.value === undefined,
      { pwdEvt, txtEvt },
    );

    await inIsolated(`__flowship.configure({ recordValues: true })`);
    await ev(`document.getElementById('txt').focus(); document.getElementById('txt').value='';`);
    mark = recorded.length;
    await send("Input.insertText", { text: "world" });
    await sleep(200);
    const withVal = since(recorded, mark, "input").pop();
    await inIsolated(`__flowship.configure({ recordValues: false })`);
    record(
      "record-values-toggle",
      "configure({recordValues:true}) 后非密码框带 value",
      !!withVal && withVal.value === "world" && withVal.valueLength === 5,
      withVal,
    );

    // 6 ── setAI 归因
    await inIsolated(`__flowship.setAI(true)`);
    mark = recorded.length;
    c = await centerOf("btn");
    await cdpClick(c.x, c.y);
    await inIsolated(`__flowship.setAI(false)`);
    const aiEvts = since(recorded, mark, "click");
    mark = recorded.length;
    await userClick(c.x, c.y);
    const userEvts = since(recorded, mark, "click");
    record(
      "ai-attribution",
      "setAI(true) 期间事件带 ai:true、之后为 false",
      aiEvts.length >= 1 && aiEvts.every((e) => e.ai === true) && userEvts.length === 1 && userEvts[0].ai === false,
      { ai: aiEvts[0]?.ai, user: userEvts[0]?.ai },
    );

    // 7 ── 滚动节流 + ratio
    mark = recorded.length;
    await ev(`window.scrollTo(0, 1500)`);
    await settle(() => since(recorded, mark, "scroll").length >= 1);
    const scrolls = since(recorded, mark, "scroll");
    record(
      "scroll",
      "滚动被录到且 ratio 在 (0,1]",
      scrolls.length >= 1 && scrolls[0].scroll.ratio > 0 && scrolls[0].scroll.ratio <= 1,
      scrolls[0],
    );
    await ev(`window.scrollTo(0, 0)`);

    // 8 ── 回车提交 + 键盘事件
    await ev(`document.getElementById('q').focus()`);
    await send("Input.insertText", { text: "abc" });
    mark = recorded.length;
    wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    wc.sendInputEvent({ type: "char", keyCode: "\r" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await sleep(250);
    const keys = since(recorded, mark, "key", (e) => e.key === "Enter");
    record(
      "key-submit",
      "Enter 键被录到且触发了表单提交",
      keys.length >= 1 && (await ev("window.__submitted")) === "abc",
      keys[0],
    );

    // 9 ── 复选框选择：用 CDP 的真实鼠标输入（Input.dispatchMouseEvent 产生的 click / change 是 trusted）。
    //     以前这里用页面脚本派发合成 change，现在录制器按 isTrusted 过滤，合成事件不会再被录到（见第 9b 步）。
    mark = recorded.length;
    c = await centerOf("agree");
    await cdpClick(c.x, c.y);
    await sleep(200);
    const selEvts = since(recorded, mark, "select");
    record(
      "checkbox-change",
      "真实点击复选框被录为 select 事件（trusted change）",
      selEvts.length === 1 && selEvts[0].target?.name === "同意条款" && (await ev("document.getElementById('agree').checked")) === true,
      selEvts[0],
    );

    // 9b ── 页面脚本派发的合成键盘 / 点击 / 输入 / 提交 / 滚动 / 聚焦事件一律不产生活动条目（R1-04 isTrusted）
    await sleep(1200); // 令牌桶补满，排除限流造成的假通过
    mark = recorded.length;
    await ev(
      `(() => {
        const b = document.getElementById('btn');
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        b.click();
        b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        b.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
        const t = document.getElementById('txt');
        t.dispatchEvent(new Event('input', { bubbles: true }));
        t.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('city').dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('agree').dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('f').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        document.getElementById('q').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        window.dispatchEvent(new Event('scroll'));
        document.dispatchEvent(new Event('scroll'));
        return true;
      })()`,
    );
    await sleep(400);
    const forged = since(recorded, mark);
    record("synthetic-ignored", "页面脚本派发的合成键盘 / 点击 / 输入 / 提交 / 滚动 / 聚焦事件不产生录制事件", forged.length === 0, forged);

    // 9b2 ── R2-05：UA 自己派发的 trusted 事件也不能伪造操作记录。
    //     `checkbox.click()` 引出的 change、`form.requestSubmit()` 引出的 submit、`el.focus()` 引出的 focusin 都是 isTrusted === true，
    //     但此前 1 秒内没有真实的 pointer / key 输入（上一步已睡过 ≥1.6 秒）→ 不应有 select / submit / focus 条目；
    //     紧接着用 CDP 真实鼠标点一次复选框（正控）→ 必须有 select，证明闸不是把 change 整个关了
    await sleep(1200);
    mark = recorded.length;
    await ev(
      `(() => {
        window.__submitted = null;
        document.getElementById('agree').click();
        document.getElementById('f').requestSubmit();
        document.getElementById('q').focus();
        return true;
      })()`,
    );
    await sleep(400);
    const uaForged = since(recorded, mark).filter((e) => e.type === "select" || e.type === "submit" || e.type === "focus");
    record(
      "ua-dispatched-ignored",
      "checkbox.click() / form.requestSubmit() / el.focus()（UA 派发的 trusted change / submit / focusin）在无真实输入时不产生 select / submit / focus 条目",
      uaForged.length === 0 && (await ev("window.__submitted")) === "abc", // 页面的 submit 处理器确实跑了（requestSubmit 没被校验拦掉）
      since(recorded, mark),
    );
    mark = recorded.length;
    c = await centerOf("agree");
    await cdpClick(c.x, c.y);
    await sleep(200);
    const uaControl = since(recorded, mark, "select");
    record(
      "ua-control-real-click",
      "正控：紧接着真实鼠标点复选框，select 条目照常产生（闸没有把 change 整个关掉）",
      uaControl.length === 1 && uaControl[0].target?.name === "同意条款",
      uaControl[0],
    );

    // 9b3 ── R3-01：`<label for>` 的默认行为会让 UA 给关联控件转发一个 click（疑似 isTrusted === true），关联控件可以是 display:none 的 checkbox。
    //     页面无需任何真实输入就能 `label.click()`——这个转发出去的 click / 随之而来的 change 不能被当成「用户手势」（否则击穿新标签激活闸 / 下载手势闸 / 录制器门槛）。
    //     先把转发事件的 isTrusted 原样记下来（真机取值），再断言无真实输入时录制器完全不出 click / select / key；正控：真实点 label 照常有 click 条目。
    await sleep(1200);
    await ev(
      `(() => {
        window.__fwd = [];
        const c = document.getElementById('hidchk');
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'change', 'input']) c['on' + t] = (e) => window.__fwd.push([t, e.isTrusted]);
        return true;
      })()`,
    );
    mark = recorded.length;
    await ev(`document.getElementById('lbl').click()`);
    await sleep(400);
    const fwdRaw = await ev("window.__fwd");
    const fwdForged = since(recorded, mark).filter((e) => e.type === "click" || e.type === "select" || e.type === "key" || e.type === "input" || e.type === "submit");
    console.log("INFO label.click() 转发到关联控件的事件（类型, isTrusted）：" + JSON.stringify(fwdRaw));
    record(
      "label-forward-ignored",
      "页面脚本 label.click() 让 UA 转发给隐藏 checkbox 的 click / change（真机取值见上一行 INFO）在无真实输入时不产生 click / select 等录制条目",
      // R4-04 ⑤：正控——转发事件确实到了（fwdRaw 非空且含 click）。否则「没有录到」可能只是 label.click() 根本没转发（环境差异），断言就空转了
      Array.isArray(fwdRaw) && fwdRaw.length > 0 && fwdRaw.some((e) => e[0] === "click") && fwdForged.length === 0,
      { fwdRaw, recorded: since(recorded, mark) },
    );
    await sleep(1200);
    mark = recorded.length;
    c = await centerOf("lbl");
    await cdpClick(c.x, c.y);
    await sleep(300);
    const lblReal = since(recorded, mark, "click");
    record(
      "label-forward-real-click",
      "正控：真实鼠标点 label，click 条目照常产生（闸没有把 click 整个关掉）",
      lblReal.length >= 1,
      since(recorded, mark),
    );

    // 9b4 ── R3-04：页面对自己的隐藏 textarea `execCommand('insertText')`，UA 派发的 input / beforeinput 是 trusted（先把真机取值记下来）；
    //     无真实输入时录制器不能因此产生「用户输入」条目，也不能耗尽令牌（交替两个不同目标，各来 30 次，再验证紧接着的真实点击仍被录到）。
    //     正控：用户真点这个框、再真打字（CDP keyDown 带 text）→ 有 input 条目。
    await sleep(1200);
    await ev(
      `(() => {
        window.__fwdIn = [];
        for (const id of ['ghost', 'ghost2']) {
          const t = document.getElementById(id);
          t.oninput = (e) => window.__fwdIn.push([id, 'input', e.isTrusted]);
          t.onbeforeinput = (e) => window.__fwdIn.push([id, 'beforeinput', e.isTrusted]);
        }
        return true;
      })()`,
    );
    mark = recorded.length;
    await ev(
      `(() => {
        for (let i = 0; i < 30; i++) {
          for (const id of ['ghost', 'ghost2']) {
            const t = document.getElementById(id);
            t.focus();
            document.execCommand('insertText', false, 'x');
          }
        }
        return true;
      })()`,
    );
    await sleep(500);
    const fwdInRaw = (await ev("window.__fwdIn")) || [];
    const ghostForged = since(recorded, mark).filter((e) => e.type === "input");
    console.log("INFO execCommand('insertText') 派发的事件（框, 类型, isTrusted）前 4 条：" + JSON.stringify(fwdInRaw.slice(0, 4)) + `，共 ${fwdInRaw.length} 条`);
    record(
      "ua-dispatched-input-ignored",
      "页面 execCommand('insertText') 让 UA 派发的 trusted input 在无真实输入时不产生 input 条目（真机取值见上一行 INFO）",
      ghostForged.length === 0 && fwdInRaw.length > 0,
      { ghostForged: ghostForged.length, fwdInRaw: fwdInRaw.length },
    );
    mark = recorded.length;
    c = await centerOf("btn");
    await cdpClick(c.x, c.y);
    await sleep(200);
    record(
      "ua-input-flood-no-starve",
      "伪造 input 洪水之后，紧接着的真实点击仍被录到（令牌没被耗尽）",
      since(recorded, mark, "click").length >= 1,
      since(recorded, mark),
    );

    // 9c ── contenteditable 的正文不会被当成可访问名写进录制事件（R1-05）
    mark = recorded.length;
    c = await centerOf("editor");
    await userClick(c.x, c.y);
    const edClick = since(recorded, mark, "click").pop();
    record(
      "editable-name",
      "点击 contenteditable：target.name 不含正文",
      !!edClick && edClick.target?.role === "textbox" && !edClick.target?.name && !JSON.stringify(edClick).includes("私密"),
      edClick,
    );

    // 9d ── 按键不泄漏字符（R1-03）：真实的 Alt+@（Option 输入）/ 单字符键 / 密码框里的 Enter 都不外发；Ctrl+a 与 Enter 在普通框外发
    const realKey = async (params) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    };
    await sleep(1200);
    mark = recorded.length;
    await ev(`document.getElementById('pwd').focus()`);
    await realKey({ key: "@", code: "Digit2", modifiers: 1, text: "@" }); // Alt+@
    await realKey({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); // 密码框里的 Enter 也不留痕
    await ev(`document.getElementById('txt').focus()`);
    await realKey({ key: "x", code: "KeyX", text: "x" }); // 单字符
    await realKey({ key: "@", code: "Digit2", modifiers: 1, text: "@" }); // 普通框里的 Alt+@ 同样不带字符
    await sleep(300);
    const noLeak = since(recorded, mark, "key");
    record("key-no-leak", "Alt+@ / 单字符 / 密码框 Enter 不产生 key 事件，录制载荷里没有 @ 或 x 字符键", noLeak.length === 0, noLeak);
    mark = recorded.length;
    await realKey({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 }); // Ctrl+a
    await realKey({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await sleep(300);
    const okKeys = since(recorded, mark, "key");
    record(
      "key-whitelist",
      "普通框里 Ctrl+a 与 Enter 照常外发",
      okKeys.some((e) => e.key === "a" && (e.modifiers || []).includes("Control")) && okKeys.some((e) => e.key === "Enter"),
      okKeys,
    );

    // 9e ── 令牌桶限流（R1-04）：真实输入（trusted）疯狂连发也只放过有限条，不会冲掉日志
    await sleep(1200);
    mark = recorded.length;
    // 并发派发（突发压到毫秒级）：逐个 await 的话，慢机器上一轮循环拖到好几秒，桶按 20 条 / 秒补充，放过条数会随耗时涨过 45
    // （实测一次 65），那是阈值依赖耗时、不是限流失效
    const burstParams = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 };
    await Promise.all(Array.from({ length: 80 }, () => send("Input.dispatchKeyEvent", { type: "keyDown", ...burstParams })));
    await Promise.all(Array.from({ length: 80 }, () => send("Input.dispatchKeyEvent", { type: "keyUp", ...burstParams })));
    await sleep(300);
    const burst = since(recorded, mark, "key");
    record("rate-limit", "80 次真实 Ctrl+a 连发被令牌桶限流（放过 1–45 条，远少于 80）", burst.length >= 1 && burst.length <= 45, { passed: burst.length });
    await sleep(1300); // 桶补满，不影响后面的步骤

    // 10 ── 跨站 iframe 内的点击
    await waitFor(
      async () => (childSetup.size && [...childSetup.values()].length ? true : null),
      5000,
      "子 frame 会话 attach",
    );
    await Promise.all([...childSetup.values()].map((p) => p.catch(() => {})));
    // 子会话装好脚本后重载 iframe，让脚本在子文档里真正跑起来
    await ev(`(() => { const f = document.getElementById('fr'); f.src = f.src; })()`);
    await waitFor(
      async () => {
        for (const [sid, cid] of childCtx) {
          const t = await safe(() => ev("typeof __flowship", cid, sid));
          if (t === "object") return true;
        }
        return null;
      },
      6000,
      "子 frame 隔离世界装好",
    );
    const childMark = childRecorded.length;
    let childSid = null;
    let local = null;
    for (const [sid, cid] of childCtx) {
      const t = await safe(() => ev("typeof __flowship", cid, sid));
      if (t === "object") {
        childSid = sid;
        local = await ev(
          `(() => { const b = document.getElementById('fbtn').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
          undefined,
          sid,
        );
        break;
      }
    }
    const frameRect = await ev(
      `(() => { const b = document.getElementById('fr').getBoundingClientRect(); return { x: b.x, y: b.y }; })()`,
    );
    // sendInputEvent 的坐标在 OOPIF 上不路由（探针 T6 用的就是 CDP 派发），这里跟探针一致
    // 对照监听（子文档主世界、捕获阶段）：区分「点击根本没送达子文档」与「送达了但录制器没录」
    await ev(`window.__cc = 0; document.addEventListener('click', () => { window.__cc++; }, true);`, undefined, childSid);
    // 跨站 iframe 的点击有两条派发路径：
    //  ① 根会话 + 主视口坐标（产品 actions.mjs 的做法）：要靠浏览器进程里的 OOPIF 命中测试数据把事件路由进子 frame，
    //     该数据随合成帧提交；本脚本的窗口与产品停车场一样是 show:false，机器忙 / 屏幕被遮挡的时段实测偶发（8/40 次）点击根本没送达
    //     子文档（对照监听 __cc 为 0，与录制器无关），且重试 6 次也不恢复；
    //  ② 子会话 + 帧内局部坐标：直接投给子 frame 的 widget，不依赖命中测试。
    // 本步骤要验证的是「录制器在 OOPIF 里录得到、frame 归因为 child」，所以先走 ①（贴近产品），子文档没收到再退到 ②，
    // 并打一行 INFO 留痕；E2E_OOPIF_CHILD_ONLY=1 强制只走 ②（用来验证兜底路径本身）。子文档收到了而录制器没录 = 真缺陷，照样红。
    let clickAttempts = 0;
    let pageGotClick = 0;
    let route = "root";
    if (!process.env.E2E_OOPIF_CHILD_ONLY) {
      while (clickAttempts < 2) {
        clickAttempts++;
        await cdpClick(frameRect.x + local.x, frameRect.y + local.y);
        const got = await safe(() => ev(`window.__cc`, undefined, childSid));
        pageGotClick = typeof got === "number" ? got : 0;
        if (pageGotClick > 0) break;
        await sleep(500);
      }
    }
    if (pageGotClick === 0) {
      route = "child-session";
      const at = { x: local.x, y: local.y };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at }, childSid);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 }, childSid);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 }, childSid);
      const got2 = await safe(() => ev(`window.__cc`, undefined, childSid));
      pageGotClick = typeof got2 === "number" ? got2 : 0;
      console.log(`E2E INFO oopif-route 根会话派发未送达子文档，已改用子会话派发（子文档收到=${pageGotClick}）`);
    }
    await settle(() => since(childRecorded, childMark, "click").length >= 1);
    const childClicks = since(childRecorded, childMark, "click");
    record(
      "oopif-click",
      "跨站 iframe 内点击被录到且 frame:child",
      childClicks.length >= 1 &&
        childClicks[0].frame === "child" &&
        childClicks[0].target?.name === "框架内按钮",
      // 没录到时给出现场（子会话 / 坐标 / 子 frame 此后收到的全部事件类型），别让失败只剩一个 undefined
      childClicks[0] ?? { childSid, local, frameRect, childEvents: childRecorded.slice(childMark).map((e) => e.type), ctxCount: childCtx.size, pageGotClick, clickAttempts, route },
    );

    // 11 ── 覆盖层：不抛错、host 存在且 pointer-events:none、不挡页面点击
    const overlayErr = await safe(() =>
      inIsolated(
        `(() => { __flowship.overlay.showAction({ point: { x: 120, y: 90 }, rect: { x: 100, y: 70, width: 90, height: 36 }, label: '点击 按钮「提交订单」', kind: 'click' }); __flowship.overlay.setActive(true); __flowship.overlay.setActive(true, 'AI 操作中'); return 'ok'; })()`,
      ),
    );
    const hostInfo = await ev(
      `(() => { const h = document.querySelector('[data-flowship-overlay]'); if (!h) return null; const cs = getComputedStyle(h); return { found: true, pointerEvents: cs.pointerEvents, position: cs.position, zIndex: cs.zIndex }; })()`,
    );
    const clicksBefore = await ev("window.__clicks");
    c = await centerOf("btn");
    await userClick(c.x, c.y);
    const clicksAfter = await ev("window.__clicks");
    const hideErr = await safe(() => inIsolated(`__flowship.overlay.hide(); 'ok'`));
    record(
      "overlay",
      "覆盖层 showAction/setActive/hide 不抛错、host pointer-events:none、不挡点击",
      overlayErr === "ok" &&
        hideErr === "ok" &&
        !!hostInfo?.found &&
        hostInfo.pointerEvents === "none" &&
        clicksAfter - clicksBefore === 1,
      { hostInfo, overlayErr, hideErr },
    );

    // 12 ── 重复注入幂等：再 evaluate 一次同一脚本，一次点击只录一条
    await ev(buildPageScript(), mainCtx);
    mark = recorded.length;
    c = await centerOf("btn");
    await userClick(c.x, c.y);
    const dup = since(recorded, mark, "click");
    record("idempotent", "重复注入不重复录制（一次点击一条）", dup.length === 1, { count: dup.length });
  } catch (e) {
    record("fatal", "e2e 主流程未抛错", false, String(e?.stack || e));
  } finally {
    const passed = results.filter((r) => r.ok).length;
    console.log(`E2E DONE ${passed}/${results.length} PASS`);
    clearTimeout(watchdog);
    fixture.close();
    await safe(() => wc.debugger.detach());
    if (!win.isDestroyed()) win.destroy();
    app.exit(results.every((r) => r.ok) ? 0 : 1);
  }
}

main().catch((e) => {
  console.log(`E2E FAIL main ${String(e?.stack || e)}`);
  app.exit(1);
});
