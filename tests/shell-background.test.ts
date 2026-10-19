/**
 * 后台 shell 标记的纯函数（src/lib/shell-background.ts + tool-display 的 markBackgroundRunningTools）
 *
 * 背景：shell 超时 / 被要求后台跑时，SDK 照样回 success + exit 0，事件流上这块工具「已完成」、
 * 图标亮绿色终端，可进程还在跑（AI 随后调 wait 等它）。服务端落 running / ended 标记事件，
 * 渲染层据此在会话 running 时给这块 shell 标 backgroundRunning、图标转圈。
 *
 * 这里钉：标记的构造 / 解析、「每个 callId 取最后一条」的口径、标记不渲染、以及打标不误伤别的块。
 */
import { describe, expect, it } from "vitest";

import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import {
  buildShellBackgroundEvent,
  collectRunningBackgroundCallIds,
  collectRunningBackgroundShells,
  isShellBackgroundMarkerEvent,
  SHELL_BACKGROUND_ENDED_TEXT,
  SHELL_BACKGROUND_META_KEY,
  SHELL_BACKGROUND_RUNNING_TEXT,
  shellBackgroundOf,
} from "@/lib/shell-background";
import {
  coerceStaleRunningTools,
  isToolBlock,
  isToolVerbGroup,
  markBackgroundRunningTools,
  mergeToolDisplayEvents,
  type StreamRenderItem,
  type ToolBlock,
} from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";

let seq = 0;
const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "kind" | "text">,
): TaskEvent => ({
  id: `e${++seq}`,
  ts: 1000 + seq,
  ...partial,
});

const marker = (
  callId: string,
  phase: "running" | "ended",
  extra: Record<string, unknown> = {},
  eventMeta: Record<string, unknown> = {},
): TaskEvent => {
  const built = buildShellBackgroundEvent({
    callId,
    phase,
    ...(phase === "ended" ? { reason: "exited" as const } : {}),
    ...extra,
  });
  return ev({
    kind: built.kind,
    text: built.text,
    meta: { ...built.meta, ...eventMeta },
  });
};

const shellCall = (callId: string): TaskEvent =>
  ev({
    kind: "tool_call",
    text: "调用 shell",
    meta: { callId, name: "shell", args: '{"command":"sleep 60"}' },
  });

const shellResult = (callId: string): TaskEvent =>
  ev({
    kind: "tool_result",
    text: "工具完成 shell",
    meta: {
      callId,
      name: "shell",
      status: "success",
      output: "",
      exitCode: 0,
      executionTime: 231,
    },
  });

const blockOf = (items: StreamRenderItem[], callId: string): ToolBlock => {
  for (const it of items) {
    if (isToolBlock(it) && it.callId === callId) return it;
    if (isToolVerbGroup(it)) {
      const m = it.members.find((x) => x.callId === callId);
      if (m) return m;
    }
  }
  throw new Error(`block ${callId} not found`);
};

describe("标记事件的构造与解析", () => {
  it("running：kind=info、meta.shellBackground 带 callId/phase/pid，文案区分运行中", () => {
    const built = buildShellBackgroundEvent({
      callId: "c1",
      phase: "running",
      pid: 4242,
    });
    expect(built.kind).toBe("info");
    expect(built.text).toBe(SHELL_BACKGROUND_RUNNING_TEXT);
    expect(built.meta).toEqual({
      [SHELL_BACKGROUND_META_KEY]: { callId: "c1", phase: "running", pid: 4242 },
    });
  });

  it("ended：带 reason，文案是已结束", () => {
    const built = buildShellBackgroundEvent({
      callId: "c1",
      phase: "ended",
      reason: "run-ended",
    });
    expect(built.text).toBe(SHELL_BACKGROUND_ENDED_TEXT);
    expect(shellBackgroundOf({ kind: built.kind, meta: built.meta })).toEqual({
      callId: "c1",
      phase: "ended",
      reason: "run-ended",
    });
  });

  it("解析：往返一致；pid 非数字 / reason 非法被丢掉而不是带进去", () => {
    expect(
      shellBackgroundOf({
        kind: "info",
        meta: {
          shellBackground: { callId: "c", phase: "running", pid: "12", reason: "weird" },
        },
      }),
    ).toEqual({ callId: "c", phase: "running" });
  });

  it("不是标记 → null：kind 不是 info / 缺 callId / phase 非法 / meta 形态不对", () => {
    const good = { callId: "c", phase: "running" };
    expect(shellBackgroundOf({ kind: "tool_result", meta: { shellBackground: good } })).toBeNull();
    expect(shellBackgroundOf({ kind: "info", meta: { shellBackground: { phase: "running" } } })).toBeNull();
    expect(shellBackgroundOf({ kind: "info", meta: { shellBackground: { callId: "", phase: "running" } } })).toBeNull();
    expect(shellBackgroundOf({ kind: "info", meta: { shellBackground: { callId: "c", phase: "paused" } } })).toBeNull();
    expect(shellBackgroundOf({ kind: "info", meta: { shellBackground: "running" } })).toBeNull();
    expect(shellBackgroundOf({ kind: "info", meta: { shellBackground: null } })).toBeNull();
    expect(shellBackgroundOf({ kind: "info" })).toBeNull();
    expect(isShellBackgroundMarkerEvent(ev({ kind: "info", text: "普通 info" }))).toBe(false);
  });
});

