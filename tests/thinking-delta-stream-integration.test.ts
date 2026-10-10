/**
 * thinking_delta 实时帧：走真实发布通路的集成验证（不 mock task-stream）
 *
 * 复现 2026-10-10 的实测场景：一段思考持续 65s、期间 1111 条 token 级 chunk（thinkingSegments=1）。
 * 修复前：订阅者在这 65s 里**一帧都收不到**——thinking 要攒到段结束才落一条事件，
 * 界面只能写「等待模型响应… 已等待 62s」，用户体感 70s 才有响应（服务端口径 firstDeltaMs 却只有 6s）。
 *
 * 这里用真实的 handleSdkMessage + 真实的 task-stream（publish / subscribeTaskStream），
 * 只把磁盘（task-fs.appendEvent）换成「回调 onCommitted 即视为落盘」的假实现，钉死五条承诺：
 *   ① 首帧零延迟——第一个 chunk 到达的同一时刻订阅者就收到「在思考」；
 *   ② 帧率收敛——1111 条 chunk 合成约 260 帧（≤ 4 帧/s），相邻帧间隔 ≥ 250ms；
 *   ③ 顺序——所有实时帧都先于落盘的 thinking 事件到达、之后不再有幽灵帧；
 *   ④ 落盘不变——thinking 事件仍是整段一条、带完整文本（实时帧只是预告，不是正式内容）；
 *   ⑤ 同一个 id——所有实时帧的 eventId 相同，且正是落盘 thinking 事件的 id：
 *      前端据此把「进行中的思考行」和落盘行对成同一个 React 节点（点开着读的不会被收起）。
 *      （假落盘与真实 appendEvent 一样尊重事件里预先指定的 id，所以实现若没把 id 带进落盘事件，这条会挂。）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/task-fs", () => {
  let seq = 0;
  return {
    getTask: vi.fn(),
    patchActionIfOwner: vi.fn(),
    // 假落盘：lease 失主返回 null，否则立刻视为已提交（真实实现是写盘后回调 onCommitted）
    appendEvent: async (
      _taskId: string,
      ev: Record<string, unknown>,
      lease?: () => boolean,
      onCommitted?: (event: unknown) => void,
    ) => {
      if (lease && !lease()) return null;
      seq += 1;
      const event = { id: `e${seq}`, ts: Date.now(), seq, ...ev };
      onCommitted?.(event);
      return event;
    },
  };
});

vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => {}),
}));

vi.mock("@/lib/server/tool-result-persist", () => ({
  buildToolResultMeta: vi.fn(async () => ({
    callId: "c1",
    name: "shell",
    status: "ok",
    output: "ok",
  })),
}));

const { subscribeTaskStream } = await import("@/lib/server/task-stream");
const {
  handleSdkMessage,
  discardPendingThinkingDeltas,
  THINKING_DELTA_INTERVAL_MS,
  __resetToolCallRunningSeenForTest,
} = await import("@/lib/server/sdk-message-handler");
import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";

const TASK = "task-thinking-integration";
const leaseOk = () => true;

/** 实测：thinkingSegments=1 内的 thinking-delta 条数 */
const TOTAL_CHUNKS = 1111;
/** 实测：65370ms / 1111 ≈ 59ms 一条 */
const STEP_MS = 59;

type Frame = {
  /** 相对第一个 chunk 到达时刻的毫秒数 */
  at: number;
  kind: string;
  /** thinking_delta 的增量 / event 帧里事件的文本 */
  text?: string;
  /** kind === "event" 时事件自己的 kind */
  eventKind?: string;
  /** thinking_delta 帧的 eventId / event 帧里事件自己的 id */
  id?: string;
};

