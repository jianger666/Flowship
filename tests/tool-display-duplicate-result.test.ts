/**
 * R14 S2 · 同 callId 的多条 tool_result 不再合成「孤儿卡」。
 *
 * 现象（用户截图）：事件流里两张并行的评审子代理卡（不同模型）之后，多出第三张只写「子代理任务」、
 * 没有模型徽标的卡。
 *
 * 根因（读代码 + 事件元数据 + main.log 核过）：SDK 在同一个运行里把还没全部返回的工具调用整批重新派发，
 * 同一个 callId 被执行第二遍、各回一条 tool_result。`mergeToolDisplayEvents` 里 `resultsByCallId` 是「后写覆盖」，
 * tool_call 只配最后一条，先到的那条没人认领，被合成成孤儿块——孤儿块没有 args，
 * 所以标题缺省「子代理任务」（tool-block.tsx）、没有 model / effort 徽标。
 * 旧历史里 read、shell 也各有过同 callId 隔几秒的双结果，缺口是通用的。
 *
 * 只测纯函数 `mergeToolDisplayEvents`（事件 → 渲染项），不渲染 React。
 * 改前（基线源码）：多条结果的用例红（出现多余的孤儿块）；真孤儿 / 无 callId / 缓存对拍 / 块身份这几条是对照，本来就该过。
 */
import { describe, expect, it } from "vitest";

import {
  isToolBlock,
  isToolVerbGroup,
  mergeToolDisplayEvents,
  parseTaskToolArgs,
  type StreamRenderItem,
  type ToolBlock,
} from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({
  ts: 1,
  ...partial,
});

const taskArgs = (description: string, model: string, effort?: string) =>
  JSON.stringify({
    description,
    prompt: "任务书",
    model,
    ...(effort ? { effort } : {}),
  });

const call = (
  id: string,
  callId: string,
  name: string,
  args?: string,
): TaskEvent =>
  ev({
    id,
    kind: "tool_call",
    text: `调用 ${name}`,
    meta: { callId, name, ...(args ? { args } : {}) },
  });

const result = (
  id: string,
  callId: string,
  name: string,
  status: "success" | "error" | "interrupted" = "success",
  output = "ok",
): TaskEvent =>
  ev({
    id,
    kind: "tool_result",
    text: `工具完成 ${name}`,
    ts: 2,
    meta: { callId, name, status, output },
  });

/** 把渲染项摊平成工具块（verb 组里的成员也算） */
const blocksOf = (items: StreamRenderItem[]): ToolBlock[] =>
  items.flatMap((it) =>
    isToolBlock(it) ? [it] : isToolVerbGroup(it) ? it.members : [],
  );

/** 用户截图的形状：两个并行子代理，其中 A 回了两条结果，B 还没回 */
const screenshotEvents = (): TaskEvent[] => [
  call(
    "c1",
    "toolu_review_a",
    "task",
    taskArgs("评审 A（前半段）", "composer-2.5"),
  ),
  call(
    "c2",
    "toolu_review_b",
    "task",
    taskArgs("评审 B（后半段）", "claude-sonnet-5-5", "high"),
  ),
  result("r1", "toolu_review_a", "task"),
  result("r2", "toolu_review_a", "task"),
];

