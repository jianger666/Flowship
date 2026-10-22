import { describe, expect, it } from "vitest";

import {
  analyzingToolLabel,
  AWAITING_ASK_LABEL,
  deriveActiveStatus,
  formatStatusElapsed,
  groupChatRenderItems,
  isLatestErrorEvent,
  isWorkGroup,
  latestEventTs,
  msUntilStall,
  PROCESSING_PLACEHOLDER_LABEL,
  shouldShowProcessingPlaceholder,
  STATUS_ELAPSED_SHOW_AFTER_MS,
  STATUS_STALL_AFTER_MS,
  STATUS_STALL_DETAIL,
  STATUS_STALL_LABEL,
  stallFallbackStatus,
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
    // 组 id = 首成员的稳定身份：思考取事件 id、工具块取 `tool:${callId}`（R4-01，见 tests/row-id-stability.test.ts）
    expect((out[3] as WorkGroupItem).id).toBe("tool:tail");
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
    // sinceTs = 这条 tool_call 的 ts：状态行据此显示「已执行多久」
    expect(withLive).toEqual({
      label: "正在执行 shell",
      detail: "line2 final out",
      sinceTs: 2,
    });

    const noLive = deriveActiveStatus([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      call,
    ]);
    expect(noLive?.label).toBe("正在执行 shell");
    expect(noLive?.detail).toMatch(/pnpm lint/);
  });

  it("thinking 尾 → 思考中（不带原文：原文在组内思考行里，状态行再摘一行就是上下重复）", () => {
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
    expect(status?.detail).toBeUndefined();
  });

  it("纯 assistant → 正在回复…；已完成工具 → 正在分析 read 的结果（带起点时间）", () => {
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
    // 等待从「工具结果落盘」(ts=3) 算起，不是从 tool_call (ts=2) 算起——工具自己的耗时不算进空等
    expect(done).toEqual({ label: "正在分析 read 的结果", sinceTs: 3 });
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

  it("user_reply 后无活动 → 正在启动…（带让位标记：流尾有进度行时状态行不再重复说）", () => {
    expect(
      deriveActiveStatus([
        ev({ id: "u", kind: "user_reply", text: "刚发", ts: 1 }),
      ]),
    ).toEqual({ label: "正在启动…", yieldToTail: true });

    // 尾部只有 info，再往前是 user_reply
    expect(
      deriveActiveStatus([
        ev({ id: "u", kind: "user_reply", text: "刚发", ts: 1 }),
        ev({ id: "i", kind: "info", text: "boot", ts: 2 }),
      ]),
    ).toEqual({ label: "正在启动…", yieldToTail: true });
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
      sinceTs: 2,
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

  it("压缩进行中盖过「正在回复…」；结束后继续往前扫", () => {
    const running = ev({
      id: "c",
      kind: "info",
      text: "正在压缩上下文…",
      ts: 3,
      meta: { kind: "compaction", status: "running" },
    });
    expect(
      deriveActiveStatus(
        [
          ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
          ev({ id: "a", kind: "assistant_message", text: "结论：可合", ts: 2 }),
          running,
        ],
        undefined,
        { streaming: true },
      ),
    ).toEqual({ label: "正在压缩上下文…" });

    expect(
      deriveActiveStatus(
        [
          ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
          ev({ id: "a", kind: "assistant_message", text: "结论：可合", ts: 2 }),
          ev({
            id: "d",
            kind: "info",
            text: "已压缩上下文",
            ts: 4,
            meta: { kind: "compaction", status: "done" },
          }),
        ],
        undefined,
        { streaming: true },
      ),
    ).toEqual({ label: "正在回复…" });
  });

  describe("工具跑完等模型：点名上一个工具 + 带起点时间（原来只有一句「处理中…」）", () => {
    const user = ev({ id: "u", kind: "user_reply", text: "q", ts: 1 });
    const call = (id: string, callId: string, name: string, ts: number) =>
      ev({ id, kind: "tool_call", text: `调用 ${name}`, ts, meta: { callId, name, args: "{}" } });
    const result = (id: string, callId: string, name: string | undefined, ts: number) =>
      ev({
        id,
        kind: "tool_result",
        text: "完成",
        ts,
        meta: { callId, ...(name ? { name } : {}), status: "success" },
      });

    it("串行多个工具：点名最后一个、起点是它的结果落盘时刻（更早已配对的不干扰）", () => {
      const status = deriveActiveStatus([
        user,
        call("c1", "a", "grep", 2),
        result("r1", "a", "grep", 3),
        call("c2", "b", "read", 10),
        result("r2", "b", "read", 14),
      ]);
      expect(status).toEqual({ label: "正在分析 read 的结果", sinceTs: 14 });
    });

    it("tool_result 缺 name 时按 callId 回查 tool_call 的工具名", () => {
      const status = deriveActiveStatus([
        user,
        call("c1", "a", "shell", 2),
        result("r1", "a", undefined, 9),
      ]);
      expect(status).toEqual({ label: "正在分析 shell 的结果", sinceTs: 9 });
    });

    it("连工具名都没有 → 退回「处理中…」兜底，但仍带起点时间", () => {
      const status = deriveActiveStatus([
        user,
        ev({ id: "r1", kind: "tool_result", text: "完成", ts: 7, meta: { callId: "z" } }),
      ]);
      expect(status).toEqual({ label: PROCESSING_PLACEHOLDER_LABEL, sinceTs: 7 });
    });

    it("并行工具：还有 tool_call 没配上结果 → 状态行说那个还在跑的（V16-02：旧写法停在先回来的 read 的结果上、说「处理中…」）", () => {
      const status = deriveActiveStatus([
        user,
        call("c1", "a", "read", 2),
        call("c2", "b", "grep", 3),
        result("r1", "a", "read", 5),
      ]);
      // read 先回来、grep 还没回来：不能点 read（会误导），也不能说「处理中…」（它其实在执行 grep）
      expect(status).toMatchObject({ label: "正在执行 grep", sinceTs: 3 });
      expect(status).not.toHaveProperty("stallSinceTs");
    });

    it("工具名过长按 28 字截断（MCP 工具名可以很长，别把整行顶满）", () => {
      const longName = "mcp__some_server__" + "get_document_blocks_".repeat(4);
      const status = deriveActiveStatus([
        user,
        call("c1", "a", longName, 2),
        result("r1", "a", longName, 3),
      ]);
      expect(status?.label.startsWith("正在分析 ")).toBe(true);
      expect(status?.label.endsWith("… 的结果")).toBe(true);
      // 「正在分析 」+ 28 字 + 「…」+「 的结果」
      expect(status!.label.length).toBeLessThanOrEqual(5 + 28 + 1 + 4);
    });

    it("起点时间只给三类空窗：启动 / 思考 / 回复 / 压缩都不带（不重复计时）", () => {
      const noSince = (events: TaskEvent[], streaming = false) => {
        const s = deriveActiveStatus(events, undefined, { streaming });
        expect(s).not.toBeNull();
        expect(s).not.toHaveProperty("sinceTs");
      };
      noSince([user]);
      noSince([user, ev({ id: "t", kind: "thinking", text: "想", ts: 2 })]);
      noSince([user, ev({ id: "a", kind: "assistant_message", text: "答", ts: 2 })]);
      noSince(
        [
          user,
          ev({
            id: "c",
            kind: "info",
            text: "正在压缩上下文…",
            ts: 2,
            meta: { kind: "compaction", status: "running" },
          }),
        ],
        true,
      );
      // 正文已在流时，工具刚跑完改口「正在回复…」，同样不带
      noSince([user, call("c1", "a", "read", 2), result("r1", "a", "read", 3)], true);
    });

    it("事件 ts 是脏值（NaN / 缺省）→ 不带 sinceTs，状态行就不走字（不显示 NaNs）", () => {
      const status = deriveActiveStatus([
        user,
        call("c1", "a", "read", 2),
        { ...result("r1", "a", "read", 3), ts: Number.NaN },
      ]);
      expect(status).toEqual({ label: "正在分析 read 的结果" });
      expect(status).not.toHaveProperty("sinceTs");
    });

    it("文案出口只有 analyzingToolLabel 一个（改措辞不用满仓库找）", () => {
      expect(analyzingToolLabel("read")).toBe("正在分析 read 的结果");
    });
  });
});

describe("静默兜底：stallSinceTs（SDK 里不可见的等待，如 Cursor 原生 await 的 sleep）", () => {
  const user = ev({ id: "u", kind: "user_reply", text: "q", ts: 1 });
  const thinking = ev({ id: "t", kind: "thinking", text: "想", ts: 2 });
  const toolDone = [
    ev({
      id: "c",
      kind: "tool_call",
      text: "调用 shell",
      ts: 2,
      meta: { callId: "x", name: "shell", args: "{}" },
    }),
    ev({
      id: "r",
      kind: "tool_result",
      text: "完成",
      ts: 3,
      meta: { callId: "x", name: "shell", status: "success" },
    }),
  ];

  it("不传 lastActivityTs = 不兜底：返回值里根本没有 stallSinceTs 这个键（既有 toEqual 断言不受影响）", () => {
    for (const events of [[user, thinking], [user, ...toolDone]]) {
      expect(deriveActiveStatus(events)).not.toHaveProperty("stallSinceTs");
    }
  });

  it("空等类（思考刚结束 / 工具跑完等模型 / 回复刚结束）传了就带上锚，其余字段原样", () => {
    expect(deriveActiveStatus([user, thinking], undefined, { lastActivityTs: 2 })).toEqual({
      label: "思考中",
      stallSinceTs: 2,
    });
    expect(
      deriveActiveStatus([user, ...toolDone], undefined, { lastActivityTs: 3 }),
    ).toEqual({ label: "正在分析 shell 的结果", sinceTs: 3, stallSinceTs: 3 });
    expect(
      deriveActiveStatus(
        [user, ev({ id: "a", kind: "assistant_message", text: "答", ts: 2 })],
        undefined,
        { lastActivityTs: 2 },
      ),
    ).toEqual({ label: "正在回复…", stallSinceTs: 2 });
  });

  it("锚点取调用方给的「最后一条事件」，不是这一步自己的 ts（隐藏事件也是还在动的证据）", () => {
    // 状态由 ts=3 的 tool_result 决定，但全局最后一条事件在 ts=9
    expect(
      deriveActiveStatus([user, ...toolDone], undefined, { lastActivityTs: 9 }),
    ).toMatchObject({ sinceTs: 3, stallSinceTs: 9 });
  });

  it("没资格的一律不挂：工具在跑 / 子代理 / 压缩 / 正文在流 / 实时思考 / 启动阶段", () => {
    const opts = { lastActivityTs: 5 };
    // 工具在跑
    const running = ev({
      id: "c",
      kind: "tool_call",
      text: "调用 shell",
      ts: 2,
      meta: { callId: "x", name: "shell", args: "{}" },
    });
    expect(deriveActiveStatus([user, running], undefined, opts)).not.toHaveProperty(
      "stallSinceTs",
    );
    // 子代理
    const sub = ev({
      id: "s",
      kind: "tool_call",
      text: "调用 task",
      ts: 2,
      meta: { callId: "t1", name: "task", args: "{}" },
    });
    expect(deriveActiveStatus([user, sub], undefined, opts)).not.toHaveProperty(
      "stallSinceTs",
    );
    // 压缩进行中
    const compact = ev({
      id: "k",
      kind: "info",
      text: "正在压缩上下文…",
      ts: 2,
      meta: { kind: "compaction", status: "running" },
    });
    expect(deriveActiveStatus([user, compact], undefined, opts)).not.toHaveProperty(
      "stallSinceTs",
    );
    // 正文在流：delta 持续来，不算静默
    expect(
      deriveActiveStatus([user, thinking], undefined, { ...opts, streaming: true }),
    ).not.toHaveProperty("stallSinceTs");
    expect(
      deriveActiveStatus([user, ...toolDone], undefined, { ...opts, streaming: true }),
    ).not.toHaveProperty("stallSinceTs");
    // 实时思考：thinking-delta 持续来
    expect(
      deriveActiveStatus([user, ...toolDone], undefined, { ...opts, thinkingSince: 4 }),
    ).toEqual({ label: "思考中", sinceTs: 4 });
    // 启动阶段（yieldToTail）：PendingRow 在计时，不抢
    expect(deriveActiveStatus([user], undefined, opts)).toEqual({
      label: "正在启动…",
      yieldToTail: true,
    });
  });

  it("有未答提问（awaitingUser）：空等类也不挂锚——事件流静默是在等人答、不是卡住，不能改口「仍在等待」", () => {
    for (const events of [[user, thinking], [user, ...toolDone]]) {
      // 对照：同样的事件、没有未答提问时是挂锚的
      expect(
        deriveActiveStatus(events, undefined, { lastActivityTs: 5 }),
      ).toHaveProperty("stallSinceTs", 5);
      expect(
        deriveActiveStatus(events, undefined, { lastActivityTs: 5, awaitingUser: true }),
      ).not.toHaveProperty("stallSinceTs");
    }
    // awaitingUser: false 与不传等价
    expect(
      deriveActiveStatus([user, thinking], undefined, { lastActivityTs: 5, awaitingUser: false }),
    ).toHaveProperty("stallSinceTs", 5);
    // V16-01：文案也不能再说「正在分析 shell 的结果」——AI 是在等人答，不是在分析（见下方「等你回答」一节）
    expect(
      deriveActiveStatus([user, ...toolDone], undefined, { lastActivityTs: 5, awaitingUser: true }),
    ).toEqual({ label: AWAITING_ASK_LABEL });
  });

  it("脏值（0 / 负数 / NaN / Infinity）不挂锚：状态行不会拿一个无意义的起点去算「已等待」", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        deriveActiveStatus([user, thinking], undefined, { lastActivityTs: bad }),
      ).not.toHaveProperty("stallSinceTs");
    }
  });

  it("阈值 20s：差多久改口（msUntilStall）+ 改口后的状态（锚点同时当走字起点）", () => {
    expect(STATUS_STALL_AFTER_MS).toBe(20_000);
    expect(msUntilStall(1000, 1000)).toBe(20_000);
    expect(msUntilStall(1000, 11_000)).toBe(10_000);
    expect(msUntilStall(1000, 21_000)).toBe(0);
    // 过了点是负数：调用方据此「立刻改口」而不是排一个负延迟的定时器
    expect(msUntilStall(1000, 30_000)).toBeLessThan(0);
    expect(stallFallbackStatus(1000)).toEqual({
      label: STATUS_STALL_LABEL,
      detail: STATUS_STALL_DETAIL,
      sinceTs: 1000,
    });
    expect(STATUS_STALL_LABEL).toBe("仍在等待");
  });
});

