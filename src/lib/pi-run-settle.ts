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

/**
 * 自定义端点「回了 200、却没给任何内容」时 run 的收尾文案（R14 Q11-01）。
 *
 * 为什么要有这条：端点地址填成网页（200 + HTML）、网关吞了正文、模型直接空 stop——pi 都当「正常结束」。
 * Flowship 为兼容缺 finish_reason 的网关把 supportsFinishReason 关了（custom-openai-compat.ts），
 * 流里没有 finish_reason 时 pi 自己补成 stop；于是 wait() 返回 finished、回复为空、没有任何错误，
 * 用户看到「已完成」却什么都没有。
 *
 * 文案约束（tests/custom-agent-empty-reply.test.ts 钉着）：
 * - 关键句放最前：chat-runner / task-runner 把 result 截到前 200 字符拼进 `agent run status=error: …`；
 * - 不含 isRetryableRunError 兜底正则里的词（network / fetch failed / unavailable / aborted …）：
 *   那会被当成断线自动重连，对着同一个坏地址重复请求；
 * - 错误卡（lib/error-classify.ts 的 endpoint 类）按「模型没有返回任何内容」这句识别，两边文案一致由测试钉着。
 */
export const EMPTY_REPLY_MESSAGE =
  "模型没有返回任何内容（可能是接口地址填成了网页、模型名不对，或端点异常）。到设置里检查接口地址和模型名后再试。";

/**
 * pi 内层自动重试开始时，那半截回复里已经亮起（running）却永远等不到执行结果的工具调用，补成 error 用的说明
 * （R14 Q11-02）。pi 对「以错误收尾的 assistant 消息」不会执行里面的工具，所以「这次调用没有执行」是事实。
 */
export const RETRY_INTERRUPTED_TOOL_RESULT = "连接中断，这次调用没有执行";

/**
 * 一条 assistant 消息有没有「用户看得见的产出」：非空白正文，或至少一个工具调用。
 * 思考（thinking）不算——只想不说，用户这边仍是一条空回复；正文只有空白也不算（屏幕上是个空气泡）。
 * message_end 时用它兜底：事件流里的 text_delta / toolcall_end 是实时信号，这里是整条消息的权威口径。
 */
export const assistantMessageHasOutput = (msg: unknown): boolean => {
  if (!isAssistant(msg)) return false;
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content.trim() !== "";
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "toolCall") return true;
    return b.type === "text" && typeof b.text === "string" && b.text.trim() !== "";
  });
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