describe("S2：同 callId 多条 tool_result 只出一张卡", () => {
  it("用户截图的形状：两张子代理卡，不再多出第三张没有任务书参数的孤儿卡", () => {
    const out = mergeToolDisplayEvents(screenshotEvents());
    expect(out).toHaveLength(2);
    const blocks = blocksOf(out);
    expect(blocks.map((b) => b.callId)).toEqual(["toolu_review_a", "toolu_review_b"]);
    // 每张卡都带着任务书参数——标题与模型徽标取自它；孤儿块没有 args，正是截图里「子代理任务」那张
    expect(blocks.map((b) => parseTaskToolArgs(b.args)?.description)).toEqual([
      "评审 A（前半段）",
      "评审 B（后半段）",
    ]);
    expect(blocks.map((b) => parseTaskToolArgs(b.args)?.model)).toEqual([
      "composer-2.5",
      "claude-sonnet-5-5",
    ]);
    // A 已完成（配对的是结果），B 仍在跑
    expect(blocks[0]?.status).toBe("success");
    expect(blocks[1]?.status).toBe("running");
  });

  it("配对的是最后一条结果（沿用既有行为）：先错后成功 → 一张成功卡", () => {
    const events = [
      call("c1", "toolu_a", "shell", "ls"),
      result("r1", "toolu_a", "shell", "error", "boom"),
      result("r2", "toolu_a", "shell", "success", "done"),
    ];
    const blocks = blocksOf(mergeToolDisplayEvents(events));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.status).toBe("success");
    expect(blocks[0]?.result?.output).toBe("done");
  });

  it("配对的是最后一条结果：先成功后错误 → 一张错误卡（不是第一条）", () => {
    const events = [
      call("c1", "toolu_a", "shell", "ls"),
      result("r1", "toolu_a", "shell", "success", "done"),
      result("r2", "toolu_a", "shell", "error", "boom"),
    ];
    const blocks = blocksOf(mergeToolDisplayEvents(events));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.status).toBe("error");
    expect(blocks[0]?.result?.output).toBe("boom");
  });

  it("同一个 callId 三条结果也只出一张卡", () => {
    const events = [
      call("c1", "toolu_a", "task", taskArgs("评审", "composer-2.5")),
      result("r1", "toolu_a", "task"),
      result("r2", "toolu_a", "task"),
      result("r3", "toolu_a", "task"),
    ];
    const out = mergeToolDisplayEvents(events);
    expect(out).toHaveLength(1);
    expect(blocksOf(out)[0]?.status).toBe("success");
  });

  it("不限子代理：shell / read 的双结果（历史里隔几秒）同样只出一张卡", () => {
    const shell = blocksOf(
      mergeToolDisplayEvents([
        call("c1", "toolu_s", "shell", "echo hi"),
        result("r1", "toolu_s", "shell"),
        result("r2", "toolu_s", "shell"),
      ]),
    );
    expect(shell).toHaveLength(1);
    expect(shell[0]?.name).toBe("shell");

    const read = blocksOf(
      mergeToolDisplayEvents([
        call("c2", "toolu_r", "read", "a.ts"),
        result("r3", "toolu_r", "read"),
        result("r4", "toolu_r", "read"),
      ]),
    );
    expect(read).toHaveLength(1);
    expect(read[0]?.name).toBe("read");
  });

  it("不同 callId 互不影响：各自只出一张卡", () => {
    const events = [
      call("ca", "toolu_a", "task", taskArgs("甲", "m1")),
      call("cb", "toolu_b", "task", taskArgs("乙", "m2")),
      call("cc", "toolu_c", "task", taskArgs("丙", "m3")),
      result("ra1", "toolu_a", "task"),
      result("rb1", "toolu_b", "task"),
      result("ra2", "toolu_a", "task"),
      result("rc1", "toolu_c", "task"),
      result("rc2", "toolu_c", "task"),
      result("rc3", "toolu_c", "task"),
    ];
    const blocks = blocksOf(mergeToolDisplayEvents(events));
    expect(blocks.map((b) => b.callId)).toEqual([
      "toolu_a",
      "toolu_b",
      "toolu_c",
    ]);
    expect(blocks.every((b) => b.status === "success")).toBe(true);
  });

  it("重复结果晚到（流式）：卡片数不变、不闪出孤儿卡", () => {
    const events = screenshotEvents();
    const before = mergeToolDisplayEvents(events.slice(0, 3));
    expect(before).toHaveLength(2);
    expect(blocksOf(before)[0]?.status).toBe("success");
    const after = mergeToolDisplayEvents(events);
    expect(after).toHaveLength(2);
    expect(blocksOf(after).map((b) => b.callId)).toEqual(
      blocksOf(before).map((b) => b.callId),
    );
    expect(blocksOf(after)[0]?.status).toBe("success");
  });
});

describe("S2：没有配对调用的结果（call 在上一页）", () => {
  it("单条孤儿结果：照旧合成一个孤儿块（对照）", () => {
    const out = mergeToolDisplayEvents([result("r1", "toolu_old", "shell")]);
    const blocks = blocksOf(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.callId).toBe("toolu_old");
    expect(blocks[0]?.args).toBeUndefined();
    expect(blocks[0]?.status).toBe("success");
  });

  it("同 callId 的多条孤儿结果：只合成最后一条的块", () => {
    const out = mergeToolDisplayEvents([
      result("r1", "toolu_old", "shell", "error", "boom"),
      result("r2", "toolu_old", "shell", "success", "done"),
    ]);
    const blocks = blocksOf(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe("r2");
    expect(blocks[0]?.status).toBe("success");
  });
});

describe("S2：不误伤", () => {
  it("没有 callId 的 tool_result 不参与去重：原样保留（对照）", () => {
    const events = [
      ev({
        id: "x1",
        kind: "tool_result",
        text: "旧格式结果 1",
        meta: { name: "shell", status: "success", output: "a" },
      }),
      ev({
        id: "x2",
        kind: "tool_result",
        text: "旧格式结果 2",
        meta: { name: "shell", status: "success", output: "b" },
      }),
    ];
    const out = mergeToolDisplayEvents(events);
    expect(out.map((it) => it.id)).toEqual(["x1", "x2"]);
  });

  it("配对块的身份仍是 tool_call 事件（id / callId 不变）（对照）", () => {
    const blocks = blocksOf(mergeToolDisplayEvents(screenshotEvents()));
    expect(blocks[0]?.id).toBe("c1");
    expect(blocks[0]?.callId).toBe("toolu_review_a");
  });

  it("缓存对拍：有缓存与 noCache 的结果一致，重复调用也一致", () => {
    const events = screenshotEvents();
    const cached = mergeToolDisplayEvents(events);
    expect(mergeToolDisplayEvents(events)).toEqual(cached);
    expect(mergeToolDisplayEvents(events, { noCache: true })).toEqual(cached);
  });

  it("不改输入事件数组 / 事件对象", () => {
    const events = screenshotEvents();
    const snapshot = JSON.stringify(events);
    const lenBefore = events.length;
    mergeToolDisplayEvents(events);
    expect(events).toHaveLength(lenBefore);
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});
