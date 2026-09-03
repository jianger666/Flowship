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

/** 从 Task 取水位输入 */
export const rotationUsageOf = (
  task: Pick<Task, "sessionInputTokens" | "tokenUsage">,
): RotationUsageLike => ({
  sessionInputTokens: task.sessionInputTokens,
  totalInputTokens: task.tokenUsage?.total.inputTokens,
});
