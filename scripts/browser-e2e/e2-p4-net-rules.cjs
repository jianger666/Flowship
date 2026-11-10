"use strict";
/**
 * E2·P4 真机 e2e（真 Electron + 真 CDP）：A5 网络规则（block / set_headers / mock / fail / delay / clear / 用户接管暂停 / Flowship origin 不生效）
 * + B1 网络增强（WebSocket 帧 / SSE 事件采集与脱敏、过滤参数、ReDoS 防护、initiator、HAR 导出）。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p4-net-rules.cjs --timeout 150
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动。临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；
 * 不碰 Flowship / FlowshipTest 与 8676/8776/8876。仓库没有 `ws` 依赖，WebSocket 端点手写 upgrade 握手 + 简易文本帧。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-p4-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`E2P4 ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, timeoutMs = 5000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(step);
  }
};

const SECRET = "sk-live-SUPERSECRETVALUE123456";
const TOKEN = "SUPERSECRETTOKEN123456";
const BEARER = "abcdef0123456789abcdef0123456789";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const textFrame = (s) => {
  const p = Buffer.from(s, "utf8");
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, p]);
};
/** 读第一个（客户端必然带掩码的）文本帧；够用即可，不处理分片 */
const readClientText = (buf) => {
  if (buf.length < 6) return null;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    len = buf.readUInt16BE(2);
    off = 4;
  }
  const mask = buf.subarray(off, off + 4);
  const data = buf.subarray(off + 4, off + 4 + len);
  return Buffer.from(data.map((b, i) => b ^ mask[i % 4])).toString("utf8");
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>P4</title></head><body><h1>P4</h1>
<script>
window.go = function (url, init) {
  const t0 = performance.now();
  return fetch(url, init).then(function (r) { return r.text().then(function (b) { return { status: r.status, body: b, ms: performance.now() - t0 }; }); })
    .catch(function (e) { return { error: String(e), ms: performance.now() - t0 }; });
};
function loadThing() { return fetch('/api/init').then(function (r) { return r.text(); }); }
window.loadThing = loadThing;
window.openWs = function () {
  return new Promise(function (resolve) {
    const got = [];
    const ws = new WebSocket('ws://127.0.0.1:' + location.port + '/ws');
    ws.onopen = function () { ws.send('hello token=${TOKEN}'); };
    ws.onmessage = function (e) { got.push(e.data); };
    ws.onclose = function () { resolve(got); };
    setTimeout(function () { resolve(got); }, 5000);
  });
};
window.openSse = function () {
  return new Promise(function (resolve) {
    const got = [];
    const es = new EventSource('/sse');
    const done = function (e) { got.push(e.data); if (got.length >= 3) { es.close(); resolve(got); } };
    es.onmessage = done;
    es.addEventListener('tick', done);
    setTimeout(function () { es.close(); resolve(got); }, 5000);
  });
};
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const p = u.pathname;
      seen.push({ path: p, headers: { ...req.headers } });
      res.setHeader("access-control-allow-origin", "*");
      if (p === "/") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(PAGE);
      }
      if (p === "/api/missing") {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        return res.end('{"error":"nope"}');
      }
      if (p === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`event: tick\nid: 1\ndata: hello Bearer ${BEARER}\n\n`);
        setTimeout(() => res.write(`data: q=1&token=${TOKEN}\n\n`), 80);
        setTimeout(() => res.write("event: tick\nid: 3\ndata: plain-event\n\n"), 160);
        req.on("close", () => res.end());
        return undefined;
      }
      res.setHeader("content-type", "application/json");
      if (p === "/api/post") return res.end('{"posted":true}');
      return res.end(JSON.stringify({ from: "server", path: p }));
    });
    server.on("upgrade", (req, socket) => {
      if (new URL(req.url, "http://x").pathname !== "/ws") return socket.destroy();
      const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}${WS_GUID}`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(textFrame(`{"auth":"Bearer ${BEARER}","hello":"world"}`));
      socket.on("data", (buf) => {
        const t = readClientText(buf);
        if (t !== null) {
          socket.write(textFrame(`echo:${t}`));
          setTimeout(() => {
            socket.write(Buffer.from([0x88, 0x00])); // close
            socket.end();
          }, 120);
        }
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` }));
  });

