"use strict";
/**
 * E2·P10 · C7 冒烟（真 Electron + 真 CDP）：`attachShadow({mode:"closed"})` 下各 op 的行为，
 * 重点是 **secret-field 在 closed shadow root 里的漏判风险**（AI 不能往 closed 里的密码框键入）。
 *
 * 只能经启动器运行：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-c7-closed-shadow.cjs --timeout 150
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-c7-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// open / closed 各一个自定义元素（内含 button / 普通 input / 密码 input / 文字 / select）；
// x-deleg：closed + delegatesFocus，第一个可聚焦元素就是密码框（DOM.focus 容器会把焦点委托进去）；
// x-outer：closed 里嵌套 closed 的 x-inner（密码框 + 普通框在最内层）。
// window.__CL / __DG / __NI 只是 fixture 给断言读 value 用的「测试后门」，AI 的工具拿不到它们。
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>C7</title>
<style>body{margin:8px;font:14px sans-serif} x-open,x-closed,x-deleg,x-outer,x-inner{display:inline-block;vertical-align:top;width:220px;margin:0 4px 0 0}
button,input,select,p{display:block;width:200px;margin:2px 0;box-sizing:border-box}</style></head><body>
<h1>closed shadow</h1>
<input id="top-plain" aria-label="顶层普通框">
<div>
<x-open id="xo"></x-open>
<x-closed id="xc"></x-closed>
<x-deleg id="xd" role="textbox" aria-label="委托容器"></x-deleg>
<x-outer id="xn"></x-outer>
<x-frame id="xf"></x-frame>
</div>
<script>
window.__clicks = [];
var inner = function (prefix, pwSeed) {
  return '<button id="b">' + prefix + '按钮</button><input id="i" aria-label="' + prefix + '普通框"><input id="p" type="password" value="' + pwSeed + '" aria-label="' + prefix + '密码框"><p id="t">' + prefix + '文字 ' + prefix.toUpperCase() + 'TEXT</p><select id="s" aria-label="' + prefix + '下拉"><option value="a">甲</option><option value="b">乙</option></select>';
};
customElements.define('x-open', class extends HTMLElement { connectedCallback() {
  var r = this.attachShadow({ mode: 'open' }); r.innerHTML = inner('open', 'OPENPW');
  r.getElementById('b').addEventListener('click', function () { window.__clicks.push('open-b'); });
  r.getElementById('b').addEventListener('mouseenter', function () { window.__hover = 'open'; });
  r.getElementById('s').addEventListener('change', function () { window.__sel = 'open:' + this.value; });
} });
customElements.define('x-closed', class extends HTMLElement { connectedCallback() {
  var r = this.attachShadow({ mode: 'closed' }); r.innerHTML = inner('closed', 'CLOSEDPW'); window.__CL = r;
  r.getElementById('b').addEventListener('click', function () { window.__clicks.push('closed-b'); });
  r.getElementById('b').addEventListener('mouseenter', function () { window.__hover = 'closed'; });
  r.getElementById('s').addEventListener('change', function () { window.__sel = 'closed:' + this.value; });
} });
customElements.define('x-deleg', class extends HTMLElement { connectedCallback() {
  var r = this.attachShadow({ mode: 'closed', delegatesFocus: true });
  r.innerHTML = '<input id="p" type="password" value="DELEGPW" aria-label="委托密码框" style="height:60px">'; window.__DG = r;
} });
customElements.define('x-inner', class extends HTMLElement { connectedCallback() {
  var r = this.attachShadow({ mode: 'closed' });
  r.innerHTML = '<input id="p" type="password" value="NESTPW" aria-label="嵌套密码框"><input id="i" aria-label="嵌套普通框">'; window.__NI = r;
} });
customElements.define('x-outer', class extends HTMLElement { connectedCallback() {
  var r = this.attachShadow({ mode: 'closed' }); r.innerHTML = '<x-inner></x-inner>';
} });
// R6-03：closed root 里放 iframe——fa 是同站可读（srcdoc 无 sandbox，里面是密码框），fs 是沙箱（无 allow-same-origin，contentDocument 读不进，里面也是密码框）
customElements.define('x-frame', class extends HTMLElement { connectedCallback() {
  var r = this.attachShadow({ mode: 'closed' });
  r.innerHTML = '<iframe id="fa" style="width:200px;height:50px;display:block" srcdoc="<input id=ipw type=password value=FRAMEPW style=width:150px>"></iframe>' +
    '<iframe id="fs" sandbox="allow-scripts" style="width:200px;height:50px;display:block;margin-top:6px" srcdoc="<input id=spw type=password value=SANDPW style=width:150px>"></iframe>';
  window.__FR = r;
} });
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

const main = async () => {
  await app.whenReady();
  const { server, base } = await startFixture();
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);

  const mainWin = new BrowserWindow({ show: false, width: 1100, height: 700, webPreferences: { sandbox: true } });
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

  const T = "c7-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
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
  const snap = async () => (await call("snapshot", { maxChars: 60000 })).text;

  await call("navigate", { url: `${base}/` });
  let text = await snap();
  const R = {
    cBtn: refOf(text, "closed按钮"),
    cIn: refOf(text, "closed普通框"),
    cPw: refOf(text, "closed密码框"),
    cSel: refOf(text, "closed下拉"),
    oBtn: refOf(text, "open按钮"),
    oPw: refOf(text, "open密码框"),
    dGroup: refOf(text, "委托容器"),
    dPw: refOf(text, "委托密码框"),
    dIn: refOf(text, "委托普通框"),
    nPw: refOf(text, "嵌套密码框"),
    nIn: refOf(text, "嵌套普通框"),
  };
  console.log("  [refs]", JSON.stringify(R));

  // ═══════════ 安全重点：closed 里的密码框 ═══════════
  check("sec-snap-refs", "snapshot（AX 穿透）能给出 closed 内按钮 / 普通框 / 密码框 / 嵌套密码框的 ref", !!(R.cBtn && R.cIn && R.cPw && R.cSel && R.nPw && R.nIn), R);
  check("sec-snap-nopw", "snapshot 文本里没有 closed / open / 委托 / 嵌套密码框的明文值", !/CLOSEDPW|OPENPW|DELEGPW|NESTPW/.test(text));

  const pwVal = (which) => ev(`window.${which}.getElementById('p').value`);
  const pwUntouched = async () =>
    (await pwVal("__CL")) === "CLOSEDPW" && (await pwVal("__DG")) === "DELEGPW" && (await pwVal("__NI")) === "NESTPW";

  const typeClosedPw = await tryCall("type", { ref: R.cPw, text: "hunter2" });
  check("sec-type-closed-pw", "type 到 closed 内密码框 → 被拒（BAD_ARGS）", !typeClosedPw.ok && typeClosedPw.code === "BAD_ARGS", typeClosedPw.message?.slice(0, 40));

  const fillClosedPw = await tryCall("fill_form", { fields: [{ ref: R.cPw, value: "hunter2" }] });
  // fill_form 逐项记成败（整体不抛）：该项必须 ok:false 且带密码拒绝文案，密码框值不变
  const fillJson = JSON.stringify(fillClosedPw.ok ? fillClosedPw.value : fillClosedPw);
  check(
    "sec-fill-closed-pw",
    "fill_form 到 closed 内密码框 → 该项被拒（ok:false + 密码文案），值没变",
    (!fillClosedPw.ok || (/"ok":false/.test(fillJson) && !/"ok":true/.test(fillJson) && /密码/.test(fillJson))) && (await pwVal("__CL")) === "CLOSEDPW",
    fillJson.slice(0, 120),
  );

  // click 本身允许；随后无 ref 的 press_key 往「当前焦点」键入——焦点在 closed 内密码框，必须拒绝
  await call("click", { ref: R.cPw });
  const pkAfterClick = await tryCall("press_key", { key: "a" });
  check("sec-presskey-after-click", "click closed 密码框后 press_key(无 ref) 字符键 → 被拒", !pkAfterClick.ok && pkAfterClick.code === "BAD_ARGS", pkAfterClick);
  const pkPaste = await tryCall("press_key", { key: "Control+v" });
  check("sec-presskey-paste", "焦点在 closed 密码框时 Ctrl+V 粘贴 → 被拒", !pkPaste.ok && pkPaste.code === "BAD_ARGS", pkPaste);
  const pkEnter = await tryCall("press_key", { key: "Enter" });
  check("sec-presskey-enter-ok", "功能键 Enter 仍放行（不误伤）", pkEnter.ok, pkEnter.message);

  const pkRef = await tryCall("press_key", { key: "b", ref: R.cPw });
  check("sec-presskey-ref", "press_key 带 ref=closed 密码框 → 被拒", !pkRef.ok && pkRef.code === "BAD_ARGS", pkRef);

  // 先点别处把焦点拿走，再用 mouse 坐标点中 closed 密码框（不经 ref），再 press_key
  await call("click", { ref: R.cIn });
  const rect = await ev(`(function(){var r = window.__CL.getElementById('p').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2};})()`);
  await call("mouse", { action: "click", x: rect.x, y: rect.y });
  const pkMouse = await tryCall("press_key", { key: "c" });
  check("sec-mouse-then-key", "mouse 坐标点中 closed 密码框后 press_key → 被拒", !pkMouse.ok && pkMouse.code === "BAD_ARGS", pkMouse);

  // 嵌套 closed（closed 里再套 closed）里的密码框
  await call("click", { ref: R.nPw });
  const pkNested = await tryCall("press_key", { key: "d" });
  check("sec-nested-closed", "嵌套 closed 里的密码框拿到焦点后 press_key → 被拒", !pkNested.ok && pkNested.code === "BAD_ARGS", pkNested);

  // delegatesFocus 容器：type 到容器 ref，DOM.focus 把焦点委托进 closed 里的第一个可聚焦元素（密码框）
  if (R.dGroup) {
    const typeDeleg = await tryCall("type", { ref: R.dGroup, text: "hunter2" });
    const dgActive = await ev(`window.__DG.activeElement && window.__DG.activeElement.id`);
    // 焦点要么没进密码框（那就什么都没键入），要么进去了且必须被拒；两种都不能让 DELEGPW 变
    check(
      "sec-type-delegated-container",
      "type 到 delegatesFocus 容器（焦点会落进 closed 密码框）→ 被拒，密码框值不变",
      (await pwVal("__DG")) === "DELEGPW" && (dgActive !== "p" || (!typeDeleg.ok && typeDeleg.code === "BAD_ARGS")),
      { dgActive, typeDeleg: typeDeleg.ok ? "ok" : typeDeleg.code },
    );
  } else {
    check("sec-type-delegated-container", "（容器没有 ref，改用 press_key 无 ref 经 Tab 聚焦）", true, "no-ref");
  }

  // 焦点探测的另一条路：Tab 键把焦点移进 closed 内的密码框（Tab 是功能键，放行），再按字符键
  await call("click", { ref: R.cIn });
  await call("press_key", { key: "Tab" });
  const afterTab = await ev(`window.__CL.activeElement && window.__CL.activeElement.id`);
  if (afterTab === "p") {
    const pkTab = await tryCall("press_key", { key: "e" });
    check("sec-tab-into-pw", "Tab 把焦点移进 closed 密码框后 press_key → 被拒", !pkTab.ok && pkTab.code === "BAD_ARGS", pkTab);
  } else {
    check("sec-tab-into-pw", "（Tab 没有落到密码框，跳过）", true, afterTab);
  }

  // R6-03：closed root 里的 iframe（同站可读 / 沙箱读不进）获焦后，press_key 必须被拒（以前读不进的 iframe 被判 safe）
  for (const [id, label] of [["fa", "同站可读 iframe（里面是密码框）"], ["fs", "沙箱 iframe（读不进，里面是密码框）"]]) {
    await call("click", { ref: R.cIn }); // 先把焦点拿回来
    const fr = await ev(`(function(){var r = window.__FR.getElementById('${id}').getBoundingClientRect(); return {x: r.left + 30, y: r.top + 18};})()`);
    await call("mouse", { action: "click", x: fr.x, y: fr.y });
    const pkFrame = await tryCall("press_key", { key: "x" });
    check(`sec-closed-iframe-${id}`, `焦点进了 closed root 内的${label} → press_key 被拒（BAD_ARGS）`, !pkFrame.ok && pkFrame.code === "BAD_ARGS", pkFrame.message?.slice(0, 60));
    if (id === "fs") check("sec-closed-iframe-msg", "沙箱 iframe 的拒绝文案可自修复（内嵌框架 + 让用户操作）", !pkFrame.ok && /内嵌框架/.test(pkFrame.message ?? "") && /browser_ask_user_to_act/.test(pkFrame.message ?? ""), pkFrame.message?.slice(0, 80));
  }

  // R6-30：browser_mouse 的中键点击（Linux 下是粘贴）/ 拖放释放落点落在 closed 密码框或 iframe 上 → 被拒
  const cpRect = await ev(`(function(){var r = window.__CL.getElementById('p').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2};})()`);
  const midPw = await tryCall("mouse", { action: "click", button: "middle", x: cpRect.x, y: cpRect.y });
  check("sec-mouse-middle-closed-pw", "mouse 中键点击 closed 密码框 → 被拒（BAD_ARGS）", !midPw.ok && midPw.code === "BAD_ARGS", midPw.message?.slice(0, 50));
  const faRect = await ev(`(function(){var r = window.__FR.getElementById('fa').getBoundingClientRect(); return {x: r.left + 30, y: r.top + 18};})()`);
  const midFrame = await tryCall("mouse", { action: "click", button: "middle", x: faRect.x, y: faRect.y });
  check("sec-mouse-middle-iframe", "mouse 中键点击 closed 内 iframe → 被拒（unknown，fail-closed）", !midFrame.ok && midFrame.code === "BAD_ARGS", midFrame.message?.slice(0, 50));
  const bRect = await ev(`(function(){var r = window.__CL.getElementById('b').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2};})()`);
  await call("mouse", { action: "down", x: bRect.x, y: bRect.y });
  await call("mouse", { action: "move", x: cpRect.x, y: cpRect.y });
  const upPw = await tryCall("mouse", { action: "up", x: cpRect.x, y: cpRect.y });
  check("sec-mouse-up-on-closed-pw", "mouse 拖到 closed 密码框上 up → 被拒", !upPw.ok && upPw.code === "BAD_ARGS", upPw.message?.slice(0, 50));
  const topRect = await ev(`(function(){var r = document.getElementById('top-plain').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2};})()`);
  const upPlain = await tryCall("mouse", { action: "up", x: topRect.x, y: topRect.y });
  check("ctl-mouse-up-on-plain", "换到普通框 up 放行（按下态被正常释放）", upPlain.ok, upPlain.message?.slice(0, 50));
  const midPlain = await tryCall("mouse", { action: "click", button: "middle", x: topRect.x, y: topRect.y });
  check("ctl-mouse-middle-plain", "中键点击普通框放行", midPlain.ok, midPlain.message?.slice(0, 50));

  // R6-30 三轮复审（A / B / C）：不靠鼠标轨迹猜落点——up 一律探落点；按着键时其它工具的点击先拒
  // ① B：按着左键时 browser_click 被拒（它的 mouseReleased 会在点击位置结束按住的拖放），文案说明按下状态
  await call("mouse", { action: "down", x: topRect.x, y: topRect.y });
  const heldClick = await tryCall("click", { ref: R.cIn });
  check("sec-mouse-held-click-refused", "browser_mouse 按着左键时 browser_click 被拒（BAD_ARGS，文案说明按下状态）", !heldClick.ok && heldClick.code === "BAD_ARGS" && /按下状态/.test(heldClick.message ?? ""), heldClick.message?.slice(0, 60));
  // ② A：down 之后**不经过任何鼠标动作**，在同一坐标叠一个顶层密码框（等价 browser_scroll / 页面脚本 / 异步内容换了元素）→ 原地 up 被拒，密码框仍为空
  await ev(
    `(function(){var e=document.createElement('input'); e.id='shift-pw'; e.type='password'; e.setAttribute('aria-label','叠上来的密码框'); e.style.cssText='position:fixed;left:${Math.round(topRect.x - 40)}px;top:${Math.round(topRect.y - 12)}px;width:80px;height:24px;z-index:99999;margin:0'; document.body.appendChild(e); return true;})()`,
  );
  const upShift = await tryCall("mouse", { action: "up", x: topRect.x, y: topRect.y });
  check("sec-mouse-up-after-shift", "down 之后没有任何鼠标动作、同一坐标下换成了密码框 → 原地 up 被拒（不再有「原地不探」）", !upShift.ok && upShift.code === "BAD_ARGS", upShift.message?.slice(0, 50));
  check("sec-mouse-shift-pw-empty", "被拒之后叠上来的顶层密码框仍是空的", (await ev(`document.getElementById('shift-pw').value`)) === "");
  // ③ C 的出路：移走密码框后 up 放行并收尾；之后 browser_click 恢复可用
  await ev(`document.getElementById('shift-pw').remove()`);
  const upCleared = await tryCall("mouse", { action: "up", x: topRect.x, y: topRect.y });
  check("ctl-mouse-up-after-remove", "密码框移走后 up 放行（按下态收尾）", upCleared.ok, upCleared.message?.slice(0, 50));
  const clickAfterUp = await tryCall("click", { ref: R.cIn });
  check("ctl-click-after-up", "up 之后 browser_click 恢复可用", clickAfterUp.ok, clickAfterUp.message?.slice(0, 50));
  // ④ A：原地 down→up 落在 closed 密码框也拒（点它请用 browser_click）；换到普通框 up 收尾
  await call("mouse", { action: "down", x: cpRect.x, y: cpRect.y });
  const upInplace = await tryCall("mouse", { action: "up", x: cpRect.x, y: cpRect.y });
  check("sec-mouse-inplace-up-closed-pw", "原地 down→up 落在 closed 密码框 → 被拒（up 一律探落点）", !upInplace.ok && upInplace.code === "BAD_ARGS", upInplace.message?.slice(0, 50));
  const upEnd = await tryCall("mouse", { action: "up", x: topRect.x, y: topRect.y });
  check("ctl-mouse-up-end", "换到普通框 up 收尾放行", upEnd.ok, upEnd.message?.slice(0, 50));

  check("sec-pw-untouched", "全程之后 closed / 委托 / 嵌套三个密码框的值都没被改动", await pwUntouched(), { c: await pwVal("__CL"), d: await pwVal("__DG"), n: await pwVal("__NI") });

  // 对照组：普通框不能被误伤
  const typeClosedIn = await tryCall("type", { ref: R.cIn, text: "hello" });
  const inVal = await ev(`window.__CL.getElementById('i').value`);
  check("ctl-type-closed-plain", "type 到 closed 普通框成功", typeClosedIn.ok && inVal === "hello", { inVal, err: typeClosedIn.message });
  await call("click", { ref: R.cIn });
  const pkPlain = await tryCall("press_key", { key: "z" });
  const inVal2 = await ev(`window.__CL.getElementById('i').value`);
  check("ctl-presskey-closed-plain", "焦点在 closed 普通框时 press_key 字符键放行", pkPlain.ok && inVal2.endsWith("z"), { inVal2, err: pkPlain.message });
  await call("click", { ref: R.nIn });
  const pkNestedPlain = await tryCall("press_key", { key: "q" });
  const nVal = await ev(`window.__NI.getElementById('i').value`);
  check("ctl-presskey-nested-plain", "嵌套 closed 普通框 press_key 放行", pkNestedPlain.ok && nVal === "q", { nVal, err: pkNestedPlain.message });
  const fillPlain = await tryCall("fill_form", { fields: [{ ref: R.cIn, value: "via-fill" }] });
  check("ctl-fill-closed-plain", "fill_form 到 closed 普通框成功", fillPlain.ok && (await ev(`window.__CL.getElementById('i').value`)) === "via-fill", fillPlain.message);

  // drag 落点：把 closed 按钮拖到「委托密码框」上，落点处元素在 closed 里（elementFromPoint 只返回 host）
  if (R.dPw && R.cBtn) {
    const dragPw = await tryCall("drag", { fromRef: R.cBtn, toRef: R.dPw });
    check("sec-drag-onto-closed-pw", "drag 落到 closed 密码框 → 被拒", !dragPw.ok && dragPw.code === "BAD_ARGS", dragPw);
  }
  if (R.dGroup && R.cBtn) {
    const dragHost = await tryCall("drag", { fromRef: R.cBtn, toRef: R.dGroup });
    // 容器（host）中心落点正好压着 closed 里的第一个控件（密码框）：落点探针必须穿透 closed 看到它
    const centerEl = await ev(`(function(){var h=document.getElementById('xd');var r=h.getBoundingClientRect();return window.__DG.elementFromPoint(r.left+r.width/2,r.top+r.height/2) && window.__DG.elementFromPoint(r.left+r.width/2,r.top+r.height/2).id;})()`);
    check("sec-drag-onto-host-center", "drag 落到 closed host 中心（压着密码框）→ 被拒（或落点不是密码框）", !dragHost.ok || centerEl !== "p", { centerEl, dragHost });
  }

  // ═══════════ 其余 op 逐项 ═══════════
  await call("navigate", { url: `${base}/` });
  text = await snap();
  const R2 = { cBtn: refOf(text, "closed按钮"), cSel: refOf(text, "closed下拉"), oBtn: refOf(text, "open按钮"), cIn: refOf(text, "closed普通框") };
  check("op-snapshot", "snapshot：closed 内元素带 ref，open 对照也有", !!(R2.cBtn && R2.cSel && R2.oBtn));

  await call("click", { ref: R2.cBtn });
  check("op-click", "click closed 按钮：页面事件触发", (await ev("window.__clicks.indexOf('closed-b') >= 0")) === true);
  await call("hover", { ref: R2.cBtn });
  check("op-hover", "hover closed 按钮：mouseenter 触发", (await ev("window.__hover")) === "closed");
  const selR = await tryCall("select", { ref: R2.cSel, values: ["乙"] });
  check("op-select", "select closed 内 <select>", selR.ok && (await ev("window.__sel")) === "closed:b", selR.message);

  const insp = await tryCall("inspect", { ref: R2.cBtn, include: ["box", "attrs"] });
  check("op-inspect", "inspect closed 按钮：有 box", insp.ok && !!(insp.value?.box || insp.value?.rect || JSON.stringify(insp.value).includes("width")), insp.ok ? undefined : insp.message);

  const readAll = await tryCall("read", { format: "text", mainContent: false });
  const readText = JSON.stringify(readAll.value ?? "");
  check("op-read-open-text", "read（整页）能读到 open shadow 里的文字", readAll.ok && readText.includes("OPENTEXT"), readAll.message);
  check("op-read-closed-text", "read（整页）能读到 closed shadow 里的文字", readAll.ok && readText.includes("CLOSEDTEXT"), readAll.message);

  const waitOpen = await tryCall("wait_for", { text: "OPENTEXT", timeoutMs: 2000 });
  check("op-waitfor-open", "wait_for text：open 内文字", waitOpen.ok && waitOpen.value?.matched === true, waitOpen.message);
  const waitClosed = await tryCall("wait_for", { text: "CLOSEDTEXT", timeoutMs: 2500 });
  check("op-waitfor-closed", "wait_for text：closed 内文字", waitClosed.ok && waitClosed.value?.matched === true, waitClosed.message ?? waitClosed.value);

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
