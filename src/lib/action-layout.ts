/**
 * 推进面板布局：按用户偏好对 action key 排序 + 过滤隐藏项 + 固定三组分组。
 *
 * v0.9.12 起隐藏语义彻底化：/actions 页关掉的 action 在「推进」弹窗直接不出现
 *（原「更多」折叠区删了——关了就关了、要用去 /actions 页重新开启）。
 * 偏好来自 settings.actionLayout（个人级、落 config.json）。
 *
 * 分组（渲染层、内置固定三组）：通用 / 团队·wk 流程 / 自定义；
 * 组顺序 + 默认折叠走 actionLayout.groupOrder / collapsedGroups。
 */

import type { ActionLayoutPref, ActionType, CustomActionDef } from "./types";

// 推进面板内置 action 的默认顺序——advance-dialog 渲染 + /actions 布局配置页共用、单一来源。
// custom 不在内（自定义 action 走单独清单、按 id 排）。
export const BUILTIN_ADVANCE_ACTIONS: Exclude<ActionType, "custom">[] = [
  "plan",
  "build",
  "review",
  "dev",
  "ship",
];

const BUILTIN_SET = new Set<string>(BUILTIN_ADVANCE_ACTIONS);

// key 是不是内置推进 action——混排列表里区分内置 / 自定义（自定义 key 是 custom id）
export const isBuiltinAdvanceAction = (
  key: string,
): key is Exclude<ActionType, "custom"> => BUILTIN_SET.has(key);

/** 推进弹窗固定三组 key（渲染层归属判定用） */
export type ActionGroupKey = "builtin" | "team" | "custom";

/** 组顺序默认：通用 → 团队 · wk 流程 → 自定义 */
export const DEFAULT_GROUP_ORDER: ActionGroupKey[] = [
  "builtin",
  "team",
  "custom",
];

/** 组标题文案（能力页 + 推进弹窗共用） */
export const ACTION_GROUP_LABEL: Record<ActionGroupKey, string> = {
  builtin: "通用",
  team: "团队 · wk 流程",
  custom: "自定义",
};

const GROUP_KEY_SET = new Set<string>(DEFAULT_GROUP_ORDER);

export const isActionGroupKey = (k: string): k is ActionGroupKey =>
  GROUP_KEY_SET.has(k);

/**
 * 归一 groupOrder：只留合法三组、去重、缺的补到末尾（保证始终恰好三组）。
 */
export const normalizeGroupOrder = (raw: string[] | undefined): ActionGroupKey[] => {
  const seen = new Set<ActionGroupKey>();
  const out: ActionGroupKey[] = [];
  for (const k of raw ?? []) {
    if (!isActionGroupKey(k) || seen.has(k)) continue;
    out.push(k);
    seen.add(k);
  }
  for (const k of DEFAULT_GROUP_ORDER) {
    if (!seen.has(k)) out.push(k);
  }
  return out;
};

/**
 * 归一 collapsedGroups：只留合法组 key、去重。
 */
export const normalizeCollapsedGroups = (
  raw: string[] | undefined,
): ActionGroupKey[] => {
  const seen = new Set<ActionGroupKey>();
  const out: ActionGroupKey[] = [];
  for (const k of raw ?? []) {
    if (!isActionGroupKey(k) || seen.has(k)) continue;
    out.push(k);
    seen.add(k);
  }
  return out;
};

/**
 * 空 / 缺省布局偏好（全显示、默认组序、全展开）。
 * local-store 归一 + 调用方兜底共用。
 */
export const emptyActionLayout = (): ActionLayoutPref => ({
  order: [],
  hidden: [],
  groupOrder: [...DEFAULT_GROUP_ORDER],
  collapsedGroups: [],
});

/**
 * 判定 action key 归属哪一组。
 * - builtin：内置 ActionType
 * - team：origin=team 的派生
 * - custom：其余（legacy 自建 + app 壳派生）
 */
export const resolveActionGroup = (
  key: string,
  customById: ReadonlyMap<string, Pick<CustomActionDef, "origin">>,
): ActionGroupKey => {
  if (isBuiltinAdvanceAction(key)) return "builtin";
  if (customById.get(key)?.origin === "team") return "team";
  return "custom";
};

export type AdvanceActionGroup = {
  key: ActionGroupKey;
  label: string;
  keys: string[];
};

export type PartitionGroupsOptions = {
  /** 能力页：空组也出组头（用户能配折叠 / 看到组存在）；推进弹窗默认 false */
  includeEmpty?: boolean;
  /** 推进弹窗：team 组按 CustomActionDef.order 升序；能力页拖拽序优先、默认 false */
  sortTeamByDefOrder?: boolean;
};

