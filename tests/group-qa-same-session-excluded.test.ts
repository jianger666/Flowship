/**
 * 并入同会话的非属主一轮（meta.groupNonOwnerTurn）不算旁路问答轮。
 *
 * 老逻辑里，任何没有 restrictedRunTag 的群问题都会走 temporal「历史」配对——并入同会话之后，非属主的问与答都在
 * 主事件流里（普通气泡 + 回复），若仍被配成「历史」轮，就会多出一份重复的问答卡。
 */
import { describe, expect, it } from "vitest";

import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import { collectGroupQaRounds, isGroupQaQuestionEvent } from "@/lib/group-qa";
import type { TaskEvent } from "@/lib/types";

let seq = 0;
const ev = (over: Partial<TaskEvent> & { kind: TaskEvent["kind"] }): TaskEvent =>
  ({ id: `e_${seq++}`, ts: 1_000_000 + seq, text: "", ...over }) as TaskEvent;

const NOW = 1_000_000 + 60_000;

describe("同会话非属主一轮不算旁路问答轮", () => {
  const sameSession = () => [
    ev({
      kind: "user_reply",
      text: "[群消息·来自 李四（非任务所有者）]\n埋点查了吗",
      meta: { source: "feishu_group", groupSender: "李四", groupNonOwnerTurn: true },
    }),
    ev({ kind: "assistant_message", text: "查了，在 track.ts 里" }),
  ];

  it("这一问一答不产生任何 round（也不会被配成「历史」）", () => {
    expect(collectGroupQaRounds(sameSession(), NOW)).toEqual([]);
  });

  it("问题事件不是旁路问题、也不被事件流隐藏：问与答都以普通消息留在事件流里", () => {
    const [question, answer] = sameSession();
    expect(isGroupQaQuestionEvent(question!)).toBe(false);
    expect(isHiddenFromEventStream(question!, { isChat: false })).toBe(false);
    expect(isHiddenFromEventStream(answer!, { isChat: false })).toBe(false);
  });

  it("对照：同样形状但没有 groupNonOwnerTurn 标记 → 仍是历史轮（老数据口径不变）", () => {
    const events = sameSession();
    delete (events[0]!.meta as Record<string, unknown>).groupNonOwnerTurn;
    const rounds = collectGroupQaRounds(events, NOW);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ legacy: true, askerName: "李四" });
  });

  it("同会话那一轮的回答不会被前面未收口的历史问题 scooped 走", () => {
    const events = [
      ev({
        kind: "user_reply",
        text: "老问题",
        meta: { source: "feishu_group", groupSender: "王五" },
      }),
      ev({ kind: "assistant_message", text: "老回答" }),
      ...sameSession(),
    ];
    const rounds = collectGroupQaRounds(events, NOW);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.askerName).toBe("王五");
    expect(rounds[0]!.answerText).toBe("老回答");
  });
});
