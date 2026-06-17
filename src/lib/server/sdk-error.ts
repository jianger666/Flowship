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
    // CursorSdkError 还挂了 endpoint / operation / isRetryable——一并收、便于区分认证 / 限流 / 网络
    if (typeof e.endpoint === "string") bits.endpoint = e.endpoint;
    if (typeof e.operation === "string") bits.operation = e.operation;
    if (typeof e.isRetryable === "boolean") bits.isRetryable = e.isRetryable;
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

/**
 * 「长连接被断」类裸 run 失败的识别 + 用户友好文案（V0.8.x）
 *
 * 单 SDK Run 模型下、run 跨 action 挂在 shell curl 长连接上等用户 ack（可挂数小时）。
 * 这条长连接最常见的死法就是「被断」：等太久 / 本地网抖 / 代理·LB 砍 idle 连接 /
 * 笔记本休眠 / Cursor 后端回收久挂的 run。此时 SDK 给的是 status=error|expired、
 * 且 message 全空、错误对象也无 code/cause——拿不到任何诊断、只剩一坨 run 元数据 dump。
 *
 * 这类对用户没有信息量、还吓人（原文「agent run status=error --- SDK result dump --- {...}」）。
 * 识别出来后事件流里换成一句「长连接已断开」友好提示；真·有诊断的错
 * （认证 / 限流 / MCP / agent 协议错）照旧展示详情、方便定位根因。
 */

// 裸 status=error/expired：status 后面只跟 result dump（run 元数据）或直接到串尾、
// 不带任何人类可读诊断段（--- SDK stream error message --- / inline `: 详情`）。
// 命中即「无诊断」、配合「错误对象也无 code/cause」一起判、才算长连接被断。
const BARE_RUN_DROP_RE =
  /^agent run status=(?:error|expired)(?:\s*\n--- SDK result dump|\s*$)/;

const DUMP_MARKER = "--- SDK result dump ---";

/**
 * run dump（RunResult JSON）里除了 run 元数据（id/status/model/durationMs/...）、
 * 若还带诊断字段（result/message/error/reason 非空）说明 SDK 给了线索、
 * 不能当「无诊断的连接断」吞掉（reviewAI P1：把「dump 仅元数据」这个 RCA 前提写进代码边界）。
 *
 * dump 被 slice(1500) 截断 / 非法 JSON 时 parse 失败 → 解析不出诊断、返回 false
 * 不据此 demote（BARE_RUN_DROP_RE + bits 仍是主闸、且 task-runner 已把 result.result inline、
 * 最常见的诊断字段在进 dump 前就已让正则失配）。
 */
const dumpHasDiagnostic = (rawMessage: string): boolean => {
  const idx = rawMessage.indexOf(DUMP_MARKER);
  if (idx < 0) return false;
  const jsonStr = rawMessage.slice(idx + DUMP_MARKER.length).trim();
  if (!jsonStr) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const d = parsed as Record<string, unknown>;
  for (const k of ["result", "message", "error", "reason"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim()) return true;
    // 非空对象（如 error:{code:...}）才算诊断；空对象 {} 不算、避免无信息量却误 demote
    if (v && typeof v === "object" && Object.keys(v).length > 0) return true;
  }
  return false;
};

export interface RunFailureSummary {
  // 落事件流的文案：连接断 / 额度时是友好提示、否则是带详情的原始错误串
  text: string;
  // 是否「裸 status=error 无诊断」类（连接断 or 额度用完、二者 SDK 层无法区分）——
  // 调用方据此决定要不要加「失败 / 异常」前缀
  isConnectionDrop: boolean;
  // 完整原始诊断串（message + SDK 字段、始终算出）。连接断 / 额度时 text 是友好文案、
  // 但 detail 仍保留原始——调用方落进 error event 的 meta、事后可从 events.jsonl 直接定位、
  // 不必翻 app console。这也是排查「额度 vs 连接断」唯一能留下的线索（SDK 公开 API 不暴露 errorCode）。
  detail: string;
}

// 「裸 status=error 无诊断」的友好文案。
// 关键事实（2026-06-16 实测 + 调研 @cursor/sdk 1.0.17）：run.wait() 的 RunResult / stream 的
// SDKStatusMessage / 公开 getRun 返回的 Run 都**不暴露 errorCode**——额度用完和长连接断在 SDK 公开层
// 返回完全一样（裸 status=error、message/result 空）、服务端无法区分。所以文案兼列两种最常见原因、
// 引导用户自行确认额度、不把额度用完误导成纯网络问题。
const BARE_RUN_DROP_TEXT =
  "本轮异常结束——可能是长连接断开（等待太久 / 网络·代理中断 / 电脑休眠），也可能是 Cursor 额度·用量已用完。请先确认账号额度；额度正常多为连接断开、重新发起本轮通常可恢复。";

/**
 * 把 run 失败归一成「给用户看的事件文案」+ 始终算出的原始 detail。
 * - 裸 status=error 无诊断（连接断 / 额度用完、SDK 层无法区分）→ 友好一句话、不加吓人前缀
 * - 其它（有诊断）→ 复用 buildSdkErrorMessage 的详情串、调用方自行加「失败 / 异常」前缀
 */
export const summarizeRunFailure = (
  rawMessage: string,
  err: unknown,
): RunFailureSummary => {
  const bits = extractSdkErrorBits(err);
  // 始终算原始诊断、落 meta（连接断 / 额度时 UI 显示友好文案、但原始细节不丢）
  const detail = buildSdkErrorMessage(rawMessage, err);
  // 三道闸全过才算「裸 status=error 无诊断」：①裸 status 形态 ②err 无 code/cause（保守：有 code
  // 先当真错留详情、含 14 UNAVAILABLE / 4 DEADLINE 这类会走详情分支、属可接受 false-negative）
  // ③dump 里没塞诊断字段。误吞比漏报更伤、所以宁可少判、不可吞掉 RCA 线索。
  const isConnectionDrop =
    BARE_RUN_DROP_RE.test(rawMessage) &&
    Object.keys(bits).length === 0 &&
    !dumpHasDiagnostic(rawMessage);
  if (isConnectionDrop) {
    // 「通常可恢复」不写死「即可恢复」——resume 可能因后端已清 run 失败、不过度承诺（reviewAI P2）。
    return { isConnectionDrop: true, text: BARE_RUN_DROP_TEXT, detail };
  }
  return { isConnectionDrop: false, text: detail, detail };
};
