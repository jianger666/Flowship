/**
 * V6-02（第二轮 review）：task 头部在 AI 等你回答时写「运行中」+ 一直转圈的「停止」，侧栏却是「待回答」。
 *
 * 事实核对：ask_user 提问后**不会**把 runStatus 切成 awaiting_user——等答案靠一条前台 curl 阻塞，
 * runStatus 全程是 running（CHANGELOG 同一轮等答案）。所以头部只看 runStatus 必然说「运行中」。
 *
 * 取舍（见 deriveTaskHeaderRunBadge / taskStopButtonView 的注释）：
 *  - 徽标：等待回答时写「待回答」（与侧栏 taskStageLine 同词），不再写「运行中」；
 *  - 停止键：**不移除**。等答案期间底部输入条不是停止键（composer 的 isRunning = runActive && !pendingAsk），
 *    头部这颗是用户在会话卡死时唯一的停止入口——只把转圈图标换成静态方块、补一句说明。
 *  - isStopButtonVisible 仍只看 runStatus（安全契约，tests/restricted-group-question.test.ts 钉着），这里不并 runActive。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isStopButtonVisible } from "@/lib/task-display";
import {
  AWAITING_ANSWER_LABEL,
  deriveTaskHeaderRunBadge,
  taskStopButtonView,
} from "@/lib/task-header-status";

describe("deriveTaskHeaderRunBadge：头部运行态徽标", () => {
  it("running + 有未答提问 → 「待回答」（不再写「运行中」），标记 awaitingAnswer", () => {
    const b = deriveTaskHeaderRunBadge("running", true);
    expect(b).toEqual({
      kind: "badge",
      label: "待回答",
      variant: "secondary",
      awaitingAnswer: true,
    });
    expect(AWAITING_ANSWER_LABEL).toBe("待回答");
  });

  it("awaiting_user + 有未答提问 → 同样「待回答」（侧栏 hasPendingAsk 优先于 runStatus）", () => {
    const b = deriveTaskHeaderRunBadge("awaiting_user", true);
    expect(b.kind).toBe("badge");
    if (b.kind === "badge") {
      expect(b.label).toBe("待回答");
      expect(b.awaitingAnswer).toBe(true);
    }
  });

  it("running 没有未答提问 → 照旧「运行中」", () => {
    expect(deriveTaskHeaderRunBadge("running", false)).toEqual({
      kind: "badge",
      label: "运行中",
      variant: "default",
      awaitingAnswer: false,
    });
  });

  it("awaiting_user 没有未答提问（交卷等确认 / 断掉态）→ 照旧「等待回复」", () => {
    const b = deriveTaskHeaderRunBadge("awaiting_user", false);
    expect(b).toMatchObject({ kind: "badge", label: "等待回复", awaitingAnswer: false });
  });

  it("error 永远是失败：提问已没人接，不能写成「待回答」", () => {
    expect(deriveTaskHeaderRunBadge("error", true)).toEqual({ kind: "error", label: "失败" });
    expect(deriveTaskHeaderRunBadge("error", false)).toEqual({ kind: "error", label: "失败" });
  });

  it("idle 不画徽标（即便残留一条没了结的 ask 事件）", () => {
    expect(deriveTaskHeaderRunBadge("idle", false)).toEqual({ kind: "none" });
    expect(deriveTaskHeaderRunBadge("idle", true)).toEqual({ kind: "none" });
  });
});

describe("taskStopButtonView：停止键外观（能力不变，只换外观）", () => {
  it("等你回答时：静态图标（不转圈）+ 说明文案，文案点明「停止会让待答提问作废」", () => {
    const v = taskStopButtonView(true);
    expect(v.spinning).toBe(false);
    expect(v.tooltip).toContain("等你回答");
    expect(v.tooltip).toContain("作废");
  });

  it("AI 真在跑：保持转圈、没有多余说明", () => {
    expect(taskStopButtonView(false)).toEqual({ spinning: true, tooltip: null });
  });
});

describe("安全契约：isStopButtonVisible 仍只看 runStatus", () => {
  it("running 时（含等你回答）停止键可见；awaiting_user / idle / error 不可见——退路不被头部徽标改动影响", () => {
    expect(isStopButtonVisible({ runStatus: "running" })).toBe(true);
    expect(isStopButtonVisible({ runStatus: "awaiting_user" })).toBe(false);
    expect(isStopButtonVisible({ runStatus: "idle" })).toBe(false);
    expect(isStopButtonVisible({ runStatus: "error" })).toBe(false);
  });
});

// ---- 接线契约（页面是 .tsx、node 环境 import 不了，只能钉源码） ----
const repoDir = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(repoDir, rel), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("task 详情页头部接线", () => {
  const page = stripComments(read("src/app/tasks/[id]/page.tsx"));

  it("徽标走 deriveTaskHeaderRunBadge(task.runStatus, awaitingAskAnswer)，不再直接 RUN_STATUS_LABEL[task.runStatus]", () => {
    expect(page).toContain("deriveTaskHeaderRunBadge(task.runStatus, awaitingAskAnswer)");
    expect(page).not.toMatch(/RUN_STATUS_LABEL\[task\.runStatus\]/);
    expect(page).not.toMatch(/RUN_STATUS_VARIANT\[task\.runStatus\]/);
  });

  it("停止键显隐仍是 isStopButtonVisible(task) && !canAck——没有并上 runActive / awaitingAskAnswer", () => {
    expect(page).toMatch(/isStopButtonVisible\(task\) && !canAck\s*&&/);
    expect(page).not.toMatch(/isStopButtonVisible\(task\)\s*&&\s*!?(runActive|awaitingAskAnswer)/);
  });

  it("停止图标的转圈由 taskStopButtonView 决定（不再无条件 animate-spin）", () => {
    expect(page).toContain("taskStopButtonView(");
    expect(page).toContain("stopView.spinning");
    // 头部停止键那一段里不能再有无条件的 <Loader2 className=\"animate-spin\" /> + 停止
    expect(page).not.toMatch(/<Loader2 className="animate-spin" \/>\s*停止/);
  });
});