/** 模拟「Flowship 自身 origin」的第二个 http 服务：isAppUrl 按它的端口判 */
const startAppFixture = () =>
  new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("content-type", "text/plain");
      res.end("app-ok");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }));
  });

const main = async () => {
  await app.whenReady();
  const fx = await startFixture();
  const appFx = await startAppFixture();
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);

  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");

  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain,
    nativeImage,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: (u) => String(u).includes(`:${appFx.port}/`) || String(u).endsWith(`:${appFx.port}`),
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  manager.onConfig({ evaluateEnabled: true, networkBodyRead: true });

  const T = "e2p4-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  };
  const ev = async (expr) => (await call("evaluate", { expression: expr })).value;
  const go = (url, init) => ev(`window.go(${JSON.stringify(url)}${init ? `, ${JSON.stringify(init)}` : ""})`);
  const net = async (args = {}) => (await call("network", { limit: 500, ...args })).entries;
  const findEntry = async (suffix, extra = {}) => (await net(extra)).filter((e) => String(e.url).includes(suffix)).pop();

  await call("navigate", { url: `${fx.base}/` });
  const sess = manager.getSession(T);
  const tab = sess.getTab();

  // 记录 Fetch.enable / disable：Fetch 域是否「只在有规则时开」只能从命令序列上看
  const fetchLog = [];
  const origSend = tab.send.bind(tab);
  tab.send = (method, params, sid, timeout) => {
    if (method === "Fetch.enable" || method === "Fetch.disable") fetchLog.push(method);
    return origSend(method, params, sid, timeout);
  };

  // ═══════════ A5：规则 ═══════════
  const empty = await call("net_rules", { action: "list" });
  check("rules-empty", "没有规则：list 为空、从未开过 Fetch 域", empty.count === 0 && empty.rules.length === 0 && fetchLog.length === 0, { empty, fetchLog });

  // block
  const blk = await call("net_rules", { action: "block", pattern: "*/api/ads/*" });
  check("block-add", "block 规则添加成功并 Fetch.enable", blk.rule.id === "r1" && fetchLog.at(-1) === "Fetch.enable", blk);
  const seenBefore = fx.seen.length;
  const rBlocked = await go(`${fx.base}/api/ads/banner`);
  check("block-effect", "被 block 的请求在页面里失败（TypeError）", typeof rBlocked.error === "string" && /Failed to fetch/i.test(rBlocked.error), rBlocked);
  check("block-no-server", "被 block 的请求没有到达服务器", !fx.seen.slice(seenBefore).some((s) => s.path === "/api/ads/banner"));
  const eBlocked = await waitUntil(async () => (await findEntry("/api/ads/banner"))?.ruled === "block" && (await findEntry("/api/ads/banner")));
  check("block-flag", "network 列表里该请求带 ruled=block 且算 failed", eBlocked && eBlocked.ruled === "block" && eBlocked.failed === true, eBlocked);
  const rOk = await go(`${fx.base}/api/data?x=1`);
  check("block-nomatch", "不匹配的请求不受影响", rOk.status === 200 && /"from":"server"/.test(rOk.body), rOk);

  // set_headers：值只在主进程规则里 + 线上
  const sh = await call("net_rules", { action: "set_headers", pattern: "*/api/hdr*", headers: [{ name: "X-Flowship-Test", value: SECRET }] });
  await ev("document.cookie = 'sidtest=cookie-ok; path=/'");
  const rHdr = await go(`${fx.base}/api/hdr`);
  const hdrSeen = fx.seen.filter((s) => s.path === "/api/hdr").pop();
  check("headers-effect", "set_headers 后服务端收到了额外请求头", rHdr.status === 200 && hdrSeen?.headers["x-flowship-test"] === SECRET, { got: hdrSeen?.headers["x-flowship-test"] });
  // Fetch.continueRequest 的 headers 是整体替换：确认浏览器后加的 Cookie / UA 没被我们弄丢（调试带登录态的 API 时很关键）
  check("headers-keep-browser", "set_headers 不会丢掉浏览器自己带的 Cookie / User-Agent / Accept", String(hdrSeen?.headers.cookie).includes("sidtest=cookie-ok") && /Electron|Chrome/.test(String(hdrSeen?.headers["user-agent"])) && !!hdrSeen?.headers.accept, { cookie: hdrSeen?.headers.cookie, ua: String(hdrSeen?.headers["user-agent"]).slice(0, 40) });
  const listed = await call("net_rules", { action: "list" });
  const stateJson = JSON.stringify(sess.getState());
  const hdrEntry = await waitUntil(async () => (await findEntry("/api/hdr"))?.ruled === "headers" && (await findEntry("/api/hdr")));
  check(
    "headers-redacted",
    "list / 添加结果 / 状态 / 活动日志里都不含头值，只有头名",
    !JSON.stringify([sh, listed, stateJson, (await call("user_activity", { markSeen: false, limit: 100 })).entries]).includes(SECRET) &&
      listed.rules.find((r) => r.action === "set_headers")?.headerNames?.[0] === "X-Flowship-Test",
  );
  check("headers-flag", "被加头的请求在列表里标 ruled=headers", hdrEntry?.ruled === "headers", hdrEntry);
  const forbidden = await tryCall("net_rules", { action: "set_headers", pattern: "*/x", headers: { Host: "evil.test" } });
  check("headers-forbidden", "禁改头（Host）被拒 BAD_ARGS", !forbidden.ok && forbidden.code === "BAD_ARGS", forbidden);

  // mock（同源 + 跨源，跨源时自动回显 Origin 作为 ACAO）
  await call("net_rules", { action: "mock", pattern: "*/api/mocked*", status: 201, body: '{"mocked":true}', headers: [{ name: "X-Mock", value: "1" }] });
  const seenMock = fx.seen.length;
  const rMock = await go(`${fx.base}/api/mocked`);
  check("mock-effect", "mock：页面拿到自定义状态码与 body", rMock.status === 201 && rMock.body === '{"mocked":true}', rMock);
  check("mock-no-server", "被 mock 的请求没有到达服务器", !fx.seen.slice(seenMock).some((s) => s.path === "/api/mocked"));
  const rMockX = await go(`http://localhost:${fx.port}/api/mocked-x`);
  check("mock-cors", "跨源请求的 mock 不被 CORS 拦掉（回显 Origin）", rMockX.status === 201 && rMockX.body === '{"mocked":true}', rMockX);
  const eMock = await waitUntil(async () => (await findEntry("/api/mocked"))?.ruled === "mock" && (await findEntry("/api/mocked")));
  check("mock-flag", "列表里标 ruled=mock", eMock?.ruled === "mock", eMock);
  const mockHuge = await tryCall("net_rules", { action: "mock", pattern: "*/x", body: "a".repeat(1024 * 1024 + 1) });
  check("mock-huge", "mock body 超过 1MB 被拒", !mockHuge.ok && mockHuge.code === "BAD_ARGS");

  // fail
  await call("net_rules", { action: "fail", pattern: "*/api/fail*", errorReason: "ConnectionRefused" });
  const rFail = await go(`${fx.base}/api/fail`);
  const eFail = await waitUntil(async () => (await findEntry("/api/fail"))?.ruled === "fail" && (await findEntry("/api/fail")));
  check("fail-effect", "fail：页面请求失败，列表标 ruled=fail 且 errorText 含 CONNECTION_REFUSED", typeof rFail.error === "string" && eFail?.failed === true && /CONNECTION_REFUSED/i.test(eFail.errorText || ""), { rFail, eFail });

  // delay
  await call("net_rules", { action: "delay", pattern: "*/api/slow*", delayMs: 900 });
  const rSlow = await go(`${fx.base}/api/slow`);
  const rFast = await go(`${fx.base}/api/fast`);
  check("delay-effect", "delay：被延迟的请求耗时 ≥ 设定（900ms），未命中的很快", rSlow.status === 200 && rSlow.ms >= 850 && rFast.ms < 600, { slow: rSlow.ms, fast: rFast.ms });
  const delayTooLong = await tryCall("net_rules", { action: "delay", pattern: "*/x", delayMs: 30001 });
  check("delay-cap", "delay 超过 30s 被拒", !delayTooLong.ok && delayTooLong.code === "BAD_ARGS");

  // list / 上限
  const l2 = await call("net_rules", { action: "list" });
  check("list-count", "list 列出 5 条规则（block / headers / mock / fail / delay），命中次数 ≥1", l2.count === 5 && l2.rules.every((r) => r.hits >= 1), l2.rules.map((r) => `${r.id}:${r.action}:${r.hits}`));
  check("state-contrib", "状态里 netRules={count:5,paused:false}", JSON.stringify(sess.getState().netRules) === JSON.stringify({ count: 5, paused: false }), sess.getState().netRules);

  // clear 单条
  const cOne = await call("net_rules", { action: "clear", ruleId: "r1" });
  const seenAfterClear = fx.seen.length;
  const rAdsAfter = await go(`${fx.base}/api/ads/banner`);
  check("clear-one", "clear rule_id=r1 后该请求恢复（服务器收到）", cOne.removed === 1 && cOne.count === 4 && rAdsAfter.status === 200 && fx.seen.slice(seenAfterClear).some((s) => s.path === "/api/ads/banner"), { cOne, rAdsAfter });

  // 用户接管：自动暂停 / 恢复
  await call("net_rules", { action: "block", pattern: "*/api/ads/*" });
  const rBlockedAgain = await go(`${fx.base}/api/ads/banner`);
  check("pre-takeover", "接管前规则生效", typeof rBlockedAgain.error === "string", rBlockedAgain);
  const nFetch = fetchLog.length;
  sess.controller = "user";
  await sleep(400);
  check("takeover-disable", "用户接管：Fetch 域被关闭", fetchLog.length > nFetch && fetchLog.at(-1) === "Fetch.disable", fetchLog.slice(-3));
  // R6：接管期间 AI 的 evaluate 会被 USER_CONTROL 拒绝，所以这里直接在页面里发请求，模拟用户自己的操作（不经 AI 工具通道）
  const rPaused = await tab.wc.executeJavaScript(`window.go(${JSON.stringify(`${fx.base}/api/ads/banner`)})`);
  const lp = await call("net_rules", { action: "list" });
  check("takeover-paused", "接管期间原本被屏蔽的请求能通过，list 标 paused", rPaused.status === 200 && lp.paused === true && lp.count === 5, { rPaused, paused: lp.paused, count: lp.count });
  check("takeover-state", "状态 netRules.paused=true", sess.getState().netRules?.paused === true, sess.getState().netRules);
  const addDuring = await tryCall("net_rules", { action: "block", pattern: "*/api/other*" });
  check("takeover-usercontrol", "接管期间 AI 添加规则 → USER_CONTROL", !addDuring.ok && addDuring.code === "USER_CONTROL", addDuring);
  sess.controller = "idle";
  await sleep(400);
  check("handback-enable", "交还后 Fetch 域重新开启", fetchLog.at(-1) === "Fetch.enable", fetchLog.slice(-3));
  const rResumed = await go(`${fx.base}/api/ads/banner`);
  check("handback-effect", "交还后规则恢复生效（规则没丢）", typeof rResumed.error === "string", rResumed);

  // Flowship origin：`*` 也碰不到
  const seenApp = appFx.seen.length;
  await call("net_rules", { action: "block", pattern: "*" });
  await call("net_rules", { action: "set_headers", pattern: "*", headers: { "X-Evil": SECRET } });
  const rApp = await go(`http://127.0.0.1:${appFx.port}/api/app`);
  const rNon = await go(`${fx.base}/api/data?probe=1`);
  check("app-origin", "Flowship origin（isAppUrl）：pattern=* 的 block 也不生效、也没被注入头", rApp.status === 200 && rApp.body === "app-ok" && appFx.seen.length > seenApp, rApp);
  check("app-origin-control", "对照：非 Flowship 的请求被 `*` 屏蔽", typeof rNon.error === "string", rNon);

  // clear 全部：Fetch 关闭
  const cAll = await call("net_rules", { action: "clear" });
  check("clear-all", "clear 全部：removed 数 > 0，count=0，Fetch.disable", cAll.count === 0 && cAll.removed >= 6 && fetchLog.at(-1) === "Fetch.disable", { cAll, last: fetchLog.at(-1) });
  const rAfterAll = await go(`${fx.base}/api/ads/banner`);
  const rAfterAll2 = await go(`${fx.base}/api/data?probe=2`);
  check("clear-all-effect", "清空后请求全部恢复", rAfterAll.status === 200 && rAfterAll2.status === 200, { rAfterAll, rAfterAll2 });
  check("state-cleared", "清空后状态里没有 netRules", (sess.getState().netRules ?? null) === null, sess.getState().netRules);
  const nFetchEnd = fetchLog.length;
  await call("net_rules", { action: "clear" });
  check("clear-idempotent", "再次 clear 不重复发 Fetch.disable", fetchLog.length === nFetchEnd);

  // ═══════════ B1：WebSocket / SSE ═══════════
  const wsGot = await ev("window.openWs()");
  check("ws-page", "页面 WebSocket 收到服务端帧", Array.isArray(wsGot) && wsGot.length >= 2 && wsGot.some((m) => String(m).startsWith("echo:")), wsGot);
  const wsEntry = await waitUntil(async () => {
    const e = (await net({ type: "ws" })).pop();
    return e && e.closed === true ? e : null;
  }, 6000);
  check("ws-entry", "network type=ws 有 WebSocket 条目：status 101、帧数 ≥3、已关闭", wsEntry && wsEntry.type === "WebSocket" && wsEntry.status === 101 && wsEntry.frameCount >= 3, wsEntry);
  const wsDetail = await call("network_detail", { id: wsEntry.id, includeBody: true, frameLimit: 50 });
  const wsText = JSON.stringify(wsDetail.frames);
  check(
    "ws-frames-redacted",
    "WebSocket 帧被采集，Bearer / token 已脱敏（缓冲里没有明文）",
    wsDetail.frames.items.length >= 3 && !wsText.includes(BEARER) && !wsText.includes(TOKEN) && wsText.includes("[已隐藏]") && wsText.includes("world"),
    { total: wsDetail.frames.total, sample: wsText.slice(0, 300) },
  );
  const wsNoBody = await call("network_detail", { id: wsEntry.id });
  check("ws-frames-nobody", "没带 include_body 时不含帧文本", !JSON.stringify(wsNoBody.frames).includes("world") && wsNoBody.frames.textIncluded === false);

  const sseGot = await ev("window.openSse()");
  check("sse-page", "页面 EventSource 收到 3 个事件", Array.isArray(sseGot) && sseGot.length === 3, sseGot);
  const sseEntry = await waitUntil(async () => {
    const e = (await net({ type: "sse" })).pop();
    return e && e.frameCount >= 3 ? e : null;
  }, 6000);
  check("sse-entry", "network type=sse 有 EventSource 条目且事件数 ≥3", sseEntry && sseEntry.type === "EventSource" && sseEntry.frameCount >= 3, sseEntry);
  const sseDetail = await call("network_detail", { id: sseEntry.id, includeBody: true });
  const sseText = JSON.stringify(sseDetail.frames);
  check("sse-redacted", "SSE 事件被采集，token 已脱敏、事件名保留", !sseText.includes(BEARER) && !sseText.includes(TOKEN) && sseText.includes("tick") && sseText.includes("plain-event"), sseText.slice(0, 300));
  const idle = await tryCall("wait_for", { networkIdle: true, timeoutMs: 3000 });
  check("sse-idle", "已建立的 SSE 不让 networkIdle 永远等不到（≤3s 内返回，不是超时错误）", idle.ok === true || idle.code !== "TIMEOUT", { ok: idle.ok, code: idle.code });

  // ═══════════ B1：过滤 / initiator ═══════════
  await go(`${fx.base}/api/missing`);
  await go(`${fx.base}/api/post`, { method: "POST", body: "{}" });
  await go(`${fx.base}/api/data?token=${TOKEN}&ok=1`);
  await ev("window.loadThing()");
  await sleep(300);
  const f404 = await net({ status: "404" });
  check("filter-status", "status=404 只返回 404", f404.length >= 1 && f404.every((e) => e.status === 404), f404.map((e) => e.status));
  const f4xx = await net({ status: "4xx" });
  check("filter-status-class", "status=4xx 返回 4xx 一类", f4xx.length >= 1 && f4xx.every((e) => e.status >= 400 && e.status < 500));
  const fPost = await net({ method: "POST" });
  check("filter-method", "method=POST 只返回 POST", fPost.length >= 1 && fPost.every((e) => e.method === "POST"), fPost.map((e) => e.method));
  const fType = await net({ type: "xhr,fetch" });
  check("filter-type", "type=xhr,fetch 排除 Document / WebSocket", fType.length >= 3 && fType.every((e) => e.type === "XHR" || e.type === "Fetch"));
  const fRe = await net({ urlRegex: "/api/(data|post)" });
  check("filter-regex", "url_regex 只返回匹配的", fRe.length >= 2 && fRe.every((e) => /\/api\/(data|post)/.test(e.url)), fRe.length);
  const fOracle = await net({ urlRegex: TOKEN });
  check("filter-regex-oracle", "url_regex 对脱敏后的 URL 匹配：猜 query 里的密钥匹配不到", fOracle.length === 0, fOracle.map((e) => e.url));
  const urlHit = await findEntry("/api/data?token=");
  check("url-redacted", "列表里 URL 的 token 参数已脱敏", urlHit && !urlHit.url.includes(TOKEN) && urlHit.url.includes("ok=1"), urlHit?.url);
  const fFailed = await net({ failedOnly: true });
  check("filter-failed", "failed_only 只返回失败的（含 block / fail 的请求）", fFailed.length >= 2 && fFailed.every((e) => e.failed === true), fFailed.length);
  const fStatusFailed = await net({ status: "failed" });
  check("filter-status-failed", "status=failed 只含网络层失败（有 errorText，不含 404）", fStatusFailed.length >= 1 && fStatusFailed.every((e) => e.failed === true && e.errorText) && !fStatusFailed.some((e) => e.status === 404), fStatusFailed.length);
  const all = await net({});
  const mid = all[Math.floor(all.length / 2)].id;
  const fSince = await call("network", { sinceId: mid, limit: 500 });
  check("filter-since", "since_id 只返回更新的、lastId 可继续翻页", fSince.entries.length > 0 && fSince.entries.every((e) => e.id > mid) && fSince.lastId >= fSince.entries.at(-1).id, { n: fSince.entries.length, lastId: fSince.lastId });
  const t0 = Date.now();
  const redos = await tryCall("network", { urlRegex: "(a+)+$" });
  const redos2 = await tryCall("network", { urlRegex: `${"a".repeat(30)}*` });
  const redos3 = await tryCall("network", { urlRegex: "(a|aa)+$" });
  check("filter-redos", "ReDoS 病态正则被拒（BAD_ARGS），总耗时 <1s、不卡主进程", !redos.ok && redos.code === "BAD_ARGS" && !redos3.ok && redos3.code === "BAD_ARGS" && Date.now() - t0 < 1000 && (redos2.ok || redos2.code === "BAD_ARGS"), { redos: redos.code, redos3: redos3.code, ms: Date.now() - t0 });
  const longRegex = await tryCall("network", { urlRegex: "a".repeat(101) });
  check("filter-regex-long", "url_regex 超过 100 字符被拒", !longRegex.ok && longRegex.code === "BAD_ARGS");
  const eInit = await findEntry("/api/init");
  check(
    "initiator",
    "条目带 initiator：栈 ≤3 帧、含发起函数 loadThing",
    eInit?.initiator && eInit.initiator.stack.length >= 1 && eInit.initiator.stack.length <= 3 && /loadThing/.test(eInit.initiator.stack[0]),
    eInit?.initiator,
  );

  // ═══════════ B1：HAR ═══════════
  const har = await call("net_export", { limit: 500 });
  const harDir = path.join(TMP, "data", "tasks", T, "browser-har");
  const harText = fs.readFileSync(har.path, "utf8");
  let harObj = null;
  try {
    harObj = JSON.parse(harText);
  } catch {
    harObj = null;
  }
  check("har-valid", "export_har 产出合法 HAR 1.2（有 entries / request / response / timings）", harObj?.log?.version === "1.2" && harObj.log.entries.length >= 10 && harObj.log.entries.every((e) => e.request && e.response && e.timings && e.startedDateTime), { entries: har.entries });
  check("har-path", "HAR 文件在任务目录 browser-har/ 下，文件名由主进程生成", har.path.startsWith(harDir + path.sep) && /^net-\d{8}-\d{6}-127\.0\.0\.1\.har$/.test(har.file), har.file);
  check("har-redacted", "HAR 不含明文 token / Bearer / 头值", !harText.includes(TOKEN) && !harText.includes(BEARER) && !harText.includes(SECRET), { redacted: har.redacted });
  const wsHar = harObj.log.entries.find((e) => e._resourceType === "WebSocket");
  const sseHar = harObj.log.entries.find((e) => e._resourceType === "EventSource");
  check("har-streams", "HAR 带 WebSocket 帧与 SSE 事件（已脱敏）", wsHar?._webSocketMessages?.length >= 3 && sseHar?._serverSentEvents?.length >= 3, { ws: wsHar?._webSocketMessages?.length, sse: sseHar?._serverSentEvents?.length });
  const ruledHar = harObj.log.entries.filter((e) => e._ruled);
  check("har-ruled", "HAR 条目保留 _ruled 标记", ruledHar.length >= 3, ruledHar.map((e) => e._ruled));
  if (process.platform !== "win32") {
    check("har-mode", "HAR 文件 0600、目录 0700", (fs.statSync(har.path).mode & 0o777) === 0o600 && (fs.statSync(harDir).mode & 0o777) === 0o700, { file: (fs.statSync(har.path).mode & 0o777).toString(8), dir: (fs.statSync(harDir).mode & 0o777).toString(8) });
  }
  const harNoBody = await call("net_export", { limit: 100, includeBodies: false });
  check("har-nobody", "include_bodies=false：不含响应体", harNoBody.bodiesIncluded === false && !fs.readFileSync(harNoBody.path, "utf8").includes('"server"'));
  manager.onConfig({ evaluateEnabled: true, networkBodyRead: false });
  const harOff = await call("net_export", { limit: 100 });
  check("har-bodyread-off", "networkBodyRead 关闭：主进程独立拒绝取 body（bodiesDisabled）", harOff.bodiesIncluded === false && harOff.bodiesDisabled === true);
  manager.onConfig({ evaluateEnabled: true, networkBodyRead: true });
  const emptyExport = await tryCall("net_export", { urlRegex: "zzz-no-such-url" });
  check("har-empty", "没有匹配条目 → BAD_ARGS（不写空文件）", !emptyExport.ok && emptyExport.code === "BAD_ARGS");
  const leftovers = fs.readdirSync(harDir).filter((f) => f.endsWith(".tmp"));
  check("har-no-tmp", "导出目录没有残留临时文件", leftovers.length === 0, leftovers);

  // ═══════════ 生命周期：tab 关闭清规则 ═══════════
  await call("net_rules", { action: "block", pattern: "*/api/ads/*" });
  const rt = tab.ext.get("netrules");
  await call("tabs", { action: "close", tabId: tab.id });
  await sleep(200);
  check("tab-close", "tab 关闭 → 规则随之清除", rt.count() === 0 && (sess.getState().netRules ?? null) === null, { count: rt.count() });

  await call("close_session");
  fx.server.close();
  appFx.server.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`E2P4 SUMMARY ${passed}/${results.length} passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(passed === results.length ? 0 : 1);
};

main().catch((err) => {
  console.error("E2P4 FATAL", err && err.stack ? err.stack : err);
  const passed = results.filter((r) => r.ok).length;
  console.log(`E2P4 SUMMARY ${passed}/${results.length} passed (FATAL)`);
  app.exit(1);
});
