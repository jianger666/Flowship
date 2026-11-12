"use strict";
/**
 * R14 回归（真 Electron + 真 CDP；2026-11-11 16:29 正式包 v1.9.47 闪退）：AI 给 `*unassigned/page*` 设了 net_rules mock，2 秒后 browser_click
 * 点了会触发该请求的按钮，主进程 CrBrowserMain SIGSEGV（EXC_BAD_ACCESS，地址 0xefefef…＝PartitionAlloc 把「释放后仍被引用」的内存刷成 0xEF）。
 *
 * 根因（Chromium 自己的 bug，我们改不了；Electron 42.4.0 实测）：对「CORS 模式、带请求体、跨源」的 XHR / fetch 下**任何终结命令**都会令浏览器进程释放后使用——
 * 不只是 `Fetch.fulfillRequest`，**`Fetch.failRequest` 也崩**（任何 errorReason）。事故简报最初说「fail / block 不崩」是被 CORS 预检混淆了：
 * json 的跨源 POST 先发预检，fail 规则把预检先失败，真正带体的 POST 根本没发出来；用不触发预检的 text/plain POST 配 fail / block 规则同样 SIGSEGV。
 * 不崩的：`Fetch.continueRequest`（含改写 url）、跨源 GET / DELETE、跨源不带体的 POST、同源请求的 fulfill / fail、预检（没有体）的 fulfill / fail。
 *
 * 防护（electron-app/browser/net-rules-engine.mjs 的 decideForRequest / terminalWouldCrashChromium / REFUSE_URL）：block / fail / mock 命中
 * 「带体且不能确认同源」的请求时**不发任何终结命令、也不放行真请求**，改发 `continueRequest` 并把 url 改写到 Chromium 受限端口（连接前就被拒），
 * 请求在本机立刻失败（页面看到网络错误、请求体不外发）；条目 ruled 仍是 block / fail，mock 则是 `mock-refused`。
 *
 * 旧代码（没有防护）在第一次「跨源 POST + mock + 点击」就 SIGSEGV——启动器会报「Electron 被信号 SIGSEGV 结束」，最后一条 SMOKE BEGIN 就是触发步骤。
 * 有防护时应全绿：
 *   ① 跨源 JSON POST + mock + 真点击：Electron 不崩；页面看到网络错误；网络列表里该请求 ruled=mock-refused 且 failed；
 *      **真后端没有收到这个 POST**（拒绝而不是放行）；CORS 预检仍被系统代答（后端没收到 OPTIONS）；
 *   ② 同类形态一并不崩、不放行：text/plain POST（不触发预检）、PUT / PATCH、fetch（非 XHR）、同 site 不同端口、sendBeacon；
 *   ③ 不误伤：同源 POST 带体、跨源 GET、跨源 POST 不带体的 mock 仍然正常生效（拿到 mock 的状态码与 body、标记 ruled=mock、真后端没收到）；
 *   ④ block / fail 规则对同样的请求同样不崩（它们原来发的 failRequest 就会崩）；对安全类请求仍走原来的 failRequest（errorText 是 BLOCKED_BY_CLIENT / CONNECTION_REFUSED）；
 *   ⑤ 全局不变量：整个运行期间没有任何「带体 + 跨源」的暂停请求收到过 fulfillRequest / failRequest（旁路记录每条 Fetch 命令与对应请求）；
 *   ⑥ 没有主进程 uncaughtException，主进程存活至收尾。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r14-mock-no-fulfill-crash.cjs --timeout 120
 *
 * 临时 userData、窗口 show:false、fixture 都在回环随机端口；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 * 调查崩溃用的单形态探针（PROBE_MODE / PROBE_RULE 等开关）见同目录 r14-mock-fulfill-probe.cjs。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-r14-mock-"));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
};
const info = (id, name, detail) => console.log(`SMOKE INFO ${id} ${name} ${JSON.stringify(detail)}`);
// 崩了的话，最后一条 BEGIN 就是触发步骤（启动器会报「被信号 SIGSEGV 结束」）
const begin = (msg) => console.log(`SMOKE BEGIN ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000, step = 50) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return (await fn()) || null;
};

const uncaught = [];
process.on("uncaughtException", (e) => {
  uncaught.push(String((e && e.message) || e));
  console.log("  [uncaughtException]", (e && e.stack) || e);
});

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

const MOCK_BODY = JSON.stringify({ mocked: true, total: 3, list: ["a", "b", "c"] });

const main = async () => {
  await app.whenReady();

  // 跨源 API 服务：用 localhost 访问（页面在 127.0.0.1）→ 跨 origin 且跨 site；记录每个到达真后端的请求。
  // 预检答 max-age=0：每次跨源 JSON POST 都真的发预检（否则 Chromium 默认缓存 5 秒，「预检被代答」的断言就可能空转）
  const apiSeen = [];
  const api = await listen((req, res) => {
    apiSeen.push({ method: req.method, url: req.url });
    res.setHeader("access-control-allow-origin", req.headers.origin || "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-max-age", "0");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ from: "real-server", method: req.method }));
  });
  const apiBase = `http://localhost:${api.port}`;
  const apiSameSite = `http://127.0.0.1:${api.port}`; // 与页面同 site（都是 127.0.0.1）、不同 origin（端口不同）

  const PAGE = `<!doctype html><meta charset="utf-8"><title>r14</title>
<h1>r14</h1>
<button id="q">查询</button> <pre id="out"></pre>
<script>
window.__cnt = 0;
// 统一的请求发射器：返回 {status, text} 或 {error}；via=fetch 走 fetch，否则 XHR；body 缺省 = 不带体
window.go = function (method, url, opt) {
  opt = opt || {};
  var hasBody = opt.body !== undefined;
  if (opt.via === 'fetch') {
    var init = { method: method };
    if (hasBody) { init.body = opt.body; init.headers = { 'Content-Type': opt.ctype }; }
    return fetch(url, init).then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t.slice(0, 120) }; }); }).catch(function (e) { return { error: String(e) }; });
  }
  return new Promise(function (resolve) {
    var x = new XMLHttpRequest();
    x.open(method, url);
    if (hasBody) x.setRequestHeader('Content-Type', opt.ctype);
    x.onload = function () { resolve({ status: x.status, text: x.responseText.slice(0, 120) }); };
    x.onerror = function () { resolve({ error: 'xhr-error' }); };
    x.onabort = function () { resolve({ error: 'xhr-abort' }); };
    x.send(hasBody ? opt.body : null);
  });
};
window.beacon = function (url) { return navigator.sendBeacon(url, '{"a":1}'); };
// 现场的按钮：点击 → 跨源 JSON POST（带体）
document.getElementById('q').onclick = function () {
  window.__cnt++;
  window.go('POST', '${apiBase}/unassigned/page?n=' + window.__cnt, { ctype: 'application/json', body: JSON.stringify({ pageNum: 1, pageSize: 100, kw: '中文' }) })
    .then(function (r) { document.getElementById('out').textContent = JSON.stringify(r); });
};
</script>`;
  const siteSeen = [];
  const site = await listen((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/favicon.ico") {
      res.statusCode = 404;
      return res.end();
    }
    if (p.includes("unassigned/page")) {
      siteSeen.push({ method: req.method, url: req.url });
      res.setHeader("content-type", "application/json");
      return res.end('{"from":"real-site"}');
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  const base = `http://127.0.0.1:${site.port}`;

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const mainWin = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");
  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain,
    nativeImage,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: (u) => /:9\//.test(u), // 假的「应用端口」9：fixture 的随机端口不会被拦
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  manager.onConfig({ evaluateEnabled: true });

  const T = "r14-mock-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
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
  const clickBtn = async (name) => {
    const s = await call("snapshot", {});
    const ref = refOf(s.text, name);
    if (!ref) throw new Error(`snapshot 里没找到按钮 ${name}`);
    return call("click", { ref });
  };
  const readOut = async () => {
    const t = await ev("document.getElementById('out').textContent");
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return null;
    }
  };
  /** 真点击「查询」，等页面把结果写进 #out */
  const clickAndRead = async () => {
    await ev("document.getElementById('out').textContent = ''; 1");
    await clickBtn("查询");
    return until(readOut, 8000);
  };
  /** 经页面的 window.go 发一个请求（evaluate 会等 Promise） */
  const fire = (method, url, opt) => ev(`window.go(${JSON.stringify(method)}, ${JSON.stringify(url)}, ${JSON.stringify(opt || {})})`);
  const isErr = (r) => !!r && typeof r.error === "string";
  const netEntries = async () => (await call("network", { limit: 500 })).entries;
  const findEntry = async (pred) => (await netEntries()).filter(pred).pop();
  /** 到达真后端（非预检）的 unassigned/page 请求数 */
  const apiRealHits = () => apiSeen.filter((s) => s.method !== "OPTIONS" && /unassigned\/page/.test(s.url)).length;
  const apiPreflights = () => apiSeen.filter((s) => s.method === "OPTIONS").length;

  await call("navigate", { url: `${base}/` });

  // 旁路记录主 tab 的 Fetch 终结 / 放行命令与 requestPaused 载荷（拿不到就降级成只看「不崩 + 真后端没收到」）
  const tab = manager.getSession(T).activeTab;
  const dbg = tab.wc.debugger;
  const sent = [];
  const paused = new Map(); // requestId → { method, hasBody, crossOrigin }
  const origSend = dbg.sendCommand.bind(dbg);
  let tapped = true;
  const originOf = (u) => {
    try {
      return new URL(String(u)).origin;
    } catch {
      return null;
    }
  };
  try {
    dbg.sendCommand = (method, params, sessionId) => {
      if (/^Fetch\.(fulfillRequest|failRequest|continueRequest)$/.test(method)) sent.push({ method, requestId: params && params.requestId, code: params && params.responseCode, url: params && params.url });
      return origSend(method, params, sessionId);
    };
    dbg.on("message", (_e, method, params) => {
      if (method !== "Fetch.requestPaused" || !/unassigned\/page/.test(String(params && params.request && params.request.url))) return;
      const r = params.request;
      const h = r.headers || {};
      const originH = Object.entries(h).find(([k]) => k.toLowerCase() === "origin");
      const hasBody = r.hasPostData === true || (typeof r.postData === "string" && r.postData !== "");
      const same = !!originH && originOf(originH[1]) !== null && originOf(originH[1]) === originOf(r.url);
      paused.set(params.requestId, { method: r.method, hasBody, crossOrigin: !same, origin: originH ? originH[1] : undefined });
    });
  } catch {
    tapped = false;
  }
  if (!tapped || dbg.sendCommand === origSend) {
    tapped = false;
    info("tap", "debugger 不可旁路记录，旁路断言降级为只看不崩 + 真后端没收到", {});
  }
  const pausedList = () => [...paused.entries()].map(([requestId, p]) => ({ requestId, ...p }));

  // ───── 基线：没有规则时点一次，请求真的到达后端（也证明夹具本身是通的） ─────
  begin("S0 无规则点击（真请求）");
  const r0 = await clickAndRead();
  check("baseline-real", "无规则：跨源 JSON POST 真的到达后端，页面拿到真响应；预检也到达后端", r0 && r0.status === 200 && /real-server/.test(r0.text) && apiRealHits() === 1 && apiPreflights() >= 1, { r0, hits: apiRealHits(), preflights: apiPreflights() });

  // ───── ① 现场复刻：设 mock（跨源 API 路径），隔 2 秒真点击 ─────
  begin("S1 设置 mock 规则（*unassigned/page*）");
  const rule = await call("net_rules", { action: "mock", pattern: "*unassigned/page*", status: 200, body: MOCK_BODY });
  check("rule-added", "mock 规则添加成功", rule && rule.rule && rule.rule.id === "r1", rule && rule.rule);
  await sleep(2000);
  const pre1 = { real: apiRealHits(), preflights: apiPreflights(), sent: sent.length, paused: paused.size };
  begin("S1 点击触发被 mock 的跨源带体 POST（现场崩溃点；旧代码在这里 SIGSEGV）");
  const r1 = await clickAndRead();
  check("cross-post-click-error", "①跨源 JSON POST + mock + 真点击：Electron 没崩，页面看到网络错误（没有拿到 mock 的响应）", isErr(r1), r1);
  check("cross-post-no-real", "①真后端没有收到这个 POST（被拒绝，而不是放行）", apiRealHits() === pre1.real, { before: pre1.real, after: apiRealHits() });
  check("cross-post-preflight", "①CORS 预检仍被系统代答：真后端没收到新的 OPTIONS", apiPreflights() === pre1.preflights, { before: pre1.preflights, after: apiPreflights() });
  const e1 = await until(async () => {
    const e = await findEntry((x) => String(x.url).includes("/unassigned/page?n=2"));
    return e && e.ruled === "mock-refused" && e.failed === true ? e : null;
  }, 5000);
  check("cross-post-flag", "①网络列表里该请求 ruled=mock-refused 且算 failed", !!e1, e1 || (await findEntry((x) => String(x.url).includes("/unassigned/page?n=2"))));
  info("cross-post-errtext", "被就地拒绝的请求在列表里的 errorText（预期 net::ERR_UNSAFE_PORT）", e1 && e1.errorText);
  if (tapped) {
    const seenP = pausedList().slice(pre1.paused);
    const post = seenP.find((p) => p.method === "POST");
    const pre = seenP.find((p) => p.method === "OPTIONS");
    check("tap-payload", "旁路：requestPaused 里有预检 OPTIONS（没有体）与 hasPostData=true 且 Origin 跨源的 POST（防护判定依据的真实载荷）", !!pre && !!post && post.hasBody && !pre.hasBody && post.crossOrigin && typeof post.origin === "string", { pre, post });
    const cmds = sent.slice(pre1.sent);
    const forPost = cmds.filter((c) => post && c.requestId === post.requestId);
    check(
      "tap-refuse-shape",
      "旁路：带体的 POST 只收到一条 continueRequest（url 被改写到回环受限端口），没有 fulfillRequest / failRequest；预检被 fulfill（204）",
      forPost.length === 1 && forPost[0].method === "Fetch.continueRequest" && /^http:\/\/127\.0\.0\.1:1\//.test(forPost[0].url || "") && cmds.some((c) => pre && c.requestId === pre.requestId && c.method === "Fetch.fulfillRequest" && c.code === 204),
      { forPost, n: cmds.length },
    );
  }

  // ───── ② 同类形态：都不崩、都不放行 ─────
  const matrix = [
    ["cross-post-plain", "POST", `${apiBase}/unassigned/page?m=plain`, { ctype: "text/plain", body: '{"a":1}' }, "text/plain 的 POST 不触发预检"],
    ["cross-put-json", "PUT", `${apiBase}/unassigned/page?m=put`, { ctype: "application/json", body: '{"a":1}' }, "跨源 PUT 带体"],
    ["cross-patch-json", "PATCH", `${apiBase}/unassigned/page?m=patch`, { ctype: "application/json", body: '{"a":1}' }, "跨源 PATCH 带体"],
    ["cross-post-fetch", "POST", `${apiBase}/unassigned/page?m=fetch`, { ctype: "application/json", body: '{"a":1}', via: "fetch" }, "fetch（非 XHR）"],
    ["samesite-post-json", "POST", `${apiSameSite}/unassigned/page?m=samesite`, { ctype: "application/json", body: '{"a":1}' }, "同 site 不同端口（现场就是这种）"],
  ];
  for (const [id, method, url, opt, label] of matrix) {
    begin(`S2 mock ${id}（${label}）`);
    const before = apiRealHits();
    const r = await fire(method, url, opt);
    check(`matrix-${id}`, `②${label}：Electron 没崩、页面看到网络错误、真后端没收到`, isErr(r) && apiRealHits() === before, { r, before, after: apiRealHits() });
  }
  begin("S2 mock sendBeacon（POST 带体，非 CORS 模式）");
  const beaconBefore = apiRealHits();
  await ev(`window.beacon(${JSON.stringify(`${apiBase}/unassigned/page?m=beacon`)})`);
  await sleep(600);
  check("matrix-beacon", "②sendBeacon：Electron 没崩、真后端没收到", apiRealHits() === beaconBefore, { before: beaconBefore, after: apiRealHits() });
  const refusedEntries = (await netEntries()).filter((x) => x.ruled === "mock-refused");
  check("matrix-flags", "②被拒的请求在列表里都是 ruled=mock-refused", refusedEntries.length >= 6, refusedEntries.length);

  // ───── ③ 不误伤：同源 POST 带体 / 跨源 GET / 跨源 POST 不带体的 mock 仍然生效 ─────
  const okCases = [
    ["same-post-body", "POST", `${base}/same/unassigned/page`, { ctype: "application/json", body: '{"a":1}' }, "同源 POST 带体", () => siteSeen.length],
    ["cross-get", "GET", `${apiBase}/unassigned/page?g=1`, {}, "跨源 GET", apiRealHits],
    ["cross-post-nobody", "POST", `${apiBase}/unassigned/page?nb=1`, {}, "跨源 POST 不带体", apiRealHits],
  ];
  for (const [id, method, url, opt, label, counter] of okCases) {
    begin(`S3 ${id}（${label}）`);
    const before = counter();
    const r = await fire(method, url, opt);
    check(`ok-${id}`, `③${label}：mock 照常生效（200 + mock 的 body），真后端没收到`, !!r && r.status === 200 && /"mocked":true/.test(r.text) && counter() === before, { r, before, after: counter() });
    const e = await until(async () => {
      const x = await findEntry((en) => String(en.url) === url);
      return x && x.ruled === "mock" ? x : null;
    }, 4000);
    check(`ok-${id}-flag`, `③${label}：列表里标 ruled=mock（不是 mock-refused）`, !!e, e || (await findEntry((en) => String(en.url) === url)));
  }
  const listed = await call("net_rules", { action: "list" });
  check("hits-counted", "规则命中次数照常累计（被拒的请求也算命中）", listed.rules[0].hits >= 9, listed.rules[0]);

  // ───── ④ block / fail 规则：同样的危险请求同样不崩（它们原来发的 failRequest 就会崩）；安全类仍走 failRequest ─────
  await call("net_rules", { action: "clear" });
  await call("net_rules", { action: "block", pattern: "*unassigned/page*" });
  await sleep(300);
  const blockCases = [
    ["cross-post-plain", "POST", `${apiBase}/unassigned/page?b=plain`, { ctype: "text/plain", body: '{"a":1}' }, "text/plain POST（不经预检；原来的 failRequest 在这里 SIGSEGV）"],
    ["cross-post-fetch", "POST", `${apiBase}/unassigned/page?b=fetch`, { ctype: "text/plain", body: '{"a":1}', via: "fetch" }, "fetch + text/plain POST"],
    ["cross-put-json", "PUT", `${apiBase}/unassigned/page?b=put`, { ctype: "application/json", body: '{"a":1}' }, "json PUT（预检先被 failRequest，真请求不发）"],
    ["samesite-post-plain", "POST", `${apiSameSite}/unassigned/page?b=samesite`, { ctype: "text/plain", body: '{"a":1}' }, "同 site 不同端口 POST"],
  ];
  for (const [id, method, url, opt, label] of blockCases) {
    begin(`S4 block ${id}（${label}）`);
    const before = apiRealHits();
    const r = await fire(method, url, opt);
    check(`block-${id}`, `④block：${label}：Electron 没崩、页面看到网络错误、真后端没收到`, isErr(r) && apiRealHits() === before, { r, before, after: apiRealHits() });
  }
  begin("S4 block sendBeacon");
  const bb = apiRealHits();
  await ev(`window.beacon(${JSON.stringify(`${apiBase}/unassigned/page?b=beacon`)})`);
  await sleep(600);
  check("block-beacon", "④block：sendBeacon 没崩、真后端没收到", apiRealHits() === bb, { before: bb, after: apiRealHits() });
  const blockedEntry = await until(async () => {
    const e = await findEntry((x) => String(x.url).includes("b=plain"));
    return e && e.ruled === "block" && e.failed === true ? e : null;
  }, 5000);
  check("block-flag", "④被就地拒绝的 block 请求：列表里仍是 ruled=block 且 failed", !!blockedEntry, blockedEntry);
  // 对照（安全类）：同源 POST 带体 / 跨源 GET 被 block → 仍走原来的 failRequest，errorText 是 BLOCKED_BY_CLIENT
  const sameBlocked = await fire("POST", `${base}/same/unassigned/page?b=same`, { ctype: "application/json", body: '{"a":1}' });
  const getBlocked = await fire("GET", `${apiBase}/unassigned/page?b=get`, {});
  const sameE = await until(async () => {
    const e = await findEntry((x) => String(x.url).includes("b=same"));
    return e && e.ruled === "block" && e.errorText ? e : null;
  }, 5000);
  const getE = await until(async () => {
    const e = await findEntry((x) => String(x.url).includes("b=get"));
    return e && e.ruled === "block" && e.errorText ? e : null;
  }, 5000);
  check(
    "block-safe-class",
    "④对照：同源 POST 带体 / 跨源 GET 被 block 仍走原来的 failRequest（errorText 含 BLOCKED_BY_CLIENT）",
    isErr(sameBlocked) && isErr(getBlocked) && /BLOCKED_BY_CLIENT/i.test(sameE?.errorText || "") && /BLOCKED_BY_CLIENT/i.test(getE?.errorText || ""),
    { same: sameE?.errorText, get: getE?.errorText },
  );

  await call("net_rules", { action: "clear" });
  await call("net_rules", { action: "fail", pattern: "*unassigned/page*", errorReason: "ConnectionRefused" });
  await sleep(300);
  begin("S4 fail cross-post-plain");
  const fb = apiRealHits();
  const rf = await fire("POST", `${apiBase}/unassigned/page?f=plain`, { ctype: "text/plain", body: '{"a":1}' });
  check("fail-cross-post-plain", "④fail：text/plain 跨源 POST 没崩、页面看到网络错误、真后端没收到", isErr(rf) && apiRealHits() === fb, { rf, before: fb, after: apiRealHits() });
  const failEntry = await until(async () => {
    const e = await findEntry((x) => String(x.url).includes("f=plain"));
    return e && e.ruled === "fail" && e.failed === true ? e : null;
  }, 5000);
  check("fail-flag", "④被就地拒绝的 fail 请求：列表里仍是 ruled=fail 且 failed", !!failEntry, failEntry);
  const rfGet = await fire("GET", `${apiBase}/unassigned/page?f=get`, {});
  const failGetE = await until(async () => {
    const e = await findEntry((x) => String(x.url).includes("f=get"));
    return e && e.ruled === "fail" && e.errorText ? e : null;
  }, 5000);
  check("fail-safe-class", "④对照：跨源 GET 被 fail 仍走原来的 failRequest（errorText 含 CONNECTION_REFUSED）", isErr(rfGet) && /CONNECTION_REFUSED/i.test(failGetE?.errorText || ""), failGetE?.errorText);
  await call("net_rules", { action: "clear" });

  // ───── ⑤ 全局不变量：任何「带体 + 跨源」的暂停请求都没收到过 fulfillRequest / failRequest ─────
  if (tapped) {
    const danger = new Set(pausedList().filter((p) => p.hasBody && p.crossOrigin).map((p) => p.requestId));
    const violations = sent.filter((c) => danger.has(c.requestId) && (c.method === "Fetch.fulfillRequest" || c.method === "Fetch.failRequest"));
    const refusals = sent.filter((c) => danger.has(c.requestId) && c.method === "Fetch.continueRequest" && /^http:\/\/127\.0\.0\.1:1\//.test(c.url || ""));
    check("invariant-no-terminal-on-body-cross-origin", "⑤全局：整个运行期间，没有任何「带体 + 跨源」的暂停请求收到过 fulfillRequest / failRequest；且它们都被就地拒绝过", danger.size >= 10 && violations.length === 0 && refusals.length >= danger.size - 1, { dangerous: danger.size, violations, refusals: refusals.length });
  }

  // ⑥ 无主进程未捕获异常；能走到这里本身就说明主进程没有 SIGSEGV
  check("no-uncaught", "没有主进程 uncaughtException", uncaught.length === 0, uncaught.slice(0, 3));
  check("process-alive", "主进程存活至收尾（没有被信号结束）", true);

  const failed = results.filter((x) => !x.ok);
  console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed`);
  api.server.close();
  site.server.close();
  app.exit(failed.length === 0 ? 0 : 1);
};

main().catch((e) => {
  console.log("SMOKE FAIL fatal", (e && e.stack) || e);
  app.exit(3);
});
