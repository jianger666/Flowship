/**
 * ask_user「是否还该弹窗」的判定（单一源）
 *
 * 背景（断线重启「多弹窗并发」根因）：AskUserDialog 只看「ask_user_request 有没有了结」决定弹不弹。
 * 一条 ask 了结 = 用户答了（ask_user_reply 配对）或被作废（断线重启 / 换 agent / 停止时后端补
 * 一条 info 事件标记 `meta.supersededAskId`）。旧 agent 断掉后那条 ask 的 token 已失效、永远
 * resolve 不了——不把它当「已了结」、前端会反复复活弹窗、用户答了必报错（旧 agent 没了）、
 * 严重时把 runStatus 打回 error 形成死循环。
 *
 * 这套判定原来散在前端 pendingEvent / rows / 后端 supersedePendingAsks 三处、各写一遍易漂移、
 * 收口到这里做单一源（项目约定：同样逻辑两处以上必抽 + 可单测）。
 */

import type { TaskEvent } from "./types";

/** 某条 ask 是否已被用户回答（有对应的 ask_user_reply） */
export const isAskReplied = (events: TaskEvent[], askId: string): boolean =>
  events.some(
    (e) =>
      e.kind === "ask_user_reply" &&
      typeof e.meta?.askId === "string" &&
      e.meta.askId === askId,
  );

/**
 * 某条 ask 是否已被作废：断线重启 / 换 agent / 停止时、后端补一条 info 事件、
 * meta.supersededAskId 指向这条 ask 的 askId。
 */
export const isAskSuperseded = (events: TaskEvent[], askId: string): boolean =>
  events.some(
    (e) =>
      e.kind === "info" &&
      typeof e.meta?.supersededAskId === "string" &&
      e.meta.supersededAskId === askId,
  );

/** 某条 ask 是否已了结（已答 或 已作废）——了结的都不该再弹窗 */
export const isAskSettled = (events: TaskEvent[], askId: string): boolean =>
  isAskReplied(events, askId) || isAskSuperseded(events, askId);

/**
 * 找当前唯一该弹窗的 ask_user_request：倒序扫、第一条「没了结」的就是它。
 * 一次只弹一个（串行）；都了结了返回 null（弹窗关闭）。
 */
export const findPendingAskEvent = (events: TaskEvent[]): TaskEvent | null => {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== "ask_user_request") continue;
    const askId = typeof ev.meta?.askId === "string" ? ev.meta.askId : null;
    if (!askId) continue;
    if (!isAskSettled(events, askId)) return ev;
  }
  return null;
};
