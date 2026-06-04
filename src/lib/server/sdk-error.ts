/**
 * SDK 错误详情提取（V0.6.12、task-runner / chat-runner 共用）
 *
 * @cursor/sdk 抛的 ConnectError 等错误对象、message 往往只是「agent run status=error」/
 *「Network request failed」这种概要、真正有用的 code（gRPC/connect code、如 16=unauthenticated）
 * 跟 cause 挂在对象字段上。两个 runner 的 run catch 共用这里、把详情一并落到 error event、
 * 方便事后直接从 events 定位根因（网络 / 限流 / 认证 / ...）、不用翻 dev server console。
 */

/**
 * 从 error 对象抠出结构化字段：code / status / requestId / cause。
 * err 不是对象、或取字段抛错时静默兜底、返回已收集到的部分。
 */
export const extractSdkErrorBits = (err: unknown): Record<string, unknown> => {
  const bits: Record<string, unknown> = {};
  try {
    const e = err as Record<string, unknown>;
    // ConnectError.code 是 number（如 16=unauthenticated）；个别 SDK 用 string code、两种都收
    if (typeof e.code === "string" || typeof e.code === "number") {
      bits.code = e.code;
    }
    if (typeof e.status === "number") bits.status = e.status;
    if (typeof e.requestId === "string") bits.requestId = e.requestId;
    if (e.cause instanceof Error) {
      bits.causeName = e.cause.name;
      bits.causeMessage = e.cause.message;
    }
  } catch {
    /* noop：err 非对象 / 取字段抛错时静默、bits 保留已收集部分 */
  }
  return bits;
};

/**
 * message + SDK 详情拼成完整可读错误串（无详情时只回 message）。
 * 两个 runner 写 error event 时统一走这个、文案口径一致。
 */
export const buildSdkErrorMessage = (message: string, err: unknown): string => {
  const bits = extractSdkErrorBits(err);
  return Object.keys(bits).length > 0
    ? `${message}\n--- SDK error fields ---\n${JSON.stringify(bits, null, 2)}`
    : message;
};