describe("标记不渲染（只滤显示、不滤落盘）", () => {
  it("running / ended 标记都被事件流藏起来，普通 info 不受影响", () => {
    expect(isHiddenFromEventStream(marker("c1", "running"))).toBe(true);
    expect(isHiddenFromEventStream(marker("c1", "ended"))).toBe(true);
    expect(isHiddenFromEventStream(ev({ kind: "info", text: "依赖目录已后台克隆完成" }))).toBe(false);
  });

  it("chat 形态同样藏（不依赖 isChat）", () => {
    expect(isHiddenFromEventStream(marker("c1", "running"), { isChat: true })).toBe(true);
  });

  it("旁路 run 打了 groupRun 的标记照旧被藏（属主主流看不到）", () => {
    expect(
      isHiddenFromEventStream(marker("c1", "running", {}, { groupRun: "grp_1" })),
    ).toBe(true);
  });
});

describe("collectRunningBackgroundShells：每个 callId 取最后一条标记", () => {
  it("只有 running → 在跑", () => {
    expect(collectRunningBackgroundShells([marker("c1", "running")])).toEqual([
      { callId: "c1" },
    ]);
  });

  it("running 之后有 ended → 不在跑（exited / run-ended 都算）", () => {
    expect(
      collectRunningBackgroundShells([marker("c1", "running"), marker("c1", "ended")]),
    ).toEqual([]);
    const runEnded = ev({
      ...buildShellBackgroundEvent({ callId: "c2", phase: "ended", reason: "run-ended" }),
    });
    expect(
      collectRunningBackgroundShells([marker("c2", "running"), runEnded]),
    ).toEqual([]);
  });

  it("多个 callId 互不影响：一个结束、一个还在跑", () => {
    const out = collectRunningBackgroundShells([
      marker("a", "running"),
      marker("b", "running"),
      marker("a", "ended"),
    ]);
    expect(out.map((s) => s.callId)).toEqual(["b"]);
  });

  it("按落盘顺序：ended 在前、running 在后 → 以最后一条为准（在跑）", () => {
    expect(
      collectRunningBackgroundShells([marker("c1", "ended"), marker("c1", "running")]).map(
        (s) => s.callId,
      ),
    ).toEqual(["c1"]);
  });

  it("带出 groupRun（收尾补写 ended 要用同一个身份）；属主自己的没有", () => {
    const out = collectRunningBackgroundShells([
      marker("side", "running", {}, { groupRun: " grp_9 " }),
      marker("own", "running"),
    ]);
    expect(out).toEqual([{ callId: "side", groupRun: "grp_9" }, { callId: "own" }]);
  });

  it("无关事件（普通 info / tool_result）不被误认；集合版与列表版口径一致", () => {
    const events = [
      ev({ kind: "info", text: "x" }),
      shellCall("c1"),
      shellResult("c1"),
      marker("c1", "running"),
    ];
    expect([...collectRunningBackgroundCallIds(events)]).toEqual(["c1"]);
    expect(collectRunningBackgroundCallIds([]).size).toBe(0);
  });
});

