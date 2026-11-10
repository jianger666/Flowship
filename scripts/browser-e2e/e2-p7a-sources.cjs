"use strict";
/**
 * E2·P7a 真机冒烟（真 Electron + 真 CDP）：B3 `sources`（list / get / sourcemap / issues）与 `console` 栈 sourcemap 还原。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-p7a-sources.cjs --timeout 120
 *
 * 通过 createBrowserManager(...).dispatch 直接驱动。临时 userData、窗口 show:false、本地 http fixture（127.0.0.1 随机端口）；
 * 不碰 Flowship / FlowshipTest 与 8676/8776/8876。每个能力 1–3 条核心断言。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-e2-p7a-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 最小 bundle + source map（生成代码一行；VLQ 在这里手编码）──
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const vlq = (n) => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let d = v & 31;
    v >>>= 5;
    if (v > 0) d |= 32;
    out += B64[d];
  } while (v > 0);
  return out;
};
const BUNDLE_BODY = 'function boom(){console.error("boom-from-bundle")}window.addEventListener("load",function(){setTimeout(boom,0)});';
const BUNDLE = `${BUNDLE_BODY}\n//# sourceMappingURL=bundle.js.map\n`;
// 生成列 0 → a.ts 行 0；列 16（console.error 所在）→ 行 1 列 2；列 60 → 行 3
const seg = (gcol, src, ol, oc) => `${vlq(gcol)}${vlq(src)}${vlq(ol)}${vlq(oc)}`;
const MAP = JSON.stringify({
  version: 3,
  file: "bundle.js",
  sources: ["src/a.ts"],
  sourcesContent: ['export function boom() {\n  console.error("boom-from-bundle");\n}\n'],
  names: [],
  // 相对编码：第 2 个 segment 的 src / 行 / 列都是相对前一个的增量
  mappings: [seg(0, 0, 0, 0), `${vlq(16)}${vlq(0)}${vlq(1)}${vlq(2)}`, `${vlq(44)}${vlq(0)}${vlq(2)}${vlq(-2)}`].join(","),
});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>P7a</title>
<link rel="stylesheet" href="/style.css">
<style>.inline-x{margin:0}</style></head><body>
<h1 class="target">P7a</h1>
<img src="/pic.png" alt="blocked by CSP">
<script src="/bundle.js"></script>
<script src="/nomap.js"></script>
<script src="/appmap.js"></script>
<script>window.__inline = 1;</script>
</body></html>`;

const hits = { appPath: 0 };
const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      if (p.startsWith("/__flowship_app__")) {
        hits.appPath++;
        res.setHeader("content-type", "application/json");
        return res.end(MAP);
      }
      if (p === "/bundle.js") {
        res.setHeader("content-type", "application/javascript");
        return res.end(BUNDLE);
      }
      if (p === "/bundle.js.map") {
        res.setHeader("content-type", "application/json");
        return res.end(MAP);
      }
      if (p === "/nomap.js") {
        res.setHeader("content-type", "application/javascript");
        return res.end('window.__nomap = 1; var apiKey = "sk-A1b2C3d4E5f6G7h8I9j0K1l2M3n4";\n');
      }
      if (p === "/appmap.js") {
        res.setHeader("content-type", "application/javascript");
        return res.end(`window.__appmap = 1;\n//# sourceMappingURL=/__flowship_app__/secret.map\n`);
      }
      if (p === "/style.css") {
        res.setHeader("content-type", "text/css");
        return res.end(".target { color: red; }\n.other { margin: 0; }\n");
      }
      if (p === "/pic.png") {
        res.setHeader("content-type", "image/png");
        return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      // img-src 'none'：页面里的 <img> 触发 CSP 违规（Audits 里的 CSP 问题）；脚本不受限
      res.setHeader("content-security-policy", "img-src 'none'");
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
    // 把 /__flowship_app__ 路径当作「Flowship 自身 origin」，验证 sourcemap 获取绝不碰它
    isAppUrl: (u) => {
      try {
        return new URL(u).pathname.startsWith("/__flowship_app__");
      } catch {
        return false;
      }
    },
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });
  manager.onConfig({ evaluateEnabled: true });

  const T = "p7a-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  };

  await call("navigate", { url: `${base}/` });
  await sleep(800); // 等 load 事件里的 setTimeout(boom) 与 CSP 违规产生

  // ═══════════ list：启用前就加载的脚本 / 样式表 ═══════════
  const list = await call("sources", { action: "list" });
  const byUrl = (suffix) => list.items.find((i) => i.url.endsWith(suffix));
  check("list-scripts", "list 列出启用前就加载的外链脚本（bundle.js / nomap.js）", !!byUrl("/bundle.js") && !!byUrl("/nomap.js"), list.items.map((i) => `${i.id}:${i.url.slice(-24)}`));
  check("list-sourcemap-flag", "bundle.js 标 sourceMap:true，nomap.js 为 false", byUrl("/bundle.js")?.sourceMap === true && byUrl("/nomap.js")?.sourceMap === false);
  check("list-inline", "内联脚本（文档 URL）带 inline 标记", list.items.some((i) => i.kind === "script" && i.inline === true), list.items.filter((i) => i.kind === "script").map((i) => `${i.id}${i.inline ? "·inline" : ""}`));
  check("list-hidden", "Flowship 注入的隔离世界脚本 / Electron 内部脚本不在列表里（无 <eval> 噪声、无 electron/ 脚本）", !list.items.some((i) => /^electron\//.test(i.url)) && !list.items.some((i) => i.url === "<eval>"), list.items.map((i) => i.url.slice(-30)));
  check("list-styles", "样式表：外链 style.css 与内联 <style>（inline 标记）都在", !!byUrl("/style.css") && list.items.some((i) => i.kind === "style" && i.inline === true), list.styleCount);
  const listFilter = await call("sources", { action: "list", url: "bundle" });
  check("list-filter", "url 过滤只剩 bundle", listFilter.items.length === 1 && listFilter.items[0].url.endsWith("/bundle.js"));

  // ═══════════ get：带行号 / 先脱敏 ═══════════
  const got = await call("sources", { action: "get", url: `${base}/bundle.js` });
  check("get-numbered", "get 带行号（第 1 行以 `1 | function boom` 开头）", got.text.split("\n")[0].startsWith("1 | function boom"), got.text.split("\n")[0].slice(0, 40));
  const nomap = await call("sources", { action: "get", url: "/nomap.js" });
  check("get-redacted", "源码里的 apiKey 凭据被遮蔽（不含原值）", !nomap.text.includes("sk-A1b2C3d4E5f6"), nomap.text.slice(0, 80));
  const css = await call("sources", { action: "get", scriptId: byUrl("/style.css").id });
  check("get-style", "样式表 get：带行号并含 .target 规则", /1 \| \.target/.test(css.text), css.text.slice(0, 40));

  // ═══════════ sourcemap：original 位置映射 ═══════════
  const orig = await call("sources", { action: "get", url: "/bundle.js", startLine: 1, column: 25, original: true });
  check("original-pos", "original:true 把 1:25 映射到 src/a.ts 第 2 行", orig.original?.available === true && orig.original.source === "src/a.ts" && orig.original.line === 2, orig.original);
  check("original-snippet", "original 附带内嵌的原始源码片段（含 console.error）", /console\.error/.test(orig.original?.snippet ?? ""));
  const sm = await call("sources", { action: "sourcemap", url: "/bundle.js" });
  check("sourcemap-info", "sourcemap action：loaded、sources=[src/a.ts]、有内嵌内容", sm.loaded === true && sm.sources?.[0] === "src/a.ts" && sm.withContent === 1, sm);
  const evilMap = await call("sources", { action: "get", url: "/appmap.js", original: true });
  check("sourcemap-app-origin", "map 指向 Flowship origin：降级 available:false，且 fixture 未收到任何请求", evilMap.original?.available === false && hits.appPath === 0, { original: evilMap.original, hits: hits.appPath });
  const bad = await tryCall("sources", { action: "get", url: "/does-not-exist.js" });
  check("get-notfound", "不存在的 url：BAD_ARGS 且提示先 list", !bad.ok && bad.code === "BAD_ARGS" && /list/.test(bad.message), bad);

  // ═══════════ issues ═══════════
  const issues = await call("sources", { action: "issues" });
  const csp = (issues.shown ?? []).find((i) => i.category === "csp");
  check("issues-csp", "issues 抓到 CSP 违规（img-src 'none'）", !!csp && /CSP|内容安全策略/.test(csp.summary), issues.counts);
  const issuesCsp = await call("sources", { action: "issues", types: ["cookie"] });
  check("issues-filter", "types 过滤：只看 cookie 时没有 CSP 条目", (issuesCsp.shown ?? []).every((i) => i.category === "cookie"));

  // ═══════════ console 栈还原 ═══════════
  const plain = await call("console", { level: "error", limit: 20 });
  check("console-default-no-stack", "默认（不带 sourcemap）条目不出站 stack，形状不变", plain.entries.length > 0 && plain.entries.every((e) => e.stack === undefined));
  const resolved = await call("console", { level: "error", limit: 20, sourcemap: true });
  const boom = resolved.entries.find((e) => /boom-from-bundle/.test(e.text));
  const f0 = boom?.stack?.[0];
  check("console-stack-original", "sourcemap:true：栈首帧还原到 src/a.ts 第 2 行", f0?.original?.source === "src/a.ts" && f0.original.line === 2, { f0, note: resolved.sourcemap });
  check("console-stack-generated", "同时保留压缩后的原坐标（bundle.js 第 1 行）", /bundle\.js/.test(f0?.url ?? "") && f0?.line === 0, f0);

  // 失败降级：导航到没有 map 的页面后再还原 → 原栈 + note，不抛
  await call("navigate", { url: `${base}/nomap.js` });
  const degraded = await tryCall("console", { level: "all", limit: 5, sourcemap: true });
  check("console-degrade", "没有 sourceMappingURL 的页面：sourcemap:true 不抛，返回 note", degraded.ok && Array.isArray(degraded.value.entries), degraded.ok ? degraded.value.sourcemap : degraded);

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
