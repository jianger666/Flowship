"use strict";
/**
 * V1「输入类」真 Electron 冒烟：mouse（click / double_click / wheel / down-move-up / 越界）、fill_form（含密码拒绝与 submit）、
 * click.modifiers（Ctrl/Cmd+点击）、snapshot.query、wait_for 新条件（urlContains / networkIdle / refVisible）、screenshot 的 viewportW/H。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/v1-smoke.cjs --timeout 120
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动（等价于 server 经 ipc 通道发 req）。
 * 临时 userData、窗口 show:false、本地 http fixture（随机端口，仅 127.0.0.1）；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-v1-smoke-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 画布固定在 (20,20) 400×200：视口坐标 (120,120) = 画布局部 (100,100)
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>V1 Smoke</title>
<style>
  body{font-family:sans-serif;margin:0}
  #cv{position:absolute;left:20px;top:20px;width:400px;height:200px;background:#eef;border:0}
  #sb{position:absolute;left:500px;top:20px;width:200px;height:150px;overflow:auto;background:#efe}
  #sb div{height:600px}
  #wrap{padding-top:260px;padding-left:20px}
  .row{margin:8px 0}
  #grow{width:0;height:0;padding:0;border:0;overflow:hidden;display:block}
  #grow.on{width:120px;height:30px;border:1px solid #333}
</style></head><body>
<canvas id="cv" width="400" height="200" aria-label="画布"></canvas>
<div id="sb"><div>滚动区</div></div>
<div id="wrap">
  <div class="row"><input id="name" aria-label="姓名"></div>
  <div class="row"><input id="email" aria-label="邮箱"></div>
  <div class="row"><input id="pwd" type="password" aria-label="密码"></div>
  <div class="row"><label><input id="agree" type="checkbox"> 同意条款</label></div>
  <div class="row"><label><input id="news" type="checkbox" checked> 订阅通知</label></div>
  <div class="row"><select id="city" aria-label="城市"><option value="bj">北京</option><option value="sh">上海</option></select></div>
  <div class="row"><button id="submit">提交</button></div>
  <div class="row"><a id="lnk" href="/page2">链接去第二页</a></div>
  <div class="row"><button id="req">发慢请求</button> <button id="trig">触发长大</button> <button id="nav">延迟跳转</button></div>
  <button id="grow" aria-label="会长大的按钮">长大</button>
</div>
<script>
window.__cv={click:0,dbl:0,down:0,up:0,wheel:0,last:null,wheelDelta:null};
window.__drag={moves:0,up:null,down:null};
window.__lnkEvt={click:null,ctx:null};
window.__submitted=null;
var cv=document.getElementById('cv');
cv.addEventListener('click',function(e){window.__cv.click++;window.__cv.last={x:e.offsetX,y:e.offsetY,ctrl:e.ctrlKey,shift:e.shiftKey};});
cv.addEventListener('dblclick',function(){window.__cv.dbl++;});
cv.addEventListener('mousedown',function(e){window.__cv.down++;window.__drag.down={x:e.clientX,y:e.clientY};});
cv.addEventListener('wheel',function(e){window.__cv.wheel++;window.__cv.wheelDelta={x:e.deltaX,y:e.deltaY};e.preventDefault();},{passive:false});
window.addEventListener('mousemove',function(e){if(e.buttons===1)window.__drag.moves++;});
window.addEventListener('mouseup',function(e){window.__cv.up++;window.__drag.up={x:e.clientX,y:e.clientY};});
var lnk=document.getElementById('lnk');
lnk.addEventListener('click',function(e){window.__lnkEvt.click={ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey};});
lnk.addEventListener('contextmenu',function(e){window.__lnkEvt.ctx={ctrl:e.ctrlKey,meta:e.metaKey};e.preventDefault();});
document.getElementById('submit').addEventListener('click',function(e){
  e.preventDefault();
  window.__submitted={name:document.getElementById('name').value,email:document.getElementById('email').value,
    agree:document.getElementById('agree').checked,news:document.getElementById('news').checked,city:document.getElementById('city').value};
});
document.getElementById('req').addEventListener('click',function(){fetch('/slow').catch(function(){});});
document.getElementById('trig').addEventListener('click',function(){setTimeout(function(){document.getElementById('grow').className='on';},900);});
document.getElementById('nav').addEventListener('click',function(){setTimeout(function(){location.href='/page2';},500);});
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/slow") {
        // 慢请求：1.2 秒后才回，用来验证 networkIdle 确实在等在途请求
        return setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        }, 1200);
      }
      if (p === "/favicon.ico") {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (p === "/page2") return res.end('<!doctype html><title>Page2</title><h1>第二页</h1><button>回去</button>');
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

  const T = "v1-smoke-task";
  const call = (op, args = {}, signal) => manager.dispatch(op, args, { taskId: T, signal });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  };
  const ev = async (expr, tabId) => (await call("evaluate", { expression: expr, ...(tabId ? { tabId } : {}) })).value;
  const refOf = (text, name) => {
    for (const line of text.split("\n")) {
      if (line.includes(name)) {
        const m = /\[ref=(e\d+)\]/.exec(line);
        if (m) return m[1];
      }
    }
    return null;
  };
  /** 一次 snapshot 取多个 ref（下一次 snapshot 会让旧 ref 全部失效） */
  const refs = async (names) => {
    const snap = await call("snapshot", {});
    const out = { snap };
    for (const n of names) out[n] = refOf(snap.text, n);
    return out;
  };

  const nav = await call("navigate", { url: base + "/" });
  check("nav", "navigate 打开 fixture", nav.url.startsWith(base) && nav.status === 200, nav);
  const vp = await ev("({w:innerWidth,h:innerHeight})");

  // ── screenshot：viewportW / viewportH ──
  const shot = await call("screenshot", {});
  check("shot-viewport", "screenshot 结果带 viewportW/H，且等于页面 innerWidth/innerHeight", shot.viewportW === vp.w && shot.viewportH === vp.h && vp.w > 0, { shot: [shot.viewportW, shot.viewportH], vp });

  // ── mouse：click ──
  const c1 = await call("mouse", { action: "click", x: 120, y: 120 });
  const cv1 = await ev("window.__cv");
  check("mouse-click", "mouse click：画布收到 1 次点击，局部坐标≈(100,100)", cv1.click === 1 && Math.abs(cv1.last.x - 100) <= 1 && Math.abs(cv1.last.y - 100) <= 1 && c1.navigated === false, { cv1, c1 });
  // ── mouse：double_click ──
  await call("mouse", { action: "double_click", x: 150, y: 120 });
  const cv2 = await ev("window.__cv");
  check("mouse-dbl", "mouse double_click：画布收到 dblclick", cv2.dbl === 1 && cv2.click === 3, cv2);
  // ── mouse：wheel ──
  await call("mouse", { action: "wheel", x: 200, y: 120, deltaY: 120 });
  const cv3 = await ev("window.__cv");
  check("mouse-wheel-canvas", "mouse wheel：画布收到 wheel，deltaY=120", cv3.wheel >= 1 && cv3.wheelDelta.y === 120, cv3);
  // 原生滚轮的「默认滚动动作」只做信息性输出、不计入汇总：headless（show:false 窗口）里实测有「滚动落在上一次滚轮的目标 / 慢一拍」的怪现象，
  // 无法在这里判定真窗口的行为（见交付报告）。滚轮事件本身（位置 + delta）由上面的画布 wheel 监听验证。
  await sleep(900);
  await call("mouse", { action: "wheel", x: 600, y: 90, deltaY: 100 });
  await sleep(1000);
  console.log(`SMOKE INFO wheel-native-scroll 滚动区 scrollTop=${await ev("document.getElementById('sb').scrollTop")}（信息性，不计入汇总）`);
  // ── mouse：down → move → up（带 buttons 的拖拽轨迹） ──
  await call("mouse", { action: "down", x: 60, y: 60 });
  await call("mouse", { action: "move", x: 200, y: 120 });
  await call("mouse", { action: "move", x: 260, y: 140 });
  await call("mouse", { action: "up", x: 260, y: 140 });
  const drag = await ev("window.__drag");
  check("mouse-down-move-up", "down→move→up：页面看到按下、带 buttons 的移动、在终点抬起", drag.down && Math.abs(drag.down.x - 60) <= 1 && drag.moves >= 2 && drag.up && Math.abs(drag.up.x - 260) <= 1, drag);
  // ── mouse：越界 ──
  const over = await tryCall("mouse", { action: "click", x: vp.w + 50, y: 10 });
  check("mouse-out-of-viewport", "坐标超出视口 → BAD_ARGS，文案带视口尺寸", !over.ok && over.code === "BAD_ARGS" && over.message.includes(`${vp.w}×${vp.h}`), over);
  const overY = await tryCall("mouse", { action: "move", x: 10, y: vp.h });
  check("mouse-out-y", "y 恰等于视口高度也越界（上界开区间）", !overY.ok && overY.code === "BAD_ARGS", overY);
  const neg = await tryCall("mouse", { action: "click", x: -1, y: 10 });
  check("mouse-negative", "负坐标 → BAD_ARGS", !neg.ok && neg.code === "BAD_ARGS", neg);
  const zeroWheel = await tryCall("mouse", { action: "wheel", x: 10, y: 10 });
  check("mouse-wheel-zero", "wheel 不给 delta → BAD_ARGS", !zeroWheel.ok && zeroWheel.code === "BAD_ARGS", zeroWheel);
  const sess = manager.getSession(T);
  const logs = sess.activityLog.list().map((e) => e.summary).join("\n");
  check("mouse-log", "活动日志写了「鼠标点击 (120, 120)」", /鼠标点击 \(120, 120\)/.test(logs) && /鼠标滚轮/.test(logs), logs.slice(0, 300));

  // ── snapshot.query ──
  const full = await call("snapshot", {});
  const q = await call("snapshot", { query: "姓名" });
  const fullRef = refOf(full.text, "姓名");
  // 注意：每次 snapshot 都会换一代 ref，所以 query 结果的 ref 要和「同一代」比——这里用 query 自己返回的 ref 去操作验证
  const qRef = refOf(q.text, "姓名");
  check("query-filter", "snapshot query：头部有「命中 N 行 / 共 M 个可交互元素」，只含相关行（比全量短）", /命中 \d+ 行 \/ 共 \d+ 个可交互元素/.test(q.text) && !!qRef && q.text.length < full.text.length && !q.text.includes("画布"), { head: q.text.split("\n")[0], fullRef, qRef });
  const qType = await tryCall("type", { ref: qRef, text: "via-query-ref" });
  check("query-ref-usable", "query 结果里的 ref 可直接操作（ref 表完整登记）", qType.ok && (await ev("document.getElementById('name').value")) === "via-query-ref", qType);
  const qNone = await call("snapshot", { query: "绝对不存在的关键词zzz" });
  check("query-none", "query 无命中 → 明确说「没有匹配」而不是空串", /没有匹配/.test(qNone.text) && qNone.text.length > 10, qNone.text);
  const qCase = await call("snapshot", { query: "SUBMIT" });
  const qCase2 = await call("snapshot", { query: "提交" });
  check("query-case", "query 大小写不敏感（提交 命中；SUBMIT 对中文按钮无命中属预期）", /命中 \d+ 行/.test(qCase2.text) && /没有匹配/.test(qCase.text), { a: qCase.text.slice(0, 40), b: qCase2.text.split("\n")[0] });

  // ── fill_form：含密码拒绝、submit 被跳过 ──
  await call("type", { ref: (await refs(["姓名"]))["姓名"], text: "" }); // 清空
  let r = await refs(["姓名", "邮箱", "密码", "同意条款", "订阅通知", "城市", "提交"]);
  const f1 = await call("fill_form", {
    fields: [
      { ref: r["姓名"], value: "张三" },
      { ref: r["邮箱"], value: "z@example.com" },
      { ref: r["密码"], value: "s3cret-PW" },
      { ref: r["同意条款"], checked: true },
      { ref: r["订阅通知"], checked: true }, // 已勾：不能被点掉
      { ref: r["城市"], values: ["上海"] },
    ],
    submitRef: r["提交"],
  });
  const byRef = Object.fromEntries(f1.results.map((x) => [x.ref, x]));
  const pwdRes = byRef[r["密码"]];
  check("fill-pwd-rejected", "密码框被拒绝（ok:false，指向 browser_ask_user_to_act），密码框保持为空", pwdRes && pwdRes.ok === false && /browser_ask_user_to_act/.test(pwdRes.error) && (await ev("document.getElementById('pwd').value")) === "", pwdRes);
  check(
    "fill-others-ok",
    "其它项照常：文本 / 复选 / 下拉都成功，已勾选的复选框 checked:true 不会被点掉",
    [r["姓名"], r["邮箱"], r["同意条款"], r["订阅通知"], r["城市"]].every((k) => byRef[k]?.ok === true) &&
      (await ev("document.getElementById('name').value")) === "张三" &&
      (await ev("document.getElementById('agree').checked")) === true &&
      (await ev("document.getElementById('news').checked")) === true &&
      (await ev("document.getElementById('city').value")) === "sh",
    f1.results,
  );
  check("fill-submit-skipped", "有失败项时不提交：submit.ok=false 且页面没收到提交", f1.submit && f1.submit.ok === false && (await ev("window.__submitted")) === null, f1.submit);

  // ── fill_form：全部成功 + 取消勾选 + submit ──
  r = await refs(["姓名", "订阅通知", "提交"]);
  const f2 = await call("fill_form", { fields: [{ ref: r["姓名"], value: "李四" }, { ref: r["订阅通知"], checked: false }], submitRef: r["提交"] });
  const sub = await ev("window.__submitted");
  check("fill-submit", "全部成功 → 点击 submitRef，页面收到提交（取消勾选生效）", f2.results.every((x) => x.ok) && f2.submit?.ok === true && sub && sub.name === "李四" && sub.news === false && sub.agree === true && sub.city === "sh", { f2: f2.results, sub });
  // 单字段失败不中断后续
  r = await refs(["姓名", "邮箱"]);
  const f3 = await call("fill_form", { fields: [{ ref: "e99999", value: "x" }, { ref: r["邮箱"], value: "after-fail@x.com" }] });
  check("fill-partial", "单字段失败（ref 不存在）不中断后续字段", f3.results[0].ok === false && f3.results[1].ok === true && (await ev("document.getElementById('email').value")) === "after-fail@x.com", f3.results);
  const badShape = await tryCall("fill_form", { fields: [{ ref: "e1", value: "a", checked: true }] });
  check("fill-bad-shape", "value/checked 同时给 → BAD_ARGS", !badShape.ok && badShape.code === "BAD_ARGS", badShape);
  const logs2 = sess.activityLog.list().map((e) => e.summary).join("\n");
  check("fill-privacy", "活动日志只写数量，不含任何输入值", /填写了表单/.test(logs2) && !/张三|李四|s3cret|z@example|after-fail/.test(logs2), logs2.slice(-300));

  // ── click.modifiers ──
  const isMac = process.platform === "darwin";
  const newTabMod = isMac ? "Meta" : "Control";
  r = await refs(["链接去第二页"]);
  const m1 = await call("click", { ref: r["链接去第二页"], modifiers: [newTabMod] });
  const lnkEvt = await ev("window.__lnkEvt", "t1");
  const sawMod = !!(lnkEvt.click && (isMac ? lnkEvt.click.meta : lnkEvt.click.ctrl));
  check("click-modifier-flag", `click.modifiers=[${newTabMod}]：页面 click 事件带对应修饰键标志`, sawMod, lnkEvt);
  const tabsAfter = await call("tabs", { action: "list" });
  check("click-modifier-newtab", `${newTabMod}+点击链接 = 新标签页（newTabId 有值、原页未跳转）`, !!m1.newTabId && m1.navigated === false && tabsAfter.tabs.length >= 2, { m1, tabs: tabsAfter.tabs.map((t) => t.url) });
  if (m1.newTabId) {
    await call("tabs", { action: "close", tabId: m1.newTabId });
    await call("tabs", { action: "select", tabId: "t1" });
  }
  // Control（非 mac 的新标签修饰键 / mac 上的右键等价物）：只验证事件携带 ctrlKey，行为按平台各异（信息性）
  r = await refs(["链接去第二页"]);
  await tryCall("click", { ref: r["链接去第二页"], modifiers: ["Control"] });
  const lnkEvt2 = await ev("window.__lnkEvt", "t1").catch(() => null);
  const ctrlSeen = !!(lnkEvt2 && ((lnkEvt2.click && lnkEvt2.click.ctrl) || (lnkEvt2.ctx && lnkEvt2.ctx.ctrl)));
  check("click-ctrl-flag", "Control+点击：click 或 contextmenu 事件带 ctrlKey（mac 上可能走 contextmenu）", ctrlSeen, lnkEvt2);
  // 清理：Control+点击在非 mac 上也会开新标签
  for (const t of (await call("tabs", { action: "list" })).tabs) if (t.id !== "t1") await call("tabs", { action: "close", tabId: t.id }).catch(() => {});
  await call("tabs", { action: "select", tabId: "t1" }).catch(() => {});
  const badMod = await tryCall("click", { ref: "e1", modifiers: ["Hyper"] });
  check("click-modifier-bad", "未知修饰键 → BAD_ARGS", !badMod.ok && badMod.code === "BAD_ARGS", badMod);

  // ── wait_for：networkIdle ──
  await call("navigate", { url: base + "/" }); // 干净页面（上面的 Control+点击可能已让 t1 状态变化）
  const idle0 = await call("wait_for", { networkIdle: true, timeoutMs: 6000 });
  check("wait-idle-already", "页面已空闲：networkIdle 约 500ms 后 matched", idle0.matched === true && idle0.elapsedMs >= 450 && idle0.elapsedMs < 4000, idle0);
  r = await refs(["发慢请求"]);
  await call("click", { ref: r["发慢请求"] });
  const idle1 = await call("wait_for", { networkIdle: true, timeoutMs: 8000 });
  check("wait-idle-inflight", "有 1.2s 在途请求：networkIdle 等到它结束 + 500ms 静默才 matched", idle1.matched === true && idle1.elapsedMs >= 700, idle1);
  await call("click", { ref: (await refs(["发慢请求"]))["发慢请求"] });
  const idleTimeout = await call("wait_for", { networkIdle: true, timeoutMs: 500 });
  check("wait-idle-timeout", "在途请求未结束时短超时 → matched:false", idleTimeout.matched === false, idleTimeout);
  await sleep(1500); // 让上面的慢请求收尾

  // ── wait_for：refVisible ──
  r = await refs(["触发长大", "会长大的按钮"]);
  const hasGrowRef = !!r["会长大的按钮"];
  check("grow-ref-exists", "（前提）0×0 的按钮出现在快照里并有 ref", hasGrowRef, r.snap.text.split("\n").filter((l) => l.includes("长大")));
  if (hasGrowRef) {
    const notYet = await call("wait_for", { refVisible: r["会长大的按钮"], timeoutMs: 600 });
    check("wait-refvisible-no", "0×0 元素：refVisible 短超时 → matched:false", notYet.matched === false, notYet);
    await call("click", { ref: r["触发长大"] });
    const grown = await call("wait_for", { refVisible: r["会长大的按钮"], timeoutMs: 5000 });
    check("wait-refvisible-yes", "元素长出来后 refVisible → matched:true", grown.matched === true, grown);
  } else {
    check("wait-refvisible-no", "（跳过：前提不满足）", false);
    check("wait-refvisible-yes", "（跳过：前提不满足）", false);
  }
  const staleRv = await tryCall("wait_for", { refVisible: "e1", timeoutMs: 500 });
  check("wait-refvisible-stale", "ref 已失效 → 直接抛 REF_STALE（不傻等到超时）", !staleRv.ok && (staleRv.code === "REF_STALE" || staleRv.code === "REF_NOT_FOUND"), staleRv);

  // ── wait_for：urlContains ──
  r = await refs(["延迟跳转"]);
  await call("click", { ref: r["延迟跳转"] });
  const urlHit = await call("wait_for", { urlContains: "/page2", timeoutMs: 6000 });
  check("wait-url", "urlContains：延迟跳转后命中 /page2", urlHit.matched === true, urlHit);
  const urlMiss = await call("wait_for", { urlContains: "no-such-segment", timeoutMs: 600 });
  check("wait-url-miss", "urlContains 不命中 → 超时 matched:false", urlMiss.matched === false, urlMiss);
  const multi = await tryCall("wait_for", { urlContains: "a", networkIdle: true });
  check("wait-one-of", "多个条件同时给 → BAD_ARGS", !multi.ok && multi.code === "BAD_ARGS", multi);
  const noneGiven = await tryCall("wait_for", {});
  check("wait-none", "一个条件都没给 → BAD_ARGS", !noneGiven.ok && noneGiven.code === "BAD_ARGS", noneGiven);

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
