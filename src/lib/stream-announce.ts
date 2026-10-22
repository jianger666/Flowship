/**
 * 事件流「关键事件播报」的纯函数（V14-01 + V16-10）。
 *
 * 读屏用户看不到事件流里新长出来的失败 / 待答 / 完成。又不能把 `role=alert` 贴到列表卡片上：
 * 事件流是虚拟列表，卡片每次滚进视口都会重新挂载，live region 会反复播报（error-card.tsx 头注释的禁令是对的）。
 * 所以播报区放在列表外（components/tasks/stream-announcer.tsx），这里只负责「哪些新事件值得说、怎么说」：
 *
 *   - 去重靠**基线 seq**：挂载 / 切任务那一刻已存在的事件 = 基线（maxEventSeq），不播；
 *     之后 seq 更大的新事件才播。`nextSeq` 单调不回退（回退 / 编辑重发把列表截短也不会把基线拉低），
 *     所以同一条事件不会播第二遍，向前翻页补进来的更早事件也不会被当成新的。
 *   - 没有 `seq` 的事件（旧数据 / 本地乐观事件）无从判断新旧，**不播**——宁可漏播也不反复念。
 *   - 「流里本来就不显示」的事件（被平台消音的 / 答疑旁路 run 的 / 回合内工具失败…）不播，
 *     与 `isHiddenFromEventStream` 同口径（单一隐藏闸，不另造一份）。
 *   - 文案是中文业务口径，不外露内部事件类型名 / 工具名；失败只念 `text` 第一行
 *     （`meta.detail` 是原始诊断，不进播报）。
 */

import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import type { TaskEvent } from "@/lib/types";

/** 摘要最多念多少个字（超出加省略号）：播报区是「通知一声」，不是把整段正文念一遍 */
export const ANNOUNCE_BRIEF_MAX = 60;

/**
 * 从尾部最多回看多少条：新事件一定在尾部，没必要每次把整份历史翻一遍。
 * 一次性涌入超过这个数的新事件（长时间断线后重连补发）只会漏掉更早的那部分——
 * 它们本来也只是「摘要一句话」，漏掉比念几百条强。
 */
const SCAN_WINDOW = 400;

/** 「AI 有新回复」的固定文案（trailing 节流后单独播，见 hook） */
export const REPLY_ANNOUNCEMENT = "AI 有新回复";

/**
 * 「AI 有新回复」的 trailing 静默窗口（Q8-05）：最后一条回复之后这么久没有后续工具调用，才念「AI 有新回复」。
 * 逐事件念的话「叙述 → tool_call → tool_result」每个往返都会触发一次（20 轮念 20 次）。
 */
export const REPLY_ANNOUNCE_QUIET_MS = 4000;

export interface StreamAnnouncement {
  /** 要播的话；空串 = 这一批没有值得播的（含「AI 有新回复」，向后兼容） */
  text: string;
  /** 播完之后的新基线（≥ prevSeq，单调不回退） */
  nextSeq: number;
  /** 不含「AI 有新回复」的部分：失败 / 待答 / 完成这类要立刻播的 */
  urgentText: string;
  /** 这一批末尾是一条回复（之后没有工具往返）：交给 trailing 节流，不立刻念 */
  replyPending: boolean;
  /** 这一批里出现过工具往返：已挂起的 trailing 计时说明那条回复只是叙述，应取消 */
  toolActivity: boolean;
}

/** trailing 计时器该怎么动（纯函数，hook 照做） */
export type ReplyTimerAction = "restart" | "cancel" | "keep";

/**
 * 一批新事件之后「AI 有新回复」的计时器动作：
 * - 这批末尾是回复 → restart（从最后一条回复起重新计静默窗口）；
 * - 否则这批有工具往返且计时器在走 → cancel（挂起的那条回复只是工具调用前的叙述句）；
 * - 其它 → keep（没有新信息，别动计时器）。
 */
export const nextReplyTimerAction = (
  d: Pick<StreamAnnouncement, "replyPending" | "toolActivity">,
  timerArmed: boolean,
): ReplyTimerAction => {
  if (d.replyPending) return "restart";
  if (d.toolActivity && timerArmed) return "cancel";
  return "keep";
};

const isSeq = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** 当前事件里最大的 seq；没有任何带 seq 的事件 = 0（seq 从 1 起） */
export const maxEventSeq = (events: readonly TaskEvent[]): number => {
  let max = 0;
  for (const e of events) {
    if (isSeq(e.seq) && e.seq > max) max = e.seq;
  }
  return max;
};

