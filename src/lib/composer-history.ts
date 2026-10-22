/**
 * 输入框 ↑ 历史的数据源（纯函数、单一来源）
 *
 * 两个语境各有各的「上一条我说过的话」：
 * - 事件流输入条 / chat：本会话 user_reply 文本
 * - 推进弹窗：本 task 历次 action 的用户指令
 *
 * 两者产出的都是 ComposerSession.inputHistory 约定的 **新→旧** 列表
 *（↑ 先翻最近一条）、去空 + 连续相同去重。
 */

import { isHiddenFromEventStream } from "./event-stream-hidden";
import type { ActionRecord, TaskEvent } from "./types";

/** 相邻重复不入列（连着发两条一样的、↑ 不该按两下才动） */
const pushIfNotRepeat = (out: string[], text: string): void => {
  const t = text.trim();
  if (!t) return;
  if (out.length > 0 && out[out.length - 1] === t) return;
  out.push(t);
};

/**
 * 从 events 抽 user_reply 文本，新→旧、去空、连续相同去重。
 *
 * 事件流里被藏起来的 user_reply（群里陌生人的提问、被消音的等）不进历史：
 * 否则属主按 ↑ 会把别人的话填进自己的输入框。隐藏口径只认 isHiddenFromEventStream
 * 这一个闸，别在这里另写判定。不传 isChat：该闸的 isChat 分支只处理 info 类启动噪声，
 * 对 user_reply 无影响（日后若加 chat 专属的 user_reply 隐藏规则，这里要跟着透传）。
 */
export const buildInputHistory = (events: TaskEvent[]): string[] => {
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind !== "user_reply") continue;
    if (isHiddenFromEventStream(ev)) continue;
    pushIfNotRepeat(out, ev.text ?? "");
  }
  return out;
};

/**
 * task 页「跟 AI 说」输入条的 ↑ 历史：本会话 user_reply + 历次 action 的用户指令，按时间合并，
 * 新→旧、去空、相邻相同去重（第三轮 review D8-03）。
 *
 * 为什么不只用 {@link buildInputHistory}：task 页的 events 只是最近一段窗口（task.eventsTruncated），
 * 一轮长 run 之后重开页面，窗口里可能一条 user_reply 都没有、↑ 翻不到任何东西；
 * 而推进时输入的指令住在 task.actions（meta 里完整保存、不受事件窗口影响），补上它历史才稳定。
 * 过滤口径与两个单来源函数一致：被藏起来的 user_reply、被划除的 action 都不进。
 */
export const buildTaskInputHistory = (
  events: readonly TaskEvent[],
  actions: readonly ActionRecord[],
): string[] => {
  const entries: Array<{ ts: number; order: number; text: string }> = [];
  for (const ev of events) {
    if (ev.kind !== "user_reply" || isHiddenFromEventStream(ev)) continue;
    entries.push({ ts: ev.ts, order: entries.length, text: ev.text ?? "" });
  }
  for (const a of actions) {
    if (a.excluded) continue;
    entries.push({ ts: a.startedAt, order: entries.length, text: a.userInstruction ?? "" });
  }
  // 同一时刻按出现顺序（后出现的算更新）；排序不改入参
  entries.sort((x, y) => y.ts - x.ts || y.order - x.order);
  const out: string[] = [];
  for (const e of entries) pushIfNotRepeat(out, e.text);
  return out;
};

/**
 * 从 action 历史抽用户指令，新→旧、去空、连续相同去重。
 * 划除（excluded）的 action 已被排出 agent 上下文、这里同口径不进历史。
 */
export const buildActionInstructionHistory = (
  actions: ActionRecord[],
): string[] => {
  const out: string[] = [];
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i]!;
    if (a.excluded) continue;
    pushIfNotRepeat(out, a.userInstruction ?? "");
  }
  return out;
};
