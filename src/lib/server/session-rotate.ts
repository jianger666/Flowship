/**
 * chat 会话保命轮换（2026-09-03 OOM 根治：最小可用版）
 *
 * 背景：@cursor/sdk（1.0.30）local-agent 无客户端自动压缩，后端即便压也只省模型窗口、
 * 不释放我们 server 堆。单 chat 窗口连跑 9 个子代理后累计 input 278 万、单轮 56 万，
 * 堆到 ~2.4G 就 `heap out of memory` → 整个 server 进程没（实测）。
 *
 * 解法：水位一到，下轮消息走已有的「懒重启」分支（关旧建新 + 起手 prompt 注入近 12 轮
 * 摘要——与 resume 失败降级 / 切模型同一条路），把 GB 级旧 Agent 内存扔掉。
 * `events.jsonl` 是真相源、扔的只是 SDK 会话缓存，转坏上限 = 忘点远古上下文。
 *
 * 范围：只 chat（chat-inject 决策点）。task-runner 不动。
 * 阈值极高、正常会话撞不上；开关 = 阈值常量（改大即关）。
 *
 * 为什么只看「会话累计」、不看「单轮」：
 * 转完后 `tokenUsage.last` 还是转前那轮的旧值（新轮没跑完）——若拿单轮做触发，
 * 下轮检查会看到 stale 的 56 万而无限连转。会话累计在新建锚点时清零，无此问题。
 */

import type { Task } from "@/lib/types";
import type { WorkerMemorySample } from "./mem-governance";
import { classifyWorkerMemory, isRotationAllowed } from "./mem-governance";
import { heapPressure } from "./sdk-store-gc";

/** 当前 SDK 会话累计 input 超过此值 → 下轮轮换（同事实测崩时 278 万） */
export const ROTATE_SESSION_INPUT_TOKENS = 2_000_000;

/** 轮换时落盘的 info 事件文案（事件流里显示为灰色居中细线、无需 UI 改动） */
export const SESSION_ROTATION_INFO_TEXT =
  "上下文过长，已自动压缩续接，本窗口用新会话继续，上方历史仍保留。";

export interface RotationUsageLike {
  /** 当前 SDK 会话累计 input（recordTurnUsage 累加、新建锚点清零） */
  sessionInputTokens?: number;
  /** 兜底：老任务缺字段时用累计 total 估算（转一次即自愈、之后走正常计数） */
  totalInputTokens?: number;
}

/** 纯函数：水位到了返 true。缺字段（老任务）→ 用 total 估算，再缺 = 不转。 */
export const isSessionRotationDue = (u: RotationUsageLike): boolean =>
  (u.sessionInputTokens ?? u.totalInputTokens ?? 0) >=
  ROTATE_SESSION_INPUT_TOKENS;

/**
 * task 轮换双条件（2026-09-07 矫枉过正修正）：水位超线 **并且** 堆水位过半才转。
 * 堆不吃紧时链胖点也不折腾用户；85% 的拒单门（见 sdk-store-gc）是最后一道。
 * heapRatio 可注入（单测锁行为），缺省读实时堆。chat 通路不用这条（沿用旧语义）。
 */
export const ROTATE_HEAP_FLOOR = 0.5;
export const shouldRotateSession = (
  u: RotationUsageLike,
  heapRatio: number = heapPressure().ratio,
): boolean => isSessionRotationDue(u) && heapRatio >= ROTATE_HEAP_FLOOR;

/** 从 Task 取水位输入 */
export const rotationUsageOf = (
  task: Pick<Task, "sessionInputTokens" | "tokenUsage">,
): RotationUsageLike => ({
  sessionInputTokens: task.sessionInputTokens,
  totalInputTokens: task.tokenUsage?.total.inputTokens,
});

// ---------------- run 内水位触发器（2026-09-22 自动压缩续接） ----------------
//
// 边界轮换只在 action / send 边界查水位，一个 action 内部连跑上百个工具调用照样
// 会把会话滚爆（同事实测单 run 增量 278 万后 OOM）。这里补 run 内的探针：
//   - 消费点：task-fs.recordTurnUsage（记账即查、chat/task 共用入口）
//   - 触发回调：task-runner 的 consumeSessionRun 在 run.wait 前登记（拿到 run 才能 cancel）
//   - chat 不登记（懒重启已兜底）、无登记 = no-op
// 判定复用 shouldRotateSession 双条件（水位 + 堆过半、防过矫语义与边界轮换一致）。

export type WorkerRotationAction = "none" | "soft" | "hard";

/**
 * run 内轮换触发器。参数为触发档位（soft=等收尾、hard=工具间隙截断）；
 * 存量注册方（无参）保持兼容——少参数函数可赋值给多参数签名。
 */
export type MidRunRotationTrigger = (action?: WorkerRotationAction) => void;

const midRunRotationTriggers = new Map<string, MidRunRotationTrigger>();

export const registerMidRunRotationTrigger = (
  taskId: string,
  fn: MidRunRotationTrigger,
): void => {
  midRunRotationTriggers.set(taskId, fn);
};

/** 注销按 identity——并发 / 递归 consume 交错时不误摘后继登记的那条 */
export const unregisterMidRunRotationTrigger = (
  taskId: string,
  fn: MidRunRotationTrigger,
): void => {
  if (midRunRotationTriggers.get(taskId) === fn) {
    midRunRotationTriggers.delete(taskId);
  }
};

/**
 * 记账点调用：水位到了就触发（无登记 = no-op）。绝不 throw（埋点场景不许反伤记账）。
 * heapRatio 可注入（单测锁行为），缺省读实时堆。
 */
