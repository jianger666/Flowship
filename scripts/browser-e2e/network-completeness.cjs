"use strict";
/**
 * 网络记录完整性回归（真 Electron）：页面解析最早发出的 img / css / js 请求不能漏。
 *
 * 背景（只在真 Electron 里出现，单测的 fake 永远测不到）：
 * 1. 导航提交后渲染进程里的 Network 代理比预加载扫描器启用得晚，早期子资源收不到 requestWillBeSent
 *    （甚至 responseReceived），network 列表里只剩 Document 和 Fetch/XHR → tab.backfillResourceTiming 用页面的
 *    Resource Timing 兜底；
 * 2. 真 Electron 给主会话的 CDP sessionId 是空串 ""（不是 undefined / null）：tab 必须归一成 null，否则
 *    isoContexts 的键分裂、mainFrameId 不随导航更新，隔离世界里的 overlay / 补录第一次导航之后全打到过期 context 上。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/network-completeness.cjs --timeout 120
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动。临时 userData、窗口 show:false、本地 http fixture（随机端口，仅 127.0.0.1）；
 * 不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-net-completeness-"));
app.setPath("userData", path.join(TMP, "userData"));
app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
};

// 每次导航的子资源 URL 都带唯一 ?n=，排除缓存命中的干扰：缺了就是真漏记
const PAGE = (n) => `<!doctype html><html><head><meta charset="utf-8"><title>P${n}</title>
<link rel="stylesheet" href="/s.css?n=${n}"><script src="/a.js?n=${n}"></script></head><body>
<img src="/i.png?n=${n}"><p>probe ${n}</p>
<script>fetch('/api/ok?n=${n}'); fetch('/api/fail?n=${n}');</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const p = u.pathname;
      if (p === "/i.png") {
        res.setHeader("content-type", "image/png");
        return res.end(PNG);
      }
      if (p === "/s.css") {
        res.setHeader("content-type", "text/css");
        return res.end("body{margin:0}");
      }
      if (p === "/a.js") {
        res.setHeader("content-type", "text/javascript");
        return res.end("window.__a=1;");
      }
      if (p === "/api/ok") {
        res.setHeader("content-type", "application/json");
        return res.end("{}");
      }
      if (p === "/api/fail") {
        res.statusCode = 500;
        return res.end("boom");
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE(u.searchParams.get("n") || "0"));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

const EXPECTED = ["/", "/s.css", "/a.js", "/i.png", "/api/ok", "/api/fail"];

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
    log: () => {},
  });
  const T = "net-completeness";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const pathsOf = (r, n) => r.entries.filter((e) => new URL(e.url).search === "" || new URL(e.url).search === `?n=${n}`).map((e) => new URL(e.url).pathname);
  const missingOf = (r, n) => EXPECTED.filter((p) => !pathsOf(r, n).includes(p));

  // ── 1. 首次导航：五类请求都在 ──
  await call("navigate", { url: `${base}/?n=1` });
  await sleep(800);
  const first = await call("network", { limit: 200 });
  check("first-nav-complete", "首次导航后 Document / CSS / JS / 图片 / fetch ×2 全部出现在 network 里", missingOf(first, 1).length === 0, { missing: missingOf(first, 1), got: pathsOf(first, 1) });
  const byPath = (r, p) => r.entries.find((e) => new URL(e.url).pathname === p);
  check("status-and-type", "补录 / 事件记录的状态与类型正确（css=Stylesheet、img=Image、js=Script、fail=500 且 failed）", byPath(first, "/s.css")?.type === "Stylesheet" && byPath(first, "/i.png")?.type === "Image" && byPath(first, "/a.js")?.type === "Script" && byPath(first, "/api/fail")?.status === 500 && byPath(first, "/api/fail")?.failed === true && byPath(first, "/s.css")?.status === 200, first.entries.map((e) => `${e.type}:${e.status}`));
  check("ids-unique", "所有条目 id 唯一、递增后无重复（补录条目也有 id）", new Set(first.entries.map((e) => e.id)).size === first.entries.length && first.entries.every((e) => Number.isInteger(e.id)), first.entries.map((e) => e.id));

  // ── 2. 隔离世界上下文：主会话键不分裂、context 有效、mainFrameId 跟着导航走 ──
  const tab = manager.getSession(T).activeTab;
  const keys = [...tab.isoContexts.keys()];
  check("iso-keys-not-split", "主会话的隔离世界键没有分裂（有 main:<frame>，没有以 `:` 开头的空 sessionId 键）", keys.some((k) => k === `main:${tab.mainFrameId}`) && keys.every((k) => !k.startsWith(":")), keys);
  const ctx = tab.isoContexts.get(`main:${tab.mainFrameId}`);
  let evalOk = false;
  try {
    const r = await tab.send("Runtime.evaluate", { expression: "1+1", contextId: ctx, returnByValue: true, silent: true }, null, 2000);
    evalOk = r?.result?.value === 2;
  } catch {
    /* 过期 context → 落到 FAIL */
  }
  check("main-iso-context-alive", "按 main:<mainFrameId> 取到的隔离世界 context 在导航后仍然有效（overlay / 补录都依赖它）", evalOk, { ctx, mainFrameId: tab.mainFrameId });
  const tree = await tab.send("Page.getFrameTree", {});
  check("main-frame-id-follows", "mainFrameId 与当前主 frame 一致", tab.mainFrameId === tree?.frameTree?.frame?.id, { tab: tab.mainFrameId, real: tree?.frameTree?.frame?.id });

  // ── 3. 连续 12 次导航，每次 300ms 后读：一条都不能漏 ──
  const miss = [];
  for (let i = 10; i < 22; i++) {
    await call("network", { clear: true, limit: 1 });
    await call("navigate", { url: `${base}/?n=${i}` });
    await sleep(300);
    const r = await call("network", { limit: 200 });
    for (const m of missingOf(r, i)) miss.push(`${i}:${m}`);
  }
  check("rapid-navs-complete", "连续 12 次导航，每次的 Document / CSS / JS / 图片 / fetch ×2 一条不漏", miss.length === 0, { miss });

  // ── 4. clear 语义：清空后读到 0 条，补录不会把 clear 之前的资源又灌回来 ──
  await call("network", { clear: true, limit: 1 });
  const afterClear = await call("network", { limit: 200 });
  check("clear-stays-empty", "clear 之后立刻读为空，补录不回灌旧资源", afterClear.entries.length === 0, afterClear.entries.map((e) => e.url));
  await call("navigate", { url: `${base}/?n=30` });
  await sleep(300);
  const afterNav = await call("network", { limit: 200 });
  check("after-clear-nav", "clear 之后再导航，只有新页面的请求", afterNav.entries.every((e) => /n=30|\/\?n=30/.test(e.url) || new URL(e.url).search === "?n=30") && missingOf(afterNav, 30).length === 0, { missing: missingOf(afterNav, 30), got: afterNav.entries.map((e) => e.url.replace(base, "")) });

  // ── 5. 重复读取不产生重复条目 ──
  const again = await call("network", { limit: 200 });
  check("repeat-read-no-dup", "连续再读一次，条目数不变（补录不重复入账）", again.entries.length === afterNav.entries.length, { before: afterNav.entries.length, after: again.entries.length });

  manager.destroy();
  server.close();
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
    app.exit(1);
  });
