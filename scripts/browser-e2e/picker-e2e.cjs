"use strict";
// 元素拾取的真实 Electron 验证。只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
//   node scripts/browser-e2e/run.mjs scripts/browser-e2e/picker-e2e.cjs --timeout 60
// 验证 electron-app/browser/picker.mjs 在真 Electron + 真 CDP 下：Overlay 检查模式 → 点选 → PickedElement（含截图 / 选择器唯一性）、取消、Esc。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REPO = path.resolve(__dirname, "../..");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "fs-picker-e2e-")));

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>拾取页</title></head><body style="margin:0;height:2000px">
<div id="app">
  <a href="#" aria-label="首页链接" style="position:absolute;left:20px;top:20px;width:120px;height:40px;background:#eee">首页</a>
  <section style="position:absolute;left:0;top:100px">
    <button style="position:absolute;left:200px;top:0;width:160px;height:50px">提交订单</button>
    <button data-testid="cancel-btn" style="position:absolute;left:400px;top:0;width:160px;height:50px">取消</button>
    <button style="position:absolute;left:600px;top:0;width:160px;height:50px">重复</button>
  </section>
  <ul style="position:absolute;left:20px;top:300px"><li>甲</li><li id="item-b">乙</li><li>丙</li></ul>
</div></body></html>`;

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`超时：${label}`)), ms))]);

const main = async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(url);
  const wc = win.webContents;
  wc.debugger.attach("1.3");
  await wc.debugger.sendCommand("Page.enable");
  await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });

  const listeners = new Set();
  wc.debugger.on("message", (_e, method, params, sessionId) => {
    for (const l of listeners) l(method, params, sessionId ?? null);
  });
  const tab = {
    destroyed: false,
    wc,
    ensureCdp: async () => {},
    send: (method, params = {}) => wc.debugger.sendCommand(method, params),
    onCdpEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  const { startPicker, redactHtmlInputValues } = await import(pathToFileURL(path.join(REPO, "electron-app/browser/picker.mjs")).href);
  const click = async (x, y) => {
    await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(80);
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const evalPage = (expr) => tab.send("Runtime.evaluate", { expression: expr, returnByValue: true }).then((r) => r.result.value);

  const runPick = async (x, y) => {
    let picked = null;
    let ended = 0;
    const done = new Promise((resolve) => {
      startPicker(tab, {
        onPicked: (p) => (picked = p),
        onEnd: () => {
          ended++;
          resolve();
        },
      });
    });
    await sleep(400); // 等 Overlay 检查模式就位
    await click(x, y);
    await withTimeout(done, 6000, "等 onEnd");
    return { picked, ended };
  };

  // 1) 点选「提交订单」（无 id / testid → 走 nth-of-type 路径）
  {
    const { picked, ended } = await runPick(280, 125);
    check("点选：onPicked 被调、onEnd 一次", !!picked && ended === 1, `ended=${ended}`);
    if (picked) {
      console.log("  picked =", JSON.stringify({ ...picked, screenshot: picked.screenshot ? `<${picked.screenshot.length}B>` : undefined }));
      check("role=button / name=提交订单", picked.role === "button" && picked.name === "提交订单");
      check("text=提交订单", picked.text === "提交订单");
      check("outerHTML 含 <button", picked.outerHTML.includes("<button"));
      check("url/title", picked.url === url && picked.title === "拾取页");
      const uniq = await evalPage(`document.querySelectorAll(${JSON.stringify(picked.selector)}).length`);
      const isIt = await evalPage(`document.querySelector(${JSON.stringify(picked.selector)})?.textContent`);
      check("选择器在页内唯一命中且就是这个元素", uniq === 1 && isIt === "提交订单", `selector=${picked.selector}`);
      check("rect 合理", Math.abs(picked.rect.x - 200) < 2 && Math.abs(picked.rect.y - 100) < 2 && Math.abs(picked.rect.width - 160) < 2);
      check("截图是 jpeg dataURL 且 ≤200KB", typeof picked.screenshot === "string" && picked.screenshot.startsWith("data:image/jpeg;base64,") && picked.screenshot.length <= 200 * 1024, `len=${picked.screenshot?.length}`);
      check("reactSource=null（非 React 页）", picked.reactSource === null);
    }
  }

  // 2) 点选带 data-testid 的按钮 → 优先 testid
  {
    const { picked } = await runPick(480, 125);
    check("data-testid 优先", !!picked && picked.selector === 'button[data-testid="cancel-btn"]', `selector=${picked?.selector}`);
  }

  // 3) 点选带 id 的 li → #item-b（ul 有 40px 左 padding，li 内容从 x=60 起）
  {
    const top = await evalPage(`document.getElementById("item-b").getBoundingClientRect().top`);
    const { picked } = await runPick(64, Math.round(top + 5));
    check("id 优先（#item-b）", !!picked && picked.selector === "#item-b", `selector=${picked?.selector}`);
  }

  // 4) 取消：cancel() 幂等、onEnd 一次、之后点击不再触发 onPicked
  {
    let picked = null;
    let ended = 0;
    const h = startPicker(tab, { onPicked: (p) => (picked = p), onEnd: () => ended++ });
    await sleep(400);
    h.cancel();
    h.cancel();
    await sleep(200);
    await click(280, 125);
    await sleep(400);
    check("cancel：onEnd 一次、不 onPicked", ended === 1 && picked === null, `ended=${ended}`);
  }

  // 5) Esc：真 sendInputEvent 能否触发 before-input-event（页面是 BrowserWindow 的 wc，行为与 WebContentsView 一致）
  {
    let picked = null;
    let ended = 0;
    let sawInput = false;
    wc.once("before-input-event", () => (sawInput = true));
    startPicker(tab, { onPicked: (p) => (picked = p), onEnd: () => ended++ });
    await sleep(400);
    wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await sleep(500);
    console.log(`  sendInputEvent 触发 before-input-event=${sawInput}`);
    check("Esc（sendInputEvent）→ onEnd 一次", ended === 1 && picked === null, `ended=${ended} sawInput=${sawInput}`);
  }

  // 6) R4-01：真 Chromium 对「属性名里带引号」标记的序列化形态 + 降级路径的字符串脱敏（DOM.getOuterHTML 的原始串）
  {
    const OLD_TAG_RE = /<(?:input|textarea)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/i; // R3-05 的旧标签边界正则：见引号就配对
    await tab.send("DOM.enable");
    const rawOf = async (selector) => {
      const doc = await tab.send("DOM.getDocument", { depth: 0 });
      const q = await tab.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
      const o = await tab.send("DOM.getOuterHTML", { nodeId: q.nodeId });
      return o.outerHTML;
    };
    await evalPage(`document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(
      '<div id="r4">' +
        '<input id="r4a" type="password" name="pw" value="hunter2"">' + // 值后面多一个引号：规范里是名为 `"` 的属性
        "<input id=\"r4b\" type=hidden name=csrf value='tok-9' 'x>" + // 单引号开头的属性名
        '<textarea id="r4c" name="t"">TA-SECRET</textarea>' +
        "</div>",
    )})`);
    const rawA = await rawOf("#r4a");
    const rawB = await rawOf("#r4b");
    const rawAll = await rawOf("#r4");
    console.log("  raw #r4a =", rawA);
    console.log("  raw #r4b =", rawB);
    check("前提：真序列化里 value 属性还在、且带着那个奇怪的属性名（引号总数为奇数）", rawA.includes('value="hunter2"') && (rawA.match(/"/g) || []).length % 2 === 1, `quotes=${(rawA.match(/"/g) || []).length}`);
    check("前提：旧版标签边界正则对它们匹配不上（= 旧版整个标签当「不是标签」、value 原样漏出）", !OLD_TAG_RE.test(rawA) && !OLD_TAG_RE.test(rawB));
    check("redactHtmlInputValues：密码框 value 脱敏（真序列化）", !redactHtmlInputValues(rawA).includes("hunter2") && redactHtmlInputValues(rawA).includes('type="password"'));
    check("redactHtmlInputValues：hidden 的 value 脱敏（真序列化）", !redactHtmlInputValues(rawB).includes("tok-9") && redactHtmlInputValues(rawB).includes('name="csrf"'));
    const redAll = redactHtmlInputValues(rawAll);
    check("整个容器：三处秘密一个不剩，textarea 标签保留", !redAll.includes("hunter2") && !redAll.includes("tok-9") && !redAll.includes("TA-SECRET") && redAll.includes("<textarea"));

    // 诱饵：script 文本（不转义）里放 `<input type=text x='`，真密码框在它后面
    await evalPage(`document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(
      '<div id="r4d"><script>var a="<input type=text x=\'";</script><input id="r4e" type="password" value="REAL-D"><script>var b="\'";</script></div>',
    )})`);
    const rawD = await rawOf("#r4d");
    check("诱饵：script 里的未配对单引号不能吞掉后面真密码框的 value", rawD.includes("REAL-D") && !redactHtmlInputValues(rawD).includes("REAL-D"), `len=${rawD.length}`);
  }

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(() => main().catch((err) => {
  console.error("e2e 异常：", err);
  app.exit(1);
}));
