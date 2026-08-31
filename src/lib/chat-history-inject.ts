/**
 * chat 起新会话时的「接续历史」切片（resume 失败 / 懒重启 / 空闲回收后）。
 *
 * 只取 user_reply / assistant_message 正文、不含 thinking / 工具过程。
 * 轮数 + 字符双封顶，避免把整份 events.jsonl 灌进第一轮。
 * resume 成功时根本不走这里——历史已在会话文件里。
 */

export const HISTORY_INJECT_MAX_TURNS = 12;
/** ~4k token 量级，相对起手系统 prompt（常 60KB+）是零头 */
export const HISTORY_INJECT_MAX_CHARS = 12_000;
/** 从文件尾扫这么多事件，才能在工具密集的对话里凑够上面的轮数 */
export const HISTORY_INJECT_SCAN_EVENTS = 500;

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
};

const isHistoryTurnKind = (kind: string): kind is ChatHistoryTurnKind =>
  kind === "user_reply" || kind === "assistant_message";

const turnText = (text: string | undefined): string => {
  const t = text?.trim() ?? "";
  return t.length > 0 ? t : "(空)";
};

export const selectChatHistoryTurns = (
  events: ReadonlyArray<{ id?: string; kind: string; text?: string }>,
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

  const truncatedByCount = filtered.length > HISTORY_INJECT_MAX_TURNS;
  let slice = truncatedByCount
    ? filtered.slice(-HISTORY_INJECT_MAX_TURNS)
    : filtered;

  let truncatedByChars = false;
  let total = slice.reduce((n, e) => n + (e.text ?? "").length, 0);
  while (slice.length > 1 && total > HISTORY_INJECT_MAX_CHARS) {
    truncatedByChars = true;
    const dropped = slice[0];
    slice = slice.slice(1);
    total -= (dropped.text ?? "").length;
  }
  if (slice.length === 1 && (slice[0].text ?? "").length > HISTORY_INJECT_MAX_CHARS) {
    truncatedByChars = true;
    const kept = slice[0].text ?? "";
    slice = [
      {
        ...slice[0],
        text: `${kept.slice(0, HISTORY_INJECT_MAX_CHARS)}…`,
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
