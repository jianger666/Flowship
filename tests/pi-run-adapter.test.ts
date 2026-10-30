/**
 * PiRunAdapter 事件翻译 · 确定性单测（喂合成 pi 事件，不起 HTTP / 真会话）
 *
 * 真链路（真 createCustomAgent + 回环假端点）在 tests/custom-agent-empty-reply.test.ts；
 * 这里钉那些真链路里没法稳定触发的分支（比如「取消」要卡在 agent_end 与 agent_settled 之间）：
 *
 * R14 Q11-01（P1-3）空回复：整个 run（含 pi 内部自动重试）从头到尾没出现过「用户看得见的产出」——
 * 非空白正文 / 工具调用，思考不算——且没有错误、没取消，agent_settled 时以 error 收尾，
 * 文案 = EMPTY_REPLY_MESSAGE。判据只看「整个 run 有没有」，不看最后一条 assistant：
 * 工具跑完后模型一句话不说是正常的（submit_work / ask_user 之后常见）。
 */
import { describe, expect, it, vi } from "vitest";

import { PiRunAdapter } from "@/lib/server/custom-agent-backend";
import { EMPTY_REPLY_MESSAGE, RETRY_INTERRUPTED_TOOL_RESULT } from "@/lib/pi-run-settle";

type Ev = Record<string, unknown>;

const newRun = (opts?: { messages?: unknown[]; errorMessage?: string }): PiRunAdapter =>
  new PiRunAdapter(
    {
      state: { messages: opts?.messages ?? [], errorMessage: opts?.errorMessage },
      abort: async () => {},
    } as never,
    {} as never,
  );

const textDelta = (delta: string): Ev => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});
const thinkingDelta = (delta: string): Ev => ({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta },
});
const toolCallEnd = (id = "call_1"): Ev => ({
  type: "message_update",
  assistantMessageEvent: {
    type: "toolcall_end",
    toolCall: { id, name: "read", arguments: { path: "a.txt" } },
  },
});
const toolExecEnd = (id = "call_1"): Ev => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "read",
  isError: false,
  result: "ok",
});
const messageEnd = (content: unknown[], stopReason = "stop"): Ev => ({
  type: "message_end",
  message: { role: "assistant", stopReason, content },
});
const SETTLED: Ev = { type: "agent_settled" };

/** 依次喂事件（最后必须带 agent_settled，否则 wait() 不会返回）并取收尾结果 */
const finish = async (run: PiRunAdapter, events: Ev[]) => {
  for (const e of events) run.onEvent(e as never);
  return run.wait();
};

