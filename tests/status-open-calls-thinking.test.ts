/**
 * 第三轮 review R3-04：V16-02 同根残留——并行工具 / 子代理还在跑时，尾部落了一条 thinking / 正文，
 * 状态行就说「仍在等待 · 38s 暂无新输出」
 *
 * 事实（R3 probe6 X1/X2/X3/X4）：openCalls（没配上 tool_result 的 tool_call）只在回扫命中
 * tool_call / tool_result 时才被看；命中落盘 thinking / assistant_message 就直接返回「空等」类
 * （idle），随后外层给它挂静默兜底锚 stallSinceTs，30s 后状态行改口「仍在等待 · N 秒暂无新输出」——
 * 而 c1 明明还在跑（子代理 / 长 shell）。
 *
 * 修法：这两个分支在「正文没在流」且「还有没回来的工具」时，返回 openCallsStatus（busy：不挂兜底锚、
 * 不被实时思考盖）。正文在流（streaming）仍是「正在回复…」——那是真的在出字。
 * error 分支不动（报告也判「不必」）。
 *
 * 状态行是否会说「仍在等待」只取决于返回值有没有 stallSinceTs：这里直接断言它。
 */
import { describe, expect, it } from "vitest";

import { deriveActiveStatus } from "../src/lib/chat-turns";
import type { TaskEvent } from "../src/lib/types";

const T0 = 1_000_000;
let seq = 0;
const ev = (p: Partial<TaskEvent> & Pick<TaskEvent, "kind" | "ts">): TaskEvent => {
  seq += 1;
  return { id: p.id ?? `e${seq}`, text: "", ...p };
};
const call = (ts: number, name: string, callId: string, args = "{}"): TaskEvent =>
  ev({ kind: "tool_call", ts, text: `调用 ${name}`, meta: { callId, name, args } });
const result = (ts: number, name: string, callId: string): TaskEvent =>
  ev({ kind: "tool_result", ts, text: "完成", meta: { callId, name, status: "success" } });

const SUB_ARGS = JSON.stringify({ description: "查日志", prompt: "p" });

/** 与 event-stream 一致：lastActivityTs = 整个任务最后一条事件的 ts */
const statusOf = (events: TaskEvent[], opts?: { streaming?: boolean }) =>
  deriveActiveStatus(events, undefined, {
    ...opts,
    lastActivityTs: events[events.length - 1]!.ts,
  });

