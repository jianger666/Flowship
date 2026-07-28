/**
 * server 端「当前可推进的 action 清单」（按推进弹窗同一套数据源与分组序拼装）。
 *
 * 供飞书需求群「推进」选择卡 / 「推进 <名字>」模糊匹配用——群里没有 UI，
 * 只能由 server 复算一份与 advance-dialog 一致的可见列表：
 *   - 自定义 action：listCustomActions → usableCustomActions（滤 legacy）
 *     → filterAdvanceByDisabledAppSkills（settings.disabledSkills、关掉的自管 skill 不出现）
 *     → filterAdvanceByRequiresKnowledge + knowledge 派生过滤（团队规范总开关关时隐藏）
 *   - 排序：settings.actionLayout（用户手拖顺序 + 显隐）→ arrangeByLayout
 *   - 分组：groupAdvanceActions（通用 / 团队·wk / 共享 / 自定义、组序走 groupOrder）
 *   - 日常任务（无飞书链接）只留自定义组（filterAdvanceGroupsForDailyTask）
 *
 * 准入软条件（只读仓拦 build、缺 GitLab PAT 拦 ship 等）不在这里过滤——
 * advanceTask 内部会做服务端校验，起不来会以「没能启动」回给用户。
 */

import {
  arrangeByLayout,
  BUILTIN_ADVANCE_ACTIONS,
  filterAdvanceByDisabledAppSkills,
  filterAdvanceByRequiresKnowledge,
  groupAdvanceActions,
  isBuiltinAdvanceAction,
  usableCustomActions,
  type ActionGroupKey,
} from "@/lib/action-layout";
import { filterAdvanceGroupsForDailyTask } from "@/lib/lightweight-task";
import {
  ACTION_LABEL,
  isSharedTeamCategory,
  type ActionType,
  type Task,
} from "@/lib/types";

import { listCustomActions } from "./custom-action-fs";
import { readSettingsFile } from "./settings-fs";
import {
  readDisabledSkills,
  readTeamKnowledgeEnabled,
} from "./skills-loader";

/** 一个可推进项：内置 action 或自定义 action（key = builtin type / custom def id） */
export interface AdvanceOption {
  /** 按钮回调 / 直推匹配用的稳定标识：内置 = ActionType、自定义 = def id（app:xxx / team:xxx） */
  key: string;
  /** 展示名：内置 = 中文标（出方案）、自定义 = def.label */
  label: string;
  /** advanceTask 的 actionType（自定义一律 "custom"） */
  actionType: ActionType;
  /** 仅自定义：定义 id（= key，语义化重复一份、调用方不用再判 isBuiltin） */
  customActionId?: string;
  /** 仅自定义：挂载 skill 名（「推进 <名字>」模糊匹配的第二匹配源） */
  skill?: string;
}

export interface AdvanceOptionGroup {
  key: ActionGroupKey;
  /** 组头文案（通用 / 团队 · wk 流程 / 共享 / 自定义） */
  label: string;
  options: AdvanceOption[];
}

const toStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * 列出某任务当前可推进的 action（分组序 = 推进弹窗同款）。
 * 任一读盘失败按「没配置」兜底（layout 空 / 禁用表空），不抛。
 */
export const listAdvanceOptionGroupsForTask = async (
  task: Pick<Task, "feishuStoryUrl">,
): Promise<AdvanceOptionGroup[]> => {
  // 布局偏好（顺序 + 显隐 + 组序）——config.json 缺失 / 损坏按空布局处理
  let layoutRaw: Record<string, unknown> | null = null;
  try {
    const result = await readSettingsFile();
    const settings = result.status === "ok" ? result.settings : null;
    const al = settings?.actionLayout;
    layoutRaw =
      al && typeof al === "object" && !Array.isArray(al)
        ? (al as Record<string, unknown>)
        : null;
  } catch {
    layoutRaw = null;
  }
  const layout = {
    order: toStrArr(layoutRaw?.order),
    hidden: toStrArr(layoutRaw?.hidden),
  };
  const groupOrder = toStrArr(layoutRaw?.groupOrder);

  // 自定义 action：与推进弹窗同一串过滤链
  let defs = usableCustomActions(await listCustomActions());
  defs = filterAdvanceByDisabledAppSkills(defs, await readDisabledSkills());
  const knowledgeOn = await readTeamKnowledgeEnabled();
  defs = filterAdvanceByRequiresKnowledge(defs, knowledgeOn);
  if (!knowledgeOn) {
    // 团队规范关：knowledge 派生的 team action 一并隐藏（shared: 市场件不受总开关管）
    defs = defs.filter(
      (d) => !(d.origin === "team" && !isSharedTeamCategory(d.teamCategory)),
    );
  }

  const customById = new Map(defs.map((d) => [d.id, d] as const));
  const arranged = arrangeByLayout(
    [...BUILTIN_ADVANCE_ACTIONS, ...defs.map((d) => d.id)],
    layout,
  );
  const groups = filterAdvanceGroupsForDailyTask(
    groupAdvanceActions(
      arranged,
      customById,
      groupOrder.length > 0 ? groupOrder : undefined,
    ),
    task,
  );

  return groups
    .map((g) => ({
      key: g.key,
      label: g.label,
      options: g.keys.flatMap((key): AdvanceOption[] => {
        if (isBuiltinAdvanceAction(key)) {
          return [{ key, label: ACTION_LABEL[key], actionType: key }];
        }
        const def = customById.get(key);
        if (!def) return [];
        return [
          {
            key,
            label: def.label,
            actionType: "custom",
            customActionId: def.id,
            skill: def.skill?.trim() || undefined,
          },
        ];
      }),
    }))
    .filter((g) => g.options.length > 0);
};
