/* eslint-disable @typescript-eslint/no-explicit-any -- 假 electron 对象 / 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * E2·P4（S3：A5 网络规则 + B1 网络增强）单测夹具：**真实** BrowserSession + **真实** BrowserTab（假 WebContentsView / 假 debugger）
 * + 真实 `ops/net-rules.mjs` handlers。
 *
 * 为什么不用假 tab：规则运行时的核心契约（`tab.onCdpEvent` 的事件分发、`addSessionHook` 在 debugger 重连 / OOPIF 子会话上的重放、
 * `getExt` 的 dispose、`#flushNet` 对 ruled 标记的处理）都在真 tab 里；`runAction` 的串行 / USER_CONTROL / 活动日志口径在真 session 里。
 * 假的只有最外面一层：debugger.sendCommand 由测试脚本化应答，页面事件由 `emit` 注入。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

import { createActivityLog } from "../../electron-app/browser/activity-log.mjs";
import { OP_HELPERS } from "../../electron-app/browser/index.mjs";
import { createHandlers, normalize } from "../../electron-app/browser/ops/net-rules.mjs";
import { BrowserError } from "../../electron-app/browser/server-channel.mjs";
import { BrowserSession } from "../../electron-app/browser/session.mjs";
import { BrowserTab } from "../../electron-app/browser/tab.mjs";

export { BrowserError };

export interface SentCmd {
  method: string;
  params: Record<string, any>;
  sessionId: string | null;
}

export interface P4EnvOptions {
  taskId?: string;
  /** 页面 URL（getURL 返回） */
  url?: string;
  /** 设置：默认 networkBodyRead 开 */
  config?: Record<string, unknown>;
  /** isAppUrl 判定（默认：host 为 flowship.local 或端口 8876 的 localhost 视为应用自身） */
  isAppUrl?: (u: string) => boolean;
  /** CDP 应答脚本：method → (params, sessionId) => result */
  cdp?: Record<string, (params: Record<string, any>, sessionId: string | null) => unknown>;
  now?: () => number;
}

/** 测试里的「应用自身」判定：不依赖端口配置，用固定主机名，避免和真实 8676/8776/8876 端口扯上关系 */
export const defaultIsAppUrl = (u: string): boolean => {
  try {
    const x = new URL(u);
    return x.hostname === "flowship.local" || (x.hostname === "localhost" && x.port === "18876");
  } catch {
    return false;
  }
};

