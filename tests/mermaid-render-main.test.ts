/**
 * Mermaid 出图——主进程服务（electron-app/mermaid-render.mjs）与整条链路的接线契约。
 *
 * 真 Electron / 真 Chromium 的行为（隐藏窗口截图、网络白名单、sandbox、真路由）见
 * scripts/browser-e2e/mermaid-render.cjs；这里用假 BrowserWindow 钉死「调度 / 协议 / 隔离配置 / 资源回收」，
 * 并把真实的 server 侧客户端接到主进程服务上做一次联调。
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IDLE_DESTROY_MS,
  MAX_CSS_HEIGHT,
  MAX_CSS_WIDTH,
  MAX_DEVICE_PX,
  MAX_QUEUE,
  MAX_SOURCE_CHARS,
  MERMAID_PAGE_PATH,
  RENDER_CALL_TIMEOUT_MS,
  RENDER_PARTITION,
  createMermaidRenderer,
  isAllowedRenderRequest,
  parseRenderRequest,
  planCapture,
} from "../electron-app/mermaid-render.mjs";
import type { BridgeTransport } from "@/lib/server/browser/bridge";
import { createMermaidRenderClient } from "@/lib/server/mermaid-render";
import { BARE_ROUTES, isBareRoute } from "@/lib/bare-routes";

const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf8");
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("planCapture：按尺寸规划截图", () => {
  it("常规尺寸：2 倍清晰度", () => {
    expect(planCapture(223.2, 501.4)).toEqual({ ok: true, cssWidth: 224, cssHeight: 502, scale: 2 });
  });

  it("设备像素任一边超过上限 → 降到 1 倍（宽的 CSS 上限 ×2 不会超；高的会）", () => {
    const half = Math.floor(MAX_DEVICE_PX / 2);
    expect(planCapture(MAX_CSS_WIDTH, 100)).toMatchObject({ ok: true, scale: 2 });
    expect(planCapture(100, half)).toMatchObject({ ok: true, scale: 2 });
    expect(planCapture(100, half + 1)).toMatchObject({ ok: true, scale: 1 });
    expect(planCapture(100, MAX_CSS_HEIGHT)).toMatchObject({ ok: true, scale: 1 });
  });

  it("CSS 宽 / 高超上限 → 放弃", () => {
    expect(planCapture(MAX_CSS_WIDTH + 1, 100)).toMatchObject({ ok: false });
    expect(planCapture(100, MAX_CSS_HEIGHT + 1)).toMatchObject({ ok: false });
    expect(planCapture(MAX_CSS_WIDTH, MAX_CSS_HEIGHT)).toMatchObject({ ok: true });
  });

  it("无效尺寸（NaN / 0 / 负 / 非数字）→ 放弃", () => {
    for (const [w, h] of [[NaN, 10], [10, NaN], [0, 10], [10, -1], ["10", 10], [Infinity, 10], [undefined, undefined]] as const) {
      expect(planCapture(w, h)).toMatchObject({ ok: false });
    }
  });
});

describe("isAllowedRenderRequest：渲染窗口网络白名单", () => {
  const origin = "http://127.0.0.1:8876";
  it("只放行 server 自己的 origin（含 dev 热更新的 ws）与 data: / blob:", () => {
    expect(isAllowedRenderRequest("http://127.0.0.1:8876/mermaid-render", origin)).toBe(true);
    expect(isAllowedRenderRequest("http://127.0.0.1:8876/_next/static/chunks/a.js", origin)).toBe(true);
    expect(isAllowedRenderRequest("ws://127.0.0.1:8876/_next/webpack-hmr", origin)).toBe(true);
    expect(isAllowedRenderRequest("data:image/svg+xml;base64,AAAA", origin)).toBe(true);
    expect(isAllowedRenderRequest("blob:http://127.0.0.1:8876/abc", origin)).toBe(true);
  });

  it("其它一律拒绝：别的端口 / 主机 / 协议、localhost 别名、file、https 升级、解析失败", () => {
    for (const url of [
      "http://127.0.0.1:9999/x.png",
      "http://evil.example/p.png",
      "https://evil.example/p.png",
      "http://localhost:8876/mermaid-render", // 别名不放行：host 精确比较
      "https://127.0.0.1:8876/x", // 协议不同
      "wss://127.0.0.1:8876/x",
      "ws://127.0.0.1:9999/x",
      "ftp://127.0.0.1:8876/x",
      "file:///etc/passwd",
      "http://127.0.0.1:8876@evil.example/x", // userinfo 绕过：host 是 evil.example
      "http://evil.example/?u=http://127.0.0.1:8876/",
      "not a url",
      "",
    ]) {
      expect(isAllowedRenderRequest(url, origin), url).toBe(false);
    }
    expect(isAllowedRenderRequest(undefined as unknown as string, origin)).toBe(false);
    expect(isAllowedRenderRequest("http://127.0.0.1:8876/x", "garbage")).toBe(false);
  });

  it("origin 是 https 时：同端口 https / wss 放行，http 不放行", () => {
    expect(isAllowedRenderRequest("https://127.0.0.1:8876/x", "https://127.0.0.1:8876")).toBe(true);
    expect(isAllowedRenderRequest("wss://127.0.0.1:8876/x", "https://127.0.0.1:8876")).toBe(true);
    expect(isAllowedRenderRequest("http://127.0.0.1:8876/x", "https://127.0.0.1:8876")).toBe(false);
  });
});

describe("parseRenderRequest：校验 server 发来的报文", () => {
  it("合法请求 / 取消", () => {
    expect(parseRenderRequest({ v: 1, kind: "mermaid-render-req", id: 3, source: "graph TD; A-->B" })).toEqual({
      kind: "req",
      id: 3,
      source: "graph TD; A-->B",
    });
    expect(parseRenderRequest({ v: 1, kind: "mermaid-render-cancel", id: 3 })).toEqual({ kind: "cancel", id: 3 });
  });

  it("不属于本协议（版本 / kind / id 非整数 / 非对象）→ null（调用方直接忽略，不回包）", () => {
    for (const m of [
      null,
      undefined,
      "x",
      { v: 2, kind: "mermaid-render-req", id: 1, source: "a" },
      { v: 1, kind: "req", id: 1, source: "a" },
      { v: 1, kind: "hello" },
      { v: 1, kind: "mermaid-render-req", id: "1", source: "a" },
      { v: 1, kind: "mermaid-render-req", id: 1.5, source: "a" },
      { v: 1, kind: "mermaid-render-req", source: "a" },
    ]) {
      expect(parseRenderRequest(m)).toBeNull();
    }
  });

  it("源码为空 / 非字符串 / 过长 → bad-req（带原因，仍要回错误）", () => {
    expect(parseRenderRequest({ v: 1, kind: "mermaid-render-req", id: 1, source: "  " })).toMatchObject({ kind: "bad-req", id: 1 });
    expect(parseRenderRequest({ v: 1, kind: "mermaid-render-req", id: 1, source: 5 })).toMatchObject({ kind: "bad-req" });
    expect(parseRenderRequest({ v: 1, kind: "mermaid-render-req", id: 1, source: "x".repeat(MAX_SOURCE_CHARS + 1) })).toMatchObject({
      kind: "bad-req",
      message: expect.stringContaining("过长"),
    });
    expect(parseRenderRequest({ v: 1, kind: "mermaid-render-req", id: 1, source: "x".repeat(MAX_SOURCE_CHARS) })).toMatchObject({ kind: "req" });
  });
});

// ───────────────────────── 假 Electron ─────────────────────────

const PNG = Buffer.from("PNG-BYTES");

interface PageBehavior {
  /** `__flowshipMermaidRender` 的返回（可为函数以便按源码决定 / 挂起） */
  render: (source: string) => unknown | Promise<unknown>;
  loadURL: (url: string) => Promise<void>;
}

