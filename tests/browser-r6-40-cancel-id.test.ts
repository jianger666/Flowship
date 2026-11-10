/**
 * R6-40：server-channel 的 `cancel` 报文 id 非有限整数时不得降级成任务级取消。
 *
 * 契约（server ⇄ 主进程）：
 *  - **任务级取消 = 显式不带 `id` 键**的 `{ v:1, kind:"cancel", taskId }`（bridge.ts 的 `cancel(taskId)` 与 AbortSignal 中止都这样发）；
 *  - **单请求取消 = 带有限整数 `id`**（bridge 的本地超时，`id` 是递增的请求序号）；
 *  - 带了 `id` 键但不是有限整数（`"1"` / `null`（NaN / Infinity 经 JSON 序列化变成 null）/ 小数 / 对象 …）→ 忽略并记日志，
 *    绝不降级成任务级取消——一条畸形 / 版本错位的报文不能中止整个任务的浏览器动作，也不能清掉同任务的 wait / ask 挂起态。
 *
 * 后半部分用**真 bridge ⇄ 真 server-channel**（JSON 往返模拟 Node IPC）钉死「合法路径没被改坏」：
 * bridge 的三种取消各走各的级别，且任务级报文真的没有 `id` 键。
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServerChannel } from "../electron-app/browser/server-channel.mjs";
import { createBrowserBridge, type BridgeTransport } from "@/lib/server/browser/bridge";

class FakeProc extends EventEmitter {
  sent: unknown[] = [];
  connected = true;
  send(msg: unknown, cb?: (err?: Error) => void) {
    this.sent.push(msg);
    cb?.();
    return true;
  }
}

/** 起一个通道，派发 3 个在途请求（t1 两个、t2 一个）；dispatch 永不结算，只记录各请求的 signal */
const setupChannel = () => {
  const proc = new FakeProc();
  const signals = new Map<number, AbortSignal>();
  const onCancel = vi.fn();
  const log = vi.fn();
  createServerChannel({
    proc: proc as never,
    dispatch: async (_op: string, args: Record<string, unknown>, ctx: { signal: AbortSignal }) => {
      signals.set(args.n as number, ctx.signal);
      return new Promise(() => {});
    },
    onCancel,
    log,
  } as never);
  proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "t1", op: "scroll", args: { n: 1 } });
  proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "t1", op: "wait_for", args: { n: 2 } });
  proc.emit("message", { v: 1, kind: "req", id: 3, taskId: "t2", op: "scroll", args: { n: 3 } });
  const aborted = () => [1, 2, 3].filter((n) => signals.get(n)?.aborted).sort();
  const logs = () => log.mock.calls.map((c) => String(c[0]));
  return { proc, signals, onCancel, log, aborted, logs };
};

const flushMicro = () => new Promise<void>((r) => setImmediate(r));

