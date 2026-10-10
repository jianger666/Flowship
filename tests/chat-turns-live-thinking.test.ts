/**
 * attachLiveThinking：把「正在进行的思考」作为一条真正的 thinking 成员画进工作过程流程
 *
 * 背景（2026-10-10）：thinking 事件要整段思考结束才落盘，一段思考可达一分多钟——期间流程里缺这一步，
 * 用户看到的只是底部一行「等待模型响应… 已等待 62s」。用户要的是「就用现在已有的思考的展示、
 * 一直（从开始到结束）显示就行」：所以进行中的思考不另做组件，而是合成一条 thinking 事件、
 * 并进流尾的工作过程组，由已有的思考行渲染；服务端预定的落盘 id 让落盘前后是同一个 React 节点
 * （用户点开着读的内容不会在落盘那一刻被收起）。
 *
 * 这里用真实的 groupChatRenderItems / coalesceAdjacentThinking 产出做输入和对照（而不是手捏对象），钉死：
 *   - 落在哪里（追加 / 并进末尾的思考 / 新建组）；
 *   - **与落盘后同构**：组 id、成员 id 序列、步数与「该事件落盘后 buildStreamItems 的产出」一致——
 *     这是「同一个节点、不重挂载」的结构保证；
 *   - 只改流尾一项、前面的引用不变（memo 的行不被每帧击穿）、不改入参；
 *   - hasRunning 置真 → 「处理中…」占位让位。
 */
import { describe, expect, it } from "vitest";

import {
  attachLiveThinking,
  groupChatRenderItems,
  isLiveThinkingEvent,
  isLiveThinkingMeta,
  isWorkGroup,
  shouldShowProcessingPlaceholder,
  type ChatRenderItem,
  type WorkGroupItem,
} from "../src/lib/chat-turns";
import { coalesceAdjacentThinking } from "../src/lib/merge-thinking";
import { THINKING_TEXT_MAX, type LiveThinking } from "../src/lib/thinking-live";
import type { ToolBlock } from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({ ts: 1, ...partial });

const live = (over: Partial<LiveThinking> = {}): LiveThinking => ({
  id: "e_live",
  text: "先看数据",
  since: 150,
  ...over,
});

const tool = (id = "tool1", ts = 3): ToolBlock => ({
  kind: "__tool_block__",
  id,
  callId: id,
  name: "shell",
  status: "success",
  text: "ls",
  ts,
});

const user = ev({ id: "u", kind: "user_reply", text: "q", ts: 1 });
const think1 = ev({ id: "t1", kind: "thinking", text: "想", ts: 2 });
const aside = ev({ id: "a", kind: "assistant_message", text: "我先看看", ts: 3 });
const think2 = ev({ id: "t2", kind: "thinking", text: "再想", ts: 4 });

/** 这段思考落盘后那条真实事件（id / 文本与实时态一致） */
const persisted = (l: LiveThinking, ts = 999): TaskEvent =>
  ev({ id: l.id, kind: "thinking", text: l.text, ts });

const lastGroup = (items: readonly ChatRenderItem[]): WorkGroupItem => {
  const last = items[items.length - 1]!;
  expect(isWorkGroup(last)).toBe(true);
  return last as WorkGroupItem;
};

/** 流尾那一组的「形状」：组 id + 成员 id 序列 + 步数。同构 = 形状一致 = React key 一致 */
const shape = (g: WorkGroupItem) => ({
  id: g.id,
  members: g.members.map((m) => m.id),
  stepCount: g.stepCount,
});

const textOf = (m: ChatRenderItem): string => (m as TaskEvent).text;

