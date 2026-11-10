"use strict";
/**
 * D 组：「server 侧 bridge.ts + tools.ts  ↔  真实 Electron 里的 BrowserManager」跨进程 e2e 的 Electron 一侧。
 *
 * 角色：它在这个测试里扮演「桌面壳主进程」——用真实 Electron 依赖创建 createBrowserManager，
 * 再把「父进程（vitest）经 Node ipc 开的那路通道」包成 attachServerChannel 需要的 `EventEmitter + send(msg, cb) + connected`，
 * 这样 server-channel.mjs 的收发 / 分发 / 取消 / 断线清理全走真实通道，而不是直接调 manager.dispatch。
 *
 * 只能经启动器 + ipc:true 运行（见 tests/browser-e2e-bridge.test.ts，由 runElectronScript({ ipc: true }) 起）：
 *   FS_BROWSER_E2E=1 pnpm exec vitest run tests/browser-e2e-bridge.test.ts
 * 不带 ipc 单独跑会直接 exit(3)。
 *
 * # 自定义消息（都不属于 §4 协议，只在这个 e2e 里用；bridge.ts / server-channel 对未知 kind 一律忽略或只记日志）
 *   peer → 测试：{ v:1, kind:"peer-ready", fixtureUrl, appUrl, userDataTmp }  通道挂好、fixture 起好之后发一次
 *   测试 → peer：{ v:1, kind:"peer-cmd", cmdId, cmd, ...参数 }
 *   peer → 测试：{ v:1, kind:"peer-reply", cmdId, ok:true, result } | { ok:false, error }
 * peer-cmd 在这里被截走，不会转给 server-channel（所以不污染它的日志）。钩子清单：
 *   state {taskId}                      → session.getState()（会话不存在 → null）
 *   config                              → manager.getConfig()（验证 server 推的 config 真的到了主进程）
 *   takeover {taskId}                   → session.takeover()
 *   handback {taskId, note?}            → session.handback(note)
 *   answer-ask {taskId, outcome, note?} → session.answerAsk(outcome, note)（用户点「完成 / 放弃」）
 *   wait-idle {taskId, timeoutMs?}      → 等 AI 宽限期（8s）过完、controller 回 idle
 *   user-click {taskId, selector}       → webContents.sendInputEvent 模拟「真实用户」点击元素中心
 *   user-type {taskId, selector, text}  → 先点击聚焦、再逐字 keyDown / char / keyUp
 *   page-eval {taskId, expression}      → 在页面主世界求值（独立于 AI 的 browser_evaluate，用来核对「页面确实收到」）
 *   quit                                → 回复后 app.exit(0)（模拟壳 / 通道消失）
 * 这些钩子只存在于本脚本，不要搬进 electron-app/browser/index.mjs 的生产代码。
 *
 * 临时 userData、窗口 show:false、fixture 只监听 127.0.0.1 随机端口；不碰 Flowship / FlowshipTest 与 8676 / 8776 / 8876。
 */
const { app, BrowserWindow, WebContentsView, session, ipcMain, nativeImage } = require("electron");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (typeof process.send !== "function") {
  console.error("[bridge-peer] 没有 ipc 通道：请经 runElectronScript({ ipc: true }) 启动");
  app.exit(3);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browser-bridge-peer-"));
app.setPath("userData", TMP);
// 隐藏的停车场窗口常驻，关光窗口不该让 app 退出
app.on("window-all-closed", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log("[peer]", m);
/** 退出前清临时 userData（app.exit 不触发 will-quit，所以不能挂在那上面） */
const bye = (code) => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结果 */
  }
  app.exit(code);
};