export const makeP4Env = async (opts: P4EnvOptions = {}) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "p4-net-"));
  const taskId = opts.taskId ?? "task-p4";
  const pageUrl = opts.url ?? "https://example.com/";
  const isAppUrl = opts.isAppUrl ?? defaultIsAppUrl;

  const sent: SentCmd[] = [];
  const cdp: Record<string, (params: Record<string, any>, sessionId: string | null) => unknown> = { ...(opts.cdp ?? {}) };
  let attached = false;
  let onMessage: (e: unknown, method: string, params: Record<string, any>, sessionId?: string) => void = () => {};
  const dbg = {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    on: (ev: string, fn: never) => {
      if (ev === "message") onMessage = fn;
    },
    sendCommand: vi.fn(async (method: string, params: Record<string, any> = {}, sessionId?: string) => {
      sent.push({ method, params, sessionId: sessionId ?? null });
      const h = cdp[method];
      if (h) return h(params, sessionId ?? null);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      return {};
    }),
  };
  const wc: any = {
    debugger: dbg,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setAudioMuted: vi.fn(),
    loadURL: vi.fn(async () => {}),
    getURL: () => pageUrl,
    getTitle: () => "示例",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    close: vi.fn(),
    isDestroyed: () => false,
    session: {},
  };
  class FakeView {
    webContents = wc;
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
  }
  const mainWin = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
  const parkingWin = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
  const stateContributors: Array<(s: any) => Record<string, unknown>> = [];
  const exts = new Map<string, (s: any, args?: any) => Promise<unknown>>();
  const host: any = {
    createTab: ({ id, hooks }: { id: string; hooks: unknown }) =>
      new BrowserTab({
        id,
        WebContentsView: FakeView as never,
        parkingWindow: parkingWin,
        pageScripts: { PAGE_WORLD_NAME: "flowship", RECORDER_BINDING: "__rec", buildPageScript: () => "//" } as never,
        isAppUrl,
        hooks,
      } as any),
    getMainWindow: () => mainWin,
    getParkingWindow: () => parkingWin,
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: vi.fn(),
    stateContributors,
  };
  const activityLog = createActivityLog();
  const session = new BrowserSession({ taskId, host, activityLog, graceMs: 8_000, now: opts.now ?? (() => 1_000) });
  const tab: any = await session.openTab({});
  await tab.ready;

  const cfg: Record<string, unknown> = { evaluateEnabled: false, networkBodyRead: true, ...(opts.config ?? {}) };
  const scheduleState = vi.fn();
  const handlers: any = createHandlers({
    requireSession: () => session,
    getConfig: () => cfg,
    abortable: (p: Promise<unknown>) => p,
    scheduleState,
    app: { getPath: () => userData },
    electron: { isAppUrl },
    addStateContributor: (fn: (s: any) => Record<string, unknown>) => {
      stateContributors.push(fn);
      return () => {};
    },
    registerExt: (name: string, fn: (s: any, args?: any) => Promise<unknown>) => {
      exts.set(name, fn);
    },
    log: () => {},
    ...(opts.now ? { now: opts.now } : {}),
  } as any);

  const emit = (method: string, params: Record<string, any>, sessionId?: string) => onMessage(null, method, params, sessionId);
  const norm = (op: string, args: Record<string, unknown>) => normalize(op, args, OP_HELPERS as any) as Record<string, unknown>;
  /** normalize + handler：与真实 dispatch 的顺序一致 */
  const call = async (op: "net_rules" | "net_export", args: Record<string, unknown>): Promise<any> => handlers[op](taskId, norm(op, args));
  const rules = (args: Record<string, unknown>) => call("net_rules", args);

  /** 发出一个 `Fetch.requestPaused`（请求阶段）；返回 CDP 事件载荷 */
  let seq = 0;
  const pause = (o: { url: string; method?: string; headers?: Record<string, string>; networkId?: string; requestId?: string; sessionId?: string }) => {
    const requestId = o.requestId ?? `fetch-${++seq}`;
    const params = {
      requestId,
      networkId: o.networkId ?? `net-${seq}`,
      request: { url: o.url, method: o.method ?? "GET", headers: o.headers ?? { Accept: "*/*" } },
      resourceType: "Fetch",
    };
    emit("Fetch.requestPaused", params, o.sessionId);
    return params;
  };

  /** 已发出的某类 CDP 命令 */
  const cmds = (method: string) => sent.filter((c) => c.method === method);
  const lastCmd = (method: string) => cmds(method).at(-1);
  /** 让微任务 / 已排队的 Promise 链跑完 */
  const settle = async (n = 6) => {
    for (let i = 0; i < n; i += 1) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  };

  /** 一个完整请求（发起 → 响应 → 完成）进网络环 */
  let ts = 100;
  const request = (rid: string, o: { url?: string; method?: string; status?: number; mime?: string; type?: string; sessionId?: string } = {}) => {
    emit(
      "Network.requestWillBeSent",
      {
        requestId: rid,
        timestamp: ts,
        type: o.type ?? "Fetch",
        request: { url: o.url ?? `https://a.test/${rid}`, method: o.method ?? "GET", headers: { Accept: "*/*" } },
      },
      o.sessionId,
    );
    emit("Network.responseReceived", { requestId: rid, type: o.type ?? "Fetch", response: { status: o.status ?? 200, mimeType: o.mime ?? "application/json", headers: { "X-Req": rid } } }, o.sessionId);
    ts += 0.05;
    emit("Network.loadingFinished", { requestId: rid, timestamp: ts }, o.sessionId);
  };

  return {
    userData,
    harDir: path.join(userData, "data", "tasks", taskId, "browser-har"),
    taskId,
    session,
    tab,
    wc,
    dbg,
    sent,
    cdp,
    cfg,
    handlers,
    stateContributors,
    exts,
    scheduleState,
    activityLog,
    emit,
    norm,
    call,
    rules,
    pause,
    request,
    cmds,
    lastCmd,
    settle,
    isAppUrl,
    /** 当前所有 AI 活动条目的摘要 */
    activitySummaries: (): string[] => (session.getState().recent as Array<{ actor: string; summary?: string }>).filter((e) => e.actor === "ai").map((e) => e.summary ?? ""),
    /** session.getState() 的 JSON（检查「状态里不含凭据」） */
    stateJson: () => JSON.stringify(session.getState()),
    cleanup: () => {
      try {
        session.destroy?.();
      } catch {
        /* 清理不抛 */
      }
      fs.rmSync(userData, { recursive: true, force: true });
    },
  };
};

export type P4Env = Awaited<ReturnType<typeof makeP4Env>>;
