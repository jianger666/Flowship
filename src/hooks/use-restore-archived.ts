"use client";

/**
 * 详情页「恢复归档」动作（请求 + 列表同步 + 提示 + 防重入），task 形态与 chat 形态共用（R14 B6-3 / Q3-03）。
 *
 * 口径同会话页 handleOpen 的恢复分支（sessions/page.tsx）：
 * 先标记「恢复中」（慢轮询拿回的旧快照 archived:true 不得把它盖回去）→ PATCH archived:false →
 * 把服务端返回的任务塞回列表与详情页 → 提示取服务端回报（定时恢复了几个 / 错过几个由 buildRestoreToast 说）。
 *
 * 防重入用 ref：setState 要等下一次渲染才生效，双击的第二下可能抢在按钮 disabled 之前进来。
 * 失败只弹错、放闸，用户可以直接再点一次。
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { useTaskList } from "@/hooks/use-task-list";
import { setTaskArchivedWithReport } from "@/lib/task-store";
import type { Task } from "@/lib/types";
import {
  loadSidebarPinnedOrder,
  saveSidebarPinnedOrder,
} from "@/lib/view-memory";
import { buildRestoreToast } from "@/lib/worktree-report";

export const useRestoreArchived = (
  task: Pick<Task, "id" | "title" | "pinned">,
  /** 服务端回报的最新任务（页面据此把本地 task 换成 archived 已清掉的那份） */
  onRestored: (updated: Task) => void,
) => {
  const { upsertTask, markArchiving, unmarkArchiving } = useTaskList();
  const [restoring, setRestoring] = useState(false);
  const busyRef = useRef(false);

  const restore = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRestoring(true);
    // 恢复方向同样标记：upsert 之后轮询仍可能拿回旧快照（archived:true）把它盖回去
    markArchiving(task.id, false);
    try {
      const { task: updated, report } = await setTaskArchivedWithReport(
        task.id,
        false,
      );
      upsertTask(updated);
      onRestored(updated);
      if (task.pinned) {
        // 归档时置顶序里的 id 被摘掉了：恢复的置顶任务接回末尾，不然掉出手动序（同会话页 restorePinnedOrder）
        const order = loadSidebarPinnedOrder();
        if (!order.includes(task.id)) {
          saveSidebarPinnedOrder([...order, task.id]);
        }
      }
      toast.success(buildRestoreToast(task.title, report));
    } catch (err) {
      toast.error(
        `恢复失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      unmarkArchiving(task.id);
      busyRef.current = false;
      setRestoring(false);
    }
  }, [
    task.id,
    task.title,
    task.pinned,
    onRestored,
    upsertTask,
    markArchiving,
    unmarkArchiving,
  ]);

  return { restore, restoring };
};
