"use strict";
/**
 * R14 探针（真 Electron + 真 CDP；2026-11-11 16:29 正式包 v1.9.47 闪退）：
 * 现场时间线：AI 对 `*unassigned/page*` 设了一条 net_rules mock（Fetch.enable + patterns），2 秒后 browser_click 点了一个会触发该请求的按钮，
 * 点击返回「与桌面壳的连接已断开」、主进程 CrBrowserMain SIGSEGV（EXC_BAD_ACCESS，地址 0xefefef…=PartitionAlloc 把「释放后仍被悬空指针引用」的内存刷成 0xEF）。
 *
 * 本脚本在回环上尽量复刻这条链路，找出让 Electron 42.4.0 崩的最小触发条件。每一步前后都打 PROBE 标记：
 * 崩了，启动器会报「被信号 SIGSEGV 结束」，最后一条 PROBE BEGIN 就是触发步骤。
 *
 * 已定结论（Electron 42.4.0 实测）：对「CORS 模式、带请求体、跨源」的请求下**任何终结命令**都崩——`Fetch.fulfillRequest` 崩，`Fetch.failRequest` 也崩（见 PROBE_RULE=fail / block）；
 * `continueRequest`、跨源 GET / 不带体 POST、同源请求不崩。事故简报最初写「fail / block 不崩」是被 CORS 预检混淆的：json 的跨源 POST 先发预检、fail 规则把预检先失败，
 * 带体的 POST 根本没发出来——要测 fail / block，用不触发预检的 `PROBE_MODE=cross-post-plain`。
 * 防护与正式回归见 net-rules-engine.mjs 的 `terminalWouldCrashChromium` 与 r14-mock-no-fulfill-crash.cjs；本探针是调查用的单形态工具，升级 Electron 前可用它重新确认上游行为。
 *
 * 只能经启动器运行：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/r14-mock-fulfill-probe.cjs --timeout 120
 *
 * 临时 userData、窗口 show:false、fixture 在回环随机端口；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-r14-probe-"));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (msg) => console.log(`PROBE ${msg}`);
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

// 与现场同量级的 mock body：约 1KB、含中文
const MOCK_BODY = JSON.stringify({
  total: 1,
  pageNum: 1,
  pageSize: 100,
  stale: false,
  cacheRefreshedAt: null,
  list: Array.from({ length: 3 }, (_, i) => ({
    deleted: false,
    externalUserId: `wm_mock_${i}`,
    qwCustomerTime: "2026-11-01 10:00:00",
    qwUserId: "qw_mock",
    stuNumbers: [],
    unionid: `u${i}`,
    uuid: `mock-uuid-${i}`,
    wechatNickname: `mock好友${i}`,
    whenCreated: "2026-11-01 10:00:00",
    bindStuNumber: false,
    chineOwner: "-",
    chineOwnerIds: [],
    mathOwner: "-",
    mathOwnerIds: [],
  })),
});

const main = async () => {
  await app.whenReady();

  // 跨源 API 服务（localhost vs 127.0.0.1）：带真实的 CORS 预检应答，模拟「前端站点 ≠ API 站点」
  const api = await listen((req, res) => {
    res.setHeader("access-control-allow-origin", req.headers.origin || "*");
    res.setHeader("access-control-allow-headers", "content-type,authorization");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-credentials", "true");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }
    res.setHeader("content-type", "application/json; charset=utf-8");
    setTimeout(() => res.end(JSON.stringify({ from: "real-server", path: req.url })), 60);
  });
  const apiBase = `http://localhost:${api.port}`;
  const apiSameSite = `http://127.0.0.1:${api.port}`; // 与页面同 site（都是 127.0.0.1）、不同 origin（端口不同）

  const PAGE = `<!doctype html><meta charset="utf-8"><title>probe</title>
<h1>probe</h1>
<button id="q">查询</button> <button id="reload">刷新</button> <pre id="out"></pre>
<script>
window.__cnt = 0;
window.__mode = 'cross-post-json';
// 形态 token（用 - 连接）：cross（跨 origin 且跨 site）| samesite（同 site 不同端口）| same（同源）；get|post|put|delete；json|plain；nobody；fetch（默认 XHR）；creds
window.xhrPost = function (url, mode) {
  mode = mode || window.__mode;
  var t = mode.split('-');
  var method = t.indexOf('get') >= 0 ? 'GET' : t.indexOf('put') >= 0 ? 'PUT' : t.indexOf('delete') >= 0 ? 'DELETE' : 'POST';
  var hasBody = method === 'POST' || method === 'PUT' ? t.indexOf('nobody') < 0 : false;
  var ctype = t.indexOf('plain') >= 0 ? 'text/plain' : 'application/json';
  var body = hasBody ? JSON.stringify({ pageNum: 1, pageSize: 100, kw: '中文' }) : null;
  if (t.indexOf('fetch') >= 0) {
    var init = { method: method, credentials: t.indexOf('creds') >= 0 ? 'include' : 'same-origin' };
    if (hasBody) { init.body = body; init.headers = { 'Content-Type': ctype }; }
    return fetch(url, init).then(function (r) { return r.text().then(function (x) { return { status: r.status, len: x.length }; }); }).catch(function (e) { return { error: String(e) }; });
  }
  return new Promise(function (resolve) {
    var x = new XMLHttpRequest();
    x.open(method, url);
    if (t.indexOf('creds') >= 0) x.withCredentials = true;
    if (hasBody) x.setRequestHeader('Content-Type', ctype);
    x.onload = function () { resolve({ status: x.status, len: x.responseText.length }); };
    x.onerror = function () { resolve({ error: 'xhr-error' }); };
    x.onabort = function () { resolve({ error: 'xhr-abort' }); };
    x.send(body);
    window.__lastXhr = x;
  });
};
window.abortRace = function (url, delay) {
  var ac = new AbortController();
  var p = fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}', signal: ac.signal })
    .then(function (r) { return r.text().then(function (t) { return 'ok:' + r.status; }); })
    .catch(function (e) { return 'err:' + e.name; });
  setTimeout(function () { ac.abort(); }, delay);
  return p;
};
document.getElementById('q').onclick = function () {
  window.__cnt++;
  window.xhrPost((/^same-/.test(window.__mode) ? location.origin : /^samesite-/.test(window.__mode) ? '${apiSameSite}' : '${apiBase}') + '/unassigned/page?n=' + window.__cnt).then(function (r) { document.getElementById('out').textContent = JSON.stringify(r); });
};
document.getElementById('reload').onclick = function () { location.reload(); };
</script>`;
  const site = await listen((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/favicon.ico") {
      res.statusCode = 404;
      return res.end();
    }
    if (p === "/unassigned/page") {
      res.setHeader("content-type", "application/json");
      return res.end('{"same":"origin-real"}');
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  const base = `http://127.0.0.1:${site.port}`;

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const mainWin = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: true } });
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
  manager.onConfig({ evaluateEnabled: true, networkBodyRead: true });

  const T = "r14-probe-task";
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
  const out = () => ev("document.getElementById('out').textContent");

  await call("navigate", { url: `${base}/` });
  // 请求形态由环境变量选择（cross|same）-（post|get）-（json|plain）；崩溃会杀掉整个进程，所以每种形态单独跑一次
  const MODE = process.env.PROBE_MODE || "cross-post-json";
  await ev(`window.__mode = ${JSON.stringify(MODE)}; 1`);
  probe(`MODE ${MODE} electron=${process.versions.electron} chrome=${process.versions.chrome}`);
  const S1_ONLY = process.env.PROBE_S1_ONLY === "1";
  // PROBE_DUMP=1：打印 Fetch.requestPaused 载荷里与「会不会崩」有关的字段（给防护条件取证用；配合不崩的规则种类如 PROBE_RULE=headers）
  if (process.env.PROBE_DUMP === "1") {
    manager.getSession(T).activeTab.wc.debugger.on("message", (_e, method, params) => {
      if (method !== "Fetch.requestPaused" || !/unassigned/.test(String(params?.request?.url))) return;
      const h = params.request.headers || {};
      const origin = Object.entries(h).find(([k]) => k.toLowerCase() === "origin")?.[1];
      probe(`PAUSED method=${params.request.method} hasPostData=${params.request.hasPostData} postData=${params.request.postData !== undefined} origin=${origin} url=${String(params.request.url).slice(0, 48)} resourceType=${params.resourceType}`);
    });
  }

  // ───── S1：先不设规则点一次（真请求），再设 mock、隔 2 秒点击（复刻现场） ─────
  probe("BEGIN S1a 无规则点击（真请求）");
  await clickBtn("查询");
  await sleep(400);
  probe(`END   S1a out=${await out()}`);

  probe("BEGIN S1b 设置 mock（跨源 POST 的 API 路径）");
  // PROBE_RULE 选规则种类：mock（默认，fulfillRequest）| headers（continueRequest 改头）| delay（continueRequest 延迟）| fail / block（failRequest）
  // PROBE_MOCK_ACAO=1：mock 自带 Access-Control-Allow-Origin（引擎就不再追加回显 Origin 的那三个头）
  const RULE = process.env.PROBE_RULE || "mock";
  const ruleArgs = {
    mock: { action: "mock", pattern: "*unassigned/page*", status: 200, body: process.env.PROBE_MOCK_BODY === "small" ? '{"a":1}' : process.env.PROBE_MOCK_BODY === "empty" ? "" : MOCK_BODY, ...(process.env.PROBE_MOCK_ACAO === "1" ? { headers: [{ name: "Access-Control-Allow-Origin", value: "*" }] } : {}) },
    headers: { action: "set_headers", pattern: "*unassigned/page*", headers: [{ name: "X-Probe", value: "1" }] },
    delay: { action: "delay", pattern: "*unassigned/page*", delayMs: 100 },
    fail: { action: "fail", pattern: "*unassigned/page*", errorReason: "Failed" },
    block: { action: "block", pattern: "*unassigned/page*" },
  }[RULE];
  probe(`RULE ${RULE} acao=${process.env.PROBE_MOCK_ACAO === "1"}`);
  const rule = await call("net_rules", ruleArgs);
  probe(`END   S1b rule=${rule.rule && rule.rule.id}`);
  await sleep(2000);

  probe("BEGIN S1c 点击触发被 mock 的请求（现场崩溃点）");
  const c1 = await clickBtn("查询");
  probe(`END   S1c click.navigated=${c1.navigated}`);
  await sleep(600);
  probe(`END   S1c out=${await out()}`);
  if (S1_ONLY) {
    probe(`DONE S1 跑完、Electron 未崩 mode=${MODE}`);
    app.exit(0);
    return;
  }

  // ───── S2：同一条规则下连续点击 30 次（每次 100ms） ─────
  probe("BEGIN S2 连点 30 次");
  for (let i = 0; i < 30; i += 1) {
    await clickBtn("查询");
    await sleep(100);
  }
  await sleep(500);
  probe(`END   S2 out=${await out()}`);

  // ───── S3：页面取消竞态：fetch 发出后 0~40ms 内 abort，请求正被暂停 / fulfill 时被取消 ─────
  probe("BEGIN S3 abort 竞态");
  const delays = [0, 1, 2, 3, 4, 5, 6, 8, 10, 13, 16, 21, 28, 34, 40];
  const tally = {};
  for (const d of delays) {
    for (let k = 0; k < 6; k += 1) {
      const r = await ev(`window.abortRace(${JSON.stringify(`${apiBase}/unassigned/page?race=${d}-${k}`)}, ${d})`);
      tally[r] = (tally[r] || 0) + 1;
    }
  }
  probe(`END   S3 tally=${JSON.stringify(tally)}`);

  // ───── S4：请求在暂停中、页面立刻刷新（导航打断挂起请求） ─────
  probe("BEGIN S4 点击后立刻刷新");
  for (let i = 0; i < 15; i += 1) {
    await ev("document.getElementById('q').click(); document.getElementById('reload').click(); 1");
    await sleep(350);
  }
  probe("END   S4");

  // ───── S5：同源路径的 mock（页面与 API 同源） ─────
  probe("BEGIN S5 同源 XHR POST 被 mock");
  await call("net_rules", { action: "mock", pattern: `${base}/unassigned/page*`, status: 200, body: MOCK_BODY });
  const same = await ev(`window.xhrPost(${JSON.stringify(`${base}/unassigned/page`)})`);
  probe(`END   S5 ${JSON.stringify(same)}`);

  // ───── S6：用户接管暂停 / 交还期间（Fetch.disable / enable 切换）里点击 ─────
  probe("BEGIN S6 clear 规则后再设（Fetch.disable→enable）后点击");
  await call("net_rules", { action: "clear" });
  await call("net_rules", { action: "mock", pattern: "*unassigned/page*", status: 200, body: MOCK_BODY });
  await sleep(300);
  await clickBtn("查询");
  await sleep(600);
  probe(`END   S6 out=${await out()}`);

  probe(`DONE 全部步骤跑完、Electron 未崩 uncaught=${uncaught.length}`);
  app.exit(0);
};

main().catch((e) => {
  console.log("PROBE FAIL", (e && e.stack) || e);
  app.exit(1);
});