describe("attachLiveThinking：落在哪里", () => {
  it("流尾是工作过程组、末成员不是思考（比如工具）：追加为新成员，组 id 不变、步数 +1", () => {
    const items = groupChatRenderItems([user, think1, tool()]); // [user, group(t1, tool1)]
    const out = attachLiveThinking(items, live({ since: 150 }));

    expect(out).toHaveLength(items.length);
    const g = lastGroup(out);
    expect(g.id).toBe("t1"); // 组 id = 首成员 id，不变 → 组不重挂载
    expect(g.members.map((m) => m.id)).toEqual(["t1", "tool1", "e_live"]);
    expect(g.stepCount).toBe(3);
    expect(g.hasRunning).toBe(true);
    expect(g.endTs).toBe(150);

    const step = g.members[2] as TaskEvent;
    expect(step.kind).toBe("thinking");
    expect(step.id).toBe("e_live");
    expect(step.ts).toBe(150);
    expect(step.text).toBe("先看数据");
  });

  it("末成员已是思考：并进去——沿用它的 id 和 ts、文本拼接、步数不变，已落盘的耗时保留", () => {
    const prev = ev({
      id: "t1",
      kind: "thinking",
      text: "想",
      ts: 2,
      meta: { durationMs: 8000 },
    });
    const items = groupChatRenderItems([user, prev]);
    const out = attachLiveThinking(items, live());

    const g = lastGroup(out);
    expect(g.id).toBe("t1");
    expect(g.members).toHaveLength(1);
    expect(g.stepCount).toBe(1); // 并进去、不新增一步
    const merged = g.members[0] as TaskEvent;
    expect(merged.id).toBe("t1");
    expect(merged.ts).toBe(2);
    expect(merged.text).toBe("想先看数据");
    expect(merged.meta?.durationMs).toBe(8000);
    expect(merged.meta?.live).toBe(true);
    expect(g.hasRunning).toBe(true);
  });

  it("流尾是 user_reply（回车后第一段思考）：新建只含这一步的组，组 id = 思考 id", () => {
    const items = groupChatRenderItems([user]);
    const out = attachLiveThinking(items, live({ since: 120 }));

    expect(out).toHaveLength(2);
    const g = lastGroup(out);
    expect(g.id).toBe("e_live");
    expect(g.members.map((m) => m.id)).toEqual(["e_live"]);
    expect(g.stepCount).toBe(1);
    expect(g.hasRunning).toBe(true);
    expect(g.hasError).toBe(false);
    expect(g.startTs).toBe(120);
    expect(g.endTs).toBe(120);
  });

  it("AI 插话之后又开始想：新建组，不并入插话之前的组（插话天然隔断前后两组）", () => {
    const items = groupChatRenderItems([user, think1, aside]); // [user, group(t1), aside]
    const out = attachLiveThinking(items, live());

    expect(out).toHaveLength(items.length + 1);
    expect(lastGroup(out).id).toBe("e_live");
    // 插话之前的那一组原样保留，没被塞进「进行中」
    expect((out[1] as WorkGroupItem).members.map((m) => m.id)).toEqual(["t1"]);
    expect(out[1]).toBe(items[1]);
  });

  it("空流：新建组（不崩）", () => {
    const out = attachLiveThinking([], live());
    expect(out).toHaveLength(1);
    expect(lastGroup(out).id).toBe("e_live");
  });

  it("已落盘兜底：尾组里已经有同 id 的事件（落盘先于清实时态那次更新到达）→ 原样返回、不叠第二份", () => {
    const l = live();
    const items = groupChatRenderItems([user, persisted(l)]);
    expect(attachLiveThinking(items, l)).toBe(items);

    // 落盘事件之后紧跟着又来了别的成员，也一样兜底（不能只看末成员）
    const withTool = groupChatRenderItems([user, persisted(l), tool()]);
    expect(attachLiveThinking(withTool, l)).toBe(withTool);
  });
});

