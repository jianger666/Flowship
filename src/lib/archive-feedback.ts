/**
 * 侧栏归档的「点了就走 + 进行中反馈」编排（从 app-sidebar.tsx 的 handleArchive 抽出来，好直接做行为测试——
 * tsconfig 是 jsx:preserve，组件没法在 vitest 里 import；这里只依赖注入进来的 navigate / toast / 回调）。
 *
 * 时序（每一条都是用户反馈的坑）：
 *  1. 点击这一刻就决定离不离开：正看着这个任务 → 立刻 navigate；`await` 之后绝不再自动跳转
 *     （服务端清隔离工作区要几十秒，用户早切去别处，返回时再 push 会把人硬拽回排期页）。
 *  2. 超过 ARCHIVE_PENDING_TOAST_DELAY_MS 还没回 → 出一条 loading toast；快归档不闪。
 *  3. 成败都用同一个 toast id 就地换成结果；结果 toast 出来之前 loading 的计时器已清，不会盖回结果。
 *  4. 失败时若已经离开了任务页 → 结果 toast 带「回到任务」入口（用户主动点的，不算自动跳转）。
 */
import {
  ARCHIVE_PENDING_TOAST_DELAY_MS,
  archiveLeaveTarget,
  archiveToastId,
  buildArchivePendingToast,
  type UserToast,
} from "@/lib/worktree-report";

export interface ArchiveToastAction {
  label: string;
  onClick: () => void;
}

/** 结果 toast 的选项：description 显式给 undefined，免得 loading 那条的说明被就地合并进结果 */
export interface ArchiveResultToastOptions {
  id: string;
  description: undefined;
  action?: ArchiveToastAction;
}

/** sonner 的 `toast` 结构上满足它；测试里用假的 */
export interface ArchiveToastApi {
  loading(message: string, options: { id: string; description?: string }): unknown;
  success(message: string, options: ArchiveResultToastOptions): unknown;
  warning(message: string, options: ArchiveResultToastOptions): unknown;
  error(message: string, options: ArchiveResultToastOptions): unknown;
}

export interface RunArchiveWithFeedbackInput<T> {
  task: { id: string; title: string; mode?: string };
  /** 点击那一帧正看着的任务 id（render 时的值） */
  activeId: string | undefined;
  /** 归档会清隔离工作区（只用来决定 loading 文案要不要多说一句） */
  willCleanup: boolean;
  /** 真正发请求；resolve 出的结果原样交给 onArchived / resultToast */
  archive: () => Promise<T>;
  /** 归档成功后落本地状态（upsert / 置顶序）；这里抛错与请求失败同样按「归档失败」处理 */
  onArchived: (result: T) => void;
  /** 结果 toast 的文案与档位（warning 走 toast.warning，其余 toast.success） */
  resultToast: (result: T) => UserToast;
  /** 成功 toast 上的「撤销」按钮 */
  undoAction: () => ArchiveToastAction;
  /** 失败后把行状态恢复（放行标记 → 恢复 upsert → 刷新），在失败 toast 之后同步调用 */
  onFailed: () => void;
  /** 无论成败最后都调（放行 archiving 标记等） */
  onSettled: () => void;
  navigate: (to: string) => void;
  toast: ArchiveToastApi;
}

export async function runArchiveWithFeedback<T>(input: RunArchiveWithFeedbackInput<T>): Promise<void> {
  const { task, toast } = input;

  const leaveTarget = archiveLeaveTarget(task, input.activeId);
  if (leaveTarget) input.navigate(leaveTarget);

  const toastId = archiveToastId(task.id);
  const pendingTimer = setTimeout(() => {
    const pending = buildArchivePendingToast(task.title, input.willCleanup);
    toast.loading(pending.message, { id: toastId, description: pending.description });
  }, ARCHIVE_PENDING_TOAST_DELAY_MS);

  try {
    const result = await input.archive();
    clearTimeout(pendingTimer);
    input.onArchived(result);
    const outcome = input.resultToast(result);
    (outcome.kind === "warning" ? toast.warning : toast.success).call(toast, outcome.message, {
      id: toastId,
      description: undefined,
      action: input.undoAction(),
    });
  } catch (err) {
    clearTimeout(pendingTimer);
    toast.error(`归档失败：${(err as Error).message}`, {
      id: toastId,
      description: undefined,
      // 点了就走之后失败：任务还在，给个回去的口子
      action: leaveTarget
        ? { label: "回到任务", onClick: () => input.navigate(`/tasks/${task.id}`) }
        : undefined,
    });
    input.onFailed();
  } finally {
    clearTimeout(pendingTimer);
    input.onSettled();
  }
}