describe("等你回答（V16-01）：AI 在等用户答题时，状态行不再说「正在分析 ask_user 的结果」逐秒走字", () => {
  const user = ev({ id: "u", kind: "user_reply", text: "q", ts: 1 });
  const askCall = ev({
    id: "c",
    kind: "tool_call",
    text: "调用 ask_user",
    ts: 2,
    meta: { callId: "ask1", name: "ask_user", args: "{}" },
  });
  const askRequest = ev({
    id: "ask",
    kind: "ask_user_request",
    text: "要选哪个？",
    ts: 3,
    meta: { askId: "a1", questions: [] },
  });
  // 真实复现：ask_user 的 tool_call / tool_result 都落了盘，回扫跳过 ask_* 后命中 tool_result
  const askResult = ev({
    id: "r",
    kind: "tool_result",
    text: "完成",
    ts: 4,
    meta: { callId: "ask1", name: "ask_user", status: "success" },
  });

  it("文案是「等你回答」、起点取提问事件的 ts（计时表达「等了多久」）；工具名不外露", () => {
    const events = [user, askCall, askRequest, askResult];
    // 修前：{ label: "正在分析 ask_user 的结果", sinceTs: 4 }
    expect(deriveActiveStatus(events)).toEqual({
      label: "正在分析 ask_user 的结果",
      sinceTs: 4,
    });
    const status = deriveActiveStatus(events, undefined, {
      lastActivityTs: 4,
      awaitingUser: true,
    });
    expect(status).toEqual({ label: AWAITING_ASK_LABEL, sinceTs: 3 });
    expect(AWAITING_ASK_LABEL).toBe("等你回答");
    expect(status?.label).not.toContain("ask_user");
  });

  it("不挂静默兜底锚（等人答不是卡住，不能二十秒后改口「仍在等待」）", () => {
    const status = deriveActiveStatus([user, askCall, askRequest, askResult], undefined, {
      lastActivityTs: 4,
      awaitingUser: true,
    });
    expect(status).not.toHaveProperty("stallSinceTs");
    expect(status).not.toHaveProperty("detail");
    expect(status).not.toHaveProperty("yieldToTail");
  });

  it("取最近一条提问的 ts（同一轮里问过多次时）", () => {
    const ask2 = ev({
      id: "ask2",
      kind: "ask_user_request",
      text: "再问一个",
      ts: 9,
      meta: { askId: "a2", questions: [] },
    });
    expect(
      deriveActiveStatus([user, askRequest, ask2], undefined, { awaitingUser: true }),
    ).toEqual({ label: AWAITING_ASK_LABEL, sinceTs: 9 });
  });

  it("提问事件不在切片里（调用方只传本轮切片）：仍说「等你回答」、只是不带计时", () => {
    expect(
      deriveActiveStatus([user, askResult], undefined, { awaitingUser: true }),
    ).toEqual({ label: AWAITING_ASK_LABEL });
  });

  it("提问事件 ts 是脏值 → 不带 sinceTs（不显示 NaNs）", () => {
    const status = deriveActiveStatus(
      [user, { ...askRequest, ts: Number.NaN }],
      undefined,
      { awaitingUser: true },
    );
    expect(status).toEqual({ label: AWAITING_ASK_LABEL });
  });

  it("盖过实时思考（thinkingSince）：等人答时模型没在思考，不能说「思考中」", () => {
    expect(
      deriveActiveStatus([user, askRequest], undefined, {
        awaitingUser: true,
        thinkingSince: 5,
      }),
    ).toEqual({ label: AWAITING_ASK_LABEL, sinceTs: 3 });
  });

  it("正文已在流（streaming）：照旧「正在回复…」——只有没在吐字时才说等你回答", () => {
    expect(
      deriveActiveStatus([user, askRequest, askResult], undefined, {
        awaitingUser: true,
        streaming: true,
      }),
    ).toEqual({ label: "正在回复…" });
  });

  it("没有未答提问：行为不变（awaitingUser 缺省 / false 等价）", () => {
    const events = [user, askCall, askRequest, askResult];
    const base = deriveActiveStatus(events);
    expect(deriveActiveStatus(events, undefined, { awaitingUser: false })).toEqual(base);
    expect(deriveActiveStatus(events, undefined, {})).toEqual(base);
  });

  it("空事件仍返回 null（即使 awaitingUser）", () => {
    expect(deriveActiveStatus([], undefined, { awaitingUser: true })).toBeNull();
  });
});

