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
  ActionRecord,
  ActionStatus,
  ActionType,
  PlanBatch,
  ReplanMode,
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
  learn: "沉淀",
  dev: "联调",
  // 兜底——custom action 实际展示走定义里的 label（见 actionDisplayLabel），拿不到才回退
  custom: "自定义",
};

/** 英文短标、用在 timeline 副标 / event stream inline */
export const ACTION_LABEL_EN: Record<ActionType, string> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
  ship: "Ship",
  learn: "Learn",
  dev: "Dev",
  custom: "Custom",
};

/** 中文 2 字短标、用在事件流 inline tag 等紧凑场景 */
export const ACTION_LABEL_SHORT: Record<ActionType, string> = {
  plan: "方案",
  build: "实现",
  review: "复核",
  ship: "提测",
  learn: "沉淀",
  dev: "联调",
  custom: "自定义",
};

/**
 * 取一条 action 的展示 label（统一来源、展示层都该走这个、不要裸 ACTION_LABEL[type]）。
 * - 内置 6 个 → 按 variant 取 ACTION_LABEL / ACTION_LABEL_SHORT / ACTION_LABEL_EN
 * - custom → action.customLabel 快照（advance 时从定义固化）、缺省回退兜底「自定义」
 *   （快照原因同 MRRecord.title：定义改名 / 删了、历史 action 仍显示当时的名字、不漂移）
 *   custom 没有 short/en 版、各 variant 都返回 customLabel 快照
 */
export const actionDisplayLabel = (
  action: {
    type: ActionType;
    customLabel?: string;
  },
  variant: "default" | "short" | "en" = "default",
): string => {
  if (action.type === "custom") {
    return action.customLabel?.trim() || ACTION_LABEL.custom;
  }
  if (variant === "short") return ACTION_LABEL_SHORT[action.type];
  if (variant === "en") return ACTION_LABEL_EN[action.type];
  return ACTION_LABEL[action.type];
};

// ===========================================
// V0.x：MR 目标分支 / 类型（提测 vs 联调）——前后端共用单一源
// ===========================================
//
// 同仓的提测 MR（→测试分支）和联调 MR（→dev 分支）按 (repoPath, targetBranch) 区分。
// 取目标分支 / 判类型的算法放这一处、task-fs upsertMR 去重 + task-runner 找旧 MR + UI 标注都复用、
// 不在多处各写一份兜底逻辑（防漂移）。

/**
 * 取一条 MR 的有效目标分支。
 * - 新记录（提测 / 联调）都显式存了 targetBranch；
 * - 老记录缺 targetBranch（提测时代）→ 兜底该仓测试分支（repoTestBranches）、再兜底 "test"。
 */
export const mrTargetBranchOf = (
  mr: { repoPath: string; targetBranch?: string },
  repoTestBranches?: Record<string, string>,
): string =>
  mr.targetBranch?.trim() ||
  repoTestBranches?.[mr.repoPath]?.trim() ||
  "test";

/**
 * 判断一条 MR 是「提测」还是「联调」——目标分支等于该仓 dev 分支 = 联调、否则提测。
 * dev 分支没配则一律算提测（联调必须显式配 dev 分支才提得了）。
 */
export const mrKindOf = (
  mr: { repoPath: string; targetBranch?: string },
  repoTestBranches?: Record<string, string>,
  repoDevBranches?: Record<string, string>,
): "ship" | "dev" => {
  const dev = repoDevBranches?.[mr.repoPath]?.trim();
  if (dev && mrTargetBranchOf(mr, repoTestBranches) === dev) return "dev";
  return "ship";
};

/** MR 类型中文标（UI badge：提测 / 联调） */
export const MR_KIND_LABEL: Record<"ship" | "dev", string> = {
  ship: "提测",
  dev: "联调",
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
  merged: "已合入",
  abandoned: "已放弃",
};

export const REPO_STATUS_VARIANT: Record<
  RepoStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  developing: "default",
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
// chat 对话标题：占位 + 首条消息派生（前后端共用单一源）
// ===========================================
//
// 自由对话「不填表单」后没有用户起的标题——新建时先给「对话 · MM-DD HH:mm」占位、
// 用户发出首条消息后用前 ~24 字覆盖（对齐 codex / Cursor Agent Window 的 first-message-wins）。
// 占位前缀单一来源、判断「是否还是占位」靠它、改前缀只改这里。

/** chat 占位标题前缀——侧栏窄、占位尽量短 */
export const CHAT_TITLE_PLACEHOLDER_PREFIX = "对话 · ";

/** 生成 chat 占位标题（新建空对话 / 后端补缺省共用） */
export const buildPlaceholderChatTitle = (now: Date = new Date()): string =>
  `${CHAT_TITLE_PLACEHOLDER_PREFIX}${now.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })}`;

/** 是否还是占位标题（用户尚未发首条消息）、用于决定要不要用首条消息覆盖 */
export const isPlaceholderChatTitle = (title: string): boolean =>
  title.startsWith(CHAT_TITLE_PLACEHOLDER_PREFIX);

