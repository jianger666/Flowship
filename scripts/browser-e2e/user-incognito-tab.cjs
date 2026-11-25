"use strict";
/**
 * 用户侧「新建无痕标签页」真机 e2e（真实 Electron 42 + 真实 CDP + 真实 session）。
 *
 * 面板「更多」菜单的入口走独立通道 `browser:newIncognitoTab`（AI 侧的 `tabs new incognito` 早就有；用户这头此前没有入口）。要证明：
 *   - 会话不存在也能建：懒创建会话、只有这一个无痕标签（不额外带一个空白的持久初始标签），TabInfo.incognito=true，partition 是内存的无痕名；
 *     之后面板 attach 上来不会再多开标签；
 *   - 与持久档案双向隔离：持久档案里的 cookie 无痕标签看不到、无痕里登录写不进持久档案；同会话里普通标签看得到持久 cookie、看不到无痕的；
 *   - 关标签即清空：partition 被清、复用同名的新无痕标签读不到上一个的登录态；
 *   - 无痕标签里开出的新标签（页面 window.open 无手势兜底 / 右键「在新标签页打开」）沿用同一个无痕 partition，不掉进持久档案；
 *     普通标签开出的仍在持久档案；共用 partition 的标签先关不清、最后一个关掉才清；
 *   - 失败不 reject：标签页已达上限 → { ok:false, error }（文案不带写给 AI 的工具名）；被 URL 策略拒绝的地址 → { ok:false }，不建会话。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/user-incognito-tab.cjs --timeout 120
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-user-incognito-"));
const USERDATA = path.join(TMP, "userdata");
fs.mkdirSync(USERDATA, { recursive: true });
app.setPath("userData", USERDATA);
app.setPath("downloads", path.join(TMP, "downloads"));
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 清临时目录（含 userData）。正常收尾和脚本抛错两条出口都要走它（tests/browser-emulation-fit.test.ts 的 FATAL 出口契约钉着）。
// best-effort：Chromium 退出前可能还在写缓存，偶发 ENOTEMPTY / EBUSY——先销毁剩下的窗口再重试几次，仍清不掉只告警，不改退出码；可重复调用
const cleanupTmp = () => {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.destroy();
    } catch {
      /* 已销毁 */
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn("SMOKE WARN 临时目录没清掉（不影响结果）：", err && err.message ? err.message : err);
  }
};

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

