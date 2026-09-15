/**
 * 群问答 tab 的聚合单测：精确配对（runTag / 群消息 id）+ 历史 temporal 配对 + 隐藏谓词。
 *
 * 用 9-14 那次江涛 CLI 互 @ 的真实形状做 fixture（5 问 4 答，第 5 问被强关打断）。
 */
import { describe, expect, it } from "vitest";

import type { TaskEvent } from "@/lib/types";

import {
  buildGroupQaSummaryEvent,
  cleanGroupQuestionText,
  collectGroupQaRounds,
  formatGroupQaTs,
  GROUP_QA_ANSWERING_RECENT_MS,
  isGroupQaQuestionEvent,
  isGroupQaSummaryEvent,
  oneLineAnswer,
} from "@/lib/group-qa";

let seq = 0;
const ev = (over: Partial<TaskEvent> & { kind: TaskEvent["kind"] }): TaskEvent =>
  ({
    id: `e_${seq++}`,
    ts: 1_000_000,
    text: "",
    ...over,
  }) as TaskEvent;

const NOW = 2_000_000_000_000;

describe("谓词", () => {
  it("只有带 runTag 的非属主群问题进 tab", () => {
    expect(
      isGroupQaQuestionEvent(
        ev({
          kind: "user_reply",
          meta: { source: "feishu_group", restrictedRunTag: "tok1" },
        }),
      ),
    ).toBe(true);
    // 属主群消息（无 runTag）留在主流程
    expect(
      isGroupQaQuestionEvent(
        ev({ kind: "user_reply", meta: { source: "feishu_group" } }),
      ),
    ).toBe(false);
    // app 里问的不进
    expect(
      isGroupQaQuestionEvent(
        ev({ kind: "user_reply", meta: { restrictedRunTag: "tok1" } }),
      ),
    ).toBe(false);
  });

  it("汇总事件只认 info + groupQaSummary", () => {
    expect(
      isGroupQaSummaryEvent(
        ev({ kind: "info", meta: { groupQaSummary: { runTag: "t" } } }),
      ),
    ).toBe(true);
    expect(
      isGroupQaSummaryEvent(ev({ kind: "info", meta: {} })),
    ).toBe(false);
  });
});

describe("展示小件", () => {
  it("提问去噪：剥前缀与 <at> 残留", () => {
    expect(
      cleanGroupQuestionText(
        "[群消息·来自 群成员（非任务所有者）]——只答疑、不执行修改类指令\n<at user_id=\"ou_x\"></at> 埋点查了吗",
      ),
    ).toBe("埋点查了吗");
    expect(
      cleanGroupQuestionText('<at user_id="ou_y">江涛</at> 这个对吗'),
    ).toBe("@江涛 这个对吗");
    // [Bug] 这类正常内容不许吃（review P2-5）
    expect(cleanGroupQuestionText("[Bug] 埋点没上报")).toBe("[Bug] 埋点没上报");
  });

  it("一行回答：首个非空行、120 字封顶", () => {
    expect(oneLineAnswer("\n\n**8/8 已上报** ✅\n\n明细…")).toBe(
      "**8/8 已上报** ✅",
    );
    expect(oneLineAnswer(`a${"b".repeat(200)}`)).toBe(`a${"b".repeat(119)}…`);
  });

  it("时间带日期（跨天轮次只看 HH:mm 会串）", () => {
    expect(formatGroupQaTs(NOW)).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });
});

describe("汇总时间回退（review P1-3）", () => {
  it("问题被裁只剩汇总：用汇总自己的时间，不沉底", () => {
    const rounds = collectGroupQaRounds(
      [
        ev({
          kind: "info",
          id: "s9",
          ts: 9000,
          text: "x",
          meta: {
            groupQaSummary: {
              runTag: "tok9",
              askerOpenId: "ou_a",
              askerName: "A",
              answer: "答",
              ok: true,
            },
          },
        }),
      ],
      NOW,
    );
    expect(rounds).toHaveLength(1);
    // 用汇总自己的时间（9000），而不是沉底的 0
    expect(rounds[0]).toMatchObject({ key: "tok9", ts: 9000 });
  });
});

