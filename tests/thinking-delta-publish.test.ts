/**
 * handleSdkMessage：thinking_delta 实时帧（让「思考中」在思考进行中就可见）
 *
 * 背景（2026-10-10 实测）：一段 65s 的思考（thinkingSegments=1、1111 条 token 级 chunk），
 * 服务端第 6s 就收到首个增量，但整段攒在 thinkingBuffer 里、到段结束才落一条 thinking 事件。
 * 用户对着「等待模型响应… 已等待 62s」干等了 70s——服务端口径的 firstDeltaMs 只有 6s，
 * 指标一切正常，用户却以为卡死。
 *
 * 这里钉死实时帧的语义：
 *   - 首个 chunk 立刻发（零延迟）、其后每 250ms 最多一帧（带期间攒的增量、一个字不丢）；
 *   - 段结束（任何非 thinking 消息 / 落盘 / run 结束）→ 没发的尾巴直接丢，下一段重新「立即发」；
 *   - 旁路答疑（origin）/ 已提问消音（askSeen）/ 回合结束后的重放 / lease 失主 → 不发；
 *   - 落盘仍是「一段一条 thinking 事件、带完整文本」，不受实时帧影响；
 *   - eventId：一段思考的第一个 chunk 就预定好落盘事件的 id，每帧都带、落盘时复用——
 *     前端据此把「进行中的思考行」和落盘行对成同一个 React 节点（点开着读的不会被收起）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WrittenEvent = {
  kind: string;
  text?: string;
  /** 预定的落盘 id（没发过实时帧的路径没有，由 appendEvent 现生成） */
  id?: string;
  meta?: Record<string, unknown>;
};
type PublishedFrame = { kind: string; text?: string; eventId?: string };

type AnyFn<R> = (...args: unknown[]) => R;
const writeOwnedEventAndPublish = vi.fn<AnyFn<Promise<void>>>(async () => {});
const appendEvent = vi.fn<AnyFn<Promise<null>>>(async () => null);
const publishIfCurrent = vi.fn<AnyFn<boolean>>(() => true);

vi.mock("@/lib/server/task-fs", () => ({
  getTask: vi.fn(),
  patchActionIfOwner: vi.fn(),
  appendEvent: (...args: unknown[]) => appendEvent(...args),
}));

vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => {}),
}));

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    writeOwnedEventAndPublish: (...args: unknown[]) =>
      writeOwnedEventAndPublish(...args),
    publish: vi.fn(),
    publishIfCurrent: (...args: unknown[]) => publishIfCurrent(...args),
  };
});

vi.mock("@/lib/server/tool-result-persist", () => ({
  buildToolResultMeta: vi.fn(async () => ({
    callId: "c1",
    name: "shell",
    status: "ok",
    output: "ok",
  })),
}));

const {
  handleSdkMessage,
  flushThinkingBuffer,
  discardPendingThinkingDeltas,
  THINKING_DELTA_INTERVAL_MS,
  __resetToolCallRunningSeenForTest,
} = await import("@/lib/server/sdk-message-handler");
import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";

const TASK = "task-thinking-live";
const leaseOk = () => true;

const mkCtx = (over: Partial<AssistantBufferCtx> = {}): AssistantBufferCtx => ({
  buffer: "",
  flush: async () => {},
  ...over,
});

const thinkingMsg = (text: string) => ({ type: "thinking", text }) as never;
const toolRunning = (callId = "c1") =>
  ({
    type: "tool_call",
    name: "shell",
    call_id: callId,
    status: "running",
    args: { command: "echo hi" },
  }) as never;
const usageMsg = () =>
  ({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } }) as never;

/** 已 publish 的 thinking_delta 帧文本（按发送顺序） */
const thinkingFrames = (taskId = TASK): string[] =>
  publishIfCurrent.mock.calls
    .filter((c) => c[0] === taskId)
    .map((c) => c[2] as PublishedFrame)
    .filter((f) => f?.kind === "thinking_delta")
    .map((f) => f.text ?? "");