describe("并行工具 / 子代理（V16-02）：先回来的 tool_result 不能盖掉还在跑的 tool_call", () => {
  const user = ev({ id: "u", kind: "user_reply", text: "q", ts: 1 });
  const taskCall = (id: string, callId: string, ts: number, description = "排查") =>
    ev({
      id,
      kind: "tool_call",
      text: "调用 task",
      ts,
      meta: { callId, name: "task", args: JSON.stringify({ description, prompt: "x" }) },
    });
  const shellCall = (id: string, callId: string, ts: number) =>
    ev({
      id,
      kind: "tool_call",
      text: "调用 shell",
      ts,
      meta: { callId, name: "shell", args: JSON.stringify({ command: "pnpm test" }) },
    });
  const done = (id: string, callId: string, name: string, ts: number) =>
    ev({
      id,
      kind: "tool_result",
      text: "完成",
      ts,
      meta: { callId, name, status: "success" },
    });

  const T0 = 1_000_000;

  it("复现：两个并行子代理，一个 40s 完成后——剩下那个仍是「子代理工作中」，不挂静默兜底锚（不会 300s 时说「仍在等待 · 260s 暂无新输出」）", () => {
    const events = [
      user,
      taskCall("c1", "a", T0, "子代理 A"),
      taskCall("c2", "b", T0 + 1000, "子代理 B"),
      done("r1", "a", "task", T0 + 40_000),
    ];
    // 修前：{ label: "处理中…", sinceTs: T0+40000, stallSinceTs: T0+40000 }
    const status = deriveActiveStatus(events, undefined, {
      lastActivityTs: T0 + 40_000,
    });
    expect(status).toEqual({
      label: "子代理工作中",
      detail: "子代理 B",
      sinceTs: T0 + 1000,
    });
    expect(status).not.toHaveProperty("stallSinceTs");
  });

  it("对照单个子代理：同样的结构（只剩一个在跑）与「单个子代理在跑」的状态完全一致", () => {
    const parallel = deriveActiveStatus(
      [user, taskCall("c1", "a", T0), taskCall("c2", "b", T0 + 1000), done("r1", "a", "task", T0 + 40_000)],
      undefined,
      { lastActivityTs: T0 + 40_000 },
    );
    const single = deriveActiveStatus([user, taskCall("c2", "b", T0 + 1000)], undefined, {
      lastActivityTs: T0 + 40_000,
    });
    expect(parallel).toEqual(single);
  });

  it("多个还在跑：「N 个子代理工作中」+ 最久的起点（不是最新那个的）、不带 detail", () => {
    const status = deriveActiveStatus(
      [user, taskCall("c1", "a", T0 + 5000), taskCall("c2", "b", T0), taskCall("c3", "c", T0 + 9000)],
      undefined,
      { lastActivityTs: T0 + 9000 },
    );
    expect(status).toEqual({ label: "3 个子代理工作中", sinceTs: T0 });
    expect(status).not.toHaveProperty("stallSinceTs");
  });

  it("多个还在跑、其中一个已先回来 → 数的是「还没回来的」", () => {
    const status = deriveActiveStatus([
      user,
      taskCall("c1", "a", T0),
      taskCall("c2", "b", T0 + 1000),
      taskCall("c3", "c", T0 + 2000),
      done("r1", "b", "task", T0 + 3000),
    ]);
    // a / c 还在跑；最久的是 a（T0）
    expect(status).toEqual({ label: "2 个子代理工作中", sinceTs: T0 });
  });

  it("并行的不全是子代理（shell + 子代理）：不说「子代理」，按「工具并行执行」计数", () => {
    const status = deriveActiveStatus([
      user,
      shellCall("c1", "a", T0),
      taskCall("c2", "b", T0 + 1000),
    ]);
    expect(status).toEqual({ label: "2 个工具并行执行中", sinceTs: T0 });
  });

  it("并行 shell：先回来的结果在尾部时，说还在跑的那条 shell（带它的摘要），不是「处理中…」", () => {
    const status = deriveActiveStatus([
      user,
      shellCall("c1", "a", T0),
      shellCall("c2", "b", T0 + 1000),
      done("r1", "a", "shell", T0 + 2000),
    ]);
    expect(status).toMatchObject({ label: "正在执行 shell", sinceTs: T0 + 1000 });
    expect(status?.detail).toMatch(/pnpm test/);
  });

  it("全部回来之后才是「正在分析 X 的结果」（起点是最后落盘的那条结果）", () => {
    const status = deriveActiveStatus([
      user,
      taskCall("c1", "a", T0),
      taskCall("c2", "b", T0 + 1000),
      done("r1", "a", "task", T0 + 40_000),
      done("r2", "b", "task", T0 + 50_000),
    ]);
    expect(status).toEqual({ label: "正在分析 task 的结果", sinceTs: T0 + 50_000 });
  });

  it("正文已在流：照旧「正在回复…」（还有没回来的工具也一样，吐字是更强的活动证据）", () => {
    const status = deriveActiveStatus(
      [user, taskCall("c1", "a", T0), taskCall("c2", "b", T0 + 1000), done("r1", "a", "task", T0 + 2000)],
      undefined,
      { streaming: true },
    );
    expect(status).toEqual({ label: "正在回复…" });
  });

  it("还在跑的是 wait：保留「等待中 + 可跳过」（单个时沿用原有的状态构造）", () => {
    const status = deriveActiveStatus([
      user,
      ev({
        id: "w",
        kind: "tool_call",
        text: "调用 wait",
        ts: T0,
        meta: { callId: "w1", name: "wait", args: JSON.stringify({ seconds: 60, reason: "等 CI" }) },
      }),
      shellCall("c2", "b", T0 + 1000),
      done("r1", "b", "shell", T0 + 2000),
    ]);
    expect(status).toMatchObject({ label: "等待中", skippable: true, sinceTs: T0 });
  });

  it("思考实时态不盖「还在跑的工具」（有更具体的信息）", () => {
    const status = deriveActiveStatus(
      [user, taskCall("c1", "a", T0), taskCall("c2", "b", T0 + 1000), done("r1", "a", "task", T0 + 2000)],
      undefined,
      { thinkingSince: T0 + 3000 },
    );
    expect(status?.label).toBe("子代理工作中");
  });

  it("串行不受影响：上一个工具跑完、下一个还没开始 → 仍是「正在分析 X 的结果」", () => {
    expect(
      deriveActiveStatus([user, shellCall("c1", "a", T0), done("r1", "a", "shell", T0 + 5000)]),
    ).toEqual({ label: "正在分析 shell 的结果", sinceTs: T0 + 5000 });
  });
});

