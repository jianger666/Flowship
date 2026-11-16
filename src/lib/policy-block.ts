/**
 * 「请求被模型方使用政策拦截」（Anthropic Usage Policy 分类器）的识别 + 连续被拦次数统计。
 *
 * 为什么单独成模块（2026-11-16「接手重构马拉松视频」事故）：
 * 这类拦截是对**整份请求内容**的自动判定。chat 出错收尾会保留落盘 sessionAgentId、
 * 下条消息 Agent.resume 接回——而被拦的内容（常见是某条工具输出）就躺在那个会话的历史里，
 * 每次 resume 都会把它整份重发，于是「继续」「重试」永远秒拦（实测 3.9 秒），聊天再也起不来。
 * 修法分三层（都靠这里的纯函数判断）：
 *   ① 出错收尾识别到拦截 → 丢掉落盘锚点（chat-runner）；
 *   ② 旧数据里锚点还在（修复前就卡住的对话）→ resume 前按事件尾判一次、跳过 resume；
 *   ③ 起新会话时若已连续被拦 → 逐级减少带入的历史（chat-history-inject）。
 *
 * 纯函数、无 server 依赖：sdk-error（server）和 chat-history-inject（共享）都从这里取。
 */

/**
 * 拦截文案：`Request blocked by Anthropic We are unable to complete this request because it was
 * blocked under Anthropic's Usage Policy.`（SDK stream error message 里原样出现）。
 * 只认「被 Anthropic 拦」这个整体，不单认 `Usage Policy`——别的报错里也可能顺带提到政策。
 */
export const POLICY_BLOCK_RE =
  /blocked (?:by|under) Anthropic|Anthropic['’]?s Usage Policy/i;

export const isPolicyBlockText = (text: string | undefined | null): boolean =>
  typeof text === "string" && text.length > 0 && POLICY_BLOCK_RE.test(text);

/** 给用户看的一句话（task / chat 通用；不含「下一步怎么办」，那句因通道而异） */
export const POLICY_BLOCK_TEXT =
  "本轮请求被模型方（Anthropic）的使用政策自动拦截了——这是对请求内容的判定，不是网络或额度问题，原样重试多半还会被拦。";

/** chat 通道在 POLICY_BLOCK_TEXT 后追加的「下一步」：说清楚旧会话已丢、再发一条就能起来 */
export const CHAT_POLICY_BLOCK_NEXT_STEP =
  "已放弃被拦的旧会话（连同它累积的工具输出）；直接再发一条消息即可开新会话，AI 只带最近几轮对话文字，更早的细节可回读事件日志。新会话若仍被拦，会自动减少带入的历史。";

type PolicyEventLike = {
  kind: string;
  text?: string;
  meta?: Record<string, unknown>;
};

/**
 * 这条事件是不是一次「被拦」的 error。
 * 新事件带 meta.policyBlock=true；修复前落盘的旧事件只能靠正文 / meta.detail 里的拦截文案认。
 */
export const isPolicyBlockEvent = (e: PolicyEventLike): boolean => {
  if (e.kind !== "error") return false;
  if (e.meta?.policyBlock === true) return true;
  if (isPolicyBlockText(e.text)) return true;
  const detail = e.meta?.detail;
  return typeof detail === "string" && isPolicyBlockText(detail);
};

/**
 * 拦截 error 事件 meta 里记「是哪个会话被拦」的键（落盘锚点 sessionAgentId 的值）。
 * 不用 `agentId`：子代理转录事件已经占用了 meta.agentId（subagent-transcript），会串味。
 * 只有出错收尾那条 `Chat agent 异常` 会写；修复前的旧事件没有，读的一侧按「不知道」处理。
 */
export const POLICY_BLOCK_AGENT_META_KEY = "policyBlockAgentId";

const blockedAgentIdOf = (e: PolicyEventLike): string | undefined => {
  const v = e.meta?.[POLICY_BLOCK_AGENT_META_KEY];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

/**
 * 事件尾上「连续被拦了几次」（从最新往前数，按用户消息分轮），顺带带出最近一轮是哪个会话被拦。
 *
 * - 同一轮里的多条拦截 error（SDK ERROR + Chat agent 异常 两条）只算一次——以用户消息为界；
 * - 碰到 assistant_message / tool_call 就停：模型在这个会话里正常产出过，说明被拦的不是历史本身，
 *   而是后来新出现的内容，历史没毒，不必减带；
 * - 碰到别的类型的 error（网络断、额度…）也停：那是另一种失败、把链打断；
 * - thinking / tool_result / info / ask_* / user_reply 都不算进展（thinking 有时在 error 之后才落盘）。
 *
 * agentId：**最近一轮**拦截里任一条事件记下的被拦会话（见 {@link POLICY_BLOCK_AGENT_META_KEY}）；
 * 更早几轮的不看——后面既然又被拦，被拦的就是后面那个会话。没记（旧事件）= undefined。
 */
export const trailingPolicyBlock = (
  events: ReadonlyArray<PolicyEventLike>,
): { streak: number; agentId?: string } => {
  let streak = 0;
  let inBlockedTurn = false;
  let agentId: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "assistant_message" || e.kind === "tool_call") break;
    if (e.kind === "error") {
      if (!isPolicyBlockEvent(e)) break;
      if (!inBlockedTurn) {
        streak++;
        inBlockedTurn = true;
      }
      // streak === 1：仍在「最近一轮」里（跨到上一条用户消息再遇拦截才会变 2）
      if (streak === 1 && agentId === undefined) agentId = blockedAgentIdOf(e);
      continue;
    }
    // 跨到上一条用户消息：下一条拦截 error 属于更早的一轮
    if (e.kind === "user_reply") inBlockedTurn = false;
  }
  return agentId === undefined ? { streak } : { streak, agentId };
};

