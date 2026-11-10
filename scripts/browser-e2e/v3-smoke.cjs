"use strict";
/**
 * V3 上传下载冒烟：真实 Electron + 真实 CDP 下验证
 *   - 下载：Content-Disposition 下载落盘（下载目录被 app.setPath 重定向到临时目录）、登记表状态变化
 *     （progressing → completed）、`downloads` 的 list / wait / sinceId（含「点击晚于 wait 调用」的宽限）/ timedOut / signal 打断、
 *     同名自动加序号、url 去 query、状态里带 downloads、活动日志只记文件名；
 *   - 上传：路径 A（ref 直接是 input[type=file]，单选 / 多选 / 单选传多个被拒）与路径 B（按钮点击后由 JS 触发 input.click()，
 *     走 Page.setInterceptFileChooserDialog + Page.fileChooserOpened），都读回 input.files 的名字和大小；
 *   - 主进程黑名单：.env / 私钥 / ~/.ssh 风格目录 / ../ 越界 / 不存在 / Flowship 数据目录；无会话时的语义；非上传按钮 5 秒后给明确错误。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/v3-smoke.cjs --timeout 120
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动（等价于 server 经 ipc 通道发 req）。
 * 临时 userData / 临时下载目录、窗口 show:false、本地 http fixture（随机端口，仅 127.0.0.1）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-v3-smoke-"));
const USERDATA = path.join(TMP, "userdata");
const DL = path.join(TMP, "downloads");
const UP = path.join(TMP, "uploads");
for (const d of [USERDATA, DL, UP]) fs.mkdirSync(d, { recursive: true });
app.setPath("userData", USERDATA);
// 下载目录重定向到临时目录：will-download 里用的是 app.getPath("downloads")
app.setPath("downloads", DL);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>V3</title></head><body>
<h1>V3 上传下载</h1>
<p><a id="dl" href="/file.bin?token=SECRET#frag">下载报告</a> | <a id="dlslow" href="/slow.bin">慢速下载</a> | <a id="dlhang" href="/hang.bin">永不结束的下载</a></p>
<p><input id="file" type="file" aria-label="单选文件输入"></p>
<p><input id="multi" type="file" multiple aria-label="多选文件输入"></p>
<p><input id="hf" type="file" hidden><button id="pick" aria-label="选择文件按钮" onclick="document.getElementById('hf').click()">选择文件</button></p>
<p><button id="plain" aria-label="普通按钮">普通按钮</button></p>
<p><button id="dllate" onclick="setTimeout(function(){ document.getElementById('dl').click(); }, 1200)">点击后延迟下载</button></p>
<script>
window.__changes = [];
['file','multi','hf'].forEach(function (id) {
  document.getElementById(id).addEventListener('change', function () { window.__changes.push(id); });
});
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/file.bin") {
        const body = Buffer.alloc(2048, 65);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="report.txt"',
          "content-length": body.length,
        });
        return res.end(body);
      }
      if (p === "/slow.bin") {
        // 8 块 × 250ms ≈ 2s：足够在 click 返回后观察到 progressing
        const chunk = Buffer.alloc(512, 66);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="slow.dat"',
          "content-length": chunk.length * 8,
        });
        let n = 0;
        const t = setInterval(() => {
          res.write(chunk);
          if (++n >= 8) {
            clearInterval(t);
            res.end();
          }
        }, 250);
        res.on("close", () => clearInterval(t));
        return;
      }
      if (p === "/hang.bin") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="hang.dat"',
          "content-length": 100000,
        });
        res.write(Buffer.alloc(1000, 67)); // 发一点就不再发：下载一直 progressing
        return;
      }
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
    isAppUrl: (u) => /:9\//.test(u), // 假的「应用端口」9：fixture 的随机端口不会被拦
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  manager.onConfig({ evaluateEnabled: true });

  const T = "v3-task";
  const call = (op, args = {}, signal, taskId = T) => manager.dispatch(op, args, { taskId, signal });
  const tryCall = async (op, args, taskId) => {
    try {
      return { ok: true, value: await call(op, args, undefined, taskId) };
    } catch (e) {
      return { ok: false, code: e?.code, message: String(e?.message ?? e) };
    }
  };
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
  const refFor = async (name) => refOf((await call("snapshot", {})).text, name);
  const listDl = async () => (await call("downloads", { action: "list" })).downloads;

  // ── 没有会话：downloads 不建会话、upload 报 NO_SESSION ──
  const NS = "no-session-task";
  const nsList = await tryCall("downloads", { action: "list" }, NS);
  check("no-session-downloads", "无会话时 downloads list 返回空且不建会话", nsList.ok && nsList.value.downloads.length === 0 && manager.getSession(NS) === undefined, nsList);
  const nsUp = await tryCall("upload", { ref: "e1", paths: [path.join(UP, "x.txt")] }, NS);
  check("no-session-upload", "无会话时 upload → NO_SESSION", !nsUp.ok && nsUp.code === "NO_SESSION", nsUp);

  const nav = await call("navigate", { url: base + "/" });
  check("nav", "navigate 打开 fixture", nav.url.startsWith(base) && nav.title === "V3", nav);

  // ── 下载 ──
  const t0 = Date.now();
  const emptyWait = await call("downloads", { action: "wait", timeoutMs: 5000 });
  check("dl-empty-wait", "没有下载也没在途：wait 立即返回 {downloads:[],timedOut:false}", emptyWait.downloads.length === 0 && emptyWait.timedOut === false && Date.now() - t0 < 1500, emptyWait);

  // 小文件在 click 返回前就下完了：不带 sinceId 的 wait 只等「在途的」，所以这里用 sinceId=0（契约语义）
  await call("click", { ref: await refFor("下载报告") });
  const afterFirst = await call("downloads", { action: "wait", sinceId: 0, timeoutMs: 10_000 });
  const d1 = afterFirst.downloads[0];
  check("dl-completed", "下载完成：wait 返回 completed、不是 timedOut", afterFirst.timedOut === false && d1 && d1.state === "completed", d1);
  const d1Path = d1 && d1.path;
  check(
    "dl-file",
    "文件落在重定向后的下载目录，名字取自 Content-Disposition，大小 2048",
    !!d1Path && path.dirname(d1Path) === DL && path.basename(d1Path) === "report.txt" && fs.existsSync(d1Path) && fs.statSync(d1Path).size === 2048 && d1.receivedBytes === 2048 && d1.totalBytes === 2048,
    { path: d1Path, bytes: d1 && d1.receivedBytes },
  );
  check("dl-url", "登记表的 url 去掉了 query / hash", !!d1 && d1.url === base + "/file.bin" && !/SECRET|frag/.test(d1.url), d1 && d1.url);
  check("dl-tab", "登记表带 tabId、startedAt、endedAt", !!d1 && d1.tabId === "t1" && d1.startedAt > 0 && d1.endedAt >= d1.startedAt, d1);

  // 同名下载 → 自动加序号
  const since1 = d1.id;
  await call("click", { ref: await refFor("下载报告") });
  const second = await call("downloads", { action: "wait", sinceId: since1, timeoutMs: 10_000 });
  check("dl-uniq", "同名下载自动加序号 report (1).txt", second.downloads.length === 1 && path.basename(second.downloads[0].path) === "report (1).txt" && second.downloads[0].state === "completed", second.downloads.map((d) => path.basename(d.path)));

  // 慢速下载：先观察到 progressing，再 wait 到 completed
  const since2 = (await listDl())[0].id;
  await call("click", { ref: await refFor("慢速下载") });
  const midList = await listDl();
  const mid = midList[0];
  check("dl-progressing", "慢速下载中途 list 看到 progressing（最新在前）", mid && mid.id > since2 && mid.state === "progressing", mid);
  const midState = manager.getSession(T).getState();
  check("dl-state-push", "BrowserState.downloads 带最近下载、最新在前、≤10 条", Array.isArray(midState.downloads) && midState.downloads[0].id === mid.id && midState.downloads.length <= 10, midState.downloads.map((d) => d.id));
  // 不带 sinceId：等「当前在途的」下载结束
  const slowDone = await call("downloads", { action: "wait", timeoutMs: 15_000 });
  const slow = slowDone.downloads[0];
  check("dl-wait-slow", "wait（无 sinceId）等在途的慢速下载完成，大小 4096", slowDone.timedOut === false && slowDone.downloads.length === 1 && slow && slow.id === mid.id && slow.state === "completed" && slow.receivedBytes === 4096 && fs.statSync(slow.path).size === 4096, slow);

  // 下载晚于 wait 调用：宽限内下载冒出来，wait 仍能等到它。
  // 评审 R1-10：下载必须带用户手势才放行，所以这里用「AI 点击按钮 → 按钮 1.2 秒后由脚本触发下载」
  // （手势在点击时产生、5 秒内有效）；原先 evaluate 里裸 setTimeout 触发的下载没有手势，现在会被拦
  const since3 = slow.id;
  await call("click", { ref: await refFor("点击后延迟下载") });
  const t1 = Date.now();
  const late = await call("downloads", { action: "wait", sinceId: since3, timeoutMs: 15_000 });
  check("dl-wait-grace", "sinceId + 下载晚于 wait：宽限内等到它并返回 completed", late.downloads.length === 1 && late.downloads[0].state === "completed" && late.timedOut === false && Date.now() - t1 >= 300, { n: late.downloads.length, ms: Date.now() - t1 });

  // sinceId 之后没有新下载：宽限后返回空
  const t2 = Date.now();
  const none = await call("downloads", { action: "wait", sinceId: late.downloads[0].id, timeoutMs: 10_000 });
  check("dl-wait-none", "sinceId 之后没有新下载：宽限后返回空，不算超时", none.downloads.length === 0 && none.timedOut === false && Date.now() - t2 < 4000, { ms: Date.now() - t2 });

  // 永不结束的下载：timedOut / signal 打断
  const since4 = (await listDl())[0].id;
  await call("click", { ref: await refFor("永不结束的下载") });
  const timed = await call("downloads", { action: "wait", sinceId: since4, timeoutMs: 1000 });
  check("dl-timeout", "到点仍在途 → timedOut:true，返回 progressing 快照", timed.timedOut === true && timed.downloads.length === 1 && timed.downloads[0].state === "progressing", timed);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("测试取消")), 200);
  const aborted = await call("downloads", { action: "wait", sinceId: since4, timeoutMs: 60_000 }, ac.signal).then(
    () => ({ ok: true }),
    (e) => ({ ok: false, message: String(e?.message ?? e) }),
  );
  check("dl-abort", "wait 能被 signal 打断（不等满 60 秒）", aborted.ok === false && /测试取消/.test(aborted.message), aborted);

  const logs = manager.getSession(T).activityLog.recent(60);
  const dlLogs = logs.filter((e) => e.kind === "download");
  check("dl-log", "活动日志有下载条目且只记文件名（不含目录 / url token）", dlLogs.some((e) => /下载完成：report\.txt/.test(e.summary)) && !dlLogs.some((e) => e.summary.includes(DL) || /SECRET/.test(e.summary)), dlLogs.map((e) => e.summary).slice(0, 4));

  // ── 上传 ──
  const f1 = path.join(UP, "说明 文档.txt");
  const f2 = path.join(UP, "图片.png");
  fs.writeFileSync(f1, "0123456789");
  fs.writeFileSync(f2, Buffer.alloc(300, 1));
  const readBack = (id) => ev(`Array.from(document.getElementById('${id}').files).map(function(f){return {name:f.name,size:f.size}})`);

  // 路径 A：ref 直接是 input[type=file]
  const refSingle = await refFor("单选文件输入");
  check("up-ref", "snapshot 里能找到文件输入框的 ref", !!refSingle, refSingle);
  const upA = await call("upload", { ref: refSingle, paths: [f1] });
  const backA = await readBack("file");
  check("up-direct", "路径 A：直接塞文件，读回 input.files 名字与大小一致", JSON.stringify(backA) === JSON.stringify([{ name: "说明 文档.txt", size: 10 }]), backA);
  check("up-result", "结果 files 与页面读回一致、无 navigated", JSON.stringify(upA.files) === JSON.stringify([{ name: "说明 文档.txt", size: 10 }]) && upA.navigated === false && upA.tabId === "t1", upA);
  check("up-change", "页面收到 change 事件", (await ev("window.__changes.indexOf('file') >= 0")) === true);

  const tooMany = await tryCall("upload", { ref: refSingle, paths: [f1, f2] });
  check("up-single-many", "单选输入框传 2 个文件 → BAD_ARGS 并说明", !tooMany.ok && tooMany.code === "BAD_ARGS" && /只接受 1 个文件/.test(tooMany.message), tooMany);

  const refMulti = await refFor("多选文件输入");
  const upMulti = await call("upload", { ref: refMulti, paths: [f1, f2] });
  const backMulti = await readBack("multi");
  check("up-multi", "多选输入框 2 个文件，读回名字与大小一致", JSON.stringify(backMulti) === JSON.stringify([{ name: "说明 文档.txt", size: 10 }, { name: "图片.png", size: 300 }]) && upMulti.files.length === 2, backMulti);

  // 路径 B：按钮 → JS 触发 hidden input.click() → fileChooserOpened
  const refBtn = await refFor("选择文件按钮");
  const upB = await call("upload", { ref: refBtn, paths: [f2] });
  const backB = await readBack("hf");
  check("up-chooser", "路径 B：点击按钮拦截文件选择框并塞文件，读回 hidden input.files", JSON.stringify(backB) === JSON.stringify([{ name: "图片.png", size: 300 }]) && upB.files.length === 1, { backB, upB });
  check("up-change-hidden", "路径 B 页面同样收到 change 事件", (await ev("window.__changes.indexOf('hf') >= 0")) === true);

  // 活动日志只记文件名
  const upLogs = manager.getSession(T).activityLog.recent(80).filter((e) => e.actor === "ai" && /上传了/.test(e.summary));
  check(
    "up-log",
    "活动日志有 AI 的上传条目，只含文件名、不含目录",
    upLogs.length >= 3 && upLogs.some((e) => e.summary.includes("说明 文档.txt")) && !upLogs.some((e) => e.summary.includes(UP) || e.summary.includes(TMP)),
    upLogs.map((e) => e.summary),
  );

  // ── 主进程黑名单 / 形状 ──
  const sshDir = path.join(UP, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(path.join(sshDir, "id_rsa"), "PRIVATE");
  fs.writeFileSync(path.join(UP, ".env"), "SECRET=1");
  fs.symlinkSync(path.join(sshDir, "id_rsa"), path.join(UP, "innocent.txt"));
  fs.mkdirSync(path.join(USERDATA, "data"), { recursive: true });
  fs.writeFileSync(path.join(USERDATA, "data", "config.json"), "{}");
  const deny = async (id, name, paths, re) => {
    const r = await tryCall("upload", { ref: refSingle, paths });
    check(id, name, !r.ok && r.code === "BAD_ARGS" && re.test(r.message), r);
  };
  await deny("deny-env", "主进程拒绝 .env", [path.join(UP, ".env")], /安全|凭据/);
  await deny("deny-ssh", "主进程拒绝 .ssh 目录里的文件", [path.join(sshDir, "id_rsa")], /\.ssh|安全/);
  await deny("deny-symlink", "主进程拒绝指向 .ssh 的符号链接", [path.join(UP, "innocent.txt")], /符号链接|\.ssh/);
  await deny("deny-userdata", "主进程拒绝 Flowship 数据目录里的文件", [path.join(USERDATA, "data", "config.json")], /数据目录/);
  await deny("deny-dotdot", "主进程拒绝 ../ 越界", [`${UP}/../uploads/图片.png`], /\.\./);
  await deny("deny-missing", "主进程拒绝不存在的文件", [path.join(UP, "不存在.txt")], /不存在/);
  await deny("deny-dir", "主进程拒绝目录", [UP], /不是普通文件/);
  await deny("deny-relative", "主进程拒绝相对路径", ["图片.png"], /绝对路径/);
  check("deny-no-effect", "被拒绝的上传没有改动页面：单选输入框仍是之前那一个文件", JSON.stringify(await readBack("file")) === JSON.stringify([{ name: "说明 文档.txt", size: 10 }]));

  // 参数规整
  const badArgs = await tryCall("upload", { ref: refSingle, paths: [] });
  check("bad-args", "paths 为空 → BAD_ARGS", !badArgs.ok && badArgs.code === "BAD_ARGS", badArgs);

  // 非上传按钮：点了不会弹文件选择框 → 5 秒后给明确错误，且之后上传路径仍然可用（拦截已关闭、状态已复位）
  const refPlain = await refFor("普通按钮");
  const t3 = Date.now();
  const notUp = await tryCall("upload", { ref: refPlain, paths: [f1] });
  check("up-not-uploader", "点非上传按钮：约 5 秒后 NOT_INTERACTABLE 并给出自修复提示", !notUp.ok && notUp.code === "NOT_INTERACTABLE" && /文件选择框/.test(notUp.message) && Date.now() - t3 >= 4500, { code: notUp.code, ms: Date.now() - t3 });
  const again = await call("upload", { ref: await refFor("选择文件按钮"), paths: [f1] });
  check("up-after-fail", "失败后再走路径 B 仍然成功（拦截被正确关闭 / 复位）", again.files.length === 1 && JSON.stringify(await readBack("hf")) === JSON.stringify([{ name: "说明 文档.txt", size: 10 }]), again);

  manager.destroy();
  server.closeAllConnections?.();
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