describe("PiRunAdapter · 空回复判定（Q11-01）", () => {
  it("一个事件都没有就 settled → error，文案是空回复提示（旧：finished）", async () => {
    expect(await finish(newRun(), [SETTLED])).toEqual({
      status: "error",
      result: EMPTY_REPLY_MESSAGE,
    });
  });

  it("只有思考 → error（思考不算产出：用户这边仍是空回复）", async () => {
    const out = await finish(newRun(), [thinkingDelta("想一想"), SETTLED]);
    expect(out).toEqual({ status: "error", result: EMPTY_REPLY_MESSAGE });
  });

  it("正文只有空白 → error（屏幕上是个空气泡）；空串 delta 也不算", async () => {
    const out = await finish(newRun(), [textDelta(" \n\t "), textDelta(""), SETTLED]);
    expect(out).toEqual({ status: "error", result: EMPTY_REPLY_MESSAGE });
  });

  it("有非空白正文 → finished", async () => {
    expect(await finish(newRun(), [textDelta("好的"), SETTLED])).toEqual({
      status: "finished",
    });
  });

  it("前面是空白、后面才有正文 → finished（出现过非空白正文就算）", async () => {
    const out = await finish(newRun(), [textDelta("\n\n"), textDelta("答"), SETTLED]);
    expect(out.status).toBe("finished");
  });

  it("只有工具调用（toolcall_end）→ finished", async () => {
    expect((await finish(newRun(), [toolCallEnd(), SETTLED])).status).toBe("finished");
  });

  it("只有 tool_execution_end（toolcall_end 漏了）→ finished（兜底：工具都跑了就不是空回复）", async () => {
    expect((await finish(newRun(), [toolExecEnd(), SETTLED])).status).toBe("finished");
  });

  it("没有 text_delta、但 message_end 的整条消息里有非空正文 → finished（兜底：非流式 provider 只给整条）", async () => {
    const out = await finish(newRun(), [
      messageEnd([{ type: "text", text: "整条给的" }]),
      SETTLED,
    ]);
    expect(out.status).toBe("finished");
  });

  it("message_end 的整条消息只有思考 / 空白正文 → error", async () => {
    const out = await finish(newRun(), [
      messageEnd([
        { type: "thinking", thinking: "嗯" },
        { type: "text", text: "  " },
      ]),
      SETTLED,
    ]);
    expect(out).toEqual({ status: "error", result: EMPTY_REPLY_MESSAGE });
  });

  it("message_end 的整条消息里有工具调用 → finished", async () => {
    const out = await finish(newRun(), [
      messageEnd([{ type: "toolCall", id: "c", name: "read", arguments: {} }], "toolUse"),
      SETTLED,
    ]);
    expect(out.status).toBe("finished");
  });

  it("整个 run 出现过工具调用，之后最后一条 assistant 空 stop → finished（判据是整个 run，不是最后一条）", async () => {
    const out = await finish(newRun(), [
      toolCallEnd(),
      messageEnd([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }], "toolUse"),
      toolExecEnd(),
      messageEnd([], "stop"), // 工具回包之后模型一句话没说
      SETTLED,
    ]);
    expect(out.status).toBe("finished");
  });

  it("pi 内部自动重试：前一次吐过半截字、重试后空 stop → finished（那半截用户已经看到了，不算空回复）", async () => {
    const out = await finish(newRun(), [
      textDelta("PART-A "),
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "terminated" },
      messageEnd([], "stop"),
      SETTLED,
    ]);
    expect(out.status).toBe("finished");
  });
});

describe("PiRunAdapter · 空回复判定不吞既有的收尾语义", () => {
  it("用户取消 + 一路没产出 → cancelled，不是空回复报错（取消不是模型的错）", async () => {
    const run = newRun();
    await run.cancel();
    expect(await finish(run, [SETTLED])).toEqual({ status: "cancelled" });
  });

  it("用户取消 + 有产出 → cancelled（既有行为不变）", async () => {
    const run = newRun();
    run.onEvent(textDelta("半截") as never);
    await run.cancel();
    expect(await finish(run, [SETTLED])).toEqual({ status: "cancelled" });
  });

  it("真错误优先于空回复：最后一条 assistant 是 error → 带原文案的 error", async () => {
    const run = newRun({
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "401: bad key" }],
    });
    expect(await finish(run, [SETTLED])).toEqual({
      status: "error",
      result: "401: bad key",
    });
  });

  it("中途粘性错误被后续成功消息清掉、且最后有正文 → finished（既有行为）", async () => {
    const out = await finish(newRun(), [
      messageEnd([], "error"),
      textDelta("恢复了"),
      messageEnd([{ type: "text", text: "恢复了" }]),
      SETTLED,
    ]);
    expect(out.status).toBe("finished");
  });

  it("已经 settle 过的 run 不会被迟到事件改写（settle 幂等）", async () => {
    const run = newRun();
    run.onEvent(SETTLED as never);
    run.onEvent(textDelta("迟到的字") as never);
    run.onEvent(SETTLED as never);
    expect(await run.wait()).toEqual({ status: "error", result: EMPTY_REPLY_MESSAGE });
  });
});

const retryEnd = (finalError: string): Ev => ({
  type: "auto_retry_end",
  success: false,
  attempt: 3,
  finalError,
});
/** pi 在 supportsFinishReason=true 时抛的那句；fatalAssistantError 把它当「残缺收尾、不算出错」 */
const BENIGN_STREAM_END = "Stream ended without finish_reason";

/**
 * 评审意见 F1（Q11-01）：auto_retry_end 失败分支里「缺 finish_reason」这种残缺收尾（fatalAssistantError 为 null）
 * 以前直接 finished、不看有没有产出，会从这条路径漏出一个空的「已完成」。现在与 agent_settled 同一套口径。
 * 注意：这几条都**不喂 agent_settled**——这条分支本来就是为了「不再等 agent_settled」而提前收尾的。
 * 当前配置下 pi 不会再抛缺 finish_reason（compat 已关 supportsFinishReason），这条路径基本走不到；
 * 钉在事件级是为了以后 compat / pi 变动让它重新可达时，空回复的洞不会从这里漏出去。
 */
