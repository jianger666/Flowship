/**
 * 「停止之后会发生什么 / 怎么继续」的文案单一来源（纯函数、无 React；第三轮 review D8-06 / D8-04）
 *
 * 之前三处各写各的：停止确认框（「说句话即可唤醒继续」）、停止后的 info（「可重新「推进」」）、
 * boot-recovery（「重新发起即可恢复」）——用户读到的是「随便哪个都行」，而两条路径语义不同：
 * - 说话 = 唤醒**同一个** action 接着干（task 输入条 / chat 发消息）；
 * - 「推进」= 新开**下一步** action。
 * 现在统一成「说话继续本步，或点「推进」开始下一步」；chat 没有「推进」，只说「继续发消息」。
 *
 * 客户端（task 页停止确认框）与服务端（stop-task 事件、boot-recovery 事件）共用本模块，改文案只改这里。
 */

/** task：停止后的两种继续方式 */
export const TASK_RESUME_HINT = "可在底部输入条说句话继续本步，或点「推进」开始下一步";
/** chat：没有「推进」 */
export const CHAT_RESUME_HINT = "可继续发消息";

/** 按任务模式取「怎么继续」短句（chat 没有「推进」）——断开 / 唤醒失败 / 没交卷等恢复文案共用，别再各写一套（Q6-07） */
export const resumeHintFor = (mode: string | undefined): string =>
  mode === "chat" ? CHAT_RESUME_HINT : TASK_RESUME_HINT;

/**
 * 停止会清掉的排队条数：只有输入条（app 来源）的；群来源（属主群话 / 托办回执 / 群提问）保留、空闲后照常送达
 * （与服务端 stop-task 的 `clearTalkQueue(id, { onlySources: ["app"] })` 同口径）。
 */
export const stoppableQueuedCount = (
  items: readonly { source: string }[] | null | undefined,
): number => (items ?? []).filter((it) => it.source === "app").length;

/**
 * task 页「停止当前 action？」确认框的正文。
 *
 * @param queuedCount 输入条里排着、还没发出的消息条数（只算停止会清掉的 app 来源；群来源保留、空闲后照常送达）。
 *   > 0 时点明会被清掉（D8-04：以前停止清队完全静默，用户排的意见悄悄没了），并说明会留「未送达」记录可复制。
 */
export const stopConfirmDescription = (opts?: { queuedCount?: number }): string => {
  const n = Math.max(0, Math.floor(opts?.queuedCount ?? 0));
  const queueClause =
    n > 0 ? `输入条里排队、还没发出的 ${n} 条消息会被清掉（会留一条「未送达」记录，文字可复制回去重发；图片 / 文件需重新添加）。` : "";
  return `会中断正在跑的 agent（如果它正在改代码、可能留下半成品）。${queueClause}停止后${TASK_RESUME_HINT}。`;
};

/**
 * 停止后写进事件流的 info 文案。
 *
 * @param mode chat 任务无 action、文案走「对话」语境
 * @param trigger `exclude` = 划除某个 action 时自动收尾（不是用户点了「停止」，别写成用户停止）；缺省 / `stop` = 用户停止
 * @param actionLabel 如 ` 出方案 action`（带前导空格；无当前 action 传空串）
 */
export const stopNoticeText = (opts: {
  mode: string | undefined;
  trigger?: "stop" | "exclude";
  actionLabel?: string;
}): string => {
  if (opts.mode === "chat") return `用户停止了对话（agent 已中断、${CHAT_RESUME_HINT}）`;
  const label = opts.actionLabel ?? "";
  return opts.trigger === "exclude"
    ? `划除时自动停止了${label}（agent 已中断、${TASK_RESUME_HINT}）`
    : `用户停止了${label}（agent 已中断、${TASK_RESUME_HINT}）`;
};

/**
 * Web 进程重启时发现任务在跑、被判中断的 error 事件正文（boot-recovery）。
 * task / chat 共用同一条事件：chat 没有「推进」按钮，所以只点名两边都成立的「在输入条说句话继续」，
 * task 另可点「推进」开启下一步。
 */
export const BOOT_RECOVERY_TEXT =
  "[boot-recovery] Web 进程重启时本任务的 agent 正在运行、这一轮已中断。可在底部输入条说句话继续本步（任务也可点「推进」开始下一步）。";