const makeEnv = () => {
  const behavior: PageBehavior = {
    render: () => ({ ok: true, width: 223, height: 502 }),
    loadURL: async () => undefined,
  };
  const windows: FakeWin[] = [];
  const logs: string[] = [];
  const sessionCalls = {
    onBeforeRequest: null as null | ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
    permissionRequest: null as null | ((...a: unknown[]) => void),
    permissionCheck: null as null | (() => boolean),
  };
  const debuggerLog: Array<{ method: string; params?: unknown }> = [];
  const scripts: string[] = [];

  class FakeWC extends EventEmitter {
    debugger = {
      attached: false,
      isAttached() {
        return this.attached;
      },
      attach() {
        this.attached = true;
      },
      detach() {
        this.attached = false;
      },
      sendCommand: async (method: string, params?: unknown) => {
        debuggerLog.push({ method, params });
        if (method === "Page.captureScreenshot") return { data: PNG.toString("base64") };
        return {};
      },
    };
    setWindowOpenHandler = vi.fn();
    setAudioMuted = vi.fn();
    executeJavaScript = async (code: string) => {
      scripts.push(code);
      if (code.includes("__flowshipMermaidReady")) return true;
      const m = /__flowshipMermaidRender\((.*)\)$/s.exec(code);
      if (m) return behavior.render(JSON.parse(m[1]!) as string);
      return undefined;
    };
  }
  class FakeWin extends EventEmitter {
    static opts: unknown[] = [];
    webContents = new FakeWC();
    destroyed = false;
    loadedUrl = "";
    constructor(opts: unknown) {
      super();
      FakeWin.opts.push(opts);
      windows.push(this);
    }
    loadURL(url: string) {
      this.loadedUrl = url;
      return behavior.loadURL(url);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  const session = {
    fromPartition: vi.fn(() => ({
      webRequest: {
        onBeforeRequest: (fn: typeof sessionCalls.onBeforeRequest) => {
          sessionCalls.onBeforeRequest = fn;
        },
      },
      setPermissionRequestHandler: (fn: typeof sessionCalls.permissionRequest) => {
        sessionCalls.permissionRequest = fn;
      },
      setPermissionCheckHandler: (fn: typeof sessionCalls.permissionCheck) => {
        sessionCalls.permissionCheck = fn;
      },
    })),
  };
  const renderer = createMermaidRenderer({
    BrowserWindow: FakeWin as never,
    session: session as never,
    getBaseUrl: () => "http://127.0.0.1:8876",
    log: (m) => logs.push(m),
  });
  const proc = Object.assign(new EventEmitter(), { connected: true as boolean, sent: [] as Array<Record<string, unknown>> });
  (proc as unknown as { send: unknown }).send = (msg: Record<string, unknown>, cb?: (e: Error | null) => void) => {
    proc.sent.push(msg);
    cb?.(null);
    return true;
  };
  renderer.attachServerProc(proc);
  const request = (id: number, source = "graph TD; A-->B") =>
    proc.emit("message", { v: 1, kind: "mermaid-render-req", id, source });
  const res = (id: number) =>
    proc.sent.find((m) => m.kind === "mermaid-render-res" && m.id === id) as ({ png: string } & Record<string, unknown>) | undefined;
  return { behavior, windows, FakeWin, logs, session, sessionCalls, debuggerLog, scripts, renderer, proc, request, res };
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createMermaidRenderer：调度与协议", () => {
  it("请求 → 先 ack、再返回 PNG(base64) 与尺寸；协议报文带 v:1", async () => {
    const e = makeEnv();
    e.request(1);
    await settle();
    expect(e.proc.sent[0]).toEqual({ v: 1, kind: "mermaid-render-ack", id: 1 });
    const r = e.res(1)!;
    expect(r).toMatchObject({ v: 1, kind: "mermaid-render-res", id: 1, ok: true, width: 223, height: 502 });
    expect(Buffer.from(r.png, "base64").toString()).toBe(PNG.toString());
    expect(e.windows).toHaveLength(1);
    expect(e.windows[0]!.loadedUrl).toBe(`http://127.0.0.1:8876${MERMAID_PAGE_PATH}`);
  });

  it("窗口安全配置：隐藏、sandbox、contextIsolation、无 nodeIntegration、独立内存会话、禁 devTools", async () => {
    const e = makeEnv();
    e.request(1);
    await settle();
    const opts = e.FakeWin.opts.at(-1) as { show: boolean; webPreferences: Record<string, unknown> };
    expect(opts.show).toBe(false);
    expect(opts.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: RENDER_PARTITION,
      devTools: false,
    });
    // 内存会话：partition 名不带 persist:
    expect(RENDER_PARTITION.startsWith("persist:")).toBe(false);
    expect(e.session.fromPartition).toHaveBeenCalledWith(RENDER_PARTITION);
  });

  it("会话网络白名单与权限：外部请求被取消、server 自己的放行；权限一律拒绝；弹窗 / 跳转被禁", async () => {
    const e = makeEnv();
    e.request(1);
    await settle();
    const decide = (url: string) => {
      let out: { cancel: boolean } | null = null;
      e.sessionCalls.onBeforeRequest!({ url }, (r) => (out = r));
      return out as unknown as { cancel: boolean };
    };
    expect(decide("http://127.0.0.1:8876/mermaid-render").cancel).toBe(false);
    expect(decide("https://evil.example/p.png").cancel).toBe(true);
    expect(decide("http://127.0.0.1:9999/x").cancel).toBe(true);
    const cb = vi.fn();
    e.sessionCalls.permissionRequest!(null, "geolocation", cb);
    expect(cb).toHaveBeenCalledWith(false);
    expect(e.sessionCalls.permissionCheck!()).toBe(false);
    const wc = e.windows[0]!.webContents;
    expect(wc.setWindowOpenHandler).toHaveBeenCalled();
    const handler = (wc.setWindowOpenHandler as unknown as { mock: { calls: Array<[() => unknown]> } }).mock.calls[0]![0];
    expect(handler()).toEqual({ action: "deny" });
    const nav = { preventDefault: vi.fn() };
    wc.emit("will-navigate", nav);
    expect(nav.preventDefault).toHaveBeenCalled();
  });

  it("截图走 CDP：先把视口设成图的尺寸（2 倍）、截完清除覆盖并分离调试器；渲染源码只作参数传入", async () => {
    const e = makeEnv();
    const src = '带"引号"和\n换行及 </script> 的源码';
    e.request(1, src);
    await settle();
    expect(e.debuggerLog.map((c) => c.method)).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Page.captureScreenshot",
      "Emulation.clearDeviceMetricsOverride",
    ]);
    expect(e.debuggerLog[0]!.params).toEqual({ width: 223, height: 502, deviceScaleFactor: 2, mobile: false });
    expect(e.windows[0]!.webContents.debugger.isAttached()).toBe(false);
    const call = e.scripts.find((s) => s.startsWith("window.__flowshipMermaidRender("))!;
    expect(call).toBe(`window.__flowshipMermaidRender(${JSON.stringify(src)})`);
    // 渲完清空舞台
    expect(e.scripts.some((s) => s.includes("__flowshipMermaidClear"))).toBe(true);
  });

  it("窗口复用：连续两个请求只建一个窗口、只加载一次页面", async () => {
    const e = makeEnv();
    const loads: string[] = [];
    const orig = e.behavior.loadURL;
    e.behavior.loadURL = async (u) => {
      loads.push(u);
      return orig(u);
    };
    e.request(1);
    await settle();
    e.request(2);
    await settle();
    expect(e.windows).toHaveLength(1);
    expect(loads).toHaveLength(1);
    expect(e.res(2)!.ok).toBe(true);
  });

  it("渲染页报错（语法错误等）→ ok:false RENDER_FAILED，带原因；窗口保留复用", async () => {
    const e = makeEnv();
    e.behavior.render = () => ({ ok: false, error: "Parse error on line 3" });
    e.request(1);
    await settle();
    expect(e.res(1)).toMatchObject({ ok: false, error: { code: "RENDER_FAILED", message: "Parse error on line 3" } });
    expect(e.windows[0]!.destroyed).toBe(false);
    // 页面返回畸形结果也不崩
    e.behavior.render = () => null;
    e.request(2);
    await settle();
    expect(e.res(2)).toMatchObject({ ok: false, error: { code: "RENDER_FAILED" } });
  });

  it("尺寸超限 → TOO_LARGE，不截图", async () => {
    const e = makeEnv();
    e.behavior.render = () => ({ ok: true, width: MAX_CSS_WIDTH + 100, height: 100 });
    e.request(1);
    await settle();
    expect(e.res(1)).toMatchObject({ ok: false, error: { code: "TOO_LARGE" } });
    expect(e.debuggerLog).toHaveLength(0);
  });

  it("截图结果体积过大：先降到 1 倍重截一次，仍超限才报 TOO_LARGE", async () => {
    const e = makeEnv();
    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    let shots = 0;
    const wcSend = e.windows.length; // 占位，窗口在首个请求时才建
    void wcSend;
    e.request(1);
    await settle();
    const dbg = e.windows[0]!.webContents.debugger;
    dbg.sendCommand = async (method: string, params?: unknown) => {
      e.debuggerLog.push({ method, params });
      if (method === "Page.captureScreenshot") {
        shots++;
        return { data: (shots === 1 ? big : Buffer.from("small")).toString("base64") };
      }
      return {};
    };
    e.debuggerLog.length = 0;
    e.request(2);
    await settle();
    // 第 2 个请求：2 倍超限 → 1 倍重截成功
    expect(e.res(2)).toMatchObject({ ok: true });
    const scales = e.debuggerLog.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").map((c) => (c.params as { deviceScaleFactor: number }).deviceScaleFactor);
    expect(scales).toEqual([2, 1]);
    // 两次都超限
    shots = -10;
    dbg.sendCommand = async (method: string) => (method === "Page.captureScreenshot" ? { data: big.toString("base64") } : {});
    e.request(3);
    await settle();
    expect(e.res(3)).toMatchObject({ ok: false, error: { code: "TOO_LARGE" } });
  });

  it("串行：第一个没渲完时第二个不会开始（共用一个窗口 / 舞台）", async () => {
    const e = makeEnv();
    let release: (v: unknown) => void = () => {};
    const started: string[] = [];
    e.behavior.render = (src) => {
      started.push(src);
      if (src === "first") return new Promise((r) => (release = r));
      return { ok: true, width: 10, height: 10 };
    };
    e.request(1, "first");
    e.request(2, "second");
    await settle();
    expect(started).toEqual(["first"]);
    expect(e.res(1)).toBeUndefined();
    release({ ok: true, width: 10, height: 10 });
    await settle();
    expect(started).toEqual(["first", "second"]);
    expect(e.res(1)!.ok).toBe(true);
    expect(e.res(2)!.ok).toBe(true);
    // 结果顺序 = 请求顺序
    const order = e.proc.sent.filter((m) => m.kind === "mermaid-render-res").map((m) => m.id);
    expect(order).toEqual([1, 2]);
  });

  it("取消：排队中的不回结果、也不渲染；正在渲染的结果被丢弃", async () => {
    const e = makeEnv();
    let release: (v: unknown) => void = () => {};
    const started: string[] = [];
    e.behavior.render = (src) => {
      started.push(src);
      if (src === "first") return new Promise((r) => (release = r));
      return { ok: true, width: 10, height: 10 };
    };
    e.request(1, "first");
    e.request(2, "queued");
    await settle();
    e.proc.emit("message", { v: 1, kind: "mermaid-render-cancel", id: 2 });
    e.proc.emit("message", { v: 1, kind: "mermaid-render-cancel", id: 1 });
    release({ ok: true, width: 10, height: 10 });
    await settle();
    expect(started).toEqual(["first"]);
    expect(e.res(1)).toBeUndefined();
    expect(e.res(2)).toBeUndefined();
  });

  it(`排队上限 ${MAX_QUEUE}：超出的请求立即回「排队过多」`, async () => {
    const e = makeEnv();
    e.behavior.render = () => new Promise(() => {}); // 第一个一直占着
    e.request(1);
    await settle();
    for (let i = 2; i <= 1 + MAX_QUEUE; i++) e.request(i);
    e.request(100);
    await settle();
    expect(e.res(100)).toMatchObject({ ok: false, error: { code: "RENDER_FAILED", message: expect.stringContaining("排队过多") } });
    expect(e.res(2)).toBeUndefined(); // 上限内的在排队
  });

  it("非法请求（空源码）：回 ack + 错误，不创建窗口", async () => {
    const e = makeEnv();
    e.request(1, "   ");
    await settle();
    expect(e.proc.sent[0]).toMatchObject({ kind: "mermaid-render-ack", id: 1 });
    expect(e.res(1)).toMatchObject({ ok: false });
    expect(e.windows).toHaveLength(0);
  });

  it("别的协议的消息（浏览器通道等）完全忽略：不回包、不建窗口", async () => {
    const e = makeEnv();
    e.proc.emit("message", { v: 1, kind: "hello" });
    e.proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "t", op: "navigate", args: {} });
    e.proc.emit("message", { v: 1, kind: "cancel", taskId: "t" });
    e.proc.emit("message", "garbage");
    await settle();
    expect(e.proc.sent).toHaveLength(0);
    expect(e.windows).toHaveLength(0);
  });
});

