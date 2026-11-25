"use strict";
/**
 * 「清除登录数据」真机 e2e（真实 Electron 42 + 真实 CDP + 真实 session）。
 *
 * 要证明的事（docs/BROWSER-AUTOMATION.md 「清除登录数据」；electron-app/browser/clear-data.mjs 文件头）：
 *   只调 clearStorageData 时，还开着的页面里「内存 token + 续期心跳」会在 1～2 秒内把 HttpOnly 登录 cookie / localStorage 写回、落盘，
 *   刷新页面仍是登录状态。修复后：清除前先让持久档案里的 http(s) 标签停下（about:blank），清完再回原地址。
 *
 *   - 两个任务（会话）各一个已登录的标签，共用持久档案：清除后两边都登出，且 2 秒后登录 cookie 没有被写回、重载后仍登出、磁盘 Cookie 库是空的；
 *   - 页面带 beforeunload（有用户激活，没人放行时 loadURL(about:blank) 会 ERR_ABORTED）也能被终止——先做一次对照证明 beforeunload 确实拦得住；
 *     那次被拦下的导航还在 Tab 上留下了挂起的离开确认框（对照 2 证明它真的在），终止时要「先确认掉、一次终止成功」，而不是靠 ERR_FAILED 重试熬过去；
 *   - 历史栈复原（后退栈原样、当前下标不变），终止期间挂的 will-prevent-unload 监听不留尾巴；
 *   - 无痕标签不碰（页面没被重载、自己的登录 cookie 还在）；空白页标签不碰；reloadedTabs 只数真正重载的；
 *   - 清除步骤失败：照样把页面还回去（不能让标签停在空白页），错误仍抛给调用方；
 *   - 单飞：并发的两次调用只清一轮。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/clear-login-data.cjs --timeout 150
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-clear-login-"));
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

// 登录页：登录 = 写 localStorage + 内存 token + 服务端下发 HttpOnly cookie；已登录页面每 150ms 续期（内存 token 在就继续把登录态写回）。
// 页面带 beforeunload（编辑中的表单）：有用户激活时，没人放行的话离开页面会被拦
const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>login-page</title></head><body>login-page<script>
window.__login = async function () {
  localStorage.setItem('k', 'v');
  window.__token = 'mem-token';
  await fetch('/login', { credentials: 'include' });
  return 'logged-in';
};
window.__rewrites = 0;
setInterval(function () {
  if (!window.__token) return;
  if (localStorage.getItem('k') === null) { localStorage.setItem('k', 'v-rewritten'); window.__rewrites++; }
  fetch('/beat', { credentials: 'include', headers: { 'x-token': window.__token } });
}, 150);
window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = 'unsaved'; return 'unsaved'; });
</script></body></html>`;

const main = async () => {
  await app.whenReady();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const cookie = req.headers.cookie || "";
    res.setHeader("cache-control", "no-store");
    if (p === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(LOGIN_PAGE);
    }
    if (p === "/p1" || p === "/p2") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><title>${p}</title>${p}`);
    }
    if (p === "/login") {
      res.setHeader("set-cookie", ["sid=abc; HttpOnly; Path=/; Max-Age=3600", "pub=1; Path=/; Max-Age=3600"]);
      return res.end("ok");
    }
    if (p === "/whoami") return res.end(cookie);
    if (p === "/beat") {
      if (req.headers["x-token"] === "mem-token") res.setHeader("set-cookie", ["sid=abc; HttpOnly; Path=/; Max-Age=3600"]);
      return res.end(cookie ? "has-cookie" : "no-cookie");
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);
  const tabMod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/tab.mjs")).href);
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

  const T1 = "e2e-clear-t1";
  const T2 = "e2e-clear-t2";
  const call = (op, args = {}, taskId = T1) => manager.dispatch(op, args, { taskId });
  const tabOf = (taskId, id) => manager.getSession(taskId).getTab(id);
  const ses = session.fromPartition(PART);
  const hist = (wc) => {
    const n = wc.navigationHistory;
    return { urls: n.getAllEntries().map((e) => String(e.url).replace(ORIGIN, "")), idx: n.getActiveIndex() };
  };
  const loaded = (tab, url) => tab.wc.getURL() === url && !tab.wc.isLoading();
  const snap = (tab) =>
    tab.wc.executeJavaScript(`(async () => ({
      docCookie: document.cookie,
      k: localStorage.getItem('k'),
      token: window.__token || null,
      rewrites: window.__rewrites || 0,
      serverSawCookie: await (await fetch('/whoami', { credentials: 'include' })).text(),
    }))()`);
  const loggedOut = (s) => s.docCookie === "" && s.k === null && s.token === null && s.serverSawCookie === "";
  const jarNames = async (s = ses) => (await s.cookies.get({})).map((c) => c.name).sort();
  const diskCookies = () => {
    const db = path.join(USERDATA, "Partitions", "flowship-browser", "Cookies");
    try {
      return execFileSync("/usr/bin/sqlite3", ["-readonly", db, "select name from cookies order by name;"], { encoding: "utf8", timeout: 5000 })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch (e) {
      return null; // 没有 sqlite3（非 macOS）：跳过磁盘校验
    }
  };

  // ───────── 准备：T1 三步历史 + 登录；T2 登录；T1 还有一个空白页标签和一个无痕标签（也登录）─────────
  await call("navigate", { url: ORIGIN + "/p1" });
  await call("navigate", { url: ORIGIN + "/p2" });
  await call("navigate", { url: ORIGIN + "/" });
  const t1 = tabOf(T1, "t1");
  await waitFor(() => loaded(t1, ORIGIN + "/"));
  await t1.wc.executeJavaScript("window.__login()", true); // userGesture=true：页面有 sticky activation，beforeunload 才会真拦

  await call("navigate", { url: ORIGIN + "/" }, T2);
  const t2tab = tabOf(T2, "t1");
  await waitFor(() => loaded(t2tab, ORIGIN + "/"));
  await t2tab.wc.executeJavaScript("window.__login()", true);

  await call("tabs", { action: "new" }); // 空白页标签（T1）
  const afterBlank = await call("tabs", { action: "list" });
  const blankInfo = afterBlank.tabs.find((t) => t.id !== "t1");
  const blankTab = tabOf(T1, blankInfo.id);

  await call("tabs", { action: "new", incognito: true });
  const listed = await call("tabs", { action: "list" });
  const incInfo = listed.tabs.find((t) => t.incognito);
  const incTab = tabOf(T1, incInfo.id);
  await call("navigate", { url: ORIGIN + "/" }); // 新建后激活的是无痕标签
  await waitFor(() => loaded(incTab, ORIGIN + "/"));
  await incTab.wc.executeJavaScript("window.__login()", true);
  await sleep(600);
  const incSes = session.fromPartition(incTab.partition);
  const incOriginBefore = await incTab.wc.executeJavaScript("performance.timeOrigin");
  await ses.cookies.flushStore();

  const preJar = await jarNames();
  const preInc = await jarNames(incSes);
  check("pre-logged-in", "准备：持久档案里有 sid / pub，无痕 partition 有自己的一份", preJar.includes("sid") && preJar.includes("pub") && preInc.includes("sid"), { preJar, preInc });
  const preHist = hist(t1.wc);

  // 对照：页面的 beforeunload 确实拦得住（没人放行时 loadURL(about:blank) 被 ERR_ABORTED、页面原地不动）——否则下面「能终止」不说明问题
  const ctl = await t1.wc.loadURL("about:blank").then(
    () => "navigated",
    (e) => e.code || String(e.message),
  );
  check("ctl-beforeunload-armed", "对照：不放行时 beforeunload 拦得住导航（ERR_ABORTED，页面原地不动）", ctl === "ERR_ABORTED" && t1.wc.getURL() === ORIGIN + "/", { ctl, url: t1.wc.getURL() });

  // 对照 2（探针 D）：被拦下的那次导航在 Tab 上留下了「离开确认框」——CDP 把 beforeunload 挂成 pendingDialog，Chromium 要一两秒才结算，
  // 期间新的导航会 ERR_FAILED。紧接着的清除就是在这个状态下终止页面的：要证明它是「先确认掉、一次终止成功」，而不是靠重试熬过去
  // （两条路各自单独都能让流程走通，只看最终结果区分不出来——所以这里数 about:blank 的导航次数与确认框的回答）
  const pendingBefore = t1.pendingDialog && t1.pendingDialog.type;
  check("ctl-dialog-pending", "对照：被拦下的导航在 Tab 上留下了 beforeunload 确认框（终止时必须先确认掉它）", pendingBefore === "beforeunload", { pendingBefore });
  const blankLoads = [];
  const answers = [];
  const origLoadURL = t1.wc.loadURL.bind(t1.wc);
  const origAnswer = t1.answerDialog.bind(t1);
  t1.wc.loadURL = (u, ...rest) => {
    if (u === "about:blank") blankLoads.push(u);
    return origLoadURL(u, ...rest);
  };
  t1.answerDialog = (...a) => {
    answers.push({ accept: a[0], by: a[2] && a[2].by });
    return origAnswer(...a);
  };

  // ───────── 清除 ─────────
  const result = await ipcCall("browser:clearBrowsingData");
  t1.wc.loadURL = origLoadURL;
  t1.answerDialog = origAnswer;
  check("clear-result", "清除返回 { reloadedTabs: 2 }（T1 与 T2 各一个 http 页；空白页与无痕不计）", result && result.reloadedTabs === 2, result);
  check(
    "halt-first-try",
    "T1 挂着离开确认框：先确认掉（以用户身份同意离开）、about:blank 一次就成，没有靠 ERR_FAILED 重试熬过去",
    blankLoads.length === 1 && answers.length === 1 && answers[0].accept === true && answers[0].by === "user",
    { blankLoads: blankLoads.length, answers },
  );

  const ready1 = await waitFor(() => loaded(t1, ORIGIN + "/"), 8000);
  const ready2 = await waitFor(() => loaded(t2tab, ORIGIN + "/"), 8000);
  const s1 = ready1 ? await snap(t1) : null;
  const s2 = ready2 ? await snap(t2tab) : null;
  check("t1-logged-out", "T1：页面回到原地址，cookie / localStorage / 内存 token 都没了，服务端看不到登录 cookie", !!s1 && loggedOut(s1), s1);
  check("t2-logged-out", "T2（另一个任务、共用持久档案）同样登出", !!s2 && loggedOut(s2), s2);

  // 老行为在这里翻车：旧页面的心跳 1～2 秒内把 sid 写回。重载后的页面没有 token，不会再续期
  await sleep(2000);
  const jar2 = await jarNames();
  const s1b = await snap(t1);
  check("no-resurrect", "清除后 2 秒：登录 cookie 没被写回（cookie 库里没有 sid），localStorage 也没被写回", !jar2.includes("sid") && s1b.k === null && s1b.rewrites === 0, { jar2, s1b });

  const histOk = await waitFor(() => {
    const h = hist(t1.wc);
    return JSON.stringify(h) === JSON.stringify(preHist) ? h : null;
  }, 4000);
  check("history-restored", "T1 历史栈原样复原（后退栈与当前下标都不变；终止 / 恢复多出的两条已修剪）", !!histOk, { before: preHist, after: hist(t1.wc) });
  check("no-listener-leak", "终止期间挂的 will-prevent-unload 监听已摘掉（两个标签都没有残留）", t1.wc.listenerCount("will-prevent-unload") === 0 && t2tab.wc.listenerCount("will-prevent-unload") === 0);

  check("blank-untouched", "空白页标签没被碰（仍是 about:blank）", blankTab.wc.getURL() === "about:blank", blankTab.wc.getURL());

  const incNow = await incTab.wc.executeJavaScript(`({ origin: performance.timeOrigin, token: window.__token || null, cookie: document.cookie })`);
  const incJar = await jarNames(incSes);
  check("incognito-untouched", "无痕标签没被碰：页面没重载（同一个 timeOrigin、内存 token 还在）、自己的登录 cookie 还在", incNow.origin === incOriginBefore && incNow.token === "mem-token" && incJar.includes("sid"), { incNow, incJar });

  // 重载后仍登出（老行为：刷新页面还是登录状态）+ 磁盘上的 Cookie 库是空的
  await t1.wc.reload();
  await waitFor(() => loaded(t1, ORIGIN + "/"), 8000);
  const afterReload = await snap(t1);
  check("reload-still-logged-out", "清除后重载页面仍是登出态（老行为：刷新还是登录）", loggedOut(afterReload), afterReload);
  await ses.cookies.flushStore();
  const disk = diskCookies();
  check("disk-clean", "磁盘上的 Cookie 库里没有登录 cookie", disk === null || (!disk.includes("sid") && !disk.includes("pub")), disk === null ? "跳过：没有 sqlite3" : disk);

  // ───────── 清除步骤失败：照样还原页面，错误仍抛 ─────────
  await t1.wc.executeJavaScript("window.__login()", true);
  const origClear = ses.clearStorageData.bind(ses);
  let storageCalls = 0;
  let failNext = false;
  ses.clearStorageData = (...a) => {
    storageCalls += 1;
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("e2e-boom"));
    }
    return origClear(...a);
  };
  failNext = true;
  const failure = await ipcCall("browser:clearBrowsingData").then(
    () => null,
    (e) => String(e && e.message),
  );
  const restored = await waitFor(() => loaded(t1, ORIGIN + "/"), 8000);
  check("failure-restores-page", "clearStorageData 抛错：错误照常抛给调用方，T1 页面仍被还回原地址（不停在空白页）", failure === "e2e-boom" && !!restored, { failure, url: t1.wc.getURL() });

  // ───────── 单飞：并发两次只清一轮 ─────────
  await t1.wc.executeJavaScript("window.__login()", true);
  storageCalls = 0;
  const [r1, r2] = await Promise.all([ipcCall("browser:clearBrowsingData"), ipcCall("browser:clearBrowsingData")]);
  check("single-flight", "并发两次调用只清一轮（clearStorageData 只调 1 次，两次拿到同一结果）", storageCalls === 1 && r1 === r2 && r1.reloadedTabs >= 1, { storageCalls, r1, r2 });
  await waitFor(() => loaded(t1, ORIGIN + "/"), 8000);
  await sleep(500);
  const finalSnap = await snap(t1);
  check("final-logged-out", "单飞那一轮之后同样登出、没被写回", loggedOut(finalSnap), finalSnap);

  ses.clearStorageData = origClear;
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