/**
 * 从用户首条消息派生 chat 标题（纯截取、不调 AI）：
 * 去代码块 / 常见 markdown 标记 / 折叠空白换行 → 截到 ~24 字（CJK 占位宽、侧栏窄）、超出加省略号。
 * 全空白返回 null（调用方保留占位）。
 */
export const deriveChatTitleFromMessage = (text: string): string | null => {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#`*_>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const MAX = 24;
  return cleaned.length > MAX ? `${cleaned.slice(0, MAX)}…` : cleaned;
};

// ===========================================
// V0.6.23 build 分批：批次推导（前后端共用单一源）
// ===========================================
//
// 为什么放这里：UI（advance-dialog 选批、timeline 进度条）跟后端（task-runner 拼 build
// 指令）都要「最新 plan 的批次 + 已 build 哪些」这套推导、放一处避免两边算法漂移。
// 进度全部**派生自 action 历史**、不存计数器字段——plan 重拆 / build 返工都能自然反映。

export type EffectiveBatchStatus = "pending" | "built" | "superseded";

export interface EffectivePlanBatch extends PlanBatch {
  /** 真正写进 build.requestedBatchIds 的稳定 key，避免不同 plan 里的 b1/b2 撞车 */
  effectiveId: string;
  /** plan 内原始 id（如 b1/b2），只用于展示和旧数据兼容 */
  rawId: string;
  /** 这个批次来自哪次 plan action */
  sourcePlanActionId: string;
  /** 展示用序号（#7 方案） */
  sourceActionN: number;
  /** 纯派生状态，不落库，避免第二真相源 */
  status: EffectiveBatchStatus;
  /** append 模式下疑似重复旧批次时只提示，不自动合并 */
  duplicateOfEffectiveId?: string;
}

const isPlanWithBatches = (
  action: ActionRecord,
): action is ActionRecord & { planBatches: PlanBatch[] } =>
  action.type === "plan" &&
  !action.excluded &&
  !!action.planBatches &&
  action.planBatches.length > 0;

export const getBatchEffectiveId = (
  planActionId: string,
  batchId: string,
): string => `${planActionId}:${batchId}`;

const normalizeBatchTitle = (title: string): string =>
  title.replace(/\s+/g, "").toLowerCase();

const findDuplicate = (
  active: EffectivePlanBatch[],
  batch: PlanBatch,
): string | undefined => {
  const title = normalizeBatchTitle(batch.title);
  const candidate = active.find((prev) => {
    if (prev.status === "superseded") return false;
    if (prev.rawId === batch.id) return true;
    if (!title) return false;
    const prevTitle = normalizeBatchTitle(prev.title);
    return !!prevTitle && (prevTitle.includes(title) || title.includes(prevTitle));
  });
  return candidate?.effectiveId;
};

const makeEffectiveBatch = (
  action: ActionRecord,
  batch: PlanBatch,
  duplicateOfEffectiveId?: string,
): EffectivePlanBatch => ({
  ...batch,
  // id 保持等于 effectiveId，尽量兼容旧调用方用 b.id 做 key / selected value 的写法。
  id: getBatchEffectiveId(action.id, batch.id),
  effectiveId: getBatchEffectiveId(action.id, batch.id),
  rawId: batch.id,
  sourcePlanActionId: action.id,
  sourceActionN: action.n,
  status: "pending",
  duplicateOfEffectiveId,
});

const findLegacySeedPlanId = (
  plans: Array<ActionRecord & { planBatches: PlanBatch[] }>,
): string | null => {
  const firstExplicit = plans.findIndex((a) => !!a.replanMode);
  if (firstExplicit === -1) return plans[plans.length - 1]?.id ?? null;
  for (let i = firstExplicit - 1; i >= 0; i--) {
    if (!plans[i].replanMode) return plans[i].id;
  }
  return null;
};

const resolveRequestedBatchId = (
  id: string,
  active: EffectivePlanBatch[],
): string | null => {
  if (id.includes(":")) return id;
  const matches = active.filter(
    (b) => b.status !== "superseded" && b.rawId === id,
  );
  // 旧数据裸 b1/b2 只在唯一匹配时映射；多 plan 撞车时不猜。
  return matches.length === 1 ? matches[0].effectiveId : null;
};

export interface EffectiveBatchesResult {
  batches: EffectivePlanBatch[];
  superseded: EffectivePlanBatch[];
  builtIds: Set<string>;
}

/**
 * 派生当前 task 的有效批次集。
 *
 * 关键约束：
 * - 不落 task 级 batch 状态，所有状态从 action history 现场推导；
 * - 旧 task 缺 replanMode 时保持 legacy latest-only；
 * - 新 replan 通过 action.replanMode 决定 append / rebuild；
 * - build.requestedBatchIds 新写 effectiveId，旧裸 id 在唯一匹配时兼容。
 */