describe("latestEventTs：静默兜底的锚", () => {
  it("空列表是 0", () => {
    expect(latestEventTs([])).toBe(0);
  });

  it("取末条（新事件 append 在尾、上拉历史在头）", () => {
    expect(latestEventTs([{ ts: 10 }, { ts: 20 }, { ts: 50 }])).toBe(50);
  });
});

describe("formatStatusElapsed：状态行走字秒数", () => {
  it("不到门槛（3s）一律不显示：瞬时工具别闪数字", () => {
    expect(STATUS_ELAPSED_SHOW_AFTER_MS).toBe(3000);
    expect(formatStatusElapsed(0)).toBeNull();
    expect(formatStatusElapsed(1000)).toBeNull();
    expect(formatStatusElapsed(2999)).toBeNull();
  });

  it("够门槛后按秒级口径：3s / 12s / 59s / 1m0s / 2m14s", () => {
    expect(formatStatusElapsed(3000)).toBe("3s");
    expect(formatStatusElapsed(12_000)).toBe("12s");
    expect(formatStatusElapsed(59_000)).toBe("59s");
    expect(formatStatusElapsed(60_000)).toBe("1m0s");
    expect(formatStatusElapsed(134_000)).toBe("2m14s");
  });

  it("脏值（NaN）不显示", () => {
    expect(formatStatusElapsed(Number.NaN)).toBeNull();
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

  it("输入框上方的状态行已经画出来 → 组尾让位（同一句「处理中」不上下各说一遍）", () => {
    expect(
      shouldShowProcessingPlaceholder({ ...on, statusLineVisible: true }),
    ).toBe(false);
  });

  it("没有状态行（task 形态 / 隐藏输入区）→ 组尾仍兜底；缺省按没有状态行算", () => {
    expect(
      shouldShowProcessingPlaceholder({ ...on, statusLineVisible: false }),
    ).toBe(true);
    expect(shouldShowProcessingPlaceholder(on)).toBe(true);
  });
});
