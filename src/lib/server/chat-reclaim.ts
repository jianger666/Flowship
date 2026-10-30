/**
 * X3：chat 热会话回收的共享口径（纯逻辑 + 全局计数；不 import chat-runner / run-perf，防循环依赖）。
 *
 * 背景（实测证据见 HANDOFF 的 X3 小节）：chat 会话空闲 12 分钟才回收，但「两边接力」（定时 / 评审）都是
 * 每 10 分钟来一条，会话永远等不到空闲 → 一个长会话（Cursor SDK 在进程里持有整段对话数据）在 server
 * 进程堆里占约 2 GB，约 6~7 小时堆耗尽、server 崩溃重启。这里放四件事：
 *   1. 「这个会话现在能不能回收」的唯一判定——空闲清扫器 / 定时 run 收尾 / 水位门三处共用，口径不漂移；
 *   2. 水位门的候选排序（占用从大到小，永远排除本次要服务的会话）；
 *   3. 回收计数（idle / scheduled-end / watermark）；
 *   4. 热会话探针——给 run-perf 的 proc 遥测读（崩前留证据，下次不必靠推断）。
 *
 * 不在这里做的事：真正关会话（要碰 chat-runner 私有状态，留在 chat-runner）；改空闲 TTL（仍 12 分钟）。
 */

import { isScheduleBoilerplateText } from "@/lib/chat-stream-display";

// ─────────────────────────── 常量 ───────────────────────────

/**
 * 软水位：堆占用（used / limit）≥ 此值时，chat 入口先回收「空闲、可回收」的热会话（不拒单）。
 * 硬水位沿用 sdk-store-gc 的 HEAP_GUARD_RATIO（0.85）：回收之后仍 ≥ 它才拒新活。
 */
export const CHAT_WATERMARK_SOFT_RATIO = 0.7;

/**
 * 定时触发的 run 自然结束后，等这么久再回收会话：让「收尾后立刻 drain 队列 / 送后台结果 / 用户秒回」
 * 先有机会起新 run（它们会让守卫或 runSeq 变化而放弃回收）。unref，不拖进程退出。
 */
export const SCHEDULED_RUN_RECLAIM_GRACE_MS = 45_000;

/** 空闲清扫器的拍点。TTL（12 分钟）不变——只是不再最坏等 TTL + 10 分钟才发现。 */
export const CHAT_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

// ─────────────────────────── 回收守卫 ───────────────────────────

export type ChatReclaimReason = "idle" | "scheduled-end" | "watermark";

/** 不能回收的原因（只用来写日志 / 测试断言；是否能回收只看「返回 null 与否」） */
export type ChatReclaimBlock =
  | "cold-start"
  | "closing"
  | "run-active"
  | "background-subagent"
  | "queued"
  | "draining"
  | "pending-ask"
  | "inflight-steer"
  | "pending-bg-results"
  | "rewind";

/** 判定所需的现读快照（由 chat-runner 在同步段里读出来，此处只做纯判定） */
export interface ChatReclaimSnapshot {
  /** false = 冷启动占位期（agent 还没挂上），此时关会话会和 runChatSession 打架 */
  hasAgent: boolean;
  /**
   * getChatLifecycle 的值：非空 = stopping / deleting / finalizing / reopening 等收尾窗口，
   * 已有别的流程在管这个会话（摘会话、清队、改状态），回收不插手
   */
  lifecycle?: string | null;
  runActive: boolean;
  /** 在跑的后台子代理数：关会话会连它们一起取消、结果丢失 */
  backgroundRunning: number;
  /** 聊天队列里等着送的消息数 */
  queueCount: number;
  /** flushChatQueue 正在 drain（dequeue → send 之间） */
  draining: boolean;
  /** 有挂起的 ask_user（答案要回到同一会话） */
  pendingAsk: boolean;
  /** 「立即发送」steer 在飞的消息数 */
  inflightSteers: number;
  /** 攒着还没送进主 AI 的后台子代理结果条数 */
  pendingBackgroundResults: number;
  /** 检查点回退进行中 */
  rewindInProgress: boolean;
}

/**
 * 能回收返回 null；不能回收返回第一个命中的原因。
 * 任何一条命中都不回收——回收的代价只是下一条消息要 resume 一次，而误回收的代价是丢后台子代理 / 待答 / 在飞消息。
 */
export const chatReclaimBlockReason = (
  s: ChatReclaimSnapshot,
): ChatReclaimBlock | null => {
  if (!s.hasAgent) return "cold-start";
  if (s.lifecycle) return "closing";
  if (s.runActive) return "run-active";
  if (s.backgroundRunning > 0) return "background-subagent";
  if (s.queueCount > 0) return "queued";
  if (s.draining) return "draining";
  if (s.pendingAsk) return "pending-ask";
  if (s.inflightSteers > 0) return "inflight-steer";
  if (s.pendingBackgroundResults > 0) return "pending-bg-results";
  if (s.rewindInProgress) return "rewind";
  return null;
};

