/**
 * Skills 面板共享类型 / 常量 / 纯函数（chip 过滤等、供单测）
 */

import {
  isSharedTeamCategory,
  labelTeamCategoryBadge,
  labelTeamSharedCategory,
  parseSharedCategory,
} from "@/lib/types";

/** 跟 /api/skills 返回对齐的条目形态 */
export interface SkillRow {
  name: string;
  description: string;
  source: "builtin" | "app" | "feishu-cli" | "team";
  editable: boolean;
  /**
   * 启停语义按来源分：
   * - team shared = 已安装（skill-states，市场装卸）
   * - team knowledge = 已启用（同一 skill-states，Switch 启停）
   * - app = 未被 disabledSkills 关
   * - 内置 / 飞书 CLI = 恒 true（必备只读）
   */
  enabled: boolean;
  absPath: string;
  /** 展示用短路径（home 缩成 ~） */
  displayPath?: string;
  /** team 源：shared:<cat>（组内沉淀）或 knowledge 顶层目录名（global/frontend/...） */
  teamCategory?: string;
  /**
   * 行上亮「action」tag：team 源 = 带 .flowship-action.json（安装即派生推进 action）；
   * 自管源 = 被本地 custom action 挂载（skills-card refresh 时补填）
   */
  teamAction?: boolean;
  /** team 源：创建人（共享库 git 首次引入者；小字展示、没有不显示） */
  author?: string;
}

export interface CursorGlobalSkill {
  dirName: string;
  name: string;
  description: string;
}

export const SOURCE_LABEL: Record<SkillRow["source"], string> = {
  builtin: "内置",
  app: "自管",
  "feishu-cli": "飞书 CLI",
  team: "团队",
};

/** 左栏导航：永远只有 5 项来源、无嵌套 */
export type SourceNavKey =
  | "app"
  | "shared"
  | "knowledge"
  | "builtin"
  | "feishu-cli";

/** 上传分类 chip 固定顺序（含 common） */
export const UPLOAD_CATEGORIES = [
  "common",
  "fe",
  "be",
  "qa",
  "other",
] as const;

export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number];

export const labelUploadCategory = (cat: string): string =>
  labelTeamSharedCategory(cat);

/** shared 条目的分类名（shared:fe → fe；异常兜底 common） */
export const sharedCategoryOf = (s: SkillRow): string =>
  parseSharedCategory(s.teamCategory ?? "") || "common";

/** knowledge 条目的分类名（teamCategory 原样、缺省 unknown） */
export const knowledgeCategoryOf = (s: SkillRow): string =>
  s.teamCategory ?? "unknown";

/** 左栏来源过滤（不含分类 chip / 搜索） */
export const skillsForNav = (
  skills: SkillRow[],
  nav: SourceNavKey,
): SkillRow[] => {
  if (nav === "shared") {
    return skills.filter(
      (s) => s.source === "team" && isSharedTeamCategory(s.teamCategory),
    );
  }
  if (nav === "knowledge") {
    return skills.filter(
      (s) => s.source === "team" && !isSharedTeamCategory(s.teamCategory),
    );
  }
  return skills.filter((s) => s.source === nav);
};

export type CategoryChip = { value: string; label: string; count: number };

/**
 * 右侧列表顶部的分类 chip 行（仅共享 / 团队规范有）：
 * 「全部」+ 有内容的分类。共享按 common/fe/be/qa/other 优先排、未知目录殿后字母序；
 * 团队规范按字母序（global/frontend/... 路径推导不写死）。
 */
export const categoryChipsFor = (
  skills: SkillRow[],
  nav: SourceNavKey,
): CategoryChip[] => {
  if (nav !== "shared" && nav !== "knowledge") return [];
  const inNav = skillsForNav(skills, nav);
  const catOf = nav === "shared" ? sharedCategoryOf : knowledgeCategoryOf;
  const counts = new Map<string, number>();
  for (const s of inNav) {
    const cat = catOf(s);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const preferred = ["common", "fe", "be", "qa", "other"];
  const keys = [...counts.keys()].sort((a, b) => {
    if (nav === "shared") {
      const ia = preferred.indexOf(a);
      const ib = preferred.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
    }
    return a.localeCompare(b);
  });
  return [
    { value: "all", label: "全部", count: inNav.length },
    ...keys.map((cat) => ({
      value: cat,
      label: nav === "shared" ? labelTeamSharedCategory(cat) : cat,
      count: counts.get(cat) ?? 0,
    })),
  ];
};

/** 分类 chip 过滤（chip="all" 或非 shared/knowledge 导航 = 不过滤） */
export const applyCategoryChip = (
  skills: SkillRow[],
  nav: SourceNavKey,
  chip: string,
): SkillRow[] => {
  const inNav = skillsForNav(skills, nav);
  if (chip === "all" || (nav !== "shared" && nav !== "knowledge")) return inNav;
  const catOf = nav === "shared" ? sharedCategoryOf : knowledgeCategoryOf;
  return inNav.filter((s) => catOf(s) === chip);
};

/** 搜索结果用来源小标签文案（team 分类与 Action 列表共用 labelTeamCategoryBadge） */
export const sourceTagForSkill = (s: SkillRow): string => {
  if (s.source === "app") return "自管";
  if (s.source === "builtin") return "内置";
  if (s.source === "feishu-cli") return "飞书 CLI";
  // team：缺 category 时与 knowledgeCategoryOf 对齐成「规范 · unknown」（非 Action 的「共享」）
  return labelTeamCategoryBadge(
    s.teamCategory,
    `规范 · ${knowledgeCategoryOf(s)}`,
  );
};

export {
  isSharedTeamCategory,
  labelTeamCategoryBadge,
  labelTeamSharedCategory,
  parseSharedCategory,
};
