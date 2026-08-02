/**
 * 「搜索此栏」作用域协调：产物栏 vs 事件流
 *
 * Cmd/Ctrl+F 按最近焦点 / 点击 / 路由默认规则路由到对应内联搜索。
 */

export type PaneSearchScope = "artifact" | "event-stream";

export const ARTIFACT_SEARCH_FOCUS_EVENT = "flowship:artifact-search-focus";
export const EVENT_STREAM_SEARCH_FOCUS_EVENT = "flowship:event-stream-search-focus";

let activeScope: PaneSearchScope | null = null;

export const setActivePaneSearchScope = (scope: PaneSearchScope): void => {
  activeScope = scope;
};

export const getActivePaneSearchScope = (): PaneSearchScope | null =>
  activeScope;

/** 测试 / 路由默认：重置作用域记忆 */
export const resetActivePaneSearchScope = (): void => {
  activeScope = null;
};

export const isTaskDetailPath = (pathname: string): boolean =>
  pathname.startsWith("/tasks/");

/**
 * 无明确焦点时的默认规则：
 * - 任务详情页 → 产物栏（中间栏默认交互区）
 * - 其它页 → 无栏内搜索（Mod+F 不拦截）
 */
export const resolvePaneSearchScope = (
  scope: PaneSearchScope | null,
  pathname: string,
): PaneSearchScope | null => {
  if (!isTaskDetailPath(pathname)) return null;
  if (scope === "event-stream" || scope === "artifact") return scope;
  return "artifact";
};

export const dispatchArtifactSearchFocus = (): void => {
  if (typeof window === "undefined") return;
  setActivePaneSearchScope("artifact");
  window.dispatchEvent(new CustomEvent(ARTIFACT_SEARCH_FOCUS_EVENT));
};

export const dispatchEventStreamSearchFocus = (): void => {
  if (typeof window === "undefined") return;
  setActivePaneSearchScope("event-stream");
  window.dispatchEvent(new CustomEvent(EVENT_STREAM_SEARCH_FOCUS_EVENT));
};

export const dispatchPaneSearchFocus = (scope: PaneSearchScope): void => {
  if (scope === "artifact") dispatchArtifactSearchFocus();
  else dispatchEventStreamSearchFocus();
};
