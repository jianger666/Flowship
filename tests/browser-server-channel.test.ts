/**
 * server ⇄ 主进程通道（electron-app/browser/server-channel.mjs）单测：契约 §4。
 * 用假 proc（EventEmitter + send）驱动，不起真子进程。
 * 钉死：单个 req 任何异常都回 res ok:false、不抛到顶层；cancel / 断线把挂起请求以 CANCELLED abort。
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { BROWSER_ERROR_CODES, BrowserError, createServerChannel, toErrorPayload } from "../electron-app/browser/server-channel.mjs";

/** 等微任务队列排空（不用真实定时器等待） */
const flush = () => new Promise<void>((r) => setImmediate(r));

class FakeProc extends EventEmitter {
  sent: unknown[] = [];
  connected = true;
  sendImpl: ((msg: unknown, cb?: (err?: Error) => void) => boolean) | null = null;
  send(msg: unknown, cb?: (err?: Error) => void) {
    if (this.sendImpl) return this.sendImpl(msg, cb);
    // 与真 child_process 的 json 序列化一致：序列化发生在 send 的同步段内，BigInt / 循环引用在这里抛 TypeError
    JSON.stringify(msg);
    this.sent.push(msg);
    cb?.();
    return true;
  }
}

/** dispatch 的类型直接取自 createServerChannel 的参数（args 是 object，测试侧不再收窄成 Record） */
type Dispatch = Parameters<typeof createServerChannel>[0]["dispatch"];

const setup = (dispatch: Dispatch) => {
  const proc = new FakeProc();
  const onConfig = vi.fn();
  const onCancel = vi.fn();
  const logs: string[] = [];
  const channel = createServerChannel({
    proc: proc as never,
    dispatch,
    platform: "test-os",
    onConfig,
    onCancel,
    log: (m) => logs.push(m),
  });
  return { proc, channel, onConfig, onCancel, logs };
};

const resOf = (proc: FakeProc, id: number) =>
  (proc.sent as Array<Record<string, unknown>>).find((m) => m.kind === "res" && m.id === id) as Record<string, never> | undefined;

describe("握手与 config", () => {
  it("hello → hello-ack（v:1、platform、capabilities 含 browser.v1）", async () => {
    const { proc } = setup(async () => ({}));
    proc.emit("message", { v: 1, kind: "hello" });
    expect(proc.sent).toEqual([{ v: 1, kind: "hello-ack", platform: "test-os", capabilities: ["browser.v1"] }]);
  });

  it("config 只透传 boolean 字段，其余丢弃", async () => {
    const { proc, onConfig } = setup(async () => ({}));
    proc.emit("message", { v: 1, kind: "config", recordInputValues: true, evaluateEnabled: "yes", extra: 1 });
    expect(onConfig).toHaveBeenCalledWith({ recordInputValues: true });
    proc.emit("message", { v: 1, kind: "config", evaluateEnabled: false });
    expect(onConfig).toHaveBeenLastCalledWith({ evaluateEnabled: false });
  });
});

