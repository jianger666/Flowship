/**
 * 下拉里「按输入过滤候选」的匹配规则（仓库选择器等用）。
 *
 * 空格分词、每个词都要出现（AND），不分大小写：`crm web` 能命中 `crm-web`、`/code/crm/web-app`，
 * `student center` 也能命中 `student-center`——只用单个子串的话，用户多敲个空格就什么都搜不到。
 * 词里的连字符 / 下划线不做归一（`crm-web` 就是要子串命中 `crm-web`），保持可预期。
 */
export const matchesSearchQuery = (text: string, query: string): boolean => {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = text.toLowerCase();
  return tokens.every((t) => hay.includes(t));
};

/**
 * 搜索框里按 Enter 该选哪一项：过滤结果里第一个可选的；一项都没有（或被禁用）就退回手填值（allowCustom 时才有）。
 *
 * 多选里 Enter 只负责「选上」：目标已经选中时返回 null、什么都不做。
 * Picker 的 pick 在多选下是 toggle——不拦的话，搜 `crm` 回车选上 crm-web 后手滑再按一下回车就把它取消了，
 * 仓库选择器取消一个仓还会连带清掉它填的分支配置（编辑任务里），一个回车丢数据。
 * 要取消请点那一项（点选项仍是 toggle）。
 */
export const resolveEnterPick = (args: {
  /** 已过滤的候选（保持展示顺序） */
  filtered: ReadonlyArray<{ value: string; disabled?: boolean }>;
  /** allowCustom 时的手填值（没有则 null） */
  customCandidate: string | null;
  multiple: boolean;
  /** 当前已选的 key（单选传 [value] 或 []） */
  selectedKeys: readonly string[];
}): string | null => {
  const { filtered, customCandidate, multiple, selectedKeys } = args;
  const target = filtered.find((o) => !o.disabled)?.value ?? customCandidate;
  if (!target) return null;
  if (multiple && selectedKeys.includes(target)) return null;
  return target;
};