/** 正文第一个非空行，空白折叠，超长截断（按字符而不是 UTF-16 单元，不把 emoji 劈成两半） */
const brief = (text: string): string => {
  const first =
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? "";
  const chars = [...first];
  return chars.length > ANNOUNCE_BRIEF_MAX
    ? `${chars.slice(0, ANNOUNCE_BRIEF_MAX).join("")}…`
    : first;
};

const withBrief = (head: string, text: string): string => {
  const b = brief(text);
  return b ? `${head}：${b}` : head;
};

/**
 * 基线 `prevSeq` 之后新增了哪些值得播的事件 → 一句中文 + 新基线。
 *
 * 一批里有多种时按轻重排：失败 → 待答 → 完成；同类连续多条只说一句
 * （失败带条数、取最新一条的摘要）。「；」连接，polite 播报区一次念完。
 */
export const deriveAnnouncements = (
  prevSeq: number,
  events: readonly TaskEvent[],
  opts: { isChat?: boolean } = {},
): StreamAnnouncement => {
  let nextSeq = prevSeq;
  let errorCount = 0;
  let lastError: TaskEvent | null = null;
  let lastAsk: TaskEvent | null = null;
  let awaitingAck = false;
  // 「AI 有新回复」只在这一批里**最后**一个相关事件是回复时才念（R8-03）：
  // 工具调用之间的叙述句（「我先看下 X」→ tool_call → …）也是 assistant_message，每条都念会变成噪音
  let lastReplySeq = -1;
  let lastToolSeq = -1;

  const from = Math.max(0, events.length - SCAN_WINDOW);
  // 事件按 seq 升序追加，所以「最新一条」= 遍历里最后遇到的一条
  for (let i = from; i < events.length; i++) {
    const e = events[i]!;
    if (!isSeq(e.seq)) continue;
    if (e.seq > nextSeq) nextSeq = e.seq;
    if (e.seq <= prevSeq) continue;
    if (isHiddenFromEventStream(e, { isChat: opts.isChat })) continue;

    switch (e.kind) {
      case "error":
        errorCount += 1;
        lastError = e;
        break;
      case "ask_user_request":
        lastAsk = e;
        break;
      case "info":
        // 「Action 产出完成、等待 ack」里程碑（rows.tsx 的 awaitingAck 卡）
        if (e.meta?.awaitingAck === true) awaitingAck = true;
        break;
      case "assistant_message":
        lastReplySeq = e.seq;
        break;
      case "tool_call":
      case "tool_result":
        lastToolSeq = e.seq;
        break;
      default:
        break;
    }
  }

  const parts: string[] = [];
  if (lastError) {
    parts.push(
      withBrief(
        errorCount > 1 ? `出错了（共 ${errorCount} 条）` : "出错了",
        lastError.text,
      ),
    );
  }
  if (lastAsk) parts.push(withBrief("AI 在等你回答", lastAsk.text));
  if (awaitingAck) parts.push("这一步的产出已完成，等你确认");
  const urgentText = parts.join("；");
  const replyPending = lastReplySeq > lastToolSeq;
  if (replyPending) parts.push(REPLY_ANNOUNCEMENT);

  return {
    text: parts.join("；"),
    nextSeq,
    urgentText,
    replyPending,
    toolActivity: lastToolSeq >= 0,
  };
};

/**
 * 状态行 label 进读屏播报区前的口径（R8-03）：不外露工具名。
 * 「正在执行 shell」→「正在执行工具」、「正在分析 read 的结果」→「正在分析工具结果」；
 * 连续换工具时粗化后文案不变 → 播报区 DOM 不变 → 读屏不会每换一个工具念一遍。
 * 其余 label（思考中 / 等待中 / 等你回答 / 正在回复… …）本来就不含工具名，原样。
 */
/**
 * 状态行进读屏播报区的口径（Q8-05）：只在「空 ↔ 非空」两态间切换。
 * 粗化后的文案（正在执行工具 / 正在分析工具结果 / 思考中…）在一次运行里仍会随阶段来回变，
 * 每次工具往返 ≈ 念两句；只留「有没有在忙」，阶段细节有可见的状态行，读屏用户要的是「开始 / 结束」。
 * （ask 到达时「等你回答」也不再由这一格念，事件格的「AI 在等你回答：…」独占，D6-04 的双念随之消失。）
 */
export const ANNOUNCE_BUSY_LABEL = "AI 处理中";
export const announceStatusPresence = (label: string): string =>
  label.trim() ? ANNOUNCE_BUSY_LABEL : "";

export const announceStatusLabel = (label: string): string => {
  if (/^正在执行\s+\S/.test(label)) return "正在执行工具";
  if (/^正在分析\s+.+\s+的结果$/.test(label)) return "正在分析工具结果";
  return label;
};
