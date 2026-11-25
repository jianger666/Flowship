"use strict";
/**
 * Mermaid 出图（真 Electron + 真 Chromium）：electron-app/mermaid-render.mjs。
 *
 * 只能经启动器运行（AGENTS.md「跑无头 Electron 脚本必须走启动器」）：
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/mermaid-render.cjs --timeout 180
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/mermaid-render.cjs --timeout 240 -- --base=http://127.0.0.1:8691
 *
 * 两种模式：
 *  - 默认（fixture）：脚本自己起一个本地 http 服务，`/mermaid-render` 用 node_modules 里的 mermaid.min.js 按「渲染页契约」
 *    现写一份——不依赖 Next / 打包，验证**主进程这一半**（窗口隔离、网络白名单、CDP 截图、串行 / 取消 / 超限 / 协议校验）。
 *  - `--base=<server 根地址>`：连一个真的 Flowship server（如隔离的 `next dev`），渲染的是**真路由**（src/app/mermaid-render），
 *    额外验证：真页面能就绪、与聊天页同一套安全闸（含外部资源引用的源码被拦）、产出的图不是空白。
 *
 * server ⇄ 主进程的通道在这里用一个假 proc（EventEmitter + send）代替——协议报文与真实 IPC 完全一致，
 * Node 的 IPC 序列化本身不在被测范围。
 *
 * 临时 userData；窗口全程 show:false；不碰 Flowship / FlowshipTest 与 8676 / 8776 / 8876。
 * 产出的 PNG 落在 `$MERMAID_E2E_OUT`（缺省 /tmp/fs-mermaid-e2e-out），脚本末尾打印路径，方便人眼复核。
 */
const { app, BrowserWindow, session, nativeImage, dialog } = require("electron");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-mermaid-render-"));
app.setPath("userData", TMP);
app.on("window-all-closed", () => {});
dialog.showMessageBox = () => new Promise(() => {});
if (app.dock) app.dock.hide();

