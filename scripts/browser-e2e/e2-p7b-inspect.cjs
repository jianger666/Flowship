"use strict";
/**
 * E2·P7b（B4）真 Electron + 真 CDP：browser_inspect 的 matched_rules / event_listeners / a11y_audit。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p7b-inspect.cjs --timeout 150
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动。临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；
 * 不碰 Flowship / FlowshipTest 与 8676/8776/8876。每个能力只测 1–3 条核心断言。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-p7b-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
};

// 行号敏感：下面 <style> 内的 `.inl` 规则所在的文档行，用于断言「内联样式表的行号换算」
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>P7b</title>
<link rel="stylesheet" href="/app.css">
<style>
.inl { border: 1px solid red; }
input[value="hunter2"] { outline: 1px solid red; }
</style></head><body>
<h1>P7b</h1>
<button id="btn" class="btn inl" style="margin-top: 3px">Go</button>
<button id="ibtn" title="icon"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>
<input id="pw" type="password" value="hunter2" aria-label="pwfield">
<script src="/app.js"></script>
</body></html>`;
const INL_LINE = PAGE.split("\n").findIndex((l) => l.startsWith(".inl {")) + 1;

const CSS_TEXT = `.btn { color: red !important; padding: 2px; }
.btn:hover { color: blue; }
#btn { background: url(/x.png?token=sk-live-abcdef1234567890); }
`;
const JS_TEXT = `var b = document.getElementById('btn');
b.addEventListener('click', function onClickSecretBody() { window.__clicked = (window.__clicked || 0) + 1; }, { once: true });
b.addEventListener('mouseover', function () {}, { passive: true, capture: true });
`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/app.css") {
        res.setHeader("content-type", "text/css");
        return res.end(CSS_TEXT);
      }
      if (p === "/app.js") {
        res.setHeader("content-type", "application/javascript");
        return res.end(JS_TEXT);
      }
      if (p === "/x.png") {
        res.statusCode = 204;
        return res.end();
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
    isAppUrl: (u) => /:9\//.test(u),
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  manager.onConfig({ evaluateEnabled: true });

  const T = "p7b-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
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

  await call("navigate", { url: `${base}/` });
  const snap = (await call("snapshot", {})).text;
  const btn = refOf(snap, "Go");
  const ibtn = refOf(snap, "icon");
  const pw = refOf(snap, "pwfield");
  check("refs", "拿到三个元素的 ref", !!btn && !!ibtn && !!pw, { btn, ibtn, pw });

  // ═══ matched_rules ═══
  const m = await call("inspect", { ref: btn, include: ["matched_rules"] });
  const mr = m.matchedRules;
  check("mr-only-extra", "只要 matched_rules：不带 box / attrs / styles，但有 tag", m.tag === "button" && !m.box && !m.attrs && !m.styles && !!mr && !mr.error, Object.keys(m));
  const ruleBtn = mr?.rules?.find((r) => r.selector === ".btn");
  check(
    "mr-external",
    "外链 CSS 规则：来源 URL:行:列、!important、声明",
    !!ruleBtn && /\/app\.css:1:\d+$/.test(ruleBtn.source) && ruleBtn.origin === "author" && ruleBtn.decls.some((d) => d.name === "color" && d.value === "red" && d.important === true),
    ruleBtn,
  );
  const ruleInl = mr?.rules?.find((r) => r.selector === ".inl");
  check("mr-inline-sheet", `内联 <style> 规则：来源标注 + 文档行号（预期第 ${INL_LINE} 行）`, !!ruleInl && ruleInl.source.startsWith("<style>") && ruleInl.source.includes(`:${INL_LINE}:`), ruleInl);
  check("mr-inline-attr", "元素 style 属性被单独列出（margin-top: 3px）", Array.isArray(mr?.inline) && mr.inline.some((d) => d.name === "margin-top" && d.value === "3px"), mr?.inline);
  check("mr-ua-folded", "浏览器默认样式只给数量（uaCount ≥ 1），规则列表里没有 user-agent 来源", mr?.uaCount >= 1 && mr.rules.every((r) => r.origin !== "user-agent"), mr?.uaCount);
  check("mr-url-redacted", "声明里 url(...?token=sk-live-…) 的凭据被脱敏", !JSON.stringify(mr).includes("sk-live-abcdef1234567890"), mr?.rules?.find((r) => r.selector === "#btn"));

  const mp = await call("inspect", { ref: pw, include: ["matched_rules"] });
  check("mr-secret-selector", "密码框上 input[value=…] 选择器被遮，结果里没有 hunter2", !JSON.stringify(mp).includes("hunter2") && JSON.stringify(mp.matchedRules).includes("已隐藏"), mp.matchedRules?.rules);

  // ═══ event_listeners ═══
  const hubMod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/debugger-hub.mjs")).href);
  const hub = hubMod.getDebuggerHub(manager.getSession(T).activeTab);
  const el = await call("inspect", { ref: btn, include: ["event_listeners"] });
  const ls = el.eventListeners;
  const click = ls?.listeners?.find((l) => l.type === "click");
  const over = ls?.listeners?.find((l) => l.type === "mouseover");
  check("el-click", "列出 click 监听：once=true，位置是 app.js:行:列", !!click && click.once === true && click.capture === false && /\/app\.js:\d+:\d+$/.test(click.location), click);
  check("el-mouseover", "mouseover：capture + passive", !!over && over.capture === true && over.passive === true, over);
  check("el-no-source", "不给函数源码 / 函数名", !JSON.stringify(el).includes("onClickSecretBody") && !JSON.stringify(el).includes("__clicked"), ls);
  check("el-hub-released", "用完释放 hub（没有别的使用者 → ownerCount=0）", !hub || hub.ownerCount() === 0, hub?.ownerCount?.());

  // ═══ a11y_audit ═══
  const a11y = await call("inspect", { ref: ibtn, include: ["a11y_audit"] });
  const au = a11y.a11yAudit;
  check("a11y-run", "axe 跑通：有版本号与违规列表", !!au && !au.error && /^4\./.test(au.version) && Array.isArray(au.violations), au);
  const imgAlt = au?.violations?.find((v) => v.id === "image-alt");
  check("a11y-image-alt", "报出 image-alt（img 缺 alt）：影响 / 节点数 / 选择器", !!imgAlt && imgAlt.impact === "critical" && imgAlt.nodes >= 1 && imgAlt.selectors.length >= 1, imgAlt);
  check("a11y-no-html", "摘要里没有节点 HTML 片段", !JSON.stringify(au).includes("<img"), undefined);
  const mainAxe = await ev("JSON.stringify({ t: typeof axe, w: 'axe' in window, k: Object.getOwnPropertyNames(window).includes('axe') })");
  check("a11y-main-world-clean", "页面主世界里查不到 axe 全局", JSON.parse(mainAxe).t === "undefined" && JSON.parse(mainAxe).w === false && JSON.parse(mainAxe).k === false, mainAxe);
  const again = await call("inspect", { ref: ibtn, include: ["a11y_audit"] });
  check("a11y-rerun", "同一 world 再跑一次仍成功（不重复注入也不报错）", !again.a11yAudit?.error && again.a11yAudit?.violations?.some((v) => v.id === "image-alt"), again.a11yAudit?.error);

  // ═══ 混合 + 回归 ═══
  const all = await call("inspect", { ref: btn, include: ["box", "attrs", "matched_rules", "event_listeners"] });
  check("mix", "基础项 + 新项同时返回，互不影响", !!all.box && !!all.attrs && !!all.matchedRules && !!all.eventListeners && all.attrs.id === "btn", Object.keys(all));
  const plain = await call("inspect", { ref: btn });
  check("default-unchanged", "缺省 include 行为不变（box + styles + attrs，无新字段）", !!plain.box && !!plain.styles && !!plain.attrs && !plain.matchedRules && !plain.eventListeners && !plain.a11yAudit, Object.keys(plain));
  const clicked = await ev("(function(){ document.getElementById('btn').click(); return window.__clicked || 0; })()");
  check("el-listener-intact", "检查监听器没有触发 / 移除页面的监听（点击仍生效一次）", clicked === 1, clicked);

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
