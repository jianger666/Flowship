/**
 * Mermaid → PNG 渲染服务（主进程侧）。给飞书回复里的 ```mermaid 出图用：飞书卡片不渲染 Mermaid，只能发图片。
 *
 * 为什么在主进程：Mermaid 需要真实 DOM（文字测量 getBBox、流程图的 foreignObject），server 进程里没有；
 * 打包后的壳里也没有 mermaid 包。所以这里开一个**隐藏窗口**加载 server 自己的渲染页（`/mermaid-render`，
 * 与 app 内聊天用同一份 mermaid、同一套安全配置与源码预扫），渲染完用 CDP 截图成 PNG，经 IPC 还给 server，
 * 由 server 上传飞书换 image_key。协议见 src/lib/server/mermaid-render.ts 的头注释。
 *
 * 隔离（渲染的是模型写的内容，按不可信输入对待）：
 *  - 独立的内存会话（partition，不带 persist:），与主窗口 / 内置浏览器的 cookie、缓存互不相通；
 *  - 网络只放行 server 自己的 origin（外加 data: / blob:），其它请求一律取消——就算预扫被绕过，渲染页也发不出追踪请求；
 *  - sandbox + contextIsolation、无 nodeIntegration；权限请求一律拒绝；禁止弹窗 / 页面跳转；
 *  - 页面从不展示给用户（show:false），也不会计入「用户窗口」（见 main.js 的 hasUserWindows）。
 *
 * 资源：窗口懒创建；请求串行（一次只渲一张）；空闲 {@link IDLE_DESTROY_MS} 后销毁；排队上限 {@link MAX_QUEUE}；
 * 源码 / 图片尺寸 / PNG 体积都有上限（超限就报错，由 server 退回「保留成代码块」）。
 *
 * 渲染页契约（app/mermaid-render/page.tsx）：
 *   `window.__flowshipMermaidReady === true` 之后可调
 *   `window.__flowshipMermaidRender(source)` → `{ ok:true, width, height }` | `{ ok:false, error }`
 *   渲染结果放在页面左上角 (0,0)、白底、尺寸即 width × height（CSS 像素）；`window.__flowshipMermaidClear()` 清空舞台。
 *
 * 纯函数（planCapture / isAllowedRenderRequest / parseRenderRequest）单独导出，tests/mermaid-render-main.test.ts 覆盖；
 * 真 Electron + 真 IPC 的行为见 scripts/browser-e2e/mermaid-render.cjs。
 */

export const MERMAID_PAGE_PATH = "/mermaid-render";
/** 内存会话名（不带 `persist:`，进程退出即丢） */
export const RENDER_PARTITION = "flowship-mermaid-render";
/** 源码长度上限（mermaid 自己的 maxTextSize 默认 5 万字符，超了它只会渲染「Maximum text size exceeded」） */
export const MAX_SOURCE_CHARS = 50_000;
/** 渲染页就绪（含冷启动加载）等待上限 */
export const PAGE_READY_TIMEOUT_MS = 20_000;
/** 单次 `__flowshipMermaidRender` 调用上限 */
export const RENDER_CALL_TIMEOUT_MS = 20_000;
/** 最后一次渲染后多久销毁窗口 */
export const IDLE_DESTROY_MS = 60_000;
/** 最多排几个请求（不含正在渲的那个） */
export const MAX_QUEUE = 8;
/** 图的 CSS 像素宽 / 高上限：超过说明图大到飞书里也看不清，直接放弃（保留成代码块） */
export const MAX_CSS_WIDTH = 4000;
export const MAX_CSS_HEIGHT = 12000;
/** 截图设备像素上限（任一边）；超过就降到 1 倍 */
export const MAX_DEVICE_PX = 8192;
/** PNG 体积上限（飞书图片上限 10MB，留余量） */
export const MAX_PNG_BYTES = 8 * 1024 * 1024;

const PROTOCOL_VERSION = 1;

/**
 * 按渲染页回报的尺寸规划截图：2 倍清晰度优先，边太长就降到 1 倍，再大就放弃。
 * @param {unknown} width
 * @param {unknown} height
 * @returns {{ ok: true, cssWidth: number, cssHeight: number, scale: 1 | 2 } | { ok: false, reason: string }}
 */
