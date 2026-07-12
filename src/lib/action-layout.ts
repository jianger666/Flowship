/**
 * 推进面板布局：按用户偏好对 action key 排序 + 过滤隐藏项。
 *
 * v0.9.12 起隐藏语义彻底化：/actions 页关掉的 action 在「推进」弹窗直接不出现
 *（原「更多」折叠区删了——关了就关了、要用去 /actions 页重新开启）。
 * 偏好来自 settings.actionLayout（个人级、落 config.json）。
 */

import type { ActionType, CustomActionDef } from "./types";

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

/**
 * 推进弹窗可用的自定义 action：旧格式（legacyPlaybook 残留）已停用、直接滤掉。
 * 能力页列表不走本函数（legacy 要展示出来供查看 / 删除）。
 */
export const usableCustomActions = (
  defs: CustomActionDef[],
): CustomActionDef[] => defs.filter((d) => !d.legacyPlaybook);

// key 是不是内置推进 action——混排列表里区分内置 / 自定义（自定义 key 是 custom id）
export const isBuiltinAdvanceAction = (
  key: string,
): key is Exclude<ActionType, "custom"> => BUILTIN_SET.has(key);

/**
 * 仅按 order 排一组 action key（不分显隐、hidden 项保持在它的 order 位置）。
 * - order 里出现的按其下标排前；没出现的（新加项）靠稳定排序保持传入的原始相对顺序、排末尾
 * 泛型 T 保留入参字面量类型（内置传 Exclude<ActionType,"custom">[]、自定义传 string[]）。
 * 「推进」弹窗用 arrangeByLayout（要过滤隐藏）；/actions 布局配置页用本函数（要全序、含隐藏项在原位）。
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
 * 按布局偏好排一组 action key + 过滤隐藏项（「推进」弹窗只渲染返回值）。
 * - 顺序走 sortByOrder
 * - hidden 命中的直接不出现（重新启用去 /actions 页开开关）
 * - 全部被隐藏时返回空数组——「推进」弹窗显示空态引导去 /actions 页、不把用户关掉的又摆出来
 */
export const arrangeByLayout = <T extends string>(
  keys: readonly T[],
  layout: { order: string[]; hidden: string[] },
): T[] => {
  const sorted = sortByOrder(keys, layout.order);
  const hiddenSet = new Set(layout.hidden);
  return sorted.filter((k) => !hiddenSet.has(k));
};
