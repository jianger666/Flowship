/**
 * pi 自定义 run 收尾：本轮算不算失败。
 *
 * pi 把 HTTP 503 等写进 assistant（stopReason=error），内部会重试；重试成功后
 * 会话里仍留着那条空错误。从后往前扫整段历史会把已恢复的 503 当成最终失败，
 * wait() 报 error → 宿主「连接中断、正在自动重连」。只认最后一条 assistant。
 */

import { fatalAssistantError } from "@/lib/custom-openai-compat";

const isAssistant = (msg: unknown): boolean =>
  !!msg && typeof msg === "object" && (msg as { role?: unknown }).role === "assistant";

/**
 * pi 把 HTTP 400 / 503 写进 assistant 消息（stopReason=error），prompt() 不抛。
 * 从单条消息抠 errorMessage；缺 finish_reason 不当失败。
 */
export const readAssistantError = (msg: unknown): string | null => {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  };
  if (m.role !== "assistant") return null;
  if (m.stopReason !== "error" && m.stopReason !== "aborted") return null;
  const raw =
    typeof m.errorMessage === "string" && m.errorMessage.trim()
      ? m.errorMessage.trim()
      : `模型请求失败（${String(m.stopReason)}）`;
  return fatalAssistantError(raw);
};

export const lastAssistantMessage = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) return isAssistant(messages) ? messages : null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistant(messages[i])) return messages[i];
  }
  return null;
};

/**
 * 本轮是否应以失败收尾。最后一条 assistant 已是 stop / toolUse → 中途 503 作废。
 * 没有 assistant 时才回落到粘性错误（prompt 还没吐出消息就挂了）。
 */
export const settleErrorFromTranscript = (
  messages: unknown,
  stickyError?: string | null,
): string | null => {
  const last = lastAssistantMessage(messages);
  if (last) return readAssistantError(last);
  return fatalAssistantError(stickyError);
};

/** message_end：失败则记下；后续成功的 assistant 清掉，避免粘性错误污染 settle。 */
export const stickyErrorAfterMessageEnd = (
  sticky: string | null,
  msg: unknown,
): string | null => {
  const err = readAssistantError(msg);
  if (err) return err;
  if (isAssistant(msg)) return null;
  return sticky;
};
