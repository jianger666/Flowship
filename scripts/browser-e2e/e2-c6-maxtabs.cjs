"use strict";
/**
 * E2·P10 · C6 冒烟（真 Electron）：单任务标签页上限 `config.maxTabs` 的端到端行为。
 *
 * 覆盖：manager 层 tabs new 按上限拒绝（文案对）、onConfig 实时调整（上调能继续开、坏值不改、下调后不再开但不强关已有）、
 * 页面脚本 window.open（无手势）与带手势弹窗同样计入上限、关闭 tab 后可再开。
 *
 * 只能经启动器运行：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-c6-maxtabs.cjs --timeout 150
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-c6-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>C6</title></head><body>
<button id="pop" onclick="window.open('/popup')">开弹窗</button><h1>maxtabs</h1></body></html>`;

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
  manager.onConfig({ evaluateEnabled: true });

  const T = "c6-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  };
  const list = async () => (await call("tabs", { action: "list" })).tabs;
  const count = async () => (await list()).length;
  const openNew = () => tryCall("tabs", { action: "new", url: `${base}/p` });
  const refOf = (text, name) => {
    for (const line of text.split("\n")) {
      if (line.includes(name)) {
        const m = /\[ref=(e\d+)\]/.exec(line);
        if (m) return m[1];
      }
    }
    return null;
  };

  await call("navigate", { url: `${base}/p` });
  manager.onConfig({ maxTabs: 5 });
  for (let i = 0; i < 4; i++) await openNew();
  check("c6-fill-5", "上限 5：开到 5 个", (await count()) === 5, await count());
  const sixth = await openNew();
  check("c6-reject-6th", "第 6 个被拒：BAD_ARGS + 文案带「已达上限（5 个）」与关闭指引", !sixth.ok && sixth.code === "BAD_ARGS" && /已达上限（5 个）/.test(sixth.message) && /browser_tabs close/.test(sixth.message), sixth);
  check("c6-reject-no-leak", "被拒后 tab 数仍是 5（没有半个 tab）", (await count()) === 5);

  // 页面脚本（无手势）window.open：满额时不能把总数顶过上限
  const wopen = async () => {
    await call("evaluate", { expression: "window.open('/popup'); 1" });
    await sleep(500);
  };
  await wopen();
  check("c6-script-open-full", "满额时页面脚本 window.open 不新增 tab", (await count()) === 5, await count());

  // 上调：实时生效
  manager.onConfig({ maxTabs: 8 });
  for (let i = 0; i < 3; i++) await openNew();
  check("c6-raise-8", "onConfig 上调到 8 后能继续开到 8 个", (await count()) === 8, await count());
  const ninth = await openNew();
  check("c6-reject-9th", "第 9 个被拒（文案是 8 个）", !ninth.ok && /已达上限（8 个）/.test(ninth.message ?? ""), ninth.message);

  // 坏值：主进程不改（server 侧已规整，这里是最后一道防线）
  for (const bad of [3, 4, 61, 7.5, "9", null, NaN, Infinity, -1, 0]) manager.onConfig({ maxTabs: bad });
  const afterBad = await openNew();
  check("c6-bad-values-ignored", "坏值（3/4/61/7.5/'9'/null/NaN/Infinity/-1/0）不改变上限，仍是 8", !afterBad.ok && /已达上限（8 个）/.test(afterBad.message ?? ""), afterBad.message);

  // 边界：5 与 60 合法
  manager.onConfig({ maxTabs: 60 });
  const ok9 = await openNew();
  check("c6-boundary-60", "边界 60 合法：上调后第 9 个能开", ok9.ok && (await count()) === 9, await count());
  manager.onConfig({ maxTabs: 61 });
  manager.onConfig({ maxTabs: 5 });
  const afterDown = await openNew();
  check("c6-lower-5", "下调到 5：已有 9 个不被强关，但再开被拒（文案 5 个）", (await count()) === 9 && !afterDown.ok && /已达上限（5 个）/.test(afterDown.message ?? ""), { n: await count(), msg: afterDown.message });

  // 关闭 tab 后可再开
  manager.onConfig({ maxTabs: 8 });
  let tabs = await list();
  for (const t of tabs.slice(-4)) await call("tabs", { action: "close", tabId: t.id });
  check("c6-after-close-count", "关掉 4 个后剩 5 个", (await count()) === 5, await count());
  const again = await openNew();
  check("c6-reopen-after-close", "关闭后（上限 8）可再开", again.ok && (await count()) === 6, await count());

  // 页面脚本 window.open（无手势）计入上限：当前 6，上限 8 → 开 2 个后满，第 3 个无效
  await wopen();
  await wopen();
  const nScript = await count();
  await wopen();
  check("c6-script-open-counts", "页面脚本 window.open 计入上限：6 + 2 = 8，再开不新增", nScript === 8 && (await count()) === 8, { nScript, after: await count() });

  // 带手势的弹窗路径：满额时点击按钮开弹窗不新增；腾出名额后能开
  await call("tabs", { action: "select", tabId: (await list())[0].id });
  await call("navigate", { url: `${base}/p` });
  const snap1 = (await call("snapshot", {})).text;
  const popRef = refOf(snap1, "开弹窗");
  const before = await count();
  if (popRef) await call("click", { ref: popRef });
  await sleep(800);
  check("c6-gesture-popup-full", "满额时带手势弹窗不新增 tab", !!popRef && (await count()) === before && before === 8, { popRef, before, after: await count() });
  const closeOne = (await list()).filter((t) => !t.isActive).slice(-1)[0];
  await call("tabs", { action: "close", tabId: closeOne.id });
  const before2 = await count();
  const snap2 = (await call("snapshot", {})).text;
  const popRef2 = refOf(snap2, "开弹窗");
  if (popRef2) await call("click", { ref: popRef2 });
  await sleep(1200);
  const after2 = await count();
  check("c6-gesture-popup-room", "有名额时带手势弹窗计入（新增 1 个且不超上限）", after2 === before2 + 1 && after2 <= 8, { before2, after2 });

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
