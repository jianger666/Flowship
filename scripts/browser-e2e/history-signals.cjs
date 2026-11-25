"use strict";
/**
 * 地址栏记忆依赖的两个主进程信号的真机 e2e（真实 Electron 42 + 真实 CDP + 真实 session）。
 *
 * 渲染侧决定「用户敲的网址有没有成功打开、记不记」只能看到两样东西（src/components/browser/typed-visit.ts 的判定表就建立在它们之上）：
 *   - `browser:navigate` 的回复带 { url, kind }：实际去的地址 / 是网址还是搜索词；被拒绝的不带；
 *   - 标签状态（TabInfo）里的 `loadFailed`：只有「主 frame 加载失败」的错误页才为真（连接被拒 / DNS 失败…），
 *     成功 / 404 / 重定向 / 下载都不带它——这是渲染侧唯一能分出「打开了」与「打不开」的信号（失败后 url 仍是敲的地址、loading 也变回 false）。
 * 这里在真实 Chromium 下把判定表依赖的每种导航结果的状态都钉一遍（单测里的状态是照着这些实测值写的；Electron 升级后行为变了会在这里红）：
 *   打开了 / 404 / 重定向 / 连接被拒（含重敲同一个失败地址）/ 失败后再打开别的地址（loadFailed 被清掉）/ 下载（url 不变）/ 页面挂着不返回的子资源（url 已变、loading 一直为真）。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/history-signals.cjs --timeout 120
 *
 * 临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口；「连接被拒」用一个刚释放的随机端口，不碰外网）；
 * 不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-history-signals-"));
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
const waitFor = async (fn, ms = 8000, step = 100) => {
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

/** 找一个当下没人监听的本机端口（先占住再释放）：连它 = 连接被拒，不依赖外网 / DNS / 代理 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const main = async () => {
  await app.whenReady();
  const hanging = new Set();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (p === "/") return res.end("<!doctype html><title>Home Page</title>home");
    if (p === "/missing") {
      res.statusCode = 404;
      return res.end("<!doctype html><title>Missing Page</title>nope");
    }
    if (p === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "/");
      return res.end();
    }
    if (p === "/download") {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="a.bin"');
      return res.end("binary");
    }
    // 页面本身很快就提交了（有 <title>），但带一个永远不返回的子资源：加载一直没结束
    if (p === "/hang") return res.end('<!doctype html><title>Hang Page</title>hang<img src="/never">');
    if (p === "/never") {
      hanging.add(res);
      res.on("close", () => hanging.delete(res));
      return; // 不回、不关：这个请求一直挂着
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
  const DEAD = `http://127.0.0.1:${await freePort()}/`;

  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);

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

  const U = "e2e-hist-1";
  /** 渲染侧看到的活动标签（getState 返回的就是推送给渲染侧的那份 TabInfo） */
  const activeTab = async () => {
    const st = await ipcCall("browser:getState", U);
    return st && st.tabs ? (st.tabs.find((t) => t.isActive) ?? st.tabs[0] ?? null) : null;
  };
  /** 等标签满足条件（条件拿到的是最新的标签状态），返回满足时的标签状态；超时返回 null */
  const settle = (pred, ms = 10000) =>
    waitFor(async () => {
      const t = await activeTab();
      return t && pred(t) ? t : null;
    }, ms);
  const brief = (t) => t && { url: t.url, title: t.title, loading: t.loading, loadFailed: t.loadFailed };

  // ───────── navigate 的回复 ─────────
  const bare = `127.0.0.1:${new URL(ORIGIN).port}/`; // 没带协议：主进程补 http://（回环地址），回复里要是补全后的地址
  const replyUrl = await ipcCall("browser:navigate", U, bare);
  check(
    "reply-url",
    "敲网址（没带协议）：回复 { ok:true, url: 补全后的实际地址, kind:'url' }",
    replyUrl && replyUrl.ok === true && replyUrl.url === `${ORIGIN}/` && replyUrl.kind === "url" && Object.keys(replyUrl).sort().join() === "kind,ok,url",
    replyUrl,
  );

  const replyBad = await ipcCall("browser:navigate", U, "file:///etc/hosts");
  check(
    "reply-rejected",
    "被 URL 策略拒绝（file:）：{ ok:false, error }，不带 url / kind（渲染侧据此判断没有可记的地址）",
    replyBad && replyBad.ok === false && typeof replyBad.error === "string" && !("url" in replyBad) && !("kind" in replyBad),
    replyBad,
  );

  // ───────── 各种导航结果下渲染侧看到的标签状态 ─────────
  const ok = await settle((t) => t.url === `${ORIGIN}/` && !t.loading && t.title === "Home Page");
  check("state-success", "打开了：url = 敲的地址、loading=false、title 是页面标题，没有 loadFailed 字段", !!ok && !("loadFailed" in ok), brief(ok));

  await ipcCall("browser:navigate", U, `${ORIGIN}/missing`);
  const missing = await settle((t) => t.url === `${ORIGIN}/missing` && !t.loading);
  check(
    "state-404",
    "HTTP 404 页面也是「打开了」：url = 敲的地址、title 是 404 页面的标题、没有 loadFailed（Chrome 同样会记这种地址）",
    !!missing && missing.title === "Missing Page" && !("loadFailed" in missing),
    brief(missing),
  );

  await ipcCall("browser:navigate", U, `${ORIGIN}/redirect`);
  const redirected = await settle((t) => t.url === `${ORIGIN}/` && !t.loading && t.title === "Home Page");
  check("state-redirect", "重定向：url = 最终地址（≠ 敲的 /redirect）、没有 loadFailed", !!redirected && !("loadFailed" in redirected), brief(redirected));

  await ipcCall("browser:navigate", U, DEAD);
  const refused = await settle((t) => t.loadFailed === true && !t.loading);
  check(
    "state-refused",
    "连接被拒：loadFailed=true、loading 回到 false（光看 url / loading 分不出成败，所以必须有这个字段）",
    !!refused && refused.loadFailed === true && refused.loading === false,
    brief(refused),
  );

  await ipcCall("browser:navigate", U, DEAD);
  await sleep(300);
  const refusedAgain = await settle((t) => t.loadFailed === true && !t.loading);
  check("state-refused-retype", "重敲同一个失败地址：这次也失败，最终仍是 loadFailed=true、loading=false", !!refusedAgain && refusedAgain.loadFailed === true, brief(refusedAgain));

  await ipcCall("browser:navigate", U, `${ORIGIN}/`);
  const recovered = await settle((t) => t.url === `${ORIGIN}/` && !t.loading && t.title === "Home Page");
  check("state-recovered", "失败之后打开了别的地址：loadFailed 被清掉（不会把上一次的失败带到新页面上）", !!recovered && !("loadFailed" in recovered), brief(recovered));

  // 失败的页面上敲一个能打开的地址 → 能打开；同一个地址在失败后立刻重敲、这回服务起来了 = 成功（loadFailed 随新导航清掉）
  await ipcCall("browser:navigate", U, DEAD);
  await settle((t) => t.loadFailed === true && !t.loading);
  const deadPort = new URL(DEAD).port;
  const revive = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>Back Online</title>up");
  });
  const reviveListening = await new Promise((resolve) => {
    revive.once("error", () => resolve(false)); // 端口被别的进程抢了：这条用例不成立，如实标记
    revive.listen(Number(deadPort), "127.0.0.1", () => resolve(true));
  });
  if (reviveListening) {
    await ipcCall("browser:navigate", U, DEAD);
    const back = await settle((t) => t.url === DEAD && !t.loading && t.title === "Back Online");
    check("state-retype-revived", "重敲刚才失败的地址、这回服务起来了：loadFailed 清掉，title 是页面标题", !!back && !("loadFailed" in back), brief(back));
    revive.closeAllConnections?.();
    await new Promise((r) => revive.close(r));
  } else {
    check("state-retype-revived", "（端口被占用，跳过）重敲刚才失败的地址、这回服务起来了", true, { skipped: true });
  }

  // ───────── 下载：url 不变、没有 loadFailed ─────────
  await ipcCall("browser:navigate", U, `${ORIGIN}/`);
  const beforeDl = await settle((t) => t.url === `${ORIGIN}/` && !t.loading && t.title === "Home Page");
  await ipcCall("browser:navigate", U, `${ORIGIN}/download`);
  await sleep(2000);
  const afterDl = await activeTab();
  check(
    "state-download",
    "敲的是附件直链：变成下载，标签仍停在出发的页面（url 没变、loading=false、没有 loadFailed）——渲染侧据此「等到超时作废」而不是记下它",
    !!beforeDl && !!afterDl && afterDl.url === beforeDl.url && afterDl.loading === false && !("loadFailed" in afterDl),
    { before: brief(beforeDl), after: brief(afterDl) },
  );

  // ───────── 页面挂着不返回的子资源 ─────────
  await ipcCall("browser:navigate", U, `${ORIGIN}/hang`);
  const committed = await settle((t) => t.url === `${ORIGIN}/hang` && t.title === "Hang Page");
  await sleep(2500);
  const stillLoading = await activeTab();
  check(
    "state-hanging-subresource",
    "页面已提交（url / title 都是新页面）但带一个永远不返回的子资源：loading 一直为 true、没有 loadFailed——渲染侧靠「宽限时间」把它按已打开算",
    !!committed && !!stillLoading && stillLoading.url === `${ORIGIN}/hang` && stillLoading.loading === true && !("loadFailed" in stillLoading) && hanging.size >= 1,
    { committed: brief(committed), later: brief(stillLoading), hangingRequests: hanging.size },
  );

  // 收尾：离开挂着的页面（停掉那个加载），再关掉挂着的连接
  await ipcCall("browser:navigate", U, `${ORIGIN}/`);
  await settle((t) => t.url === `${ORIGIN}/` && !t.loading);
  for (const res of hanging) res.destroy();

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
