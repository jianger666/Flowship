"use strict";
/**
 * E2·P10 · C7 冒烟（真 Electron + 真 CDP）：`attachShadow({mode:"closed"})` 下各 op 的行为，
 * 重点：closed 里的密码框 —— **读取侧**（snapshot 值遮罩）仍然生效；**写入侧**（type / fill_form / press_key / mouse / drag）不再有任何限制。
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

  // ═══════════ closed 里的密码框：读取侧遮罩仍在，写入不再受限 ═══════════
  check("sec-snap-refs", "snapshot（AX 穿透）能给出 closed 内按钮 / 普通框 / 密码框 / 嵌套密码框的 ref", !!(R.cBtn && R.cIn && R.cPw && R.cSel && R.nPw && R.nIn), R);
  check("sec-snap-nopw", "snapshot 文本里没有 closed / open / 委托 / 嵌套密码框的明文值", !/CLOSEDPW|OPENPW|DELEGPW|NESTPW/.test(text));

  const pwVal = (which) => ev(`window.${which}.getElementById('p').value`);

  // 写入侧：AI 往密码框里输入不再有任何限制（type / fill_form / press_key / mouse / drag），closed shadow 里的也一样
  const typeClosedPw = await tryCall("type", { ref: R.cPw, text: "hunter2" });
  check("pw-type-closed", "type 到 closed 内密码框成功（不再被拒），值落到页面", typeClosedPw.ok && (await pwVal("__CL")) === "hunter2", typeClosedPw.message?.slice(0, 60));

  const fillClosedPw = await tryCall("fill_form", { fields: [{ ref: R.cPw, value: "via-fill-pw" }] });
  const fillJson = JSON.stringify(fillClosedPw.ok ? fillClosedPw.value : fillClosedPw);
  check("pw-fill-closed", "fill_form 到 closed 内密码框 → 该项 ok:true，值落到页面", fillClosedPw.ok && /"ok":true/.test(fillJson) && !/"ok":false/.test(fillJson) && (await pwVal("__CL")) === "via-fill-pw", fillJson.slice(0, 120));

  // click 之后无 ref 的 press_key 往「当前焦点」键入：焦点在 closed 内密码框，字符键照常输入；Enter 也放行
  await call("click", { ref: R.cPw });
  const pkAfterClick = await tryCall("press_key", { key: "a" });
  check("pw-presskey-after-click", "click closed 密码框后 press_key(无 ref) 字符键放行，字符进了密码框", pkAfterClick.ok && (await pwVal("__CL")).endsWith("a"), pkAfterClick.message?.slice(0, 60));
  const pkEnter = await tryCall("press_key", { key: "Enter" });
  check("pw-presskey-enter-ok", "功能键 Enter 放行", pkEnter.ok, pkEnter.message);

  const pkRef = await tryCall("press_key", { key: "b", ref: R.cPw });
  check("pw-presskey-ref", "press_key 带 ref=closed 密码框放行，字符进了密码框", pkRef.ok && (await pwVal("__CL")).endsWith("b"), pkRef.message?.slice(0, 60));

  // 先点别处把焦点拿走，再用 mouse 坐标点中 closed 密码框（不经 ref），再 press_key
  await call("click", { ref: R.cIn });
  const rect = await ev(`(function(){var r = window.__CL.getElementById('p').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2};})()`);
  await call("mouse", { action: "click", x: rect.x, y: rect.y });
  const pkMouse = await tryCall("press_key", { key: "c" });
  check("pw-mouse-then-key", "mouse 坐标点中 closed 密码框后 press_key 放行", pkMouse.ok && (await pwVal("__CL")).endsWith("c"), pkMouse.message?.slice(0, 60));

  // 嵌套 closed（closed 里再套 closed）里的密码框
  await call("click", { ref: R.nPw });
  const pkNested = await tryCall("press_key", { key: "d" });
  check("pw-nested-closed", "嵌套 closed 里的密码框拿到焦点后 press_key 放行", pkNested.ok && (await pwVal("__NI")).endsWith("d"), pkNested.message?.slice(0, 60));

  // delegatesFocus 容器：type 到容器 ref，DOM.focus 把焦点委托进 closed 里的第一个可聚焦元素（密码框）——照常输入
  if (R.dGroup) {
    const typeDeleg = await tryCall("type", { ref: R.dGroup, text: "hunter2" });
    const dgActive = await ev(`window.__DG.activeElement && window.__DG.activeElement.id`);
    check(
      "pw-type-delegated-container",
      "type 到 delegatesFocus 容器不报错；焦点委托进了 closed 密码框时字符真的进去了",
      typeDeleg.ok && (dgActive !== "p" || (await pwVal("__DG")).endsWith("hunter2")), // 清空动作作用在容器上、不会清到委托进去的内层框，所以只断言「字符进去了」
      { dgActive, typeDeleg: typeDeleg.ok ? "ok" : typeDeleg.code },
    );
  } else {
    check("pw-type-delegated-container", "（容器没有 ref，跳过）", true, "no-ref");
  }

  // Tab 键把焦点移进 closed 内的密码框，再按字符键
  await call("click", { ref: R.cIn });
  await call("press_key", { key: "Tab" });
  const afterTab = await ev(`window.__CL.activeElement && window.__CL.activeElement.id`);
  if (afterTab === "p") {
    const pkTab = await tryCall("press_key", { key: "e" });
    check("pw-tab-into-pw", "Tab 把焦点移进 closed 密码框后 press_key 放行", pkTab.ok && (await pwVal("__CL")).endsWith("e"), pkTab.message?.slice(0, 60));
  } else {
    check("pw-tab-into-pw", "（Tab 没有落到密码框，跳过）", true, afterTab);
  }

  // closed root 里的 iframe（同站可读 / 沙箱读不进）获焦后，press_key 同样放行（以前读不进的 iframe 会被拒）
  for (const [id, label] of [["fa", "同站可读 iframe（里面是密码框）"], ["fs", "沙箱 iframe（读不进，里面是密码框）"]]) {
    await call("click", { ref: R.cIn }); // 先把焦点拿回来
    const fr = await ev(`(function(){var r = window.__FR.getElementById('${id}').getBoundingClientRect(); return {x: r.left + 30, y: r.top + 18};})()`);
    await call("mouse", { action: "click", x: fr.x, y: fr.y });
    const pkFrame = await tryCall("press_key", { key: "x" });
    check(`pw-closed-iframe-${id}`, `焦点进了 closed root 内的${label} → press_key 放行（不再因读不进 iframe 而拒绝）`, pkFrame.ok, pkFrame.message?.slice(0, 60));
  }

  // browser_mouse：中键点击 / 拖放释放落在 closed 密码框或 iframe 上，不再被拒
  const cpRect = await ev(`(function(){var r = window.__CL.getElementById('p').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2};})()`);
  const midPw = await tryCall("mouse", { action: "click", button: "middle", x: cpRect.x, y: cpRect.y });
  check("pw-mouse-middle-closed-pw", "mouse 中键点击 closed 密码框放行", midPw.ok, midPw.message?.slice(0, 50));
  const faRect = await ev(`(function(){var r = window.__FR.getElementById('fa').getBoundingClientRect(); return {x: r.left + 30, y: r.top + 18};})()`);
  const midFrame = await tryCall("mouse", { action: "click", button: "middle", x: faRect.x, y: faRect.y });
  check("pw-mouse-middle-iframe", "mouse 中键点击 closed 内 iframe 放行", midFrame.ok, midFrame.message?.slice(0, 50));
  const bRect = await ev(`(function(){var r = window.__CL.getElementById('b').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2};})()`);
  await call("mouse", { action: "down", x: bRect.x, y: bRect.y });
  await call("mouse", { action: "move", x: cpRect.x, y: cpRect.y });
  const upPw = await tryCall("mouse", { action: "up", x: cpRect.x, y: cpRect.y });
  check("pw-mouse-up-on-closed-pw", "mouse 拖到 closed 密码框上 up 放行（按下态正常释放）", upPw.ok, upPw.message?.slice(0, 50));
  const topRect = await ev(`(function(){var r = document.getElementById('top-plain').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2};})()`);
  const midPlain = await tryCall("mouse", { action: "click", button: "middle", x: topRect.x, y: topRect.y });
  check("ctl-mouse-middle-plain", "中键点击普通框放行", midPlain.ok, midPlain.message?.slice(0, 50));

  // 按着左键时 browser_click 不再被拒（不再有「按下状态」守卫）；之后 up 正常收尾
  await call("mouse", { action: "down", x: topRect.x, y: topRect.y });
  const heldClick = await tryCall("click", { ref: R.cIn });
  check("ctl-mouse-held-click-ok", "browser_mouse 按着左键时 browser_click 照常执行", heldClick.ok, heldClick.message?.slice(0, 60));
  const upEnd = await tryCall("mouse", { action: "up", x: topRect.x, y: topRect.y });
  check("ctl-mouse-up-end", "up 放行收尾", upEnd.ok, upEnd.message?.slice(0, 50));
  const clickAfterUp = await tryCall("click", { ref: R.cIn });
  check("ctl-click-after-up", "up 之后 browser_click 仍可用", clickAfterUp.ok, clickAfterUp.message?.slice(0, 50));

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

  // drag 落点：把 closed 按钮拖到「委托密码框」上 / 容器中心，不再被拒
  if (R.dPw && R.cBtn) {
    const dragPw = await tryCall("drag", { fromRef: R.cBtn, toRef: R.dPw });
    check("pw-drag-onto-closed-pw", "drag 落到 closed 密码框放行", dragPw.ok, dragPw.message?.slice(0, 60));
  }
  if (R.dGroup && R.cBtn) {
    const dragHost = await tryCall("drag", { fromRef: R.cBtn, toRef: R.dGroup });
    check("pw-drag-onto-host-center", "drag 落到 closed host 中心（压着密码框）放行", dragHost.ok, dragHost.message?.slice(0, 60));
  }

  // 读取侧遮罩不受写入放开的影响：写进去的值照样不会出现在 snapshot 里
  const textAfterWrite = await snap();
  check("sec-snap-nopw-after-write", "往密码框写入之后，snapshot 里仍没有这些密码框的明文值（hunter2 / via-fill-pw 等）", !/hunter2|via-fill-pw|CLOSEDPW|OPENPW|DELEGPW|NESTPW/.test(textAfterWrite));

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
