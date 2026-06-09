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
  PlanBatch,
  RepoStatus,
  RunStatus,
  Task,
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
  review: "复核",
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

// ===========================================
// V0.6.23 build 分批：批次推导（前后端共用单一源）
// ===========================================
//
// 为什么放这里：UI（advance-dialog 选批、timeline 进度条）跟后端（task-runner 拼 build
// 指令）都要「最新 plan 的批次 + 已 build 哪些」这套推导、放一处避免两边算法漂移。
// 进度全部**派生自 action 历史**、不存计数器字段——plan 重拆 / build 返工都能自然反映。

/**
 * 取最新一个「有批次」的 plan action 的 planBatches。
 *
 * - build 分批选择 + 进度推导都以它为基准
 * - 返空数组 = 这个 task 没拆批次（小需求 / 老 task）、build 退化成「做全部」老流程
 * - 倒序找：plan 可能被重跑多次、只认最新一版拆分
 * - 不限 status：planBatches 是 agent 调 set_plan_batches 主动落库的有效数据、
 *   run 中断（error）/ 还在 awaiting_ack 都不影响数据本身。
 *   典型坑：plan 拆了批次但 serve 重启被标 error、之后接续的 plan 没重拆批次——
 *   仍要能回退到那次拆好的批次、否则分批 build 整个失效。
 */
export const getLatestPlanBatches = (task: Task): PlanBatch[] => {
  for (let i = task.actions.length - 1; i >= 0; i--) {
    const a = task.actions[i];
    if (
      a.type === "plan" &&
      !a.excluded &&
      a.planBatches &&
      a.planBatches.length > 0
    ) {
      return a.planBatches;
    }
  }
  return [];
};

/**
 * 已 build 过的批次 id 集合（纯派生、不存计数器避免漂移）。
 * = 所有 completed 且未划除的 build action 的 requestedBatchIds 之并集。
 */
export const collectBuiltBatchIds = (task: Task): Set<string> => {
  const ids = new Set<string>();
  for (const a of task.actions) {
    if (a.type === "build" && a.status === "completed" && !a.excluded) {
      for (const id of a.requestedBatchIds ?? []) ids.add(id);
    }
  }
  return ids;
};

/** 批次进度快照（UI 进度条 + 后端 prompt 进度提示共用） */
export interface BatchProgress {
  /** 最新 plan 拆出的全部批次（顺序 = 建议 build 顺序） */
  batches: PlanBatch[];
  /** 总批次数 */
  total: number;
  /** 已完成批次数（限当前 plan 批次内、防 plan 重拆后旧 id 残留误计） */
  done: number;
  /** 已 build 过的批次 id（含可能不在当前 plan 的历史 id） */
  doneIds: Set<string>;
  /** 还没 build 的批次（= 推进 build 时默认勾选项） */
  remaining: PlanBatch[];
}

/**
 * 算批次进度——给 UI 进度条 / 默认勾选 + 后端 build 指令的「累计 X/Y 批」共用。
 */
export const computeBatchProgress = (task: Task): BatchProgress => {
  const batches = getLatestPlanBatches(task);
  const doneIds = collectBuiltBatchIds(task);
  const remaining = batches.filter((b) => !doneIds.has(b.id));
  const done = batches.length - remaining.length;
  return { batches, total: batches.length, done, doneIds, remaining };
};
