/**
 * task 事件流接粘性状态行（第二轮 review V16-05，小步版）的纯函数部分。
 *
 * 背景：状态行（deriveActiveStatus）原先只给 chat 画——task 形态里 AI 明明在跑，
 * assistant_message 之后 / 落盘的 thinking 之后 / action_start 后的「启动过程」组，流里没有任何
 * 转圈或计时，唯一的活信号是页面头部的「停止」，长列表滚下去就看不见了。
 * 这里钉两件事：
 *   1. 回扫的边界：task 的一轮 run 以 action_start 开头——它和 user_reply 一样是「一轮的起点」，
 *      既要让回扫在它这里收尾（不能越过它去读上一个 action 的尾巴），也要是本轮切片的起点；
 *   2. 本轮切片（sliceCurrentRunEvents）：状态行的输入只取本轮，shell 直播每个 delta 一次重算，
 *      不能每次都扫全量事件（见 docs/HANDOFF.md「踩过的坑」/ event-stream-scroll-contract）。
 * 接线（task 形态确实挂上状态行）是源码契约，在 tests/status-line-contract.test.ts。
 */
import { describe, expect, it } from "vitest";

import {
  deriveActiveStatus,
  sliceCurrentRunEvents,
} from "../src/lib/chat-turns";
import type { TaskEvent } from "../src/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind">,
): TaskEvent => ({ ts: 1, text: "", ...partial });

const actionStart = (id: string, ts: number): TaskEvent =>
  ev({ id, kind: "action_start", text: "开始 开发（dev）n=1", ts });

const bootInfo = (id: string, ts: number): TaskEvent =>
  ev({ id, kind: "info", text: "准备工作区", ts, meta: { subkind: "boot" } });

const toolCall = (id: string, callId: string, ts: number): TaskEvent =>
  ev({
    id,
    kind: "tool_call",
    text: "调用 shell",
    ts,
    meta: { callId, name: "shell", args: "{}" },
  });

const toolResult = (id: string, callId: string, ts: number): TaskEvent =>
  ev({
    id,
    kind: "tool_result",
    text: "完成",
    ts,
    meta: { callId, name: "shell", status: "success" },
  });

describe("action_start：task 一轮 run 的起点（回扫在它这里收尾）", () => {
  it("action_start 之后只有启动链 info：说「正在启动…」并从 action_start 起走字（流里没有别的计时）", () => {
    const events = [actionStart("a1", 1000), bootInfo("i1", 1100), bootInfo("i2", 1200)];
    expect(deriveActiveStatus(events)).toEqual({
      label: "正在启动…",
      sinceTs: 1000,
    });
  });

  it("不带 yieldToTail：task 形态流尾没有 PendingRow 在计时，状态行不能让位", () => {
    expect(deriveActiveStatus([actionStart("a1", 1000)])).not.toHaveProperty(
      "yieldToTail",
    );
  });

  it("不越过 action_start 去读上一个 action 的尾巴（否则新 action 启动时说成「正在分析 shell 的结果」）", () => {
    const prev = [
      actionStart("a0", 100),
      toolCall("c1", "x", 200),
      toolResult("r1", "x", 300),
    ];
    // 对照：没有 action_start 隔断时，尾部就是上一个 action 的 tool_result
    expect(deriveActiveStatus(prev)?.label).toBe("正在分析 shell 的结果");
    const events = [...prev, actionStart("a1", 5000), bootInfo("i1", 5100)];
    expect(deriveActiveStatus(events)).toEqual({
      label: "正在启动…",
      sinceTs: 5000,
    });
  });

  it("上一个 action 里没回结果的 tool_call 不会串进新 action 的状态（孤儿调用被 action_start 隔断）", () => {
    const events = [
      actionStart("a0", 100),
      toolCall("c1", "orphan", 200),
      actionStart("a1", 5000),
      toolCall("c2", "y", 5100),
      toolResult("r2", "y", 5200),
    ];
    // 切到本轮：只有 c2 / r2，没有「还在跑的 orphan」混进来
    const status = deriveActiveStatus(sliceCurrentRunEvents(events));
    expect(status).toEqual({ label: "正在分析 shell 的结果", sinceTs: 5200 });
  });

  it("正文已经在流：改口「正在回复…」，别在流式输出时还写「正在启动…」", () => {
    expect(
      deriveActiveStatus([actionStart("a1", 1000), bootInfo("i1", 1100)], undefined, {
        streaming: true,
      }),
    ).toEqual({ label: "正在回复…" });
  });

  it("有实时思考时思考盖过启动（agent 已经开始想了）", () => {
    expect(
      deriveActiveStatus([actionStart("a1", 1000)], undefined, { thinkingSince: 2000 }),
    ).toEqual({ label: "思考中", sinceTs: 2000 });
  });

  it("等人答题时照旧「等你回答」，不被启动态盖掉", () => {
    const ask = ev({ id: "q1", kind: "ask_user_request", text: "选哪个？", ts: 1500 });
    expect(
      deriveActiveStatus([actionStart("a1", 1000), ask], undefined, { awaitingUser: true }),
    ).toMatchObject({ label: "等你回答" });
  });

  it("chat 形态不受影响：user_reply 之后仍是「正在启动…」+ yieldToTail、不带计时", () => {
    const user = ev({ id: "u1", kind: "user_reply", text: "你好", ts: 10 });
    expect(deriveActiveStatus([user])).toEqual({
      label: "正在启动…",
      yieldToTail: true,
    });
  });
});

