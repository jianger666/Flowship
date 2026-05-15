/**
 * 任务展示层公共文案 / 工具
 *
 * 抽出来的动机：
 * - PHASE_LABEL 在 task-card / phase-progress / task page / artifact-panel 4 处独立定义、
 *   其中 artifact-panel 还多了「规划」二字、文案漂移
 * - STATUS_LABEL / STATUS_VARIANT 在 task-card 跟 task page 完全复制
 * - formatRelative 是「N 分钟前」之类相对时间、目前只 task-card 用、但放这统一收口未来好复用
 *
 * 命名约定：
 * - PHASE_LABEL: 默认中文长版本（「上下文 + 方案」）、用在卡片 / phase-progress 主标
 * - PHASE_LABEL_EN: 短英文（「Plan」/「Build」）、用在 phase-progress 副标
 * - PHASE_LABEL_SHORT: 中文短版本（「方案」/「实现」）、用在事件流 inline 标签
 *
 * 改 phase 文案 → 只改这一个文件。
 */

import type { PhaseId, TaskStatus } from "./types";

// 任务状态中文标签
export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "草稿",
  running: "运行中",
  awaiting_user: "等待回复",
  completed: "已完成",
  failed: "失败",
};

// 任务状态对应的 Badge variant
// outline = 草稿（中性）/ default = 运行中（主色）/ secondary = 等待 / 已完成（弱）/ destructive = 失败
export const STATUS_VARIANT: Record<
  TaskStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  draft: "outline",
  running: "default",
  awaiting_user: "secondary",
  completed: "secondary",
  failed: "destructive",
};

// Phase 标签（中文长版本、主要展示）
// V0.3.4 合并原 context 进 plan 后、plan 涵盖「读上下文 + 扫仓库 + 出方案」
// 文案上不再强调「上下文」（用户对「上下文 + 方案」的复合标签接受度一般、改成更短的「方案规划」、
//   语义上「规划」自然包含「读上下文 → 出方案」、不需要并列两个词）
export const PHASE_LABEL: Record<PhaseId, string> = {
  plan: "方案规划",
  build: "编码实现",
};

// Phase 英文短标（团队沟通锚点、用在 phase-progress 副标）
export const PHASE_LABEL_EN: Record<PhaseId, string> = {
  plan: "Plan",
  build: "Build",
};

// Phase 中文短标（用在 event-stream 等空间紧凑的地方）
export const PHASE_LABEL_SHORT: Record<PhaseId, string> = {
  plan: "方案",
  build: "实现",
};

/**
 * 相对时间文案（任务卡片 / 事件流时间戳用）
 * 粒度足够：刚刚 / N 分钟前 / N 小时前 / N 天前
 * 不引第三方时间库（项目目前没用 dayjs / date-fns）、保持依赖轻
 */
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