describe("createMermaidRenderer：失败与资源回收", () => {
  it("页面加载失败：回错误、销毁窗口；下一个请求重建窗口重试", async () => {
    const e = makeEnv();
    e.behavior.loadURL = async () => {
      throw new Error("ERR_CONNECTION_REFUSED");
    };
    e.request(1);
    await settle();
    expect(e.res(1)).toMatchObject({ ok: false, error: { code: "RENDER_FAILED", message: expect.stringContaining("ERR_CONNECTION_REFUSED") } });
    expect(e.windows[0]!.destroyed).toBe(true);
    e.behavior.loadURL = async () => undefined;
    e.request(2);
    await settle();
    expect(e.windows).toHaveLength(2);
    expect(e.res(2)!.ok).toBe(true);
  });

  it(`渲染卡死（超过 ${RENDER_CALL_TIMEOUT_MS / 1000}s）：回 TIMEOUT、销毁这扇不可信的窗口，队列继续`, async () => {
    const e = makeEnv();
    e.behavior.render = (src) => (src === "hang" ? new Promise(() => {}) : { ok: true, width: 10, height: 10 });
    e.request(1, "hang");
    e.request(2, "ok");
    await settle();
    await vi.advanceTimersByTimeAsync(RENDER_CALL_TIMEOUT_MS + 1);
    await settle();
    expect(e.res(1)).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(e.windows[0]!.destroyed).toBe(true);
    // 第二个请求用新窗口完成
    expect(e.res(2)!.ok).toBe(true);
    expect(e.windows).toHaveLength(2);
  });

  it("渲染进程崩溃：窗口被销毁，下个请求重建", async () => {
    const e = makeEnv();
    e.request(1);
    await settle();
    e.windows[0]!.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(e.windows[0]!.destroyed).toBe(true);
    e.request(2);
    await settle();
    expect(e.windows).toHaveLength(2);
    expect(e.res(2)!.ok).toBe(true);
  });

  it(`空闲 ${IDLE_DESTROY_MS / 1000}s 销毁窗口；新请求会重建；排队 / 渲染中不会被回收`, async () => {
    const e = makeEnv();
    e.request(1);
    await settle();
    expect(e.renderer._state()).toMatchObject({ hasWindow: true, running: false });
    await vi.advanceTimersByTimeAsync(IDLE_DESTROY_MS - 1000);
    expect(e.windows[0]!.destroyed).toBe(false);
    // 期间来了新请求：重新计时
    e.request(2);
    await settle();
    await vi.advanceTimersByTimeAsync(IDLE_DESTROY_MS - 1000);
    expect(e.windows[0]!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(e.windows[0]!.destroyed).toBe(true);
    expect(e.renderer._state().hasWindow).toBe(false);
    e.request(3);
    await settle();
    expect(e.windows).toHaveLength(2);
    expect(e.res(3)!.ok).toBe(true);
    // 收尾后不留定时器泄漏之外的东西：销毁后无待执行的空闲定时器
    e.renderer.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isRenderWindow：只认自己的窗口（main.js 的 hasUserWindows 据此排除）", async () => {
    const e = makeEnv();
    expect(e.renderer.isRenderWindow(null)).toBe(false);
    e.request(1);
    await settle();
    expect(e.renderer.isRenderWindow(e.windows[0])).toBe(true);
    expect(e.renderer.isRenderWindow({})).toBe(false);
  });

  it("destroy：销毁窗口、丢弃排队、之后的消息一律忽略", async () => {
    const e = makeEnv();
    e.behavior.render = () => new Promise(() => {});
    e.request(1);
    e.request(2);
    await settle();
    e.renderer.destroy();
    expect(e.windows[0]!.destroyed).toBe(true);
    const sentBefore = e.proc.sent.length;
    e.request(3);
    await settle();
    expect(e.proc.sent).toHaveLength(sentBefore);
    expect(e.renderer._state()).toMatchObject({ queued: 0 });
  });

  it("server 进程退出：它排队中的请求作废（不白渲染）", async () => {
    const e = makeEnv();
    let release: (v: unknown) => void = () => {};
    const started: string[] = [];
    e.behavior.render = (src) => {
      started.push(src);
      return src === "first" ? new Promise((r) => (release = r)) : { ok: true, width: 10, height: 10 };
    };
    e.request(1, "first");
    e.request(2, "queued");
    await settle();
    e.proc.emit("exit", 1, null);
    release({ ok: true, width: 10, height: 10 });
    await settle();
    expect(started).toEqual(["first"]);
  });

  it("proc 已断开（connected=false）：不抛、不回包", async () => {
    const e = makeEnv();
    e.proc.connected = false;
    e.request(1);
    await settle();
    expect(e.proc.sent).toHaveLength(0);
  });
});

describe("联调：真实的 server 侧客户端 ⇄ 主进程服务", () => {
  const wire = () => {
    const e = makeEnv();
    const handlers = new Set<(m: unknown) => void>();
    // 主进程 → server：proc.send 的报文交给客户端的监听
    (e.proc as unknown as { send: unknown }).send = (msg: unknown, cb?: (err: Error | null) => void) => {
      queueMicrotask(() => handlers.forEach((h) => h(JSON.parse(JSON.stringify(msg)))));
      cb?.(null);
      return true;
    };
    // server → 主进程
    const transport: BridgeTransport = {
      send: (msg) => {
        queueMicrotask(() => e.proc.emit("message", JSON.parse(JSON.stringify(msg))));
        return true;
      },
      onMessage: (cb) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
      onDisconnect: () => () => {},
      isOpen: () => true,
    };
    return { e, client: createMermaidRenderClient(transport) };
  };

  it("render() 拿到 Buffer 与尺寸（报文经 JSON 往返，与真 IPC 同形）", async () => {
    const { e, client } = wire();
    const p = client.render("graph TD; A-->B", { timeoutMs: 60_000 });
    await settle();
    const out = await p;
    expect(out.png.toString()).toBe(PNG.toString());
    expect(out.width).toBe(223);
    expect(out.height).toBe(502);
    expect(e.windows).toHaveLength(1);
  });

  it("主进程报错 → 客户端抛对应 code", async () => {
    const { e, client } = wire();
    e.behavior.render = () => ({ ok: true, width: MAX_CSS_WIDTH + 1, height: 10 });
    const p = client.render("graph TD; A-->B", { timeoutMs: 60_000 });
    p.catch(() => {});
    await settle();
    await expect(p).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("客户端取消 → 主进程丢弃排队中的请求", async () => {
    const { e, client } = wire();
    let release: (v: unknown) => void = () => {};
    const started: string[] = [];
    e.behavior.render = (src) => {
      started.push(src);
      return src === "first" ? new Promise((r) => (release = r)) : { ok: true, width: 10, height: 10 };
    };
    const p1 = client.render("first", { timeoutMs: 60_000 });
    const ac = new AbortController();
    const p2 = client.render("second", { timeoutMs: 60_000, signal: ac.signal });
    p1.catch(() => {});
    p2.catch(() => {});
    await settle();
    ac.abort();
    await settle();
    release({ ok: true, width: 10, height: 10 });
    await settle();
    await expect(p2).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(p1).resolves.toBeTruthy();
    expect(started).toEqual(["first"]);
  });
});

// ───────────────────────── 接线契约（源码文本） ─────────────────────────

describe("接线契约", () => {
  it("main.js：创建渲染器、对每个新 server 进程挂上、渲染窗口不算用户窗口、will-quit 销毁", () => {
    const main = stripComments(read("electron-app/main.js"));
    expect(main).toMatch(/import \{ createMermaidRenderer \} from "\.\/mermaid-render\.mjs";/);
    expect(main).toMatch(/const mermaidRenderer = createMermaidRenderer\(\{[\s\S]*?BrowserWindow,[\s\S]*?session,[\s\S]*?getBaseUrl: \(\) => BASE_URL/);
    // 挂载在 startServer 里、紧跟浏览器通道，且被 try/catch 包住（挂失败不挡 server 启动）
    expect(main).toMatch(/browserManager\.attachServerChannel\(proc\);[\s\S]*?\} catch[\s\S]*?try \{\s*mermaidRenderer\.attachServerProc\(proc\);\s*\} catch/);
    // hasUserWindows 排除渲染窗口
    expect(main).toMatch(/hasUserWindows = \(\) =>[\s\S]*?!browserManager\.isParkingWindow\(w\)[\s\S]*?!mermaidRenderer\.isRenderWindow\(w\)/);
    // 不可逆的 destroy 放 will-quit（与 browserManager 同位）
    expect(main).toMatch(/app\.on\("will-quit"[\s\S]*?browserManager\.destroy\(\);[\s\S]*?mermaidRenderer\.destroy\(\);/);
  });

  it("server-channel：mermaid-render-* 是另一套协议，不当未知 kind 刷日志（其余未知 kind 仍记日志）", () => {
    const ch = read("electron-app/browser/server-channel.mjs");
    expect(ch).toMatch(/msg\.kind\.startsWith\("mermaid-render-"\)\) return;[\s\S]*?忽略未知 kind=/);
  });

  it("outbound finalize：先 Mermaid 出图、再换本地图片；出图结果喂给后者，上传函数共用同一个注入点", () => {
    const out = read("src/lib/server/feishu-bridge/outbound.ts");
    const finalizeStart = out.indexOf("renderMermaidForFeishu(turn.answerText");
    const replaceCall = out.indexOf("replaceLocalImagesInMarkdown(\n        withDiagrams");
    expect(finalizeStart).toBeGreaterThan(0);
    expect(replaceCall).toBeGreaterThan(finalizeStart);
    expect(out).toMatch(/renderMermaidForFeishu\(turn\.answerText, \{[\s\S]*?upload: uploadImageImpl,[\s\S]*?remainingBudgetMs: budgetDeadline - monoNow\(\)/);
    expect(out).toMatch(/import \{ renderMermaidForFeishu \} from "\.\/mermaid-outbound";/);
  });

  it("根 layout 经 AppFrame 套外壳；AppFrame 对裸路由只渲染页面本身，普通页面仍是 Providers > AppShell + Toaster", () => {
    const layout = stripComments(read("src/app/layout.tsx"));
    expect(layout).toMatch(/<AppFrame>\{children\}<\/AppFrame>/);
    expect(layout).not.toMatch(/<Providers>|<AppShell>|<Toaster/);
    const frame = stripComments(read("src/components/app-frame.tsx"));
    expect(frame).toMatch(/if \(isBareRoute\(pathname\)\) return <>\{children\}<\/>;/);
    expect(frame).toMatch(/<Providers>\s*<AppShell>\{children\}<\/AppShell>[\s\S]*?<Toaster position="top-center" offset=\{64\} \/>\s*<\/Providers>/);
  });

  it("裸路由表：只有 /mermaid-render；精确 + 子路径匹配，前缀碰撞不算", () => {
    expect([...BARE_ROUTES]).toEqual([MERMAID_PAGE_PATH]);
    expect(isBareRoute("/mermaid-render")).toBe(true);
    expect(isBareRoute("/mermaid-render/")).toBe(true);
    expect(isBareRoute("/mermaid-render/x")).toBe(true);
    for (const p of ["/", "/settings", "/tasks/t_1", "/mermaid-render-foo", "/x/mermaid-render", "", null, undefined]) {
      expect(isBareRoute(p as string), String(p)).toBe(false);
    }
  });

  it("渲染页与聊天页同一套安全：用 gated 插件 + MERMAID_SAFE_CONFIG；页面本身不套 Providers / AppShell", () => {
    const lib = stripComments(read("src/lib/mermaid-image-render.ts"));
    expect(lib).toMatch(/createGatedMermaidPlugin\(createMermaidPlugin\(\{ config: MERMAID_SAFE_CONFIG \}\)\)/);
    expect(lib).toMatch(/GATED\.getMermaid\(IMAGE_CONFIG\)\.render\(/);
    // 不绕过闸门直接用上游的 mermaid 单例
    expect(lib).not.toMatch(/from "mermaid"/);
    expect(lib).not.toMatch(/import \{[^}]*\bmermaid\b[^}]*\} from "@streamdown\/mermaid"/);
    const page = stripComments(read("src/app/mermaid-render/page.tsx"));
    expect(page).toMatch(/installMermaidImageRenderer\(stage\)/);
    expect(page).not.toMatch(/Providers|AppShell/);
    // 页面契约：主进程依赖的三个全局
    for (const g of ["__flowshipMermaidReady", "__flowshipMermaidRender", "__flowshipMermaidClear"]) {
      expect(lib).toContain(g);
      expect(read("electron-app/mermaid-render.mjs")).toContain(g);
    }
  });

  it("渲染服务源码：窗口隔离项不被改松（sandbox / contextIsolation / 无 nodeIntegration / 内存会话 / 网络白名单）", () => {
    const src = stripComments(read("electron-app/mermaid-render.mjs"));
    expect(src).toMatch(/sandbox: true/);
    expect(src).toMatch(/contextIsolation: true/);
    expect(src).toMatch(/nodeIntegration: false/);
    expect(src).not.toMatch(/nodeIntegration: true|contextIsolation: false|sandbox: false|webSecurity: false/);
    expect(src).toMatch(/ses\.webRequest\.onBeforeRequest\(/);
    expect(src).toMatch(/isAllowedRenderRequest\(details\.url, origin\(\)\)/);
    expect(src).toMatch(/show: false/);
    expect(src).not.toMatch(/persist:/);
  });

  it("server 侧客户端：只经 bridge 的进程传输（不另开 process.on('message')）", () => {
    const src = stripComments(read("src/lib/server/mermaid-render.ts"));
    expect(src).toMatch(/getProcessTransport\(\)/);
    expect(src).not.toMatch(/process\.on\(/);
    expect(src).not.toMatch(/process\.send/);
  });
});