describe("attachLiveThinking：与落盘后同构（组 id / 行 id / 步数一致 = 同一个 React 节点）", () => {
  it("追加场景：[user, 思考, 工具] + 进行中 ≡ 该思考落盘后的 [user, 思考, 工具, 思考]", () => {
    const l = live();
    const before = groupChatRenderItems([user, think1, tool()]);
    const after = groupChatRenderItems([user, think1, tool(), persisted(l)]);

    expect(shape(lastGroup(attachLiveThinking(before, l)))).toEqual(
      shape(lastGroup(after)),
    );
  });

  it("新建组场景：[user] + 进行中 ≡ 落盘后的 [user, 思考]", () => {
    const l = live();
    const before = groupChatRenderItems([user]);
    const after = groupChatRenderItems([user, persisted(l)]);

    expect(shape(lastGroup(attachLiveThinking(before, l)))).toEqual(
      shape(lastGroup(after)),
    );
  });

  it("相邻思考场景：落盘后 coalesceAdjacentThinking 会收成一条（保留第一条的 id）——进行中提前对齐，落盘那一刻不会「两行变一行」", () => {
    const l = live();
    const before = groupChatRenderItems([user, think1]);
    // 落盘后 buildStreamItems 的真实顺序：先在事件层合并相邻 thinking、再分组
    const after = groupChatRenderItems(
      coalesceAdjacentThinking([user, think1, persisted(l)]),
    );

    const attached = lastGroup(attachLiveThinking(before, l));
    const settled = lastGroup(after);
    expect(shape(attached)).toEqual(shape(settled));
    // 文本也一致：合并后的行显示的就是「前一段 + 本段」
    expect(textOf(attached.members[0]!)).toBe(textOf(settled.members[0]!));
  });

  it("插话之后新建组场景：[user, 思考, 插话] + 进行中 ≡ 落盘后的 [user, 思考, 插话, 思考]", () => {
    const l = live();
    const before = groupChatRenderItems([user, think1, aside]);
    const after = groupChatRenderItems([user, think1, aside, persisted(l)]);

    expect(shape(lastGroup(attachLiveThinking(before, l)))).toEqual(
      shape(lastGroup(after)),
    );
  });

  it("末成员是带 actionId 的思考：coalesce 要 actionId 相同才合并，进行中的（没有 actionId）不并入、追加为新成员", () => {
    const l = live();
    const actionThink = ev({
      id: "t_act",
      kind: "thinking",
      text: "任务里想的",
      ts: 2,
      actionId: "act1",
    });
    const before = groupChatRenderItems([user, actionThink]);
    const after = groupChatRenderItems(
      coalesceAdjacentThinking([user, actionThink, persisted(l)]),
    );

    const attached = lastGroup(attachLiveThinking(before, l));
    const settled = lastGroup(after);
    // 落盘后是两条（actionId 不同、不合并）；进行中同样两条
    expect(settled.members).toHaveLength(2);
    expect(shape(attached)).toEqual(shape(settled));
    // 前一条原样保留，没有被拼进进行中的文本
    expect(textOf(attached.members[0]!)).toBe("任务里想的");
    expect(textOf(attached.members[1]!)).toBe(l.text);
  });
});

describe("attachLiveThinking：不扰动其它东西", () => {
  it("不改入参：返回新数组，原数组与原尾组一字不动", () => {
    const items = groupChatRenderItems([user, think1, tool()]);
    const snapshot = JSON.stringify(items);

    const out = attachLiveThinking(items, live());

    expect(out).not.toBe(items);
    expect(JSON.stringify(items)).toBe(snapshot);
    expect((items[1] as WorkGroupItem).members).toHaveLength(2);
  });

  it("只有流尾一项变：前面的项引用不变；尾组里前面的成员引用也不变（memo 的行不被击穿）", () => {
    const items = groupChatRenderItems([user, think1, aside, think2, tool("tool9", 5)]);
    // [user, g1(t1), aside, g2(t2, tool9)]
    const out = attachLiveThinking(items, live());

    expect(out).toHaveLength(items.length);
    expect(out[0]).toBe(items[0]);
    expect(out[1]).toBe(items[1]);
    expect(out[2]).toBe(items[2]);
    expect(out[3]).not.toBe(items[3]); // 尾组换了外壳

    const before = items[3] as WorkGroupItem;
    const after = lastGroup(out);
    expect(after.members[0]).toBe(before.members[0]);
    expect(after.members[1]).toBe(before.members[1]);
  });

  it("endTs 取较大者：客户端收到首帧的时刻可能早于服务端落盘事件的时间戳", () => {
    const late = tool("tool9", 500);
    const items = groupChatRenderItems([user, think1, late]);
    expect(lastGroup(attachLiveThinking(items, live({ since: 100 }))).endTs).toBe(500);
  });
});

