/**
 * 聊天回退（含编辑回退）的失败文案 + 防重入（第二轮 review V7-05 / V7-06）
 *
 * 两件事放一起，因为都是「回退这条 HTTP 链路在前端的人话层」：
 *
 * - **V7-06 按稳定 code 选提示**：前端原先靠正则 `/跑|running|停止|409/` 匹配中文报错文案——
 *   三种 409 都说「请先停止当前回复」，「任务正在停止/删除」时是错的（它停不了、也不用停），
 *   「已有回退在进行中」又匹配不上。现在服务端 409 响应带稳定 `code`（见 rewind route），这里只认 code；
 *   老响应（没有 code）才退回旧的文案匹配兜底。
 * - **V7-05 单飞锁**：确认回退后界面零反馈、且可重入（再点一次得到红色「已有回退在进行中」，其实第一次在成功）。
 *   `runExclusiveRewind` 保证同一时刻只有一个回退在飞，被拒绝时不发请求。
 *
 * 纯函数 / 无 React、无 server 依赖：client 与 server 都能 import（服务端 RewindError 的 `reason` 类型也出自这里，
 * 前后端的 code 集合不会各写一份）。
 */

/**
 * `/rewind` 失败响应的稳定 code。
 * 前五个是服务端 `RewindErrorCode` 本身；后六个是 `run_active` 这一大类 409 的细分
 * （服务端 `RewindError.reason`，无细分时响应退回 `run_active`）。
 */
export type RewindFailureCode =
  | "not_found"
  | "not_chat"
  | "no_checkpoint"
  | "bad_target"
  | "restore_failed"
  // —— 409 的细分 ——
  /** AI 回复还在进行（含 meta.runStatus=running） */
  | "run_active"
  /** 还有排队中的消息 */
  | "queue_pending"
  /** 正在发送排队消息 */
  | "queue_draining"
  /** 正在启动新会话 */
  | "session_starting"
  /** 任务正在停止 / 删除 */
  | "task_closing"
  /** 已有另一个回退在进行 */
  | "rewind_in_progress";

const KNOWN_CODES: ReadonlySet<string> = new Set<RewindFailureCode>([
  "not_found",
  "not_chat",
  "no_checkpoint",
  "bad_target",
  "restore_failed",
  "run_active",
  "queue_pending",
  "queue_draining",
  "session_starting",
  "task_closing",
  "rewind_in_progress",
]);

export const isRewindFailureCode = (v: unknown): v is RewindFailureCode =>
  typeof v === "string" && KNOWN_CODES.has(v);

/**
 * 「因为现在忙 / 状态不对而回退不了」这几类的原因句（前缀由 kind 决定）。
 * 只列有明确话可说的；其余 code（not_found / no_checkpoint / …）带服务端原文，不替它编。
 */
const BUSY_CAUSE: Partial<Record<RewindFailureCode, string>> = {
  run_active: "AI 还在回复，请先停止当前回复",
  queue_pending: "还有排队中的消息，请先停止当前回复或等它们发送完",
  queue_draining: "正在发送排队消息，请稍后再试",
  session_starting: "正在启动新会话，请稍后再试",
  task_closing: "对话正在停止或删除，暂时无法操作",
  rewind_in_progress: "已有一次回退在进行中，请稍候",
};

/**
 * 老响应（没有 code）的兜底：沿用改造前的文案匹配。只在没有 code 时才用——
 * 有 code 一律按 code，文案里恰好带「跑 / 停止」也不会误判。
 */
const LEGACY_RUNNING_RE = /跑|running|停止|409/i;

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const errorCode = (err: unknown): unknown =>
  err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;

/**
 * 回退 / 编辑回退失败时给用户看的一句话。
 * @param kind rewind =「回退到这里」；edit = 编辑已发送消息时的那一步回退（只影响前缀）
 */
export const rewindFailureToast = (
  err: unknown,
  kind: "rewind" | "edit",
): string => {
  const prefix = kind === "rewind" ? "回退失败" : "编辑失败";
  const message = errorMessage(err);
  const code = errorCode(err);
  if (isRewindFailureCode(code)) {
    const cause = BUSY_CAUSE[code];
    return `${prefix}：${cause ?? message}`;
  }
  // 没有（或不认识的）code：回退保留旧规则，编辑旧行为本来就是原文直出
  if (code === undefined && kind === "rewind" && LEGACY_RUNNING_RE.test(message)) {
    return "请先停止当前回复再回退";
  }
  return `${prefix}：${message}`;
};

/** 回退已在进行时、新的回退请求被拒绝给用户的那句提示 */
export const REWIND_BUSY_NOTICE = "正在回退，请稍候";

/**
 * 回退单飞锁：同一时刻只有一个回退（含编辑回退）在飞。
 *
 * - `lock.current` 是锁本身，同时记「正在回退哪条消息」（UI 据此让那一行转圈、其余行禁用）
 * - 飞行中再来：直接返回 `{ ran: false }`、**不调 fn**（否则会多发一个 POST，换来服务端的「已有回退在进行中」红卡，
 *   而第一次其实在成功）；被拒绝的那次不碰锁和状态
 * - fn 成败（含同步抛错）都释放锁并通知 null，错误原样抛给调用方
 *
 * @param onChange 状态变化回调（传 React setState）：开始 → eventId，结束 → null
 */
export const runExclusiveRewind = async <T>(
  lock: { current: string | null },
  eventId: string,
  onChange: (eventId: string | null) => void,
  fn: () => Promise<T> | T,
): Promise<{ ran: true; value: T } | { ran: false }> => {
  if (lock.current !== null) return { ran: false };
  lock.current = eventId;
  onChange(eventId);
  try {
    return { ran: true, value: await fn() };
  } finally {
    lock.current = null;
    onChange(null);
  }
};
