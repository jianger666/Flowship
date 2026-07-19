/**
 * Chat 会话 token 透视（P4.1 /context）
 *
 * run-perf 在 turn-ended 记 usage 时同步写入本 Map；
 * 会话关闭不清（保留最后值）；进程重启后无数据 → totalTokens: null。
 */

/** 建议压缩阈值：最近 turn inputTokens 超过则 compactRecommended=true（将来可调） */
export const COMPACT_RECOMMENDED_INPUT_TOKENS = 200_000;

/**
 * 自动压缩阈值（绝对值）。
 * 我们没有精确 context window 数字；按 GB 约 85% context 粗估，从 260k inputTokens 起步。
 * 超阈值 → run 收尾自动 compact；失败再落 info 让用户手动。
 */
export const COMPACT_SUGGEST_INFO_INPUT_TOKENS = 260_000;

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
  /**
   * 本会话是否已尝试过自动 compact（成功或失败都算）。
   * 失败降级后不再死循环重试；新会话（首包重建）清零。
   */
  autoCompactAttempted?: boolean;
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

/** 记下首包字节（每次 chat-first / 压缩重建会话时覆盖） */
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
    // 压缩重建后 turn 计数可延续；首包字节必须换成新会话的
    turnCount: cur?.turnCount ?? 0,
    lastTurnAt: cur?.lastTurnAt ?? 0,
    firstPromptBytes: promptBytes,
    // 保留 autoCompactAttempted：压缩续接首包不能清，否则续接 turn 仍超阈值会死循环再压
    autoCompactAttempted: cur?.autoCompactAttempted,
  });
};

/** turn-ended 时写入最近 usage（会话关闭不清） */
export const recordChatTurnUsage = (
  taskId: string,
  usage: ChatTurnUsage,
): ChatContextUsageRecord => {
  const map = getUsageState().byTask;
  const cur = map.get(taskId);
  // 上下文已明显降到阈值一半以下 → 允许下次再自动压（成功压缩后的正常路径）
  let attempted = cur?.autoCompactAttempted;
  if (usage.inputTokens < COMPACT_SUGGEST_INFO_INPUT_TOKENS * 0.5) {
    attempted = false;
  }
  const next: ChatContextUsageRecord = {
    lastUsage: usage,
    turnCount: (cur?.turnCount ?? 0) + 1,
    lastTurnAt: Date.now(),
    firstPromptBytes: cur?.firstPromptBytes ?? null,
    autoCompactAttempted: attempted,
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

/** 标记本会话已尝试自动 compact（成功/失败都调，防死循环） */
export const markChatAutoCompactAttempted = (taskId: string): void => {
  const map = getUsageState().byTask;
  const cur = map.get(taskId);
  if (!cur) {
    // 尚无 usage 记录也占位，避免紧接着又触发
    map.set(taskId, {
      lastUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      turnCount: 0,
      lastTurnAt: 0,
      firstPromptBytes: null,
      autoCompactAttempted: true,
    });
    return;
  }
  map.set(taskId, { ...cur, autoCompactAttempted: true });
};

/**
 * 纯函数：run 收尾是否应触发自动 compact。
 * 阈值沿用 COMPACT_SUGGEST_INFO_INPUT_TOKENS；已尝试过则不再自动。
 */
export const shouldAutoCompactAfterTurn = (
  inputTokens: number,
  autoCompactAttempted: boolean,
): boolean =>
  inputTokens > COMPACT_SUGGEST_INFO_INPUT_TOKENS && !autoCompactAttempted;

/** bytes → 粗估 tokens（GB / 业界惯例 ≈ bytes/4） */
export const estimateTokensFromBytes = (bytes: number): number =>
  Math.max(0, Math.round(bytes / 4));

export type ChatContextApiPayload = {
  totalTokens: number | null;
  breakdown: Array<{ label: string; tokens: number }>;
  turnCount: number;
  lastTurnAt: number | null;
  compactRecommended: boolean;
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
      compactRecommended: false,
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
    compactRecommended: input > COMPACT_RECOMMENDED_INPUT_TOKENS,
  };
};
