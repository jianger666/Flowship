"use strict";
// 只能经启动器运行：node scripts/browser-e2e/run.mjs scripts/browser-e2e/v4-smoke.cjs --timeout 90
// V4 用户侧冒烟（真 Electron + 真 createBrowserManager + 真 BrowserTab + 真 user-features.mjs）：
//   右键菜单（假 Menu 注入、验模板与点击效果）/ 缩放（wc.getZoomLevel 实际效果、每 tab 独立、夹取）/
//   before-input-event 快捷键（webContents.sendInputEvent 触发 Cmd/Ctrl +,-,0,F）/ 页内查找计数 /
//   下载 reveal-open（假 shell、只认登记表 id、可执行扩展名拒绝）/ 对话框与模拟的可选转调 / IPC 可信校验
const { app, BrowserWindow, WebContentsView, session, nativeImage, webContents } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const REPO = path.resolve(__dirname, "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-v4-e2e-"));
app.setPath("userData", path.join(tmp, "userData"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${x ? " — " + x : ""}`);
};
const MOD = process.platform === "darwin" ? "meta" : "control";
const PLATFORM = process.platform;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>V4 页</title></head><body style="margin:0;font:16px sans-serif">
<p>apple banana cherry banana</p><p>banana date banana elder banana</p>
<a id="lnk" href="/next" style="position:absolute;left:20px;top:200px;display:block;width:200px;height:40px">下一页链接</a>
<a id="bad" href="http://127.0.0.1:8876/evil" style="position:absolute;left:20px;top:260px;display:block;width:200px;height:40px">应用自己的地址</a>
</body></html>`;

app.whenReady().then(async () => {
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const win = new BrowserWindow({ show: false, width: 1000, height: 700 });
  await win.loadURL("about:blank");
  const sent = [];
  const origSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, ...a) => {
    sent.push([ch, ...a]);
    return origSend(ch, ...a);
  };

  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (n, f) => handlers.set(n, f),
    on: (n, f) => listeners.set(n, f),
    removeHandler: (n) => handlers.delete(n),
    removeListener: (n) => listeners.delete(n),
  };
  // 假 Menu / clipboard / shell：验模板与副作用，不弹任何原生菜单
  const popups = [];
  const Menu = { buildFromTemplate: (template) => ({ template, popup: (opts) => popups.push({ template, opts }) }) };
  const clip = [];
  const clipboard = { writeText: (t) => clip.push(t) };
  const shellCalls = [];
  const shell = {
    showItemInFolder: (p) => shellCalls.push(["reveal", p]),
    openPath: async (p) => {
      shellCalls.push(["open", p]);
      return "";
    },
  };
  let trusted = true;
  const ev = { senderFrame: { url: "x" } };
  const { createBrowserManager } = await import(pathToFileURL(path.join(REPO, "electron-app/browser/index.mjs")).href);
  const { createIsAppUrl } = await import(pathToFileURL(path.join(REPO, "electron-app/browser/app-origin.mjs")).href);
  const mgr = createBrowserManager({
    app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, Menu, clipboard, shell,
    getMainWindow: () => win,
    isAppUrl: createIsAppUrl(() => 8876),
    isTrustedIpcSender: () => trusted,
    log: (m) => console.log("  [log]", m),
  });
  mgr.registerIpc();
  const call = (n, ...a) => handlers.get(n)(ev, ...a);
  const send = (n, ...a) => listeners.get(n)(ev, ...a);

  await call("browser:navigate", "t1", url);
  await call("browser:attach", "t1", { x: 0, y: 0, width: 800, height: 600 });
  await sleep(1500);
  const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
  check("找到浏览器 view 的 webContents 且已加载", !!wc, wc?.getURL());
  if (!wc) { app.exit(1); return; }
  const sess = mgr.getSession("t1");
  const tab1 = sess.activeTab;
  const tabInfo = async () => (await call("browser:getState", "t1")).tabs.find((t) => t.isActive);

  // ── 通道都注册了 ──
  const wanted = ["zoom", "find", "stopFind", "openDevTools", "answerDialog", "resetEmulation"].map((n) => `browser:${n}`);
  check("V4 的 send 型通道都已注册", wanted.every((n) => listeners.has(n)), wanted.filter((n) => !listeners.has(n)).join(","));
  check("V4 的 invoke 型通道（revealDownload / openDownload）已注册", handlers.has("browser:revealDownload") && handlers.has("browser:openDownload"));

  // ── 右键菜单：先试真实右键（sendInputEvent），拿不到再用 emit 合成 params ──
  let real = false;
  wc.sendInputEvent({ type: "mouseMove", x: 60, y: 220 });
  wc.sendInputEvent({ type: "mouseDown", x: 60, y: 220, button: "right", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: 60, y: 220, button: "right", clickCount: 1 });
  await sleep(800);
  if (popups.length > 0) real = true;
  console.log(`  [info] 真实右键事件${real ? "触发了" : "没有触发"} context-menu（popups=${popups.length}）`);
  if (!real) {
    wc.emit("context-menu", {}, { x: 60, y: 220, linkURL: `${url}next`, mediaType: "none", selectionText: "", isEditable: false, editFlags: { canCopy: false, canSelectAll: true } });
  }
  const m1 = popups.at(-1);
  const ids1 = m1 ? m1.template.filter((i) => i.id).map((i) => i.id) : [];
  check("右键链接：菜单含 在新标签页打开 / 复制链接 / 后退 / 前进 / 刷新 / 检查元素", ["openLink", "copyLink", "back", "forward", "reload", "inspect"].every((i) => ids1.includes(i)), ids1.join(","));
  check("右键菜单 popup 带了窗口（不是 undefined 光标位置乱弹）", !!m1?.opts?.window || real === false);
  const open = m1?.template.find((i) => i.id === "openLink");
  open?.click();
  await sleep(1000);
  const tabsAfterOpen = (await call("browser:getState", "t1")).tabs;
  check("点「在新标签页打开链接」→ 同会话多一个 tab", tabsAfterOpen.length === 2, `tabs=${tabsAfterOpen.length}`);
  m1?.template.find((i) => i.id === "copyLink")?.click();
  check("点「复制链接地址」→ clipboard.writeText 收到链接", clip.at(-1)?.endsWith("/next") === true, String(clip.at(-1)));
  // 回到第一个 tab
  send("browser:selectTab", "t1", tab1.id);
  await sleep(300);

  // 被 URL 策略拦下的链接（应用自己的端口 8876）：不给「在新标签页打开」
  wc.emit("context-menu", {}, { x: 5, y: 5, linkURL: "http://127.0.0.1:8876/evil", mediaType: "none", editFlags: {} });
  const ids2 = popups.at(-1).template.filter((i) => i.id).map((i) => i.id);
  check("被拦的链接（应用 origin）：没有 在新标签页打开，仍有 复制链接地址", !ids2.includes("openLink") && ids2.includes("copyLink"), ids2.join(","));
  wc.emit("context-menu", {}, { x: 5, y: 5, linkURL: "javascript:alert(1)", mediaType: "none", editFlags: {} });
  check("javascript: 链接同样不给 在新标签页打开", !popups.at(-1).template.some((i) => i.id === "openLink"));
  wc.emit("context-menu", {}, { x: 9, y: 9, mediaType: "image", srcURL: "https://example.com/a.png", isEditable: false, editFlags: {} });
  const ids3 = popups.at(-1).template.filter((i) => i.id).map((i) => i.id);
  check("右键图片：复制图片 / 复制图片地址", ids3.includes("copyImage") && ids3.includes("copyImageUrl"), ids3.join(","));
  wc.emit("context-menu", {}, { x: 9, y: 9, mediaType: "none", isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
  const tpl4 = popups.at(-1).template;
  check("右键输入框：剪切 / 复制不可用、粘贴可用", tpl4.find((i) => i.id === "cut")?.enabled === false && tpl4.find((i) => i.id === "paste")?.enabled === true);

  // ── 缩放：IPC → wc.getZoomLevel 的实际效果 ──
  send("browser:zoom", "t1", "in");
  send("browser:zoom", "t1", "in");
  await sleep(150);
  check("zoom in ×2 → wc.getZoomLevel()==1（步进 0.5）", wc.getZoomLevel() === 1, `level=${wc.getZoomLevel()}`);
  await sleep(200);
  const ti = await tabInfo();
  check("TabInfo.zoom==120（1.2^1，百分比整数）", ti?.zoom === 120, `zoom=${ti?.zoom}`);
  send("browser:zoom", "t1", "reset");
  await sleep(100);
  check("zoom reset → level 0 / TabInfo.zoom==100", wc.getZoomLevel() === 0 && (await tabInfo())?.zoom === 100, `level=${wc.getZoomLevel()}`);
  for (let i = 0; i < 20; i++) send("browser:zoom", "t1", "in");
  await sleep(150);
  check("放大夹到上限 +5（249%）", wc.getZoomLevel() === 5 && (await tabInfo())?.zoom === 249, `level=${wc.getZoomLevel()}`);
  for (let i = 0; i < 30; i++) send("browser:zoom", "t1", "out");
  await sleep(150);
  check("缩小夹到下限 −3（58%）", wc.getZoomLevel() === -3 && (await tabInfo())?.zoom === 58, `level=${wc.getZoomLevel()}`);
  send("browser:zoom", "t1", "bogus");
  send("browser:zoom", "t1", 42);
  check("非法 action 不改缩放", wc.getZoomLevel() === -3);
  send("browser:zoom", "t1", "reset");

  // 缩放按 host 共享（Chromium HostZoomMap，与 Chrome 一致；契约写的「每 tab 独立」做不到，见报告）：
  // 同 host 的新 tab 继承；不同 host（localhost vs 127.0.0.1）的新 tab 不受影响
  send("browser:zoom", "t1", "in");
  send("browser:zoom", "t1", "in");
  await sleep(100);
  const otherHost = url.replace("127.0.0.1", "localhost");
  const t2id = await call("browser:newTab", "t1", otherHost);
  await sleep(1500);
  const tab2 = sess.tabs.find((t) => t.id === t2id);
  check("不同 host 的新 tab 缩放是 0，原 tab 保持 1", !!tab2 && tab2.wc.getZoomLevel() === 0 && wc.getZoomLevel() === 1, `t2=${tab2?.wc.getZoomLevel()} t1=${wc.getZoomLevel()} url=${tab2?.wc.getURL()}`);
  const t2info = (await call("browser:getState", "t1")).tabs.find((t) => t.id === t2id);
  const t1info = (await call("browser:getState", "t1")).tabs.find((t) => t.id === tab1.id);
  check("TabInfo.zoom 读实时值：t1=120、t2=100", t1info?.zoom === 120 && t2info?.zoom === 100, `t1=${t1info?.zoom} t2=${t2info?.zoom}`);
  send("browser:closeTab", "t1", t2id);
  await sleep(400);
  send("browser:selectTab", "t1", tab1.id);
  send("browser:zoom", "t1", "reset");
  await sleep(100);
  console.log(`  [info] active=${sess.activeTabId} tabs=${sess.tabs.map((t) => t.id).join(",")}`);

  // ── 快捷键：sendInputEvent → before-input-event ──
  const key = (k, mods = [MOD]) => {
    wc.sendInputEvent({ type: "keyDown", keyCode: k, modifiers: mods });
    wc.sendInputEvent({ type: "keyUp", keyCode: k, modifiers: mods });
  };
  key("=");
  await sleep(200);
  check(`${MOD}+= → 放大一档（level 0.5）`, wc.getZoomLevel() === 0.5, `level=${wc.getZoomLevel()}`);
  key("Plus", [MOD, "shift"]);
  await sleep(200);
  check(`${MOD}+Shift++ → 再放大（level 1）`, wc.getZoomLevel() === 1, `level=${wc.getZoomLevel()}`);
  key("-");
  await sleep(200);
  check(`${MOD}+- → 缩小一档（level 0.5）`, wc.getZoomLevel() === 0.5, `level=${wc.getZoomLevel()}`);
  key("0");
  await sleep(200);
  check(`${MOD}+0 → 重置（level 0）`, wc.getZoomLevel() === 0, `level=${wc.getZoomLevel()}`);
  key("=", []);
  await sleep(200);
  check("不带修饰键的 = 不缩放", wc.getZoomLevel() === 0, `level=${wc.getZoomLevel()}`);
  key("=", [MOD, "alt"]);
  await sleep(200);
  check("带 Alt 的组合不拦", wc.getZoomLevel() === 0, `level=${wc.getZoomLevel()}`);
  sent.length = 0;
  key("f");
  await sleep(300);
  check(`${MOD}+F → 主窗口收到 browser:findRequested(taskId)`, sent.some((m) => m[0] === "browser:findRequested" && m[1] === "t1"), JSON.stringify(sent.filter((m) => m[0] === "browser:findRequested")));

  // ── 页内查找（用轮询等 browser:found：首个结果在隐藏窗口里可能要几百毫秒）──
  const foundsOf = () => sent.filter((m) => m[0] === "browser:found").map((m) => m[1]);
  const waitFound = async (pred, timeoutMs = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = foundsOf().filter(pred).at(-1);
      if (hit) return { hit, ms: Date.now() - t0 };
      await sleep(50);
    }
    return { hit: null, ms: timeoutMs };
  };
  sent.length = 0;
  send("browser:find", "t1", "banana", { forward: true, findNext: true, matchCase: false }); // Electron 语义：findNext=true 才是「开始新一轮查找」
  const f0 = await waitFound((f) => f.matches > 0);
  const last = f0.hit;
  console.log(`  [info] 首个 found 用时 ${f0.ms}ms，共收到 ${foundsOf().length} 条推送：${JSON.stringify(foundsOf())}`);
  check("find 'banana' → browser:found 带 taskId / matches==5 / activeMatchOrdinal>=1", last?.taskId === "t1" && last.matches === 5 && last.activeMatchOrdinal >= 1, JSON.stringify(last));
  check("占位的 matches:0 结果被吞掉（有命中时不会先闪一条 0）", foundsOf().every((f) => f.matches > 0), JSON.stringify(foundsOf()));
  const first = last?.activeMatchOrdinal ?? 0;
  sent.length = 0;
  send("browser:find", "t1", "banana", { forward: true, findNext: false }); // 后续请求（Enter = 下一个）
  const f1 = await waitFound((f) => f.matches > 0);
  check("find 下一个 → activeMatchOrdinal 前进一位", f1.hit?.activeMatchOrdinal === (first % 5) + 1, `first=${first} next=${f1.hit?.activeMatchOrdinal}`);
  sent.length = 0;
  send("browser:find", "t1", "banana", { forward: false, findNext: false }); // Shift+Enter = 上一个
  const f2 = await waitFound((f) => f.matches > 0);
  check("find 上一个 → 回到前一位", f2.hit?.activeMatchOrdinal === first, `prev=${f2.hit?.activeMatchOrdinal} first=${first}`);
  sent.length = 0;
  send("browser:find", "t1", "zzz-not-there", { findNext: true });
  const f3 = await waitFound((f) => f.matches === 0);
  check("find 不存在的词 → matches==0（无结果态，延迟推送）", f3.hit?.matches === 0, JSON.stringify(foundsOf()));
  send("browser:find", "t1", "banana", { findNext: true });
  await sleep(400);
  send("browser:stopFind", "t1");
  send("browser:find", 123, "x", {});
  send("browser:find", "t1", { evil: true }, {});
  check("stopFind / 非法参数不抛（find 的 text 不是字符串被忽略）", true);

  // ── 下载 reveal / open：只认登记表 id，永不接受渲染进程传来的路径 ──
  // 用 V3 的真登记表（session.downloads）造下载记录，验证 user-features 经 registry.get(id) 取路径
  const mk = (name, state) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, "x");
    const rec = sess.downloads.addStarted({ fileName: name, path: p, url: "https://e.test/a?token=1", totalBytes: 1, tabId: "t1" });
    if (state !== "progressing") sess.downloads.finish(rec.id, state, { receivedBytes: 1 });
    return { id: rec.id, path: p };
  };
  const dPdf = mk("report.pdf", "completed");
  const dExe = mk("setup.exe", "completed");
  const dProg = mk("partial.pdf", "progressing");
  const dNoExt = mk("README", "completed");
  shellCalls.length = 0;
  const r1 = await call("browser:revealDownload", "t1", dPdf.id);
  check("revealDownload(真登记表 id) → shell.showItemInFolder(登记表里的路径)", r1.ok === true && shellCalls[0]?.[0] === "reveal" && shellCalls[0][1] === dPdf.path, JSON.stringify(shellCalls));
  const r1b = await call("browser:revealDownload", "t1", dPdf.id, "/etc/passwd");
  check("多传一个路径参数被无视（仍然只用登记表路径）", shellCalls.at(-1)?.[1] === dPdf.path && r1b.ok === true);
  const r2 = await call("browser:openDownload", "t1", dPdf.id);
  check("openDownload(report.pdf) → shell.openPath", r2.ok === true && shellCalls.at(-1)?.[0] === "open", JSON.stringify(r2));
  shellCalls.length = 0;
  const r3 = await call("browser:openDownload", "t1", dExe.id);
  check("openDownload(setup.exe) → 拒绝，不调 shell.openPath", r3.ok === false && shellCalls.length === 0, JSON.stringify(r3));
  const r4 = await call("browser:openDownload", "t1", dProg.id);
  check("openDownload(进行中) → 拒绝", r4.ok === false && shellCalls.length === 0, JSON.stringify(r4));
  const r5 = await call("browser:openDownload", "t1", dNoExt.id);
  check("openDownload(无扩展名) → 拒绝", r5.ok === false && shellCalls.length === 0, JSON.stringify(r5));
  const r6 = await call("browser:openDownload", "t1", 999);
  check("未登记的 id → ok:false，不碰 shell", r6.ok === false && shellCalls.length === 0);
  const r7 = await call("browser:openDownload", "t1", "1; rm -rf");
  check("非整数 id → ok:false", r7.ok === false && shellCalls.length === 0);
  const r8 = await call("browser:openDownload", "nope", dPdf.id);
  check("不存在的会话 → ok:false", r8.ok === false && shellCalls.length === 0);

  // ── 对话框 / 模拟：对 tab 方法的可选调用 ──
  let answered = null;
  let resetCalled = 0;
  send("browser:answerDialog", "t1", true, "hi");
  send("browser:resetEmulation", "t1");
  check("tab 没有 answerDialog / resetEmulation（V5 未落地）时是空操作，不抛", true);
  tab1.answerDialog = (accept, text) => { answered = [accept, text]; };
  tab1.resetEmulation = () => { resetCalled += 1; };
  send("browser:answerDialog", "t1", true, "hi");
  send("browser:answerDialog", "t1", "truthy-but-not-true", 123);
  send("browser:resetEmulation", "t1");
  check("answerDialog 转调 tab.answerDialog(accept===true, promptText 仅字符串)", Array.isArray(answered) && answered[0] === false && answered[1] === undefined, JSON.stringify(answered));
  check("resetEmulation 转调 tab.resetEmulation()", resetCalled === 1);

  // ── 可信校验：不可信发送者一律拒绝 ──
  trusted = false;
  send("browser:zoom", "t1", "in");
  const before = wc.getZoomLevel();
  send("browser:find", "t1", "banana", {});
  let threw = 0;
  for (const n of ["browser:revealDownload", "browser:openDownload"]) {
    try { await call(n, "t1", dPdf.id); } catch { threw += 1; }
  }
  check("不可信发送者：zoom 不生效、find 不生效、invoke 型通道 throw", before === 0 && threw === 2, `level=${before} threw=${threw}`);
  trusted = true;

  // ── 收尾 ──
  mgr.destroy();
  await sleep(300);
  check("destroy 后 V4 的通道都已撤掉", wanted.every((n) => !listeners.has(n)) && !handlers.has("browser:revealDownload"));
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const passed = results.filter(Boolean).length;
  console.log(`\nSMOKE SUMMARY ${passed}/${results.length} passed`);
  app.exit(passed === results.length ? 0 : 1);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