export const planCapture = (width, height) => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: "渲染页回报的图片尺寸无效" };
  }
  const cssWidth = Math.ceil(width);
  const cssHeight = Math.ceil(height);
  if (cssWidth > MAX_CSS_WIDTH || cssHeight > MAX_CSS_HEIGHT) {
    return { ok: false, reason: `图太大（${cssWidth}×${cssHeight}），超出可发送的范围` };
  }
  const scale = cssWidth * 2 <= MAX_DEVICE_PX && cssHeight * 2 <= MAX_DEVICE_PX ? 2 : 1;
  return { ok: true, cssWidth, cssHeight, scale };
};

/**
 * 渲染窗口的网络白名单：只放行 server 自己的 origin（http / ws 同端口，dev 的热更新要 ws）与 data: / blob:。
 * @param {string} url
 * @param {string} origin 形如 `http://127.0.0.1:8876`
 */
export const isAllowedRenderRequest = (url, origin) => {
  if (typeof url !== "string" || !url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "blob:") return true;
  let base;
  try {
    base = new URL(origin);
  } catch {
    return false;
  }
  if (u.host !== base.host) return false;
  if (u.protocol === base.protocol) return true;
  // dev 热更新：http → ws、https → wss（同 host:port）
  return (base.protocol === "http:" && u.protocol === "ws:") || (base.protocol === "https:" && u.protocol === "wss:");
};

/**
 * 校验 server 发来的请求报文。
 * @param {unknown} msg
 * @returns {{ kind: "req", id: number, source: string } | { kind: "cancel", id: number } | { kind: "bad-req", id: number, message: string } | null} 不属于本协议返回 null
 */
export const parseRenderRequest = (msg) => {
  if (!msg || typeof msg !== "object" || msg.v !== PROTOCOL_VERSION) return null;
  if (msg.kind !== "mermaid-render-req" && msg.kind !== "mermaid-render-cancel") return null;
  if (!Number.isInteger(msg.id)) return null;
  if (msg.kind === "mermaid-render-cancel") return { kind: "cancel", id: msg.id };
  if (typeof msg.source !== "string" || !msg.source.trim()) {
    return { kind: "bad-req", id: msg.id, message: "Mermaid 源码为空" };
  }
  if (msg.source.length > MAX_SOURCE_CHARS) {
    return { kind: "bad-req", id: msg.id, message: `Mermaid 源码过长（${msg.source.length} 字符）` };
  }
  return { kind: "req", id: msg.id, source: msg.source };
};

class RenderError extends Error {
  /** @param {"TIMEOUT"|"CANCELLED"|"TOO_LARGE"|"RENDER_FAILED"} code */
  constructor(code, message) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

/** @template T @param {Promise<T>} p @param {number} ms @param {string} what */
const withTimeout = (p, ms, what) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new RenderError("TIMEOUT", `${what}超时（${Math.round(ms / 1000)}s）`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {typeof import("electron").BrowserWindow} deps.BrowserWindow
 * @param {{ fromPartition: (name: string) => any }} deps.session electron 的 session 模块
 * @param {() => string} deps.getBaseUrl server 的根地址（形如 `http://127.0.0.1:8876`）
 * @param {(msg: string) => void} [deps.log]
 */
export const createMermaidRenderer = ({ BrowserWindow, session, getBaseUrl, log = () => {} }) => {
  /** @type {{ win: any, ready: Promise<void> | null, idleTimer: any, sessionWired: boolean }} */
  const state = { win: null, ready: null, idleTimer: null, sessionWired: false };
  /** @type {Array<{ id: number, source: string, cancelled: boolean, reply: (m: object) => void }>} */
  const queue = [];
  /** @type {{ id: number, cancelled: boolean } | null} */
  let running = null;
  let destroyed = false;

  const origin = () => new URL(getBaseUrl()).origin;

  const clearIdle = () => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
  };

  const destroyWindow = (why) => {
    clearIdle();
    const win = state.win;
    state.win = null;
    state.ready = null;
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch (err) {
        log(`[mermaid-render] 销毁窗口失败：${err?.message || err}`);
      }
      if (why) log(`[mermaid-render] 渲染窗口已销毁（${why}）`);
    }
  };