describe("thinking_delta 真实发布通路（65s / 1111 条 chunk 的实测场景）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    discardPendingThinkingDeltas(TASK);
    __resetToolCallRunningSeenForTest();
  });

  afterEach(() => {
    discardPendingThinkingDeltas(TASK);
    vi.useRealTimers();
  });

  it("首帧零延迟、帧率收敛、帧先于落盘事件、落盘仍是整段一条", async () => {
    const chunks = Array.from({ length: TOTAL_CHUNKS }, (_, i) => `tok${i} `);
    const allText = chunks.join("");
    const maxChunkChars = Math.max(...chunks.map((c) => c.length));

    const t0 = Date.now();
    const frames: Frame[] = [];
    const unsub = subscribeTaskStream(TASK, (ev) => {
      frames.push({
        at: Date.now() - t0,
        kind: ev.kind,
        text:
          ev.kind === "thinking_delta"
            ? ev.text
            : ev.kind === "event"
              ? ev.event.text
              : undefined,
        eventKind: ev.kind === "event" ? ev.event.kind : undefined,
        id:
          ev.kind === "thinking_delta"
            ? ev.eventId
            : ev.kind === "event"
              ? ev.event.id
              : undefined,
      });
    });

    try {
      const ctx: AssistantBufferCtx = { buffer: "", flush: async () => {} };
      for (let i = 0; i < chunks.length; i++) {
        await handleSdkMessage(
          TASK,
          { type: "thinking", text: chunks[i]! } as never,
          ctx,
          leaseOk,
        );
        // 最后一条 chunk 之后不再等：真实的「思考 → 工具调用」是毫秒级衔接，
        // 此刻节流窗口里还压着没发的尾巴——正是「段结束丢尾巴 / 不出幽灵帧」要覆盖的分支
        if (i < chunks.length - 1) vi.advanceTimersByTime(STEP_MS);
      }
      // 思考结束：模型发起工具调用 → 先把整段思考落盘，再落 tool_call
      await handleSdkMessage(
        TASK,
        {
          type: "tool_call",
          name: "shell",
          call_id: "c1",
          status: "running",
          args: { command: "echo hi" },
        } as never,
        ctx,
        leaseOk,
      );
      // 再让时间走很久：不能再冒出幽灵帧
      vi.advanceTimersByTime(THINKING_DELTA_INTERVAL_MS * 10);
    } finally {
      unsub();
    }

    const live = frames.filter((f) => f.kind === "thinking_delta");
    const thinkingEvents = frames.filter(
      (f) => f.kind === "event" && f.eventKind === "thinking",
    );
    const thinkingEventIdx = frames.findIndex(
      (f) => f.kind === "event" && f.eventKind === "thinking",
    );

    // ① 首帧零延迟：第一个 chunk 到达的同一时刻订阅者就收到了「在思考」
    //    （修复前：一直等到整段思考结束、约 65s 之后才有任何东西）
    expect(live.length).toBeGreaterThan(0);
    expect(live[0]!.at).toBe(0);

    // ② 帧率收敛：1111 条 chunk → 约 65.5s / 250ms ≈ 262 帧，不是 1111 帧
    expect(live.length).toBeGreaterThanOrEqual(240);
    expect(live.length).toBeLessThanOrEqual(270);
    //    相邻实时帧间隔 ≥ 250ms（≤ 4 帧/s）
    for (let i = 1; i < live.length; i++) {
      expect(live[i]!.at - live[i - 1]!.at).toBeGreaterThanOrEqual(
        THINKING_DELTA_INTERVAL_MS,
      );
    }

    // ③ 顺序：所有实时帧都先于落盘的 thinking 事件；它之后不再有幽灵帧
    expect(thinkingEventIdx).toBeGreaterThan(0);
    const lastLiveIdx = frames.map((f) => f.kind).lastIndexOf("thinking_delta");
    expect(lastLiveIdx).toBeLessThan(thinkingEventIdx);

    // ④ 落盘不变：thinking 事件整段一条、带完整文本；实时帧拼起来只是它的前缀
    //    （段结束时丢掉的尾巴最多是最后一个 250ms 窗口里的内容）
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0]!.text).toBe(allText);
    const liveText = live.map((f) => f.text ?? "").join("");
    expect(allText.startsWith(liveText)).toBe(true);
    const droppedChars = allText.length - liveText.length;
    // 场景自检：段结束时窗口里确实压着没发的尾巴，否则「丢尾巴 / 无幽灵帧」这条分支根本没被覆盖
    expect(droppedChars).toBeGreaterThan(0);
    // 丢掉的至多是最后一个节流窗口里的内容（+1 条 chunk 的边界容差）
    const chunksPerWindow = Math.ceil(THINKING_DELTA_INTERVAL_MS / STEP_MS);
    expect(droppedChars).toBeLessThanOrEqual(
      (chunksPerWindow + 1) * maxChunkChars,
    );

    // ⑤ 同一个 id：260 多帧的 eventId 全相同，且正是落盘 thinking 事件的 id
    const liveIds = new Set(live.map((f) => f.id));
    expect(liveIds.size).toBe(1);
    const [liveId] = [...liveIds];
    expect(liveId).toBeTruthy();
    expect(thinkingEvents[0]!.id).toBe(liveId);
  });
});