describe("task 形态在窗口里有状态行文案可画（V16-05 报的三个窗口）", () => {
  it("assistant_message 之后：「正在回复…」，静默超过阈值时带兜底锚（转成「仍在等待 · Ns」走字）", () => {
    const events = [
      actionStart("a1", 1000),
      ev({ id: "m1", kind: "assistant_message", text: "我先看下结构", ts: 2000 }),
    ];
    expect(deriveActiveStatus(events, undefined, { lastActivityTs: 2000 })).toEqual({
      label: "正在回复…",
      stallSinceTs: 2000,
    });
  });

  it("落盘 thinking 之后：「思考中」，同样带兜底锚", () => {
    const events = [
      actionStart("a1", 1000),
      ev({ id: "t1", kind: "thinking", text: "分析一下", ts: 2000 }),
    ];
    expect(deriveActiveStatus(events, undefined, { lastActivityTs: 2000 })).toEqual({
      label: "思考中",
      stallSinceTs: 2000,
    });
  });

  it("「启动过程」组（action_start + 启动链 info）：有文案、有计时起点；静默够久时也有兜底锚", () => {
    const events = [actionStart("a1", 1000), bootInfo("i1", 1100)];
    expect(deriveActiveStatus(events, undefined, { lastActivityTs: 1100 })).toEqual({
      label: "正在启动…",
      sinceTs: 1000,
      stallSinceTs: 1100,
    });
  });
});

describe("sliceCurrentRunEvents：状态行只吃本轮切片", () => {
  it("没有任何起点事件（刚建的会话 / 纯日志）：原样返回全量", () => {
    const events = [toolCall("c1", "x", 1), toolResult("r1", "x", 2)];
    expect(sliceCurrentRunEvents(events)).toEqual(events);
    expect(sliceCurrentRunEvents([])).toEqual([]);
  });

  it("以最近一条 user_reply 为起点（含它自己）", () => {
    const events = [
      ev({ id: "u0", kind: "user_reply", text: "旧", ts: 1 }),
      toolCall("c0", "a", 2),
      ev({ id: "u1", kind: "user_reply", text: "新", ts: 3 }),
      toolCall("c1", "b", 4),
    ];
    expect(sliceCurrentRunEvents(events).map((e) => e.id)).toEqual(["u1", "c1"]);
  });

  it("以最近一条 action_start 为起点（含它自己）", () => {
    const events = [
      actionStart("a0", 1),
      toolCall("c0", "a", 2),
      actionStart("a1", 3),
      bootInfo("i1", 4),
    ];
    expect(sliceCurrentRunEvents(events).map((e) => e.id)).toEqual(["a1", "i1"]);
  });

  it("两种起点混着出现：取更靠后的那个（task 里用户中途「跟 AI 说」/ 说完又推进新 action）", () => {
    const userLater = [
      actionStart("a1", 1),
      toolCall("c1", "a", 2),
      ev({ id: "u1", kind: "user_reply", text: "补充一句", ts: 3 }),
      toolCall("c2", "b", 4),
    ];
    expect(sliceCurrentRunEvents(userLater).map((e) => e.id)).toEqual(["u1", "c2"]);
    const actionLater = [
      ev({ id: "u1", kind: "user_reply", text: "开始吧", ts: 1 }),
      toolCall("c1", "a", 2),
      actionStart("a2", 3),
      toolCall("c2", "b", 4),
    ];
    expect(sliceCurrentRunEvents(actionLater).map((e) => e.id)).toEqual(["a2", "c2"]);
  });

  it("切片 = 同样的答案（回扫必在起点收尾），只是扫描量从全量降到本轮", () => {
    const sequences: TaskEvent[][] = [
      // action 里：思考 → 工具在跑
      [
        actionStart("a0", 1),
        toolCall("c0", "p", 2),
        toolResult("r0", "p", 3),
        actionStart("a1", 10),
        ev({ id: "t1", kind: "thinking", text: "想", ts: 11 }),
        toolCall("c1", "q", 12),
      ],
      // action 里：工具跑完等模型
      [
        actionStart("a1", 10),
        toolCall("c1", "q", 12),
        toolResult("r1", "q", 13),
      ],
      // 末条是 assistant_message
      [
        actionStart("a1", 10),
        ev({ id: "m1", kind: "assistant_message", text: "好", ts: 11 }),
      ],
      // 中途插话：user_reply 在末尾
      [
        actionStart("a1", 10),
        toolCall("c1", "q", 12),
        toolResult("r1", "q", 13),
        ev({ id: "u1", kind: "user_reply", text: "再看下 X", ts: 14 }),
      ],
      // 只有启动链
      [actionStart("a0", 1), toolCall("c0", "p", 2), actionStart("a1", 10), bootInfo("i1", 11)],
    ];
    for (const events of sequences) {
      for (const opts of [undefined, { streaming: true }, { lastActivityTs: 20 }]) {
        expect(deriveActiveStatus(sliceCurrentRunEvents(events), undefined, opts)).toEqual(
          deriveActiveStatus(events, undefined, opts),
        );
      }
    }
  });
});