describe("req 分发", () => {
  it("正常请求回 res ok:true；result 为 undefined 时回 null；dispatch 收到 taskId 与 signal", async () => {
    const seen: unknown[] = [];
    const { proc } = setup(async (op, args, ctx) => {
      seen.push([op, args, ctx.taskId, ctx.signal instanceof AbortSignal]);
      return op === "status" ? undefined : { pong: (args as { x?: unknown }).x };
    });
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "taskA", op: "ping", args: { x: 7 } });
    await flush();
    expect(resOf(proc, 1)).toEqual({ v: 1, kind: "res", id: 1, ok: true, result: { pong: 7 } });
    expect(seen).toEqual([["ping", { x: 7 }, "taskA", true]]);

    proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "taskA", op: "status" });
    await flush();
    expect(resOf(proc, 2)).toEqual({ v: 1, kind: "res", id: 2, ok: true, result: null });
  });

  it("dispatch 同步抛 BrowserError / 异步抛 BrowserError 都原样回错误码", async () => {
    const { proc } = setup((op) => {
      if (op === "sync") throw new BrowserError("USER_CONTROL", "用户正在接管");
      return Promise.reject(new BrowserError("REF_STALE", "ref 已失效"));
    });
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "t", op: "sync", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "t", op: "async", args: {} });
    await flush();
    expect(resOf(proc, 1)).toMatchObject({ ok: false, error: { code: "USER_CONTROL", message: "用户正在接管" } });
    expect(resOf(proc, 2)).toMatchObject({ ok: false, error: { code: "REF_STALE" } });
  });

  it("dispatch 抛未知错误回 INTERNAL 且不带栈", async () => {
    const { proc } = setup(async () => {
      throw new Error("数据库炸了");
    });
    proc.emit("message", { v: 1, kind: "req", id: 9, taskId: "t", op: "x", args: {} });
    await flush();
    const r = resOf(proc, 9) as unknown as { ok: boolean; error: { code: string; message: string } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INTERNAL");
    expect(r.error.message).toContain("数据库炸了");
    expect(JSON.stringify(r)).not.toContain(" at "); // 没有栈帧泄漏
  });

  it("形状错误回 BAD_ARGS：缺 taskId、taskId 空、args 非对象（数组/字符串/null）", async () => {
    const dispatch = vi.fn(async () => ({}));
    const { proc } = setup(dispatch);
    proc.emit("message", { v: 1, kind: "req", id: 1, op: "x", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "", op: "x", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 3, taskId: "t", op: "x", args: [1] });
    proc.emit("message", { v: 1, kind: "req", id: 4, taskId: "t", op: "x", args: "no" });
    proc.emit("message", { v: 1, kind: "req", id: 5, taskId: "t", op: "x", args: null });
    proc.emit("message", { v: 1, kind: "req", id: 6, taskId: "t", args: {} });
    await flush();
    for (const id of [1, 2, 3, 4, 5, 6]) {
      expect(resOf(proc, id), `id=${id}`).toMatchObject({ ok: false, error: { code: "BAD_ARGS" } });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("id 不是数字时静默丢弃（无从回包）、不抛、不调 dispatch", async () => {
    const dispatch = vi.fn(async () => ({}));
    const { proc } = setup(dispatch);
    expect(() => proc.emit("message", { v: 1, kind: "req", id: "1", taskId: "t", op: "x", args: {} })).not.toThrow();
    await flush();
    expect(proc.sent).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("id 重复（R1-31）：在途期间的重复请求静默丢弃，不回包、不重复 dispatch；真实结果是这个 id 的唯一一条 res", async () => {
    let release!: (v: unknown) => void;
    const dispatch = vi.fn(() => new Promise((r) => (release = r)));
    const { proc, channel, logs } = setup(dispatch as never);
    proc.emit("message", { v: 1, kind: "req", id: 5, taskId: "t", op: "wait", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 5, taskId: "t", op: "wait", args: {} });
    await flush();
    // 旧行为是此刻就回一条 BAD_ARGS（同 id）把在途请求的结果冲掉：现在一条 res 都不能有
    expect(resOf(proc, 5)).toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(channel.pendingCount()).toBe(1);
    expect(logs.some((l) => l.includes("重复 id"))).toBe(true);
    release({ done: true });
    await flush();
    const all = (proc.sent as Array<Record<string, unknown>>).filter((m) => m.kind === "res" && m.id === 5);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ ok: true, result: { done: true } });
    expect(channel.pendingCount()).toBe(0);
  });

  it("id 重复且重复的那条还是畸形请求（缺 taskId / args 非对象）：同样丢弃，不用 BAD_ARGS 冲掉在途结果", async () => {
    let release!: (v: unknown) => void;
    const { proc } = setup(() => new Promise((r) => (release = r)));
    proc.emit("message", { v: 1, kind: "req", id: 8, taskId: "t", op: "wait", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 8, op: "wait", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 8, taskId: "t", op: "wait", args: [1] });
    await flush();
    expect(resOf(proc, 8)).toBeUndefined();
    release({ ok: 1 });
    await flush();
    const all = (proc.sent as Array<Record<string, unknown>>).filter((m) => m.kind === "res" && m.id === 8);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ ok: true, result: { ok: 1 } });
  });

  it("在途请求结束后同 id 可以复用（pending 已清）", async () => {
    const { proc } = setup(async (_op, args) => ({ echo: (args as { n?: number }).n }));
    proc.emit("message", { v: 1, kind: "req", id: 3, taskId: "t", op: "x", args: { n: 1 } });
    await flush();
    proc.emit("message", { v: 1, kind: "req", id: 3, taskId: "t", op: "x", args: { n: 2 } });
    await flush();
    const all = (proc.sent as Array<Record<string, unknown>>).filter((m) => m.kind === "res" && m.id === 3);
    expect(all.map((m) => (m.result as { echo: number }).echo)).toEqual([1, 2]);
  });
});

