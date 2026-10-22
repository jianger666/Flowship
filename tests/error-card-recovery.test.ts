/**
 * 错误卡「恢复入口」资格统一（第二轮 review：F4-01 / V3-02 / V3-04 / V9-01 / V12-03，同一根因）
 *
 * 旧口径：`ErrorCard` 只看「这是不是最新的 error」，不看「它是不是由那条 user_reply 触发的」。
 * 结果：推进失败 / action 失败 / 定时消息失败 / 后台唤醒失败的红卡都带「重试」，
 * 点它把**事件流里最后一条 user_reply** 重发进问答通道——可能把几天前的「改代码」指令再执行一遍，
 * 或把 `[SCHEDULE_FIRED …]` 整段系统样板当用户消息发出。
 *
 * 新口径（chat-turns.resolveErrorRecovery，单点判定）：
 *   重试 = error 之前最近的「触发源」是用户亲手发的 user_reply（且不是定时样板）；
 *   触发源是 action_start / advance_failed → 「重新推进」；其余（答题回执 / 后台唤醒 / 定时 / 找不到）→ 不给入口。
 *
 * 纯函数测试（UI 在 node 环境跑不起来，见 vitest.config.ts）：事件序列进、判定出。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isLatestErrorEvent,
  resolveErrorRecovery,
} from "../src/lib/chat-turns";
import type { TaskEvent } from "../src/lib/types";

const readSrc = (...seg: string[]): string =>
  readFileSync(
    path.resolve(import.meta.dirname, "..", "src", ...seg),
    "utf-8",
  );

let seq = 0;
const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "kind">,
): TaskEvent => {
  seq += 1;
  return { id: partial.id ?? `e${seq}`, text: "", ts: seq, ...partial };
};

const user = (id: string, text = "改一下登录页", meta?: TaskEvent["meta"]) =>
  ev({ id, kind: "user_reply", text, meta });
const err = (id: string, meta?: TaskEvent["meta"]) =>
  ev({ id, kind: "error", text: "炸了", meta });

describe("isLatestErrorEvent：action_start 也算翻篇", () => {
  it("错误之后推进了新 action → 这条错误翻篇（不再是当轮失败）", () => {
    const events = [
      user("u1"),
      err("e1"),
      ev({ id: "as", kind: "action_start", text: "build 启动" }),
    ];
    expect(isLatestErrorEvent(events, "e1")).toBe(false);
  });

  it("action_start 在错误之前不影响（action 起来后挂了 = 当轮失败）", () => {
    const events = [
      ev({ id: "as", kind: "action_start", text: "build 启动" }),
      err("e1"),
    ];
    expect(isLatestErrorEvent(events, "e1")).toBe(true);
  });

  it("错误之后的非属主群问答（对主流不可见）不让属主的错误翻篇", () => {
    const groupQuestion = user("gq", "群里有人问", {
      source: "feishu_group",
      restrictedRunTag: "rt1",
    });
    const events = [user("u1"), err("e1"), groupQuestion];
    expect(isLatestErrorEvent(events, "e1")).toBe(true);
  });
});

describe("resolveErrorRecovery：重试资格单点判定", () => {
  it("用户消息触发的 run 失败 → retry，且带回要重发的那条消息", () => {
    const u = user("u1");
    const events = [u, ev({ kind: "thinking", text: "想" }), err("e1")];
    const r = resolveErrorRecovery(events, "e1");
    expect(r.kind).toBe("retry");
    expect(r.kind === "retry" && r.source.id).toBe("u1");
  });

  it("重发的是『触发这一轮的那条』，不是事件流里更靠后的别人的话（非属主群问答被跳过）", () => {
    const owner = user("owner", "我的指令");
    const groupQuestion = user("gq", "群里有人问", {
      source: "feishu_group",
      restrictedRunTag: "rt1",
    });
    const events = [owner, groupQuestion, err("e1")];
    const r = resolveErrorRecovery(events, "e1");
    expect(r.kind === "retry" && r.source.id).toBe("owner");
  });

  it("F4-01：推进失败补写的 advance_failed（前面有旧 user_reply）→ 重新推进，绝不重放旧 user_reply", () => {
    const events = [
      user("old", "几天前的改代码指令"),
      ev({ kind: "assistant_message", text: "好的" }),
      err("e1", { subkind: "advance_failed", actionType: "build" }),
    ];
    expect(resolveErrorRecovery(events, "e1").kind).toBe("readvance");
  });

  it("V3-02：action 跑挂（最近触发源是 action_start）→ 重新推进，不是重试", () => {
    const events = [
      user("old", "旧话"),
      ev({ kind: "action_start", text: "build 启动" }),
      ev({ kind: "tool_call", text: "调用 shell" }),
      err("e1"),
    ];
    expect(resolveErrorRecovery(events, "e1").kind).toBe("readvance");
  });

  it("V3-04：定时触发的 run 失败（meta.source=schedule）→ 不给任何入口", () => {
    const events = [
      user("old", "旧话"),
      user("sch", "[SCHEDULE_FIRED id=sch_1] 定时任务到点了……", {
        source: "schedule",
      }),
      err("e1"),
    ];
    expect(resolveErrorRecovery(events, "e1").kind).toBe("none");
  });

  it("V3-04：老事件没有 meta.source、只剩 [SCHEDULE_FIRED 样板正文 → 同样不给入口", () => {
    const events = [
      user("sch", "[SCHEDULE_FIRED id=sch_1] 定时任务到点了……"),
      err("e1"),
    ];
    expect(resolveErrorRecovery(events, "e1").kind).toBe("none");
  });

  it("V3-04：后台子代理结果唤醒的 run 失败 → 不给入口（不重发一小时前的用户话）", () => {
    const events = [
      user("old", "一小时前的话"),
      ev({ kind: "assistant_message", text: "我派了后台子代理" }),
      ev({
        kind: "info",
        text: "后台子代理「查资料」已完成（用时 2分05秒），结果将转交主 AI",
        meta: { subkind: "background_result" },
      }),
      err("e1"),
    ];
    expect(resolveErrorRecovery(events, "e1").kind).toBe("none");
  });

  it("答题回执触发的 run 失败 → 不给入口（重试会重放更早的 user_reply）", () => {
    const events = [
      user("old", "旧话"),
      ev({ kind: "ask_user_request", text: "选哪个", meta: { askId: "a1" } }),
      ev({ kind: "ask_user_reply", text: "答：A", meta: { askId: "a1" } }),
      err("e1"),
    ];
    expect(resolveErrorRecovery(events, "e1").kind).toBe("none");
  });

  it("找不到任何触发源（已加载的尾部里没有）→ 不给入口", () => {
    expect(resolveErrorRecovery([err("e1")], "e1").kind).toBe("none");
  });

  it("历史错误（之后有新 user_reply / 新 action_start / 更新的 error）→ 不给入口", () => {
    const base = [user("u1"), err("e1")];
    expect(
      resolveErrorRecovery([...base, user("u2")], "e1").kind,
    ).toBe("none");
    expect(
      resolveErrorRecovery(
        [...base, ev({ kind: "action_start", text: "x" })],
        "e1",
      ).kind,
    ).toBe("none");
    expect(resolveErrorRecovery([...base, err("e2")], "e1").kind).toBe("none");
    expect(resolveErrorRecovery([...base, err("e2")], "e2").kind).toBe("retry");
  });

  it("V12-03 兼容：历史上被写成 error 的 MR 冲突（meta.mrUrl）不给任何入口", () => {
    const events = [
      ev({ kind: "action_start", text: "ship 启动" }),
      err("e1", { mrUrl: "https://gitlab.example.com/a/b/-/merge_requests/1" }),
    ];
    expect(resolveErrorRecovery(events, "e1").kind).toBe("none");
  });

  it("回合内工具失败（带 callId）不是当轮崩溃：自己 none、也不挡后面真正的 run 错误", () => {
    const toolErr = err("te", { callId: "c1", name: "grep" });
    const events = [user("u1"), toolErr, err("e1")];
    expect(resolveErrorRecovery(events, "te").kind).toBe("none");
    expect(resolveErrorRecovery(events, "e1").kind).toBe("retry");
  });

  it("非 error 事件 / 不存在的 id → none", () => {
    const events = [user("u1"), ev({ id: "a", kind: "assistant_message", text: "答" })];
    expect(resolveErrorRecovery(events, "a").kind).toBe("none");
    expect(resolveErrorRecovery(events, "nope").kind).toBe("none");
    expect(resolveErrorRecovery([], "e").kind).toBe("none");
  });
});

describe("接线源码契约（UI 在 node 下跑不起来，见 vitest.config.ts）", () => {
  const errorCard = readSrc("components", "tasks", "event-stream", "error-card.tsx");
  const chatView = readSrc("components", "tasks", "chat-view.tsx");
  const taskPage = readSrc("app", "tasks", "[id]", "page.tsx");
  const advanceRoute = readSrc("app", "api", "tasks", "[id]", "advance", "route.ts");
  const chatRunner = readSrc("lib", "server", "chat-runner.ts");

  it("错误卡：重试把判定出的触发消息交给回调、重新推进走 onReadvance", () => {
    expect(errorCard).toContain("onRetryLastMessage?.(retrySource)");
    expect(errorCard).toContain("onReadvance");
    expect(errorCard).toContain("重新推进");
  });

  it("chat / task 两处的重试回调：优先用错误卡给的 source，不再无条件取「最后一条 user_reply」", () => {
    expect(chatView).toContain("source ?? findLastUserReply(task.events)");
    expect(taskPage).toContain("source ?? findLastUserReply(task.events)");
  });

  it("只有 task 详情页注入 onReadvance（chat 没有「推进」）、且口径与推进按钮一致", () => {
    expect(taskPage).toContain("onReadvance:");
    expect(chatView).not.toContain("onReadvance");
    const body = taskPage.slice(taskPage.indexOf("onReadvance:"));
    const handler = body.slice(0, body.indexOf("setAdvanceDialogOpen(true)"));
    expect(handler).toContain('task.runStatus === "running"');
    expect(handler).toContain("findPendingAskEvent(task.events)");
    expect(handler).toContain('task.repoStatus === "merged"');
  });

  it("数据源仍在：推进失败补写的 error 带 subkind=advance_failed；后台结果提示带 subkind=background_result", () => {
    expect(advanceRoute).toContain('subkind: "advance_failed"');
    expect(chatRunner).toContain('subkind: "background_result"');
  });
});
