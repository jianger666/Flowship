"use strict";
/**
 * E2·P2 真机 e2e：A2 OAuth 弹窗收养 + A6 无痕标签（真实 Electron 42 + 真实 CDP）。
 *
 * A2（两个 127.0.0.1 不同端口模拟「应用页 ↔ 授权页」）：
 *   - AI 经 CDP 的 click 算手势 → window.open 被放行并收养成同会话同 partition 的 tab，window.opener 非 null；
 *     弹窗 opener.postMessage → 父页收到（origin 是授权页）；弹窗 window.close() → tab 关闭、父页 pop.closed === true、激活回到 opener；
 *   - 无手势的脚本 window.open 仍 deny + 开无 opener 的后台 tab（E1 行为不变）；
 *   - file: / chrome: / Flowship origin 弹窗 URL 被拒（不开任何 tab）；
 *   - 判定抛错 / 收养抛错：照样 deny + 退化成普通新标签，主进程不崩；
 *   - maxTabs：满了不收养也不补开。
 * A6：
 *   - tabs new {incognito:true} → 内存 partition、TabInfo.incognito；与持久档案 cookie / localStorage 双向隔离；
 *   - 弹窗继承无痕 partition（读得到无痕 cookie、读不到持久 cookie），先关弹窗不清无痕标签的数据；
 *   - browser:clearBrowsingData 只清持久档案；
 *   - 权限 / 下载守卫对无痕 partition 生效（getUserMedia 被拒、脚本下载被拦、手势下载放行）；
 *   - 关标签后 partition 被清空、没有 tab 再引用；复用 partition 的新无痕标签读不到上一个的数据；
 *   - 无痕标签计入 maxTabs。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p2-popup-incognito.cjs --timeout 150
 *
 * 临时 userData / 临时下载目录、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-p2-"));
const USERDATA = path.join(TMP, "userdata");
const DL = path.join(TMP, "downloads");
for (const d of [USERDATA, DL]) fs.mkdirSync(d, { recursive: true });
app.setPath("userData", USERDATA);
app.setPath("downloads", DL);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn 返回真值（或超时返回最后一次的值） */
const waitFor = async (fn, ms = 5000, step = 100) => {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await fn();
    } catch (e) {
      last = undefined;
    }
    if (last) return last;
    if (Date.now() >= end) return last;
    await sleep(step);
  }
};

let portA = 0;
let portB = 0;

// 应用页（父页）：按钮点击 → window.open 授权页；另有三个「被禁 URL」按钮与一个下载链接
const pageA = () => `<!doctype html><html><head><meta charset="utf-8"><title>A-app</title></head><body>
<h1>应用页</h1>
<p><button id="login" aria-label="用 Google 登录" onclick="window.__pop = window.open('http://127.0.0.1:${portB}/auth?x=1', 'oauth'); window.__popRet = window.__pop ? 'win' : 'null'">用 Google 登录</button></p>
<p><button id="login2" aria-label="另开授权窗口" onclick="window.__pop = window.open('http://127.0.0.1:${portB}/auth?x=2', '_blank'); window.__popRet = window.__pop ? 'win' : 'null'">另开授权窗口</button></p>
<p><button id="ofile" aria-label="打开 file 弹窗" onclick="window.__r = String(window.open('file:///etc/hosts'))">打开 file 弹窗</button></p>
<p><button id="ochrome" aria-label="打开 chrome 弹窗" onclick="window.__r = String(window.open('chrome://settings'))">打开 chrome 弹窗</button></p>
<p><button id="oapp" aria-label="打开应用弹窗" onclick="window.__r = String(window.open('http://127.0.0.1:9/x'))">打开应用弹窗</button></p>
<p><a id="dllink" href="/file.bin">下载文件链接</a></p>
<script>
window.__msgs = [];
window.addEventListener('message', function (e) { window.__msgs.push({ data: e.data, origin: e.origin }); });
</script></body></html>`;

