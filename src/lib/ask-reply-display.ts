/**
 * 答题回执的「人话层」（第二轮 review V12-01）。
 *
 * 背景：`ask_user_reply` 事件的 `text` 是**写给 agent / 飞书桥的协议文本**——开头有字面
 * `[ASK_USER_REPLY]`；点「稍后再补充」时更是一整段对 AI 的指令（「再问就是冒犯」…）。
 * 事件流的已答卡 / 过程行原先直接把它渲染出来，用户看到的是协议而不是自己的回答，
 * 卡头还写着「已回答 N 个问题」。
 *
 * 契约：展示层只读结构化的 `meta.answers` / `meta.deferred`，**不改 `text`**（它仍原样送 agent、
 * 供重放 / 飞书桥使用）；`meta` 缺失（老事件 / 脏数据）才退回「去掉协议抬头」的 text。
 * 纯函数（client / server 都能 import，不依赖 React）。
 */

import type { AskUserQuestion, TaskEvent } from "./types";

/** 「稍后再补充」的人话 */
export const ASK_REPLY_DEFERRED_DISPLAY = "已选择稍后再补充";

/** 协议抬头：`[ASK_USER_REPLY]` / `[ASK_USER_REPLY deferred]`（含后面的空行） */
const PROTOCOL_HEAD_RE = /^\s*\[ASK_USER_REPLY(?:\s+deferred)?\]\s*/;

const isDeferredText = (text: string): boolean =>
  /^\s*\[ASK_USER_REPLY\s+deferred\]/.test(text);

interface ParsedAnswer {
  questionId: string;
  answer: string;
}

/** 宽容解析 meta.answers：脏条目跳过；不是数组返回 null（区分「没有结构化数据」和「空答案」） */
const parseAnswers = (meta: TaskEvent["meta"]): ParsedAnswer[] | null => {
  if (!meta || !Array.isArray(meta.answers)) return null;
  const out: ParsedAnswer[] = [];
  for (const raw of meta.answers as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.questionId !== "string") continue;
    out.push({
      questionId: m.questionId,
      answer: typeof m.answer === "string" ? m.answer : "",
    });
  }
  return out;
};

const hasImages = (meta: TaskEvent["meta"]): boolean =>
  !!meta && Array.isArray(meta.images) && meta.images.length > 0;

/**
 * 答题回执给人看的文本。
 * - 稍后再补充 → 「已选择稍后再补充」
 * - 有 `meta.answers` → 逐题「Qn: 问题 / 答：回答」（有题目就按题目顺序、没有就按回答顺序）
 * - 都没有 → 去掉协议抬头的原文
 *
 * @param questions 对应 ask_user_request 的题目（可缺：没有就只列回答，不编问题）
 */
export const askReplyDisplayText = (
  reply: Pick<TaskEvent, "text" | "meta">,
  questions?: readonly AskUserQuestion[],
): string => {
  const meta = reply.meta;
  if (meta?.deferred === true || isDeferredText(reply.text)) {
    return ASK_REPLY_DEFERRED_DISPLAY;
  }

  const answers = parseAnswers(meta);
  if (answers && (answers.length > 0 || (questions?.length ?? 0) > 0)) {
    const byId = new Map(answers.map((a) => [a.questionId, a.answer.trim()]));
    // 图-only（只贴图没填字）：文字答案为空时指向缩略图，别写「未回答」
    const emptyText = hasImages(meta) ? "（见附图）" : "（未回答）";
    const blocks: string[] = [];
    if (questions && questions.length > 0) {
      questions.forEach((q, idx) => {
        const ans = byId.get(q.id) ?? "";
        blocks.push(`Q${idx + 1}: ${q.question}\n答：${ans || emptyText}`);
      });
    } else {
      answers.forEach((a, idx) => {
        blocks.push(`Q${idx + 1}\n答：${a.answer.trim() || emptyText}`);
      });
    }
    return blocks.join("\n\n");
  }

  // 没有结构化数据：老事件 / 脏数据。至少别把协议抬头露给用户
  return reply.text.replace(PROTOCOL_HEAD_RE, "").trim();
};

