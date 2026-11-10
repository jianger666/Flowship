"use strict";
/**
 * A 组最小冒烟：真实 Electron + 真实 CDP 下，navigate → snapshot → click / type / press_key / select / hover / scroll / drag
 * 通不通，以及遮挡 / 接管 / 新标签 / 密码不入日志这些关键边界。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/actions-smoke.cjs --timeout 90
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动（等价于 server 经 ipc 通道发 req），不依赖 main.js / preload。
 * 临时 userData、窗口 show:false、本地 http fixture（随机端口，仅 127.0.0.1）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-actions-smoke-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Smoke</title>
<style>
  body{font-family:sans-serif;margin:16px}
  .row{margin:10px 0}
  #cover{position:absolute;left:16px;top:560px;width:160px;height:40px;background:rgba(255,0,0,.4);z-index:10}
  #under{position:absolute;left:16px;top:560px;width:160px;height:40px}
  #dragbox{position:absolute;left:300px;top:560px;width:60px;height:40px;background:#f66;cursor:grab}
  #dropzone{position:absolute;left:560px;top:560px;width:120px;height:60px;background:#6f6}
</style></head><body>
<h1>Smoke</h1>
<div class="row"><button id="btn">提交</button></div>
<div class="row"><input id="txt" aria-label="用户名"></div>
<div class="row"><input id="pwd" type="password" aria-label="密码"></div>
<div class="row"><textarea id="ta" aria-label="备注">旧内容</textarea></div>
<div class="row"><select id="sel" aria-label="城市"><option value="bj">北京</option><option value="sh">上海</option></select></div>
<div class="row"><a id="lnk" href="/page2">去第二页</a> | <a id="blank" href="/page3" target="_blank">新窗口打开</a></div>
<div class="row"><div id="hov" role="button" tabindex="0" aria-label="悬停区" style="display:inline-block;padding:6px;border:1px solid #999">悬停区</div></div>
<div class="row"><label><input id="chk" type="checkbox"> 同意协议</label></div>
<button id="under">被盖住的按钮</button><div id="cover"></div>
<div id="dragbox" role="button" aria-label="拖块"></div><div id="dropzone" role="button" aria-label="放置区"></div>
<div style="height:3000px"></div>
<script>
window.__clicks=0; window.__hover=0; window.__enter=0; window.__underClicks=0; window.__dragMoves=0; window.__dragUp=null; window.__chg=0;
document.getElementById('btn').addEventListener('click',function(){window.__clicks++;});
document.getElementById('under').addEventListener('click',function(){window.__underClicks++;});
document.getElementById('hov').addEventListener('mouseover',function(){window.__hover++;});
document.getElementById('txt').addEventListener('keydown',function(e){if(e.key==='Enter')window.__enter++;});
document.getElementById('sel').addEventListener('change',function(){window.__chg++;});
var box=document.getElementById('dragbox'), down=false;
box.addEventListener('mousedown',function(){down=true;});
window.addEventListener('mousemove',function(e){if(down){window.__dragMoves++;box.style.left=(e.clientX-30)+'px';box.style.top=(e.clientY-20)+'px';}});
window.addEventListener('mouseup',function(e){if(down){down=false;window.__dragUp={x:e.clientX,y:e.clientY};}});
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/page2") return res.end('<!doctype html><title>Page2</title><h1>第二页</h1><button>回去</button>');
      if (p === "/page3") return res.end('<!doctype html><title>Page3</title><h1>第三页</h1>');
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

  const T = "smoke-task";
  const call = (op, args = {}, signal) => manager.dispatch(op, args, { taskId: T, signal });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
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
  const snapRef = async (name) => {
    const s = await call("snapshot", {});
    return { ref: refOf(s.text, name), snap: s };
  };

  // ── navigate / snapshot ──
  const nav = await call("navigate", { url: base + "/" });
  check("nav", "navigate 打开 fixture", nav.url.startsWith(base) && nav.status === 200 && nav.title === "Smoke", nav);
  const first = await call("snapshot", {});
  check("snap", "snapshot 拿到 ref 且含按钮 / 输入框", first.refCount >= 8 && !!refOf(first.text, "提交") && !!refOf(first.text, "用户名"), { refCount: first.refCount });

  // ── click ──
  let { ref } = await snapRef("提交");
  const c1 = await call("click", { ref });
  check("click", "click 按钮：页面收到 1 次点击、未导航", (await ev("window.__clicks")) === 1 && c1.navigated === false && c1.tabId === "t1", c1);
  check("ai-state", "动作后 controller=ai（8s 宽限内）", (await call("status")).controller === "ai");

  // ── type ──
  ({ ref } = await snapRef("用户名"));
  await call("type", { ref, text: "hello" });
  check("type", "type 输入文字", (await ev("document.getElementById('txt').value")) === "hello");
  await call("type", { ref, text: "world", clear: false });
  check("type-append", "clear:false 追加", (await ev("document.getElementById('txt').value")) === "helloworld");
  await call("type", { ref, text: "x" });
  check("type-clear", "默认先清空再输入", (await ev("document.getElementById('txt').value")) === "x");

  // R1-02：密码框拒绝 type（与 fill_form 同源文案，指向 browser_ask_user_to_act），值保持为空、不留日志
  ({ ref } = await snapRef("密码"));
  const pwdTry = await tryCall("type", { ref, text: "s3cret-PW" });
  check(
    "type-pwd-rejected",
    "密码框拒绝 type（BAD_ARGS + 指向 browser_ask_user_to_act），值保持为空",
    pwdTry.ok === false && pwdTry.code === "BAD_ARGS" && /browser_ask_user_to_act/.test(pwdTry.message ?? "") && (await ev("document.getElementById('pwd').value")) === "",
    pwdTry,
  );
  // R1-25：焦点在密码框时 press_key 拒绝单字符键；Enter 等功能键不受限
  await ev("document.getElementById('pwd').focus()");
  const pkTry = await tryCall("press_key", { key: "a" });
  check(
    "press-key-pwd-rejected",
    "焦点在密码框时 press_key 单字符被拒绝（值仍为空）",
    pkTry.ok === false && pkTry.code === "BAD_ARGS" && (await ev("document.getElementById('pwd').value")) === "",
    pkTry,
  );
  const pkEnter = await tryCall("press_key", { key: "Tab" });
  check("press-key-pwd-tab", "焦点在密码框时 Tab 仍可按", pkEnter.ok === true, pkEnter);

  ({ ref } = await snapRef("备注"));
  await call("type", { ref, text: "新内容" });
  check("type-textarea", "textarea 清空后输入", (await ev("document.getElementById('ta').value")) === "新内容");

  // 隐私：任何活动日志条目的摘要里都不得出现输入内容
  const sess = manager.getSession(T);
  const allSummaries = sess.activityLog.list().map((e) => e.summary).join("\n");
  check("privacy", "AI / 用户活动日志不含输入内容", !/s3cret|hello|world|新内容/.test(allSummaries), allSummaries.slice(0, 300));
  check("log-ai", "AI 动作进了日志（只写字符数）", /输入了 3 个字符/.test(allSummaries) && /点击了按钮「提交」/.test(allSummaries), allSummaries.slice(0, 400));

  // ── press_key ──
  ({ ref } = await snapRef("用户名"));
  await call("press_key", { key: "Control+a", ref });
  check("key-selectall", "Control+a 全选", (await ev("(function(){var e=document.getElementById('txt');return e.selectionStart===0&&e.selectionEnd===e.value.length&&e.value.length>0})()")) === true);
  await call("press_key", { key: "Backspace" });
  check("key-backspace", "Backspace 删掉选中内容", (await ev("document.getElementById('txt').value")) === "");
  await call("press_key", { key: "Enter", ref });
  check("key-enter", "Enter 触发 keydown", (await ev("window.__enter")) === 1);

  // ── select ──
  ({ ref } = await snapRef("城市"));
  await call("select", { ref, values: ["上海"] });
  check("select", "select 按文本选中并派发 change", (await ev("document.getElementById('sel').value")) === "sh" && (await ev("window.__chg")) === 1);
  const badSel = await tryCall("select", { ref, values: ["广州"] });
  check("select-missing", "找不到选项 → BAD_ARGS 并列出可选项", !badSel.ok && badSel.code === "BAD_ARGS" && /北京/.test(badSel.message), badSel);

  // ── hover ──
  ({ ref } = await snapRef("悬停区"));
  await call("hover", { ref });
  check("hover", "hover 触发 mouseover", (await ev("window.__hover")) >= 1);

  // ── checkbox（label 内的 input 点击） ──
  ({ ref } = await snapRef("同意协议"));
  await call("click", { ref });
  check("checkbox", "点击复选框", (await ev("document.getElementById('chk').checked")) === true);

  // ── 遮挡 ──
  ({ ref } = await snapRef("被盖住的按钮"));
  const covered = await tryCall("click", { ref });
  check("occluded", "被浮层盖住 → NOT_INTERACTABLE，且没点到底下的按钮", !covered.ok && covered.code === "NOT_INTERACTABLE" && (await ev("window.__underClicks")) === 0, covered);

  // ── drag（自定义鼠标拖拽） ──
  // 注意：必须一次 snapshot 取两个 ref（下一次 snapshot 会让旧 ref 全部失效）
  const dsnap = await call("snapshot", {});
  await call("drag", { fromRef: refOf(dsnap.text, "拖块"), toRef: refOf(dsnap.text, "放置区") });
  const dragUp = await ev("window.__dragUp");
  check("drag", "drag：分步 mousemove 并在目标附近抬起", (await ev("window.__dragMoves")) >= 5 && dragUp && Math.abs(dragUp.x - 620) < 40, { dragUp });

  // ── scroll ──
  const sc = await call("scroll", { direction: "down" });
  check("scroll-down", "scroll down 约 0.8 视口", sc.scroll.y > 100 && (await ev("window.scrollY")) === sc.scroll.y, sc.scroll);
  const top = await call("scroll", { direction: "top" });
  check("scroll-top", "scroll top 回到顶部", top.scroll.y === 0);
  const bottom = await call("scroll", { direction: "bottom" });
  check("scroll-bottom", "scroll bottom 到底", bottom.scroll.y > 1000, bottom.scroll);
  await call("scroll", { direction: "top" });

  // ── 新标签（target=_blank） ──
  ({ ref } = await snapRef("新窗口打开"));
  const nt = await call("click", { ref });
  check("new-tab", "target=_blank → newTabId=t2 且成为当前 tab", nt.newTabId === "t2" && (await call("tabs", { action: "list" })).activeTabId === "t2", nt);
  await call("tabs", { action: "select", tabId: "t1" });
  check("tab-select", "tabs select 切回 t1", (await call("tabs", { action: "list" })).activeTabId === "t1");
  await call("tabs", { action: "close", tabId: "t2" });

  // ── 点链接导航 ──
  ({ ref } = await snapRef("去第二页"));
  const stale = ref;
  const go = await call("click", { ref });
  check("click-nav", "点链接 → navigated:true、拿到新标题", go.navigated === true && go.title === "Page2" && go.url.endsWith("/page2"), go);
  const staleErr = await tryCall("click", { ref: stale });
  check("ref-stale", "导航后旧 ref → REF_STALE", !staleErr.ok && staleErr.code === "REF_STALE", staleErr);
  const back = await call("nav_history", { direction: "back" });
  check("history", "nav_history back", back.url.startsWith(base) && back.title === "Smoke", back);

  // ── 接管 → USER_CONTROL → 交还 ──
  sess.takeover();
  const blocked = await tryCall("click", { ref: (await snapRef("提交")).ref });
  check("user-control", "接管中 AI 动作 → USER_CONTROL", !blocked.ok && blocked.code === "USER_CONTROL", blocked);
  sess.handback("好了");
  const again = await tryCall("click", { ref: (await snapRef("提交")).ref });
  check("handback", "交还后 AI 动作恢复", again.ok === true, again);

  // ── attach 到主窗口后动作仍然可用 ──
  sess.attach({ x: 0, y: 0, width: 900, height: 600 });
  await sleep(200);
  const before = await ev("window.__clicks");
  await call("click", { ref: (await snapRef("提交")).ref });
  check("attached-click", "视图搬到主窗口后 click 仍生效", (await ev("window.__clicks")) === before + 1 && sess.getState().attached === true);
  sess.detach();

  // ── 截图 ──
  const shot = await call("screenshot", {});
  check("screenshot", "screenshot 返回 jpeg base64", shot.mimeType === "image/jpeg" && shot.dataBase64.length > 1000 && shot.width > 0, { w: shot.width, h: shot.height });

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