  const armIdle = () => {
    clearIdle();
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (!running && queue.length === 0) destroyWindow("空闲回收");
    }, IDLE_DESTROY_MS);
    state.idleTimer.unref?.();
  };

  const wireSession = (ses) => {
    if (state.sessionWired) return;
    state.sessionWired = true;
    // 只放行 server 自己的 origin：渲染的是模型写的内容，预扫被绕过时这里是最后一道（追踪像素 / 数据外带发不出去）
    ses.webRequest.onBeforeRequest((details, cb) => {
      let allowed = false;
      try {
        allowed = isAllowedRenderRequest(details.url, origin());
      } catch {
        allowed = false;
      }
      cb({ cancel: !allowed });
    });
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
  };

  const createWindow = () => {
    const ses = session.fromPartition(RENDER_PARTITION);
    wireSession(ses);
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      skipTaskbar: true,
      focusable: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: RENDER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: false,
      },
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (e) => e.preventDefault());
    wc.on("render-process-gone", (_e, details) => {
      log(`[mermaid-render] 渲染进程退出：${details?.reason || "未知"}`);
      if (state.win === win) destroyWindow(null);
    });
    win.on("closed", () => {
      if (state.win === win) {
        state.win = null;
        state.ready = null;
      }
    });
    try {
      wc.setAudioMuted(true);
    } catch {
      /* 非关键 */
    }
    return win;
  };

  /** 窗口存在且页面就绪（懒创建 + 加载 + 轮询就绪标记） */
  const ensureReady = async () => {
    if (state.win && !state.win.isDestroyed() && state.ready) return state.ready;
    destroyWindow(null);
    const win = createWindow();
    state.win = win;
    const url = `${origin()}${MERMAID_PAGE_PATH}`;
    state.ready = (async () => {
      const startedAt = Date.now();
      try {
        await withTimeout(win.loadURL(url), PAGE_READY_TIMEOUT_MS, "加载渲染页");
        for (;;) {
          if (win.isDestroyed()) throw new RenderError("RENDER_FAILED", "渲染窗口已关闭");
          const ready = await win.webContents.executeJavaScript("window.__flowshipMermaidReady === true", false);
          if (ready === true) break;
          if (Date.now() - startedAt > PAGE_READY_TIMEOUT_MS) {
            throw new RenderError("TIMEOUT", "渲染页没有就绪");
          }
          await sleep(100);
        }
        log(`[mermaid-render] 渲染页就绪（${Date.now() - startedAt}ms）`);
      } catch (err) {
        // 加载失败的窗口不留着（下次请求重建）
        if (state.win === win) destroyWindow(null);
        if (err instanceof RenderError) throw err;
        throw new RenderError("RENDER_FAILED", `渲染页加载失败：${err?.message || err}`);
      }
    })();
    // 同一个 ready 可能被多处 await；失败只在使用处处理，这里吞掉游离 rejection
    state.ready.catch(() => {});
    return state.ready;
  };

  /** CDP 截图：把视口设成图的尺寸再截，不依赖窗口大小 / 是否可见 */
  const capture = async (win, plan) => {
    const wc = win.webContents;
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const shoot = async (scale) => {
      await dbg.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: plan.cssWidth,
        height: plan.cssHeight,
        deviceScaleFactor: scale,
        mobile: false,
      });
      const r = await dbg.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      return Buffer.from(r?.data ?? "", "base64");
    };
    try {
      let buf = await shoot(plan.scale);
      if (buf.length > MAX_PNG_BYTES && plan.scale === 2) buf = await shoot(1);
      if (buf.length === 0) throw new RenderError("RENDER_FAILED", "截图结果为空");
      if (buf.length > MAX_PNG_BYTES) throw new RenderError("TOO_LARGE", "渲染出的图片体积过大");
      return buf;
    } finally {
      try {
        await dbg.sendCommand("Emulation.clearDeviceMetricsOverride");
      } catch {
        /* 窗口可能已销毁 */
      }
      try {
        dbg.detach();
      } catch {
        /* 已分离 */
      }
    }
  };

  /** @returns {Promise<{ png: Buffer, width: number, height: number }>} */
  const renderOne = async (job) => {
    await ensureReady();
    const win = state.win;
    if (!win || win.isDestroyed()) throw new RenderError("RENDER_FAILED", "渲染窗口不可用");
    if (job.cancelled) throw new RenderError("CANCELLED", "渲染已取消");
    let res;
    try {
      // JSON.stringify 产出合法的 JS 字符串字面量（U+2028/2029 在 ES2019 起也合法）；源码只作为参数、不拼进语句
      res = await withTimeout(
        win.webContents.executeJavaScript(`window.__flowshipMermaidRender(${JSON.stringify(job.source)})`, false),
        RENDER_CALL_TIMEOUT_MS,
        "渲染",
      );
    } catch (err) {
      // 页面卡死 / 执行异常：这扇窗口不可信了，销毁；下个请求重建
      destroyWindow("渲染调用失败");
      if (err instanceof RenderError) throw err;
      throw new RenderError("RENDER_FAILED", `渲染页执行失败：${err?.message || err}`);
    }
    if (!res || res.ok !== true) {
      const msg = typeof res?.error === "string" && res.error ? res.error : "Mermaid 渲染失败";
      throw new RenderError("RENDER_FAILED", msg.slice(0, 300));
    }
    const plan = planCapture(res.width, res.height);
    if (!plan.ok) throw new RenderError("TOO_LARGE", plan.reason);
    if (job.cancelled) throw new RenderError("CANCELLED", "渲染已取消");
    let png;
    try {
      png = await capture(win, plan);
    } catch (err) {
      if (err instanceof RenderError) throw err;
      destroyWindow("截图失败");
      throw new RenderError("RENDER_FAILED", `截图失败：${err?.message || err}`);
    } finally {
      // 清空舞台，别让上一张图的 DOM 留着（窗口会复用）
      try {
        if (state.win && !state.win.isDestroyed()) {
          await state.win.webContents.executeJavaScript("window.__flowshipMermaidClear && window.__flowshipMermaidClear()", false);
        }
      } catch {
        /* 非关键 */
      }
    }
    return { png, width: plan.cssWidth, height: plan.cssHeight };
  };

  const pump = async () => {
    if (running || destroyed) return;
    for (;;) {
      const job = queue.shift();
      if (!job) break;
      if (job.cancelled) continue;
      running = job;
      const startedAt = Date.now();
      try {
        const out = await renderOne(job);
        if (!job.cancelled) {
          job.reply({
            kind: "mermaid-render-res",
            id: job.id,
            ok: true,
            png: out.png.toString("base64"),
            width: out.width,
            height: out.height,
          });
        }
        log(`[mermaid-render] 渲染完成 id=${job.id} ${out.width}×${out.height} png=${out.png.length}B ${Date.now() - startedAt}ms`);
      } catch (err) {
        const code = err instanceof RenderError ? err.code : "RENDER_FAILED";
        const message = err instanceof RenderError ? err.message : `渲染异常：${err?.message || err}`;
        log(`[mermaid-render] 渲染失败 id=${job.id} code=${code}：${message}`);
        if (!job.cancelled) job.reply({ kind: "mermaid-render-res", id: job.id, ok: false, error: { code, message } });
      } finally {
        running = null;
      }
    }
    if (!destroyed) armIdle();
  };

  /** 把 server 子进程接进来（每次 server 重启都对新 proc 调一次；旧 proc 的挂起请求直接作废） */
  const attachServerProc = (proc) => {
    const reply = (msg) => {
      if (!proc || proc.connected === false || typeof proc.send !== "function") return;
      try {
        proc.send({ v: PROTOCOL_VERSION, ...msg }, (err) => {
          if (err) log(`[mermaid-render] 回包失败 kind=${msg.kind}：${err.message}`);
        });
      } catch (err) {
        log(`[mermaid-render] 回包异常 kind=${msg.kind}：${err?.message || err}`);
      }
    };
    proc.on("message", (raw) => {
      if (destroyed) return;
      const req = parseRenderRequest(raw);
      if (!req) return; // 别的协议（浏览器通道）的消息，不是我们的
      if (req.kind === "cancel") {
        for (const j of queue) if (j.id === req.id && j.reply === reply) j.cancelled = true;
        if (running && running.id === req.id) running.cancelled = true;
        return;
      }
      reply({ kind: "mermaid-render-ack", id: req.id });
      if (req.kind === "bad-req") {
        reply({ kind: "mermaid-render-res", id: req.id, ok: false, error: { code: "RENDER_FAILED", message: req.message } });
        return;
      }
      if (queue.length >= MAX_QUEUE) {
        reply({ kind: "mermaid-render-res", id: req.id, ok: false, error: { code: "RENDER_FAILED", message: "渲染排队过多" } });
        return;
      }
      clearIdle();
      queue.push({ id: req.id, source: req.source, cancelled: false, reply });
      void pump();
    });
    // 这个 proc 退出：它的挂起请求没人收了，别白渲染
    proc.once?.("exit", () => {
      for (const j of queue) if (j.reply === reply) j.cancelled = true;
    });
  };

  return {
    attachServerProc,
    /** 渲染窗口不算「用户窗口」（main.js 的 hasUserWindows 用） */
    isRenderWindow: (w) => !!w && w === state.win,
    /** 退出时调：销毁窗口、丢弃排队 */
    destroy: () => {
      destroyed = true;
      queue.length = 0;
      destroyWindow("退出");
    },
    /** 仅测试 / 诊断 */
    _state: () => ({ hasWindow: !!state.win && !state.win.isDestroyed(), queued: queue.length, running: !!running }),
  };
};