describe("R6-40·cancel 的 id 非有限整数：忽略并记日志，不降级成任务级取消", () => {
  const BAD_IDS: Array<[string, unknown]> = [
    ['字符串 "1"（数字的字符串形式也不收）', "1"],
    ["空字符串", ""],
    ["null（NaN / Infinity 经 JSON 序列化就是 null）", null],
    ["NaN（进程内直接喂）", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["小数 1.5", 1.5],
    ["布尔 true", true],
    ["布尔 false", false],
    ["对象", { id: 1 }],
    ["空对象", {}],
    ["数组 [1]", [1]],
    ["undefined（自有键；JSON 线上不可能出现，进程内喂也不当作「无 id」）", undefined],
  ];

  it.each(BAD_IDS)("id = %s → 一个请求都不中止、不调 onCancel、有日志", async (_name, bad) => {
    const s = setupChannel();
    await flushMicro();
    s.proc.emit("message", { v: 1, kind: "cancel", taskId: "t1", id: bad });
    expect(s.aborted()).toEqual([]);
    expect(s.onCancel).not.toHaveBeenCalled();
    expect(s.logs().some((m) => m.includes("忽略 cancel") && m.includes("不降级成任务级取消"))).toBe(true);
  });

  it("经 JSON 往返：id=NaN 的报文到达时 id 是 null → 同样被忽略（线上真实会发生的畸形形态）", async () => {
    const s = setupChannel();
    await flushMicro();
    const wire = JSON.parse(JSON.stringify({ v: 1, kind: "cancel", taskId: "t1", id: Number.NaN }));
    expect(wire.id).toBeNull();
    s.proc.emit("message", wire);
    expect(s.aborted()).toEqual([]);
    expect(s.onCancel).not.toHaveBeenCalled();
  });

  it("日志只写类型，不回显报文里的值（避免日志注入 / 泄漏）", async () => {
    const s = setupChannel();
    await flushMicro();
    s.proc.emit("message", { v: 1, kind: "cancel", taskId: "t1", id: "secret-looking-value-123" });
    const line = s.logs().find((m) => m.includes("忽略 cancel"))!;
    expect(line).toContain("string");
    expect(line).not.toContain("secret-looking-value-123");
  });

  it("显式不带 id 键 = 任务级取消：该任务全部在途请求中止 + onCancel(taskId)；别的任务不受影响", async () => {
    const s = setupChannel();
    await flushMicro();
    s.proc.emit("message", { v: 1, kind: "cancel", taskId: "t1" });
    expect(s.aborted()).toEqual([1, 2]);
    expect(s.onCancel).toHaveBeenCalledTimes(1);
    expect(s.onCancel).toHaveBeenCalledWith("t1");
    expect(s.logs().some((m) => m.includes("忽略 cancel"))).toBe(false);
  });

  it("整数 id（含 0 / 负数 / 不存在的 id）是单请求语义：不降级成任务级、不调 onCancel；taskId 对不上不误杀", async () => {
    const s = setupChannel();
    await flushMicro();
    for (const id of [0, -1, 999, 2 ** 40]) s.proc.emit("message", { v: 1, kind: "cancel", taskId: "t1", id });
    expect(s.aborted()).toEqual([]);
    expect(s.onCancel).not.toHaveBeenCalled();
    s.proc.emit("message", { v: 1, kind: "cancel", taskId: "t1", id: 3 }); // id=3 属于 t2：taskId 对不上
    expect(s.aborted()).toEqual([]);
    s.proc.emit("message", { v: 1, kind: "cancel", taskId: "t1", id: 2 });
    expect(s.aborted()).toEqual([2]);
    expect(s.onCancel).not.toHaveBeenCalled();
  });

  it("畸形 id 之后合法的任务级取消照常生效（忽略畸形报文不影响后续状态）", async () => {
    const s = setupChannel();
    await flushMicro();
    s.proc.emit("message", { v: 1, kind: "cancel", taskId: "t1", id: null });
    expect(s.aborted()).toEqual([]);
    s.proc.emit("message", { v: 1, kind: "cancel", taskId: "t1" });
    expect(s.aborted()).toEqual([1, 2]);
    expect(s.onCancel).toHaveBeenCalledWith("t1");
  });
});

// ───────────────────────── 真 bridge ⇄ 真 channel：合法路径没被改坏 ─────────────────────────

describe("R6-40·真 bridge ⇄ 真 server-channel：三种取消各走各的级别", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const wire = () => {
    const proc = new FakeProc();
    const signals = new Map<number, AbortSignal>();
    const toMain: Array<Record<string, unknown>> = []; // bridge → 主进程的所有报文（JSON 往返之后的形态）
    const onCancel = vi.fn();
    createServerChannel({
      proc: proc as never,
      dispatch: async (_op: string, args: Record<string, unknown>, ctx: { signal: AbortSignal }) => {
        signals.set(args.n as number, ctx.signal);
        return new Promise(() => {});
      },
      onCancel,
      log: () => {},
    } as never);
    // channel 的 proc.send（主进程 → server）直接喂给 bridge 的监听者
    const subs = new Set<(m: unknown) => void>();
    proc.send = (msg: unknown, cb?: (err?: Error) => void) => {
      for (const fn of [...subs]) fn(JSON.parse(JSON.stringify(msg)));
      cb?.();
      return true;
    };
    const transport: BridgeTransport = {
      send: (msg) => {
        const wireMsg = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>; // Node IPC 的 json 序列化
        toMain.push(wireMsg);
        proc.emit("message", wireMsg);
        return true;
      },
      onMessage: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      onDisconnect: () => () => {},
      isOpen: () => true,
    };
    const bridge = createBrowserBridge(transport);
    bridge.start();
    expect(bridge.isAvailable()).toBe(true);
    const aborted = () => [...signals.entries()].filter(([, s]) => s.aborted).map(([n]) => n).sort();
    return { bridge, toMain, signals, onCancel, aborted };
  };
  const cancelsOf = (toMain: Array<Record<string, unknown>>) => toMain.filter((m) => m.kind === "cancel");

  it("bridge.cancel(taskId)：任务级报文**没有 id 键** → 主进程中止该任务全部在途请求并调 onCancel", async () => {
    const w = wire();
    const a = w.bridge.request("t1", "scroll", { n: 1 } as never).catch((e) => e);
    const b = w.bridge.request("t1", "wait_for", { n: 2 } as never).catch((e) => e);
    const other = w.bridge.request("t2", "scroll", { n: 3 } as never).catch((e) => e);
    w.bridge.cancel("t1");
    await Promise.all([a, b]);
    const cancels = cancelsOf(w.toMain);
    expect(cancels).toHaveLength(1);
    expect(Object.hasOwn(cancels[0], "id")).toBe(false); // 契约：任务级取消显式无 id
    expect(w.aborted()).toEqual([1, 2]);
    expect(w.onCancel).toHaveBeenCalledWith("t1");
    void other;
  });

  it("AbortSignal 中止：同样是无 id 的任务级报文，主进程照常任务级取消", async () => {
    const w = wire();
    const ac = new AbortController();
    const a = w.bridge.request("t1", "navigate", { n: 1 } as never, { signal: ac.signal }).catch((e) => e);
    void w.bridge.request("t1", "click", { n: 2 } as never).catch(() => {});
    ac.abort();
    await a;
    const cancels = cancelsOf(w.toMain);
    expect(cancels).toHaveLength(1);
    expect(Object.hasOwn(cancels[0], "id")).toBe(false);
    expect(w.aborted()).toEqual([1, 2]);
    expect(w.onCancel).toHaveBeenCalledWith("t1");
  });

  it("本地超时：带整数 id 的单请求取消 → 只中止超时的那个请求，同任务别的请求与 onCancel 都不受影响", async () => {
    const w = wire();
    const slow = w.bridge.request("t1", "scroll", { n: 1 } as never, { timeoutMs: 1000 }).catch((e) => e);
    void w.bridge.request("t1", "wait_for", { n: 2 } as never, { timeoutMs: 600_000 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(1001);
    await slow;
    const cancels = cancelsOf(w.toMain);
    expect(cancels).toHaveLength(1);
    expect(Number.isInteger(cancels[0].id)).toBe(true);
    expect(w.aborted()).toEqual([1]);
    expect(w.onCancel).not.toHaveBeenCalled();
  });
});
