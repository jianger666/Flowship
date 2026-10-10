/**
 * chat 本地占位气泡（user_reply 还没落盘）的展示分类 + 「发出后空窗」进度行的触发判定。
 *
 * 背景：之前不管是「刚按下回车、正在把消息交给 SDK」还是「上一轮还在跑、这条排在后面」，
 * 一律是同一个虚线 + 时钟的气泡写「发送中…」。前者其实就是「准备环境 / 恢复对话」——
 * 和自定义 provider 一样，气泡该直接是正式消息，等待由底部进度行说明；
 * 只有真正在排队、或状态确实不明时，才保留「待定」样式。
 *
 * 三类（mode）：
 * - inflight：立即发送途中（提交时没有 run 在跑、网络状态正常）
 *             → 渲染成正式用户气泡 + 列表末尾「准备环境… / 正在恢复对话… / 正在发送…」进度行
 * - queued：提交时 run 在跑，这条排在后面 → 虚线 + 「排队中…」+ 可编辑 / 删除
 * - undefined：HTTP 状态未知 / 终态未知（uncertain），或 task 模式的占位 → 沿用旧样式，如实写「发送中…」
 *
 * 为什么 queued 要「提交时刻快照」而不能在渲染时看 isRunning：
 * 立即发送路径里 agent.send 受理（runStatus→running）早于 user_reply 落盘，
 * 中间有几十~几百 ms「占位还在、isRunning 已为真」的窗口——渲染时判定会把立即发送误判成排队、
 * 气泡样式来回闪。
 */

export type PendingBubbleMode = "inflight" | "queued";

/**
 * @param p.uncertain 发送状态未知（网络 / 终态）——不能装作「已发出」
 * @param p.queued 提交那一刻 run 已在跑（这条是排队消息）
 */
export const classifyPendingBubble = (p: {
  uncertain?: boolean;
  queued?: boolean;
}): PendingBubbleMode | undefined => {
  if (p.uncertain) return undefined;
  return p.queued ? "queued" : "inflight";
};

/** 是否有「立即发送途中」的占位：有就该在列表末尾挂进度行 */
export const hasInflightPending = (
  items: ReadonlyArray<{ mode?: PendingBubbleMode }> | undefined,
): boolean => !!items?.some((p) => p.mode === "inflight");

/**
 * 是否要在列表末尾挂「准备环境…」通用进度行（`__loading__`）：
 * - 已受理、user_reply 已落盘、AI 还没动静（原有）：isRunning && lastIsUser
 * - 已按回车、user_reply 还没落盘（新增）：有 inflight 占位
 * 两段共用同一个 `__loading__` 虚拟项（同 id），占位 → 落盘交接时进度行不重挂载、
 * 「已等待 Ns」不清零。
 */
export const shouldShowSendLoading = (s: {
  isRunning: boolean;
  lastIsUser: boolean;
  hasInflight: boolean;
}): boolean => (s.isRunning && s.lastIsUser) || s.hasInflight;
