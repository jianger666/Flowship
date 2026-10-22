/**
 * 状态行的本轮切片不能把「对主流不可见的 user_reply」当切点（第三轮 review R3-01）
 *
 * 事实：`sliceCurrentRunEvents` 从尾部找最近一条 user_reply / action_start 当本轮起点，但它没过
 * `isHiddenFromEventStream`。task 形态里 action 正跑一个长 shell 时，需求群里有人提问 →
 * 写入 `user_reply{source:"feishu_group", restrictedRunTag}`（对主流隐藏）。切片从这条隐藏事件起，
 * 随后 event-stream 再把隐藏事件滤掉，切片为空 → `deriveActiveStatus` 返回 null：
 * shell 明明在跑，状态行消失；有未答提问时「等你回答」也一并消失。
 *
 * 修法：切点判定加 `!isHiddenFromEventStream`（与 resolveErrorRecovery / isLatestErrorEvent 同一个口径）。
 *
 * 这里按 event-stream 的真实管线（slice → 滤隐藏 → deriveActiveStatus）复刻 R3 probe5 的 H1 / H2 / A2。
 */
import { describe, expect, it } from "vitest";

import { deriveActiveStatus, sliceCurrentRunEvents } from "../src/lib/chat-turns";
import { isHiddenFromEventStream } from "../src/lib/event-stream-hidden";
import type { TaskEvent } from "../src/lib/types";

let seq = 0;
const ev = (p: Partial<TaskEvent> & Pick<TaskEvent, "kind">): TaskEvent => {
  seq += 1;
  return { id: p.id ?? `e${seq}`, text: "", ts: 1000 + seq, ...p };
};
const toolCall = (callId: string, name = "shell"): TaskEvent =>
  ev({ kind: "tool_call", text: `调用 ${name}`, meta: { callId, name, args: JSON.stringify({ command: "pnpm build" }) } });
const toolResult = (callId: string, name = "shell"): TaskEvent =>
  ev({ kind: "tool_result", text: "完成", meta: { callId, name, status: "success" } });

/** 需求群里非属主的提问：对主流隐藏的 user_reply */
const groupQuestion = (): TaskEvent =>
  ev({
    kind: "user_reply",
    text: "[群消息·来自 张三]\n问个事",
    meta: { source: "feishu_group", restrictedRunTag: "rt1" },
  });
/** 旁路答疑 run 的过程事件（meta.groupRun 打标，同样对主流隐藏） */
const sideRunEvent = (kind: TaskEvent["kind"]): TaskEvent =>
  ev({ kind, text: "旁路", meta: { groupRun: "rt1" } });

/** event-stream 的状态行输入管线 */
const statusOf = (events: TaskEvent[], isChat: boolean, awaitingAsk = false) => {
  const statusEvents = sliceCurrentRunEvents(events).filter(
    (e) => !isHiddenFromEventStream(e, { isChat }),
  );
  return deriveActiveStatus(statusEvents, undefined, {
    lastActivityTs: events[events.length - 1]?.ts,
    awaitingUser: awaitingAsk,
  });
};

describe("夹具自检：群问答 user_reply / 旁路过程事件确实对主流隐藏", () => {
  it("hidden", () => {
    expect(isHiddenFromEventStream(groupQuestion())).toBe(true);
    expect(isHiddenFromEventStream(sideRunEvent("thinking"))).toBe(true);
    expect(isHiddenFromEventStream(ev({ kind: "user_reply", text: "我自己说的" }))).toBe(false);
  });
});

describe("sliceCurrentRunEvents：隐藏的 user_reply 不是切点", () => {
  it("复现：长 shell 在跑 + 群问答提问——切点落在可见的 action_start，不是隐藏提问", () => {
    const head = ev({ kind: "action_start", text: "开始 build" });
    const call = toolCall("c1");
    const q = groupQuestion();
    const slice = sliceCurrentRunEvents([head, call, q]);
    expect(slice[0]).toBe(head); // 改前：切片从隐藏的 q 起，只剩 [q]
    expect(slice).toEqual([head, call, q]);
  });

  it("可见的 user_reply 仍是切点（既有行为不变），且取最近的那条", () => {
    const u1 = ev({ kind: "user_reply", text: "第一句" });
    const a = ev({ kind: "assistant_message", text: "好" });
    const u2 = ev({ kind: "user_reply", text: "第二句" });
    const b = ev({ kind: "assistant_message", text: "行" });
    expect(sliceCurrentRunEvents([u1, a, u2, b])).toEqual([u2, b]);
  });

  it("隐藏 user_reply 夹在可见起点之后、之前都不影响：切到最近一条**可见**起点", () => {
    const u = ev({ kind: "user_reply", text: "我说的" });
    const mid = ev({ kind: "assistant_message", text: "..." });
    const events = [groupQuestion(), u, mid, groupQuestion(), sideRunEvent("assistant_message")];
    expect(sliceCurrentRunEvents(events)[0]).toBe(u);
  });

  it("整份日志里只有隐藏的 user_reply、没有任何可见起点：退回全量（与「没有任何起点」一致）", () => {
    const events = [ev({ kind: "tool_call", meta: { callId: "c", name: "x" } }), groupQuestion()];
    expect(sliceCurrentRunEvents(events)).toBe(events);
  });
});

describe("R3 probe5：状态行不被群问答带没", () => {
  it("H1 task：长 shell 在跑 + 群里有人提问 → 仍是「正在执行 shell」", () => {
    const events = [ev({ kind: "action_start", text: "开始 build" }), toolCall("c1"), groupQuestion()];
    const s = statusOf(events, false);
    expect(s?.label).toBe("正在执行 shell");
  });

  it("H1 chat：同上（chat 里原本就有同样的先切后滤）", () => {
    const events = [ev({ kind: "user_reply", text: "跑下 build" }), toolCall("c1"), groupQuestion()];
    expect(statusOf(events, true)?.label).toBe("正在执行 shell");
  });

  it("H2：再叠旁路 run 的过程事件（thinking / assistant_message）也一样", () => {
    const events = [
      ev({ kind: "action_start", text: "开始 build" }),
      toolCall("c1"),
      groupQuestion(),
      sideRunEvent("thinking"),
      sideRunEvent("assistant_message"),
    ];
    expect(statusOf(events, false)?.label).toBe("正在执行 shell");
  });

  it("A2：有未答提问（提问事件在隐藏切点之前）→ 仍是「等你回答」", () => {
    const ask = ev({
      kind: "ask_user_request",
      text: "问",
      meta: { askId: "k1", token: "t", questions: [{ question: "q" }] },
    });
    const events = [ev({ kind: "user_reply", text: "开始" }), ask, groupQuestion()];
    expect(statusOf(events, true, true)?.label).toBe("等你回答");
  });

  it("没有群问答时的老行为不变：shell 跑完等模型 → 「正在分析 shell 的结果」", () => {
    const events = [ev({ kind: "action_start", text: "开始" }), toolCall("c1"), toolResult("c1")];
    expect(statusOf(events, false)?.label).toBe("正在分析 shell 的结果");
  });
});
