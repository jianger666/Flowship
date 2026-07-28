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

import type { ActionRecord, TaskEvent } from "./types";

/** 相邻重复不入列（连着发两条一样的、↑ 不该按两下才动） */
const pushIfNotRepeat = (out: string[], text: string): void => {
  const t = text.trim();
  if (!t) return;
  if (out.length > 0 && out[out.length - 1] === t) return;
  out.push(t);
};

/** 从 events 抽 user_reply 文本，新→旧、去空、连续相同去重 */
export const buildInputHistory = (events: TaskEvent[]): string[] => {
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind !== "user_reply") continue;
    pushIfNotRepeat(out, ev.text ?? "");
  }
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
