/**
 * Chat 会话 token 透视（P4.1 /context）
 *
 * run-perf 在 turn-ended 记 usage 时同步写入本 Map；
 * 会话关闭不清（保留最后值）；进程重启后无数据 → totalTokens: null。
 *
 * 注意：turn-ended 的 inputTokens 是整 turn 内所有 LLM 步的累计（每步工具循环
 * 重发全上下文、重复计数），不能当真实上下文窗口占用——仅作粗略透视。
 */

export type ChatTurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export type ChatContextUsageRecord = {
  /** 最近一次 turn 的 usage */
  lastUsage: ChatTurnUsage;
  turnCount: number;
  lastTurnAt: number;
  /**
   * 首包 prompt 字节数（chat-first 时记下）。
   * breakdown「首包注入」用 bytes/4 估 tokens；会话关闭后仍保留。
   */
  firstPromptBytes: number | null;
};

interface ChatUsageGlobalState {
  byTask: Map<string, ChatContextUsageRecord>;
}

const CHAT_USAGE_GLOBAL_KEY = "__flowshipChatContextUsageV1__";

const getUsageState = (): ChatUsageGlobalState => {
  const g = globalThis as unknown as Record<
    string,
    ChatUsageGlobalState | undefined
  >;
  if (!g[CHAT_USAGE_GLOBAL_KEY]) {
    g[CHAT_USAGE_GLOBAL_KEY] = { byTask: new Map() };
  }
  return g[CHAT_USAGE_GLOBAL_KEY]!;
};

/** 记下首包字节（每次 chat-first 时覆盖） */
export const recordChatFirstPromptBytes = (
  taskId: string,
  promptBytes: number,
): void => {
  const map = getUsageState().byTask;
  const cur = map.get(taskId);
  map.set(taskId, {
    lastUsage: cur?.lastUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    },
    turnCount: cur?.turnCount ?? 0,
    lastTurnAt: cur?.lastTurnAt ?? 0,
    firstPromptBytes: promptBytes,
  });
};

/** turn-ended 时写入最近 usage（会话关闭不清） */
export const recordChatTurnUsage = (
  taskId: string,
  usage: ChatTurnUsage,
): ChatContextUsageRecord => {
  const map = getUsageState().byTask;
  const cur = map.get(taskId);
  const next: ChatContextUsageRecord = {
    lastUsage: usage,
    turnCount: (cur?.turnCount ?? 0) + 1,
    lastTurnAt: Date.now(),
    firstPromptBytes: cur?.firstPromptBytes ?? null,
  };
  map.set(taskId, next);
  return next;
};

/** 删任务收尾：清 usage 记录（byTask 只增不删、长跑进程积键） */
export const clearChatContextUsage = (taskId: string): void => {
  getUsageState().byTask.delete(taskId);
};

export const getChatContextUsage = (
  taskId: string,
): ChatContextUsageRecord | null =>
  getUsageState().byTask.get(taskId) ?? null;

/** bytes → 粗估 tokens（GB / 业界惯例 ≈ bytes/4） */
export const estimateTokensFromBytes = (bytes: number): number =>
  Math.max(0, Math.round(bytes / 4));

export type ChatContextApiPayload = {
  totalTokens: number | null;
  breakdown: Array<{ label: string; tokens: number }>;
  turnCount: number;
  lastTurnAt: number | null;
};

/**
 * 组装 GET /context 的 context 字段。
 * 精确拆 system/messages/tools/skills/MCP 做不到 → 两档粗分：
 *   首包注入（prompt bytes/4）+ 对话累计（最近 turn input − 首包估算）
 */
export const buildChatContextPayload = (
  taskId: string,
): ChatContextApiPayload => {
  const rec = getChatContextUsage(taskId);
  // 重启后无数据 / 尚未有 turn → totalTokens: null
  if (!rec || rec.turnCount === 0) {
    return {
      totalTokens: null,
      breakdown: [],
      turnCount: 0,
      lastTurnAt: null,
    };
  }

  const input = rec.lastUsage.inputTokens;
  const firstEst =
    rec.firstPromptBytes != null
      ? estimateTokensFromBytes(rec.firstPromptBytes)
      : 0;
  const dialogEst = Math.max(0, input - firstEst);
  const breakdown: Array<{ label: string; tokens: number }> = [];
  if (firstEst > 0) {
    breakdown.push({ label: "首包注入", tokens: firstEst });
  }
  if (dialogEst > 0 || breakdown.length === 0) {
    breakdown.push({ label: "对话累计", tokens: dialogEst });
  }

  return {
    totalTokens: input,
    breakdown,
    turnCount: rec.turnCount,
    lastTurnAt: rec.lastTurnAt || null,
  };
};
