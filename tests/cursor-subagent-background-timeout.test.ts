/**
 * 后台子代理「超时」收尾的硬化（R14 Q11b-03）：
 *
 * - 过去超时只发一次 `run.cancel()`（失败被吞）。cancel 抛错 / 被忽略 / 挂死、流不结束时，job 永远留在表里：
 *   占后台名额（上限 4，挂死 4 个后再也派不了后台子代理）、占 resume 的 busy 位、让会话永不被空闲回收、侧栏一直转圈。
 *   → 现在超时之后再给一段宽限，到点强制按失败收尾：子 agent 关掉、busy 放掉、名额还回、onSettled 恰好一次。
 * - 上限从「子代理开始」起算，不是从转后台那一刻（前台已经跑的时间要扣掉；提示词承诺「每个最长跑 N 分钟」）。
 * - 发给 SDK 的 cancel / close 自己也有期限，收尾不被它们拖住。
 *
 * 不碰真实 SDK：子 agent / 子 run 是注入的假依赖；全程假时钟（确定性，不靠真睡眠）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSubagentResumablesForTests,
  BACKGROUND_SUBAGENT_CANCEL_GRACE_MS,
  createCursorSubagentLink,
  type CursorSubagentDeps,
  type SubagentChildRun,
  type SubagentTranscriptSink,
} from "@/lib/server/cursor-subagent";
import type { BackgroundSubagentEvent } from "@/lib/server/subagent-background";
import type { SubagentRunHandle } from "@/lib/server/subagent-transcript";

/** cancel 的行为：ok = 生效（wait 返回 cancelled、流结束）；其余都是「cancel 没能让子 run 收尾」 */
type CancelMode = "ok" | "reject" | "throw" | "hang";

interface FakeRun extends SubagentChildRun {
  cancelMock: ReturnType<typeof vi.fn>;
  /** 子 run 自己收尾（成功）；可顺带让流吐一条消息再结束（模拟「宽限之后 SDK 才回过神」） */
  finish: (result?: string, lateMessage?: unknown) => void;
}

type WaitResult = {
  status: string;
  result?: string;
  error?: { message?: string } | null;
};

const fakeRun = (mode: CancelMode): FakeRun => {
  let resolveWait!: (v: WaitResult) => void;
  const waitP = new Promise<WaitResult>((r) => {
    resolveWait = r;
  });
  // 流挂着，直到 finish / cancel 生效：cancel 无效的情形下流不会自己结束
  let openGate!: (m?: unknown) => void;
  const gate = new Promise<{ m?: unknown }>((r) => {
    openGate = (m) => r({ m });
  });
  const cancel = vi.fn((): Promise<void> => {
    if (mode === "throw") throw new Error("sync boom");
    if (mode === "reject") return Promise.reject(new Error("network down"));
    if (mode === "hang") return new Promise<void>(() => {});
    resolveWait({ status: "cancelled" });
    openGate();
    return Promise.resolve();
  });
  return {
    cancel,
    cancelMock: cancel,
    stream: () =>
      (async function* () {
        const { m } = await gate;
        if (m !== undefined) yield m;
      })(),
    wait: () => waitP,
    finish: (result = "子代理的结果", lateMessage) => {
      resolveWait({ status: "finished", result });
      openGate(lateMessage);
    },
  };
};

interface SetupOpts {
  /** 每个子 run 的 cancel 行为（按创建顺序；用完后沿用最后一个）；缺省 reject */
  cancel?: CancelMode | CancelMode[];
  withIds?: boolean;
  /** 子 agent 的 close 永远不返回 */
  closeHangs?: boolean;
  background?: Partial<NonNullable<CursorSubagentDeps["background"]>>;
  transcripts?: SubagentTranscriptSink;
}

const setup = (opts: SetupOpts = {}) => {
  const runs: FakeRun[] = [];
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const events: BackgroundSubagentEvent[] = [];
  const modes = Array.isArray(opts.cancel) ? opts.cancel : [opts.cancel ?? "reject"];
  let seq = 0;
  const makeChild = (agentId?: string) => {
    const run = fakeRun(modes[Math.min(runs.length, modes.length - 1)]!);
    runs.push(run);
    const close = vi.fn((): Promise<void> | undefined =>
      opts.closeHangs ? new Promise<void>(() => {}) : undefined,
    );
    closes.push(close);
    return { ...(agentId ? { agentId } : {}), send: vi.fn(async () => run), close };
  };
  const createChild = vi.fn(async () => {
    seq += 1;
    return makeChild(opts.withIds ? `child-${seq}` : undefined);
  });
  const resumeChild = vi.fn(async ({ agentId }: { agentId: string }) => makeChild(agentId));
  const deps: CursorSubagentDeps = {
    parentModel: { id: "composer-2.5" },
    loadCatalog: async () => null,
    createChild,
    ...(opts.withIds ? { resumeChild } : {}),
    background: { onSettled: (e) => events.push(e), ...opts.background },
    ...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
  };
  const link = createCursorSubagentLink(deps);
  return { link, runs, closes, events };
};