/**
 * 已答卡的一块展示内容（Q7b-03 / Q6-19）。
 *
 * **答案不走 markdown**：用户答案是任意文本（URL / `a_b-c` / `====` / `?a=1&b=2#f!`…），
 * 先前「反斜杠转义 + MarkdownText」会被 GFM 裸链接识别（在转义之前）吃掉整串，
 * 渲染成文字带 `\`、href 带 `%5C` 的坏链接；`=` 没转义时单独一行 `====` 还会把上一行变标题。
 * 转义补丁补不完（每个新语法都要追），所以结构上分开：
 * - `question`：题目（AI 写的）——走 `MarkdownText`（`null` = 没有题目文本，只有序号标签）
 * - `answer`：答案行 `答：<原文>`——**纯文本**，用 `whitespace-pre-wrap break-words` 容器逐字渲染
 * - `plain`：「稍后再补充」/ 无结构化数据的兜底全文——同样纯文本
 */
export type AskReplyDisplayBlock =
  | { kind: "qa"; label: string; question: string | null; answer: string }
  | { kind: "plain"; text: string };

/**
 * 答题回执给已答卡渲染的结构化版本。语义与 {@link askReplyDisplayText} 一致
 * （同样的「稍后再补充」/ 兜底 / 空答案占位），区别只是题目与答案分开返回，由调用方分别渲染。
 * 答案对任意输入**逐字**返回（仅首尾空白 trim，与纯文本版一致）。
 */
export const askReplyDisplayBlocks = (
  reply: Pick<TaskEvent, "text" | "meta">,
  questions?: readonly AskUserQuestion[],
): AskReplyDisplayBlock[] => {
  const meta = reply.meta;
  if (meta?.deferred === true || isDeferredText(reply.text)) {
    return [{ kind: "plain", text: ASK_REPLY_DEFERRED_DISPLAY }];
  }
  const answers = parseAnswers(meta);
  if (answers && (answers.length > 0 || (questions?.length ?? 0) > 0)) {
    const byId = new Map(answers.map((a) => [a.questionId, a.answer.trim()]));
    const emptyText = hasImages(meta) ? "（见附图）" : "（未回答）";
    const answerLine = (raw: string): string => `答：${raw || emptyText}`;
    if (questions && questions.length > 0) {
      return questions.map((q, idx) => ({
        kind: "qa" as const,
        label: `Q${idx + 1}`,
        question: q.question,
        answer: answerLine(byId.get(q.id) ?? ""),
      }));
    }
    return answers.map((a, idx) => ({
      kind: "qa" as const,
      label: `Q${idx + 1}`,
      question: null,
      answer: answerLine(a.answer.trim()),
    }));
  }
  return [{ kind: "plain", text: reply.text.replace(PROTOCOL_HEAD_RE, "").trim() }];
};

/** 一句话摘要（过程行折叠态用）：多题用「 · 」连，已是人话、不含协议词 */
export const askReplyDisplaySummary = (
  reply: Pick<TaskEvent, "text" | "meta">,
  questions?: readonly AskUserQuestion[],
): string => {
  const meta = reply.meta;
  if (meta?.deferred === true || isDeferredText(reply.text)) {
    return ASK_REPLY_DEFERRED_DISPLAY;
  }
  const answers = parseAnswers(meta);
  if (answers && answers.length > 0) {
    const emptyText = hasImages(meta) ? "（见附图）" : "（未回答）";
    const byId = new Map(answers.map((a) => [a.questionId, a.answer.trim()]));
    const ordered =
      questions && questions.length > 0
        ? questions.map((q) => byId.get(q.id) ?? "")
        : answers.map((a) => a.answer.trim());
    return ordered.map((a) => a || emptyText).join(" · ");
  }
  return reply.text.replace(PROTOCOL_HEAD_RE, "").trim();
};
