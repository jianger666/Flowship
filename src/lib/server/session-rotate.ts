/**
 * chat 会话保命轮换（2026-09-03 OOM 根治：最小可用版）
 *
 * 背景（2026-09-03 的判断；其中「SDK 无自动压缩」已于 2026-10-08 更正，见文末）：
 * 单 chat 窗口连跑 9 个子代理后累计 input 278 万、单轮 56 万，
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
 *
 * ── 2026-10-08：token 水位（50 万速度水位 + 200 万保命水位）默认关闭 ──
 * 更正：SDK 有自动摘要 / 压缩（含带 auto|manual 触发标记的 preCompact 钩子，1.0.31 与
 * 1.0.37 实现一致），只是相关事件在 SDK 的 onDelta 里被故意过滤，Flowship 事件流看不到——
 * 看不到不等于没有。
 * 真正让会话「越聊越卡 / 内存暴涨」的是 SDK JSONL store 的 checkpoints：每次 get/create/
 * update/list 整份读入、整文件重写，内存放大约 28 倍（见 fast-checkpoint-store.ts），
 * 已在 store 层修掉。而本文件的水位看的 sessionInputTokens 是「累计发送量」——每个工具步骤
 * 都会重发整段上下文，单个 run 就能累计上千万——与上下文大小 / 堆占用只是间接相关，
 * 触发一次就轮换一次 = AI 失忆。所以两道 token 水位一并关闭，不再因 token 累计量轮换。
 * 回滚：设环境变量 FLOWSHIP_TOKEN_WATERMARK=1 后重启，原行为（阈值常量不变）整体恢复。
 * 没动的：基于真实堆占用的 85% 拒单门（sdk-store-gc 的 assertHeapOk）——它看的是真实内存，
 * 不是 token 累计。
 *
 * ── 2026-10-09：worker 隔离整体删除 ──
 * 原先这里还有一套「worker 内存样本 → 软 / 硬线 → 双限额 → 触发 run 内轮换」的新路径
 * （workerRotationActionFor / probeWorkerRotation 等），随 worker 子系统一并删除；
 * run 内轮换只剩下面 maybeFireMidRunRotation 这一条（token 水位 AND 堆过半）。
 */

import type { Task } from "@/lib/types";
import { heapPressure } from "./sdk-store-gc";

/** 当前 SDK 会话累计 input 超过此值 → 下轮轮换（同事实测崩时 278 万） */
export const ROTATE_SESSION_INPUT_TOKENS = 2_000_000;

/**
 * 速度水位（2026-09-24）：只管发送快慢，不管保命。
 * 会话累计 input 超过此值 → 下轮轮换（受理回到小上下文基线）。
 * 与内存水位（2M）解耦：后者防 OOM 谁也不许调；这个只关受理快慢和 token 花费。
 * 只认 sessionInputTokens（新锚点清零的那路）——绝不用 totalInputTokens 兜底，
 * 否则老任务一辈子 total 巨大、每条都转，死循环。缺字段 = 不转（fail-safe）。
 */
export const ROTATE_PERF_INPUT_TOKENS = 500_000;

/** 轮换时落盘的 info 事件文案（事件流里显示为灰色居中细线、无需 UI 改动） */
export const SESSION_ROTATION_INFO_TEXT =
  "上下文过长，已自动压缩续接，本窗口用新会话继续，上方历史仍保留。";

export interface RotationUsageLike {
  /** 当前 SDK 会话累计 input（recordTurnUsage 累加、新建锚点清零） */
  sessionInputTokens?: number;
  /** 兜底：老任务缺字段时用累计 total 估算（转一次即自愈、之后走正常计数） */
  totalInputTokens?: number;
}

/** token 水位总开关环境变量。仅显式 `1` / `true` 开启，缺省 = 关。 */
export const TOKEN_WATERMARK_ENV = "FLOWSHIP_TOKEN_WATERMARK" as const;

/** 两道 token 水位（速度 50 万 / 保命 200 万）是否启用。默认关闭，原因见文件头。 */
export const isTokenWatermarkEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const v = (env[TOKEN_WATERMARK_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
};

/**
 * 水位到了返 true（总开关关闭时恒 false）。缺字段（老任务）→ 用 total 估算，再缺 = 不转。
 * 除总开关外是纯函数。
 */
export const isSessionRotationDue = (u: RotationUsageLike): boolean =>
  isTokenWatermarkEnabled() &&
  (u.sessionInputTokens ?? u.totalInputTokens ?? 0) >=
    ROTATE_SESSION_INPUT_TOKENS;

/**
 * 速度水位到了返 true（总开关关闭时恒 false）。
 * 只认 sessionInputTokens（见 ROTATE_PERF_INPUT_TOKENS 注释）。
 */
export const isPerfRotationDue = (u: RotationUsageLike): boolean =>
  isTokenWatermarkEnabled() &&
  (u.sessionInputTokens ?? 0) >= ROTATE_PERF_INPUT_TOKENS;

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

/** run 内轮换触发器（无参回调；由 task-runner 在拿到 run 之后登记）。 */
export type MidRunRotationTrigger = () => void;

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