describe("PiRunAdapter · auto_retry_end 失败分支与 agent_settled 同一套空回复口径", () => {
  it("缺 finish_reason + 一路没产出 → 空回复 error（旧：finished）", async () => {
    expect(await finish(newRun(), [retryEnd(BENIGN_STREAM_END)])).toEqual({
      status: "error",
      result: EMPTY_REPLY_MESSAGE,
    });
  });

  it("缺 finish_reason + 只有思考 → 空回复 error（思考不算产出，两条收尾路径口径一致）", async () => {
    const out = await finish(newRun(), [thinkingDelta("嗯"), retryEnd(BENIGN_STREAM_END)]);
    expect(out).toEqual({ status: "error", result: EMPTY_REPLY_MESSAGE });
  });

  it("缺 finish_reason + 已有正文 → finished（既有语义：正文已在，按成功收尾、不再等 agent_settled）", async () => {
    const out = await finish(newRun(), [textDelta("正文"), retryEnd(BENIGN_STREAM_END)]);
    expect(out).toEqual({ status: "finished" });
  });

  it("缺 finish_reason + 用户取消 → cancelled（取消优先，既有行为不变）", async () => {
    const run = newRun();
    await run.cancel();
    expect(await finish(run, [retryEnd(BENIGN_STREAM_END)])).toEqual({ status: "cancelled" });
  });

  it("finalError 只有空白也算残缺收尾：一路没产出 → 空回复 error", async () => {
    expect(await finish(newRun(), [retryEnd("   ")])).toEqual({
      status: "error",
      result: EMPTY_REPLY_MESSAGE,
    });
  });

  it("真错误 finalError → 仍是带原文案的 error（不被空回复文案覆盖；有半截正文也一样）", async () => {
    expect(await finish(newRun(), [retryEnd("502 Bad Gateway")])).toEqual({
      status: "error",
      result: "502 Bad Gateway",
    });
    expect(await finish(newRun(), [textDelta("半截"), retryEnd("502 Bad Gateway")])).toEqual({
      status: "error",
      result: "502 Bad Gateway",
    });
  });

  it("finalError 为空串且之前也没记过错误 → 兜底文案「模型请求失败」（既有行为，不是空回复）", async () => {
    expect(await finish(newRun(), [retryEnd("")])).toEqual({
      status: "error",
      result: "模型请求失败",
    });
  });
});

// ───────────────── R14 Q11-02（P1-4）：pi 内层自动重试开始 ─────────────────
//
// pi 在流被掐断 / 网关 5xx 之后会自己退避、把这一条回复整个重新生成一遍；出错的半截在重试之前已经推给 UI。
// 这里钉 adapter 这一层：合成边界消息、半截里悬挂的工具调用补 error、不收尾、**不碰 sawOutput**。
// 真链路（真 createCustomAgent + 回环假端点 + 真 handleSdkMessage）在 tests/custom-agent-retry-dup.test.ts。

type Msg = {
  type: string;
  call_id?: string;
  name?: string;
  args?: unknown;
  status?: string;
  result?: unknown;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
};

const retryStart = (attempt = 1, extra: Ev = {}): Ev => ({
  type: "auto_retry_start",
  attempt,
  maxAttempts: 3,
  delayMs: 2000,
  errorMessage: "terminated",
  ...extra,
});

/** run 收尾后把已 push 的 SDKMessage 全取出来（stream() 在 ended 之后把 buffer 吐完就返回） */
const drain = async (run: PiRunAdapter): Promise<Msg[]> => {
  const out: Msg[] = [];
  for await (const m of run.stream()) out.push(m as unknown as Msg);
  return out;
};
const typesOf = (msgs: Msg[]): string[] => msgs.map((m) => m.type);
const callMsgs = (msgs: Msg[], id: string): Msg[] =>
  msgs.filter((m) => m.type === "tool_call" && m.call_id === id);
const statusesOf = (msgs: Msg[], id: string): Array<string | undefined> =>
  callMsgs(msgs, id).map((m) => m.status);