describe("markBackgroundRunningTools：给后台 shell 块打 backgroundRunning", () => {
  const build = (events: TaskEvent[]): StreamRenderItem[] =>
    mergeToolDisplayEvents(events.filter((e) => !isHiddenFromEventStream(e)));

  it("真实形态：shell 已 success（绿勾的来源）+ running 标记 → backgroundRunning，status 仍是 success", () => {
    const events = [shellCall("c1"), shellResult("c1"), marker("c1", "running")];
    const items = build(events);
    // 前提自检：标记自己不产生渲染块，shell 块已完成
    expect(items).toHaveLength(1);
    expect(blockOf(items, "c1").status).toBe("success");
    expect(blockOf(items, "c1").backgroundRunning).toBeUndefined();

    const marked = markBackgroundRunningTools(items, collectRunningBackgroundCallIds(events));
    expect(blockOf(marked, "c1").backgroundRunning).toBe(true);
    expect(blockOf(marked, "c1").status).toBe("success");
  });

  it("进程退出（ended 标记）后不再转圈", () => {
    const events = [
      shellCall("c1"),
      shellResult("c1"),
      marker("c1", "running"),
      marker("c1", "ended"),
    ];
    const items = build(events);
    const marked = markBackgroundRunningTools(items, collectRunningBackgroundCallIds(events));
    expect(blockOf(marked, "c1").backgroundRunning).toBeUndefined();
    expect(marked).toBe(items);
  });

  it("没有命中：返回原数组、块对象引用不变（下游 memo 不被击穿）", () => {
    const items = build([shellCall("c1"), shellResult("c1")]);
    expect(markBackgroundRunningTools(items, new Set())).toBe(items);
    expect(markBackgroundRunningTools(items, new Set(["other"]))).toBe(items);
  });

  it("命中的块换新对象，没命中的块保持原对象", () => {
    const items = build([
      shellCall("c1"),
      shellResult("c1"),
      shellCall("c2"),
      shellResult("c2"),
    ]);
    const marked = markBackgroundRunningTools(items, new Set(["c2"]));
    expect(blockOf(marked, "c1")).toBe(blockOf(items, "c1"));
    expect(blockOf(marked, "c2")).not.toBe(blockOf(items, "c2"));
    expect(blockOf(marked, "c2").backgroundRunning).toBe(true);
  });

  it("只认 shell：别的工具撞了同一个 callId 也不转圈", () => {
    const items = build([
      ev({ kind: "tool_call", text: "调用 read", meta: { callId: "c1", name: "read" } }),
      ev({
        kind: "tool_result",
        text: "工具完成 read",
        meta: { callId: "c1", name: "read", status: "success", output: "x" },
      }),
    ]);
    expect(markBackgroundRunningTools(items, new Set(["c1"]))).toBe(items);
  });

  it("error / interrupted 的 shell 块不打标：红叉 / 中断标不能被盖成转圈（与子代理卡同口径：只认 success）", () => {
    const err = build([
      shellCall("c1"),
      ev({
        kind: "tool_result",
        text: "工具失败 shell",
        meta: { callId: "c1", name: "shell", status: "error", output: "boom" },
      }),
    ]);
    expect(blockOf(err, "c1").status).toBe("error");
    expect(markBackgroundRunningTools(err, new Set(["c1"]))).toBe(err);
    // 被 coerceStaleRunningTools 补成 interrupted 的同理
    const interrupted = build([shellCall("c2")]).map((it) => ({ ...it, status: "interrupted" as const })) as StreamRenderItem[];
    expect(markBackgroundRunningTools(interrupted, new Set(["c2"]))).toBe(interrupted);
  });

  it("仍在 running 的 shell 块不重复处理（本来就转圈）", () => {
    const items = build([shellCall("c1")]);
    expect(blockOf(items, "c1").status).toBe("running");
    expect(markBackgroundRunningTools(items, new Set(["c1"]))).toBe(items);
  });

  it("已打过标的块幂等：再打一次不产生新对象", () => {
    const items = build([shellCall("c1"), shellResult("c1")]);
    const once = markBackgroundRunningTools(items, new Set(["c1"]));
    expect(markBackgroundRunningTools(once, new Set(["c1"]))).toBe(once);
  });

  it("verb-group 成员里的 shell 块也能打（组对象跟着换、其余成员不动）", () => {
    const a = blockOf(build([shellCall("a"), shellResult("a")]), "a");
    const b = blockOf(build([shellCall("b"), shellResult("b")]), "b");
    const group: StreamRenderItem = {
      kind: "__tool_verb_group__",
      id: "verb_a",
      members: [a, b],
      ts: b.ts,
    };
    const out = markBackgroundRunningTools([group], new Set(["b"]));
    const g = out[0];
    expect(isToolVerbGroup(g)).toBe(true);
    if (!isToolVerbGroup(g)) return;
    expect(g.members[0]).toBe(a);
    expect(g.members[1].backgroundRunning).toBe(true);
  });

  it("与 coerceStaleRunningTools 正交：会话停了（调用方不打标）→ 不转圈，也不被改判已中断", () => {
    const events = [shellCall("c1"), shellResult("c1"), marker("c1", "running")];
    const items = build(events);
    const coerced = coerceStaleRunningTools(items);
    // success 的块不是 running，coerce 不动它；这里不打标 = 图标回到完成态
    expect(blockOf(coerced, "c1").status).toBe("success");
    expect(blockOf(coerced, "c1").backgroundRunning).toBeUndefined();
  });
});