/** 已落盘的 thinking 事件文本 */
const persistedThinking = (): string[] =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => c[2] as WrittenEvent)
    .filter((e) => e?.kind === "thinking")
    .map((e) => e.text ?? "");

/** 已 publish 的 thinking_delta 帧里的 eventId（按发送顺序） */
const thinkingFrameIds = (taskId = TASK): Array<string | undefined> =>
  publishIfCurrent.mock.calls
    .filter((c) => c[0] === taskId)
    .map((c) => c[2] as PublishedFrame)
    .filter((f) => f?.kind === "thinking_delta")
    .map((f) => f.eventId);

/** 已落盘（writeOwnedEventAndPublish）的 thinking 事件完整对象 + 它的 origin（第 4 个参数） */
const persistedThinkingEvents = (): Array<{
  ev: WrittenEvent;
  origin: string | undefined;
}> =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => ({ ev: c[2] as WrittenEvent, origin: c[3] as string | undefined }))
    .filter((x) => x.ev?.kind === "thinking");

describe("handleSdkMessage thinking_delta 实时帧", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    publishIfCurrent.mockClear();
    writeOwnedEventAndPublish.mockClear();
    appendEvent.mockClear();
    discardPendingThinkingDeltas(TASK);
    discardPendingThinkingDeltas("task-other");
    __resetToolCallRunningSeenForTest();
  });

  afterEach(() => {
    discardPendingThinkingDeltas(TASK);
    discardPendingThinkingDeltas("task-other");
    vi.useRealTimers();
  });

  it("首个 chunk 立刻发一帧（零延迟）——不等任何定时器", async () => {
    await handleSdkMessage(TASK, thinkingMsg("先"), mkCtx(), leaseOk);
    expect(thinkingFrames()).toEqual(["先"]);
  });

  it("节流窗口内的后续 chunk 合成一帧、到点才发", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk); // 立即发
    vi.advanceTimersByTime(10);
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, leaseOk);
    vi.advanceTimersByTime(10);
    await handleSdkMessage(TASK, thinkingMsg("C"), ctx, leaseOk);
    // 窗口内不发
    expect(thinkingFrames()).toEqual(["A"]);

    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS);
    expect(thinkingFrames()).toEqual(["A", "BC"]);
  });

  it("窗口过去之后的下一个 chunk 又立即发（leading），不会被无谓延后", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk);
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS + 1);
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, leaseOk);
    expect(thinkingFrames()).toEqual(["A", "B"]);
  });

  it("持续高频流入：帧率被限在每 250ms 一帧，且一个字不丢", async () => {
    // 实测一段 65s 思考有 1111 条 chunk（约每 59ms 一条）——这里 10ms 一条、压测 1s
    const ctx = mkCtx();
    const chunks = Array.from({ length: 100 }, (_, i) => `t${i} `);
    for (const c of chunks) {
      await handleSdkMessage(TASK, thinkingMsg(c), ctx, leaseOk);
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS);

    const frames = thinkingFrames();
    // 1s / 250ms ≈ 4~5 帧（含首帧与收尾帧），远小于 100 条 chunk
    expect(frames.length).toBeLessThanOrEqual(6);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    // 节流只合帧、不丢内容
    expect(frames.join("")).toBe(chunks.join(""));
  });

  it("空 chunk 不发帧", async () => {
    await handleSdkMessage(TASK, thinkingMsg(""), mkCtx(), leaseOk);
    expect(thinkingFrames()).toEqual([]);
  });

  it("段结束（来了非 thinking 消息）：没发的尾巴直接丢；落盘仍是整段一条、带完整文本", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk); // 立即发
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, leaseOk); // 排队等 250ms
    expect(thinkingFrames()).toEqual(["A"]);

    // 工具调用到来 = 这段思考结束：先落盘 thinking、尾巴 "B" 不再补发
    await handleSdkMessage(TASK, toolRunning(), ctx, leaseOk);
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS * 4);

    expect(thinkingFrames()).toEqual(["A"]);
    expect(persistedThinking()).toEqual(["AB"]);
  });

  it("task 模式（没开重放保护）usage 到来也算段结束：排队的尾巴不再补发", async () => {
    // usage 在 task 模式不冲 thinking（要等 run 结束才落盘），不经过 flushThinkingBuffer——
    // 这种路径只靠 handleSdkMessage 入口的「非 thinking 消息即丢尾巴」兜底
    const ctx = mkCtx(); // dropAfterTurnEnded 未设置
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk);
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, leaseOk); // 排队
    await handleSdkMessage(TASK, usageMsg(), ctx, leaseOk);
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS * 4);
    expect(thinkingFrames()).toEqual(["A"]);
    // 没落盘（task 模式 usage 不冲）——说明确实没经过 flushThinkingBuffer
    expect(persistedThinking()).toEqual([]);
  });

  it("下一段思考的首个 chunk 重新「立即发」——节流状态随段结束重置", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk);
    await handleSdkMessage(TASK, toolRunning("c1"), ctx, leaseOk);
    // 时间没动：若节流没重置，这一条要等 250ms
    await handleSdkMessage(TASK, thinkingMsg("C"), ctx, leaseOk);
    expect(thinkingFrames()).toEqual(["A", "C"]);
  });

  it("旁路答疑（带 origin）不发：前端不区分帧属于哪一路 run、会串到主链的状态行；落盘照旧", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("旁路在想"), ctx, leaseOk, "restricted-token");
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS * 2);
    expect(thinkingFrames()).toEqual([]);

    await handleSdkMessage(TASK, toolRunning(), ctx, leaseOk, "restricted-token");
    expect(persistedThinking()).toEqual(["旁路在想"]);
  });

  it("已提问消音（askSeen）不发：与落盘的 muted thinking 同口径", async () => {
    const ctx = mkCtx({ askSeen: true });
    await handleSdkMessage(TASK, thinkingMsg("等答案时的思考"), ctx, leaseOk);
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS * 2);
    expect(thinkingFrames()).toEqual([]);
  });

  it("回合结束后的重放（dropAfterTurnEnded + usage 之后）不发：重放内容本来就不上屏", async () => {
    const ctx = mkCtx({ dropAfterTurnEnded: true });
    await handleSdkMessage(TASK, thinkingMsg("正常思考"), ctx, leaseOk);
    await handleSdkMessage(TASK, usageMsg(), ctx, leaseOk); // turn-ended
    publishIfCurrent.mockClear();

    await handleSdkMessage(TASK, thinkingMsg("SDK 重放的思考"), ctx, leaseOk);
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS * 2);
    expect(thinkingFrames()).toEqual([]);
  });

  it("lease 失主（run 已被新一轮取代）：排队的帧到点不发", async () => {
    let current = true;
    const lease = () => current;
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, lease);
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, lease);
    current = false;
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS);
    expect(thinkingFrames()).toEqual(["A"]);
  });

  it("flushThinkingBuffer（run 结束路径）也会清掉排队的帧，不留残余定时器", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk);
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, leaseOk);
    await flushThinkingBuffer(TASK, ctx, leaseOk);
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS * 4);

    expect(thinkingFrames()).toEqual(["A"]);
    expect(persistedThinking()).toEqual(["AB"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("不同任务各自节流、互不干扰", async () => {
    await handleSdkMessage(TASK, thinkingMsg("甲1"), mkCtx(), leaseOk);
    await handleSdkMessage("task-other", thinkingMsg("乙1"), mkCtx(), leaseOk);
    // 两个任务的首帧都是立即发，不会因为对方刚发过而被延后
    expect(thinkingFrames(TASK)).toEqual(["甲1"]);
    expect(thinkingFrames("task-other")).toEqual(["乙1"]);

    // 一个任务的段结束不会丢掉另一个任务排队的帧
    await handleSdkMessage(TASK, thinkingMsg("甲2"), mkCtx(), leaseOk);
    await handleSdkMessage("task-other", thinkingMsg("乙2"), mkCtx(), leaseOk);
    await handleSdkMessage(TASK, toolRunning("cA"), mkCtx(), leaseOk);
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS);
    expect(thinkingFrames(TASK)).toEqual(["甲1"]);
    expect(thinkingFrames("task-other")).toEqual(["乙1", "乙2"]);
  });
});