/** 带 onDelta 的 run：收集推给 UI 的实时增量（tool-call-started / tool-call-completed） */
const newRunWithDeltas = () => {
  const updates: Array<{ type: string; callId?: string; toolCall?: unknown }> = [];
  const run = new PiRunAdapter(
    { state: { messages: [] }, abort: async () => {} } as never,
    {
      onDelta: ({ update }: { update: unknown }) =>
        updates.push(update as (typeof updates)[number]),
    } as never,
  );
  return { run, updates };
};

describe("PiRunAdapter · auto_retry_start 合成边界消息（Q11-02）", () => {
  it("半截正文与重新生成的全文之间推一条合成边界：只带次数 / 上限 / 退避，不带 pi 的错误原文", async () => {
    const run = newRun();
    const out = await finish(run, [
      textDelta("PART-A"),
      retryStart(1),
      textDelta("FULL-ANSWER"),
      SETTLED,
    ]);
    expect(out).toEqual({ status: "finished" });
    const msgs = await drain(run);
    expect(typesOf(msgs)).toEqual(["assistant", "auto_retry_start", "assistant"]);
    // 不带 errorMessage：它可能含接口地址 / 请求 id，下游也用不着
    expect(msgs[1]).toEqual({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
    });
  });

  it("auto_retry_start 本身不收尾：run 还在等重试结果，直到 agent_settled", async () => {
    const run = newRun();
    run.onEvent(textDelta("PART-A") as never);
    run.onEvent(retryStart(1) as never);
    const early = await Promise.race([
      run.wait(),
      new Promise((r) => setTimeout(() => r("pending"), 30)),
    ]);
    expect(early).toBe("pending");
    run.onEvent(textDelta("FULL") as never);
    run.onEvent(SETTLED as never);
    expect(await run.wait()).toEqual({ status: "finished" });
  });

  it("连续两次重试 → 两条边界，次数依次递增", async () => {
    const run = newRun();
    await finish(run, [
      textDelta("A1"),
      retryStart(1),
      textDelta("A2"),
      retryStart(2),
      textDelta("FULL"),
      SETTLED,
    ]);
    const msgs = await drain(run);
    expect(typesOf(msgs)).toEqual([
      "assistant",
      "auto_retry_start",
      "assistant",
      "auto_retry_start",
      "assistant",
    ]);
    expect(
      msgs.filter((m) => m.type === "auto_retry_start").map((m) => m.attempt),
    ).toEqual([1, 2]);
  });

  it("重试之后仍然失败 → 带原文案的 error（边界消息不改变既有的失败收尾）", async () => {
    const out = await finish(newRun(), [
      textDelta("半截"),
      retryStart(1),
      retryEnd("502 Bad Gateway"),
    ]);
    expect(out).toEqual({ status: "error", result: "502 Bad Gateway" });
  });
});