// ───────────────────────── fixture 页面 ─────────────────────────

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>E2E Fixture</title></head><body>
<h1>E2E Fixture</h1>
<div><label>姓名 <input id="name" aria-label="姓名"></label></div>
<div><button id="submit">提交</button> <span id="out" role="status"></span></div>
<div><input id="note" aria-label="备注"></div>
<div><input id="pwd" type="password" aria-label="密码"></div>
<div><a id="lnk" href="/page2">去第二页</a> | <a id="blank" href="/page3" target="_blank">新窗口打开</a></div>
<div><select id="city" aria-label="城市"><option value="bj">北京</option><option value="sh">上海</option></select></div>
<div id="hov" role="button" tabindex="0" aria-label="悬停区" style="display:inline-block;padding:4px;border:1px solid #999">悬停区</div>
<div><button id="b1">拖块</button> <button id="b2">放置区</button></div>
<div style="height:3000px"></div>
<script>
window.__clicks = 0;
window.__submitted = null;
document.getElementById('submit').addEventListener('click', function () {
  window.__clicks++;
  window.__submitted = document.getElementById('name').value;
  document.getElementById('out').textContent = '已提交:' + window.__submitted;
});
console.error('fixture-console-error-marker');
fetch('/boom').catch(function () {});
</script></body></html>`;

const startFixture = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, "http://x").pathname;
      // 会失败的请求：服务端直接掐连接 → net::ERR_EMPTY_RESPONSE（CDP 的 loadingFailed）
      if (p === "/boom") return req.socket.destroy();
      res.setHeader("content-type", "text/html; charset=utf-8");
      // 慢页面：让 navigate 在途 4 秒，测「AI 动作进行中用户接管」（USER_TOOK_OVER）
      if (p === "/slow") return void setTimeout(() => res.end("<!doctype html><title>Slow</title><h1>慢页面</h1>"), 4000);
      if (p === "/page2") return res.end('<!doctype html><title>Page2</title><h1>第二页</h1><button>回去</button>');
      if (p === "/page3") return res.end("<!doctype html><title>Page3</title><h1>第三页</h1>");
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

// ───────────────────────── 通道包装：process ipc → EventEmitter + send + connected ─────────────────────────

const makeChannelProc = (onPeerCmd) => {
  const chan = new EventEmitter();
  chan.send = (msg, cb) => {
    // 父进程已断开时 process.send 会抛 ERR_IPC_CHANNEL_CLOSED，由 server-channel 的 try/catch 兜
    process.send(msg, undefined, undefined, (err) => {
      if (typeof cb === "function") cb(err || null);
    });
    return true;
  };
  Object.defineProperty(chan, "connected", { get: () => process.connected !== false });
  process.on("message", (m) => {
    if (m && typeof m === "object" && m.kind === "peer-cmd") {
      onPeerCmd(m);
      return;
    }
    chan.emit("message", m);
  });
  process.on("disconnect", () => chan.emit("disconnect"));
  return chan;
};

const sendRaw = (msg) => {
  try {
    process.send({ v: 1, ...msg }, undefined, undefined, () => {});
  } catch {
    /* 通道已断 */
  }
};

// ───────────────────────── main ─────────────────────────

const main = async () => {
  await app.whenReady();
  const { server, base } = await startFixture();
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../../electron-app/browser/index.mjs")).href);

  const mainWin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await mainWin.loadURL("about:blank");

  // 假的「应用 origin」：127.0.0.1:9。fixture 的随机端口不会被拦；测试里导航到 :9 验证 URL_BLOCKED
  const APP_URL_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):9(\/|$)/;
  const manager = mod.createBrowserManager({
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain,
    nativeImage,
    getMainWindow: () => (mainWin.isDestroyed() ? null : mainWin),
    isAppUrl: (u) => APP_URL_RE.test(u),
    isTrustedIpcSender: () => true,
    log: (m) => console.log("  [manager]", m),
  });

  const wcOf = (taskId) => {
    const tab = manager.getSession(taskId)?.activeTab;
    if (!tab) throw new Error(`任务 ${taskId} 还没有会话 / 标签页`);
    return tab.wc;
  };
  const centerOf = async (wc, selector) => {
    const pt = await wc.executeJavaScript(
      `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    );
    if (!pt) throw new Error(`页面里找不到 ${selector}`);
    return pt;
  };
  /** 真实用户点击：sendInputEvent 走浏览器进程的真实输入管线（isTrusted=true、不带 AI flag），会被页内录制器记成用户活动 */
  const userClick = async (wc, selector) => {
    const { x, y } = await centerOf(wc, selector);
    wc.sendInputEvent({ type: "mouseMove", x, y });
    await sleep(30);
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    await sleep(30);
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await sleep(60);
  };
  const userType = async (wc, selector, text) => {
    await userClick(wc, selector); // 点击聚焦
    for (const ch of text) {
      wc.sendInputEvent({ type: "keyDown", keyCode: ch });
      wc.sendInputEvent({ type: "char", keyCode: ch });
      wc.sendInputEvent({ type: "keyUp", keyCode: ch });
      await sleep(12);
    }
    await sleep(60);
  };

  const hooks = {
    state: ({ taskId }) => manager.getSession(taskId)?.getState() ?? null,
    config: () => manager.getConfig(),
    takeover: ({ taskId }) => {
      const s = manager.getSession(taskId);
      if (!s) throw new Error("没有会话");
      s.takeover();
      return s.getState().controller;
    },
    handback: ({ taskId, note }) => {
      const s = manager.getSession(taskId);
      if (!s) throw new Error("没有会话");
      s.handback(note);
      return s.getState().controller;
    },
    // 等价于用户在条幅上点「完成 / 放弃」（outcome: done | skipped）
    "answer-ask": ({ taskId, outcome, note }) => {
      const s = manager.getSession(taskId);
      if (!s) throw new Error("没有会话");
      s.answerAsk(outcome, note);
      return s.getState().controller;
    },
    "wait-idle": async ({ taskId, timeoutMs = 15000 }) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (manager.getSession(taskId)?.getState().controller === "idle") return { waitedMs: Date.now() - t0 };
        await sleep(100);
      }
      throw new Error(`${timeoutMs}ms 内 controller 没回 idle`);
    },
    "user-click": async ({ taskId, selector }) => {
      await userClick(wcOf(taskId), selector);
      return true;
    },
    "user-type": async ({ taskId, selector, text }) => {
      await userType(wcOf(taskId), selector, String(text));
      return true;
    },
    "page-eval": async ({ taskId, expression }) => wcOf(taskId).executeJavaScript(String(expression)),
  };

  const onPeerCmd = (m) => {
    const { cmdId, cmd } = m;
    const done = (ok, payload) => sendRaw({ kind: "peer-reply", cmdId, ok, ...(ok ? { result: payload ?? null } : { error: payload }) });
    if (cmd === "quit") {
      // 先把回复冲出去再退：app.exit 会直接断开 ipc，模拟「壳 / 通道消失」
      try {
        process.send({ v: 1, kind: "peer-reply", cmdId, ok: true, result: null }, undefined, undefined, () => setTimeout(() => bye(0), 50));
      } catch {
        bye(0);
      }
      return;
    }
    const fn = hooks[cmd];
    if (!fn) return done(false, `未知钩子 ${String(cmd)}`);
    Promise.resolve()
      .then(() => fn(m))
      .then(
        (r) => done(true, r),
        (e) => done(false, (e && e.message) || String(e)),
      );
  };

  const chan = makeChannelProc(onPeerCmd);
  manager.attachServerChannel(chan);

  // 父进程没了（vitest 被中断）：别留孤儿，直接退
  process.on("disconnect", () => {
    try {
      manager.destroy();
    } catch {
      /* 尽力而为 */
    }
    server.close();
    setTimeout(() => bye(0), 100);
  });

  sendRaw({ kind: "peer-ready", fixtureUrl: base + "/", fixtureBase: base, appUrl: "http://127.0.0.1:9/", userDataTmp: TMP });
  log(`ready fixture=${base}`);
};

main().catch((e) => {
  console.error("[bridge-peer] 启动失败", (e && e.stack) || e);
  app.exit(1);
});