describe("res 序列化失败的降级（R1-31）", () => {
  const circular = () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    return o;
  };

  it.each([
    ["BigInt", () => ({ big: BigInt(10) }), /BigInt/],
    ["循环引用", circular, /circular|循环/i],
  ])("result 含 %s：改发 res ok:false（INTERNAL、带可读原因），server 不用等超时", async (_name, make, reason) => {
    const { proc, channel, logs } = setup(async () => make());
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "t", op: "x", args: {} });
    await flush();
    const r = resOf(proc, 1) as unknown as { ok: boolean; result?: unknown; error: { code: string; message: string } };
    expect(r).toBeDefined();
    expect(r.ok).toBe(false);
    expect(r.result).toBeUndefined();
    expect(r.error.code).toBe("INTERNAL");
    expect(r.error.message).toMatch(reason);
    expect(r.error.message).toMatch(/无法序列化/);
    expect(r.error.message).toMatch(/可能已经执行/); // 提醒 AI 先确认状态再重试，避免对副作用操作盲目重发
    expect(logs.some((l) => l.includes("发送异常 kind=res"))).toBe(true);
    // 这个 id 只有这一条 res，且 pending 已释放
    expect((proc.sent as Array<Record<string, unknown>>).filter((m) => m.kind === "res" && m.id === 1)).toHaveLength(1);
    expect(channel.pendingCount()).toBe(0);
  });

  it("降级只针对「成功的 res」：普通成功响应不受影响；evt 序列化失败只返回 false、不伪造 res", async () => {
    const { proc, channel } = setup(async () => ({ fine: true }));
    proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "t", op: "x", args: {} });
    await flush();
    expect(resOf(proc, 2)).toMatchObject({ ok: true, result: { fine: true } });
    expect(channel.sendEvent("handback", "t", { big: BigInt(1) } as never)).toBe(false);
    expect((proc.sent as Array<Record<string, unknown>>).filter((m) => m.kind === "res")).toHaveLength(1);
  });

  it("通道真的断了（降级的那次 send 也失败）：不抛、不死循环，只记日志", async () => {
    const { proc, channel, logs } = setup(async () => ({ big: BigInt(1) }));
    let calls = 0;
    proc.sendImpl = () => {
      calls += 1;
      throw new Error("ERR_IPC_CHANNEL_CLOSED");
    };
    expect(() => proc.emit("message", { v: 1, kind: "req", id: 4, taskId: "t", op: "x", args: {} })).not.toThrow();
    await flush();
    expect(calls).toBe(2); // 原始 res + 一次降级，之后不再重试
    expect(logs.filter((l) => l.includes("发送异常 kind=res")).length).toBe(2);
    expect(channel.pendingCount()).toBe(0);
  });
});

