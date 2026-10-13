/**
 * 服务端的思考快照：记住「进行中的那一段」，新订阅者 bootstrap 时据此补一帧（见 watch-task 路由）。
 *
 * 背景（2026-10-13 用户反馈「首轮思考很长，我切窗口再切回来，思考好像又是从第一个字开始吐」）：
 * thinking_delta 是纯内存帧、从不回放，前端的实时态又只活在 ChatView 的本地 state 里——
 * 切到别的对话再切回（组件重挂）、SSE 断流重连，都等于从零开始。
 * 快照 = 「订阅那一刻之前已发出的全部」；之后的实时帧排在它后面，所以它必须与已 publish 的帧严格一致：
 *   - 只含**已发出**的（节流窗口里还没发的尾巴不算——发出时才进快照，否则 bootstrap 之后那一帧会重复）；
 *   - 窗口截尾口径与前端一致（THINKING_TEXT_MAX、同一个 appendThinkingText），累计数 total 不截；
 *   - 段结束 / run 结束 / 失主 → 没有快照（否则重连会复活一个幽灵「思考中」）。
 *
 * 另：旁路答疑（origin）run 与属主主链共用按 taskId 的节流状态。它自己从不发实时帧，
 * 但它的每条消息和收尾 flush 原先都会 discard 这份状态——主链思考进行中，旁路 run 一说话就把
 * 主链的节流状态（现在还有快照）清掉。这里钉死：旁路不碰它。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AnyFn<R> = (...args: unknown[]) => R;
type PublishedFrame = { kind: string; text?: string; eventId?: string };

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
  getLiveThinkingSnapshot,
  THINKING_DELTA_INTERVAL_MS,
  __resetToolCallRunningSeenForTest,
} = await import("@/lib/server/sdk-message-handler");
import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";
import { THINKING_TEXT_MAX } from "@/lib/thinking-live";

const TASK = "task-thinking-snapshot";
const OTHER = "task-thinking-snapshot-other";
const T0 = 1_700_000_000_000;
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

const frames = (taskId = TASK): PublishedFrame[] =>
  publishIfCurrent.mock.calls
    .filter((c) => c[0] === taskId)
    .map((c) => c[2] as PublishedFrame)
    .filter((f) => f?.kind === "thinking_delta");

describe("getLiveThinkingSnapshot：进行中那一段「已发出的」内容", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    publishIfCurrent.mockClear();
    publishIfCurrent.mockImplementation(() => true);
    writeOwnedEventAndPublish.mockClear();
    appendEvent.mockClear();
    discardPendingThinkingDeltas(TASK);
    discardPendingThinkingDeltas(OTHER);
    __resetToolCallRunningSeenForTest();
  });

  afterEach(() => {
    discardPendingThinkingDeltas(TASK);
    discardPendingThinkingDeltas(OTHER);
    vi.useRealTimers();
  });

  it("没有思考在进行 → null", () => {
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();
  });

  it("首帧发出后：快照 = 首帧的文本 / 累计数 / 首帧时刻，eventId 就是帧里带的那个（落盘时复用的预定 id）", async () => {
    await handleSdkMessage(TASK, thinkingMsg("先看"), mkCtx(), leaseOk);
    const [first] = frames();
    expect(getLiveThinkingSnapshot(TASK)).toEqual({
      eventId: first!.eventId,
      text: "先看",
      total: 2,
      since: T0,
    });
  });

  it("节流窗口里还没发出的尾巴不进快照；到点发出后才进（否则 bootstrap 之后那一帧会把它重复一遍）", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk); // 立即发
    vi.advanceTimersByTime(10);
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, leaseOk); // 攒着
    vi.advanceTimersByTime(10);
    await handleSdkMessage(TASK, thinkingMsg("C"), ctx, leaseOk); // 攒着

    expect(frames().map((f) => f.text)).toEqual(["A"]);
    expect(getLiveThinkingSnapshot(TASK)).toMatchObject({ text: "A", total: 1 });

    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS);
    expect(frames().map((f) => f.text)).toEqual(["A", "BC"]);
    expect(getLiveThinkingSnapshot(TASK)).toMatchObject({ text: "ABC", total: 3 });
  });

  it("已入队但一帧都还没发出去（首个 chunk 落在节流窗口里排着）→ null：快照只含已发出的，空快照会让前端重建出一个没有任何文字的「思考中」", async () => {
    // 纪元后 100ms：lastSentAt(0) + 250 − now > 0，首个 chunk 也走 trailing 定时器、而不是立即发
    vi.setSystemTime(100);
    await handleSdkMessage(TASK, thinkingMsg("还没发出"), mkCtx(), leaseOk);
    expect(frames()).toEqual([]);
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();

    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS);
    expect(frames().map((f) => f.text)).toEqual(["还没发出"]);
    expect(getLiveThinkingSnapshot(TASK)).toMatchObject({ text: "还没发出", total: 4 });
  });

  it("任何时刻快照文本 = 已发出的帧拼起来（没截尾时）：高频流入 100 条 chunk，逐步核对", async () => {
    const ctx = mkCtx();
    for (let i = 0; i < 100; i++) {
      await handleSdkMessage(TASK, thinkingMsg(`t${i} `), ctx, leaseOk);
      vi.advanceTimersByTime(10);
      const snap = getLiveThinkingSnapshot(TASK)!;
      expect(snap.text).toBe(frames().map((f) => f.text).join(""));
      expect(snap.total).toBe(snap.text.length);
    }
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS);
    const snap = getLiveThinkingSnapshot(TASK)!;
    expect(snap.text).toBe(Array.from({ length: 100 }, (_, i) => `t${i} `).join(""));
  });

  it("起点是首帧发出的时刻，之后的帧不改它", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk);
    vi.setSystemTime(T0 + 30_000);
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, leaseOk);
    expect(getLiveThinkingSnapshot(TASK)).toMatchObject({ text: "AB", since: T0 });
  });

  it("超过前端保留上限：文本只留尾部（与前端同一个截尾口径），累计数不截，被截掉的数量 = 累计数 − 文本长度", async () => {
    const ctx = mkCtx();
    let full = "";
    for (let i = 0; i < 25; i++) {
      const chunk = `${String(i).padStart(3, "0")}`.padEnd(1000, "·"); // 25 × 1000 = 25000 > 20000
      full += chunk;
      await handleSdkMessage(TASK, thinkingMsg(chunk), ctx, leaseOk);
      vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS + 1);
    }
    const snap = getLiveThinkingSnapshot(TASK)!;
    expect(full.length).toBeGreaterThan(THINKING_TEXT_MAX);
    expect(snap.total).toBe(full.length);
    expect(snap.text.length).toBe(THINKING_TEXT_MAX);
    expect(snap.text).toBe(full.slice(full.length - THINKING_TEXT_MAX));
  });

  it("段结束：下一条非 thinking 消息 / flushThinkingBuffer（run 结束）/ discard 都让快照消失（否则重连会复活幽灵「思考中」）", async () => {
    // ① 紧跟的工具调用
    const ctx1 = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("想"), ctx1, leaseOk);
    expect(getLiveThinkingSnapshot(TASK)).not.toBeNull();
    await handleSdkMessage(TASK, toolRunning(), ctx1, leaseOk);
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();

    // ② run 结束的收尾 flush
    const ctx2 = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("又想"), ctx2, leaseOk);
    expect(getLiveThinkingSnapshot(TASK)).not.toBeNull();
    await flushThinkingBuffer(TASK, ctx2, leaseOk);
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();

    // ③ 直接 discard
    await handleSdkMessage(TASK, thinkingMsg("再想"), mkCtx(), leaseOk);
    discardPendingThinkingDeltas(TASK);
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();
  });

  it("下一段是新的一段：eventId 换新、累计数与起点重新算，上一段的文本不会带过来", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("第一段"), ctx, leaseOk);
    const a = getLiveThinkingSnapshot(TASK)!;
    await handleSdkMessage(TASK, toolRunning(), ctx, leaseOk);

    vi.setSystemTime(T0 + 5_000);
    await handleSdkMessage(TASK, thinkingMsg("第二段"), ctx, leaseOk);
    const b = getLiveThinkingSnapshot(TASK)!;
    expect(b.eventId).not.toBe(a.eventId);
    expect(b).toMatchObject({ text: "第二段", total: 3, since: T0 + 5_000 });
  });

  it("按任务隔离：A 的思考不进 B 的快照，清 A 不影响 B", async () => {
    await handleSdkMessage(TASK, thinkingMsg("甲"), mkCtx(), leaseOk);
    await handleSdkMessage(OTHER, thinkingMsg("乙乙"), mkCtx(), leaseOk);
    expect(getLiveThinkingSnapshot(TASK)).toMatchObject({ text: "甲", total: 1 });
    expect(getLiveThinkingSnapshot(OTHER)).toMatchObject({ text: "乙乙", total: 2 });
    discardPendingThinkingDeltas(TASK);
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();
    expect(getLiveThinkingSnapshot(OTHER)).not.toBeNull();
  });

  it("失主（run 被取消 / 换了新实例 / 已结束）：读取时重估 lease，快照作废并清掉，之后不会复活", async () => {
    let alive = true;
    await handleSdkMessage(TASK, thinkingMsg("x"), mkCtx(), () => alive);
    expect(getLiveThinkingSnapshot(TASK)).not.toBeNull();
    alive = false;
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();
    alive = true;
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();
  });

  it("发帧那一刻 lease 才失主、publish 被拒：这一帧没发出去，不能进快照", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk); // 发出
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS + 1);
    publishIfCurrent.mockImplementationOnce(() => false);
    await handleSdkMessage(TASK, thinkingMsg("B"), ctx, leaseOk); // 到点立即发，但被拒
    expect(getLiveThinkingSnapshot(TASK)).toMatchObject({ text: "A", total: 1 });
  });

  it("旁路答疑（origin）/ 已提问消音（askSeen）不发实时帧，也就没有快照", async () => {
    await handleSdkMessage(TASK, thinkingMsg("旁路在想"), mkCtx(), leaseOk, "restricted-1");
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();
    await handleSdkMessage(OTHER, thinkingMsg("消音"), mkCtx({ askSeen: true }), leaseOk);
    expect(getLiveThinkingSnapshot(OTHER)).toBeNull();
  });
});

describe("旁路答疑 run 不碰属主主链的节流状态 / 快照", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    publishIfCurrent.mockClear();
    publishIfCurrent.mockImplementation(() => true);
    writeOwnedEventAndPublish.mockClear();
    appendEvent.mockClear();
    discardPendingThinkingDeltas(TASK);
    __resetToolCallRunningSeenForTest();
  });

  afterEach(() => {
    discardPendingThinkingDeltas(TASK);
    vi.useRealTimers();
  });

  it("主链思考进行中，旁路 run 来了一条非 thinking 消息（工具调用）：主链快照还在", async () => {
    await handleSdkMessage(TASK, thinkingMsg("主链在想"), mkCtx(), leaseOk);
    const before = getLiveThinkingSnapshot(TASK);
    expect(before).not.toBeNull();

    await handleSdkMessage(TASK, toolRunning("side-1"), mkCtx(), leaseOk, "restricted-1");
    expect(getLiveThinkingSnapshot(TASK)).toEqual(before);
  });

  it("旁路 run 收尾的 flushThinkingBuffer（带 origin）：主链快照还在、主链没发出去的尾巴也还在排队", async () => {
    const mainCtx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), mainCtx, leaseOk); // 立即发
    vi.advanceTimersByTime(10);
    await handleSdkMessage(TASK, thinkingMsg("B"), mainCtx, leaseOk); // 攒着，等 250ms 窗口

    await flushThinkingBuffer(TASK, mkCtx({ thinkingBuffer: "旁路的思考" }), leaseOk, "restricted-1");

    expect(getLiveThinkingSnapshot(TASK)).toMatchObject({ text: "A", total: 1 });
    vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS);
    expect(frames().map((f) => f.text)).toEqual(["A", "B"]); // 尾巴没被旁路清掉
    expect(getLiveThinkingSnapshot(TASK)).toMatchObject({ text: "AB", total: 2 });
  });

  it("主链自己的收尾 flush（无 origin）照旧清（回归：不能因为放过旁路而不清主链）", async () => {
    const ctx = mkCtx();
    await handleSdkMessage(TASK, thinkingMsg("A"), ctx, leaseOk);
    await flushThinkingBuffer(TASK, ctx, leaseOk);
    expect(getLiveThinkingSnapshot(TASK)).toBeNull();
  });
});
