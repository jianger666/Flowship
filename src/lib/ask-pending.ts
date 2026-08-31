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
 *
 * 顺带收了 ask 事件 meta 的解析（{@link extractAskQuestions}）——同一份解析原本在
 * 答题卡 / 回放行 / ask-reply 路由各有一份拷贝。本文件保持纯函数、client / server 共用。
 */

import type { AskUserQuestion, TaskEvent } from "./types";

/**
 * 「用户没答、直接发了新消息」这一种作废的 meta 标记（写在作废 info 事件上）。
 *
 * 为什么不另起一种事件 kind：了结判定（{@link isAskSettled} / {@link findPendingAskEvent}）
 * 必须只有一套——跳过就是作废的一种，仍走 `meta.supersededAskId`，这个布尔只额外回答
 * 「作废的原因是不是用户主动跳过」，供 UI 显示「已跳过」而不是中性的「已失效」。
 */
export const ASK_SKIPPED_META_KEY = "askSkipped";

/**
 * 「等待超过 24 小时、本轮已结束」这一种作废的 meta 标记。
 * 仍走 `meta.supersededAskId`（了结判定只有一套），这个布尔只额外回答
 * 「作废原因是不是硬超时」，供 UI 显示「已过期」而不是中性的「已失效」。
 */
export const ASK_EXPIRED_META_KEY = "askExpired";

/** 事件流里那条过期标记的文案（UI 会把它折成一行「已过期」，本行不单独渲染） */
export const ASK_EXPIRED_EVENT_TEXT =
  "上一组提问已过期（等待超过 24 小时）、无需再回答。";

/** 提交已过期提问时给用户看的一句（接口 409 + toast） */
export const ASK_EXPIRED_USER_MESSAGE = "这组提问已过期，请在下方继续";

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

/**
 * 某条 ask 是否是「被用户跳过」作废的（用户没答、直接发了新消息）。
 * 是 {@link isAskSuperseded} 的子集——UI 据此把卡片收成一行「已跳过」。
 */
export const isAskSkipped = (events: TaskEvent[], askId: string): boolean =>
  events.some(
    (e) =>
      e.kind === "info" &&
      typeof e.meta?.supersededAskId === "string" &&
      e.meta.supersededAskId === askId &&
      e.meta[ASK_SKIPPED_META_KEY] === true,
  );

/**
 * 这条 info 事件就是「用户跳过」的作废标记本身吗。
 *
 * 事件流渲染要把它滤掉：同一件事已经由那条 ask 折叠行（「AI 提过 N 个问题 · 已跳过」）
 * 说清楚了，再多一行「上一组提问已跳过…」就是同话说两遍。**只滤显示、不滤数据**——
 * 标记仍在 events.jsonl 里，了结判定全靠它。
 */
export const isAskSkipMarkerEvent = (ev: TaskEvent): boolean =>
  ev.kind === "info" &&
  typeof ev.meta?.supersededAskId === "string" &&
  ev.meta[ASK_SKIPPED_META_KEY] === true;

/**
 * 某条 ask 是否是「等待超过 24 小时」作废的。
 * 是 {@link isAskSuperseded} 的子集——UI 据此把卡片收成一行「已过期」。
 */
export const isAskExpired = (events: TaskEvent[], askId: string): boolean =>
  events.some(
    (e) =>
      e.kind === "info" &&
      typeof e.meta?.supersededAskId === "string" &&
      e.meta.supersededAskId === askId &&
      e.meta[ASK_EXPIRED_META_KEY] === true,
  );

/**
 * 这条 info 事件就是「等待超时」的作废标记本身吗。
 * 跟跳过标记一样只滤显示、不滤数据——话由 ask 折叠行说。
 */
export const isAskExpireMarkerEvent = (ev: TaskEvent): boolean =>
  ev.kind === "info" &&
  typeof ev.meta?.supersededAskId === "string" &&
  ev.meta[ASK_EXPIRED_META_KEY] === true;

/** 某条 ask 是否已了结（已答 或 已作废）——了结的都不该再弹窗 */
export const isAskSettled = (events: TaskEvent[], askId: string): boolean =>
  isAskReplied(events, askId) || isAskSuperseded(events, askId);

/**
 * 找当前唯一该弹窗的 ask_user_request：**只看最新一条**——没了结就弹它、了结了直接 null。
 *
 * 为什么不继续往前找「更老的未了结 ask」（同事踩坑、2026-07 修）：后端 pending 是单例、
 * 新 ask 注册即顶掉旧 ask、旧 ask 的 token 已死、永远不可能再被成功回答——把老的未了结 ask
 * 复活弹出来、用户答了必失败（严重时把还在跑的任务误标 error）。后端现在写新 ask 前会补作废
 * 标记、这里只认最新一条是同一不变量的前端兜底（顺带救活存量脏数据任务）。
 */
export const findPendingAskEvent = (events: TaskEvent[]): TaskEvent | null => {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== "ask_user_request") continue;
    const askId = typeof ev.meta?.askId === "string" ? ev.meta.askId : null;
    // 缺 askId 的脏数据跳过、继续往前找
    if (!askId) continue;
    return isAskSettled(events, askId) ? null : ev;
  }
  return null;
};

/** 读一条 ask_user_request 事件的 askId（缺 / 类型不对返 null） */
export const askIdOfEvent = (ev: TaskEvent): string | null =>
  typeof ev.meta?.askId === "string" && ev.meta.askId ? ev.meta.askId : null;

/**
 * 从 ask_user_request 事件的 meta 里解析出题目数组（宽容：脏条目跳过、坏 meta 返空）。
 *
 * 单一源：答题卡（客户端）、事件流回放行（客户端）、ask-reply 路由（服务端）、
 * 跳过收口（服务端）四处都要同一份解析，原先各写了一遍。
 */
export const extractAskQuestions = (
  meta: TaskEvent["meta"],
): AskUserQuestion[] => {
  if (!meta || !Array.isArray(meta.questions)) return [];
  const out: AskUserQuestion[] = [];
  for (const item of meta.questions as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.question !== "string") continue;
    const options: AskUserQuestion["options"] = [];
    if (Array.isArray(m.options)) {
      for (const optRaw of m.options as unknown[]) {
        if (!optRaw || typeof optRaw !== "object") continue;
        const o = optRaw as Record<string, unknown>;
        if (typeof o.id === "string" && typeof o.label === "string") {
          options.push({ id: o.id, label: o.label });
        }
      }
    }
    out.push({
      id: m.id,
      question: m.question,
      options: options.length > 0 ? options : undefined,
      allowText: typeof m.allowText === "boolean" ? m.allowText : true,
    });
  }
  return out;
};
