/**
 * 兜底 A：chat「没把回答写成正文就想挂等」的纯判定（无 IO、便于单测）。
 *
 * 背景：composer-2.5 等模型在 chat 模式有时查完代码 / 只 thinking 就直接调 wait_for_user、
 * 不把结论写成正文 → 用户看到「空白回复」。由服务端在 wait_for_user handler 调本判定硬拦
 * （见 chat-mcp.ts 的 isPrematureChatWaitOnce / wait_for_user）。
 *
 * 设计原则（2026-06-19 大幅简化）：只守一条最本质、纯客观的底线——
 *   「本轮用户在等回答、agent 却从头到尾没发过任何非空正文」→ premature。
 * 不再用正则猜「发的字够不够实质 / 是不是预告」——那条路（强弱信号 / 纯宣告识别 / 答后又查）
 * 反复误伤正常对话（用户问 curl 示例、问 wait_for_user、问写作流程都被卡过），是 NLP 无底洞、已删。
 * 判断标准从「实质性」退回「有没有发字」：发了任何非空正文就放行、「发得够不够好」交给 prompt 治，
 * 服务端只兜「完全空白」这一条。
 *
 * 抽成独立模块（对齐 shell-guard-rules / submit-mr-guard 的「guard 纯逻辑 + 配套单测」惯例）。
 */
import type { TaskEvent } from "@/lib/types";

// 兜底 A 需要完整轮次边界；0 是 task-fs.readRecentEvents 的「读全量」约定。
export const PREMATURE_CHAT_WAIT_EVENT_LIMIT = 0;

/**
 * 判定一次 wait_for_user 是否 premature（= 该回答用户却没把回答写成正文就挂等）。
 *
 * 核心不变量：本轮 run 有没有「用户正在等的回答」（obligation）、以及 agent 有没有就这一轮
 * 发过任何非空正文。
 *  - run 起点 = 最后一条「Chat 任务启动」info；该 info 的 meta.firstMessageEventId 显式指向
 *    触发本轮的首条消息事件。旧日志无 meta 时回退「user_reply 紧贴 chat_start 前一格」。
 *  - obligation 来源：轮内追问（user_reply 落在 chat_start 之后、优先）或触发本轮的首条消息。
 *  - 有 obligation + 本轮没发过任何非空正文（只 thinking / 只调工具 / 只发空白）→ premature。
 *  - 无 obligation（resume 起手、无人等回答）→ 一律放行：兜底只守「用户问题不能空白」、
 *    不拿 agent 内部自检（read/grep 历史）为难它。
 */
export const classifyPrematureChatWait = (events: TaskEvent[]): boolean => {
  // run 起点（最后一条「Chat 任务启动」）+ 该事件本身 + 最后一条 user_reply 的下标
  let runStartIdx = -1;
  let runStartEvent: TaskEvent | undefined;
  let lastUserReplyIdx = -1;
  events.forEach((e, i) => {
    if (e.kind === "user_reply") lastUserReplyIdx = i;
    else if (e.kind === "info" && e.text.startsWith("Chat 任务启动")) {
      runStartIdx = i;
      runStartEvent = e;
    }
  });

  // 本轮 run 欠不欠用户一个回答（hasObligation）+ 从哪开始 scan 这一轮（turnStart）
  let hasObligation: boolean;
  let turnStart: number;
  if (lastUserReplyIdx > runStartIdx) {
    // 轮内追问 / 催促：以它为义务起点（它之前那条回答是答上一问的、不算本问的回答）
    hasObligation = true;
    turnStart = lastUserReplyIdx;
  } else {
    // 本轮无轮内追问：看本轮 run 是否由首条消息触发（meta 显式关联优先、相邻位置回退旧日志）
    const fmId =
      typeof runStartEvent?.meta?.firstMessageEventId === "string"
        ? runStartEvent.meta.firstMessageEventId
        : undefined;
    // lastUserReplyIdx >= 0 守卫：否则 runStartIdx=0（chat_start 是首事件、无 user_reply）时
    // -1 === 0-1 会假阳性把 resume 自检误拦
    const adjacentFirstMsg =
      lastUserReplyIdx >= 0 && lastUserReplyIdx === runStartIdx - 1;
    hasObligation = Boolean(fmId) || adjacentFirstMsg;
    turnStart = runStartIdx;
  }

  // 连 run 起点都不在窗口里、又没轮内追问 → 没法可靠判定、fail-open 放行
  if (turnStart < 0) return false;

  // 无人等回答（resume 起手）：一律放行、不管 agent 内部自检
  if (!hasObligation) return false;

  // 有用户在等回答：本轮（turnStart 之后）发过任何非空正文吗？
  // 发了就放行、一个字没发（只 thinking / 只调工具 / 只发空白）才拦。
  // 只看「有没有发字」这个纯客观信号、不猜「发得够不够实质」——语义判断是误伤无底洞、已删。
  const hasAnswered = events
    .slice(turnStart + 1)
    .some((e) => e.kind === "assistant_message" && e.text.trim().length > 0);
  return !hasAnswered;
};
