/**
 * chat 起新会话时的「接续历史」切片（resume 失败 / 懒重启 / 空闲回收后）。
 *
 * 只取 user_reply / assistant_message 正文、不含 thinking / 工具过程。
 * 轮数 + 字符双封顶，避免把整份 events.jsonl 灌进第一轮。
 * resume 成功时根本不走这里——历史已在会话文件里。
 */

import {
  countTrailingPolicyBlocks,
  historyLevelForBlockStreak,
} from "@/lib/policy-block";

export const HISTORY_INJECT_MAX_TURNS = 12;
/** ~4k token 量级，相对起手系统 prompt（常 60KB+）是零头 */
export const HISTORY_INJECT_MAX_CHARS = 12_000;
/** 从文件尾扫这么多事件，才能在工具密集的对话里凑够上面的轮数 */
export const HISTORY_INJECT_SCAN_EVENTS = 500;
/**
 * 已连续被安全策略拦截 2 次时的减带档：只带最近几轮、字数也压小。
 * 拦截是对整份请求的判定，带得越少越不容易再撞上同一段内容（见 policy-block.ts）。
 */
export const HISTORY_INJECT_REDUCED_TURNS = 4;
export const HISTORY_INJECT_REDUCED_CHARS = 3_000;

export type ChatHistoryTurnKind = "user_reply" | "assistant_message";

export type ChatHistoryTurn = {
  kind: ChatHistoryTurnKind;
  text: string;
};

export type ChatHistoryInject = {
  /** 空 = 窗口里还没有更早的对话，走「第一条消息」起手 */
  turns: ChatHistoryTurn[];
  /** 因轮数 / 字数 / 扫描窗口丢掉了更早的正文 */
  truncated: boolean;
  /**
   * 因连续被安全策略拦截、这次**一条历史都没带**时 = 已连续被拦的次数（≥3）。
   * 平时不出现这个字段；turns 为空但带了它 ≠「新对话第一句」，起手 prompt 要交代清楚。
   */
  omittedForPolicyBlock?: number;
};

const isHistoryTurnKind = (kind: string): kind is ChatHistoryTurnKind =>
  kind === "user_reply" || kind === "assistant_message";

const turnText = (text: string | undefined): string => {
  const t = text?.trim() ?? "";
  return t.length > 0 ? t : "(空)";
};

export const selectChatHistoryTurns = (
  events: ReadonlyArray<{
    id?: string;
    kind: string;
    text?: string;
    meta?: Record<string, unknown>;
  }>,
  opts: { skipEventId?: string; skipUserText?: string } = {},
): ChatHistoryInject => {
  const ua = events.filter((e) => isHistoryTurnKind(e.kind));

  let filtered = opts.skipEventId
    ? ua.filter((e) => e.id !== opts.skipEventId)
    : ua;
  // persist 失败无 eventId 时：从末条往前找一条正文相同的 user_reply 去掉，
  // 避免和「用户的新消息」重复。同文本连发会误删一条历史——概率极低，
  // 主路径有 skipEventId、不走这里。
  if (!opts.skipEventId && opts.skipUserText !== undefined) {
    for (let i = filtered.length - 1; i >= 0; i--) {
      if (
        filtered[i].kind === "user_reply" &&
        (filtered[i].text ?? "") === opts.skipUserText
      ) {
        filtered = filtered.filter((_, idx) => idx !== i);
        break;
      }
    }
  }

  if (filtered.length === 0) return { turns: [], truncated: false };

  // 已被安全策略连续拦截：逐级减带（拦截是对整份请求内容的判定，历史带得越多越容易再撞上）。
  // 从同一份 events 里数、不另读盘——session-rebuilt-notice 与 runChatSession 同源，两边口径自动一致。
  const blockStreak = countTrailingPolicyBlocks(events);
  const level = historyLevelForBlockStreak(blockStreak);
  if (level === "none") {
    return { turns: [], truncated: true, omittedForPolicyBlock: blockStreak };
  }
  const maxTurns =
    level === "reduced" ? HISTORY_INJECT_REDUCED_TURNS : HISTORY_INJECT_MAX_TURNS;
  const maxChars =
    level === "reduced" ? HISTORY_INJECT_REDUCED_CHARS : HISTORY_INJECT_MAX_CHARS;

  const truncatedByCount = filtered.length > maxTurns;
  let slice = truncatedByCount ? filtered.slice(-maxTurns) : filtered;

  let truncatedByChars = false;
  let total = slice.reduce((n, e) => n + (e.text ?? "").length, 0);
  while (slice.length > 1 && total > maxChars) {
    truncatedByChars = true;
    const dropped = slice[0];
    slice = slice.slice(1);
    total -= (dropped.text ?? "").length;
  }
  if (slice.length === 1 && (slice[0].text ?? "").length > maxChars) {
    truncatedByChars = true;
    const kept = slice[0].text ?? "";
    slice = [
      {
        ...slice[0],
        text: `${kept.slice(0, maxChars)}…`,
      },
    ];
  }

  return {
    turns: slice.map((e) => ({
      kind: e.kind as ChatHistoryTurnKind,
      text: turnText(e.text),
    })),
    truncated: truncatedByCount || truncatedByChars,
  };
};

/** 拼进 chat 起手 prompt 的「本窗口已有对话」段；turns 为空时返空数组 */
export const formatChatHistorySection = (inject: ChatHistoryInject): string[] => {
  // 连续被安全策略拦截、这次一条历史都没带：交代清楚，别让模型当成「新窗口第一句」
  if (inject.turns.length === 0 && inject.omittedForPolicyBlock) {
    return [
      "## 本窗口此前的请求被安全策略连续拦截",
      "",
      `本窗口之前的请求已连续 ${inject.omittedForPolicyBlock} 次被模型方的使用政策拦截（对整份请求内容的自动判定）。为了让会话能重新起来，这次没有带入任何历史对话——下面「用户的新消息」是这个新会话收到的第一句，但它不是窗口里的第一条消息。`,
      "需要前情时：只读上文「任务事件日志」那个文件里 user_reply / assistant_message 的正文；**不要**去读 tool_result / thinking，那里最可能带着被拦的内容。拿不准就直接问用户。",
      "",
    ];
  }
  if (inject.turns.length === 0) return [];

  const lines: string[] = [
    "## 本窗口已有对话（接续，不是新开）",
    "",
    "内存会话已回收，或刚换了模型 / 工作目录。下面是最近几轮用户和你的正文（不含工具过程）。不要把当前这句当成新窗口的第一句。",
    "",
  ];
  for (const turn of inject.turns) {
    lines.push(turn.kind === "user_reply" ? "### 用户" : "### 你", turn.text, "");
  }
  if (inject.truncated) {
    lines.push(
      "更早的对话已省略。需要细节时用 read 读下方事件日志末尾（只要 user_reply / assistant_message）。",
      "",
    );
  }
  return lines;
};
