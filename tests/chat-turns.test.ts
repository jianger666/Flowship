import { describe, expect, it } from "vitest";

import {
  deriveActiveStatus,
  groupChatRenderItems,
  isLatestErrorEvent,
  isWorkGroup,
  PROCESSING_PLACEHOLDER_LABEL,
  shouldShowProcessingPlaceholder,
  type WorkGroupItem,
} from "../src/lib/chat-turns";
import type { StreamRenderItem, ToolBlock, ToolVerbGroup } from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({
  ts: 1,
  ...partial,
});

const block = (
  partial: Partial<ToolBlock> & Pick<ToolBlock, "id" | "name">,
): ToolBlock => ({
  kind: "__tool_block__",
  callId: partial.id,
  status: "success",
  text: "调用",
  ts: 1,
  ...partial,
});

const verbGroup = (
  partial: Partial<ToolVerbGroup> & Pick<ToolVerbGroup, "id" | "members">,
): ToolVerbGroup => ({
  kind: "__tool_verb_group__",
  ts: partial.members[partial.members.length - 1]?.ts ?? 1,
  ...partial,
});

describe("groupChatRenderItems", () => {
  it("AI 中间插话独立并隔断组：user → thinking+tool 成组 → 插话 → 后续工具成新组 → 正文", () => {
    // 2026-07-21 用户验收拍板：AI 中间插的话不进组、且插话前后两批工具不得整合进同一组
    const user = ev({ id: "u1", kind: "user_reply", text: "你好", ts: 10 });
    const thinking = ev({ id: "t1", kind: "thinking", text: "想一下", ts: 20 });
    const tool = block({ id: "tb1", name: "shell", ts: 30, status: "success" });
    const aside = ev({
      id: "a1",
      kind: "assistant_message",
      text: "查到 X、我再看看 Y",
      ts: 40,
    });
    const tool2 = block({ id: "tb2", name: "read", ts: 45, status: "success" });
    const body = ev({
      id: "a2",
      kind: "assistant_message",
      text: "结论在此",
      ts: 50,
    });
    const out = groupChatRenderItems([user, thinking, tool, aside, tool2, body]);
    expect(out.map((x) => x.kind)).toEqual([
      "user_reply",
      "__work_group__",
      "assistant_message",
      "__work_group__",
      "assistant_message",
    ]);
    const g1 = out[1] as WorkGroupItem;
    expect(g1.id).toBe("t1");
    expect(g1.members.map((m) => m.id)).toEqual(["t1", "tb1"]);
    expect(g1.stepCount).toBe(2);
    expect(g1.startTs).toBe(20);
    expect(g1.endTs).toBe(30);
    expect(out[2]).toMatchObject({ kind: "assistant_message", id: "a1" });
    const g2 = out[3] as WorkGroupItem;
    expect(g2.members.map((m) => m.id)).toEqual(["tb2"]);
    expect(out[4]).toMatchObject({ kind: "assistant_message", id: "a2" });
  });

  it("多 turn 边界：第二个 user_reply 重开分组", () => {
    const u1 = ev({ id: "u1", kind: "user_reply", text: "一", ts: 1 });
    const t1 = ev({ id: "t1", kind: "thinking", text: "想", ts: 2 });
    const a1 = ev({ id: "a1", kind: "assistant_message", text: "答一", ts: 3 });
    const u2 = ev({ id: "u2", kind: "user_reply", text: "二", ts: 4 });
    const t2 = ev({ id: "t2", kind: "thinking", text: "再想", ts: 5 });
    const a2 = ev({ id: "a2", kind: "assistant_message", text: "答二", ts: 6 });
    const out = groupChatRenderItems([u1, t1, a1, u2, t2, a2]);
    expect(out.map((x) => x.kind)).toEqual([
      "user_reply",
      "__work_group__",
      "assistant_message",
      "user_reply",
      "__work_group__",
      "assistant_message",
    ]);
    expect((out[1] as WorkGroupItem).id).toBe("t1");
    expect((out[1] as WorkGroupItem).members).toHaveLength(1);
    expect((out[4] as WorkGroupItem).id).toBe("t2");
    expect(out[2]).toMatchObject({ id: "a1" });
    expect(out[5]).toMatchObject({ id: "a2" });
  });

  it("assistant 一律独立：唯一 assistant 不进组；零 assistant 全成组", () => {
    const onlyBody = groupChatRenderItems([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "a", kind: "assistant_message", text: "only", ts: 2 }),
    ]);
    expect(onlyBody.map((x) => x.kind)).toEqual([
      "user_reply",
      "assistant_message",
    ]);

    const noBody = groupChatRenderItems([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "t", kind: "thinking", text: "…", ts: 2 }),
      block({ id: "tb", name: "read", ts: 3 }),
    ]);
    expect(noBody).toHaveLength(2);
    expect(noBody[0]).toMatchObject({ kind: "user_reply" });
    expect(isWorkGroup(noBody[1]!)).toBe(true);
    expect((noBody[1] as WorkGroupItem).members.map((m) => m.id)).toEqual([
      "t",
      "tb",
    ]);
  });

  it("不进组项隔断：ask_user_request 前后各成一组、ask 独立", () => {
    const items: StreamRenderItem[] = [
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "t1", kind: "thinking", text: "前", ts: 2 }),
      ev({
        id: "ask",
        kind: "ask_user_request",
        text: "选一个",
        ts: 3,
      }),
      block({ id: "tb", name: "shell", ts: 4 }),
      ev({ id: "a", kind: "assistant_message", text: "好了", ts: 5 }),
    ];
    const out = groupChatRenderItems(items);
    expect(out.map((x) => x.kind)).toEqual([
      "user_reply",
      "__work_group__",
      "ask_user_request",
      "__work_group__",
      "assistant_message",
    ]);
    expect((out[1] as WorkGroupItem).members.map((m) => m.id)).toEqual(["t1"]);
    expect((out[3] as WorkGroupItem).members.map((m) => m.id)).toEqual(["tb"]);
  });

  it("assistant 之后的收尾成员 → 新组", () => {
    const out = groupChatRenderItems([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "t", kind: "thinking", text: "想", ts: 2 }),
      ev({ id: "a", kind: "assistant_message", text: "正文", ts: 3 }),
      block({ id: "tail", name: "shell", ts: 4, status: "success" }),
    ]);
    expect(out.map((x) => x.kind)).toEqual([
      "user_reply",
      "__work_group__",
      "assistant_message",
      "__work_group__",
    ]);
    expect((out[1] as WorkGroupItem).id).toBe("t");
    expect((out[3] as WorkGroupItem).id).toBe("tail");
    expect((out[3] as WorkGroupItem).members).toHaveLength(1);
  });

  it("error 独立平铺、隔断前后组——不能被组的「run 结束自动收起」吃掉", () => {
    // 2026-07-28：跑了 40 分钟的 build 挂了，错误却收进工作过程组、run 一结束整组自动
    // 收起，用户正在读的错误啪一下消失。error 从此不进组、跟 assistant_message 同等待遇。
    const out = groupChatRenderItems([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "t", kind: "thinking", text: "想", ts: 2 }),
      block({ id: "tb", name: "shell", ts: 3, status: "success" }),
      ev({ id: "e", kind: "error", text: "Chat agent 异常：炸了", ts: 4 }),
      block({ id: "tb2", name: "read", ts: 5, status: "success" }),
      ev({ id: "a", kind: "assistant_message", text: "答", ts: 6 }),
    ]);
    expect(out.map((x) => x.kind)).toEqual([
      "user_reply",
      "__work_group__",
      "error",
      "__work_group__",
      "assistant_message",
    ]);
    // 错误项原样输出、没有被包进任何组
    expect(out[2]).toMatchObject({ kind: "error", id: "e" });
    expect((out[1] as WorkGroupItem).members.map((m) => m.id)).toEqual([
      "t",
      "tb",
    ]);
    expect((out[3] as WorkGroupItem).members.map((m) => m.id)).toEqual(["tb2"]);
    // 组里没有 error 成员了 → hasError 只由「工具执行失败」驱动
    expect((out[1] as WorkGroupItem).hasError).toBe(false);
  });

  it("hasError / hasRunning / stepCount / startTs / endTs", () => {
    const thinking = ev({ id: "t", kind: "thinking", text: "x", ts: 100 });
    const running = block({
      id: "run",
      name: "shell",
      ts: 200,
      status: "running",
    });
    const errBlock = block({
      id: "eb",
      name: "edit",
      ts: 400,
      status: "error",
    });
    const body = ev({
      id: "a",
      kind: "assistant_message",
      text: "仍答",
      ts: 500,
    });
    const out = groupChatRenderItems([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      thinking,
      running,
      errBlock,
      body,
    ]);
    const g = out[1] as WorkGroupItem;
    // 工具块 error 状态仍算组内有错（组头那个 ✗ 靠它）
    expect(g.hasError).toBe(true);
    expect(g.hasRunning).toBe(true);
    expect(g.stepCount).toBe(3);
    expect(g.startTs).toBe(100);
    expect(g.endTs).toBe(400);

    // verb-group 内 error 成员也算 hasError；整组算 1 步
    const vg = verbGroup({
      id: "verb_r1",
      members: [
        block({ id: "r1", name: "read", ts: 10, status: "success" }),
        block({ id: "r2", name: "grep", ts: 20, status: "error" }),
      ],
    });
    const outVg = groupChatRenderItems([
      ev({ id: "u2", kind: "user_reply", text: "q", ts: 1 }),
      vg,
      ev({ id: "a2", kind: "assistant_message", text: "ok", ts: 30 }),
    ]);
    const g2 = outVg[1] as WorkGroupItem;
    expect(g2.hasError).toBe(true);
    expect(g2.stepCount).toBe(1);
    expect(g2.startTs).toBe(20); // verb group 自身 ts = 末成员
    expect(g2.endTs).toBe(20);
  });

  it("info 不进组", () => {
    const out = groupChatRenderItems([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "t", kind: "thinking", text: "想", ts: 2 }),
      ev({ id: "i", kind: "info", text: "重连中", ts: 3 }),
      block({ id: "tb", name: "shell", ts: 4 }),
      ev({ id: "a", kind: "assistant_message", text: "答", ts: 5 }),
    ]);
    expect(out.map((x) => x.kind)).toEqual([
      "user_reply",
      "__work_group__",
      "info",
      "__work_group__",
      "assistant_message",
    ]);
    expect((out[1] as WorkGroupItem).members.map((m) => m.id)).toEqual(["t"]);
    expect((out[3] as WorkGroupItem).members.map((m) => m.id)).toEqual(["tb"]);
  });

  it("空输入 / 全独立项 → 原样返回、零组；单成员也成组", () => {
    expect(groupChatRenderItems([])).toEqual([]);

    const onlyIndep: StreamRenderItem[] = [
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "i", kind: "info", text: "hi", ts: 2 }),
      ev({
        id: "ask",
        kind: "ask_user_request",
        text: "?",
        ts: 3,
      }),
    ];
    const indepOut = groupChatRenderItems(onlyIndep);
    expect(indepOut.every((x) => !isWorkGroup(x))).toBe(true);
    expect(indepOut.map((x) => x.id)).toEqual(["u", "i", "ask"]);

    const single = groupChatRenderItems([
      ev({ id: "t", kind: "thinking", text: "solo", ts: 1 }),
    ]);
    expect(single).toHaveLength(1);
    expect(isWorkGroup(single[0]!)).toBe(true);
    expect((single[0] as WorkGroupItem).stepCount).toBe(1);
  });

  it("流首无 user_reply 的过程成员也可成组（turn 从开头起）", () => {
    const out = groupChatRenderItems([
      ev({ id: "t", kind: "thinking", text: "先想", ts: 1 }),
      ev({ id: "a", kind: "assistant_message", text: "答", ts: 2 }),
      ev({ id: "u", kind: "user_reply", text: "下一轮", ts: 3 }),
      ev({ id: "a2", kind: "assistant_message", text: "再答", ts: 4 }),
    ]);
    expect(out.map((x) => x.kind)).toEqual([
      "__work_group__",
      "assistant_message",
      "user_reply",
      "assistant_message",
    ]);
  });
});