describe("R3-04：还有工具在跑时，尾部的落盘 thinking / 正文不盖掉它们", () => {
  it("X1：子代理 c1 在跑，期间落一条 thinking → 「子代理工作中」，不挂静默兜底锚", () => {
    const s = statusOf([
      ev({ kind: "user_reply", ts: T0 }),
      call(T0 + 1000, "task", "c1", SUB_ARGS),
      ev({ kind: "thinking", ts: T0 + 2000 }),
    ]);
    expect(s).toMatchObject({ label: "子代理工作中", sinceTs: T0 + 1000 });
    expect(s?.stallSinceTs).toBeUndefined();
  });

  it("X2：子代理 c1 在跑，期间落一条 assistant_message → 同样「子代理工作中」", () => {
    const s = statusOf([
      ev({ kind: "user_reply", ts: T0 }),
      call(T0 + 1000, "task", "c1", SUB_ARGS),
      ev({ kind: "assistant_message", ts: T0 + 2000, text: "已派出子代理" }),
    ]);
    expect(s).toMatchObject({ label: "子代理工作中", sinceTs: T0 + 1000 });
    expect(s?.stallSinceTs).toBeUndefined();
  });

  it("X3：两个并行 shell，c2 先回来、c1 还在跑，之后落 thinking → 说还在跑的 c1（「正在执行 shell」）", () => {
    const s = statusOf([
      ev({ kind: "user_reply", ts: T0 }),
      call(T0 + 1000, "shell", "c1", JSON.stringify({ command: "pnpm build" })),
      call(T0 + 1001, "shell", "c2"),
      result(T0 + 2000, "shell", "c2"),
      ev({ kind: "thinking", ts: T0 + 2500 }),
    ]);
    expect(s).toMatchObject({ label: "正在执行 shell", sinceTs: T0 + 1000 });
    expect(s?.stallSinceTs).toBeUndefined();
  });

  it("X4：task 形态（以 action_start 起头）同 X3", () => {
    const s = statusOf([
      ev({ kind: "action_start", ts: T0, text: "开始" }),
      call(T0 + 1000, "shell", "c1"),
      call(T0 + 1001, "shell", "c2"),
      result(T0 + 2000, "shell", "c2"),
      ev({ kind: "thinking", ts: T0 + 2500 }),
    ]);
    expect(s?.label).toBe("正在执行 shell");
    expect(s?.stallSinceTs).toBeUndefined();
  });

  it("还有多个没回来：合并成一句（与 waitingAfterTools 同口径）", () => {
    const s = statusOf([
      ev({ kind: "user_reply", ts: T0 }),
      call(T0 + 1000, "task", "c1", SUB_ARGS),
      call(T0 + 1001, "task", "c2", SUB_ARGS),
      ev({ kind: "thinking", ts: T0 + 2000 }),
    ]);
    expect(s).toMatchObject({ label: "2 个子代理工作中", sinceTs: T0 + 1000 });
  });

  it("正文已经在流（streaming）：仍是「正在回复…」——那是真在出字，不被工具盖掉", () => {
    for (const kind of ["thinking", "assistant_message"] as const) {
      const s = statusOf(
        [
          ev({ kind: "user_reply", ts: T0 }),
          call(T0 + 1000, "task", "c1", SUB_ARGS),
          ev({ kind, ts: T0 + 2000 }),
        ],
        { streaming: true },
      );
      expect(s?.label).toBe("正在回复…");
    }
  });
});

describe("R3-04：没有未回来的工具时，老行为不变", () => {
  it("落盘 thinking 在尾（工具都回来了）→ 「思考中」，且带静默兜底锚", () => {
    const s = statusOf([
      ev({ kind: "user_reply", ts: T0 }),
      call(T0 + 1000, "shell", "c1"),
      result(T0 + 2000, "shell", "c1"),
      ev({ kind: "thinking", ts: T0 + 2500 }),
    ]);
    expect(s?.label).toBe("思考中");
    expect(s?.stallSinceTs).toBeDefined();
  });

  it("落盘 assistant_message 在尾（没有未回来的工具）→ 「正在回复…」", () => {
    const s = statusOf([
      ev({ kind: "user_reply", ts: T0 }),
      ev({ kind: "assistant_message", ts: T0 + 1000, text: "好" }),
    ]);
    expect(s?.label).toBe("正在回复…");
  });

  it("error 分支不动：wait 在跑被 error 盖住 → 仍按空等处理（对照：这是「兜底锚」应当出现的形状）", () => {
    const s = statusOf([
      ev({ kind: "user_reply", ts: T0 }),
      call(T0 + 1000, "wait", "c1", JSON.stringify({ seconds: 60 })),
      ev({ kind: "error", ts: T0 + 2000, text: "boom" }),
    ]);
    expect(s?.label).toBe("正在回复…");
    expect(s?.stallSinceTs).toBeDefined();
  });

  it("工具先回来、后续 thinking 之前没有任何未回来的 → 不被误当 open（c1 已有结果）", () => {
    const s = statusOf([
      ev({ kind: "user_reply", ts: T0 }),
      call(T0 + 1000, "task", "c1", SUB_ARGS),
      result(T0 + 1500, "task", "c1"),
      ev({ kind: "thinking", ts: T0 + 2000 }),
    ]);
    expect(s?.label).toBe("思考中");
  });
});