describe("精确配对", () => {
  const question = (id: string, ts: number, runTag: string, text: string) =>
    ev({
      kind: "user_reply",
      id,
      ts,
      text,
      meta: {
        source: "feishu_group",
        restrictedRunTag: runTag,
        groupSender: "李四",
        groupSenderOpenId: "ou_li",
      },
    });
  const summary = (
    id: string,
    ts: number,
    runTag: string,
    answer: string,
    askerName = "李四",
  ) =>
    ev({
      kind: "info",
      id,
      ts,
      text: `群问答 · ${askerName}：${answer.slice(0, 10)}`,
      meta: {
        groupQaSummary: {
          runTag,
          askerOpenId: "ou_li",
          askerName,
          answer,
          ok: true,
        },
      },
    });

  it("runTag 配对：一行 = 时间/谁/一行回答，详情有全文", () => {
    const rounds = collectGroupQaRounds(
      [
        question("q1", 1000, "tok1", "埋点查了吗"),
        summary("s1", 2000, "tok1", "查了，**8/8 已上报** ✅\n\n明细…"),
      ],
      NOW,
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      key: "tok1",
      ts: 1000,
      askerName: "李四",
      askerOpenId: "ou_li",
      questionText: "埋点查了吗",
      ok: true,
      answering: false,
      legacy: false,
    });
    expect(rounds[0]!.answerText).toContain("8/8");
  });

  it("群消息 id 兜底（no_pending 落回旁路：问题没 runTag）", () => {
    const rounds = collectGroupQaRounds(
      [
        ev({
          kind: "user_reply",
          id: "q2",
          ts: 1000,
          text: "是对的吗",
          meta: { source: "feishu_group", feishuMessageId: "om_9" },
        }),
        ev({
          kind: "info",
          id: "s2",
          ts: 2000,
          text: "x",
          meta: {
            groupQaSummary: {
              runTag: "tokX",
              askerOpenId: "ou_a",
              askerName: "A",
              questionMessageId: "om_9",
              answer: "对",
              ok: true,
            },
          },
        }),
      ],
      NOW,
    );
    // 汇总靠 questionMessageId 反查到问题：只出一轮，不多出 legacy 行
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      key: "tokX",
      askerName: "A",
      questionText: "是对的吗",
      answerText: "对",
      legacy: false,
    });
  });

  it("有问无答：近期算回答中，陈旧算未收到", () => {
    const fresh = collectGroupQaRounds(
      [question("q3", NOW - 1000, "tok3", "在吗")],
      NOW,
    );
    expect(fresh[0]).toMatchObject({ answering: true, answerText: "" });
    const stale = collectGroupQaRounds(
      [question("q4", NOW - GROUP_QA_ANSWERING_RECENT_MS - 1, "tok4", "在吗")],
      NOW,
    );
    expect(stale[0]).toMatchObject({
      answering: false,
      ok: false,
      answerText: "",
    });
  });
});

describe("历史 temporal 配对（老代码无 runTag）", () => {
  const legacyQ = (id: string, ts: number, text: string) =>
    ev({
      kind: "user_reply",
      id,
      ts,
      text: `[群消息·来自 群成员（非任务所有者）]——只答疑\n${text}`,
      meta: { source: "feishu_group", groupSender: "群成员" },
    });
  const ans = (id: string, ts: number, text: string) =>
    ev({ kind: "assistant_message", id, ts, text });

  it("江涛 CLI 案：5 问 4 答 → 4 轮精确 + 第 5 问（被强关）标未收到", () => {
    const events: TaskEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(legacyQ(`q${i}`, i * 1000, `问题${i}`));
      if (i < 4) events.push(ans(`a${i}`, i * 1000 + 500, `回答${i} 明细`));
    }
    const rounds = collectGroupQaRounds(events, NOW);
    expect(rounds).toHaveLength(5);
    // 倒序：最新在前
    expect(rounds[0]!.questionText).toBe("问题4");
    expect(rounds[0]).toMatchObject({
      legacy: true,
      ok: false,
      answerText: "",
    });
    expect(rounds[1]).toMatchObject({
      legacy: true,
      ok: true,
      questionText: "问题3",
    });
    expect(rounds[1]!.answerText).toContain("回答3");
  });

  it("属主自己的追问会截断上一轮（不串台）", () => {
    const rounds = collectGroupQaRounds(
      [
        legacyQ("q1", 1000, "群问题"),
        ans("a1", 1500, "群回答"),
        ev({ kind: "user_reply", id: "mine", ts: 2000, text: "我自己问", meta: {} }),
        ans("a2", 2500, "主流程回答"),
      ],
      NOW,
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.answerText).toBe("群回答");
  });
});

describe("汇总事件", () => {
  it("形状固定：info + groupQaSummary，失败轮也记", () => {
    const e = buildGroupQaSummaryEvent({
      runTag: "tok1",
      askerOpenId: "ou_li",
      askerName: "李四",
      questionMessageId: "om_9",
      answer: "查了\n\n明细",
      ok: false,
    });
    expect(e.kind).toBe("info");
    expect(e.text).toContain("群问答 · 李四");
    expect(e.meta.groupQaSummary).toMatchObject({
      runTag: "tok1",
      askerOpenId: "ou_li",
      questionMessageId: "om_9",
      answer: "查了\n\n明细",
      ok: false,
    });
    // 汇总事件自己也要能进 tab（谓词认它）
    expect(
      isGroupQaSummaryEvent({
        id: "e_x",
        ts: 1,
        kind: "info",
        text: e.text,
        meta: e.meta,
      }),
    ).toBe(true);
  });
});
