/**
 * 自定义 OpenAI 兼容端的流 compat + 残缺收尾识别。
 *
 * pi 默认 `supportsFinishReason=true`：上游关连接时最后一个 chunk 不带
 * `finish_reason` 就抛 `Stream ended without finish_reason`，run 被标失败、
 * 还会自动重试（用户看到「一直吐字然后失败」）。OpenCode / 自建代理经常这样
 * 收尾，正文其实已经写完。关掉该开关后 pi 按已有正文当 stop / toolUse。
 *
 * 代价：流里一个 chunk 都没有（地址填成网页、200 + HTML）或只有空 stop 时，pi 同样按 stop 收尾——
 * run 看起来正常结束、却没有任何产出。这类由 custom-agent-backend.ts 的 PiRunAdapter 兜底：
 * 整个 run 没出现过非空白正文 / 工具调用就以 error 收尾（R14 Q11-01，文案见 pi-run-settle.ts 的
 * EMPTY_REPLY_MESSAGE）。
 */

export const OPENAI_STREAM_COMPAT = {
  supportsUsageInStreaming: false,
  supportsFinishReason: false,
  maxTokensField: "max_tokens" as const,
};

const BENIGN_STREAM_END_RE = /stream ended without finish_reason/i;

export const isBenignOpenAiStreamEnd = (
  message: string | null | undefined,
): boolean => typeof message === "string" && BENIGN_STREAM_END_RE.test(message);

/** 真失败留下文案；缺 finish_reason 这种残缺收尾当没出错 */
export const fatalAssistantError = (
  message: string | null | undefined,
): string | null => {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (isBenignOpenAiStreamEnd(trimmed)) return null;
  return trimmed;
};
