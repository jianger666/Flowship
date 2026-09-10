/**
 * 说话条手动选模型的粘住覆盖（按任务存 localStorage）。
 *
 * 单一来源：key 格式与读写清只在这里，切提供方的两个入口跟说话条都调同一份，
 * 防“切提供方后旧覆盖阴魂不散、拿上一家的模型 id 往新提供方发”。
 *
 * SSR 安全：server 侧没有 window，一律按“无覆盖”处理。
 */

import type { ModelSelection } from "@/lib/types";

export const talkOverrideKey = (taskId: string): string =>
  `flowship:talk-model-override:${taskId}`;

export const loadTalkOverride = (taskId: string): ModelSelection | null => {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(talkOverrideKey(taskId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModelSelection>;
    if (typeof parsed?.id !== "string" || !parsed.id.trim()) return null;
    return {
      id: parsed.id,
      ...(Array.isArray(parsed.params) ? { params: parsed.params } : {}),
    };
  } catch {
    return null;
  }
};

export const saveTalkOverride = (
  taskId: string,
  next: ModelSelection | null,
): void => {
  try {
    if (typeof window === "undefined") return;
    if (!next) window.localStorage.removeItem(talkOverrideKey(taskId));
    else window.localStorage.setItem(talkOverrideKey(taskId), JSON.stringify(next));
  } catch {
    // quota 满等失败不影响主流程
  }
};

/** 切提供方 / 跟上新会话时清掉旧覆盖（跟清会话锚点放一起，语义最正）。 */
export const clearTalkOverride = (taskId: string): void =>
  saveTalkOverride(taskId, null);
