"use strict";
/**
 * E2·P6 / B2 性能（真 Electron + 真 CDP）：start_trace / stop_trace、metrics、heap_snapshot、coverage、会话销毁时 trace 收尾。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p6-perf.cjs --timeout 150
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动。临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；
 * 不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 *
 * 关于 LCP / FCP / CLS：隐藏窗口里 Chromium 可能不出帧，这三项是否采到取决于环境，只做「采到则必须合理」的软检查（INFO），
 * 硬断言放在一定能得到的东西上：合法 trace JSON、长任务、慢请求、堆 / DOM 指标、构造函数占用、覆盖率比例。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-p6-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const info = (id, name, detail) => console.log(`SMOKE INFO ${id} ${name} ${JSON.stringify(detail)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 故意只用一半的 JS：used() 被调用，unusedBig() 从不调用（占大头）
const APP_JS = `
class BigThing { constructor(i) { ${Array.from({ length: 24 }, (_, k) => `this.f${k} = i + ${k};`).join(" ")} } }
window.__keep = [];
for (let i = 0; i < 15000; i++) window.__keep.push(new BigThing(i));
function used() { return 1 + 1; }
function unusedBig() {
${Array.from({ length: 120 }, (_, i) => `  var v${i} = Math.sqrt(${i + 1}) * ${i + 7}; if (v${i} > 1e9) { console.log('never ${i}', v${i}); }`).join("\n")}
  return 'never';
}
window.__used = used();
`;
// 故意只用一半的 CSS：.used 命中，其余 .never-* 不命中
const SITE_CSS = `.used { color: red; padding: 4px; }\n${Array.from({ length: 80 }, (_, i) => `.never-${i} { margin: ${i}px; border: 1px solid #${(i * 1234567 % 0xffffff).toString(16).padStart(6, "0")}; }`).join("\n")}\n`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>P6</title><link rel="stylesheet" href="/site.css"></head><body>
<h1 class="used">P6 性能 fixture</h1>
<div id="top" style="height:40px">顶部</div>
<button id="b">点我</button>
<p>正文</p>
<script src="/app.js"></script>
<script>
window.__clicks = 0;
document.getElementById('b').addEventListener('click', function () { window.__clicks++; var t = Date.now(); while (Date.now() - t < 30) {} });
// 慢请求：服务端延迟 700ms
fetch('/slow').then(function (r) { return r.text(); }).then(function () { window.__slowDone = true; });
// 布局偏移：200ms 后在上方插入一个大块，把下面的内容挤下去
setTimeout(function () { var d = document.createElement('div'); d.style.cssText = 'height:200px;background:#eee'; d.textContent = '晚到的横幅'; document.body.insertBefore(d, document.getElementById('top')); }, 200);
// 长任务：400ms 后阻塞主线程 180ms
setTimeout(function () { var t = Date.now(); while (Date.now() - t < 180) {} window.__longDone = true; }, 400);
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/slow") {
        setTimeout(() => {
          res.setHeader("content-type", "text/plain");
          res.end("slow-ok");
        }, 700);
        return;
      }
      if (p === "/app.js") {
        res.setHeader("content-type", "application/javascript");
        res.setHeader("cache-control", "no-store");
        return res.end(APP_JS);
      }
      if (p === "/site.css") {
        res.setHeader("content-type", "text/css");
        res.setHeader("cache-control", "no-store");
        return res.end(SITE_CSS);
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port }));
  });

const main = async () => {
  await app.whenReady();
  const { server, base } = await startFixture();
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
    isAppUrl: (u) => /:9\//.test(u),
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  manager.onConfig({ evaluateEnabled: true });

  const T = "p6-task";
  const dir = path.join(TMP, "data", "tasks", T, "browser-traces");
  const call = (op, args = {}, signal) => manager.dispatch(op, args, { taskId: T, signal });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  };
  const ev = async (expr) => (await call("evaluate", { expression: expr })).value;
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const unix = process.platform !== "win32";

  // ═══════════ 参数 / 前置 ═══════════
  await call("navigate", { url: `${base}/` });
  await sleep(1200);
  const badPreset = await tryCall("perf", { action: "start_trace", preset: "devtools.timeline,*" });
  check("args-preset", "任意类别串被拒（BAD_ARGS）", !badPreset.ok && badPreset.code === "BAD_ARGS", badPreset);
  const noTrace = await tryCall("perf", { action: "stop_trace" });
  check("stop-none", "没有进行中的 trace 时 stop_trace → BAD_ARGS", !noTrace.ok && noTrace.code === "BAD_ARGS", noTrace.message);

  // ═══════════ trace ═══════════
  const start = await call("perf", { action: "start_trace" });
  check("trace-start", "start_trace 成功（默认预设、60 秒 / 200MB）", start.action === "start_trace" && start.preset === "default" && start.maxSeconds === 60, start);
  const dup = await tryCall("perf", { action: "start_trace" });
  check("trace-mutex", "同会话再 start_trace → BAD_ARGS（互斥）", !dup.ok && dup.code === "BAD_ARGS", dup.message);

  await call("navigate", { url: `${base}/` }); // 重新加载：fixture 的偏移 / 长任务 / 慢请求都发生在录制期间
  await sleep(1800);
  await ev("document.getElementById('b').click(); document.getElementById('b').click(); 1");
  await sleep(300);
  const stop = await call("perf", { action: "stop_trace" });
  const s = stop.summary;
  // R6-02：结果不再带绝对路径（只给文件名 + 相对子目录）；脚本自己用已知的任务目录拼出真实路径来验文件
  const stopPath = stop.file ? path.join(dir, stop.file) : "";
  check("trace-stop", "stop_trace 返回摘要与文件名（不含绝对路径）", stop.action === "stop_trace" && !!stop.file && stop.path === undefined && stop.dir === "browser-traces" && !!s, { file: stop.file, dir: stop.dir, bytes: stop.bytes, truncated: stop.truncated, events: stop.parsedEvents });
  const text = stopPath && fs.existsSync(stopPath) ? fs.readFileSync(stopPath, "utf8") : "";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = null;
  }
  check("trace-json", "trace 文件是合法 JSON 且含 traceEvents（能在 DevTools Performance 打开）", parsed && Array.isArray(parsed.traceEvents) && parsed.traceEvents.length > 100, { n: parsed?.traceEvents?.length });
  check("trace-events", "流式解析的事件数与文件一致", parsed && stop.parsedEvents === parsed.traceEvents.length, { parsed: stop.parsedEvents, file: parsed?.traceEvents?.length });
  check("trace-perms", "文件 0600、目录 0700、无 .tmp 残留", !unix || ((fs.statSync(stopPath).mode & 0o777) === 0o600 && (fs.statSync(dir).mode & 0o777) === 0o700 && files().every((n) => !n.endsWith(".tmp"))), { mode: unix ? (fs.statSync(stopPath).mode & 0o777).toString(8) : "win" });
  check("trace-path", "文件在任务目录 browser-traces 下，文件名主进程生成", fs.existsSync(stopPath) && /^trace-\d{8}-\d{6}\.json$/.test(stop.file), stop.file);
  check("trace-longtask", "摘要：长任务 ≥ 1（fixture 阻塞 180ms）且最长 ≥ 100ms", s && s.longTasks.count >= 1 && s.longTasks.longest[0].ms >= 100, s?.longTasks);
  const slowReq = s && s.slowRequests.find((r) => /\/slow$/.test(r.url));
  check("trace-slowreq", "摘要：最慢请求含 /slow（≥ 500ms）", !!slowReq && slowReq.ms >= 500, s?.slowRequests?.slice(0, 3));
  check("trace-top", "摘要：主线程耗时榜（事件类型 / 函数）非空", s && (s.topEvents.length > 0 || s.topFunctions.length > 0), { events: s?.topEvents?.slice(0, 3), funcs: s?.topFunctions?.slice(0, 2) });
  info("trace-vitals", "LCP / FCP / CLS / INP / TTFB（隐藏窗口可能不出帧，仅供参考）", s?.metrics);
  if (s && s.metrics.lcpMs !== null) check("trace-lcp-sane", "LCP 采到时在合理范围（0–10s）", s.metrics.lcpMs > 0 && s.metrics.lcpMs < 10_000, s.metrics.lcpMs);
  const dumped = JSON.stringify(stop);
  check("trace-no-app", "摘要里没有 Flowship origin（:9/）", !/:9\//.test(JSON.stringify(s)));
  // AI 条目在会话状态的 recent 里（user_activity 只返回用户操作）
  const act = (manager.getSession(T).getState().recent || []).filter((e) => e.actor === "ai").map((e) => e.summary || "");
  check("trace-activity", "活动日志（AI）有「开始 / 结束了性能录制」", act.some((x) => /开始了性能录制/.test(x)) && act.some((x) => /结束了性能录制/.test(x)), act.filter((x) => /性能/.test(x)));
  void dumped;

  // ═══════════ metrics ═══════════
  const m = await call("perf", { action: "metrics" });
  check("metrics", "metrics 第一次：JS 堆 / DOM 节点有数，计数类指标不返回（自 enable 起累计，此刻无意义）", m.first === true && m.metrics.jsHeapUsedMB > 0 && m.metrics.domNodes > 0 && m.metrics.layoutCount === undefined, m.metrics);
  await ev("(function(){ var d = document.createElement('div'); d.textContent = 'x'; document.body.appendChild(d); return document.body.offsetHeight; })()");
  const m2 = await call("perf", { action: "metrics" });
  check("metrics-delta", "metrics 第二次：两次调用之间的布局次数 ≥ 1、脚本耗时 ≥ 0", m2.first === false && m2.metrics.layoutCount >= 1 && m2.metrics.scriptDurationMs >= 0, m2.metrics);

  // ═══════════ heap snapshot ═══════════
  const heap = await call("perf", { action: "heap_snapshot", topN: 30, gc: true });
  const heapPath = heap.file ? path.join(dir, heap.file) : "";
  const heapOk = heapPath && fs.existsSync(heapPath) && fs.statSync(heapPath).size > 10_000;
  check("heap-file", "堆快照文件存在、0600、文件名主进程生成，结果不带绝对路径", heapOk && heap.path === undefined && (!unix || (fs.statSync(heapPath).mode & 0o777) === 0o600) && /^heap-\d{8}-\d{6}\.heapsnapshot$/.test(heap.file), { file: heap.file, bytes: heap.bytes });
  check("heap-top", "前 N 名非空，节点数 > 1000", heap.summary && heap.summary.top.length > 0 && heap.summary.nodeCount > 1000, heap.summary && { nodes: heap.summary.nodeCount, top: heap.summary.top.slice(0, 5) });
  check("heap-bigthing", "fixture 的 BigThing（15000 个实例）出现在构造函数占用前 30 名", !!(heap.summary && heap.summary.top.find((t) => t.name === "BigThing" && t.count >= 15000)), heap.summary && heap.summary.top.slice(0, 12).map((t) => `${t.name}:${t.count}`));
  let snapJson = null;
  try {
    snapJson = JSON.parse(fs.readFileSync(heapPath, "utf8"));
  } catch (e) {
    snapJson = null;
  }
  check("heap-json", "堆快照文件本身是合法 JSON（含 snapshot / nodes / strings）", !!snapJson && !!snapJson.snapshot && Array.isArray(snapJson.nodes) && Array.isArray(snapJson.strings));
  if (snapJson) {
    // 与官方一致性：用整份 JSON.parse 独立算一遍 BigThing 的 self_size 汇总，对照增量解析的结果
    const f = snapJson.snapshot.meta.node_fields;
    const n = f.length;
    const ti = f.indexOf("type"), ni = f.indexOf("name"), si = f.indexOf("self_size");
    let cnt = 0, size = 0;
    for (let i = 0; i < snapJson.nodes.length; i += n) {
      if (snapJson.strings[snapJson.nodes[i + ni]] === "BigThing" && snapJson.snapshot.meta.node_types[0][snapJson.nodes[i + ti]] === "object") {
        cnt += 1;
        size += snapJson.nodes[i + si];
      }
    }
    const row = heap.summary && heap.summary.top.find((t) => t.name === "BigThing");
    check("heap-consistent", "增量解析的 BigThing 个数 / self size 与整份 JSON.parse 独立计算一致", !!row && row.count === cnt && row.selfSize === size, { row, cnt, size });
  }

  // ═══════════ coverage ═══════════
  const cs = await call("perf", { action: "coverage_start" });
  check("cov-start", "coverage_start（JS + CSS）", cs.action === "coverage_start" && cs.js === true && cs.css === true, cs);
  const dupCov = await tryCall("perf", { action: "coverage_start" });
  check("cov-mutex", "重复 coverage_start → BAD_ARGS", !dupCov.ok && dupCov.code === "BAD_ARGS", dupCov.message);
  await call("navigate", { url: `${base}/` });
  await sleep(1500);
  const cov = await call("perf", { action: "coverage_stop", topN: 5 });
  const jsRow = cov.js && cov.js.top.find((r) => /\/app\.js$/.test(r.url));
  const cssRow = cov.css && cov.css.top.find((r) => /\/site\.css$/.test(r.url));
  check("cov-js", "JS 覆盖率：app.js 报出大比例未使用（已用 < 60%，总长 > 3000）", !!jsRow && jsRow.usedPercent < 60 && jsRow.total > 3000, jsRow);
  check("cov-css", "CSS 覆盖率：site.css 已用 < 40%", !!cssRow && cssRow.usedPercent < 40 && cssRow.total > 1000, cssRow);
  check("cov-sorted", "按未使用字节降序", (cov.js?.top ?? []).every((r, i, a) => i === 0 || a[i - 1].unused >= r.unused));
  const noCov = await tryCall("perf", { action: "coverage_stop" });
  check("cov-stop-twice", "再次 coverage_stop → BAD_ARGS（已收尾）", !noCov.ok && noCov.code === "BAD_ARGS", noCov.message);

  // ═══════════ 会话销毁时 trace 收尾 ═══════════
  const before = files().sort();
  await call("perf", { action: "start_trace", preset: "runtime" });
  await sleep(500);
  await call("close_session");
  await sleep(300);
  check("destroy-nofile", "trace 中途 close_session：没有新文件、没有 .tmp 残留", JSON.stringify(files().sort()) === JSON.stringify(before), { before, after: files() });
  await call("navigate", { url: `${base}/` });
  const again = await tryCall("perf", { action: "start_trace" });
  check("destroy-restart", "销毁后的新会话可以重新 start_trace（旧状态没有残留）", again.ok === true, again);
  const stop2 = await tryCall("perf", { action: "stop_trace" });
  check("destroy-stop", "新会话里 stop_trace 正常结束", stop2.ok === true && !!stop2.value.file && stop2.value.path === undefined, stop2.ok ? { file: stop2.value.file } : stop2);

  // 过滤保险：文件名都是我们生成的，没有路径穿越
  check("files-clean", "目录里只有 trace-* / heap-* 文件", files().every((n) => /^(trace|heap)-\d{8}-\d{6}(-\d+)?\.(json|heapsnapshot)$/.test(n)), files());

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
