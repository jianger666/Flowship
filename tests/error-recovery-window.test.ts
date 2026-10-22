/**
 * 300 条窗口一致性 · 错误卡恢复入口（第三轮 review D8-02）
 *
 * 事实：task 页首屏与 watch-task bootstrap 只带最近 300 条事件。长 run（>150 对工具调用）崩了，
 * 重开页面后触发源（action_start / user_reply）在窗口外，`resolveErrorRecovery` 回扫到数组头仍找不到触发源
 * → none，红卡只剩「复制错误」。
 *
 * 修法（与服务端「窗口补到含最近一条 user_reply / action_start」互补，服务端补不到时兜底）：
 * 调用方告诉它「事件列表被截断过（task.eventsTruncated）」+ 形态——
 *   - task 形态回扫到头仍没触发源 → `readvance`：重新推进是用户确认的弹窗，不会替用户重放任何消息；
 *   - chat 形态 → 仍然 none：触发源可能是用户消息、定时样板、后台唤醒，猜错 = 重放旧话，宁可不给入口；
 *   - 没截断（完整窗口）找不到触发源仍是 none（老行为，见 error-card-recovery.test.ts）。
 */
import { describe, expect, it } from "vitest";

import { resolveErrorRecovery } from "../src/lib/chat-turns";
import type { TaskEvent } from "../src/lib/types";

let seq = 0;
const ev = (p: Partial<TaskEvent> & Pick<TaskEvent, "kind">): TaskEvent => {
  seq += 1;
  return { id: p.id ?? `e${seq}`, text: "", ts: seq, ...p };
};

const toolPairs = (n: number): TaskEvent[] => {
  const out: TaskEvent[] = [];
  for (let i = 0; i < n; i++) {
    const callId = `k${seq}`;
    out.push(ev({ kind: "tool_call", meta: { callId, name: "read" } }));
    out.push(ev({ kind: "tool_result", meta: { callId, name: "read" } }));
  }
  return out;
};

/** D8-02 复现：user_reply + action_start(build) + 200 对 read + error，共 403 条 */
const longRunCrash = (): TaskEvent[] => [
  ev({ id: "u1", kind: "user_reply", text: "先出方案" }),
  ev({ id: "as", kind: "action_start", text: "开始 build" }),
  ...toolPairs(200),
  ev({ id: "err", kind: "error", text: "Agent 运行失败：429 rate limited" }),
];

describe("D8-02：长 run 崩了、触发源在窗口外", () => {
  it("复现：全量 readvance；只剩最近 300 条且不告知截断 → none（老行为，红卡没出口）", () => {
    const all = longRunCrash();
    expect(resolveErrorRecovery(all, "err").kind).toBe("readvance");
    const tail = all.slice(-300);
    expect(tail[0]!.kind).toBe("tool_result"); // 触发源确实在窗口外
    expect(resolveErrorRecovery(tail, "err").kind).toBe("none");
  });

  it("task 形态 + 告知截断：回扫到头没触发源 → 重新推进", () => {
    const tail = longRunCrash().slice(-300);
    expect(
      resolveErrorRecovery(tail, "err", { truncated: true, mode: "task" }).kind,
    ).toBe("readvance");
  });

  it("chat 形态 + 告知截断：仍然 none（触发源可能是定时 / 后台唤醒，猜错就是重放旧话）", () => {
    const tail = longRunCrash().slice(-300);
    expect(
      resolveErrorRecovery(tail, "err", { truncated: true, mode: "chat" }).kind,
    ).toBe("none");
    // 不传形态 = 保守口径（同 chat）
    expect(resolveErrorRecovery(tail, "err", { truncated: true }).kind).toBe("none");
  });

  it("完整窗口（没截断）找不到触发源：仍 none，不因为 mode=task 就乱给入口", () => {
    expect(
      resolveErrorRecovery([ev({ id: "e", kind: "error", text: "炸" })], "e", {
        truncated: false,
        mode: "task",
      }).kind,
    ).toBe("none");
  });

  it("窗口里找得到触发源时，截断标记不改变判定（用户消息仍是 retry）", () => {
    const events = [
      ev({ id: "x", kind: "tool_result" }),
      ev({ id: "u", kind: "user_reply", text: "改一下" }),
      ...toolPairs(3),
      ev({ id: "err", kind: "error", text: "炸" }),
    ];
    const r = resolveErrorRecovery(events, "err", { truncated: true, mode: "task" });
    expect(r.kind === "retry" && r.source.id).toBe("u");
  });

  it("窗口里先撞到的是非「重试 / 重新推进」类触发源（答题回执 / 后台唤醒 / 定时）：照旧 none，不被降级兜底覆盖", () => {
    const base = [ev({ kind: "tool_result" }), ...toolPairs(2)];
    const askReply = [
      ...base,
      ev({ kind: "ask_user_reply", text: "答：A", meta: { askId: "a1" } }),
      ev({ id: "err", kind: "error", text: "炸" }),
    ];
    expect(
      resolveErrorRecovery(askReply, "err", { truncated: true, mode: "task" }).kind,
    ).toBe("none");
    const schedule = [
      ...base,
      ev({
        kind: "user_reply",
        text: "[SCHEDULE_FIRED id=s1] 到点了",
        meta: { source: "schedule" },
      }),
      ev({ id: "err", kind: "error", text: "炸" }),
    ];
    expect(
      resolveErrorRecovery(schedule, "err", { truncated: true, mode: "task" }).kind,
    ).toBe("none");
  });

  it("对主流不可见的群问答 user_reply 不是触发源：窗口里只有它时按「没找到」处理（task 降级 readvance）", () => {
    const events = [
      ev({ kind: "tool_result" }),
      ev({
        kind: "user_reply",
        text: "[群消息·来自 张三]\n问个事",
        meta: { source: "feishu_group", restrictedRunTag: "rt1" },
      }),
      ev({ id: "err", kind: "error", text: "炸" }),
    ];
    expect(
      resolveErrorRecovery(events, "err", { truncated: true, mode: "task" }).kind,
    ).toBe("readvance");
  });

  it("历史遗留的 MR 冲突 error（meta.mrUrl）与回合内工具失败：降级兜底也不给入口 / 不挡当轮错误", () => {
    const mr = [
      ev({ kind: "tool_result" }),
      ev({ id: "err", kind: "error", text: "冲突", meta: { mrUrl: "https://x/-/merge_requests/1" } }),
    ];
    expect(
      resolveErrorRecovery(mr, "err", { truncated: true, mode: "task" }).kind,
    ).toBe("none");
    const toolErr = ev({ id: "te", kind: "error", text: "grep 挂了", meta: { callId: "c1", name: "grep" } });
    const events = [ev({ kind: "tool_result" }), toolErr, ev({ id: "err", kind: "error", text: "炸" })];
    expect(
      resolveErrorRecovery(events, "te", { truncated: true, mode: "task" }).kind,
    ).toBe("none");
    expect(
      resolveErrorRecovery(events, "err", { truncated: true, mode: "task" }).kind,
    ).toBe("readvance");
  });

  it("历史错误（之后有新 user_reply）即使截断也不给入口", () => {
    const events = [
      ev({ kind: "tool_result" }),
      ev({ id: "err", kind: "error", text: "炸" }),
      ev({ kind: "user_reply", text: "继续" }),
    ];
    expect(
      resolveErrorRecovery(events, "err", { truncated: true, mode: "task" }).kind,
    ).toBe("none");
  });
});
