/**
 * 设置保存「被拒 / 重试放弃」之后，开关 / 单选类草稿要不要回滚（S-5 起；第二十轮评审 R20-10 把范围从「只有 boolean」扩到单选控件；纯函数，不依赖 React）。
 *
 * 背景：use-settings 的 saveFieldValue 是乐观更新——开关一点草稿就先变成新值，写盘失败后 savedSettings 不动。
 * 5xx / 网络错误还会按 2 / 8 / 30 秒自动重试，这段时间草稿停在新值是合理的（马上就会存进去）；
 * 但**服务端 4xx 拒绝**（同一份内容再发也不会成功）或**重试放弃**之后，草稿还停在新值、磁盘却是旧值——
 * 对「限制群里非宿主成员」这类保护类开关，界面显示已开、实际没开，是误导；单选控件（提供方 / 默认模型 / IDE / 链接打开方式 / 角色 / 提交快捷键 / 标签上限…）同理，
 * 而且草稿一直停在被拒的值上，该字段一直算 dirty，离页还被 `beforeunload` 一直拦（评审 R20-10：此前头注释写「没有显示已生效的误导」，对这类控件不成立）。
 *
 * 决定（第二十轮评审 R20-10，按推荐）：两类回滚，都把草稿恢复成最近一次**已保存**的值：
 *  1. boolean 开关（S-5 原有）；
 *  2. **单选 / 步进类**字段（{@link CHOICE_FIELDS}）：UI 是选项按钮 / 下拉 / 有界数字框，一次操作提交一个离散的值，回滚吃不掉「用户正在敲的文字」。
 * **不回滚**的：文本框（apiKey / gitToken / branchTemplate——回滚会吃掉用户刚输入的内容，toast 又叫他「检查输入后再改一次」）、
 * 整块编辑的列表 / 对象 / 集合（repos / customProviders / mcpServers / companyEnv / actionLayout / disabled* 集合——整值回滚可能盖掉并发的别的元素的修改，卡片里还有各自的本地状态）。
 * 这些字段被拒后仍显示被拒的值、仍 dirty——有意保留：内容还在、还会拦离页，用户要自己修正（`tests/settings-draft-rollback.test.ts` 的「分类对账」钉着每个 `saveFieldValue(…)` 调用点的字段都归了类）。
 * 首次失败（5xx / 网络错误，还会自动重试）不回滚——调用方只在上面两个出口调用本函数。
 *
 * 为什么 boolean 用值的类型（typeof boolean）判定、单选用显式字段表：use-settings 的 FIELD_EQ_KIND 在那个文件里，
 * 本文件被它 import，反过来 import 会循环；而 FeAiFlowSettings 里的 boolean 开关在 DEFAULT_SETTINGS 里都有 boolean 默认值、
 * initSettings 也都规整成 boolean，「草稿和已保存值都是 boolean」就等价于「这是个开关字段」。
 * 已保存值不是 boolean（取不到 / 字段缺省）时没有可信的回滚目标，不回滚。
 * 单选字段没有这种类型特征（字符串 / 数字 / 对象都有），所以靠 {@link CHOICE_FIELDS} 显式列出；新增单选字段忘了列 = 退回「被拒后仍显示被拒的值」（旧行为、fail-safe），
 * 分类对账测试会逼着人工归类。
 */

/** toast 里带的那一句：告诉用户界面上的开关已经退回去了，别以为开着 */
export const SWITCH_RESTORED_NOTE = "开关已恢复为保存前的状态";
/** 单选 / 步进类字段回滚后的那一句 */
export const CHOICE_RESTORED_NOTE = "已恢复为保存前的值";

/**
 * 单选 / 步进类字段：被服务端拒绝 / 重试放弃之后回滚成已保存的值（R20-10；评审点名前 7 个，`meegleProject` 是同类的下拉选择、一并处理）。
 * 对应的控件：提供方 / 默认模型（选择器）、IDE / 链接打开方式 / 角色 / 提交快捷键（选项按钮）、标签页上限（5–60 的有界数字框，失焦提交）、飞书项目空间（下拉）。
 */
