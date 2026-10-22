/**
 * `@` 菜单「只认当前 query 的结果」（纯函数、无 React；第二轮 review V5-02）
 *
 * `@` 候选是异步拉的（debounce 120ms + 请求耗时）。query 一变，菜单里还留着上一轮的结果——
 * 这时用户立刻 Enter / Tab，旧写法 `pickAt` 直接取 `filtered[index]`，`@Button` 会被替换成
 * 上一轮第一项 `@Bar.ts`，pill 看着「很像对的」、agent 读错文件。
 *
 * 规则：结果绑定「它是按哪个 query 拉的」；当前 query 与结果所属 query 逐字相等才可选，
 * 不匹配一律拒选（UI 保持菜单、等结果到，不选陈旧项，也不把 Enter 漏给「提交」）。
 */
import { REPO_FILES_Q_MAX_LEN } from "./repo-files-shared";

/** 请求前对 query 的截断（与 `/api/repo-files` 的 q 上限同口径；比较也必须用它） */
export const normalizeAtQuery = (query: string): string =>
  query.slice(0, REPO_FILES_Q_MAX_LEN);

/**
 * 结果是否属于当前 query。
 * @param query 当前正在打的过滤词（null = 没在打 `@`）
 * @param resultQuery 结果所属的（已截断）query（null = 还没有任何结果）
 */
export const isAtResultFresh = (
  query: string | null,
  resultQuery: string | null,
): boolean =>
  query !== null &&
  resultQuery !== null &&
  normalizeAtQuery(query) === resultQuery;

/**
 * 取可选的那一项：结果与当前 query 匹配且下标合法才返回，否则 null（拒选）。
 * 键盘 Enter / Tab 与鼠标点击共用这一道闸。
 */
export const pickableFor = <T>(
  query: string | null,
  resultQuery: string | null,
  items: readonly T[],
  index: number,
): T | null => {
  if (!isAtResultFresh(query, resultQuery)) return null;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    return null;
  }
  return items[index] ?? null;
};

/** 结果已到、确实没有匹配 */
export const AT_EMPTY_HINT = "无匹配文件";
/** 请求失败 / 超时（不是「没有匹配」：用户改个字重试才有机会拿到候选；第四轮 Q6-09） */
export const AT_FAILED_HINT = "候选加载超时，改个字再试";
export const atEmptyHint = (failed: boolean): string =>
  failed ? AT_FAILED_HINT : AT_EMPTY_HINT;

/** 一次候选结果：按哪个 query 拉的 + 候选 + 是否是失败 / 超时落的空结果 */
export interface AtResultsOf<T> {
  query: string;
  files: T[];
  failed: boolean;
}

/**
 * 候选请求出口 → 要存的结果。aborted 返回 null（query 变了 / 卸载，静默不动）；
 * 失败 / 超时按「这个 query 没有候选」收口（菜单落空态、Enter 不再被吞），但带 failed 标记让 UI 写不同文案。
 */
export const atResultsFromOutcome = <T>(
  query: string,
  out: { kind: "ok"; files: T[] } | { kind: "failed" } | { kind: "aborted" },
): AtResultsOf<T> | null => {
  if (out.kind === "aborted") return null;
  return out.kind === "ok"
    ? { query, files: out.files, failed: false }
    : { query, files: [], failed: true };
};

export type AtMenuMode = "closed" | "loading" | "empty" | "list";

export interface AtMenuView<T> {
  /**
   * closed：没在打 `@`；loading：没有可展示的结果、在等；
   * empty：结果已到、这个 query 确实没有匹配；list：有列表可画（可能是上一轮的旧结果）
   */
  mode: AtMenuMode;
  /** 结果不是当前 query 的（候选在路上）：列表降透明 + aria-busy、Enter / Tab 拒选但要拦下 */
  stale: boolean;
  /** 可以选（结果新鲜且有候选） */
  canPick: boolean;
  /** 要画的列表（stale 时是旧结果；loading / closed 时为空） */
  items: readonly T[];
}

/** `@` 菜单状态机：把「query + 结果所属 query」折成 UI 要的几态（hook 与测试共用） */
export const atMenuView = <T>(
  query: string | null,
  results: { query: string; files: readonly T[] } | null,
): AtMenuView<T> => {
  if (query === null) {
    return { mode: "closed", stale: false, canPick: false, items: [] };
  }
  const fresh = isAtResultFresh(query, results?.query ?? null);
  if (fresh && results) {
    const has = results.files.length > 0;
    return {
      mode: has ? "list" : "empty",
      stale: false,
      canPick: has,
      items: results.files,
    };
  }
  // 结果不是这个 query 的（或还没有）：旧结果非空就继续画旧的，空就当「还在加载」——
  // 绝不能把「上一轮无匹配」当成这一轮的结论
  const items = results?.files ?? [];
  return {
    mode: items.length > 0 ? "list" : "loading",
    stale: true,
    canPick: false,
    items,
  };
};