describe("cancel 与断线", () => {
  /** dispatch 模拟等待型 op：只在 signal abort 时以 reason 拒绝 */
  const waitingDispatch = (signals: AbortSignal[]) => (_op: string, _args: unknown, ctx: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      signals.push(ctx.signal);
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
    });

  it("cancel 只 abort 该 taskId 的挂起请求，错误码 CANCELLED，并回调 onCancel", async () => {
    const signals: AbortSignal[] = [];
    const { proc, onCancel } = setup(waitingDispatch(signals) as never);
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "taskA", op: "wait_for", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "taskB", op: "wait_for", args: {} });
    proc.emit("message", { v: 1, kind: "cancel", taskId: "taskA" });
    await flush();
    expect(signals[0].aborted).toBe(true);
    expect((signals[0].reason as BrowserError).code).toBe("CANCELLED");
    expect(signals[1].aborted).toBe(false);
    expect(resOf(proc, 1)).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(onCancel).toHaveBeenCalledWith("taskA");
    // taskId 非法的 cancel 不回调、不抛
    expect(() => proc.emit("message", { v: 1, kind: "cancel", taskId: "" })).not.toThrow();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each(["exit", "disconnect"])("proc %s 后 pending 全部以 CANCELLED abort、通道关闭且幂等", async (ev) => {
    const signals: AbortSignal[] = [];
    const { proc, channel } = setup(waitingDispatch(signals) as never);
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "taskA", op: "wait_for", args: {} });
    proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "taskB", op: "ask", args: {} });
    proc.emit(ev);
    await flush();
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    expect(signals.map((s) => (s.reason as BrowserError).code)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(channel.isClosed()).toBe(true);
    expect(channel.pendingCount()).toBe(0);
    // 关闭后：消息被忽略、sendEvent 返回 false、重复 close / exit 不抛
    expect(channel.sendEvent("handback", "taskA", {})).toBe(false);
    expect(() => {
      channel.close();
      proc.emit(ev);
      proc.emit("message", { v: 1, kind: "hello" });
    }).not.toThrow();
    expect(proc.sent.filter((m) => (m as Record<string, unknown>).kind === "hello-ack")).toHaveLength(0);
  });

  it("proc.connected===false 时 send 不抛、sendEvent 返回 false", async () => {
    const { proc, channel } = setup(async () => ({}));
    proc.connected = false;
    proc.sendImpl = () => {
      throw new Error("ERR_IPC_CHANNEL_CLOSED");
    };
    expect(() => proc.emit("message", { v: 1, kind: "hello" })).not.toThrow();
    expect(channel.sendEvent("handback", "t", { note: "x" })).toBe(false);
    expect(proc.sent).toHaveLength(0);
  });

  it("proc.send 同步抛错被吞掉（hello 不冒泡）", async () => {
    const { proc } = setup(async () => ({}));
    proc.sendImpl = () => {
      throw new Error("boom");
    };
    expect(() => proc.emit("message", { v: 1, kind: "hello" })).not.toThrow();
  });
});

describe("杂项健壮性", () => {
  it("不识别的消息不抛：null / 字符串 / 缺 v / 版本不符 / 未知 kind", async () => {
    const { proc } = setup(async () => ({}));
    for (const m of [null, "hello", 42, [], { kind: "hello" }, { v: 2, kind: "hello" }, { v: 1, kind: "nope" }, { v: 1 }]) {
      expect(() => proc.emit("message", m)).not.toThrow();
    }
    await flush();
    expect(proc.sent).toHaveLength(0);
  });

  it("sendEvent 正常发送 evt 信封；data 缺省为 {}", async () => {
    const { proc, channel } = setup(async () => ({}));
    expect(channel.sendEvent("handback", "taskA", { note: "好了" })).toBe(true);
    expect(channel.sendEvent("session_closed", "taskA", undefined as never)).toBe(true);
    expect(proc.sent).toEqual([
      { v: 1, kind: "evt", name: "handback", taskId: "taskA", data: { note: "好了" } },
      { v: 1, kind: "evt", name: "session_closed", taskId: "taskA", data: {} },
    ]);
  });

  it("handleMessage 可被单测直接喂（不经 proc 事件）", async () => {
    const { proc, channel } = setup(async () => ({ ok: 1 }));
    channel.handleMessage({ v: 1, kind: "req", id: 3, taskId: "t", op: "x", args: {} });
    await flush();
    expect(resOf(proc, 3)).toMatchObject({ ok: true, result: { ok: 1 } });
  });
});

describe("BrowserError / toErrorPayload / 错误码表", () => {
  it("错误码表与契约 §4.2 全集一致（顺序也一致）", () => {
    expect([...BROWSER_ERROR_CODES]).toEqual([
      "NO_SESSION", "USER_CONTROL", "USER_TOOK_OVER", "URL_BLOCKED", "REF_STALE", "REF_NOT_FOUND",
      "NOT_INTERACTABLE", "TIMEOUT", "NAV_FAILED", "TAB_NOT_FOUND", "CANCELLED", "DISABLED", "BAD_ARGS", "INTERNAL",
      // 增强包 E2（契约 §15）
      "ACCESS_DISABLED", "DENIED", "UNSUPPORTED",
    ]);
  });

  it("BrowserError 保留 code/message；未知错误折成 INTERNAL", () => {
    const e = new BrowserError("TIMEOUT", "等太久了");
    expect(e).toBeInstanceOf(Error);
    expect(toErrorPayload(e)).toEqual({ code: "TIMEOUT", message: "等太久了" });
    expect(toErrorPayload(new Error("x"))).toMatchObject({ code: "INTERNAL" });
    expect(toErrorPayload("裸字符串").code).toBe("INTERNAL");
    expect(toErrorPayload(null).code).toBe("INTERNAL");
    expect(toErrorPayload(undefined).code).toBe("INTERNAL");
  });
});
