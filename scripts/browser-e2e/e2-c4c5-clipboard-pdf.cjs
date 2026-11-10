"use strict";
/**
 * E2·C4 剪贴板 + C5 PDF 选项 冒烟（真 Electron + 真 CDP）。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/e2-c4c5-clipboard-pdf.cjs --timeout 120
 *
 * 剪贴板用**内存假剪贴板**注入 createBrowserManager（不碰开发机真实的系统剪贴板），但走的是真实的 manager / dispatch / session / ops 接线；
 * PDF 走真 Chromium 的 Page.printToPDF，按 PDF 里的 /MediaBox 与页对象数断言（不依赖页眉文字是否可抽取）。
 * 临时 userData / 下载目录，窗口 show:false，本地 http fixture；不碰 Flowship / FlowshipTest 与 8676/8776/8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-c4c5-"));
app.setPath("userData", TMP);
app.setPath("downloads", path.join(TMP, "downloads"));
app.on("window-all-closed", () => {});

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

/** 5 页的打印 fixture：每个 section 一页 */
const PDF_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>PDF fixture</title>
<style>section{page-break-after:always;height:200px;background:#eef}</style></head><body>
${[1, 2, 3, 4, 5].map((n) => `<section><h1>第 ${n} 页</h1></section>`).join("\n")}
</body></html>`;

/** 一张没有分页符的长页（3000px 高）：用来看 scale 对页数的影响 */
const LONG_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>long</title></head><body style="margin:0"><div style="height:3000px;background:#efe">long</div></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(new URL(req.url, "http://x").pathname === "/long" ? LONG_PAGE : PDF_PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

/** PDF 页数：数 `/Type /Page`（不是 /Pages）；MediaBox：第一页的 [0 0 w h] */
const pdfInfo = (file) => {
  const buf = fs.readFileSync(file).toString("latin1");
  const pages = (buf.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  const m = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(buf);
  return { head: buf.slice(0, 5), pages, width: m ? Number(m[3]) - Number(m[1]) : null, height: m ? Number(m[4]) - Number(m[2]) : null };
};

const main = async () => {
  await app.whenReady();
  const { server, base } = await startFixture();
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);

  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");

  // 内存假剪贴板：manager 通过 deps.clipboard 拿到（user-features 与 ops/clipboard 共用同一份注入）
  const fakeClip = { text: "" };
  const clipboard = {
    readText: () => fakeClip.text,
    writeText: (t) => {
      fakeClip.text = String(t);
    },
  };

  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain,
    nativeImage,
    clipboard,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: (u) => /:9\//.test(u),
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [log]", m),
  });

  const T = "c4c5-task";
  const call = (op, args = {}) => manager.dispatch(op, args, { taskId: T });
  const tryCall = async (op, args) => {
    try {
      return { ok: true, value: await call(op, args) };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  };

  await call("navigate", { url: `${base}/` });

  // ═══════════ C4 剪贴板 ═══════════
  const USER_SECRET = "用户原有的剪贴板-hunter2-ORIGINAL";
  fakeClip.text = USER_SECRET;
  const r0 = await call("clipboard", { action: "read" });
  check("clip-not-armed", "没 watch_start 就 read：not_armed，结果里没有用户原有内容", r0.status === "not_armed" && !JSON.stringify(r0).includes("hunter2"), r0);

  const w = await call("clipboard", { action: "watch_start" });
  check("clip-watch", "watch_start：armed，不回显内容", w.armed === true && !JSON.stringify(w).includes("hunter2"), w);
  // R6-18：窗口内还没有 AI 页面动作 → 用户（这里模拟）复制的内容一律不返回
  fakeClip.text = "用户在窗口内复制的 pw-USER-PRE";
  const r1pre = await call("clipboard", { action: "read" });
  check("clip-no-ai-action", "R6-18 窗口内没有 AI 动作：no_ai_action，不返回用户复制的内容", r1pre.status === "no_ai_action" && !JSON.stringify(r1pre).includes("pw-USER-PRE"), r1pre);
  // 真 tab.withAiInput 路径：press_key 触发钩子 → watch 记下 AI 动作并把基线重定到「动作之前」的剪贴板（用户那份被排除）
  await call("press_key", { key: "Shift" });
  const r1 = await call("clipboard", { action: "read" });
  check("clip-unchanged", "AI 动作后 read：unchanged（动作前用户复制的内容被排除），仍不返回", r1.status === "unchanged" && !JSON.stringify(r1).includes("hunter2") && !JSON.stringify(r1).includes("pw-USER-PRE"), r1);

  fakeClip.text = "npm install flowship"; // 模拟页面「复制」按钮放进剪贴板的内容
  const r2 = await call("clipboard", { action: "read" });
  check("clip-changed", "页面复制后 read：changed，拿到新文字且不含旧秘密", r2.status === "changed" && r2.text === "npm install flowship" && !JSON.stringify(r2).includes("hunter2"), r2);
  const r3 = await call("clipboard", { action: "read" });
  check("clip-consumed", "同一次变化只读一次：再读 unchanged", r3.status === "unchanged", r3);

  const wr = await call("clipboard", { action: "write", text: "AI 写的内容" });
  check("clip-write", "write 写进系统剪贴板，watch 生效时基线同步更新", fakeClip.text === "AI 写的内容" && wr.watching === true, wr);
  const r4 = await call("clipboard", { action: "read" });
  check("clip-self-write", "AI 自己写的内容不会被读回（unchanged）", r4.status === "unchanged", r4);

  // R6-07：press_key 粘贴键只放行「AI 本轮 write 写入」的剪贴板（真 index.mjs 注入的 clipboard.readText）
  const pasteOk = await tryCall("press_key", { key: "Control+v" });
  check("paste-own-write", "R6-07 剪贴板 == AI 写入：Ctrl+V 放行", pasteOk.ok, pasteOk);
  fakeClip.text = "用户后来复制的 pw-USER-C";
  const pasteBad = await tryCall("press_key", { key: "Control+v" });
  check("paste-user-copy", "R6-07 用户改写剪贴板后 Ctrl+V 被拒，文案不含用户内容", !pasteBad.ok && pasteBad.code === "BAD_ARGS" && /不是你本轮写入/.test(pasteBad.message) && !String(pasteBad.message).includes("pw-USER-C"), pasteBad);
  const pasteBad2 = await tryCall("press_key", { key: "Shift+Insert" });
  check("paste-shift-insert", "R6-07 Shift+Insert 同样被拒", !pasteBad2.ok && pasteBad2.code === "BAD_ARGS", pasteBad2);

  // R6-18：观察窗口 5 秒（自第一次 AI 动作起算），过期后同样的变化不再返回
  await call("clipboard", { action: "watch_start" });
  await call("press_key", { key: "Shift" });
  await new Promise((r) => setTimeout(r, 5400));
  fakeClip.text = "窗口外才发生的变化 pw-LATE";
  const rLate = await call("clipboard", { action: "read" });
  check("clip-window-5s", "R6-18 AI 动作后 5 秒窗口过期：expired，不返回内容", rLate.status === "expired" && !JSON.stringify(rLate).includes("pw-LATE"), rLate);

  const bad = await tryCall("clipboard", { action: "write", text: "x".repeat(100_001) });
  check("clip-too-long", "write 超过 100000 字符 → BAD_ARGS", !bad.ok && bad.code === "BAD_ARGS", bad);

  // 用户接管时三个动作 USER_CONTROL、watch 作废：由单测 tests/browser-e2-c4-clipboard.test.ts 用真 BrowserSession 覆盖（真机里触发接管要走面板 ipc，不在本脚本范围）

  // ═══════════ C5 PDF 选项 ═══════════
  const saveAndInspect = async (args) => {
    const r = await call("save", { kind: "pdf", ...args });
    return { r, info: pdfInfo(r.path) };
  };

  const base0 = await saveAndInspect({});
  check("pdf-default", "不带选项：合法 PDF，5 个 section 分成多页", base0.info.head === "%PDF-" && base0.info.pages >= 5, base0.info);

  const ranged = await saveAndInspect({ pageRanges: "1-2" });
  check("pdf-ranges", "pageRanges=1-2 → 2 页", ranged.info.pages === 2, ranged.info);

  const a4 = await saveAndInspect({ paperFormat: "a4" });
  check("pdf-a4", "paperFormat=a4 → 宽≈595、高≈842（pt）", Math.abs(a4.info.width - 595) < 3 && Math.abs(a4.info.height - 842) < 3, a4.info);

  const land = await saveAndInspect({ paperFormat: "a4", landscape: true });
  check("pdf-landscape", "a4 + landscape → 宽>高（≈842×595）", land.info.width > land.info.height && Math.abs(land.info.width - 842) < 3, land.info);

  const letter = await saveAndInspect({ paperFormat: "letter" });
  check("pdf-letter", "paperFormat=letter → 612×792", Math.abs(letter.info.width - 612) < 3 && Math.abs(letter.info.height - 792) < 3, letter.info);

  // scale 的影响用一张没有分页符的 3000px 长页来看：scale=1 要好几页，scale=0.3 缩成一页
  await call("navigate", { url: `${base}/long` });
  const longFull = await saveAndInspect({ paperFormat: "a4" });
  const longScaled = await saveAndInspect({ paperFormat: "a4", scale: 0.3 });
  check("pdf-scale", "长页：scale=0.3 缩小后页数明显少于不缩放", longFull.info.pages >= 3 && longScaled.info.pages < longFull.info.pages, { full: longFull.info.pages, scaled: longScaled.info.pages });
  await call("navigate", { url: `${base}/` });

  const hf = await saveAndInspect({ paperFormat: "a4", header: "页眉 <script>alert(1)</script><span class='title'></span>", footer: "第 <span class='pageNumber'></span> / <span class='totalPages'></span> 页", margins: { top: 1, bottom: 1 } });
  check("pdf-header-footer", "带页眉页脚 / 页边距：仍是合法 PDF 且页数不变", hf.info.head === "%PDF-" && hf.info.pages >= 1, hf.info);

  const badOpt = await tryCall("save", { kind: "pdf", scale: 9 });
  check("pdf-bad-scale", "scale=9 → BAD_ARGS", !badOpt.ok && badOpt.code === "BAD_ARGS", badOpt);
  const badKind = await tryCall("save", { kind: "html", landscape: true });
  check("pdf-bad-kind", "非 pdf 带 landscape → BAD_ARGS", !badKind.ok && badKind.code === "BAD_ARGS", badKind);

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