/** 事件尾上「连续被拦了几次」，见 {@link trailingPolicyBlock} */
export const countTrailingPolicyBlocks = (
  events: ReadonlyArray<PolicyEventLike>,
): number => trailingPolicyBlock(events).streak;

/**
 * 现在这个落盘锚点，是不是「被拦的那个会话」——resume 前据此决定要不要跳过接回。
 *
 * 光看「事件尾上还有没被冲掉的拦截」不够：被拦之后已经起过新会话 B（锚点换成 B），但 B 还没产出
 * 任何文字 / 工具调用就断网重连（或被用户停止、等问答）时，事件尾上仍只有那次拦截——
 * 把健康的 B 当成毒会话丢掉，重连还会白退避一分钟。所以新事件记了是哪个会话被拦，
 * 与现锚点不同就说明后来已换了新会话、不毒。
 *
 * 旧事件（修复前落盘）没记会话：按原口径——事件尾上还有拦截、锚点就是那个毒会话。
 */
export const isAnchorBlockedSession = (
  events: ReadonlyArray<PolicyEventLike>,
  anchorAgentId: string,
): boolean => {
  const { streak, agentId } = trailingPolicyBlock(events);
  if (streak === 0) return false;
  if (agentId !== undefined && agentId !== anchorAgentId) return false;
  return true;
};

/** 起新会话时带入多少历史：full = 正常；reduced = 只带最近几轮短摘要；none = 不带历史 */
export type PolicyBlockHistoryLevel = "full" | "reduced" | "none";

/**
 * 连续被拦次数 → 历史带入档位。
 * 1 次：多半是旧会话里某条工具输出惹的祸，丢掉旧会话 + 正常带最近几轮对话文字就够；
 * 2 次：连文字摘要里都可能有问题（或用户那句话本身），减带；
 * ≥3 次：不带历史，保证最后一定能起来。
 */
export const historyLevelForBlockStreak = (
  streak: number,
): PolicyBlockHistoryLevel =>
  streak >= 3 ? "none" : streak === 2 ? "reduced" : "full";