const fakeSink = () => {
  const handle = {
    key: "sa_fake000001",
    onMessage: vi.fn(),
    setBackground: vi.fn(),
    setAgentId: vi.fn(),
    finish: vi.fn(),
  } satisfies SubagentRunHandle;
  const start = vi.fn((init: unknown) => {
    void init;
    return handle as SubagentRunHandle;
  });
  return { sink: { start } as SubagentTranscriptSink, handle };
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const call = async (
  link: ReturnType<typeof createCursorSubagentLink>,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> => {
  const r = (await link.tool.execute(args as never, {} as never)) as ToolResult;
  return {
    text: r.content.map((c) => c.text).join("\n"),
    isError: r.isError === true,
  };
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetSubagentResumablesForTests();
  vi.useFakeTimers();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("超时后 cancel 没能让子 run 收尾：宽限到点强制收尾", () => {
  it.each([
    { mode: "reject", desc: "cancel 返回 rejection（网络断）" },
    { mode: "throw", desc: "cancel 同步抛错" },
    { mode: "hang", desc: "cancel 永远不返回" },
  ] as const)(
    "$mode —— $desc：maxRuntime 到点发 cancel；再过宽限才强制收尾（failed·超时、名额还回、子 agent 关掉、只通知一次）",
    async ({ mode }) => {
      const { link, runs, closes, events } = setup({
        cancel: mode,
        background: { maxRuntimeMs: 1000, cancelGraceMs: 500 },
      });
      await call(link, { prompt: "跑不完", run_in_background: true });
      expect(link.control.backgroundRunning()).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(runs[0]!.cancelMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); // t = 1000：超时、发 cancel
      expect(runs[0]!.cancelMock).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(0);
      expect(link.control.backgroundRunning()).toBe(1); // 宽限内仍算在跑

      await vi.advanceTimersByTimeAsync(499); // t = 1499：宽限还没到
      expect(events).toHaveLength(0);
      expect(link.control.backgroundRunning()).toBe(1);
      expect(closes[0]).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // t = 1500：强制收尾
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "failed" });
      expect(events[0]!.text).toContain("仍未完成");
      expect(link.control.backgroundRunning()).toBe(0);
      expect(closes[0]).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(120_000); // 之后不会再有重复通知 / 重复关闭
      expect(events).toHaveLength(1);
      expect(closes[0]).toHaveBeenCalledTimes(1);
    },
  );

  it("宽限缺省 30 秒：maxRuntime 到点后再过 30 秒才强制收尾（不是 29 秒、也不会更久）", async () => {
    expect(BACKGROUND_SUBAGENT_CANCEL_GRACE_MS).toBe(30_000);
    const { link, events } = setup({
      cancel: "reject",
      background: { maxRuntimeMs: 1000 },
    });
    await call(link, { prompt: "跑不完", run_in_background: true });

    await vi.advanceTimersByTimeAsync(1000 + 29_999);
    expect(events).toHaveLength(0);
    expect(link.control.backgroundRunning()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "failed" });
    expect(link.control.backgroundRunning()).toBe(0);
  });

  it("cancel 自己挂死：30 秒期限一到放弃等待并告警；告警不影响宽限到点的强制收尾", async () => {
    const { link, events } = setup({
      cancel: "hang",
      background: { maxRuntimeMs: 1000, cancelGraceMs: 60_000 },
    });
    await call(link, { prompt: "跑不完", run_in_background: true });

    await vi.advanceTimersByTimeAsync(1000 + 29_999);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // cancel 发出后第 30 秒
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("cancel 失败 / 超时");
    expect(String(warn.mock.calls[0]![1])).toContain("超时");
    expect(events).toHaveLength(0); // 宽限 60 秒还没到

    await vi.advanceTimersByTimeAsync(30_000); // t = 1000 + 60_000
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "failed" });
  });

  it("cancel 返回 rejection：原因写进告警（不静默吞掉）", async () => {
    const { link } = setup({
      cancel: "reject",
      background: { maxRuntimeMs: 1000, cancelGraceMs: 500 },
    });
    await call(link, { prompt: "跑不完", run_in_background: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("cancel 失败 / 超时");
    expect(String(warn.mock.calls[0]![1])).toContain("network down");
  });

  it("强制收尾放掉 resume 的占位：收尾前同一个子代理仍是「还在运行」，收尾后又能 resume", async () => {
    const { link, runs, events } = setup({
      withIds: true,
      cancel: ["ok", "reject", "ok"],
      background: { maxRuntimeMs: 1000, cancelGraceMs: 500 },
    });
    // 先前台跑完第一个，拿到可 resume 的 id
    const first = call(link, { prompt: "第一次" });
    await vi.advanceTimersByTimeAsync(1);
    runs[0]!.finish("第一次结果");
    const firstOut = await first;
    const childId = /resume="(child-\d+)"/.exec(firstOut.text)?.[1];
    expect(childId).toBe("child-1");

    // 后台 resume 它：这一个的 cancel 会抛错、流也不结束
    const bgOut = await call(link, {
      prompt: "接着做",
      resume: childId,
      run_in_background: true,
    });
    expect(bgOut.isError).toBe(false);
    const busy = await call(link, { prompt: "再来", resume: childId });
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain("还在运行");

    await vi.advanceTimersByTimeAsync(1500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "failed" });

    const third = call(link, { prompt: "收尾后再 resume", resume: childId });
    await vi.advanceTimersByTimeAsync(1);
    runs[2]!.finish("第三次结果");
    expect((await third).isError).toBe(false);
  });

  it("强制收尾把后台名额还回来：上限 2 的会话，两个都挂死超时后又能派满", async () => {
    const { link, events } = setup({
      cancel: "reject",
      background: { maxConcurrent: 2, maxRuntimeMs: 1000, cancelGraceMs: 500 },
    });
    await call(link, { prompt: "a", run_in_background: true });
    await call(link, { prompt: "b", run_in_background: true });
    const full = await call(link, { prompt: "c", run_in_background: true });
    expect(full.isError).toBe(true);
    expect(full.text).toContain("上限 2");

    await vi.advanceTimersByTimeAsync(1500);
    expect(events.map((e) => e.status)).toEqual(["failed", "failed"]);
    expect(link.control.backgroundRunning()).toBe(0);

    expect((await call(link, { prompt: "d", run_in_background: true })).isError).toBe(false);
    expect((await call(link, { prompt: "e", run_in_background: true })).isError).toBe(false);
    expect(link.control.backgroundRunning()).toBe(2);
  });

  it("子 agent 的 close 也挂死：最多再等 30 秒就放弃等待、照样收尾（后台清单不被 close 拖住）", async () => {
    const { link, events, closes } = setup({
      cancel: "reject",
      closeHangs: true,
      background: { maxRuntimeMs: 1000, cancelGraceMs: 500 },
    });
    await call(link, { prompt: "跑不完", run_in_background: true });

    await vi.advanceTimersByTimeAsync(1500); // 强制收尾已触发，收尾卡在 close 上
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    expect(link.control.backgroundRunning()).toBe(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "failed" });
    expect(link.control.backgroundRunning()).toBe(0);
  });

  it("强制收尾之后子 run 才迟到地成功：结果丢弃——不重复通知、不登记成可 resume、过程记录仍是失败·超时、迟到的流消息不再记", async () => {
    const { sink, handle } = fakeSink();
    const { link, runs, events } = setup({
      withIds: true,
      cancel: "reject",
      transcripts: sink,
      background: { maxRuntimeMs: 1000, cancelGraceMs: 500 },
    });
    await call(link, { prompt: "跑不完", run_in_background: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(events).toHaveLength(1);
    expect(handle.finish).toHaveBeenCalledTimes(1);
    expect(handle.finish).toHaveBeenCalledWith({
      status: "failed",
      error: expect.stringContaining("仍未完成"),
    });

    runs[0]!.finish("迟到的结果", { type: "assistant", text: "迟到的流消息" });
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toHaveLength(1);
    expect(handle.finish).toHaveBeenCalledTimes(1);
    expect(handle.onMessage).not.toHaveBeenCalled();

    // 迟到的成功没有把它登记成可 resume 的子代理
    const resumed = await call(link, { prompt: "接着", resume: "child-1" });
    expect(resumed.isError).toBe(true);
    expect(resumed.text).toContain("找不到子代理");
  });

  it("【对照】cancel 正常生效：走原来的收尾（failed·超时），宽限计时器被清掉、不重复通知、不重复关闭", async () => {
    const { link, events, closes } = setup({
      cancel: "ok",
      background: { maxRuntimeMs: 1000, cancelGraceMs: 500 },
    });
    await call(link, { prompt: "x", run_in_background: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "failed" });
    expect(events[0]!.text).toContain("仍未完成");
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // 计时器全部清掉（含宽限计时器、cancel / close 的期限计时器）

    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toHaveLength(1);
    expect(closes[0]).toHaveBeenCalledTimes(1);
  });

  it("【对照】按时完成：不发 cancel、不告警、计时器全清", async () => {
    const { link, runs, events } = setup({
      cancel: "reject",
      background: { maxRuntimeMs: 1000, cancelGraceMs: 500 },
    });
    await call(link, { prompt: "很快", run_in_background: true });
    await vi.advanceTimersByTimeAsync(100);
    runs[0]!.finish("好了");
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "done", text: expect.stringContaining("好了") });
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs[0]!.cancelMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });
});