describe("PiRunAdapter · auto_retry_start 半截里悬挂的工具调用补 error（Q11-02）", () => {
  it("已亮起（running）却没等到结果的调用 → 补成 error + 说明；UI 实时增量同步变成失败", async () => {
    const { run, updates } = newRunWithDeltas();
    await finish(run, [toolCallEnd("call_1"), retryStart(1), SETTLED]);
    const msgs = await drain(run);
    expect(typesOf(msgs)).toEqual(["tool_call", "tool_call", "auto_retry_start"]);
    expect(msgs[0]).toMatchObject({ call_id: "call_1", name: "read", status: "running" });
    // 补出来的 error 带着原来的名字 / 参数，卡片才对得上同一张
    expect(msgs[1]).toEqual({
      type: "tool_call",
      call_id: "call_1",
      name: "read",
      args: { path: "a.txt" },
      status: "error",
      result: RETRY_INTERRUPTED_TOOL_RESULT,
    });
    expect(updates.map((u) => u.type)).toEqual([
      "tool-call-started",
      "tool-call-completed",
    ]);
    expect(updates[1]).toEqual({
      type: "tool-call-completed",
      callId: "call_1",
      toolCall: {
        type: "read",
        result: { status: "error", value: { output: RETRY_INTERRUPTED_TOOL_RESULT } },
      },
    });
  });

  it("补 error 的说明文案是业务口径：中文、不漏内部名词", () => {
    expect(RETRY_INTERRUPTED_TOOL_RESULT).toMatch(/[\u4e00-\u9fa5]/);
    expect(RETRY_INTERRUPTED_TOOL_RESULT).not.toMatch(/[A-Za-z]/);
  });

  it("bash 调用补 error 时 UI 增量的类型沿用 shell（与 tool_execution_end 同口径）", async () => {
    const { run, updates } = newRunWithDeltas();
    run.onEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { id: "sh_1", name: "bash", arguments: { command: "ls" } },
      },
    } as never);
    run.onEvent(retryStart(1) as never);
    run.onEvent(SETTLED as never);
    await run.wait();
    expect(updates.map((u) => [u.type, (u.toolCall as { type: string }).type])).toEqual([
      ["tool-call-started", "shell"],
      ["tool-call-completed", "shell"],
    ]);
  });

  it("已经有结果的调用不重复补；只补还没结果的那一个", async () => {
    const run = newRun();
    await finish(run, [
      toolCallEnd("a"),
      toolExecEnd("a"),
      toolCallEnd("b"),
      retryStart(1),
      SETTLED,
    ]);
    const msgs = await drain(run);
    expect(statusesOf(msgs, "a")).toEqual(["running", "completed"]);
    expect(statusesOf(msgs, "b")).toEqual(["running", "error"]);
    expect(callMsgs(msgs, "b")[1].result).toBe(RETRY_INTERRUPTED_TOOL_RESULT);
  });

  it("执行失败的调用（tool_execution_end isError）也算有结果，不再补", async () => {
    const run = newRun();
    await finish(run, [
      toolCallEnd("a"),
      { ...toolExecEnd("a"), isError: true, result: "boom" },
      retryStart(1),
      SETTLED,
    ]);
    const msgs = await drain(run);
    expect(statusesOf(msgs, "a")).toEqual(["running", "error"]);
    expect(callMsgs(msgs, "a")[1].result).toBe("boom");
  });

  it("没有悬挂的调用 → 不产生任何 tool_call 消息", async () => {
    const run = newRun();
    await finish(run, [textDelta("半截"), retryStart(1), textDelta("全文"), SETTLED]);
    expect(typesOf(await drain(run)).filter((t) => t === "tool_call")).toEqual([]);
  });

  it("重试后重新发起同一个 call id：新一轮 running → completed，最终没有残留的 running", async () => {
    const run = newRun();
    await finish(run, [
      toolCallEnd("call_1"),
      retryStart(1),
      toolCallEnd("call_1"),
      toolExecEnd("call_1"),
      SETTLED,
    ]);
    const msgs = await drain(run);
    expect(statusesOf(msgs, "call_1")).toEqual(["running", "error", "running", "completed"]);
  });

  it("连续两次重试：每个悬挂调用只补一次（补完即清空，第二次重试不会再补第一轮的）", async () => {
    const run = newRun();
    await finish(run, [
      toolCallEnd("a"),
      retryStart(1),
      toolCallEnd("b"),
      retryStart(2),
      SETTLED,
    ]);
    const msgs = await drain(run);
    expect(statusesOf(msgs, "a")).toEqual(["running", "error"]);
    expect(statusesOf(msgs, "b")).toEqual(["running", "error"]);
  });
});

describe("PiRunAdapter · auto_retry_start 不改变空回复判定（sawOutput 按整个 run 累计，P1-3 口径）", () => {
  it("重试前出现过正文 → 重新生成的这一遍即便什么都没有，仍是 finished（不能把 sawOutput 清零）", async () => {
    expect(await finish(newRun(), [textDelta("半截"), retryStart(1), SETTLED])).toEqual({
      status: "finished",
    });
  });

  it("重试前出现过工具调用 → 同上（补 error 不会把它抹掉）", async () => {
    expect(await finish(newRun(), [toolCallEnd("a"), retryStart(1), SETTLED])).toEqual({
      status: "finished",
    });
  });

  it("重试前只有思考 → 仍是空回复（思考不算产出）", async () => {
    expect(await finish(newRun(), [thinkingDelta("嗯"), retryStart(1), SETTLED])).toEqual({
      status: "error",
      result: EMPTY_REPLY_MESSAGE,
    });
  });

  it("一路没产出、只有重试事件 → 空回复（auto_retry_start 本身不算产出）", async () => {
    expect(await finish(newRun(), [retryStart(1), retryStart(2), SETTLED])).toEqual({
      status: "error",
      result: EMPTY_REPLY_MESSAGE,
    });
  });

  it("重试后才有正文 → finished", async () => {
    expect(await finish(newRun(), [retryStart(1), textDelta("全文"), SETTLED])).toEqual({
      status: "finished",
    });
  });

  it("用户取消 → cancelled（取消优先，重试事件不改变）", async () => {
    const run = newRun();
    await run.cancel();
    expect(await finish(run, [textDelta("半截"), retryStart(1), SETTLED])).toEqual({
      status: "cancelled",
    });
  });
});