// 授权页（弹窗）：报告自己有没有 opener，有就 postMessage 回去
const pageB = () => `<!doctype html><html><head><meta charset="utf-8"><title>B-auth</title></head><body>
<h1>授权页</h1>
<script>
window.__info = { hasOpener: !!window.opener, name: window.name };
try { if (window.opener) window.opener.postMessage({ type: 'oauth', code: 'abc123' }, '*'); } catch (e) { window.__info.err = String(e); }
</script></body></html>`;

const startServer = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

const main = async () => {
  await app.whenReady();
  const A = await startServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/file.bin") {
      const body = Buffer.alloc(1024, 65);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="report.txt"', "content-length": body.length });
      return res.end(body);
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pageA());
  });
  const B = await startServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pageB());
  });
  portA = A.port;
  portB = B.port;
  const ORIGIN_A = `http://127.0.0.1:${portA}`;
  const ORIGIN_B = `http://127.0.0.1:${portB}`;

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const tabMod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/tab.mjs")).href);
  const incMod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/incognito.mjs")).href);

  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");

  // 包一层真 ipcMain：留一份处理函数，脚本里像渲染进程那样调 browser:clearBrowsingData
  const ipcHandlers = new Map();
  const ipcSpy = {
    handle: (n, f) => {
      ipcHandlers.set(n, f);
      return ipcMain.handle(n, f);
    },
    on: (...a) => ipcMain.on(...a),
    removeHandler: (...a) => {
      ipcHandlers.delete(a[0]);
      return ipcMain.removeHandler(...a);
    },
    removeListener: (...a) => ipcMain.removeListener(...a),
  };
  const ipcCall = (n, ...a) => ipcHandlers.get(n)({ senderFrame: { url: "x" } }, ...a);

  // R6-10 / R6-11：真 Session 上的 closeAllConnections / clearAuthCache 调用观察（只包一层计数，仍调原实现）。
  // 「已放行坏证书的连接不再被复用」本身真机无法观测（需要真的 https 自签名站点 + 连接复用时序）：这里只钉「清除 / wipe / 会话结束时确实调用了」
  const netCalls = [];
  const spiedSession = {
    fromPartition: (name) => {
      const s = session.fromPartition(name);
      if (!s.__r6Spied) {
        s.__r6Spied = true;
        for (const m of ["closeAllConnections", "clearAuthCache"]) {
          const orig = typeof s[m] === "function" ? s[m].bind(s) : null;
          if (orig) {
            s[m] = (...a) => {
              netCalls.push({ partition: name, method: m });
              return orig(...a);
            };
          }
        }
      }
      return s;
    },
  };
  const callsOf = (partition, method) => netCalls.filter((c) => c.partition === partition && c.method === method).length;

  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session: spiedSession,
    ipcMain: ipcSpy,
    nativeImage,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: (u) => /:9\//.test(u), // 假的「应用端口」9：fixture 的随机端口不会被拦
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  manager.onConfig({ evaluateEnabled: true, maxTabs: 20 });
  manager.registerIpc();

  const T = "p2-task";
  const call = (op, args = {}, signal, taskId = T) => manager.dispatch(op, args, { taskId, signal });
  const tryCall = async (op, args, taskId) => {
    try {
      return { ok: true, value: await call(op, args, undefined, taskId) };
    } catch (e) {
      return { ok: false, code: e?.code, message: String(e?.message ?? e) };
    }
  };
  const ev = async (expr, tabId) => (await call("evaluate", { expression: expr, ...(tabId ? { tabId } : {}) })).value;
  const listTabs = async () => (await call("tabs", { action: "list" })).tabs;
  const sessionObj = () => manager.getSession(T);
  const tabObj = (id) => sessionObj().getTab(id);
  const refOf = (text, name) => {
    for (const line of text.split("\n")) {
      if (line.includes(name)) {
        const m = /\[ref=(e\d+)\]/.exec(line);
        if (m) return m[1];
      }
    }
    return null;
  };
  // 对指定 tab 取快照、找名字对应的 ref，再 AI 点击（CDP Input.dispatchMouseEvent）
  const clickByName = async (tabId, name) => {
    const snap = await call("snapshot", { tabId });
    const ref = refOf(snap.text, name);
    if (!ref) throw new Error(`快照里找不到「${name}」：${snap.text.slice(0, 300)}`);
    return call("click", { ref, tabId });
  };
  // 页面开 tab 限流（每 opener 10 秒 ≤ 3 个）是另一条已有单测覆盖的闸：脚本里每个小节前清一下，免得小节之间互相吃配额
  const resetThrottle = () => sessionObj().pageTabTimes?.clear?.();
  const closeAllExcept = async (keep) => {
    for (const t of await listTabs()) {
      if (t.id !== keep) await tryCall("tabs", { action: "close", tabId: t.id });
    }
    await tryCall("tabs", { action: "select", tabId: keep });
  };

  // ───────────────────────────── A2：OAuth 弹窗收养 ─────────────────────────────
  const nav = await call("navigate", { url: ORIGIN_A + "/" });
  check("nav", "navigate 打开应用页", nav.url.startsWith(ORIGIN_A) && nav.title === "A-app" && nav.tabId === "t1", nav);
  check("parent-no-opener", "顶层页 window.opener 为 null", (await ev("window.opener === null", "t1")) === true);

  // 1) 无手势的脚本 window.open：仍 deny + 无 opener 的后台 tab（E1 行为不变）
  resetThrottle();
  await ev(`window.__np = 'pending'; setTimeout(function(){ window.__np = String(window.open('${ORIGIN_B}/auth?script=1')); }, 10); 1`, "t1");
  const t2 = await waitFor(async () => (await listTabs()).length === 2 && (await listTabs()).find((t) => t.id !== "t1"));
  check("nogesture-new-tab", "无手势脚本 window.open → 开出一个新 tab", !!t2, t2 && t2.id);
  if (t2) {
    check("nogesture-deny", "window.open 返回 null（deny，页面拿不到窗口句柄）", (await ev("window.__np", "t1")) === "null", await ev("window.__np", "t1"));
    await waitFor(async () => (await ev("location.pathname", t2.id)) === "/auth");
    check("nogesture-no-opener", "该 tab 的 window.opener 为 null、不是收养的弹窗", (await ev("window.opener === null", t2.id)) === true && tabObj(t2.id).popup !== true);
    check("nogesture-no-steal", "后台脚本弹窗不抢占激活（激活 tab 仍是 t1）", (await call("tabs", { action: "list" })).activeTabId === "t1");
    await call("tabs", { action: "close", tabId: t2.id });
  }

  // 1b) R6-24①：页面自己合成的「点击」不是真实手势——dispatchEvent(new MouseEvent('click')) / el.click() 触发的 onclick 里 window.open
  // 不能换来 opener 弹窗：window.open 返回 null、没有收养、新开的 tab 无 opener（与 1) 同一条路径；真实手势只认浏览器进程输入管线里的按下事件
  for (const [label, expr] of [
    ["synthetic-dispatch", "document.getElementById('login').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))"],
    ["el-click", "document.getElementById('login2').click()"],
  ]) {
    resetThrottle();
    await ev(`window.__pop = undefined; window.__popRet = 'pending'; setTimeout(function(){ ${expr}; }, 10); 1`, "t1");
    const ts = await waitFor(async () => (await listTabs()).length === 2 && (await listTabs()).find((t) => t.id !== "t1"));
    check(`${label}-new-tab`, `${label}：合成点击里的 window.open → 只开出普通新 tab（不是收养的弹窗）`, !!ts, ts && ts.id);
    check(`${label}-deny`, `${label}：window.open 返回 null（页面拿不到窗口句柄）`, (await ev("window.__popRet", "t1")) === "null", await ev("window.__popRet", "t1"));
    if (ts) {
      check(`${label}-not-popup`, `${label}：该 tab 不是弹窗收养（popup !== true 且 opener 不是 t1 的活引用）`, tabObj(ts.id).popup !== true);
      await waitFor(async () => (await ev("location.pathname", ts.id)) === "/auth");
      check(`${label}-no-opener`, `${label}：新 tab 里 window.opener === null`, (await ev("window.opener === null", ts.id)) === true);
      check(`${label}-no-steal`, `${label}：不抢占激活（激活 tab 仍是 t1）`, (await call("tabs", { action: "list" })).activeTabId === "t1");
      await call("tabs", { action: "close", tabId: ts.id });
      await waitFor(async () => (await listTabs()).length === 1);
    }
  }

  // 2) AI 点击 → window.open 放行并收养（OAuth 主流程）
  resetThrottle();
  await ev("window.__msgs.length = 0; 1", "t1");
  await clickByName("t1", "用 Google 登录");
  const pop = await waitFor(async () => (await listTabs()).find((t) => t.id !== "t1"));
  check("popup-adopted", "AI 点击后弹窗被收养成一个 tab", !!pop, pop && pop.id);
  let popId = pop && pop.id;
  if (pop) {
    const popTab = tabObj(popId);
    const t1Tab = tabObj("t1");
    check("popup-flags", "tab.popup === true 且 opener === t1", popTab.popup === true && popTab.opener === "t1", { popup: popTab.popup, opener: popTab.opener });
    check(
      "popup-same-partition",
      "弹窗与 opener 同 partition / 同 Session，且是持久档案",
      popTab.partition === t1Tab.partition && popTab.partition === tabMod.BROWSER_PARTITION && popTab.wc.session === t1Tab.wc.session,
      { partition: popTab.partition },
    );
    check("popup-active", "opener 在前台 + 有手势 → 弹窗成为激活 tab", (await call("tabs", { action: "list" })).activeTabId === popId);
    await waitFor(async () => (await ev("location.pathname", popId)) === "/auth");
    check("popup-opener-nonnull", "弹窗里 window.opener 非 null 且 name 保留", JSON.stringify(await ev("JSON.stringify({ o: !!window.opener, n: window.name })", popId)) === JSON.stringify('{"o":true,"n":"oauth"}'));
    const info = await ev("JSON.stringify(window.__info)", popId);
    check("popup-info", "授权页自己的探测：hasOpener = true", JSON.parse(info).hasOpener === true, info);
    const msgs = await waitFor(async () => {
      const m = JSON.parse(await ev("JSON.stringify(window.__msgs)", "t1"));
      return m.length > 0 ? m : null;
    });
    check(
      "popup-postmessage",
      "弹窗 opener.postMessage → 父页收到 {code:abc123}，origin 是授权页",
      Array.isArray(msgs) && msgs[0].data && msgs[0].data.code === "abc123" && msgs[0].origin === ORIGIN_B,
      msgs,
    );
    check("popup-ret", "父页 window.open 返回了窗口句柄", (await ev("window.__popRet", "t1")) === "win");

    // 弹窗 window.close() → tab 关闭、父页 pop.closed、激活回到 opener
    await tryCall("evaluate", { expression: "window.close(); 1", tabId: popId });
    const gone = await waitFor(async () => (await listTabs()).length === 1);
    check("popup-close-removes-tab", "弹窗 window.close() → tab 被关闭", gone === true, (await listTabs()).map((t) => t.id));
    check("popup-closed-flag", "父页 pop.closed === true", (await waitFor(async () => (await ev("window.__pop.closed", "t1")) === true)) === true);
    check("popup-active-back", "弹窗关闭后激活回到 opener（t1）", (await call("tabs", { action: "list" })).activeTabId === "t1");
  }

  // 3) 被禁 URL 的弹窗（有手势也一律拒、不开任何 tab）
  for (const [btn, label] of [
    ["打开 file 弹窗", "file:"],
    ["打开 chrome 弹窗", "chrome:"],
    ["打开应用弹窗", "Flowship origin"],
  ]) {
    resetThrottle();
    await ev("window.__r = 'unset'; 1", "t1");
    await clickByName("t1", btn);
    await sleep(700);
    const tabsNow = await listTabs();
    check(`blocked-${label}`, `${label} 弹窗被拒：不开任何 tab、window.open 返回 null`, tabsNow.length === 1 && (await ev("window.__r", "t1")) === "null", { tabs: tabsNow.length, r: await ev("window.__r", "t1") });
  }

  // 4) 异常路径：判定抛错 → 仍 deny，退化成普通新标签（无 opener）
  resetThrottle();
  const t1Tab = tabObj("t1");
  const origHook = t1Tab.hooks.onPopupRequest;
  t1Tab.hooks.onPopupRequest = () => {
    throw new Error("boom（e2e 注入）");
  };
  await clickByName("t1", "用 Google 登录");
  const fb1 = await waitFor(async () => (await listTabs()).find((t) => t.id !== "t1"));
  check("throw-hook-fallback", "判定抛错：退化成普通新 tab（window.open 返回 null、无 opener）", !!fb1 && (await ev("window.__popRet", "t1")) === "null", fb1 && fb1.id);
  if (fb1) {
    await waitFor(async () => (await ev("location.pathname", fb1.id)) === "/auth");
    check("throw-hook-no-opener", "该 tab 没有 opener", (await ev("window.opener === null", fb1.id)) === true && tabObj(fb1.id).popup !== true);
    await call("tabs", { action: "close", tabId: fb1.id });
  }
  t1Tab.hooks.onPopupRequest = origHook;

  // 收养抛错：createWindow 回调里 session.openPopupTab 抛 → 关掉弹窗 wc + 补开普通新 tab，主进程不崩
  resetThrottle();
  const sess = sessionObj();
  sess.openPopupTab = () => {
    throw new Error("boom（e2e 注入收养失败）");
  };
  await clickByName("t1", "用 Google 登录");
  await sleep(900);
  const tabsAfterAdoptFail = await listTabs();
  const fb2 = tabsAfterAdoptFail.find((t) => t.id !== "t1");
  check("throw-adopt-fallback", "收养抛错：恰好补开 1 个普通新 tab（弹窗 wc 已关、没有重复）", tabsAfterAdoptFail.length === 2 && !!fb2, tabsAfterAdoptFail.map((t) => t.id));
  if (fb2) {
    await waitFor(async () => (await ev("location.pathname", fb2.id)) === "/auth");
    check("throw-adopt-no-opener", "补开的 tab 没有 opener，应用仍可正常 evaluate（主进程没崩）", (await ev("window.opener === null", fb2.id)) === true && tabObj(fb2.id).popup !== true);
  }
  delete sess.openPopupTab; // 去掉实例上的覆盖，回到原型方法
  await closeAllExcept("t1");

  // ───────────────────────────── A6：无痕标签 ─────────────────────────────
  // 持久档案先种 cookie / localStorage
  await ev("document.cookie = 'p=persist; path=/'; localStorage.setItem('k', 'persist'); 1", "t1");

  const newInc = await call("tabs", { action: "new", incognito: true, url: ORIGIN_A + "/" });
  const incInfo = newInc.tabs.find((t) => t.incognito === true);
  check("inc-tabinfo", "tabs new {incognito:true} → TabInfo.incognito === true，其余 tab 没有该字段", !!incInfo && newInc.tabs.filter((t) => t.incognito).length === 1 && newInc.tabs.find((t) => t.id === "t1").incognito === undefined, newInc.tabs.map((t) => ({ id: t.id, inc: t.incognito })));
  const incId = incInfo && incInfo.id;
  const incTab = tabObj(incId);
  const incPart = incTab.partition;
  check(
    "inc-partition",
    "无痕 tab 是内存 partition（无 persist: 前缀、匹配命名规则）且与持久档案是不同 Session",
    !incPart.startsWith("persist:") && incMod.INCOGNITO_PARTITION_RE.test(incPart) && incTab.wc.session !== tabObj("t1").wc.session && incTab.incognito === true,
    { incPart },
  );
  // 隔离：持久种的在无痕读不到；无痕种的在持久读不到
  check("iso-persist-to-inc-cookie", "持久 tab 设的 cookie 在无痕 tab 读不到", !(await ev("document.cookie", incId)).includes("p=persist"), await ev("document.cookie", incId));
  check("iso-persist-to-inc-ls", "持久 tab 设的 localStorage 在无痕 tab 读不到", (await ev("localStorage.getItem('k')", incId)) === null);
  await ev("document.cookie = 'i=incog; path=/'; localStorage.setItem('ik', 'incog'); 1", incId);
  check("iso-inc-to-persist-cookie", "无痕 tab 设的 cookie 在持久 tab 读不到（持久的 p 仍在）", !(await ev("document.cookie", "t1")).includes("i=incog") && (await ev("document.cookie", "t1")).includes("p=persist"), await ev("document.cookie", "t1"));
  check("iso-inc-to-persist-ls", "无痕 tab 设的 localStorage 在持久 tab 读不到", (await ev("localStorage.getItem('ik')", "t1")) === null);

  // partition 配置对无痕生效：权限（getUserMedia 一律拒）、下载守卫
  const gum = (id) => ev("navigator.mediaDevices.getUserMedia({ video: true }).then(function(){ return 'granted'; }, function(e){ return e.name; })", id);
  const gumInc = await gum(incId);
  check("inc-permission-denied", "无痕 partition 的权限处理器生效：getUserMedia 被拒（NotAllowedError，与持久档案一致）", gumInc === "NotAllowedError" && (await gum("t1")) === "NotAllowedError", { inc: gumInc });
  const incSes = session.fromPartition(incPart);
  check("inc-download-hook", "无痕 partition 装了 will-download 守卫", incSes.listenerCount("will-download") >= 1, incSes.listenerCount("will-download"));
  await ev("(function(){ var a = document.createElement('a'); a.href = '/file.bin'; a.download = 'x.txt'; document.body.appendChild(a); a.click(); })(); 1", incId);
  await sleep(1500);
  check("inc-download-guard-blocks", "无痕 tab 里脚本（无手势）触发的下载被拦：下载目录没有文件", fs.readdirSync(DL).length === 0, fs.readdirSync(DL));
  await clickByName(incId, "下载文件链接");
  const dlOk = await waitFor(() => fs.existsSync(path.join(DL, "report.txt")) && fs.statSync(path.join(DL, "report.txt")).size === 1024, 8000);
  check("inc-download-gesture-ok", "无痕 tab 里 AI 点击（有手势）的下载放行并落盘（守卫能找到无痕 session 的所属 tab）", dlOk === true, fs.readdirSync(DL));

  // 无痕标签的弹窗继承其 partition
  resetThrottle();
  await ev("window.__msgs.length = 0; 1", incId);
  await clickByName(incId, "用 Google 登录");
  const incPop = await waitFor(async () => (await listTabs()).find((t) => t.id !== "t1" && t.id !== incId));
  check("inc-popup-adopted", "无痕 tab 的弹窗被收养", !!incPop, incPop && incPop.id);
  if (incPop) {
    const ipTab = tabObj(incPop.id);
    check("inc-popup-partition", "弹窗继承无痕 partition（同名、同 Session、仍标记无痕）", ipTab.partition === incPart && ipTab.wc.session === incTab.wc.session && ipTab.incognito === true && incPop.incognito === true, { partition: ipTab.partition });
    await waitFor(async () => (await ev("location.pathname", incPop.id)) === "/auth");
    const pc = await ev("document.cookie", incPop.id);
    check("inc-popup-cookie", "弹窗读得到无痕 cookie、读不到持久 cookie", pc.includes("i=incog") && !pc.includes("p=persist"), pc);
    const m = await waitFor(async () => {
      const arr = JSON.parse(await ev("JSON.stringify(window.__msgs)", incId));
      return arr.length > 0 ? arr : null;
    });
    check("inc-popup-postmessage", "无痕弹窗同样能 opener.postMessage", Array.isArray(m) && m[0].data.code === "abc123", m);
    await tryCall("evaluate", { expression: "window.close(); 1", tabId: incPop.id });
    await waitFor(async () => !(await listTabs()).some((t) => t.id === incPop.id));
    await sleep(500); // 给「最后一个引用才清」的异步清空留时间：若引用计数有误，这里会把无痕标签的数据清掉
    check("inc-popup-close-keeps-data", "先关弹窗不清无痕标签的数据（引用计数）", (await ev("document.cookie", incId)).includes("i=incog") && (await ev("localStorage.getItem('ik')", incId)) === "incog");
  }

  // clearBrowsingData 只清持久档案
  const closeBefore = callsOf(tabMod.BROWSER_PARTITION, "closeAllConnections");
  await ipcCall("browser:clearBrowsingData");
  check("clear-closes-connections", "R6-10：clearBrowsingData 对持久 session 调了 closeAllConnections（真 Session 上存在该方法）", typeof session.fromPartition(tabMod.BROWSER_PARTITION).closeAllConnections === "function" && callsOf(tabMod.BROWSER_PARTITION, "closeAllConnections") === closeBefore + 1, netCalls);
  check("clear-skips-incognito-conn", "R6-10：clearBrowsingData 不断无痕 session 的连接", callsOf(incPart, "closeAllConnections") === 0, netCalls);
  const persistCookie = await ev("document.cookie", "t1");
  check("clear-persist-wiped", "clearBrowsingData 清掉持久档案的 cookie / localStorage", !persistCookie.includes("p=persist") && (await ev("localStorage.getItem('k')", "t1")) === null, persistCookie);
  check("clear-inc-untouched", "clearBrowsingData 不影响无痕 tab 的 cookie / localStorage", (await ev("document.cookie", incId)).includes("i=incog") && (await ev("localStorage.getItem('ik')", incId)) === "incog");

  // 关无痕标签 → partition 被清空、没人再引用；复用该 partition 的新无痕标签读不到旧数据
  const cookiesBefore = await incSes.cookies.get({});
  check("inc-has-cookie-before-close", "关闭前无痕 session 里确实有 cookie（排除空转）", cookiesBefore.some((c) => c.name === "i"), cookiesBefore.map((c) => c.name));
  await call("tabs", { action: "close", tabId: incId });
  const wiped = await waitFor(async () => (await incSes.cookies.get({})).length === 0, 6000);
  check("inc-close-wipes", "关闭无痕 tab 后其 partition 的 cookie 被清空", wiped === true, (await incSes.cookies.get({})).map((c) => c.name));
  const connClosed = await waitFor(async () => callsOf(incPart, "closeAllConnections") >= 1, 4000);
  check("inc-wipe-closes-connections", "R6-10：无痕 wipe 之后对该 partition 调了 closeAllConnections（并清了认证缓存）", connClosed === true && callsOf(incPart, "clearAuthCache") >= 1, netCalls);
  check("inc-close-unreferenced", "会话里不再有 tab 引用该 partition", !sessionObj().tabs.some((t) => t.partition === incPart));
  const inc2 = await call("tabs", { action: "new", incognito: true, url: ORIGIN_A + "/" });
  const inc2Info = inc2.tabs.find((t) => t.incognito === true);
  const inc2Id = inc2Info && inc2Info.id;
  check(
    "inc-reuse-clean",
    "新无痕标签（可能复用刚清空的 partition）读不到上一个无痕标签的 cookie / localStorage",
    !!inc2Id && !(await ev("document.cookie", inc2Id)).includes("i=incog") && (await ev("localStorage.getItem('ik')", inc2Id)) === null,
    { reused: inc2Id ? tabObj(inc2Id).partition === incPart : null },
  );
  await call("tabs", { action: "close", tabId: inc2Id });

  // maxTabs：弹窗 / 无痕 tab 都计入；满了不收养也不补开
  await closeAllExcept("t1");
  manager.onConfig({ maxTabs: 5 });
  for (let i = 0; i < 3; i++) await call("tabs", { action: "new" });
  const fifth = await call("tabs", { action: "new", incognito: true });
  check("max-incognito-counts", "无痕 tab 计入 maxTabs（t1 + 3 普通 + 1 无痕 = 5）", fifth.tabs.length === 5 && fifth.tabs.filter((t) => t.incognito).length === 1, fifth.tabs.length);
  const sixthInc = await tryCall("tabs", { action: "new", incognito: true });
  const sixth = await tryCall("tabs", { action: "new" });
  check("max-reject-new", "满额后 tabs new（含无痕）→ BAD_ARGS「已达上限」", !sixthInc.ok && sixthInc.code === "BAD_ARGS" && /上限/.test(sixthInc.message) && !sixth.ok && sixth.code === "BAD_ARGS", { sixthInc, sixth });
  await call("tabs", { action: "select", tabId: "t1" });
  resetThrottle();
  await ev("window.__popRet = 'unset'; 1", "t1");
  await clickByName("t1", "用 Google 登录");
  await sleep(900);
  const afterFull = await listTabs();
  check("max-popup-denied", "满额时弹窗不被收养、也不补开（tab 数仍为 5，window.open 返回 null）", afterFull.length === 5 && (await ev("window.__popRet", "t1")) === "null", { n: afterFull.length });
  manager.onConfig({ maxTabs: 20 });
  await closeAllExcept("t1");

  // 页面开 tab 限流（每 opener 10 秒 ≤ 3 个）：前 3 次放行并收养，第 4 次被限流——既不收养也不补开；
  // 前面被拒的 URL（file: / chrome: / Flowship origin）与满额拒绝都没吃配额，所以这里从干净窗口数起
  resetThrottle();
  // 用 `_blank` 的按钮：固定窗口名（oauth）会复用已开的同名弹窗，不会新开
  for (let i = 1; i <= 3; i++) {
    await call("tabs", { action: "select", tabId: "t1" });
    await clickByName("t1", "另开授权窗口");
    await waitFor(async () => (await listTabs()).length === 1 + i);
  }
  const adoptedN = (await listTabs()).filter((t) => t.id !== "t1" && tabObj(t.id).popup === true).length;
  check("throttle-first-three", "限流窗口内前 3 次弹窗全部被收养", adoptedN === 3, adoptedN);
  await call("tabs", { action: "select", tabId: "t1" });
  await ev("window.__popRet = 'unset'; 1", "t1");
  await clickByName("t1", "另开授权窗口");
  await sleep(900);
  const afterThrottle = await listTabs();
  check("throttle-fourth-dropped", "第 4 次被限流：tab 数仍为 4、window.open 返回 null（不收养也不补开）", afterThrottle.length === 4 && (await ev("window.__popRet", "t1")) === "null", { n: afterThrottle.length });
  await closeAllExcept("t1");

  // R6-11：任务结束（close_session）→ 持久 partition 的认证缓存被清（HTTP Basic / NTLM 缓存不跨任务）。
  // 真机能观测到的只有「调用了 clearAuthCache」；缓存是否真的清空要真的 401 站点 + 第二个任务，本脚本不做
  const authBefore = callsOf(tabMod.BROWSER_PARTITION, "clearAuthCache");
  await call("close_session", {});
  const authCleared = await waitFor(async () => callsOf(tabMod.BROWSER_PARTITION, "clearAuthCache") > authBefore, 3000);
  check("session-end-clears-auth", "R6-11：close_session → 对持久 session 调了 clearAuthCache", authCleared === true, netCalls);

  manager.destroy();
  A.server.closeAllConnections?.();
  B.server.closeAllConnections?.();
  A.server.close();
  B.server.close();
};

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结果 */
    }
    app.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error("SMOKE ERROR", (e && e.stack) || e);
    const failed = results.filter((r) => !r.ok);
    console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed（脚本中途异常）${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`);
    app.exit(1);
  });
