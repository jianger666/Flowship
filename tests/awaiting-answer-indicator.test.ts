/**
 * 第三轮 review R3-03：「五处口径」修了三处，chat 头部徽标与侧栏转圈仍说「运行中 / 转圈」
 *
 * 事实：AI 用 ask_user 提问等答案时 runStatus 仍是 running（等答案靠一条前台 curl 阻塞，不切 awaiting_user）。
 *   - 状态行 / task 头部徽标已说「待回答 / 等你回答」（V16-01 / V6-02）；
 *   - chat 头部徽标直接 `RUN_STATUS_LABEL[runStatus]` → 仍写「运行中」；
 *   - 侧栏 LeadingIndicator 先判 `runStatus === "running"` → 转圈（task 行还并排写「待回答」，自相矛盾）。
 * 修法：复用 task-header-status 的「待回答」判定——chat 头部走 deriveChatHeaderRunBadge、
 * 侧栏行首走 isAwaitingAnswer（running + hasPendingAsk → 品牌色脉冲点「待回答」，不转圈）。
 * `isTaskBusy`（列表轮询 / 折叠保护用）不变：此刻 run 确实还活着，轮询不能停。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isTaskBusy } from "@/lib/task-background";
import {
  AWAITING_ANSWER_LABEL,
  deriveChatHeaderRunBadge,
  deriveTaskHeaderRunBadge,
} from "@/lib/task-header-status";
import { isAwaitingAnswer } from "@/lib/task-stage-line";
import type { RunStatus, TaskSummary } from "@/lib/types";

const row = (p: Partial<TaskSummary>): TaskSummary =>
  ({
    id: "t1",
    title: "x",
    mode: "chat",
    repoStatus: "developing",
    currentActionId: null,
    mrs: [],
    repoPaths: [],
    createdAt: 1,
    updatedAt: 2,
    actionCount: 0,
    runStatus: "idle",
    ...p,
  }) as TaskSummary;

describe("deriveChatHeaderRunBadge：chat 头部徽标", () => {
  it("running + 有未答提问 → 「待回答」（不再写「运行中」），与 task 头部同词同样式", () => {
    const b = deriveChatHeaderRunBadge("running", true);
    expect(b).toEqual({
      kind: "badge",
      label: "待回答",
      variant: "secondary",
      awaitingAnswer: true,
    });
    expect(b).toEqual(deriveTaskHeaderRunBadge("running", true));
    expect(AWAITING_ANSWER_LABEL).toBe("待回答");
  });

  it("running 没有未答提问 → 照旧「运行中」", () => {
    expect(deriveChatHeaderRunBadge("running", false)).toMatchObject({
      kind: "badge",
      label: "运行中",
      awaitingAnswer: false,
    });
  });

  it("chat 静息（idle / awaiting_user）不画徽标——这是 chat 与 task 头部的既有差异，不回归", () => {
    for (const awaitingAsk of [false, true]) {
      expect(deriveChatHeaderRunBadge("idle", awaitingAsk)).toEqual({ kind: "none" });
      expect(deriveChatHeaderRunBadge("awaiting_user", awaitingAsk)).toEqual({ kind: "none" });
    }
  });

  it("error 永远是「失败」：提问已没人接，不能写成「待回答」；样式仍是 chat 既有的 Badge", () => {
    for (const awaitingAsk of [false, true]) {
      expect(deriveChatHeaderRunBadge("error", awaitingAsk)).toMatchObject({
        kind: "badge",
        label: "失败",
        awaitingAnswer: false,
      });
    }
  });

  it("徽标文案全表：只有 running+提问 一格不同于 RUN_STATUS_LABEL", () => {
    const statuses: RunStatus[] = ["idle", "running", "awaiting_user", "error"];
    const diffs: string[] = [];
    for (const s of statuses) {
      for (const ask of [false, true]) {
        const b = deriveChatHeaderRunBadge(s, ask);
        const label = b.kind === "none" ? null : b.label;
        diffs.push(`${s}/${ask}=${label}`);
      }
    }
    expect(diffs).toEqual([
      "idle/false=null",
      "idle/true=null",
      "running/false=运行中",
      "running/true=待回答",
      "awaiting_user/false=null",
      "awaiting_user/true=null",
      "error/false=失败",
      "error/true=失败",
    ]);
  });
});

describe("isAwaitingAnswer：侧栏行首「待回答」判定（chat / task 同口径）", () => {
  it("running + hasPendingAsk → 是（chat 与 task 都算）", () => {
    expect(isAwaitingAnswer(row({ runStatus: "running", hasPendingAsk: true, mode: "chat" }))).toBe(true);
    expect(isAwaitingAnswer(row({ runStatus: "running", hasPendingAsk: true, mode: "task" }))).toBe(true);
  });

  it("没有未答提问 / 不在 running → 否（其余态走原有判定，不动）", () => {
    expect(isAwaitingAnswer(row({ runStatus: "running" }))).toBe(false);
    expect(isAwaitingAnswer(row({ runStatus: "running", hasPendingAsk: false }))).toBe(false);
    for (const runStatus of ["idle", "awaiting_user", "error"] as const) {
      expect(isAwaitingAnswer(row({ runStatus, hasPendingAsk: true }))).toBe(false);
    }
  });

  it("isTaskBusy 不变：待回答时 run 还活着，列表轮询 / 折叠保护照旧", () => {
    expect(isTaskBusy(row({ runStatus: "running", hasPendingAsk: true }))).toBe(true);
  });
});

describe("接线（源码契约，仅钉位置与文案）", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

  it("侧栏 LeadingIndicator：待回答判定在「运行中转圈」之前，画品牌色脉冲点、读屏说「待回答」", () => {
    const src = read("src/components/tasks/task-list-item.tsx");
    const fn = src.slice(
      src.indexOf("const LeadingIndicator"),
      src.indexOf("interface TaskListItemProps"),
    );
    const awaiting = fn.indexOf("isAwaitingAnswer(task)");
    const running = fn.indexOf('task.runStatus === "running"');
    expect(awaiting).toBeGreaterThan(-1);
    expect(awaiting).toBeLessThan(running);
    const branch = fn.slice(awaiting, running);
    expect(branch).toContain('aria-label="待回答"');
    expect(branch).toContain("bg-brand");
    expect(branch).not.toContain("animate-spin");
  });

  it("chat 头部徽标走 deriveChatHeaderRunBadge，不再直接 RUN_STATUS_LABEL[task.runStatus]", () => {
    const src = read("src/components/tasks/chat-view.tsx");
    expect(src).toContain("deriveChatHeaderRunBadge(task.runStatus, awaitingAsk)");
    expect(src).not.toContain("{RUN_STATUS_LABEL[task.runStatus]}");
  });
});
