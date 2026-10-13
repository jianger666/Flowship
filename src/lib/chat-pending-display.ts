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
 *
 * 同一个空窗里输入框一侧（运行态外观 / 停止键语义）的判定也收在本文件末尾。
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

// ---------------------------------------------------------------------------
// 同一个「发出后空窗」里，输入框这一侧的状态（2026-10-12）
//
// 空窗 = 回车 → 服务端把消息交给 SDK 受理（受理后才发布 runStatus=running）。
// 实测（chat-reply-timings.log）：热路径要先打发送前快照 0.3–0.7s、再 agent.send 受理 1–3s，
// 合计 1.3–2.7s；冷路径还要 resume，4.5–6.7s。
//
// v1.9.29 把气泡改成了「正式气泡 + 列表末尾准备环境…」，界面在说「AI 已经在处理了」，
// 但输入框仍绑在 HTTP 请求上：只有一个转圈的发送键、没有停止键——两处表达自相矛盾，
// 而且这几秒里用户想停也停不了。下面三个函数收口这一侧。
// ---------------------------------------------------------------------------

/**
 * 输入框右侧是否按「运行态」画（转圈 + 红色停止键 + 排队发送）。
 *
 * 提交飞行期间（submitting）也算：气泡已是正式消息，输入框就别再装作「还在发送」。
 * 有待答提问时照旧不画运行态——那时回车 = 隐式跳过提问，输入条要保持可发。
 */
export const shouldShowComposerRunning = (s: {
  /** run 进行中 latch（runStatus 进过 running，done 事件才松开） */
  isRunning: boolean;
  /** 本地提交飞行中（sendChatReply 的 HTTP 还没返回） */
  submitting: boolean;
  awaitingAsk: boolean;
}): boolean => (s.isRunning || s.submitting) && !s.awaitingAsk;

/**
 * 点停止键：现在就停，还是等这次提交落地再停。
 *
 * 受理前直接停会撞一个服务端竞态：热路径（会话在内存）发送前快照期间还没有任何占位，
 * 这时 stop 把会话关了，随后 sendChatMessage 发现无会话（no_session）、落到「起新会话」
 * 并重新领一个 lease——用户点了停止，AI 却被重新拉起来，消息还被重放。
 * 冷路径（claim / startToken）和 agent.send 受理期间（共享取消闭包）都有兜底，唯独这一段没有。
 *
 * 判据：提交还在飞、且服务端还没受理。受理的信号是 runStatus 发布 running（runActive 随之为真）：
 * 之后 run 已被取消闭包持有，stop 是确定的。排队发送（run 本来就在跑）时 runActive 已真 → 直接停。
 */
export type ChatStopMode = "now" | "after_submit";
export const decideChatStop = (s: {
  submitting: boolean;
  runActive: boolean;
}): ChatStopMode => (s.submitting && !s.runActive ? "after_submit" : "now");

/**
 * 提交落地后，怎么处理「受理前点过的停止」：
 * - none：没登记过，什么都不做；
 * - stop：消息已被服务端接住、任务还在——现在兑现这次停止；
 * - release：消息没发出去（被拒 / 状态不明）或任务已没了——没有 run 可停，
 *   只把停止键的「停止中」外观收掉（草稿由调用方保留，用户可重发；不落一条多余的「用户停止了对话」）。
 */
export type StopIntentSettlement = "none" | "stop" | "release";
export const settleStopIntent = (s: {
  /** 受理前是否登记过停止意图 */
  pending: boolean;
  /** 这次提交是否落地（消息已被服务端接住） */
  accepted: boolean;
  /** 任务还在（没被删 / 没被切走） */
  alive: boolean;
}): StopIntentSettlement => {
  if (!s.pending) return "none";
  return s.accepted && s.alive ? "stop" : "release";
};