describe("thinking_delta 的 eventId：实时帧预定的 id 与落盘事件是同一个", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    publishIfCurrent.mockClear();
    writeOwnedEventAndPublish.mockClear();
    appendEvent.mockClear();
    discardPendingThinkingDeltas(TASK);
    __resetToolCallRunningSeenForTest();
  });

  afterEach(() => {
    discardPendingThinkingDeltas(TASK);
    vi.useRealTimers();
  });

  it("同一段的所有实时帧带同一个 eventId，落盘的 thinking 事件复用它", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk); // 立即发
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS + 1);
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, leaseOk); // 又一帧
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS + 1);
    await handleSdkMessage(TASK, thinkingMsg("C"), ctx, leaseOk); // 第三帧

    const ids = thinkingFrameIds();
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBeTruthy();
    expect(new Set(ids).size).toBe(1);

    // 工具调用到来 = 段结束 → 整段落盘：事件 id 就是帧里告诉前端的那个
    await handleSdkMessage(TASK, toolRunning(), ctx, leaseOk);
    const persisted = persistedThinkingEvents();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.ev.id).toBe(ids[0]);
    expect(persisted[0]!.ev.text).toBe("ABC");
  });

  it("下一段思考换新 id：一个 id 只落一条事件，不会串到下一段", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk);
    await handleSdkMessage(TASK, toolRunning("c1"), ctx, leaseOk); // 第一段落盘
    await handleSdkMessage(TASK, thinkingMsg("C"), ctx, leaseOk); // 第二段首帧
    await handleSdkMessage(TASK, toolRunning("c2"), ctx, leaseOk); // 第二段落盘

    const ids = thinkingFrameIds();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);

    const persisted = persistedThinkingEvents();
    expect(persisted.map((p) => p.ev.id)).toEqual([ids[0], ids[1]]);
    expect(persisted.map((p) => p.ev.text)).toEqual(["A", "C"]);
  });

  it("空 chunk 不预定 id（没有内容的段不该占一个 id）", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg(""), ctx, leaseOk);
    expect(ctx.thinkingEventId).toBeUndefined();
    expect(thinkingFrameIds()).toEqual([]);
  });

  it("旁路答疑（origin）：落盘不带预定 id，而且不会取走主链正在用的 id", async () => {
    const main = mkCtx();
    const side = mkCtx();

    await handleSdkMessage(TASK, thinkingMsg("主链在想"), main, leaseOk);
    const [mainId] = thinkingFrameIds();
    expect(mainId).toBeTruthy();

    // 旁路在同一个任务上思考 + 调工具（触发它自己的 flush）：它没发过帧、没有预定 id
    await handleSdkMessage(TASK, thinkingMsg("旁路在想"), side, leaseOk, "restricted-token");
    await handleSdkMessage(TASK, toolRunning("side-c"), side, leaseOk, "restricted-token");
    expect(side.thinkingEventId).toBeUndefined();
    const sidePersisted = persistedThinkingEvents().filter(
      (p) => p.origin === "restricted-token",
    );
    expect(sidePersisted).toHaveLength(1);
    expect(sidePersisted[0]!.ev.text).toBe("旁路在想");
    expect(sidePersisted[0]!.ev.id).toBeUndefined(); // 由 appendEvent 现生成

    // 主链的预定 id 没被旁路动过：主链落盘仍复用它
    await flushThinkingBuffer(TASK, main, leaseOk);
    const mainPersisted = persistedThinkingEvents().filter(
      (p) => p.origin === undefined,
    );
    expect(mainPersisted).toHaveLength(1);
    expect(mainPersisted[0]!.ev.id).toBe(mainId);
  });

  it("已提问消音（askSeen）之后才落盘（走 appendEvent、muted）：仍复用帧里已经给前端的 id", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk); // askSeen 之前：发了帧
    const [frameId] = thinkingFrameIds();
    expect(frameId).toBeTruthy();

    ctx.askSeen = true; // 之后模型提了问
    await flushThinkingBuffer(TASK, ctx, leaseOk);

    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled(); // muted 不 publish
    expect(appendEvent).toHaveBeenCalledTimes(1);
    const written = appendEvent.mock.calls[0]![1] as WrittenEvent;
    expect(written.kind).toBe("thinking");
    expect(written.id).toBe(frameId);
    expect(written.meta?.muted).toBe(true);
  });

  it("lease 失主：不落盘，预定的 id 也不会漏给下一段", async () => {
    let current = true;
    const lease = () => current;
    const ctx = mkCtx();

    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, lease);
    const [firstId] = thinkingFrameIds();
    expect(firstId).toBeTruthy();

    current = false;
    await flushThinkingBuffer(TASK, ctx, lease); // 失主：不落盘
    expect(persistedThinkingEvents()).toEqual([]);
    expect(ctx.thinkingEventId).toBeUndefined();

    current = true;
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, lease);
    const ids = thinkingFrameIds();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBeTruthy();
    expect(ids[1]).not.toBe(firstId);
  });

  it("回合结束后重放的思考（dropAfterTurnEnded）不预定 id——它既不发帧也不落盘", async () => {
    const ctx = mkCtx({ dropAfterTurnEnded: true });
    await handleSdkMessage(TASK, thinkingMsg("正常思考"), ctx, leaseOk);
    await handleSdkMessage(TASK, usageMsg(), ctx, leaseOk); // turn-ended：落盘并清零
    expect(ctx.thinkingEventId).toBeUndefined();

    await handleSdkMessage(TASK, thinkingMsg("SDK 重放的思考"), ctx, leaseOk);
    expect(ctx.thinkingEventId).toBeUndefined();
    expect(thinkingFrameIds()).toHaveLength(1); // 只有正常那一段的帧
  });

  it("run 交接：旧 run 没来得及清节流状态时，新 run 的帧带它自己预定的 id（不沿用旧 run 的）", async () => {
    // 节流状态按 taskId 共享。run 被新一轮接管时，旧 run 可能根本没走到段结束
    // （既没 flush 也没 discard），状态就残留在表里；新 run 的首个 chunk 会直接命中它。
    // 这时帧里的 eventId 必须是新 run 自己预定的那个——否则前端拿旧 id 画进行中的思考行，
    // 落盘时（新 run 的 id）对不上，用户点开着读的内容会被收起 / 重挂载。
    const oldRun = mkCtx();
    const newRun = mkCtx();

    await handleSdkMessage(TASK, thinkingMsg("旧"), oldRun, leaseOk); // 首帧立即发
    const [oldId] = thinkingFrameIds();
    expect(oldId).toBeTruthy();

    await handleSdkMessage(TASK, thinkingMsg("新"), newRun, leaseOk); // 落进旧 run 残留的节流窗口
    expect(newRun.thinkingEventId).toBeTruthy();
    expect(newRun.thinkingEventId).not.toBe(oldId);

    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS + 1);
    const ids = thinkingFrameIds();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(newRun.thinkingEventId);
    expect(thinkingFrames()).toEqual(["旧", "新"]);
  });
});
