/**
 * 工作台看板点一条排期：去哪、要不要先把已归档的任务恢复。
 *
 * 用户实测的坑：需求建过任务、之后又把任务归档了——工作台那条排期仍挂着这个任务，
 * 点进去能聊，但侧栏里没有它（归档任务侧栏默认不显示、而它还是归档态）。
 *
 * 口径同会话页 handleOpen（sessions/page.tsx）：打开归档的任务 = 先恢复再进入。
 * 恢复失败就留在看板、弹错（用户可以再点一次），不带着归档态硬进。
 *
 * 纯逻辑（plan）与带副作用的流程（openBoardItem，依赖全部注入）分开：
 * 本仓 vitest 是 node 环境、没有 DOM，组件里的点击回调测不到，所以把能测的都放在这里。
 */

import type { Task, TaskSummary } from "@/lib/types";
import { shouldTrustCachedTaskLink } from "@/lib/workitem-link";
import { buildRestoreToast, type ArchiveReport } from "@/lib/worktree-report";

/** 看板条目里本文件关心的字段（BoardItem 结构上兼容，避免 lib 反向依赖组件） */
export interface BoardOpenItem {
  id: string;
  name?: string;
  projectKey?: string;
  url?: string;
  /** 服务端 join 的任务（也可能是 localStorage 缓存里的陈旧映射） */
  task: { id: string } | null | undefined;
}

type LiveTask = Pick<TaskSummary, "id" | "title" | "pinned" | "archived">;

export type BoardOpenPlan =
  | { kind: "preview" }
  | { kind: "enter"; taskId: string }
  | { kind: "restore"; task: LiveTask };

/**
 * 点条目去哪：
 * - 没挂任务 → 工作项预览页（启动才建任务）；
 * - 任务在实时列表里：未归档 → 直进；已归档 → 先恢复再进；
 * - 任务不在实时列表里：列表还没就绪 / 首拉失败（拿不到实时校验）→ 信缓存映射直进，
 *   否则当它已被删 → 预览页（盲跳会 404）。
 */
export const planBoardOpen = (s: {
  task: BoardOpenItem["task"];
  /** 侧栏实时任务列表（含已归档的行） */
  liveTasks: ReadonlyArray<LiveTask>;
  loaded: boolean;
  loadError?: string | null;
}): BoardOpenPlan => {
  const cached = s.task;
  if (!cached) return { kind: "preview" };
  const live = s.liveTasks.find((t) => t.id === cached.id);
  if (live) {
    return live.archived === true
      ? { kind: "restore", task: live }
      : { kind: "enter", taskId: live.id };
  }
  return shouldTrustCachedTaskLink({
    loaded: s.loaded,
    loadError: s.loadError ?? null,
    taskCount: s.liveTasks.length,
  })
    ? { kind: "enter", taskId: cached.id }
    : { kind: "preview" };
};

export interface OpenBoardItemDeps {
  push: (url: string) => void;
  /** PATCH archived（task-store 的 setTaskArchivedWithReport） */
  setArchived: (
    id: string,
    archived: boolean,
  ) => Promise<{ task: Task; report?: ArchiveReport }>;
  /** 归档中标记（useTaskList）：恢复窗口内服务端旧快照（archived:true）不得把刚恢复的行盖回去 */
  markArchiving: (id: string, expectArchived: boolean) => void;
  unmarkArchiving: (id: string) => void;
  upsertTask: (task: Task | TaskSummary) => void;
  /** 置顶任务归档时、置顶序里的 id 被摘掉了：恢复后接回末尾（同会话页 restorePinnedOrder） */
  restorePinnedOrder: (id: string) => void;
  notifySuccess: (message: string) => void;
  notifyError: (message: string) => void;
  /** 恢复请求在途的任务 id（调用方跨点击持有）：连点同一条不重复发请求、不重复弹提示 */
  restoring: Set<string>;
}

/** true = 已恢复、可以进入；false = 恢复失败（已弹错，留在看板） */
const restoreBeforeOpen = async (
  task: LiveTask,
  deps: OpenBoardItemDeps,
): Promise<boolean> => {
  // 恢复方向同样标记：upsert 之后轮询仍可能拿回旧快照（archived:true）把它盖回去
  deps.markArchiving(task.id, false);
  try {
    const { task: updated, report } = await deps.setArchived(task.id, false);
    deps.upsertTask(updated);
    if (task.pinned) deps.restorePinnedOrder(task.id);
    deps.notifySuccess(buildRestoreToast(task.title, report));
    return true;
  } catch (err) {
    deps.notifyError(
      `恢复失败：${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    deps.unmarkArchiving(task.id);
  }
};

/** 看板点条目的完整流程：按 planBoardOpen 的结论跳转；已归档的先恢复、成功才进入 */
export const openBoardItem = async (
  it: BoardOpenItem,
  view: {
    tasks: ReadonlyArray<LiveTask>;
    loaded: boolean;
    loadError?: string | null;
  },
  deps: OpenBoardItemDeps,
): Promise<void> => {
  const plan = planBoardOpen({
    task: it.task,
    liveTasks: view.tasks,
    loaded: view.loaded,
    loadError: view.loadError,
  });
  if (plan.kind === "enter") {
    deps.push(`/tasks/${plan.taskId}`);
    return;
  }
  if (plan.kind === "preview") {
    const qs = new URLSearchParams();
    if (it.projectKey) qs.set("project", it.projectKey);
    if (it.name) qs.set("name", it.name);
    if (it.url) qs.set("url", it.url);
    deps.push(`/workitems/${encodeURIComponent(it.id)}?${qs.toString()}`);
    return;
  }
  const { id } = plan.task;
  if (deps.restoring.has(id)) return;
  deps.restoring.add(id);
  try {
    if (await restoreBeforeOpen(plan.task, deps)) deps.push(`/tasks/${id}`);
  } finally {
    deps.restoring.delete(id);
  }
};