describe("上限从「子代理开始」起算：前台已经跑的时间要扣掉", () => {
  const MIN = 60_000;

  it("前台跑了 25 分钟才被插话转后台：再过 5 分钟（总共 30 分钟）就超时，不是再给 30 分钟", async () => {
    const { link, runs } = setup({
      cancel: "ok",
      background: { maxRuntimeMs: 30 * MIN },
    });
    const fg = call(link, { prompt: "前台" });
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(link.control.detachForeground()).toBe(1);
    expect((await fg).text).toContain("已转到后台");

    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(runs[0]!.cancelMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 距子代理开始刚好 30 分钟
    expect(runs[0]!.cancelMock).toHaveBeenCalledTimes(1);
  });

  it("前台已经跑过头（40 分钟 > 上限）才转后台：最多再给 1 秒就收尾，不再多给一个完整的上限", async () => {
    const { link, runs, events } = setup({
      cancel: "ok",
      background: { maxRuntimeMs: 30 * MIN },
    });
    const fg = call(link, { prompt: "前台" });
    await vi.advanceTimersByTimeAsync(40 * MIN);
    expect(link.control.detachForeground()).toBe(1);
    await fg;

    await vi.advanceTimersByTimeAsync(999);
    expect(runs[0]!.cancelMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runs[0]!.cancelMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "failed", detached: true });
  });

  it("前台转后台之后 cancel 也没能让子 run 收尾：同样宽限到点强制收尾（转后台这个出口也接了强制收尾）", async () => {
    const { link, runs, events, closes } = setup({
      cancel: "reject",
      background: { maxRuntimeMs: 10_000, cancelGraceMs: 500 },
    });
    const fg = call(link, { prompt: "前台" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(link.control.detachForeground()).toBe(1);
    expect((await fg).text).toContain("已转到后台");
    expect(link.control.backgroundRunning()).toBe(1);

    await vi.advanceTimersByTimeAsync(6999); // 距子代理开始 9999ms：还没超时
    expect(runs[0]!.cancelMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 10_000ms：超时、发 cancel（cancel 返回 rejection，子 run 不收尾）
    expect(runs[0]!.cancelMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    expect(link.control.backgroundRunning()).toBe(1);

    await vi.advanceTimersByTimeAsync(499); // 宽限还没到
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); // 宽限到点：强制收尾
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "failed", detached: true });
    expect(events[0]!.text).toContain("仍未完成");
    expect(link.control.backgroundRunning()).toBe(0);
    expect(closes[0]).toHaveBeenCalledTimes(1);
  });

  it("一开始就是后台：上限就是从启动算（行为不变）", async () => {
    const { link, runs } = setup({
      cancel: "ok",
      background: { maxRuntimeMs: 30 * MIN },
    });
    await call(link, { prompt: "后台", run_in_background: true });
    await vi.advanceTimersByTimeAsync(30 * MIN - 1);
    expect(runs[0]!.cancelMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runs[0]!.cancelMock).toHaveBeenCalledTimes(1);
  });
});