describe("isLatestErrorEvent", () => {
  // 「重试」发的是最后一条用户消息——只有当轮失败该给这个入口，
  // 否则翻历史点旧错误上的重试会把今天最后那条消息重发出去
  const err = (id: string, ts: number) =>
    ev({ id, kind: "error", text: "炸了", ts });

  it("最后一条 error 且其后无新用户消息 → 可重试", () => {
    const events = [
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "t", kind: "thinking", text: "想", ts: 2 }),
      err("e1", 3),
    ];
    expect(isLatestErrorEvent(events, "e1")).toBe(true);

    // 错误之后还有 assistant / info 之类不影响判定（用户没接话、这轮还没翻篇）
    expect(
      isLatestErrorEvent(
        [...events, ev({ id: "i", kind: "info", text: "已停止", ts: 4 })],
        "e1",
      ),
    ).toBe(true);
  });

  it("其后有新用户消息 → 这轮已翻篇、不给重试", () => {
    const events = [
      ev({ id: "u1", kind: "user_reply", text: "q", ts: 1 }),
      err("e1", 2),
      ev({ id: "u2", kind: "user_reply", text: "再来", ts: 3 }),
    ];
    expect(isLatestErrorEvent(events, "e1")).toBe(false);
  });

  it("有更新的 error → 只有最新那条可重试", () => {
    const events = [
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      err("e1", 2),
      err("e2", 3),
    ];
    expect(isLatestErrorEvent(events, "e1")).toBe(false);
    expect(isLatestErrorEvent(events, "e2")).toBe(true);
  });

  it("非 error 事件 / 不存在的 id → false", () => {
    const events = [
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "a", kind: "assistant_message", text: "答", ts: 2 }),
    ];
    expect(isLatestErrorEvent(events, "a")).toBe(false);
    expect(isLatestErrorEvent(events, "nope")).toBe(false);
    expect(isLatestErrorEvent([], "e")).toBe(false);
  });

  it("回合内工具失败（带 callId）不算当轮崩溃、不给重试、不挡真正的 run 错误", () => {
    const toolErr = ev({
      id: "te",
      kind: "error",
      text: "工具调用失败 grep",
      ts: 2,
      meta: { callId: "c1", name: "grep" },
    });
    const runErr = ev({
      id: "re",
      kind: "error",
      text: "Chat agent 异常：断网",
      ts: 3,
    });
    const events = [
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      toolErr,
    ];
    expect(isLatestErrorEvent(events, "te")).toBe(false);
    expect(isLatestErrorEvent([...events, runErr], "re")).toBe(true);
    expect(isLatestErrorEvent([...events, runErr], "te")).toBe(false);
  });
});