export const maybeFireMidRunRotation = (
  taskId: string,
  usage: RotationUsageLike,
  heapRatio: number = heapPressure().ratio,
): void => {
  try {
    if (!shouldRotateSession(usage, heapRatio)) return;
    midRunRotationTriggers.get(taskId)?.();
  } catch {
    /* 触发失败不挡记账 */
  }
};

// ---------------- v3.1 §3.2：堆/RSS 水位独立触发（加法，不改存量语义） ----------------
//
// 存量 shouldRotateSession = token 水位 AND 堆过半（防过矫）。v3.1 终版要求堆/RSS
// 水位独立可触发（token 降级为日志参考）。本函数是新触发器实现，调用方（worker
// 模式接线）在 recordTurnUsage 探针处按 worker 上报的 sample 调用；存量路径不动，
// 等实验 A 校准常数 + 热路径接线时再切换。单测锁行为。
// WorkerRotationAction 类型见上（run 内水位触发器一节，与 MidRunRotationTrigger 同处）。

/** 纯函数：worker 内存样本 → 轮换动作（soft=等 run 收尾重启，hard=工具间隙截断）。 */
export const workerRotationActionFor = (sample: WorkerMemorySample): WorkerRotationAction => {
  const level = classifyWorkerMemory(sample);
  return level === "hard" ? "hard" : level === "soft" ? "soft" : "none";
};

/**
 * worker 模式记账点调用：sample 命中软/硬线即触发已登记的回调。绝不 throw。
 */
export const maybeFireWorkerRotation = (
  taskId: string,
  sample: WorkerMemorySample,
): WorkerRotationAction => {
  try {
    const action = workerRotationActionFor(sample);
    if (action !== "none") midRunRotationTriggers.get(taskId)?.(action);
    return action;
  } catch {
    return "none";
  }
};

// ---------- v3.1 接线层：worker 样本注册 + 双限额计数 ----------
//
// worker 自监控上报经 IPC 到主进程后调 reportWorkerMemorySample 登记最新样本；
// recordTurnUsage 探针（flag 开）读样本走新路径，无样本回落老路径（fail-safe）。
// 计数器与 task-runner 存量 midRunRotationCounts 相互独立（新路径切段走新计数，
// 老路径计数不动），双限额任一超限即降级提示用户。

const workerSamples = new Map<string, WorkerMemorySample>();

/** worker 自上报中继调用（绝不 throw）。 */
export const reportWorkerMemorySample = (taskId: string, sample: WorkerMemorySample): void => {
  try {
    workerSamples.set(taskId, sample);
  } catch {
    /* 埋点不许反伤 */
  }
};

export const getWorkerMemorySample = (taskId: string): WorkerMemorySample | null => {
  try {
    return workerSamples.get(taskId) ?? null;
  } catch {
    return null;
  }
};

export const clearWorkerMemorySamples = (): void => {
  workerSamples.clear();
};

/** ③修复：task 换代时清旧样本（防旧 task 样本残留误触发）。单测隔离亦用此。 */
export const clearWorkerMemorySample = (taskId: string): void => {
  try {
    workerSamples.delete(taskId);
  } catch {
    /* 埋点不许反伤 */
  }
};

interface RotationCounters {
  perAction: Map<string, number>;
  perTaskHour: Map<string, { windowStart: number; count: number }>;
  perTaskTotal: Map<string, number>;
}

const counters: RotationCounters = {
  perAction: new Map(),
  perTaskHour: new Map(),
  perTaskTotal: new Map(),
};

const HOUR_MS = 3600 * 1000;
const COUNTERS_MAX = 500;

const evictCounters = (): void => {
  for (const m of [counters.perAction, counters.perTaskHour, counters.perTaskTotal] as const) {
    while (m.size > COUNTERS_MAX) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
  }
};

export interface WorkerRotationProbeResult {
  action: WorkerRotationAction;
  fired: boolean;
  denyReason?: string;
}

/**
 * flag 开的探针实现：样本缺失 → {none, fired:false}（调用方回落老路径）；
 * 命中软/硬线 → 双限额检查 → 允许则计数+触发回调（含档位），超限则降级不触发。
 * 自然完成回退计数由调用方负责（另见 clearWorkerRotationCounters 测后清理）。
 */
export const probeWorkerRotation = (
  taskId: string,
  actionId: string | null | undefined,
  sample: WorkerMemorySample | null,
  now = Date.now(),
): WorkerRotationProbeResult => {
  try {
    if (!sample) return { action: "none", fired: false };
    const action = workerRotationActionFor(sample);
    if (action === "none") return { action, fired: false };
    const actionKey = actionId ?? taskId;
    const hour = counters.perTaskHour.get(taskId);
    const hourCount = hour && now - hour.windowStart < HOUR_MS ? hour.count : 0;
    const allowed = isRotationAllowed({
      actionCount: counters.perAction.get(actionKey) ?? 0,
      taskHourCount: hourCount,
      taskTotalCount: counters.perTaskTotal.get(taskId) ?? 0,
    });
    if (!allowed.allowed) {
      return { action, fired: false, denyReason: allowed.reason };
    }
    counters.perAction.set(actionKey, (counters.perAction.get(actionKey) ?? 0) + 1);
    counters.perTaskTotal.set(taskId, (counters.perTaskTotal.get(taskId) ?? 0) + 1);
    if (hour && now - hour.windowStart < HOUR_MS) {
      hour.count += 1;
    } else {
      counters.perTaskHour.set(taskId, { windowStart: now, count: 1 });
    }
    evictCounters();
    midRunRotationTriggers.get(taskId)?.(action);
    return { action, fired: true };
  } catch {
    return { action: "none", fired: false };
  }
};

export const clearWorkerRotationCounters = (): void => {
  counters.perAction.clear();
  counters.perTaskHour.clear();
  counters.perTaskTotal.clear();
};