const main = async () => {
  await app.whenReady();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    res.setHeader("cache-control", "no-store");
    if (p === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end("<!doctype html><title>fixture</title>fixture");
    }
    if (p === "/login") {
      res.setHeader("set-cookie", ["sid=abc; HttpOnly; Path=/; Max-Age=3600"]);
      return res.end("ok");
    }
    if (p === "/whoami") return res.end(req.headers.cookie || "");
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const tabMod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/tab.mjs")).href);
  const incMod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/incognito.mjs")).href);
  const PART = tabMod.BROWSER_PARTITION;

  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");

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

  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain: ipcSpy,
    nativeImage,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: (u) => /:9\//.test(u),
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  manager.onConfig({ evaluateEnabled: true, maxTabs: 20 });
  manager.registerIpc();

  const U1 = "e2e-uinc-1";
  const tabOf = (taskId, id) => manager.getSession(taskId).getTab(id);
  const loaded = (tab, url) => tab.wc.getURL() === url && !tab.wc.isLoading();
  const whoami = (tab) => tab.wc.executeJavaScript("fetch('/whoami', { credentials: 'include' }).then((r) => r.text())");
  const login = (tab) => tab.wc.executeJavaScript("fetch('/login', { credentials: 'include' }).then((r) => r.text())");
  const jarNames = async (s) => (await s.cookies.get({})).map((c) => c.name).sort();
  const ses = session.fromPartition(PART);

  // ───────── 会话不存在：直接建无痕标签 ─────────
  const noSessionBefore = manager.getSession(U1);
  const created = await ipcCall("browser:newIncognitoTab", U1);
  const state1 = await ipcCall("browser:getState", U1);
  check(
    "lazy-create",
    "会话不存在也能建：返回 { ok, tabId }，会话被懒创建，只有这一个标签且 TabInfo.incognito=true",
    !noSessionBefore && created && created.ok === true && created.tabId === "t1" && state1 && state1.exists === true && state1.tabs.length === 1 && state1.tabs[0].incognito === true,
    { noSessionBefore: !!noSessionBefore, created, tabs: state1 && state1.tabs.map((t) => ({ id: t.id, incognito: t.incognito })) },
  );

  const t1 = tabOf(U1, "t1");
  check(
    "real-partition",
    "标签在内存的无痕 partition 里（匹配无痕命名规则、不是持久档案），wc.session 与持久档案是两个 session",
    incMod.isIncognitoPartition(t1.partition) && t1.partition !== PART && t1.wc.session !== ses,
    { partition: t1.partition },
  );

  const attached = await ipcCall("browser:attach", U1, { x: 0, y: 0, width: 600, height: 400 });
  check("attach-keeps-one-tab", "面板随后 attach 上来：仍只有这一个无痕标签（没有多开空白的持久初始标签）", attached && attached.attached === true && attached.tabs.length === 1 && attached.tabs[0].incognito === true, attached && attached.tabs.map((t) => ({ id: t.id, incognito: t.incognito })));

  // ───────── 隔离 ─────────
  await ses.cookies.set({ url: ORIGIN + "/", name: "pcookie", value: "1" });
  const withUrl = await ipcCall("browser:newIncognitoTab", U1, ORIGIN + "/");
  const incTab = withUrl && withUrl.ok ? tabOf(U1, withUrl.tabId) : null;
  const incLoaded = incTab ? await waitFor(() => loaded(incTab, ORIGIN + "/"), 8000) : false;
  check("url-loads", "带地址新建：新的无痕标签加载了该地址", !!incLoaded, { withUrl, url: incTab && incTab.wc.getURL() });

  const seenByInc = incLoaded ? await whoami(incTab) : null;
  check("inc-cant-see-persistent", "持久档案里的 cookie（pcookie）无痕标签看不到", seenByInc === "", { seenByInc });

  if (incLoaded) await login(incTab);
  const incSes = session.fromPartition(incTab.partition);
  const persistentJar = await jarNames(ses);
  const incJar = await jarNames(incSes);
  check("login-not-leaking", "无痕里登录：sid 只在无痕 partition，写不进持久档案", incJar.includes("sid") && !persistentJar.includes("sid"), { persistentJar, incJar });

  const plainId = await ipcCall("browser:newTab", U1, ORIGIN + "/");
  const plainTab = plainId ? tabOf(U1, plainId) : null;
  const plainLoaded = plainTab ? await waitFor(() => loaded(plainTab, ORIGIN + "/"), 8000) : false;
  const seenByPlain = plainLoaded ? await whoami(plainTab) : null;
  check(
    "plain-tab-contrast",
    "对照：同会话里 browser:newTab 开的普通标签在持久档案里，看得到 pcookie、看不到无痕里登录的 sid",
    !!plainLoaded && /pcookie=1/.test(seenByPlain) && !/sid=/.test(seenByPlain) && plainTab.incognito !== true,
    { plainId, seenByPlain },
  );

  // ───────── 关标签即清空 + 名字复用不串味 ─────────
  const incName = incTab.partition;
  await ipcCall("browser:closeTab", U1, withUrl.tabId);
  const wiped = await waitFor(async () => (await jarNames(incSes)).length === 0, 8000);
  check("close-wipes", "关掉这个无痕标签：它的 partition 被清空（cookie 库里什么都没有）", !!wiped, { name: incName, jar: await jarNames(incSes) });

  const again = await ipcCall("browser:newIncognitoTab", U1, ORIGIN + "/");
  const againTab = again && again.ok ? tabOf(U1, again.tabId) : null;
  const againLoaded = againTab ? await waitFor(() => loaded(againTab, ORIGIN + "/"), 8000) : false;
  const seenAgain = againLoaded ? await whoami(againTab) : null;
  check("reuse-clean", "再开一个无痕标签（可能复用刚清空的名字）：读不到上一个的 sid", !!againLoaded && seenAgain === "", { reusedName: againTab && againTab.partition === incName, seenAgain });

  // ───────── 无痕标签开出来的新标签：留在同一个无痕环境，不掉进持久档案 ─────────
  // 页面 target=_blank / 无手势 window.open 的兜底、右键「在新标签页打开」都经 session.onNewTab → openTab({ opener })；
  // 以前它只认显式 incognito:true，所以这些新标签会静默落进持久档案（带着持久登录态、新写的 cookie 留在磁盘上）
  const U4 = "e2e-uinc-4";
  const opened4 = await ipcCall("browser:newIncognitoTab", U4, ORIGIN + "/");
  const opener = opened4 && opened4.ok ? tabOf(U4, opened4.tabId) : null;
  const openerLoaded = opener ? await waitFor(() => loaded(opener, ORIGIN + "/"), 8000) : false;
  if (openerLoaded) await login(opener);
  const openerSes = openerLoaded ? session.fromPartition(opener.partition) : null;
  const tabIds4 = () => manager.getSession(U4).tabs.map((t) => t.id);
  const newTabAfter = async (before) => {
    const id = await waitFor(() => tabIds4().find((x) => !before.includes(x)), 8000);
    const tab = id ? tabOf(U4, id) : null;
    if (tab) await waitFor(() => loaded(tab, ORIGIN + "/"), 8000);
    return tab;
  };

  const beforePage = tabIds4();
  if (openerLoaded) await opener.wc.executeJavaScript(`window.open(${JSON.stringify(ORIGIN + "/")}, "_blank"); 1`); // 无手势：走 deny + onNewTab 兜底
  const childPage = openerLoaded ? await newTabAfter(beforePage) : null;
  const seenByChildPage = childPage ? await whoami(childPage) : null;
  check(
    "child-inherits-page-open",
    "无痕标签里页面 window.open（无手势兜底，即 target=_blank 的落点）开出的新标签：沿用同一个无痕 partition，带着无痕里登录的 sid、看不到持久档案的 pcookie",
    !!childPage && childPage.partition === opener.partition && childPage.incognito === true && /sid=abc/.test(seenByChildPage ?? "") && !/pcookie/.test(seenByChildPage ?? ""),
    { childPartition: childPage && childPage.partition, openerPartition: opener && opener.partition, seenByChildPage },
  );

  const beforeMenu = tabIds4();
  if (openerLoaded) opener.hooks.onNewTab({ url: ORIGIN + "/", disposition: "foreground-tab", openerTabId: opener.id, byUser: true }); // 右键「在新标签页打开」最终调的就是这个钩子（user-features.mjs）
  const childMenu = openerLoaded ? await newTabAfter(beforeMenu) : null;
  const seenByChildMenu = childMenu ? await whoami(childMenu) : null;
  check(
    "child-inherits-context-menu",
    "右键「在新标签页打开」从无痕标签里开的新标签：同样沿用无痕 partition（sid 在、pcookie 不在）",
    !!childMenu && childMenu.partition === opener.partition && childMenu.incognito === true && /sid=abc/.test(seenByChildMenu ?? "") && !/pcookie/.test(seenByChildMenu ?? ""),
    { childPartition: childMenu && childMenu.partition, seenByChildMenu },
  );

  const plain4Id = await ipcCall("browser:newTab", U4, ORIGIN + "/");
  const plain4 = plain4Id ? tabOf(U4, plain4Id) : null;
  if (plain4) await waitFor(() => loaded(plain4, ORIGIN + "/"), 8000);
  const beforePlain = tabIds4();
  if (plain4) await plain4.wc.executeJavaScript(`window.open(${JSON.stringify(ORIGIN + "/")}, "_blank"); 1`);
  const childPlain = plain4 ? await newTabAfter(beforePlain) : null;
  const seenByChildPlain = childPlain ? await whoami(childPlain) : null;
  check(
    "plain-child-stays-persistent",
    "对照：普通标签里页面 window.open 开出的新标签仍在持久档案里（看得到 pcookie、看不到无痕的 sid），没有被误当成无痕",
    !!childPlain && childPlain.partition === PART && childPlain.incognito !== true && /pcookie=1/.test(seenByChildPlain ?? "") && !/sid=/.test(seenByChildPlain ?? ""),
    { childPartition: childPlain && childPlain.partition, seenByChildPlain },
  );

  // 引用计数（真 Electron）：opener 与两个子标签共用一个 partition，最后一个关掉才清
  if (openerLoaded) await ipcCall("browser:closeTab", U4, opener.id);
  await sleep(1000);
  const jarOpenerClosed = openerSes ? await jarNames(openerSes) : [];
  check("opener-close-keeps", "先关 opener：两个子标签还在用这个无痕 partition → 不清空（sid 仍在）", jarOpenerClosed.includes("sid"), { jar: jarOpenerClosed });
  if (childPage) await ipcCall("browser:closeTab", U4, childPage.id);
  await sleep(1000);
  const jarOneLeft = openerSes ? await jarNames(openerSes) : [];
  check("one-left-keeps", "再关一个子标签：还剩一个在用 → 仍不清空", jarOneLeft.includes("sid"), { jar: jarOneLeft });
  if (childMenu) await ipcCall("browser:closeTab", U4, childMenu.id);
  const wipedShared = openerSes ? await waitFor(async () => (await jarNames(openerSes)).length === 0, 8000) : false;
  check("last-close-wipes", "共用这个无痕 partition 的最后一个标签关掉 → 才清空", !!wipedShared, { jar: openerSes ? await jarNames(openerSes) : null });
  const persistentJarEnd = await jarNames(ses);
  check("persistent-untouched", "全程持久档案没被污染也没被清：pcookie 还在、没有 sid", persistentJarEnd.includes("pcookie") && !persistentJarEnd.includes("sid"), { persistentJarEnd });

  // ───────── 失败不 reject ─────────
  const U2 = "e2e-uinc-2";
  manager.onConfig({ maxTabs: 5 }); // 设置允许的最小上限（onConfig 只认 5～60）
  const filled = [];
  for (let i = 0; i < 5; i += 1) filled.push(await ipcCall("browser:newIncognitoTab", U2));
  const over = await ipcCall("browser:newIncognitoTab", U2);
  manager.onConfig({ maxTabs: 20 });
  check(
    "limit-friendly-error",
    "标签页已达上限（5 个）：第 6 个返回 { ok:false, error }，文案不带写给 AI 的工具名（browser_tabs）；已有的 5 个标签不受影响",
    filled.every((r) => r && r.ok === true) && over && over.ok === false && /标签页已达上限/.test(over.error) && !/browser_tabs/.test(over.error) && manager.getSession(U2).tabs.length === 5,
    { over, tabs: manager.getSession(U2).tabs.length },
  );

  const U3 = "e2e-uinc-3";
  const rejected = await ipcCall("browser:newIncognitoTab", U3, "file:///etc/hosts");
  check("policy-reject", "被 URL 策略拒绝的地址（file:）：{ ok:false, error }，不建会话", rejected && rejected.ok === false && typeof rejected.error === "string" && !manager.getSession(U3), { rejected, session: !!manager.getSession(U3) });

  manager.destroy();
  server.closeAllConnections?.();
  server.close();
};

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`);
    cleanupTmp(); // 清不掉只告警（不让「全部通过」被清理失败变成 FATAL exit 1）
    app.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error("SMOKE ERROR", (e && e.stack) || e);
    const failed = results.filter((r) => !r.ok);
    console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length} passed（脚本中途异常）${failed.length ? ` FAILED: ${failed.map((f) => f.id).join(",")}` : ""}`);
    cleanupTmp(); // 错误已先打出；清理只告警，退出码仍是 1
    app.exit(1);
  });