const OUT = process.env.MERMAID_E2E_OUT || "/tmp/fs-mermaid-e2e-out";
fs.mkdirSync(OUT, { recursive: true });
const BASE_ARG = process.argv.find((a) => a.startsWith("--base="));
const REAL_BASE = BASE_ARG ? BASE_ARG.slice("--base=".length).replace(/\/+$/, "") : "";

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok });
  console.log(`E2E ${ok ? "PASS" : "FAIL"} ${id} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
let renderer = null;
const finish = (code) => {
  const failed = results.filter((r) => !r.ok);
  console.log(`E2E DONE ${results.length - failed.length}/${results.length} passed（PNG 输出：${OUT}）`);
  try {
    renderer?.destroy();
  } catch {}
  for (const s of servers) {
    try {
      s.close();
    } catch {}
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn("SMOKE WARN 临时目录没清掉（不影响结果）：", err && err.message ? err.message : err);
  }
  app.exit(code ?? (failed.length ? 1 : 0));
};

const findMermaidMin = () => {
  const pnpm = path.join(process.cwd(), "node_modules", ".pnpm");
  const dir = fs.readdirSync(pnpm).find((d) => d.startsWith("mermaid@"));
  if (!dir) throw new Error("找不到 node_modules/.pnpm/mermaid@*");
  return path.join(pnpm, dir, "node_modules", "mermaid", "dist", "mermaid.min.js");
};

const listen = (server) =>
  new Promise((resolve) => {
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

// fixture 渲染页：按「渲染页契约」用 mermaid.min.js 现写（与 src/lib/mermaid-image-render.ts 同形，但不含 TS 预扫闸）
const FIXTURE_PAGE = `<!doctype html><meta charset="utf-8"><title>fixture</title>
<body style="margin:0;background:#fff">
<div id="stage" style="position:absolute;left:0;top:0;padding:16px;background:#fff;width:max-content"></div>
<script src="/mermaid.min.js"></script>
<script>
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default',
    fontFamily: '"PingFang SC","Microsoft YaHei",Arial,sans-serif', suppressErrorRendering: true });
  const stage = document.getElementById('stage');
  let seq = 0;
  window.__flowshipMermaidRender = async (source) => {
    try {
      stage.replaceChildren();
      const id = 'fx-' + (++seq);
      const { svg } = await mermaid.render(id, source);
      stage.innerHTML = svg;
      const el = stage.querySelector('svg');
      const vb = el.viewBox && el.viewBox.baseVal;
      const w = Math.ceil(vb && vb.width > 0 ? vb.width : el.getBoundingClientRect().width);
      const h = Math.ceil(vb && vb.height > 0 ? vb.height : el.getBoundingClientRect().height);
      el.setAttribute('width', String(w)); el.setAttribute('height', String(h));
      el.style.maxWidth = 'none'; el.style.display = 'block';
      await new Promise((r) => setTimeout(r, 30));
      const rect = stage.getBoundingClientRect();
      return { ok: true, width: rect.width, height: rect.height };
    } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
  };
  window.__flowshipMermaidClear = () => stage.replaceChildren();
  // 网络探针：页面里主动请求外部地址（用来验证渲染窗口的网络白名单）
  window.__probe = (url) => fetch(url, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked');
  window.__flowshipMermaidReady = true;
</script>`;

const pngInfo = (png) => {
  const sig = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  const img = nativeImage.createFromBuffer(png);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  let nonWhite = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    if (bmp[i] < 240 || bmp[i + 1] < 240 || bmp[i + 2] < 240) nonWhite++;
  }
  return { sig, width, height, nonWhiteRatio: nonWhite / (bmp.length / 4) };
};

(async () => {
  await app.whenReady();

  // 假 server 进程：send 收到的报文进 inbox，按 id 等待
  const proc = new EventEmitter();
  proc.connected = true;
  const inbox = [];
  const waiters = [];
  proc.send = (msg, cb) => {
    inbox.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
    cb?.(null);
    return true;
  };
  const waitFor = (pred, ms = 60_000) =>
    new Promise((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error("等待超时"));
        }
      }, ms);
    });
  let nextId = 1;
  const request = (source) => {
    const id = nextId++;
    proc.emit("message", { v: 1, kind: "mermaid-render-req", id, source });
    return id;
  };
  const result = (id, ms) => waitFor((m) => m.kind === "mermaid-render-res" && m.id === id, ms);

  // 本地服务：fixture 页（默认）；evil 服务计数（验证网络白名单）
  let evilHits = 0;
  const evilPort = await listen(
    http.createServer((req, res) => {
      evilHits++;
      res.writeHead(200, { "content-type": "image/png" });
      res.end();
    }),
  );
  let baseUrl = REAL_BASE;
  if (!REAL_BASE) {
    const mermaidJs = fs.readFileSync(findMermaidMin());
    const port = await listen(
      http.createServer((req, res) => {
        if (req.url === "/mermaid-render") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(FIXTURE_PAGE);
        } else if (req.url === "/mermaid.min.js") {
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end(mermaidJs);
        } else {
          res.writeHead(404);
          res.end();
        }
      }),
    );
    baseUrl = `http://127.0.0.1:${port}`;
  }
  console.log(`E2E 模式=${REAL_BASE ? "real" : "fixture"} base=${baseUrl}`);

  const { createMermaidRenderer, MAX_CSS_WIDTH } = await import(
    pathToFileURL(path.join(process.cwd(), "electron-app", "mermaid-render.mjs")).href
  );
  renderer = createMermaidRenderer({ BrowserWindow, session, getBaseUrl: () => baseUrl, log: (m) => console.log(`  [log] ${m}`) });
  renderer.attachServerProc(proc);

  const saveAndInspect = (name, res) => {
    const png = Buffer.from(res.png, "base64");
    fs.writeFileSync(path.join(OUT, `${name}.png`), png);
    return { png, info: pngInfo(png) };
  };

  // ── A 基本出图 ──
  const FLOW = `graph TD
  A[开始] --> B{条件判断}
  B -->|是| C[执行流程]
  B -->|否| D[结束]
  C --> D`;
  const t0 = Date.now();
  const id1 = request(FLOW);
  const ack1 = await waitFor((m) => m.kind === "mermaid-render-ack" && m.id === id1, 30_000).catch(() => null);
  const resultBeforeAck = inbox.some((m) => m.kind === "mermaid-render-res" && m.id === id1);
  const r1 = await result(id1, 90_000).catch((e) => ({ ok: false, error: { message: e.message } }));
  const coldMs = Date.now() - t0;
  check(
    "A0",
    "收到请求先回 ack（早于结果）",
    !!ack1 && !resultBeforeAck && inbox.indexOf(ack1) < inbox.findIndex((m) => m.kind === "mermaid-render-res" && m.id === id1),
  );
  check("A1", "流程图渲染成功（含窗口冷启动）", r1.ok === true, { coldMs, err: r1.error?.message });
  if (r1.ok) {
    const { info } = saveAndInspect("flowchart", r1);
    check("A2", "PNG 有效、尺寸 = CSS 尺寸 × 2（高清）", info.sig && info.width === r1.width * 2 && info.height === r1.height * 2, { css: [r1.width, r1.height], px: [info.width, info.height] });
    check("A3", "图不是空白（有墨迹）", info.nonWhiteRatio > 0.01, { nonWhiteRatio: Number(info.nonWhiteRatio.toFixed(4)) });
  }

  const SEQ = `sequenceDiagram
  participant 用户
  participant 飞书
  participant Flowship
  用户->>飞书: 发送问题
  飞书->>Flowship: 转发消息
  Flowship-->>飞书: 流式回复
  飞书-->>用户: 展示卡片`;
  const r2 = await result(request(SEQ), 60_000).catch((e) => ({ ok: false, error: { message: e.message } }));
  check("A4", "中文时序图渲染成功", r2.ok === true, { err: r2.error?.message });
  if (r2.ok) {
    const { info } = saveAndInspect("sequence", r2);
    check("A5", "时序图非空白", info.nonWhiteRatio > 0.01, { nonWhiteRatio: Number(info.nonWhiteRatio.toFixed(4)) });
  }

  // ── B 失败路径 ──
  const rBad = await result(request("graph TD\n  A -->"), 60_000).catch((e) => ({ ok: false, error: { message: e.message } }));
  check("B1", "语法错误 → ok:false（RENDER_FAILED，带原因）", rBad.ok === false && rBad.error?.code === "RENDER_FAILED" && !!rBad.error?.message, rBad.error);

  const rEmpty = await result(request("   "), 10_000).catch((e) => ({ ok: false, error: { message: e.message } }));
  check("B2", "空源码 → 直接拒绝", rEmpty.ok === false, rEmpty.error);

  const rHuge = await result(request("x".repeat(60_000)), 10_000).catch((e) => ({ ok: false, error: { message: e.message } }));
  check("B3", "源码超过长度上限 → 直接拒绝（不进渲染）", rHuge.ok === false && /过长/.test(rHuge.error?.message || ""), rHuge.error);

  // 超宽图：一长串横向节点 → CSS 宽度超过上限 → TOO_LARGE
  const wide = "graph LR\n" + Array.from({ length: 60 }, (_, i) => `  N${i}[节点编号${i}] --> N${i + 1}[节点编号${i + 1}]`).join("\n");
  const rWide = await result(request(wide), 90_000).catch((e) => ({ ok: false, error: { message: e.message } }));
  check("B4", `超宽图（> ${MAX_CSS_WIDTH}px）→ TOO_LARGE`, rWide.ok === false && rWide.error?.code === "TOO_LARGE", rWide.ok ? { width: rWide.width } : rWide.error);

  // ── C 协议 ──
  const before = inbox.length;
  proc.emit("message", { v: 1, kind: "hello" }); // 浏览器协议的消息
  proc.emit("message", { v: 1, kind: "res", id: 1, ok: true });
  proc.emit("message", { v: 2, kind: "mermaid-render-req", id: 99, source: "graph TD; A-->B" }); // 版本不对
  proc.emit("message", { v: 1, kind: "mermaid-render-req", id: "x", source: "graph TD; A-->B" }); // id 非整数
  await sleep(500);
  check("C1", "别的协议 / 版本不对 / id 非法的消息一律忽略（无任何回包）", inbox.length === before);

  // 串行：同时发 3 个，都成功，且按发送顺序返回
  const ids = [request("graph TD; A-->B"), request("graph TD; C-->D"), request("graph TD; E-->F")];
  const rs = await Promise.all(ids.map((i) => result(i, 90_000).catch((e) => ({ ok: false, error: { message: e.message } }))));
  const order = inbox.filter((m) => m.kind === "mermaid-render-res" && ids.includes(m.id)).map((m) => m.id);
  check("C2", "并发 3 个请求：全部成功、按发送顺序返回（串行）", rs.every((r) => r.ok) && JSON.stringify(order) === JSON.stringify(ids), { order, ok: rs.map((r) => r.ok) });

  // 取消：排在队尾的请求被取消 → 不回结果
  const blocker = request(FLOW);
  const victim = request("graph TD; X-->Y");
  proc.emit("message", { v: 1, kind: "mermaid-render-cancel", id: victim });
  await result(blocker, 60_000).catch(() => null);
  await sleep(1500);
  const victimRes = inbox.find((m) => m.kind === "mermaid-render-res" && m.id === victim);
  check("C3", "排队中被取消的请求不会回结果", !victimRes);

  // ── D 隔离 ──
  const renderWin = BrowserWindow.getAllWindows().find((w) => renderer.isRenderWindow(w));
  check("D1", "渲染窗口存在、不可见，且被识别为渲染窗口（不计入用户窗口）", !!renderWin && !renderWin.isVisible());
  if (renderWin) {
    const probe = await renderWin.webContents
      .executeJavaScript(`Promise.race([window.__probe ? window.__probe("http://127.0.0.1:${evilPort}/x.png") : (fetch("http://127.0.0.1:${evilPort}/x.png",{mode:"no-cors"}).then(()=>"reached",()=>"blocked")), new Promise(r=>setTimeout(()=>r("timeout"),5000))])`, false)
      .catch((e) => `err:${e.message}`);
    // 再用 <img> 发一次（走另一条加载路径）
    await renderWin.webContents
      .executeJavaScript(`new Promise(r=>{const i=new Image();i.onload=i.onerror=()=>r(1);i.src="http://127.0.0.1:${evilPort}/y.png";setTimeout(()=>r(0),3000)})`, false)
      .catch(() => 0);
    await sleep(300);
    check("D2", "渲染窗口访问外部地址被网络白名单拦截（evil 服务 0 次命中）", probe !== "reached" && evilHits === 0, { probe, evilHits });
    const perm = await renderWin.webContents
      .executeJavaScript(`navigator.permissions.query({name:"geolocation"}).then(s=>s.state,()=>"err")`, false)
      .catch(() => "err");
    check("D3", "页面权限默认不授予", perm !== "granted", { perm });
    const globals = await renderWin.webContents
      .executeJavaScript(`({ req: typeof require, proc: typeof process })`, false)
      .catch(() => ({}));
    check("D4", "渲染页拿不到 Node 能力（sandbox + 无 nodeIntegration）", globals.req === "undefined" && globals.proc === "undefined", globals);
  }

  // ── E 真路由专属 ──
  if (REAL_BASE) {
    const evilSrc = `graph TD\n  A["<img src='http://127.0.0.1:${evilPort}/leak.png'>"] --> B`;
    const hitsBefore = evilHits;
    const rEvil = await result(request(evilSrc), 60_000).catch((e) => ({ ok: false, error: { message: e.message } }));
    await sleep(500);
    check("E1", "含 <img> 外部资源的源码：真页面的闸拦下、不出图、evil 0 命中", rEvil.ok === false && evilHits === hitsBefore, { err: rEvil.error?.message?.slice(0, 80), evilHits });
    const cssSrc = `graph TD\n  A --> B\n  classDef x background-image:url(http://127.0.0.1:${evilPort}/c.png)\n  class A x`;
    const rCss = await result(request(cssSrc), 60_000).catch((e) => ({ ok: false, error: { message: e.message } }));
    await sleep(500);
    check("E2", "classDef url() 外部资源：被拦、evil 0 命中", rCss.ok === false && evilHits === hitsBefore, { evilHits });
    const shellGone = renderWin
      ? await renderWin.webContents.executeJavaScript(`document.querySelectorAll("aside,nav,header").length`, false).catch(() => -1)
      : -1;
    check("E3", "真页面没有套应用外壳（无 aside / nav / header）", shellGone === 0, { shellGone });
    // `next dev` 的「N」开发提示（<nextjs-portal>）会盖进截图左下角：必须不可见（生产构建里没有这个元素、空集合也算过）
    const devBadge = renderWin
      ? await renderWin.webContents
          .executeJavaScript(
            `(() => { const els = [...document.querySelectorAll("nextjs-portal")]; return { count: els.length, visible: els.filter((el) => getComputedStyle(el).display !== "none").length }; })()`,
            false,
          )
          .catch(() => ({ count: -1, visible: -1 }))
      : { count: -1, visible: -1 };
    check("E4", "`next dev` 的开发提示（nextjs-portal）不可见，不会盖进截图", devBadge.visible === 0, devBadge);
  }

  // ── F 收尾 ──
  renderer.destroy();
  await sleep(300);
  check("F1", "destroy 后渲染窗口已销毁", !BrowserWindow.getAllWindows().some((w) => !w.isDestroyed()));
  finish();
})().catch((err) => {
  console.log(`E2E FAIL FATAL ${err?.stack || err}`);
  finish(1);
});
