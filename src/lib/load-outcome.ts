/**
 * 「加载结果」归类（纯函数、client / server 都能 import）
 *
 * 背景（失败说谎）：任务详情 / 侧栏任务列表的首次拉取一旦失败，原先都被当成「没有数据」画出来——
 *  - 详情接口 503（存在性证据读未知）/ 断网 / 5xx → 页面画「任务不存在或已删除」
 *  - 列表首拉失败 → 侧栏画「还没有任务、去看板挑一个需求启动」
 * 用户会据此误判（以为任务被删了、以为数据没了）且没有任何重试入口。
 *
 * 契约：**只有服务端明确说「没有」才画「不存在」**——
 *  - 404 not_found：确定不存在
 *  - 410 task_deleted：确定已删除（详情路由对「已删」回 410；重试毫无意义，归同一类）
 * 其余（网络错误 TypeError / 5xx / 503 temporarily_unavailable / 400 bad_request / 解析失败）
 * 都是「加载失败」：显示原因 + 重试，不下「不存在」的结论。
 */

export type LoadOutcome =
  | { kind: "ok" }
  | { kind: "notFound" }
  | { kind: "error"; message: string };

/** 服务端确定「没有这个资源」的 HTTP 状态 */
const DEFINITE_GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

/** 兼容 ApiRequestError（带 status）与任意抛值；不 import task-store（保持纯净、可在 node 测） */
const statusOf = (err: unknown): number | undefined => {
  if (err && typeof err === "object") {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
};

export const loadErrorMessage = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.trim() ? raw : "未知错误";
};

/** 把一次失败的拉取归类：确定不存在 → notFound，其余 → error（可重试） */
export const classifyLoadError = (
  err: unknown,
): Exclude<LoadOutcome, { kind: "ok" }> => {
  const status = statusOf(err);
  if (status !== undefined && DEFINITE_GONE_STATUSES.has(status)) {
    return { kind: "notFound" };
  }
  return { kind: "error", message: loadErrorMessage(err) };
};

/**
 * 任务详情拉取结果归类。
 * `fetchTask` 的契约：404 → 返回 null；其余非 2xx 抛 ApiRequestError；断网抛 TypeError。
 */
export const classifyTaskDetailResult = (
  result: { task: unknown | null } | { error: unknown },
): LoadOutcome => {
  if ("error" in result) return classifyLoadError(result.error);
  return result.task ? { kind: "ok" } : { kind: "notFound" };
};

export type ListLoadView = "loading" | "ready" | "error" | "empty";

/**
 * 列表区该画哪一态。
 *  - 已有数据（含旧数据）一律 ready：后台轮询 / 聚焦刷新失败不该拿失败态盖掉能用的列表
 *  - 没数据 + 有失败 → error（而不是 empty）：首拉失败 ≠「还没有任务」
 */
export const deriveListLoadView = (s: {
  loaded: boolean;
  loadError: string | null;
  count: number;
}): ListLoadView => {
  if (!s.loaded) return "loading";
  if (s.count > 0) return "ready";
  return s.loadError ? "error" : "empty";
};
