import {
  UPLOAD_CATEGORIES,
  type SkillRow,
  type UploadCategory,
} from "./types";

export type UploadDialogMode = "skill" | "action";

/** action 模式行（自建 app-skill；不可传的带 disabledReason） */
export type UploadActionRow = {
  id: string;
  label: string;
  skill: string;
  /** null = 可勾选；非空 = 置灰原因 */
  disabledReason: string | null;
};

export type TeamUploadPermission = {
  category: string;
  canUpdate: boolean;
  author?: string;
  reason?: string;
};

/** 已存在项必须拿到服务端明确授权才可选；新名字不在权限表中、正常允许上传。 */
export const uploadOwnershipDisabledReason = (
  name: string,
  teamSkillCategories: Record<string, string[]>,
  permissions: Record<string, TeamUploadPermission>,
): string | null => {
  if ((teamSkillCategories[name] ?? []).length === 0) return null;
  const permission = permissions[name];
  if (permission?.canUpdate === true) return null;
  return (
    permission?.reason ??
    "无法确认该共享项归属，暂不可覆盖；请检查 GitLab Token 或联系 maintainer"
  );
};

/** 相对目标分类：覆盖 / 跨分类冲突 / 无 */
export const uploadNameStatus = (
  name: string,
  targetCategory: string,
  teamSkillCategories: Record<string, string[]>,
): "none" | "overwrite" | { conflict: string } => {
  const cats = teamSkillCategories[name] ?? [];
  if (cats.length === 0) return "none";
  const other = cats.find((category) => category !== targetCategory);
  if (other) return { conflict: other };
  if (cats.includes(targetCategory)) return "overwrite";
  return "none";
};

/** 选中的 action/skill 统一展开成待上传 skill 名；选中阶段不因默认分类而丢项。 */
export const resolveUploadSkillNames = ({
  mode,
  picked,
  appSkills,
  actions,
}: {
  mode: UploadDialogMode;
  picked: ReadonlySet<string>;
  appSkills: SkillRow[];
  actions: UploadActionRow[];
}): string[] => {
  if (mode === "skill") {
    const available = new Set(appSkills.map((skill) => skill.name));
    return [...picked].filter((name) => available.has(name));
  }
  const names = new Set<string>();
  for (const action of actions) {
    if (
      picked.has(action.id) &&
      !action.disabledReason &&
      action.skill
    ) {
      names.add(action.skill);
    }
  }
  return [...names];
};

/**
 * 已上传项只有一个现存分类时，进入下一步自动切到该分类。
 * 这样「默认前端、旧版本在其它」也能直接更新；多分类混选则交给冲突提示处理。
 */
export const preferredExistingCategory = (
  names: string[],
  teamSkillCategories: Record<string, string[]>,
): UploadCategory | null => {
  const existing = new Set(
    names.flatMap((name) => teamSkillCategories[name] ?? []),
  );
  if (existing.size !== 1) return null;
  const [only] = [...existing];
  return UPLOAD_CATEGORIES.includes(only as UploadCategory)
    ? (only as UploadCategory)
    : null;
};
