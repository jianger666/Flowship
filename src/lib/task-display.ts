/**
 * 任务展示层公共文案 / 工具（V0.6 改造）
 *
 * V0.6 概念变化：phase chain 拆掉、action history 取代——
 *  - 原 PHASE_LABEL / PHASE_LABEL_EN / PHASE_LABEL_SHORT → ACTION_LABEL_*
 *  - 原 STATUS_LABEL（TaskStatus 单维度）→ REPO_STATUS_LABEL（业务）+ RUN_STATUS_LABEL（运行时）
 *  - 加 ACTION_STATUS_LABEL（单条 action 的状态）
 *
 * 改 action / status 文案 → 只改这一个文件。
 */

import type {
  ActionStatus,
  ActionType,
  RepoStatus,
  RunStatus,
} from "./types";

// ===========================================
// Action 标签（V0.6 替代原 PHASE_LABEL）
// ===========================================

/**
 * Action 中文长版本（主要展示用：advance dialog 选项 / action timeline 卡片）
 *
 * 注意：types.ts 已经 export `ACTION_LABEL`（types 层最小集合）、本文件这版**复用同名**
 * 但放在 display 层、跟其他 display label 一起统一来源。如有偏差以本文件为准。
 */
export const ACTION_LABEL: Record<ActionType, string> = {
  plan: "出方案",
  build: "改代码",
  review: "代码复核",
  ship: "提测",
  test: "AI 手测",
  learn: "沉淀",
};

/** 英文短标、用在 timeline 副标 / event stream inline */
export const ACTION_LABEL_EN: Record<ActionType, string> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
  ship: "Ship",
  test: "Test",
  learn: "Learn",
};

/** 中文 2 字短标、用在事件流 inline tag 等紧凑场景 */
export const ACTION_LABEL_SHORT: Record<ActionType, string> = {
  plan: "方案",
  build: "实现",
  review: "复核",
  ship: "提测",
  test: "手测",
  learn: "沉淀",
};

// ===========================================
// Action 状态标签
// ===========================================

export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  running: "运行中",
  awaiting_ack: "等待确认",
  completed: "已通过",
  error: "失败",
  cancelled: "已取消",
};

export const ACTION_STATUS_VARIANT: Record<
  ActionStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  running: "default",
  awaiting_ack: "secondary",
  completed: "secondary",
  error: "destructive",
  cancelled: "outline",
};

// ===========================================
// Task 级仓库状态（V0.6 新维度、跟 MR 生命周期对齐）
// ===========================================

export const REPO_STATUS_LABEL: Record<RepoStatus, string> = {
  developing: "开发中",
  awaiting_test: "待测",
  has_bug: "有 bug",
  merged: "已合入",
  abandoned: "已放弃",
};

export const REPO_STATUS_VARIANT: Record<
  RepoStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  developing: "default",
  awaiting_test: "secondary",
  has_bug: "destructive",
  merged: "secondary",
  abandoned: "outline",
};

// ===========================================
// Task 级运行时状态（V0.6 新维度、独立于 repoStatus）
// ===========================================

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  idle: "空闲",
  running: "运行中",
  awaiting_user: "等待回复",
  error: "失败",
};

export const RUN_STATUS_VARIANT: Record<
  RunStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  idle: "outline",
  running: "default",
  awaiting_user: "secondary",
  error: "destructive",
};

// ===========================================
// 仓库路径展示
// ===========================================

/**
 * 任务关联仓库的展示文案（V0.5.9 加、V0.6 不变）
 *
 * - 0 个 → "(未配置仓库)"
 * - 1 个 → 完整路径
 * - 多个 → 各仓 basename 用 " + " 拼接
 *
 * 完整路径展开版本在 hover tooltip 里给（调用方自己加 title 属性）。
 */
export const formatRepoPathsForDisplay = (paths: string[]): string => {
  if (paths.length === 0) return "(未配置仓库)";
  if (paths.length === 1) return paths[0];
  return paths
    .map((p) => {
      const clean = p.replace(/\/+$/, "");
      const idx = clean.lastIndexOf("/");
      return idx >= 0 ? clean.slice(idx + 1) || clean : clean;
    })
    .join(" + ");
};

// ===========================================
// 相对时间文案
// ===========================================

/** 相对时间文案：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export const formatRelative = (ts: number): string => {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
};