/**
 * 发给 agent 的这段文本是不是「定时触发」（`[SCHEDULE_FIRED id=…]` 开头）。
 * 为什么按文本认：定时消息从 chat-inject 到 agent.send 有三条起点（热会话直发 / resume 后发 / 冷启动首包），
 * 文本前缀在三处都在，不用给每条调用链加标志位；误判（用户手贴了这个前缀）与漏判（前面被加了别的前缀）
 * 的后果都只是「45 秒后回收 / 退回 12 分钟 TTL」，会话随时能 resume，不丢数据。
 */
export const isScheduledRunText = (text: string): boolean =>
  isScheduleBoilerplateText(text);

// ─────────────────────────── 水位门候选排序 ───────────────────────────

export interface ChatReclaimCandidate {
  taskId: string;
  /** 占用估算（字节）：SDK store 里该会话的数据量；取不到记 0 */
  usageBytes: number;
  lastActiveAt: number;
}

/**
 * 水位门回收顺序：占用从大到小；占用相同（含全取不到）则空闲最久的先回收；再按 taskId 保证稳定。
 * `exceptTaskId` = 本次要服务的会话，永远不进候选（不能为了给它腾堆把它自己关了）。
 */
export const rankReclaimCandidates = (
  list: readonly ChatReclaimCandidate[],
  exceptTaskId?: string,
): ChatReclaimCandidate[] =>
  list
    .filter((c) => c.taskId !== exceptTaskId)
    .sort(
      (a, b) =>
        b.usageBytes - a.usageBytes ||
        a.lastActiveAt - b.lastActiveAt ||
        (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
    );

/** 占用估算器：返回该 agent 在 SDK store 里的数据字节数；取不到返回 undefined */
export type ChatUsageEstimator = (
  agentId: string,
) => Promise<number | undefined>;

/**
 * 默认估算器：与 run-perf 的 store.agentMB 同源（只看不开 store——观测 / 排序绝不能因此触发 store 打开）。
 * 估算只用来排顺序，不影响「回不回收」，所以取不到就当 0。
 */
export const defaultChatUsageEstimator: ChatUsageEstimator = async (agentId) => {
  try {
    const { peekSdkStoreHandle } = await import("./sdk-agent-store");
    const handle = await peekSdkStoreHandle();
    return handle?.fast?.agentStats(agentId)?.bytes;
  } catch {
    return undefined;
  }
};

// ─────────────────────────── 全局计数 + 热会话探针 ───────────────────────────

export interface ChatHotSession {
  taskId: string;
  agentId: string;
  /** 距最近活跃（run 结束 / send）多久，ms */
  idleMs: number;
  runActive: boolean;
  backgroundRunning: number;
}

export interface ChatReclaimCounts {
  idle: number;
  scheduledEnd: number;
  watermark: number;
}

interface ChatReclaimGlobal {
  counts: ChatReclaimCounts;
  hotProbe?: () => ChatHotSession[];
}

// 与 chat-runner 同口径：状态挂 globalThis，dev hot reload 不拆分
const CHAT_RECLAIM_GLOBAL_KEY = "__flowshipChatReclaimV1__";

const getState = (): ChatReclaimGlobal => {
  const g = globalThis as unknown as Record<
    string,
    ChatReclaimGlobal | undefined
  >;
  if (!g[CHAT_RECLAIM_GLOBAL_KEY]) {
    g[CHAT_RECLAIM_GLOBAL_KEY] = {
      counts: { idle: 0, scheduledEnd: 0, watermark: 0 },
    };
  }
  return g[CHAT_RECLAIM_GLOBAL_KEY]!;
};

/** 记一次回收（自进程启动累计） */
export const recordChatReclaim = (reason: ChatReclaimReason): void => {
  const c = getState().counts;
  if (reason === "idle") c.idle += 1;
  else if (reason === "scheduled-end") c.scheduledEnd += 1;
  else c.watermark += 1;
};

export const getChatReclaimCounts = (): ChatReclaimCounts => ({
  ...getState().counts,
});

/** chat-runner 加载时登记「现在有哪些热会话」的读取函数（run-perf 经它取数，不反向 import chat-runner） */
export const registerChatHotProbe = (
  probe: (() => ChatHotSession[]) | undefined,
): void => {
  getState().hotProbe = probe;
};

/** 没登记探针（server 刚起、chat-runner 还没加载）返回 undefined，调用方据此省略遥测字段 */
export const getChatHotSessions = (): ChatHotSession[] | undefined => {
  const probe = getState().hotProbe;
  if (!probe) return undefined;
  try {
    return probe();
  } catch {
    return undefined;
  }
};

/**
 * 仅测试：清零计数；默认连探针一起清。
 * 探针是 chat-runner 加载时登记的——真实 chat-runner 的测试要传 `keepProbe: true`，否则清掉后没人再登记。
 */
export const __resetChatReclaimForTests = (opts?: {
  keepProbe?: boolean;
}): void => {
  const s = getState();
  s.counts = { idle: 0, scheduledEnd: 0, watermark: 0 };
  if (!opts?.keepProbe) s.hotProbe = undefined;
};
