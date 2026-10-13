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
  // 命中「SDK 自己放弃了」类终态报错（见 SDK_GIVE_UP_RULES）：text 是友好文案、这类绝不自动重连
  isSdkGiveUp: boolean;
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
 * SDK 自己「放弃」本轮的终态报错（Bug #3）。
 *
 * 这两句都出自 @cursor/sdk 内部（Flowship 代码里没有），随后 run.wait() 返回 status=error：
 * - "Agent turn stopped after repeated resume attempts made no progress"
 *   SDK 内部有一层自动续接——连接异常时它不报错，而是从最近的检查点重发（检查点之后的内容会被
 *   重新生成）；连续多次续接都「收到了流数据、却没产生新检查点」就抛这句放弃。
 *   2026-10 起在 claude-sonnet-5-5 [max] 的长回合里实测出现，报错前常伴随同一问题的多遍回答。
 * - "Connection failed repeatedly"
 *   SDK 传输层连续多次连接失败后放弃。
 *
 * 共同点：SDK 内部已经自己重试 / 续接过很多次才放弃。Flowship 再自动重连一轮多半只会再来一遍
 * （续接会让模型把检查点之后的内容重新生成，用户看到的是又一遍重复回答、还白烧 token），
 * 所以：① 给一句看得懂的话，原始诊断照旧落 meta.detail（错误卡可展开）；
 * ② isRetryableRunError 一律判否，绝不自动重连。
 *
 * 文案只陈述报错本身的意思，不断言「为什么续接」——根因（服务端 / 网络 / 停滞检测）目前
 * 仍没有公开钩子可区分，不在文案里编。
 */
export interface SdkGiveUpRule {
  /** 规则标识（单测 / 日志用） */
  id: "no-progress" | "connection-failed";
  re: RegExp;
  /** 给用户看的文案 */
  text: string;
}

export const SDK_GIVE_UP_RULES: readonly SdkGiveUpRule[] = [
  {
    id: "no-progress",
    re: /repeated resume attempts made no progress/i,
    text: "SDK 在断线续接时连续多次都没能继续（没有存下新进度），已放弃本轮。已生成的内容保留在上方，其中若有同一问题的多遍回答，请别混着看、以最后一个完整的版本为准；发一条消息即可接着继续。",
  },
  {
    id: "connection-failed",
    re: /connection failed repeatedly/i,
    text: "SDK 连续多次连接失败，已放弃本轮（网络或服务端不稳）。已生成的内容保留在上方；稍后发一条消息即可接着继续。",
  },
];

/** 命中「SDK 自己放弃了」类终态报错就回规则，否则 null。 */
export const matchSdkGiveUp = (rawMessage: string): SdkGiveUpRule | null =>
  SDK_GIVE_UP_RULES.find((r) => r.re.test(rawMessage)) ?? null;

/**
 * run 以非 finished 收场（status=error / expired …）时抛的 Error。
 *
 * 比裸 `new Error(message)` 多保留一样东西：SDK 给的终态错误（`result.error`）作 `cause`——
 * handleRunFailure 的 console.error 会连 [cause] 一起打进 main.log，事后不必只靠
 * 被 slice(1500) 截断的 dump 串去定位。cause 不是 Error 实例，extractSdkErrorBits 不会读它，
 * 所以不改变任何既有的「连接断 / 真错」判定。
 */
export const buildRunNotFinishedError = (
  message: string,
  result: { error?: unknown },
): Error =>
  result.error
    ? new Error(message, { cause: result.error })
    : new Error(message);

/**
 * 把 run 失败归一成「给用户看的事件文案」+ 始终算出的原始 detail。
 * - 裸 status=error 无诊断（连接断 / 额度用完、SDK 层无法区分）→ 友好一句话、不加吓人前缀
 * - 其它（有诊断）→ 复用 buildSdkErrorMessage 的详情串、调用方自行加「失败 / 异常」前缀
 */
/** Cursor 网关偶发的瞬时鉴权抖动：文案固定、重试一次通常就好（用户实测多次）。
 *  这类错误 isRetryable=false 且 code=16，但属于可恢复的瞬时态、单独放行一次。
 *  超过一次仍失败则视为真·鉴权失效，不再重试。 */