describe("合成事件的标记（ProcessEventRow 据此多画转圈、摘要取最新一行）", () => {
  it("追加的新成员带 meta.live；没超上限就没有 liveTruncated", () => {
    const items = groupChatRenderItems([user, tool()]);
    const step = lastGroup(attachLiveThinking(items, live())).members.at(-1) as TaskEvent;
    expect(step.meta?.live).toBe(true);
    expect(step.meta?.liveTruncated).toBeUndefined();
  });

  it("原文超过前端保留上限：带 liveTruncated（展开区顶部据此提示）；并进末尾思考时同样带", () => {
    const long = "x".repeat(THINKING_TEXT_MAX);
    const appended = lastGroup(
      attachLiveThinking(groupChatRenderItems([user, tool()]), live({ text: long })),
    ).members.at(-1) as TaskEvent;
    expect(appended.meta?.liveTruncated).toBe(true);

    const merged = lastGroup(
      attachLiveThinking(groupChatRenderItems([user, think1]), live({ text: long })),
    ).members[0] as TaskEvent;
    expect(merged.meta?.liveTruncated).toBe(true);
  });

  it("isLiveThinkingMeta / isLiveThinkingEvent：只认合成的那条", () => {
    const items = groupChatRenderItems([user, think1, tool()]);
    const members = lastGroup(attachLiveThinking(items, live())).members;
    const [first, second, synthesized] = members as [TaskEvent, ToolBlock, TaskEvent];

    expect(isLiveThinkingMeta(synthesized)).toBe(true);
    expect(isLiveThinkingEvent(synthesized)).toBe(true);

    // 普通落盘的思考行不是
    expect(isLiveThinkingMeta(first)).toBe(false);
    expect(isLiveThinkingEvent(first)).toBe(false);
    // 工具块不是
    expect(isLiveThinkingEvent(second)).toBe(false);
    // 没有东西不是
    expect(isLiveThinkingEvent(undefined)).toBe(false);
    // 不是 thinking 的事件，哪怕 meta 里有 live 也不是
    expect(
      isLiveThinkingMeta(ev({ id: "x", kind: "info", text: "x", meta: { live: true } })),
    ).toBe(false);
    // 只认布尔 true：磁盘上的事件 meta 是任意 JSON，不能让「碰巧有个真值」的 live 字段
    // 把一条落盘的思考当成进行中的（那样它会永远转圈、摘要永远取最新一行、耗时永远不显示）
    for (const bogus of ["true", "yes", 1, {}, [], false, 0, null]) {
      expect(
        isLiveThinkingMeta(
          ev({ id: "x", kind: "thinking", text: "x", meta: { live: bogus } }),
        ),
        `meta.live = ${JSON.stringify(bogus)}`,
      ).toBe(false);
    }
  });
});

describe("与「处理中…」占位的关系", () => {
  const ask = (g: WorkGroupItem, lastMemberKind = "__tool_block__") =>
    shouldShowProcessingPlaceholder({
      isRunning: true,
      isLastItem: true,
      hasRunning: g.hasRunning,
      hasStreamingText: false,
      lastMemberKind,
    });

  it("没有进行中的思考时，工具跑完后的空等会挂「处理中…」；并入后让位（hasRunning）", () => {
    const items = groupChatRenderItems([user, think1, tool()]);
    const plain = items[1] as WorkGroupItem;
    const attached = lastGroup(attachLiveThinking(items, live()));

    expect(ask(plain)).toBe(true);
    expect(ask(attached)).toBe(false);
  });

  it("末成员是进行中的思考时，既有的「末成员是 thinking 就不叠占位」规则也成立（双保险）", () => {
    const items = groupChatRenderItems([user, think1]);
    const attached = lastGroup(attachLiveThinking(items, live()));
    const lastKind = attached.members[attached.members.length - 1]!.kind;

    expect(lastKind).toBe("thinking");
    // 单看末成员规则：把 hasRunning 压成 false 也不挂占位
    expect(
      shouldShowProcessingPlaceholder({
        isRunning: true,
        isLastItem: true,
        hasRunning: false,
        hasStreamingText: false,
        lastMemberKind: lastKind,
      }),
    ).toBe(false);
  });
});