export const CHOICE_FIELDS: ReadonlySet<string> = new Set([
  "provider",
  "defaultModel",
  "jumpIde",
  "linkOpenMode",
  "userRole",
  "submitShortcut",
  "browserMaxTabs",
  "meegleProject",
]);

/** 缺省是合法状态的单选字段（没选过角色）：已保存值是 undefined 时回滚目标就是 undefined；其余单选字段已保存值取不到 = 没有可信的回滚目标，不回滚 */
const OPTIONAL_CHOICE_FIELDS: ReadonlySet<string> = new Set(["userRole"]);

export type DraftRollback<T> = { rollback: false } | { rollback: true; value: T };

/** 回滚的类别：决定 toast 里补哪一句 */
export type RolledBackKind = "switch" | "choice";

/**
 * 给定字段此刻的草稿值与最近一次已保存的值，返回「回滚后的字段值」或「不回滚」。
 * 只在两者都是 boolean 且不相等时回滚（相等 = 草稿本来就是已保存的值，没东西可回）。
 * 不看字段名：调用方是 saveFieldValue 里按 key 取出的这一个字段。
 */
export const rollbackBooleanDraft = (draft: unknown, saved: unknown): DraftRollback<boolean> => {
  if (typeof draft !== "boolean" || typeof saved !== "boolean") return { rollback: false };
  if (draft === saved) return { rollback: false };
  return { rollback: true, value: saved };
};

/** 单选值的相等：原始值直接比，对象（defaultModel / meegleProject）按 JSON 比（本仓里它们都是同一份来源、键序一致，万一键序不同只会多回滚一次等价值，无害） */
const sameChoice = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * 单选 / 步进类字段的回滚判定（R20-10）：只对 {@link CHOICE_FIELDS} 里的字段；草稿与已保存值不等才回滚；
 * 已保存值是 undefined 时，只有缺省合法的字段（userRole）才回滚成 undefined，其余不回滚（没有可信的目标）。
 */
export const rollbackChoiceDraft = (key: string, draft: unknown, saved: unknown): DraftRollback<unknown> => {
  if (!CHOICE_FIELDS.has(key)) return { rollback: false };
  if (saved === undefined && !OPTIONAL_CHOICE_FIELDS.has(key)) return { rollback: false };
  if (sameChoice(draft, saved)) return { rollback: false };
  return { rollback: true, value: saved };
};

/**
 * 在一份草稿对象上应用回滚：命中返回新对象（只改这一个字段）+ rolledBack=true + kind；不回滚原样返回同一个引用（React setState 据此跳过重渲染）。
 * 用作 `setSettings((prev) => applyDraftRollback(prev, saved, key).settings)`——读的是 setState 当下最新的草稿，
 * 期间用户又改过这个字段（草稿已不是失败的那个值）时也按「此刻的草稿 vs 已保存」判断，不会把别人的修改盖掉。
 */
export const applyDraftRollback = <S extends object>(
  draftSettings: S,
  savedSettings: S,
  key: keyof S,
): { settings: S; rolledBack: boolean; kind: RolledBackKind | null } => {
  const sw = rollbackBooleanDraft(draftSettings[key], savedSettings[key]);
  if (sw.rollback) return { settings: { ...draftSettings, [key]: sw.value }, rolledBack: true, kind: "switch" };
  const ch = rollbackChoiceDraft(String(key), draftSettings[key], savedSettings[key]);
  if (ch.rollback) return { settings: { ...draftSettings, [key]: ch.value }, rolledBack: true, kind: "choice" };
  return { settings: draftSettings, rolledBack: false, kind: null };
};

/**
 * 给 toast 文案补上「已恢复」一句。第二个参数是回滚的类别（`"switch"` / `"choice"`）；
 * 为兼容原来的调用，`true` 按开关处理；`false` / `null` = 没回滚，原样返回。
 */
export const withRestoredNote = (message: string, rolledBack: boolean | RolledBackKind | null): string => {
  if (!rolledBack) return message;
  return `${message}。${rolledBack === "choice" ? CHOICE_RESTORED_NOTE : SWITCH_RESTORED_NOTE}`;
};
