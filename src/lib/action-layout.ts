/**
 * 推进面板布局：按用户偏好对 action key 排序 + 分「主区 / 折叠（更多）」。
 *
 * 「推进」弹窗的内置组、自定义组各调一次本函数（两组各自排、不混排）。
 * 偏好来自 settings.actionLayout（个人级、落 config.json）。
 */

import type { ActionType } from "./types";

// 推进面板内置 action 的默认顺序——advance-dialog 渲染 + /actions 布局配置页共用、单一来源。
// custom 不在内（自定义 action 走单独清单、按 id 排）。
export const BUILTIN_ADVANCE_ACTIONS: Exclude<ActionType, "custom">[] = [
  "plan",
  "build",
  "review",
  "dev",
  "ship",
  "learn",
];

const BUILTIN_SET = new Set<string>(BUILTIN_ADVANCE_ACTIONS);

// key 是不是内置推进 action——混排列表里区分内置 / 自定义（自定义 key 是 custom id）
export const isBuiltinAdvanceAction = (
  key: string,
): key is Exclude<ActionType, "custom"> => BUILTIN_SET.has(key);

/**
 * 仅按 order 排一组 action key（不分显隐、hidden 项保持在它的 order 位置）。
 * - order 里出现的按其下标排前；没出现的（新加项）靠稳定排序保持传入的原始相对顺序、排末尾
 * 泛型 T 保留入参字面量类型（内置传 Exclude<ActionType,"custom">[]、自定义传 string[]）。
 * 「推进」弹窗用 arrangeByLayout（要分显隐）；/actions 布局配置页用本函数（要全序、含隐藏项在原位）。
 */
export const sortByOrder = <T extends string>(
  keys: readonly T[],
  order: string[],
): T[] => {
  const orderIndex = new Map(order.map((k, i) => [k, i] as const));
  const rank = (k: string): number =>
    orderIndex.has(k) ? orderIndex.get(k)! : Number.MAX_SAFE_INTEGER;
  // Array.sort 稳定：同 rank（都不在 order 里的新项）保持传入的原始顺序
  return [...keys].sort((a, b) => rank(a) - rank(b));
};

/**
 * 按布局偏好排一组 action key + 分「主区 / 折叠（更多）」。
 * - 顺序走 sortByOrder
 * - hidden 命中的归入 folded（展开后仍可选、不是禁用）
 */
export const arrangeByLayout = <T extends string>(
  keys: readonly T[],
  layout: { order: string[]; hidden: string[] },
): { visible: T[]; folded: T[] } => {
  const sorted = sortByOrder(keys, layout.order);
  const hiddenSet = new Set(layout.hidden);
  return {
    visible: sorted.filter((k) => !hiddenSet.has(k)),
    folded: sorted.filter((k) => hiddenSet.has(k)),
  };
};