export const deriveEffectiveBatches = (task: Task): EffectiveBatchesResult => {
  const plans = task.actions.filter(isPlanWithBatches);
  if (plans.length === 0) {
    return { batches: [], superseded: [], builtIds: new Set() };
  }

  const hasExplicitReplan = plans.some((a) => !!a.replanMode);
  if (!hasExplicitReplan) {
    // 旧任务保持 V0.6.23 语义：只认最新一个有批次的 plan，但所有历史 build 的裸 id
    // 仍按 rawId 计入进度，避免升级后旧 task 进度回退。
    const latest = plans[plans.length - 1]!;
    const batches = latest.planBatches.map((batch) =>
      makeEffectiveBatch(latest, batch),
    );
    const builtIds = new Set<string>();
    for (const action of task.actions) {
      if (action.type !== "build" || action.status !== "completed" || action.excluded) {
        continue;
      }
      for (const requestedId of action.requestedBatchIds ?? []) {
        if (requestedId.includes(":")) {
          builtIds.add(requestedId);
          continue;
        }
        const match = batches.find((b) => b.rawId === requestedId);
        if (match) builtIds.add(match.effectiveId);
      }
    }
    for (const b of batches) {
      if (builtIds.has(b.effectiveId)) b.status = "built";
    }
    return { batches, superseded: [], builtIds };
  }

  const legacySeedPlanId = findLegacySeedPlanId(plans);
  const active: EffectivePlanBatch[] = [];
  const builtIds = new Set<string>();

  for (const action of task.actions) {
    if (isPlanWithBatches(action)) {
      const include = action.id === legacySeedPlanId || !!action.replanMode;
      if (!include) continue;

      const mode: ReplanMode = action.replanMode ?? "append";
      if (mode === "rebuild") {
        for (const b of active) {
          if (!builtIds.has(b.effectiveId)) b.status = "superseded";
        }
      }

      for (const batch of action.planBatches) {
        const duplicateOfEffectiveId =
          mode === "append" ? findDuplicate(active, batch) : undefined;
        active.push(makeEffectiveBatch(action, batch, duplicateOfEffectiveId));
      }
      continue;
    }

    if (action.type === "build" && action.status === "completed" && !action.excluded) {
      for (const requestedId of action.requestedBatchIds ?? []) {
        const effectiveId = resolveRequestedBatchId(requestedId, active);
        if (effectiveId) builtIds.add(effectiveId);
      }
    }
  }

  for (const b of active) {
    if (builtIds.has(b.effectiveId)) b.status = "built";
  }

  return {
    batches: active.filter((b) => b.status !== "superseded"),
    superseded: active.filter((b) => b.status === "superseded"),
    builtIds,
  };
};

/**
 * 兼容旧调用名：返回当前有效批次（不是“最新单个 plan”）。
 * 新代码优先直接用 deriveEffectiveBatches / computeBatchProgress。
 */
export const getLatestPlanBatches = (task: Task): EffectivePlanBatch[] =>
  deriveEffectiveBatches(task).batches;

/** 已 build 过的批次 effective id 集合（纯派生、不存计数器避免漂移）。 */
export const collectBuiltBatchIds = (task: Task): Set<string> =>
  deriveEffectiveBatches(task).builtIds;

/** 批次进度快照（UI 进度条 + 后端 prompt 进度提示共用） */
export interface BatchProgress {
  /** 当前有效批次（顺序 = 建议 build 顺序，不含 superseded） */
  batches: EffectivePlanBatch[];
  /** 被 rebuild 替代的旧 pending 批次（默认只折叠展示 / 审计用） */
  superseded: EffectivePlanBatch[];
  /** 总批次数 */
  total: number;
  /** 已完成批次数（限当前 plan 批次内、防 plan 重拆后旧 id 残留误计） */
  done: number;
  /** 已 build 过的批次 effective id */
  doneIds: Set<string>;
  /** 还没 build 的批次（= 推进 build 时默认勾选项） */
  remaining: EffectivePlanBatch[];
  /** 最新 plan 没有结构化批次时，用于 UI 提示“未纳入 build 选择” */
  latestPlanMissingBatches?: { id: string; n: number };
}

/**
 * 算批次进度——给 UI 进度条 / 默认勾选 + 后端 build 指令的「累计 X/Y 批」共用。
 */
export const computeBatchProgress = (task: Task): BatchProgress => {
  const { batches, superseded, builtIds } = deriveEffectiveBatches(task);
  const remaining = batches.filter((b) => !builtIds.has(b.effectiveId));
  const done = batches.length - remaining.length;
  const latestPlan = [...task.actions]
    .reverse()
    .find((a) => a.type === "plan" && !a.excluded);
  const hasSplitHistory =
    batches.length > 0 ||
    superseded.length > 0 ||
    task.actions.some(
      (a) =>
        a.type === "build" &&
        !a.excluded &&
        (a.requestedBatchIds?.length ?? 0) > 0,
    );
  const latestPlanMissingBatches =
    hasSplitHistory &&
    latestPlan &&
    (!latestPlan.planBatches || latestPlan.planBatches.length === 0)
      ? { id: latestPlan.id, n: latestPlan.n }
      : undefined;

  return {
    batches,
    superseded,
    total: batches.length,
    done,
    doneIds: builtIds,
    remaining,
    latestPlanMissingBatches,
  };
};