describe("deriveActiveStatus", () => {
  it("未配对 tool_call：带 liveOutput 用尾行；无 live 用 args 摘要", () => {
    const call = ev({
      id: "c1",
      kind: "tool_call",
      text: "调用 shell",
      ts: 2,
      meta: {
        callId: "cid1",
        name: "shell",
        args: JSON.stringify({ command: "pnpm lint" }),
      },
    });
    const withLive = deriveActiveStatus(
      [ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }), call],
      { cid1: "line1\nline2 final out" },
    );
    expect(withLive).toEqual({
      label: "正在执行 shell",
      detail: "line2 final out",
    });

    const noLive = deriveActiveStatus([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      call,
    ]);
    expect(noLive?.label).toBe("正在执行 shell");
    expect(noLive?.detail).toMatch(/pnpm lint/);
  });

  it("thinking 尾 → 思考中 + 末行截断", () => {
    const status = deriveActiveStatus([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({
        id: "t",
        kind: "thinking",
        text: "第一行\n第二行很长的思考内容",
        ts: 2,
      }),
    ]);
    expect(status?.label).toBe("思考中");
    expect(status?.detail).toBe("第二行很长的思考内容");
  });

  it("纯 assistant → 正在回复…；已完成工具 → 处理中…", () => {
    expect(
      deriveActiveStatus([
        ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
        ev({ id: "a", kind: "assistant_message", text: "答", ts: 2 }),
      ]),
    ).toEqual({ label: "正在回复…" });

    const done = deriveActiveStatus([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({
        id: "c",
        kind: "tool_call",
        text: "调用",
        ts: 2,
        meta: { callId: "x", name: "read", args: "{}" },
      }),
      ev({
        id: "r",
        kind: "tool_result",
        text: "完成",
        ts: 3,
        meta: {
          callId: "x",
          name: "read",
          status: "success",
          output: "ok",
        },
      }),
    ]);
    expect(done).toEqual({ label: PROCESSING_PLACEHOLDER_LABEL });
  });

  it("正文已在流时，已完成工具改口正在回复…", () => {
    const events = [
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({
        id: "c",
        kind: "tool_call",
        text: "调用",
        ts: 2,
        meta: { callId: "x", name: "write" },
      }),
      ev({
        id: "r",
        kind: "tool_result",
        text: "完成",
        ts: 3,
        meta: { callId: "x", name: "write", status: "success" },
      }),
    ];
    expect(deriveActiveStatus(events, undefined, { streaming: true })).toEqual({
      label: "正在回复…",
    });
  });

  it("user_reply 后无活动 → 正在启动…", () => {
    expect(
      deriveActiveStatus([
        ev({ id: "u", kind: "user_reply", text: "刚发", ts: 1 }),
      ]),
    ).toEqual({ label: "正在启动…" });

    // 尾部只有 info，再往前是 user_reply
    expect(
      deriveActiveStatus([
        ev({ id: "u", kind: "user_reply", text: "刚发", ts: 1 }),
        ev({ id: "i", kind: "info", text: "boot", ts: 2 }),
      ]),
    ).toEqual({ label: "正在启动…" });
  });

  it("task 子代理工具 → 子代理工作中 + description", () => {
    const status = deriveActiveStatus([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({
        id: "c",
        kind: "tool_call",
        text: "调用 task",
        ts: 2,
        meta: {
          callId: "task1",
          name: "task",
          args: JSON.stringify({
            description: "排查 auth",
            prompt: "请完整排查",
          }),
        },
      }),
    ]);
    expect(status).toEqual({
      label: "子代理工作中",
      detail: "排查 auth",
    });
  });

  it("空输入 → null；未配对优先于更早的 thinking", () => {
    expect(deriveActiveStatus([])).toBeNull();

    const status = deriveActiveStatus([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      ev({ id: "t", kind: "thinking", text: "旧思考", ts: 2 }),
      ev({
        id: "c",
        kind: "tool_call",
        text: "调用 grep",
        ts: 3,
        meta: { callId: "g1", name: "grep", args: JSON.stringify({ pattern: "x" }) },
      }),
    ]);
    expect(status?.label).toBe("正在执行 grep");
  });

  it("detail 超长截断约 80 字", () => {
    const long = "x".repeat(120);
    const status = deriveActiveStatus(
      [
        ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
        ev({
          id: "c",
          kind: "tool_call",
          text: "调用 shell",
          ts: 2,
          meta: { callId: "cid", name: "shell", args: "{}" },
        }),
      ],
      { cid: long },
    );
    expect(status?.detail?.length).toBeLessThanOrEqual(81);
    expect(status?.detail?.endsWith("…")).toBe(true);
  });
});

describe("shouldShowProcessingPlaceholder", () => {
  const on = {
    isRunning: true,
    isLastItem: true,
    hasRunning: false,
    hasStreamingText: false,
    lastMemberKind: "__tool_block__",
  };

  it("流尾、工具已完成、正文还没出来 → 挂处理中", () => {
    expect(shouldShowProcessingPlaceholder(on)).toBe(true);
  });

  it("工具还在跑 / 已在流正文 / 末行是思考 → 不挂", () => {
    expect(shouldShowProcessingPlaceholder({ ...on, hasRunning: true })).toBe(
      false,
    );
    expect(
      shouldShowProcessingPlaceholder({ ...on, hasStreamingText: true }),
    ).toBe(false);
    expect(
      shouldShowProcessingPlaceholder({ ...on, lastMemberKind: "thinking" }),
    ).toBe(false);
    expect(shouldShowProcessingPlaceholder({ ...on, isLastItem: false })).toBe(
      false,
    );
    expect(shouldShowProcessingPlaceholder({ ...on, isRunning: false })).toBe(
      false,
    );
  });
});
