/**
 * 电脑操作（desktop.v1）与内置浏览器管理器的接线（electron-app/browser/index.mjs）。
 *
 * 电脑操作没有自己的 server 通道：它挂在内置浏览器那条 Node ipc 上。这里钉死挂接处的行为——
 * - 能力协商：传了 desktop 才在 hello-ack 里报 desktop.v1；没传时 desktop_* 请求当未知 op 拒绝（不会漏到浏览器引擎里）
 * - 请求分流：desktop_* 交给 desktop.handleOp（原样带 taskId / signal），浏览器的 op 照旧走浏览器
 * - 生命周期联动：config / cancel 同时通知两边；通道关闭 → 事件出口先摘、再 fail-closed；新通道替换旧通道时顺序正确
 * - desktop 一方抛异常不影响浏览器一方
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createBrowserManager } from "../electron-app/browser/index.mjs";
import { DesktopError } from "../electron-app/desktop/types.mjs";

type Msg = Record<string, unknown>;

class FakeProc extends EventEmitter {
  sent: Msg[] = [];
  connected = true;
  send(msg: Msg, cb?: (err?: Error) => void) {
    JSON.stringify(msg);
    this.sent.push(msg);
    cb?.();
    return true;
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));

const makeDesktop = () => {
  let sink: ((name: string, taskId: string, data: unknown) => unknown) | null = null;
  const calls: string[] = [];
  const desktop = {
    capabilities: () => ["desktop.v1"],
    isDesktopOp: (op: string) => typeof op === "string" && op.startsWith("desktop_"),
    handleOp: vi.fn(async (op: string, args: object, ctx: { taskId: string; signal?: AbortSignal }) => {
      void ctx;
      if (op === "desktop_boom") throw new DesktopError("ACCESS_DISABLED", "没开");
      if (op === "desktop_crash") throw new Error("内部炸了");
      return { handled: op, args };
    }),
    onConfig: vi.fn((cfg: object) => {
      void cfg;
      calls.push("config");
    }),
    onCancel: vi.fn((taskId: string) => {
      void taskId;
      calls.push("cancel");
    }),
    onTaskClosed: vi.fn((taskId: string) => {
      void taskId;
      calls.push("closed");
    }),
    onServerGone: vi.fn(() => {
      calls.push(sink === null ? "gone(sink已摘)" : "gone(sink还在)");
    }),
    setEventSink: vi.fn((fn: typeof sink) => {
      sink = fn;
      calls.push(fn ? "sink+" : "sink-");
    }),
    emit: (name: string, taskId: string, data: unknown) => sink?.(name, taskId, data),
    hasSink: () => sink !== null,
    calls,
  };
  return desktop;
};

const makeManager = (desktop?: ReturnType<typeof makeDesktop> | null) => {
  const log = vi.fn();
  const manager = createBrowserManager({
    app: { getPath: () => "/tmp" },
    BrowserWindow: class {},
    WebContentsView: class {},
    session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() }) },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
    getMainWindow: () => null,
    isAppUrl: () => false,
    isTrustedIpcSender: () => true,
    log,
    startPicker: () => ({ cancel() {} }),
    ...(desktop === undefined ? {} : { desktop }),
  } as never);
  return { manager, log };
};

const attach = (manager: ReturnType<typeof makeManager>["manager"]) => {
  const proc = new FakeProc();
  manager.attachServerChannel(proc as never);
  return proc;
};

const resOf = (proc: FakeProc, id: number) => proc.sent.find((m) => m.kind === "res" && m.id === id);

describe("能力协商", () => {
  it("传了 desktop：hello-ack 同时报 browser.v1 与 desktop.v1", () => {
    const { manager } = makeManager(makeDesktop());
    const proc = attach(manager);
    proc.emit("message", { v: 1, kind: "hello" });
    expect(proc.sent[0]).toMatchObject({ kind: "hello-ack", capabilities: ["browser.v1", "desktop.v1"] });
  });

  it("没传 desktop（null / 缺省）：只报 browser.v1；desktop_* 请求当未知 op 拒绝，不会进浏览器引擎", async () => {
    for (const d of [undefined, null]) {
      const { manager } = makeManager(d);
      const proc = attach(manager);
      proc.emit("message", { v: 1, kind: "hello" });
      expect(proc.sent[0]).toMatchObject({ capabilities: ["browser.v1"] });
      proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "T1", op: "desktop_screenshot", args: {} });
      await flush();
      expect(resOf(proc, 1)).toMatchObject({ ok: false, error: { code: "BAD_ARGS" } });
    }
  });
});

describe("请求分流", () => {
  it("desktop_* 交给 desktop.handleOp，带 taskId 与可中止的 signal，结果原样回给 server", async () => {
    const desktop = makeDesktop();
    const { manager } = makeManager(desktop);
    const proc = attach(manager);
    proc.emit("message", { v: 1, kind: "req", id: 7, taskId: "T9", op: "desktop_click", args: { x: 1, y: 2 } });
    await flush();
    expect(desktop.handleOp).toHaveBeenCalledTimes(1);
    const [op, args, ctx] = desktop.handleOp.mock.calls[0];
    expect(op).toBe("desktop_click");
    expect(args).toEqual({ x: 1, y: 2 });
    expect(ctx.taskId).toBe("T9");
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(resOf(proc, 7)).toMatchObject({ ok: true, result: { handled: "desktop_click", args: { x: 1, y: 2 } } });
  });

  it("DesktopError 的错误码原样到 server；普通异常折成 INTERNAL（不带栈）", async () => {
    const { manager } = makeManager(makeDesktop());
    const proc = attach(manager);
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "T1", op: "desktop_boom", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "T1", op: "desktop_crash", args: {} });
    await flush();
    expect(resOf(proc, 1)).toMatchObject({ ok: false, error: { code: "ACCESS_DISABLED", message: "没开" } });
    expect(resOf(proc, 2)).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  it("浏览器自己的 op 不受影响：照旧走浏览器（status 不建会话）", async () => {
    const desktop = makeDesktop();
    const { manager } = makeManager(desktop);
    const proc = attach(manager);
    proc.emit("message", { v: 1, kind: "req", id: 3, taskId: "T1", op: "status", args: {} });
    await flush();
    expect(resOf(proc, 3)).toMatchObject({ ok: true, result: { exists: false } });
    expect(desktop.handleOp).not.toHaveBeenCalled();
  });
});

describe("生命周期联动", () => {
  it("config：浏览器与 desktop 都收到；desktop 抛错只记日志，不影响浏览器一方", () => {
    const desktop = makeDesktop();
    desktop.onConfig.mockImplementationOnce(() => {
      throw new Error("desktop 炸了");
    });
    const { manager, log } = makeManager(desktop);
    const proc = attach(manager);
    expect(() => proc.emit("message", { v: 1, kind: "config", desktopEnabled: true, desktopLockedAccess: false, evaluateEnabled: true })).not.toThrow();
    expect(desktop.onConfig).toHaveBeenCalledWith({ desktopEnabled: true, desktopLockedAccess: false, evaluateEnabled: true });
    expect(log.mock.calls.some(([m]) => String(m).includes("[desktop] config 处理异常"))).toBe(true);
    // 抛错之后通道还活着：下一条 config 照常送到 desktop
    proc.emit("message", { v: 1, kind: "config", desktopEnabled: false });
    expect(desktop.onConfig).toHaveBeenLastCalledWith({ desktopEnabled: false });
  });

  it("cancel（任务级）：浏览器与 desktop 都收到；desktop 抛错只记日志", () => {
    const desktop = makeDesktop();
    desktop.onCancel.mockImplementationOnce(() => {
      throw new Error("cancel 炸了");
    });
    const { manager, log } = makeManager(desktop);
    const proc = attach(manager);
    expect(() => proc.emit("message", { v: 1, kind: "cancel", taskId: "T1" })).not.toThrow();
    expect(desktop.onCancel).toHaveBeenCalledWith("T1");
    expect(log.mock.calls.some(([m]) => String(m).includes("[desktop] cancel 处理异常"))).toBe(true);
  });

  it("cancel 带 id（单请求超时取消）：不触发 desktop.onCancel——那是整任务被停的语义，会把会话收掉", () => {
    const desktop = makeDesktop();
    const { manager } = makeManager(desktop);
    const proc = attach(manager);
    proc.emit("message", { v: 1, kind: "cancel", taskId: "T1", id: 5 });
    expect(desktop.onCancel).not.toHaveBeenCalled();
  });

  it("close_session（任务被删 / 归档）：同时通知 desktop 结束该任务的电脑操作会话；浏览器一方照常应答", async () => {
    const desktop = makeDesktop();
    const { manager } = makeManager(desktop);
    const proc = attach(manager);
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "T1", op: "close_session", args: {} });
    await flush();
    expect(desktop.onTaskClosed).toHaveBeenCalledTimes(1);
    expect(desktop.onTaskClosed).toHaveBeenCalledWith("T1");
    expect(resOf(proc, 1)).toMatchObject({ ok: true });
    // 不是 close_session 的请求不会触发它
    proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "T1", op: "status", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 3, taskId: "T1", op: "desktop_screenshot", args: {} });
    await flush();
    expect(desktop.onTaskClosed).toHaveBeenCalledTimes(1);
  });

  it("close_session 联动里 desktop 抛错：只记日志，浏览器会话照样清理、server 照样收到成功应答", async () => {
    const desktop = makeDesktop();
    desktop.onTaskClosed.mockImplementationOnce(() => {
      throw new Error("联动炸了");
    });
    const { manager, log } = makeManager(desktop);
    const proc = attach(manager);
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "T1", op: "close_session", args: {} });
    await flush();
    expect(resOf(proc, 1)).toMatchObject({ ok: true });
    expect(log.mock.calls.some(([m]) => String(m).includes("[desktop] close_session 联动结束会话异常"))).toBe(true);
  });

  it("没有 desktop / desktop 没有 onTaskClosed（旧实现）：close_session 照常，不报错", async () => {
    const { manager, log } = makeManager(null);
    const proc = attach(manager);
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "T1", op: "close_session", args: {} });
    await flush();
    expect(resOf(proc, 1)).toMatchObject({ ok: true });

    const old = makeDesktop() as Partial<ReturnType<typeof makeDesktop>>;
    delete old.onTaskClosed;
    const { manager: m2 } = makeManager(old as ReturnType<typeof makeDesktop>);
    const proc2 = attach(m2);
    proc2.emit("message", { v: 1, kind: "req", id: 2, taskId: "T1", op: "close_session", args: {} });
    await flush();
    expect(resOf(proc2, 2)).toMatchObject({ ok: true });
    expect(log.mock.calls.filter(([m]) => String(m).includes("[desktop]"))).toEqual([]);
  });

  it("接上通道时安装事件出口；desktop 的事件经通道以 evt 推给 server", () => {
    const desktop = makeDesktop();
    const { manager } = makeManager(desktop);
    const proc = attach(manager);
    expect(desktop.hasSink()).toBe(true);
    desktop.emit("desktop_session", "T1", { kind: "unlocked" });
    expect(proc.sent).toContainEqual({ v: 1, kind: "evt", name: "desktop_session", taskId: "T1", data: { kind: "unlocked" } });
  });

  it.each(["exit", "disconnect"])("server %s：先摘事件出口、再 fail-closed（onServerGone 时出口已经没了）", (ev) => {
    const desktop = makeDesktop();
    const { manager } = makeManager(desktop);
    const proc = attach(manager);
    desktop.calls.length = 0;
    proc.emit(ev);
    expect(desktop.calls).toEqual(["sink-", "gone(sink已摘)"]);
    expect(desktop.hasSink()).toBe(false);
    proc.emit(ev);
    expect(desktop.onServerGone).toHaveBeenCalledTimes(1);
  });

  it("新通道替换旧通道（server 重启）：旧通道先 fail-closed，再给新通道装出口；旧 proc 之后退出不会误伤新通道", () => {
    const desktop = makeDesktop();
    const { manager } = makeManager(desktop);
    const oldProc = attach(manager);
    desktop.calls.length = 0;
    const newProc = attach(manager);
    expect(desktop.calls).toEqual(["sink-", "gone(sink已摘)", "sink+"]);
    expect(desktop.hasSink()).toBe(true);
    oldProc.emit("exit");
    expect(desktop.onServerGone).toHaveBeenCalledTimes(1);
    expect(desktop.hasSink()).toBe(true);
    desktop.emit("desktop_session", "T2", { kind: "relocked" });
    expect(newProc.sent.at(-1)).toMatchObject({ kind: "evt", name: "desktop_session", taskId: "T2" });
    expect(oldProc.sent.some((m) => m.kind === "evt")).toBe(false);
  });

  it("通道关闭回调里 desktop 抛错：只记日志，不外抛", () => {
    const desktop = makeDesktop();
    desktop.onServerGone.mockImplementationOnce(() => {
      throw new Error("收尾炸了");
    });
    const { manager, log } = makeManager(desktop);
    const proc = attach(manager);
    expect(() => proc.emit("exit")).not.toThrow();
    expect(log.mock.calls.some(([m]) => String(m).includes("[desktop] 通道关闭处理异常"))).toBe(true);
  });

  it("没有 desktop 时通道关闭 / config / cancel 照常工作，不会碰 desktop 的任何东西（日志里也没有 desktop 的异常噪音）", () => {
    const { manager, log } = makeManager(null);
    const proc = attach(manager);
    expect(() => {
      proc.emit("message", { v: 1, kind: "config", desktopEnabled: true });
      proc.emit("message", { v: 1, kind: "cancel", taskId: "T1" });
      proc.emit("exit");
    }).not.toThrow();
    expect(log.mock.calls.filter(([m]) => String(m).includes("[desktop]"))).toEqual([]);
  });
});