/**
 * 按组归属分桶，再按 groupOrder 出组（能力页 / 推进弹窗共用）。
 * - 组内相对顺序默认保持传入 keys 顺序
 * - sortTeamByDefOrder：team 组有 order 的升序靠前、无 order 的接后
 * - includeEmpty：空组也返回（能力页配置用）
 */
export const partitionActionsByGroup = (
  keys: readonly string[],
  customById: ReadonlyMap<string, Pick<CustomActionDef, "origin" | "order">>,
  groupOrder: string[] | undefined = DEFAULT_GROUP_ORDER,
  options: PartitionGroupsOptions = {},
): AdvanceActionGroup[] => {
  const { includeEmpty = false, sortTeamByDefOrder = false } = options;
  const buckets: Record<ActionGroupKey, string[]> = {
    builtin: [],
    team: [],
    custom: [],
  };
  for (const key of keys) {
    buckets[resolveActionGroup(key, customById)].push(key);
  }
  if (sortTeamByDefOrder) {
    buckets.team = sortTeamKeysByDefOrder(buckets.team, customById);
  }

  return normalizeGroupOrder(groupOrder)
    .map((key) => ({
      key,
      label: ACTION_GROUP_LABEL[key],
      keys: buckets[key],
    }))
    .filter((g) => includeEmpty || g.keys.length > 0);
};

/**
 * 推进弹窗：分桶后空组不返回；team 组按 def.order 升序。
 */
export const groupAdvanceActions = (
  keys: readonly string[],
  customById: ReadonlyMap<string, Pick<CustomActionDef, "origin" | "order">>,
  groupOrder: string[] | undefined = DEFAULT_GROUP_ORDER,
): AdvanceActionGroup[] =>
  partitionActionsByGroup(keys, customById, groupOrder, {
    sortTeamByDefOrder: true,
  });

/** team 组内：有 order 升序靠前；无 order 保持相对顺序接后 */
const sortTeamKeysByDefOrder = (
  keys: string[],
  customById: ReadonlyMap<string, Pick<CustomActionDef, "order">>,
): string[] => {
  const withOrder: { key: string; order: number }[] = [];
  const without: string[] = [];
  for (const key of keys) {
    const o = customById.get(key)?.order;
    if (typeof o === "number" && Number.isFinite(o)) {
      withOrder.push({ key, order: o });
    } else {
      without.push(key);
    }
  }
  withOrder.sort((a, b) => a.order - b.order);
  return [...withOrder.map((x) => x.key), ...without];
};

/**
 * 推进弹窗可用的自定义 action：旧格式（legacyPlaybook 残留）已停用、直接滤掉。
 * 能力页列表不走本函数（legacy 要展示出来供查看 / 删除）。
 */
export const usableCustomActions = (
  defs: CustomActionDef[],
): CustomActionDef[] => defs.filter((d) => !d.legacyPlaybook);

/**
 * 推进面板：主 skill 为自管源且已关闭 → 对应自建 action 隐藏（开回来即恢复）。
 * 只拦面板入口；运行时 findSkillByName 直读不过滤（历史任务重启不炸）。
 * team 派生 action 不动（走 skill-states 安装态）。
 * origin=app-skill / 缺省（旧残留）都按 skill 名查禁用表。
 */
export const filterAdvanceByDisabledAppSkills = (
  defs: CustomActionDef[],
  disabledAppSkillNames: ReadonlySet<string>,
): CustomActionDef[] => {
  if (disabledAppSkillNames.size === 0) return defs;
  return defs.filter((d) => {
    if (d.origin === "team") return true;
    const skill = d.skill?.trim();
    if (!skill) return true;
    return !disabledAppSkillNames.has(skill);
  });
};

/**
 * 团队规范总开关关时：隐藏 requiresKnowledge=true 的派生 action（app / team 同构）。
 * enabled=true → 原样；仅严格 true 才藏（缺省 / false 都保留）。
 */
export const filterAdvanceByRequiresKnowledge = (
  defs: CustomActionDef[],
  teamKnowledgeEnabled: boolean,
): CustomActionDef[] => {
  if (teamKnowledgeEnabled) return defs;
  return defs.filter((d) => d.requiresKnowledge !== true);
};

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

/**
 * 从布局偏好里清掉某个 action id（删自定义 action 后同步调、防 order/hidden 残留鬼影 id）。
 * groupOrder / collapsedGroups 原样保留。
 */
export const removeActionLayoutId = (
  layout: ActionLayoutPref,
  id: string,
): ActionLayoutPref => ({
  ...layout,
  order: layout.order.filter((k) => k !== id),
  hidden: layout.hidden.filter((k) => k !== id),
});