const TRANSIENT_AUTH_RE =
  /Authentication error.*try logging out and back in/i;

export const isTransientAuthError = (rawMessage: string, err: unknown): boolean => {
  const summary = summarizeRunFailure(rawMessage, err);
  return TRANSIENT_AUTH_RE.test(summary.detail);
};

/**
 * run 失败是否值得自动重连（V0.13.x、用户拍板「网络波动断了要自动重连 5 次」）：
 * - 裸 status=error 无诊断（isConnectionDrop：长连接断 / 额度用完 SDK 层不可分——
 *   额度用完时重试 5 次也会一致失败、最终照样报错、无害）
 * - SDK 自标 isRetryable
 * - 诊断串命中网络类关键字（fetch failed / ECONNRESET / timeout / unavailable…）
 * 认证错（unauthenticated）/ 配置错 / 协议错不重试——重试也不会好。
 * 例外：TRANSIENT_AUTH_RE 这条瞬时鉴权抖动在首次失败时放行一次（attempt===1）。
 */
export const isRetryableRunError = (
  rawMessage: string,
  err: unknown,
  attempt?: number,
): boolean => {
  const summary = summarizeRunFailure(rawMessage, err);
  // SDK 自己已经重试 / 续接多次才放弃——我们再重连一轮多半只会再重放一遍，最先判否
  //（即使同时带 isRetryable / 网络类关键字也不重连）
  if (summary.isSdkGiveUp) return false;
  if (summary.isConnectionDrop) return true;
  const bits = extractSdkErrorBits(err);
  if (bits.isRetryable === true) return true;
  // 瞬时鉴权抖动：首次失败放行一次，超过一次不再重试（真·过期则直接报错）
  if (TRANSIENT_AUTH_RE.test(summary.detail)) {
    return (attempt ?? 1) <= 1;
  }
  // 认证 / 权限类显式排除（code 16 = unauthenticated、7 = permission denied）
  if (bits.code === 16 || bits.code === 7) return false;
  if (/unauthenticated|permission denied|invalid.*key/i.test(summary.detail)) {
    return false;
  }
  return /network|fetch failed|econn|etimedout|socket hang|und_err|aborted|unavailable|deadline|connect timeout|other side closed/i.test(
    summary.detail,
  );
};

export const summarizeRunFailure = (
  rawMessage: string,
  err: unknown,
): RunFailureSummary => {
  const bits = extractSdkErrorBits(err);
  // 始终算原始诊断、落 meta（连接断 / 额度时 UI 显示友好文案、但原始细节不丢）
  const detail = buildSdkErrorMessage(rawMessage, err);
  // SDK 自己放弃本轮：一句看得懂的话；原始串（含 SDK error fields）照旧在 detail 里
  const giveUp = matchSdkGiveUp(rawMessage);
  if (giveUp) {
    return {
      isConnectionDrop: false,
      isSdkGiveUp: true,
      text: giveUp.text,
      detail,
    };
  }
  // 三道闸全过才算「裸 status=error 无诊断」：①裸 status 形态 ②err 无 code/cause（保守：有 code
  // 先当真错留详情、含 14 UNAVAILABLE / 4 DEADLINE 这类会走详情分支、属可接受 false-negative）
  // ③dump 里没塞诊断字段。误吞比漏报更伤、所以宁可少判、不可吞掉 RCA 线索。
  const isConnectionDrop =
    BARE_RUN_DROP_RE.test(rawMessage) &&
    Object.keys(bits).length === 0 &&
    !dumpHasDiagnostic(rawMessage);
  if (isConnectionDrop) {
    // 「通常可恢复」不写死「即可恢复」——resume 可能因后端已清 run 失败、不过度承诺（reviewAI P2）。
    return {
      isConnectionDrop: true,
      isSdkGiveUp: false,
      text: BARE_RUN_DROP_TEXT,
      detail,
    };
  }
  return { isConnectionDrop: false, isSdkGiveUp: false, text: detail, detail };
};
