/**
 * 群答疑「不回」的唯一约定：**回复的第一个非空行就是 `NO_REPLY`** → 群里什么都不发。
 *
 * 2026-11-06 用户拍板「协议不用管、让 AI 自己判断」：原先那套回复协议（`[[需属主确认：…]]` 标记、
 * `@名字` 换真 @、哨兵的各种包裹 / 解释变体，一千多行）整套删掉，回复按 AI 写的原样发出（流式）。
 * 只留这一条：AI 判断「不用回」时总得有个办法说出来，否则只能硬着头皮发一句「收到」，
 * 两个机器人就会互相客气下去。宽松判定：只看首个非空行、只看字母数字（`NO_REPLY` / `no reply` /
 * `` `NO_REPLY` `` / `**NO-REPLY**。` 都算）；**首行必须就是哨兵本身**，它后面另起的行（模型的自我解释）不外发。
 * 哨兵和别的字写在同一行（`NO_REPLY：对方只是确认`）不算——宁可把这句发出去，也不吞掉一条真回复。
 *
 * 流式下的难点：回复是一个字一个字出来的，卡不能在「也许是 NO_REPLY」的时候就建出来。
 * {@link judgeGroupReply} 给三态：`undecided` 先别建卡；`silent` 整条不发；`speak` 可以起卡。
 */

import { GROUP_NO_REPLY_TOKEN } from "./group-contract";

/** 折叠成「只剩字母数字、大写」——用来和哨兵比对（吃掉引号 / 反引号 / 星号 / 标点 / 空白 / 下划线连字符） */
const fold = (s: string): string =>
  s
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();

const SENTINEL_FOLDED = fold(GROUP_NO_REPLY_TOKEN);

/** 首行还没写完时，最多等到这么多字符就当它不是哨兵（避免 emoji / 标点开头的回复一直不起卡） */
const UNDECIDED_MAX_CHARS = 24;

/** 首个非空行 + 它后面是否已经换行（行写完了）；全空返回 null */
const firstLine = (text: string): { line: string; closed: boolean } | null => {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() !== "");
  if (idx < 0) return null;
  return { line: lines[idx]!, closed: lines.length > idx + 1 };
};

/** 一整条回复（已收尾）是不是「不回」 */
export const isSilentGroupReply = (text: string): boolean => {
  const first = firstLine(text);
  return first !== null && fold(first.line) === SENTINEL_FOLDED;
};

export type GroupReplyVerdict = "silent" | "speak" | "undecided";

/** 流式中途判定：现有文本够不够下结论（`undecided` = 再等几个字） */
export const judgeGroupReply = (text: string): GroupReplyVerdict => {
  const first = firstLine(text);
  if (!first) return "undecided";
  const folded = fold(first.line);
  if (folded === SENTINEL_FOLDED) {
    // 哨兵词本身写完且行已结束 → 静默；行还没结束（后面可能紧跟别的字）再等等
    return first.closed ? "silent" : "undecided";
  }
  // 还只是哨兵的前缀（`N` / `NO` / `NO_RE` / 纯标点）且没写满 → 先别起卡
  if (
    !first.closed &&
    text.trim().length <= UNDECIDED_MAX_CHARS &&
    SENTINEL_FOLDED.startsWith(folded)
  ) {
    return "undecided";
  }
  return "speak";
};
