"use strict";
/**
 * E2·P3 真机 e2e（真 Electron + 真 CDP + 真 session.cookies）：A1 登录态 `storage` op + A7 evaluate 审批 / 响应体开关。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p3-storage-evaluate.cjs --timeout 150
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动（等价于 server 经 ipc 通道发 req）。
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 *
 * 「Flowship origin」用 app.localhost 模拟（isAppUrl 只认它；Chromium 把 *.localhost 解析到回环）：cookie 直接种进 tab 的 session jar，
 * 验证 storage op 无论如何读不到 / 删不掉 / 写不进。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2p3-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`E2P3 ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SID = "SECRET-SESSION-ABCDEF";
const THEME = "dark-mode-xyz";
const LS_VAL = "LS-VALUE-123456";
const SS_VAL = "SS-VALUE-654321";
const APP_SECRET = "FLOWSHIP-INTERNAL-TOKEN";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>E2P3</title></head><body><h1>E2P3</h1>
<script>
window.__ready = false;
try {
  localStorage.setItem('ls_token', '${LS_VAL}');
  sessionStorage.setItem('ss_k', '${SS_VAL}');
  var req = indexedDB.open('e2db', 1);
  req.onupgradeneeded = function () { req.result.createObjectStore('items', { keyPath: 'id' }); };
  req.onsuccess = function () { req.result.close(); window.__ready = true; };
  req.onerror = function () { window.__ready = 'idb-error'; };
} catch (e) { window.__ready = 'error:' + e; }
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/data.json") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ hello: "e2p3-body-marker" }));
      }
      if (p === "/whoami") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ cookie: req.headers.cookie || "" }));
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (p === "/") {
        res.setHeader("set-cookie", [`sid=${SID}; HttpOnly; Path=/`, `theme=${THEME}; Path=/`]);
        return res.end(PAGE);
      }
      res.end(`<!doctype html><title>${p}</title><h1>${p}</h1>`);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

const main = async () => {
  await app.whenReady();
  const { server, port } = await startFixture();
  const base = `http://127.0.0.1:${port}`;
  const appBase = `http://app.localhost:${port}`;
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);

  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");

  const EVAL_TIMEOUT = 700; // 缩短的审批超时（生产 120s），经 createBrowserManager 的 evaluatePromptTimeoutMs 注入
  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain,
    nativeImage,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: (u) => /^https?:\/\/app\.localhost(:\d+)?(\/|$)/i.test(String(u)),
    isTrustedIpcSender: () => true,
    evaluatePromptTimeoutMs: EVAL_TIMEOUT,
    log: (m) => console.log("  [log]", m),
  });

  // 假 server 通道：只为捕获主进程发给 server 的事件（A7 always → settings_set）
  const sent = [];
  const fakeProc = new EventEmitter();
  fakeProc.connected = true;
  fakeProc.send = (msg, cb) => {
    sent.push(msg);
    if (typeof cb === "function") cb(null);
    return true;
  };
  manager.attachServerChannel(fakeProc);

  const T = "e2p3-task";
  const callAs = (taskId, op, args = {}, signal) => manager.dispatch(op, args, { taskId, signal });
  const call = (op, args = {}, signal) => callAs(T, op, args, signal);
  const tryAs = async (taskId, op, args, signal) => {
    try {
      return { ok: true, value: await callAs(taskId, op, args, signal) };
    } catch (e) {
      return { ok: false, code: e?.code, message: String(e?.message ?? e) };
    }
  };
  const tryCall = (op, args) => tryAs(T, op, args);
  const st = (action, extra = {}) => tryCall("storage", { action, ...extra });
  const ev = async (expr) => (await call("evaluate", { expression: expr })).value;
  const stateDir = (taskId) => path.join(TMP, "data", "tasks", taskId, "browser-state");
  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await fn();
      if (v) return v;
      await sleep(40);
    }
    return null;
  };
  const sess = (taskId) => manager.getSession(taskId);
  const pendingEvaluatePrompt = (taskId) => sess(taskId)?.getState().prompts.find((p) => p.kind === "evaluate");

  // ═══════════ 准备：页面种下 cookie / localStorage / sessionStorage / IndexedDB ═══════════
  manager.onConfig({ evaluateEnabled: true });
  check("cfg-default-closed", "storageAccess 默认关（只认显式 true）", manager.getConfig().storageAccess !== true, manager.getConfig());
  await call("navigate", { url: `${base}/` });
  check("page-ready", "fixture 页面写入 localStorage / sessionStorage / IndexedDB 完成", (await waitFor(async () => (await ev("window.__ready")) === true)) !== null);

  // ═══════════ A1 · storageAccess 关（默认） ═══════════
  const l1 = await st("cookies_list");
  const cookies1 = l1.ok ? l1.value.cookies : [];
  const sidC = cookies1.find((c) => c.name === "sid");
  check("off-list-names", "cookies_list：只有名字与属性（含 HttpOnly 的 sid，主进程 session.cookies 读得到）", l1.ok && sidC && sidC.httpOnly === true && cookies1.some((c) => c.name === "theme"), cookies1.map((c) => c.name));
  check("off-list-masked", "cookies_list 值只有「长度 + 前 4 位」，没有明文 value 字段", l1.ok && !("value" in sidC) && /前 4 位「SECR」/.test(sidC.valueHint) && !JSON.stringify(l1.value).includes(SID), sidC?.valueHint);
  check("off-list-not-revealed", "cookies_list 结果 revealed=false", l1.ok && l1.value.revealed === false);
  const get1 = await st("cookies_get", { name: "sid" });
  check("off-get-masked", "cookies_get（不带 reveal）仍是脱敏", get1.ok && !JSON.stringify(get1.value).includes(SID), get1.ok ? get1.value.cookies?.[0]?.valueHint : get1);

  const sl = await st("storage_list", { area: "local" });
  check("off-ls-masked", "storage_list(local)：键名可见，值脱敏", sl.ok && sl.value.items.some((i) => i.key === "ls_token") && !JSON.stringify(sl.value).includes(LS_VAL) && /前 4 位「LS-V」/.test(sl.value.items[0].valueHint), sl.ok ? sl.value.items : sl);
  const ss = await st("storage_list", { area: "session" });
  check("off-ss-masked", "storage_list(session)：键名可见，值脱敏", ss.ok && ss.value.items.some((i) => i.key === "ss_k") && !JSON.stringify(ss.value).includes(SS_VAL), ss.ok ? ss.value.items : ss);
  const idb = await st("idb_list");
  check("off-idb-list", "idb_list（读类，不要开关）能列出库名 e2db 与对象仓库 items", idb.ok && idb.value.databases.some((d) => d.name === "e2db" && d.objectStores.some((s) => s.name === "items")), idb.ok ? idb.value.databases : idb);

  const denied = {
    "cookies_get reveal": ["cookies_get", { name: "sid", reveal: true }],
    "cookies_list reveal": ["cookies_list", { reveal: true }],
    "storage_get reveal": ["storage_get", { area: "local", key: "ls_token", reveal: true }],
    "storage_list reveal": ["storage_list", { area: "local", reveal: true }],
    cookies_set: ["cookies_set", { name: "x", value: "y" }],
    cookies_delete: ["cookies_delete", { name: "theme" }],
    cookies_clear: ["cookies_clear", {}],
    storage_set: ["storage_set", { area: "local", key: "k", value: "v" }],
    storage_remove: ["storage_remove", { area: "local", key: "ls_token" }],
    storage_clear: ["storage_clear", { area: "local" }],
    export_state: ["export_state", {}],
    import_state: ["import_state", { file: "nope" }],
    clear_site: ["clear_site", {}],
  };
  for (const [label, [action, extra]] of Object.entries(denied)) {
    const r = await st(action, extra);
    check(`off-denied-${label.replace(/\s+/g, "-")}`, `开关关：${label} → ACCESS_DISABLED`, !r.ok && r.code === "ACCESS_DISABLED", r.ok ? r.value : r.code);
  }
  const still = await st("cookies_list");
  check("off-nothing-changed", "被拒的写 / 清 / 导出一个都没生效（cookie 仍在、没有产生 browser-state 目录）", still.ok && still.value.cookies.length === cookies1.length && !fs.existsSync(stateDir(T)), still.ok ? still.value.cookies.length : still);
  check("off-localstorage-intact", "localStorage 仍在", (await ev("localStorage.getItem('ls_token')")) === LS_VAL);

  // ═══════════ A1 · storageAccess 开 ═══════════
  manager.onConfig({ storageAccess: true });
  const g = await st("cookies_get", { name: "sid", reveal: true });
  check("on-cookie-plain", "reveal：cookies_get 返回 HttpOnly cookie 的明文", g.ok && g.value.revealed === true && g.value.cookies[0].value === SID, g.ok ? g.value.cookies : g);
  const gl = await st("storage_get", { area: "local", key: "ls_token", reveal: true });
  check("on-ls-plain", "reveal：storage_get(local) 明文", gl.ok && gl.value.item.value === LS_VAL, gl.ok ? gl.value.item : gl);
  const gs = await st("storage_get", { area: "session", key: "ss_k", reveal: true });
  check("on-ss-plain", "reveal：storage_get(session) 明文", gs.ok && gs.value.item.value === SS_VAL, gs.ok ? gs.value.item : gs);

  const cs = await st("cookies_set", { name: "e2set", value: "hello-world-1" });
  check("on-cookie-set", "cookies_set 生效：页面 document.cookie 能读到，服务端也收到", cs.ok && (await ev("document.cookie")).includes("e2set=hello-world-1") && (await ev("fetch('/whoami').then(r => r.text())")).includes("e2set=hello-world-1"), cs.ok ? cs.value : cs);
  const csh = await st("cookies_set", { name: "e2http", value: "http-only-val", httpOnly: true });
  check("on-cookie-set-httponly", "cookies_set httpOnly：服务端收到、document.cookie 读不到", csh.ok && !(await ev("document.cookie")).includes("e2http") && (await ev("fetch('/whoami').then(r => r.text())")).includes("e2http=http-only-val"), csh.ok ? csh.value : csh);
  // 注入向量：名字里的 ; / = / 换行会让浏览器把后半段当成属性（如 Domain=…），必须在主进程拒掉（空格本身无害，策略允许）
  for (const evilName of ["a;Domain=evil.example", "a=b", "a\r\nSet-Cookie: x=1"]) {
    const bad = await st("cookies_set", { name: evilName, value: "x" });
    check(`on-cookie-set-badname-${JSON.stringify(evilName).length}`, `cookies_set 名字含注入字符 ${JSON.stringify(evilName)} → BAD_ARGS`, !bad.ok && bad.code === "BAD_ARGS", bad.ok ? bad.value : bad.code);
  }
  const badVal = await st("cookies_set", { name: "okname", value: "v; Domain=evil.example" });
  check("on-cookie-set-badvalue", "cookies_set 值含 ; → BAD_ARGS（防属性注入）", !badVal.ok && badVal.code === "BAD_ARGS", badVal.ok ? badVal.value : badVal.code);
  const bad2 = await st("cookies_set", { name: "x", value: "y", domain: "evil.example" });
  check("on-cookie-set-foreign-domain", "cookies_set domain 与当前站点不匹配 → BAD_ARGS（不能给别的站点种 cookie）", !bad2.ok && bad2.code === "BAD_ARGS", bad2.ok ? bad2.value : bad2.code);

  const ssl = await st("storage_set", { area: "local", key: "k2", value: "v2-from-ai" });
  check("on-ls-set", "storage_set(local) 生效（页面再读验证）", ssl.ok && (await ev("localStorage.getItem('k2')")) === "v2-from-ai", ssl.ok ? ssl.value : ssl);
  const sss = await st("storage_set", { area: "session", key: "k3", value: "v3-from-ai" });
  check("on-ss-set", "storage_set(session) 生效", sss.ok && (await ev("sessionStorage.getItem('k3')")) === "v3-from-ai", sss.ok ? sss.value : sss);
  const srm = await st("storage_remove", { area: "local", key: "k2" });
  check("on-ls-remove", "storage_remove(local) 生效", srm.ok && srm.value.existed === true && (await ev("localStorage.getItem('k2')")) === null, srm.ok ? srm.value : srm);
  const cd = await st("cookies_delete", { name: "e2set" });
  check("on-cookie-delete", "cookies_delete 生效", cd.ok && cd.value.removed === 1 && !(await ev("document.cookie")).includes("e2set"), cd.ok ? cd.value : cd);

  // ── Flowship origin：无论如何读不到 / 动不了 ──
  const appJar = sess(T).activeTab.wc.session.cookies;
  await appJar.set({ url: `${appBase}/`, name: "appsecret", value: APP_SECRET });
  const seeded = await appJar.get({ name: "appsecret" });
  check("app-seeded", "（准备）Flowship origin 的 cookie 已种进 session jar", seeded.length === 1, seeded.length);
  const allList = await st("cookies_list", { all: true, reveal: true });
  check("app-excluded-all", "cookies_list all+reveal：结果里没有 Flowship origin 的 cookie（名字与明文都没有）", allList.ok && !allList.value.cookies.some((c) => c.name === "appsecret") && !JSON.stringify(allList.value).includes(APP_SECRET), allList.ok ? allList.value.cookies.map((c) => c.name) : allList);
  const appDom = await st("cookies_list", { domain: "app.localhost", reveal: true });
  check("app-domain-blocked", "cookies_list domain=app.localhost → URL_BLOCKED", !appDom.ok && appDom.code === "URL_BLOCKED", appDom.ok ? appDom.value : appDom.code);
  const appUrlList = await st("cookies_list", { url: `${appBase}/`, reveal: true });
  check("app-url-blocked", "cookies_list url=Flowship origin → URL_BLOCKED", !appUrlList.ok && appUrlList.code === "URL_BLOCKED", appUrlList.ok ? appUrlList.value : appUrlList.code);
  const appSet = await st("cookies_set", { name: "x", value: "y", domain: "app.localhost" });
  check("app-set-blocked", "cookies_set domain=app.localhost → URL_BLOCKED", !appSet.ok && appSet.code === "URL_BLOCKED", appSet.ok ? appSet.value : appSet.code);
  const appNav = await tryCall("navigate", { url: `${appBase}/` });
  check("app-navigate-blocked", "navigate 到 Flowship origin → URL_BLOCKED（storage 不会在那种页面上执行）", !appNav.ok && appNav.code === "URL_BLOCKED", appNav.ok ? appNav.value : appNav.code);
  const clearAll = await st("cookies_clear", { all: true });
  const appAfter = await appJar.get({ name: "appsecret" });
  check("app-survives-clear-all", "cookies_clear all 清掉了别的站点 cookie，Flowship origin 的 cookie 原封不动", clearAll.ok && appAfter.length === 1 && appAfter[0].value === APP_SECRET, clearAll.ok ? clearAll.value : clearAll);

  // 清空后重建登录态（export 需要有东西可导）
  await call("navigate", { url: `${base}/` }); // 服务端重新下发 sid / theme
  await waitFor(async () => (await ev("window.__ready")) === true);
  await st("cookies_set", { name: "e2keep", value: "keep-me-please-1" });
  await st("storage_set", { area: "local", key: "ls_keep", value: "LS-KEEP-VALUE-9" });

  // ── export_state：落盘位置 / 权限 / 文件名由主进程生成 ──
  const ex = await st("export_state");
  const exFile = ex.ok ? ex.value.file : "";
  const exPath = path.join(stateDir(T), exFile || "-");
  const exStat = ex.ok && fs.existsSync(exPath) ? fs.statSync(exPath) : null;
  check("export-ok", "export_state 写出 <taskDir>/browser-state/<主进程生成名>.json", ex.ok && /^state-\d{8}-\d{6}\.json$/.test(exFile) && exStat !== null, ex.ok ? ex.value : ex);
  if (process.platform !== "win32") {
    check("export-file-0600", "导出文件权限 0600", exStat && (exStat.mode & 0o777) === 0o600, exStat && (exStat.mode & 0o777).toString(8));
    check("export-dir-0700", "browser-state 目录权限 0700", (fs.statSync(stateDir(T)).mode & 0o777) === 0o700, (fs.statSync(stateDir(T)).mode & 0o777).toString(8));
  }
  const exJson = exStat ? JSON.parse(fs.readFileSync(exPath, "utf8")) : null;
  check("export-content", "导出内容含 cookie（sid / e2keep）与 localStorage（ls_keep），且没有 Flowship origin 的 cookie", exJson && JSON.stringify(exJson).includes(SID) && JSON.stringify(exJson).includes("e2keep") && JSON.stringify(exJson).includes("LS-KEEP-VALUE-9") && !JSON.stringify(exJson).includes(APP_SECRET));
  check("export-result-no-values", "export_state 返回给 AI 的结果里没有任何明文值", ex.ok && !JSON.stringify(ex.value).includes(SID) && !JSON.stringify(ex.value).includes("LS-KEEP-VALUE-9"));

  const exTrav = await st("export_state", { file: "../../../evil-escape" });
  const dirFiles = fs.readdirSync(stateDir(T));
  const escaped = [path.join(TMP, "evil-escape.json"), path.join(TMP, "data", "evil-escape.json"), path.join(TMP, "data", "tasks", "evil-escape.json"), path.join(TMP, "data", "tasks", T, "evil-escape.json")];
  check("export-traversal-sanitized", "export_state file=\"../../../evil-escape\"：只取末段、写进 browser-state 内，目录外没有任何文件", exTrav.ok && exTrav.value.file === "evil-escape.json" && dirFiles.includes("evil-escape.json") && escaped.every((p) => !fs.existsSync(p)), exTrav.ok ? exTrav.value.file : exTrav);
  const exOdd = await st("export_state", { file: "a b/..\\c:d*e?.json" });
  check("export-odd-name", "export_state 奇怪文件名被净化成安全字符集", exOdd.ok && /^[A-Za-z0-9._-]+\.json$/.test(exOdd.value.file), exOdd.ok ? exOdd.value.file : exOdd);

  // ── clear_site → 全空 → import_state 还原 ──
  const cl = await st("clear_site");
  const afterClear = await st("cookies_list");
  const lsAfter = await st("storage_list", { area: "local" });
  const idbAfter = await st("idb_list");
  check("clear-site", "clear_site 清掉当前站点的 cookie / localStorage / IndexedDB", cl.ok && afterClear.ok && afterClear.value.total === 0 && lsAfter.ok && lsAfter.value.total === 0 && idbAfter.ok && idbAfter.value.total === 0, { cl: cl.ok ? cl.value : cl, cookies: afterClear.ok && afterClear.value.total, ls: lsAfter.ok && lsAfter.value.total, idb: idbAfter.ok && idbAfter.value.total });
  check("clear-site-app-survives", "clear_site 不碰 Flowship origin 的 cookie", (await appJar.get({ name: "appsecret" })).length === 1);

  const imp = await st("import_state", { file: exFile });
  const sid2 = await st("cookies_get", { name: "sid", reveal: true });
  check("import-restores", "import_state 还原：cookie（HttpOnly sid 明文）与 localStorage（ls_keep）都回来了", imp.ok && imp.value.cookiesSet >= 3 && sid2.ok && sid2.value.cookies[0]?.value === SID && (await ev("localStorage.getItem('ls_keep')")) === "LS-KEEP-VALUE-9", imp.ok ? imp.value : imp);
  check("import-server-sees", "还原后服务端能看到 sid（真发出去了）", (await ev("fetch('/whoami').then(r => r.text())")).includes(`sid=${SID}`));

  // ── import_state：只读 browser-state；穿越 / 符号链接 / 恶意内容 一律拒绝 ──
  for (const [label, file] of [["../ 穿越", "../browser-state/" + exFile], ["绝对路径", "/etc/hosts"], ["反斜杠", "..\\" + exFile], ["不存在", "no-such-file"], ["空串", " "]]) {
    const r = await st("import_state", { file });
    check(`import-reject-${label}`, `import_state file=${JSON.stringify(file)}（${label}）被拒`, !r.ok && r.code === "BAD_ARGS", r.ok ? r.value : r.message);
  }
  fs.mkdirSync(stateDir(T), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir(T), "evil-app.json"), JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), cookies: [{ name: "pwn", value: "1", domain: "app.localhost", path: "/", secure: false, httpOnly: false, sameSite: "lax" }], origins: [] }), { mode: 0o600 });
  const evilImp = await st("import_state", { file: "evil-app" });
  const planted = await appJar.get({ name: "pwn" });
  check("import-reject-app-cookie", "导入文件含 Flowship origin 的 cookie → 整体拒绝，什么都没写", !evilImp.ok && evilImp.code === "BAD_ARGS" && planted.length === 0, evilImp.ok ? evilImp.value : evilImp.message);
  fs.writeFileSync(path.join(stateDir(T), "garbage.json"), "{not json", { mode: 0o600 });
  const garbageImp = await st("import_state", { file: "garbage" });
  check("import-reject-garbage", "导入文件不是合法 JSON → BAD_ARGS", !garbageImp.ok && garbageImp.code === "BAD_ARGS", garbageImp.ok ? garbageImp.value : garbageImp.message);
  if (process.platform !== "win32") {
    const outside = path.join(TMP, "outside-secret.json");
    fs.writeFileSync(outside, fs.readFileSync(exPath), { mode: 0o600 });
    fs.symlinkSync(outside, path.join(stateDir(T), "linked.json"));
    const linkImp = await st("import_state", { file: "linked" });
    check("import-reject-symlink", "browser-state 里的符号链接（指向目录外）被拒，不跟随", !linkImp.ok && linkImp.code === "BAD_ARGS", linkImp.ok ? linkImp.value : linkImp.message);
  }

  // ── 活动日志 / 状态里没有值 ──
  const logText = JSON.stringify(sess(T).activityLog.list());
  const stateText = JSON.stringify(sess(T).getState());
  const secrets = [SID, LS_VAL, SS_VAL, APP_SECRET, "LS-KEEP-VALUE-9", "hello-world-1", "http-only-val", "keep-me-please-1"];
  check("log-no-values", "活动日志与状态里没有任何 cookie / storage 值", secrets.every((s) => !logText.includes(s) && !stateText.includes(s)));
  check("log-has-ai-entries", "写 / 导出 / 导入都有活动日志（actor ai）", /导出了登录状态/.test(logText) && /导入了登录状态/.test(logText) && /清空了/.test(logText) && /写入了 cookie/.test(logText), sess(T).activityLog.list().filter((e) => e.actor === "ai").length);
  const revealLog = /读取了 \d+ 个 cookie 的明文值/.test(logText) && /读取了 1 项 localStorage 的明文值/.test(logText);
  check("log-reveal-noted", "读取明文值本身也写活动日志（「AI 读取了明文」，不含值）", revealLog);

  // ── 用户接管期间：写类 USER_CONTROL；读明文也拒 ──
  sess(T).controller = "user";
  const uc1 = await st("cookies_set", { name: "u", value: "v" });
  const uc2 = await st("cookies_get", { name: "sid", reveal: true });
  const uc3 = await st("cookies_list");
  sess(T).controller = "ai";
  check("takeover-write-blocked", "用户接管：cookies_set → USER_CONTROL", !uc1.ok && uc1.code === "USER_CONTROL", uc1.ok ? uc1.value : uc1.code);
  check("takeover-reveal-blocked", "用户接管：读明文 → USER_CONTROL", !uc2.ok && uc2.code === "USER_CONTROL", uc2.ok ? uc2.value : uc2.code);
  check("takeover-masked-ok", "用户接管：脱敏列表照常可读", uc3.ok);

  // ═══════════ A7 · network 响应体读取只看 networkBodyRead（与 evaluateEnabled 无关） ═══════════
  manager.onConfig({ evaluateEnabled: true, storageAccess: false });
  await call("navigate", { url: `${base}/` });
  // 页面里 fetch 一个带固定响应体的 JSON（紧接着读，Chromium 不会回收）；evaluate 这一步仍借 evaluateEnabled=true 跑，随后关掉验证两个开关互不借用
  await ev("fetch('/data.json', { cache: 'no-store' }).then(r => r.text())");
  manager.onConfig({ evaluateEnabled: false });
  const net = await tryCall("network", {});
  const entry = net.ok ? [...net.value.entries].reverse().find((e) => e.url.endsWith("/data.json")) : null;
  check("net-list", "network 列表能拿到 /data.json 请求（拿 id）", !!entry, net.ok ? net.value.entries.map((e) => e.url) : net);
  if (entry) {
    manager.onConfig({ networkBodyRead: false });
    const nb0 = await tryCall("network_detail", { id: entry.id, includeBody: true });
    check("net-body-off", "networkBodyRead 关（evaluateEnabled 也关）：include_body → ACCESS_DISABLED", !nb0.ok && nb0.code === "ACCESS_DISABLED", nb0.ok ? "ok" : nb0.code);
    const nd0 = await tryCall("network_detail", { id: entry.id });
    check("net-detail-nobody-ok", "networkBodyRead 关：不带 include_body 的详情照常给", nd0.ok);
    manager.onConfig({ networkBodyRead: true });
    const nb1 = await tryCall("network_detail", { id: entry.id, includeBody: true });
    check("net-body-on", "networkBodyRead 开（evaluateEnabled 仍关）：include_body 照旧返回", nb1.ok && JSON.stringify(nb1.value).includes("e2p3-body-marker"), nb1.ok ? { reason: nb1.value.bodyUnavailableReason, keys: Object.keys(nb1.value) } : nb1);
    manager.onConfig({ evaluateEnabled: true, networkBodyRead: false });
    const nb2 = await tryCall("network_detail", { id: entry.id, includeBody: true });
    check("net-body-off-eval-on", "evaluateEnabled 开但 networkBodyRead 关：include_body 仍被拒（两个开关互不借用）", !nb2.ok && nb2.code === "ACCESS_DISABLED", nb2.ok ? "ok" : nb2.code);
    manager.onConfig({ evaluateEnabled: false, networkBodyRead: true });
  }

  // ═══════════ A7 · evaluate 审批卡 ═══════════
  check("eval-gate-off", "（准备）evaluateEnabled 关", manager.getConfig().evaluateEnabled === false);
  // 表达式前 200 字清洗：含零宽 / 双向控制符 / 换行 / 超长
  const nasty = `/* \u202e\u200b\u0007 ${"A".repeat(300)} */ 40 + 2`;
  const evalP1 = callAs(T, "evaluate", { expression: nasty }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e?.code, message: String(e?.message ?? e) }));
  const pr1 = await waitFor(() => pendingEvaluatePrompt(T));
  check("eval-prompt-raised", "evaluateEnabled 关：evaluate 触发一条 evaluate 提示（状态 prompts 里可见）", !!pr1, pr1 && { id: pr1.id, actions: pr1.actions });
  const summary = pr1?.detail?.summary ?? "";
  check("eval-prompt-detail-clean", "提示 detail 只含 summary，且是前 200 字清洗后文本（无格式字符 / 控制符、≤201）", pr1 && Object.keys(pr1.detail).join() === "summary" && !/[\u202e\u200b\u0007\n]/.test(summary) && summary.length <= 201 && summary.endsWith("…") && summary.startsWith("/* "), { len: summary.length, head: summary.slice(0, 20) });
  check("eval-prompt-actions", "提示可选动作 = deny（默认）/ task / always", pr1 && pr1.actions.join() === "deny,task,always", pr1?.actions);
  check("eval-pending-not-run", "审批前表达式没有被执行（promise 仍挂着）", (await Promise.race([evalP1, sleep(150).then(() => "pending")])) === "pending");
  const ans = sess(T).prompts.answer(pr1.id, { action: "task" });
  const r1 = await evalP1;
  check("eval-task-approved", "answer task → 表达式执行，返回 42", ans === true && r1.ok && r1.v.value === 42, r1);
  check("eval-prompt-cleared", "回答后提示从状态里消失", !pendingEvaluatePrompt(T));
  const t0 = Date.now();
  const r2 = await tryCall("evaluate", { expression: "6 * 7" });
  check("eval-task-session-free", "本会话后续 evaluate 免提示直接执行", r2.ok && r2.value.value === 42 && !pendingEvaluatePrompt(T) && Date.now() - t0 < 1500, r2.ok ? r2.value : r2);
  check("eval-no-settings-event-for-task", "「仅本任务」不触发 settings_set 事件", !sent.some((m) => m.kind === "evt" && m.name === "settings_set"));
  check("eval-config-still-off", "「仅本任务」不改 evaluateEnabled", manager.getConfig().evaluateEnabled === false);

  // deny
  const T2 = "e2p3-task-deny";
  await callAs(T2, "navigate", { url: `${base}/p` });
  const evalP2 = tryAs(T2, "evaluate", { expression: "1 + 1" });
  const pr2 = await waitFor(() => pendingEvaluatePrompt(T2));
  sess(T2).prompts.answer(pr2.id, { action: "deny" });
  const r3 = await evalP2;
  check("eval-deny", "answer deny → DENIED", !r3.ok && r3.code === "DENIED", r3.ok ? r3.value : r3.code);
  const evalP2b = tryAs(T2, "evaluate", { expression: "1 + 1" });
  const pr2b = await waitFor(() => pendingEvaluatePrompt(T2));
  check("eval-deny-asks-again", "拒绝不会被记住：下一次 evaluate 重新弹提示", !!pr2b);
  sess(T2).prompts.answer(pr2b.id, { action: "deny" });
  await evalP2b;
  const bogus = sess(T2).prompts.answer("p9999", { action: "task" });
  const badAction = (() => {
    const p = tryAs(T2, "evaluate", { expression: "2" });
    return p;
  })();
  const pr2c = await waitFor(() => pendingEvaluatePrompt(T2));
  const badAns = sess(T2).prompts.answer(pr2c.id, { action: "allow-session" });
  check("eval-answer-invalid", "提示 id 不存在 / 动作不在允许集合 → 回答无效，提示仍挂起", bogus === false && badAns === false && !!pendingEvaluatePrompt(T2));
  sess(T2).prompts.answer(pr2c.id, { action: "deny" });
  await badAction;

  // 超时（注入的缩短常量）
  const T3 = "e2p3-task-timeout";
  await callAs(T3, "navigate", { url: `${base}/p` });
  const tt0 = Date.now();
  const r4 = await tryAs(T3, "evaluate", { expression: "1" });
  check("eval-timeout-denied", `无人处理 → ${EVAL_TIMEOUT}ms 后 DENIED（按拒绝处理）`, !r4.ok && r4.code === "DENIED" && Date.now() - tt0 >= EVAL_TIMEOUT - 100 && /没有在/.test(r4.message), { code: r4.code, ms: Date.now() - tt0, msg: r4.message });
  check("eval-timeout-prompt-gone", "超时后提示已从状态里移除", !pendingEvaluatePrompt(T3));

  // 任务被停止（signal）→ 提示作废
  const T3b = "e2p3-task-abort";
  await callAs(T3b, "navigate", { url: `${base}/p` });
  const ac = new AbortController();
  const evalAbort = tryAs(T3b, "evaluate", { expression: "1" }, ac.signal);
  await waitFor(() => pendingEvaluatePrompt(T3b));
  // 生产里 abort 的 reason 都是 BrowserError(CANCELLED)（server-channel / session.cancelWaits），这里照样用
  const { BrowserError } = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/server-channel.mjs")).href);
  ac.abort(new BrowserError("CANCELLED", "任务被停止"));
  const r5 = await evalAbort;
  check("eval-abort-clears-prompt", "任务被取消（signal）：evaluate 以 CANCELLED 结束，提示被撤掉", !r5.ok && /CANCELLED|DENIED/.test(String(r5.code)) && !pendingEvaluatePrompt(T3b), { code: r5.code, left: !!pendingEvaluatePrompt(T3b) });

  // always → settings_set 事件
  const T4 = "e2p3-task-always";
  await callAs(T4, "navigate", { url: `${base}/p` });
  const evalP4 = tryAs(T4, "evaluate", { expression: "'always-ok'" });
  const pr4 = await waitFor(() => pendingEvaluatePrompt(T4));
  sess(T4).prompts.answer(pr4.id, { action: "always" });
  const r6 = await evalP4;
  const evts = sent.filter((m) => m.kind === "evt" && m.name === "settings_set");
  check("eval-always-runs", "answer always → 本次执行", r6.ok && r6.value.value === "always-ok", r6);
  check("eval-always-event", "always → 发出 settings_set 事件，内容 = {key:browserEvaluateEnabled, value:true} 且 taskId 正确", evts.length === 1 && evts[0].taskId === T4 && evts[0].data.key === "browserEvaluateEnabled" && evts[0].data.value === true && Object.keys(evts[0].data).length === 2, evts);
  check("eval-always-no-direct-config", "主进程不自己改 config（落盘由 server 校验白名单后做，回写 syncConfig 才会变）", manager.getConfig().evaluateEnabled === false);
  // R6-04：「永久」不置会话标记，免审批只认实时总闸；总闸还没被 syncConfig 改成 true 时，下一次仍要重新审批
  const evalAfterP = tryAs(T4, "evaluate", { expression: "1+2" });
  const prAfter = await waitFor(() => pendingEvaluatePrompt(T4));
  sess(T4).prompts.answer(prAfter.id, { action: "deny" });
  const evalAfter = await evalAfterP;
  check("eval-always-no-session-mark", "R6-04：always 不置会话标记，总闸没变时下一次 evaluate 仍弹提示（拒绝 → DENIED）", !!prAfter && !evalAfter.ok && evalAfter.code === "DENIED", { code: evalAfter.code });

  // 总闸开 → 直接执行
  manager.onConfig({ evaluateEnabled: true });
  const T5 = "e2p3-task-open";
  await callAs(T5, "navigate", { url: `${base}/p` });
  const r7 = await tryAs(T5, "evaluate", { expression: "'direct'" });
  check("eval-config-on-direct", "evaluateEnabled 开：直接执行，不弹提示", r7.ok && r7.value.value === "direct" && !pendingEvaluatePrompt(T5), r7);

  // 审批是会话级：关掉会话再开要重新批准
  manager.onConfig({ evaluateEnabled: false });
  await callAs(T, "close_session");
  await callAs(T, "navigate", { url: `${base}/p` });
  const evalP6 = tryAs(T, "evaluate", { expression: "1" });
  const pr6 = await waitFor(() => pendingEvaluatePrompt(T));
  check("eval-approval-not-persisted", "会话销毁后批准失效：重开会话再 evaluate 又要审批", !!pr6);
  if (pr6) sess(T).prompts.answer(pr6.id, { action: "deny" });
  await evalP6;

  for (const t of [T, T2, T3, T3b, T4, T5]) await tryAs(t, "close_session");
  server.close();
  manager.destroy();

  const passed = results.filter((r) => r.ok).length;
  console.log(`E2P3 SUMMARY ${passed}/${results.length} passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(passed === results.length ? 0 : 1);
};

main().catch((err) => {
  console.error("E2P3 FATAL", err && err.stack ? err.stack : err);
  const passed = results.filter((r) => r.ok).length;
  console.log(`E2P3 SUMMARY ${passed}/${results.length} passed (FATAL)`);
  app.exit(1);
});