/**
 * R14 Q11-03：收尾后退订（在微任务里退）。
 * 假会话的完整语义用例（旧 run 串台、多轮订阅不累积、排在后面的监听者不漏收）在 tests/custom-agent-unsubscribe.test.ts；
 * 这里直接喂事件，钉退订的「时机和次数」：收尾前不退、收尾那一刻不同步退、每条收尾路径都退、只退一次、
 * 退订抛错不外溢。
 */
// 用例超时收紧到 2s：改坏时（比如一开始就收不到事件）要快速失败，不是每条都撑满默认的 5s
describe("PiRunAdapter · 收尾后退订（Q11-03）", { timeout: 2000 }, () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  /** 绑了一个退订探针的 run */
  const runWithUnsub = (fn: () => void = () => {}) => {
    const run = newRun();
    const unsub = vi.fn(fn);
    run.bindUnsubscribe(unsub);
    return { run, unsub };
  };

  it("收尾前不退订：喂了正文 / 工具调用 / 重试事件，没收尾就一次都不退", async () => {
    const { run, unsub } = runWithUnsub();
    for (const e of [textDelta("a"), toolCallEnd(), toolExecEnd(), retryStart(1)]) {
      run.onEvent(e as never);
    }
    await tick();
    expect(unsub).not.toHaveBeenCalled();
  });

  it("收尾那一刻不同步退订：onEvent(agent_settled) 返回时还没退，过一个微任务才退（同步退会让 pi 派发里排在后面的监听者漏收这次事件）", async () => {
    const { run, unsub } = runWithUnsub();
    run.onEvent(textDelta("hi") as never);
    run.onEvent(SETTLED as never);
    expect(unsub).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (run: PiRunAdapter) => void | Promise<void>]>([
    [
      "agent_settled 正常收尾（finished）",
      (r) => {
        r.onEvent(textDelta("hi") as never);
        r.onEvent(SETTLED as never);
      },
    ],
    ["agent_settled 空回复（error）", (r) => r.onEvent(SETTLED as never)],
    [
      "取消之后 pi 补发 agent_settled（cancelled）",
      async (r) => {
        await r.cancel();
        r.onEvent(SETTLED as never);
      },
    ],
    ["auto_retry_end 失败：残缺收尾", (r) => r.onEvent(retryEnd(BENIGN_STREAM_END) as never)],
    ["auto_retry_end 失败：真错误", (r) => r.onEvent(retryEnd("502 Bad Gateway") as never)],
    ["prompt 抛错（onPromptError）", (r) => r.onPromptError(new Error("boom"))],
  ])("每条收尾路径都退订：%s", async (_name, drive) => {
    const { run, unsub } = runWithUnsub();
    await drive(run);
    await run.wait();
    await tick();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("只退订一次：重复收尾（重复的 agent_settled、收尾之后才到的 prompt 错误）不再退订，也不改写结果", async () => {
    const { run, unsub } = runWithUnsub();
    run.onEvent(textDelta("hi") as never);
    run.onEvent(SETTLED as never);
    run.onEvent(SETTLED as never);
    run.onPromptError(new Error("late"));
    await tick();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(await run.wait()).toEqual({ status: "finished" });
  });

  it("没绑过退订函数收尾不抛（单测 / 合成场景里 run 可以不接 session）", async () => {
    const run = newRun();
    run.onEvent(textDelta("hi") as never);
    run.onEvent(SETTLED as never);
    await tick();
    expect(await run.wait()).toEqual({ status: "finished" });
  });

  it("退订函数抛错不外溢：wait() 照常返回、没有未捕获异常", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const { run, unsub } = runWithUnsub(() => {
        throw new Error("unsub boom");
      });
      run.onEvent(textDelta("hi") as never);
      run.onEvent(SETTLED as never);
      expect(await run.wait()).toEqual({ status: "finished" });
      await tick();
      expect(unsub).toHaveBeenCalledTimes(1);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
