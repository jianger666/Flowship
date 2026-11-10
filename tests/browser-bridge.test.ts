/**
 * 内置浏览器 IPC 客户端（bridge.ts）：握手 / 配对 / 超时 / 取消 / 断线 / 事件。
 * 用假传输层，不碰真实 process.send（vitest worker 里 process.send 其实存在，所以真实通道在 VITEST 下被禁用，见下方用例）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_DEFAULT_REQUEST_TIMEOUT_MS,
  BROWSER_HANDSHAKE_TIMEOUT_MS,
  __setBrowserBridgeForTest,
  cancelBrowserTask,
  closeBrowserSession,
  createBrowserBridge,
  getBrowserBridge,
  isBrowserBridgeAvailable,
  type BridgeTransport,
} from "@/lib/server/browser/bridge";
import { BrowserBridgeError } from "@/lib/server/browser/types";

interface FakeTransport extends BridgeTransport {
  sent: Array<Record<string, unknown>>;
  emit: (msg: unknown) => void;
  disconnect: () => void;
  open: boolean;
  listenerCount: () => number;
}

const makeTransport = (): FakeTransport => {
  const msgSubs = new Set<(m: unknown) => void>();
  const discSubs = new Set<() => void>();
  const t: FakeTransport = {
    sent: [],
    open: true,
    send: (msg) => {
      if (!t.open) return false;
      t.sent.push(msg as Record<string, unknown>);
      return true;
    },
    onMessage: (cb) => {
      msgSubs.add(cb);
      return () => msgSubs.delete(cb);
    },
    onDisconnect: (cb) => {
      discSubs.add(cb);
      return () => discSubs.delete(cb);
    },
    isOpen: () => t.open,
    emit: (m) => [...msgSubs].forEach((cb) => cb(m)),
    disconnect: () => {
      t.open = false;
      [...discSubs].forEach((cb) => cb());
    },
    listenerCount: () => msgSubs.size + discSubs.size,
  };
  return t;
};

const ack = { v: 1, kind: "hello-ack", capabilities: ["browser.v1"] };
const reqs = (t: FakeTransport) => t.sent.filter((m) => m.kind === "req");

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  __setBrowserBridgeForTest(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const readyBridge = (opts: Parameters<typeof createBrowserBridge>[1] = {}) => {
  const t = makeTransport();
  const b = createBrowserBridge(t, opts);
  b.start();
  t.emit(ack);
  return { t, b };
};

describe("握手", () => {
  it("start 发 hello；收到含 browser.v1 的 hello-ack 才可用", () => {
    const t = makeTransport();
    const b = createBrowserBridge(t);
    expect(b.isAvailable()).toBe(false);
    b.start();
    expect(t.sent[0]).toEqual({ v: 1, kind: "hello" });
    expect(b.isAvailable()).toBe(false);
    t.emit(ack);
    expect(b.isAvailable()).toBe(true);
  });

  it("capabilities 不含 browser.v1 → 不可用", () => {
    const t = makeTransport();
    const b = createBrowserBridge(t);
    b.start();
    t.emit({ v: 1, kind: "hello-ack", capabilities: ["other"] });
    expect(b.isAvailable()).toBe(false);
  });

  it(`${BROWSER_HANDSHAKE_TIMEOUT_MS}ms 没有 ack → 不可用，所有调用立刻失败`, async () => {
    const t = makeTransport();
    const b = createBrowserBridge(t);
    b.start();
    await vi.advanceTimersByTimeAsync(BROWSER_HANDSHAKE_TIMEOUT_MS + 10);
    expect(b.isAvailable()).toBe(false);
    await expect(b.request("t1", "status", {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(reqs(t)).toHaveLength(0); // 没往通道里发任何 req
  });

  it("超时后仍会低频重发 hello；晚到的 ack 能转回可用（壳重启 / 晚挂监听）", async () => {
    const t = makeTransport();
    const b = createBrowserBridge(t, { helloRetryMs: 1000 });
    b.start();
    await vi.advanceTimersByTimeAsync(BROWSER_HANDSHAKE_TIMEOUT_MS + 10);
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.sent.filter((m) => m.kind === "hello").length).toBeGreaterThanOrEqual(2);
    t.emit(ack);
    expect(b.isAvailable()).toBe(true);
  });

  it("通道本来就没开：start 后不可用、不发任何东西", () => {
    const t = makeTransport();
    t.open = false;
    const b = createBrowserBridge(t);
    b.start();
    expect(b.isAvailable()).toBe(false);
    expect(t.sent).toHaveLength(0);
  });

  it("重新握手（壳重启）会触发 onReady，以便重推 config", () => {
    const onReady = vi.fn();
    const { t } = readyBridge({ onReady });
    expect(onReady).toHaveBeenCalledTimes(1);
    t.emit(ack);
    expect(onReady).toHaveBeenCalledTimes(2);
  });
});

describe("request 配对 / 错误 / 超时", () => {
  it("id 配对：乱序返回各自对号入座", async () => {
    const { t, b } = readyBridge();
    const p1 = b.request("t1", "status", {});
    const p2 = b.request("t1", "tabs", { action: "list" });
    const [r1, r2] = reqs(t);
    expect(r1!.id).not.toBe(r2!.id);
    expect(r1).toMatchObject({ v: 1, kind: "req", taskId: "t1", op: "status", args: {} });
    t.emit({ v: 1, kind: "res", id: r2!.id, ok: true, result: { which: 2 } });
    t.emit({ v: 1, kind: "res", id: r1!.id, ok: true, result: { which: 1 } });
    await expect(p1).resolves.toEqual({ which: 1 });
    await expect(p2).resolves.toEqual({ which: 2 });
    expect(b.pendingCount()).toBe(0);
  });

  it("ok:false → BrowserBridgeError（带 code / message）", async () => {
    const { t, b } = readyBridge();
    const p = b.request("t1", "click", { ref: "e1" });
    t.emit({ v: 1, kind: "res", id: reqs(t)[0]!.id, ok: false, error: { code: "REF_STALE", message: "ref 过期" } });
    const err = (await p.catch((e) => e)) as BrowserBridgeError;
    expect(err).toBeInstanceOf(BrowserBridgeError);
    expect(err.code).toBe("REF_STALE");
    expect(err.message).toBe("ref 过期");
  });

  it("未知 id / 重复 res 被忽略", async () => {
    const { t, b } = readyBridge();
    const p = b.request("t1", "status", {});
    const id = reqs(t)[0]!.id;
    t.emit({ v: 1, kind: "res", id: 9999, ok: true, result: 1 });
    t.emit({ v: 1, kind: "res", id, ok: true, result: "first" });
    t.emit({ v: 1, kind: "res", id, ok: true, result: "second" });
    await expect(p).resolves.toBe("first");
  });

  it("默认 60s 本地超时 → TIMEOUT，并清掉挂起项", async () => {
    const { b } = readyBridge();
    const p = b.request("t1", "snapshot", {});
    const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(BROWSER_DEFAULT_REQUEST_TIMEOUT_MS + 10);
    await assertion;
    expect(b.pendingCount()).toBe(0);
  });

  it("自定义 timeoutMs 生效", async () => {
    const { b } = readyBridge();
    const p = b.request("t1", "wait_for", { timeMs: 100 }, { timeoutMs: 500 });
    const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });

  it("消息发送同步失败 → UNAVAILABLE", async () => {
    const { t, b } = readyBridge();
    t.send = () => false;
    await expect(b.request("t1", "status", {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("非 v:1 / 格式不对的消息直接忽略", async () => {
    const { t, b } = readyBridge();
    const p = b.request("t1", "status", {});
    const id = reqs(t)[0]!.id;
    t.emit({ v: 2, kind: "res", id, ok: true, result: "bad" });
    t.emit("garbage");
    t.emit(null);
    t.emit({ v: 1, kind: "res", id, ok: true, result: "good" });
    await expect(p).resolves.toBe("good");
  });
});

describe("cancel / abort / 断线", () => {
  it("cancel(taskId)：发 cancel 给主进程 + 只拒该任务的本地挂起请求", async () => {
    const { t, b } = readyBridge();
    const a1 = b.request("t1", "ask_user_to_act", { message: "x" });
    const a2 = b.request("t1", "wait_for", { timeMs: 1 });
    const other = b.request("t2", "status", {});
    const guard = [expect(a1).rejects.toMatchObject({ code: "CANCELLED" }), expect(a2).rejects.toMatchObject({ code: "CANCELLED" })];
    b.cancel("t1");
    await Promise.all(guard);
    expect(t.sent).toContainEqual({ v: 1, kind: "cancel", taskId: "t1" });
    expect(b.pendingCount("t1")).toBe(0);
    expect(b.pendingCount("t2")).toBe(1);
    t.emit({ v: 1, kind: "res", id: reqs(t)[2]!.id, ok: true, result: "ok" });
    await expect(other).resolves.toBe("ok");
  });

  it("AbortSignal：任何 op 被取消都通知主进程（R1-18：click / type / navigate 也要能被停止打断）", async () => {
    const { t, b } = readyBridge();
    const c1 = new AbortController();
    const p1 = b.request("t1", "wait_for", { text: "x" }, { signal: c1.signal });
    const g1 = expect(p1).rejects.toMatchObject({ code: "CANCELLED" });
    c1.abort();
    await g1;
    expect(t.sent.filter((m) => m.kind === "cancel")).toHaveLength(1);

    // 非等待型 op：此前这里断言「不发 cancel」，把 R1-18 的缺陷钉成了预期；现在必须发
    const c2 = new AbortController();
    const p2 = b.request("t1", "snapshot", {}, { signal: c2.signal });
    const g2 = expect(p2).rejects.toMatchObject({ code: "CANCELLED" });
    c2.abort();
    await g2;
    expect(t.sent.filter((m) => m.kind === "cancel")).toHaveLength(2);
    expect(t.sent.filter((m) => m.kind === "cancel").every((m) => m.taskId === "t1")).toBe(true);
  });

  it("已 abort 的 signal：直接 CANCELLED、不发 req", async () => {
    const { t, b } = readyBridge();
    const c = new AbortController();
    c.abort();
    await expect(b.request("t1", "status", {}, { signal: c.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(reqs(t)).toHaveLength(0);
  });

  it("通道断开：挂起请求全部 CANCELLED、转不可用", async () => {
    const { t, b } = readyBridge();
    const p1 = b.request("t1", "snapshot", {});
    const p2 = b.request("t2", "snapshot", {});
    const guards = [expect(p1).rejects.toMatchObject({ code: "CANCELLED" }), expect(p2).rejects.toMatchObject({ code: "CANCELLED" })];
    t.disconnect();
    await Promise.all(guards);
    expect(b.isAvailable()).toBe(false);
    await expect(b.request("t1", "status", {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("evt session_closed：拒该任务挂起请求并通知订阅者", async () => {
    const { t, b } = readyBridge();
    const closed = vi.fn();
    b.onSessionClosed(closed);
    const p = b.request("t1", "ask_user_to_act", { message: "x" });
    const guard = expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    t.emit({ v: 1, kind: "evt", name: "session_closed", taskId: "t1", data: {} });
    await guard;
    expect(closed).toHaveBeenCalledWith("t1");
  });

  it("closeSession 发 close_session req（best-effort，不抛）", () => {
    const { t, b } = readyBridge();
    b.closeSession("t1");
    expect(reqs(t)[0]).toMatchObject({ op: "close_session", taskId: "t1" });
  });
});

describe("evt / config", () => {
  it("evt handback 派发给订阅者", () => {
    const { t, b } = readyBridge();
    const got = vi.fn();
    b.onEvent("handback", got);
    t.emit({ v: 1, kind: "evt", name: "handback", taskId: "t1", data: { note: "好了", entries: [] } });
    expect(got).toHaveBeenCalledWith({ taskId: "t1", data: { note: "好了", entries: [] } });
  });

  it("处理器注册之前到达的事件会被缓存、注册后补发（handback.ts 晚于握手加载）", () => {
    const { t, b } = readyBridge();
    t.emit({ v: 1, kind: "evt", name: "handback", taskId: "t1", data: { note: "早到" } });
    const got = vi.fn();
    b.onEvent("handback", got);
    expect(got).toHaveBeenCalledTimes(1);
    expect(got.mock.calls[0]![0].data.note).toBe("早到");
    // 补发过就不再重复
    const got2 = vi.fn();
    b.onEvent("handback", got2);
    expect(got2).not.toHaveBeenCalled();
  });

  it("订阅者抛错不影响其它订阅者", () => {
    const { t, b } = readyBridge();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = vi.fn();
    b.onEvent("handback", () => {
      throw new Error("boom");
    });
    b.onEvent("handback", ok);
    t.emit({ v: 1, kind: "evt", name: "handback", taskId: "t1", data: {} });
    expect(ok).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("syncConfig：只在内容变化时发；force 总发；不可用时不发", () => {
    const { t, b } = readyBridge();
    const configs = () => t.sent.filter((m) => m.kind === "config");
    b.syncConfig({ recordInputValues: false, evaluateEnabled: false });
    b.syncConfig({ recordInputValues: false, evaluateEnabled: false });
    expect(configs()).toHaveLength(1);
    expect(configs()[0]).toMatchObject({ v: 1, kind: "config", recordInputValues: false, evaluateEnabled: false });
    b.syncConfig({ recordInputValues: false, evaluateEnabled: true });
    expect(configs()).toHaveLength(2);
    b.syncConfig({ recordInputValues: false, evaluateEnabled: true }, true);
    expect(configs()).toHaveLength(3);
    t.disconnect();
    b.syncConfig({ recordInputValues: true, evaluateEnabled: true });
    expect(configs()).toHaveLength(3);
  });

  it("syncConfig 的载荷带 E2 新字段：放开型只认 true、收紧型只认显式 false、maxTabs 规整；缺省按默认", () => {
    const { t, b } = readyBridge();
    const last = () => t.sent.filter((m) => m.kind === "config").at(-1);
    // 老调用方只传两个字段：新字段按默认（storageAccess / pagePermissions 关；trustLoopbackCerts / networkBodyRead 开；maxTabs 20）
    b.syncConfig({ recordInputValues: false, evaluateEnabled: false });
    expect(last()).toMatchObject({
      storageAccess: false,
      pagePermissions: false,
      trustLoopbackCerts: true,
      networkBodyRead: true,
      maxTabs: 20,
    });
    b.syncConfig({
      recordInputValues: false,
      evaluateEnabled: false,
      storageAccess: true,
      pagePermissions: true,
      trustLoopbackCerts: false,
      networkBodyRead: false,
      maxTabs: 33,
    });
    expect(last()).toMatchObject({ storageAccess: true, pagePermissions: true, trustLoopbackCerts: false, networkBodyRead: false, maxTabs: 33 });
    // 脏值：maxTabs 越界回 20；非 true 的放开型当 false
    b.syncConfig({ recordInputValues: false, evaluateEnabled: false, storageAccess: "yes" as never, maxTabs: 999 });
    expect(last()).toMatchObject({ storageAccess: false, maxTabs: 20 });
  });

  it("握手完成回调里推 config 的前提：重新握手后 lastSent 被清，同样内容会再发一次", () => {
    const { t, b } = readyBridge();
    const cfg = { recordInputValues: false, evaluateEnabled: false };
    b.syncConfig(cfg);
    t.emit(ack); // 壳重启后的新 manager 需要重新拿到 config
    b.syncConfig(cfg);
    expect(t.sent.filter((m) => m.kind === "config")).toHaveLength(2);
  });
});

describe("dispose", () => {
  it("拒绝所有挂起请求并拆掉监听", async () => {
    const { t, b } = readyBridge();
    const p = b.request("t1", "snapshot", {});
    const guard = expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    b.dispose();
    await guard;
    expect(t.listenerCount()).toBe(0);
    expect(b.isAvailable()).toBe(false);
  });
});

describe("全局单例与测试注入", () => {
  it("vitest 下（process.send 存在也不自动起真实通道）：getBrowserBridge 为 null、不可用", () => {
    // vitest worker 里 process.send 是函数；若 bridge 在这里自动握手，会往 vitest 的 IPC 通道里乱发消息
    expect(getBrowserBridge()).toBeNull();
    expect(isBrowserBridgeAvailable()).toBe(false);
  });

  it("__setBrowserBridgeForTest 注入后 isBrowserBridgeAvailable / cancel / close 走注入的实例", () => {
    const { t, b } = readyBridge();
    __setBrowserBridgeForTest(b);
    expect(getBrowserBridge()).toBe(b);
    expect(isBrowserBridgeAvailable()).toBe(true);
    cancelBrowserTask("t9");
    expect(t.sent).toContainEqual({ v: 1, kind: "cancel", taskId: "t9" });
    closeBrowserSession("t9");
    expect(reqs(t).some((m) => m.op === "close_session")).toBe(true);
  });

  it("没有 bridge 时 cancelBrowserTask / closeBrowserSession 是无操作、不抛", () => {
    expect(() => cancelBrowserTask("t1")).not.toThrow();
    expect(() => closeBrowserSession("t1")).not.toThrow();
  });
});
