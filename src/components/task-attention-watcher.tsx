"use client";

/**
 * 任务注意力守望（v0.9.5、v0.9.10 去掉 Dock 角标只留系统通知）
 *
 * 盯全局任务列表（useTaskList、有任务在跑时本就 2s 条件轮询）：
 *  - 某任务 runStatus 转入 awaiting_user（AI 停下来等人）且窗口不在前台
 *    → 发系统通知；点通知壳聚焦窗口 + 回传 taskId、这里 router.push 跳详情页
 *
 * 只做「转变沿」检测：mount 时已在等待的任务不补发（陈旧噪声）。
 * error 不通知（跟侧栏同款决策：断线类 error 常见、通知反而噪声）。
 * 窗口在前台时不发系统通知（用户正看着 app、侧栏琥珀脉冲点已足够）。
 * 非桌面端没有 __notify 通道、shell-notify 封装内静默降级。
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { useTaskList } from "@/hooks/use-task-list";
import { ACTION_LABEL } from "@/lib/task-display";
import { onTaskNotifyClick, sendTaskNotification } from "@/lib/shell-notify";
import type { RunStatus, TaskSummary } from "@/lib/types";

// 通知正文：按 mode / 最近 action 状态给一句话（文案简洁原则、不超一行）。
// TaskSummary 没有 custom action 的 label 快照、custom 显示兜底「自定义」可接受。
const buildBody = (task: TaskSummary): string => {
  if (task.mode === "chat") return "AI 已回复";
  if (task.lastActionStatus === "awaiting_ack" && task.lastActionType) {
    return `「${ACTION_LABEL[task.lastActionType]}」已完成、等你确认`;
  }
  return "AI 在等你回复";
};

export const TaskAttentionWatcher = () => {
  const router = useRouter();
  const { tasks, loaded } = useTaskList();
  // 上一轮各任务 runStatus 快照（null = 还没建立基线、首轮只记录不通知）
  const prevStatusRef = useRef<Map<string, RunStatus> | null>(null);

  // 点通知 → 跳对应任务详情页（壳侧已负责聚焦窗口、这里只管路由）
  useEffect(
    () => onTaskNotifyClick((taskId) => router.push(`/tasks/${taskId}`)),
    [router],
  );

  useEffect(() => {
    if (!loaded) return;
    const prev = prevStatusRef.current;
    prevStatusRef.current = new Map(tasks.map((t) => [t.id, t.runStatus]));
    // 首轮只建基线：已在等待的是陈旧状态、不补发
    if (!prev) return;
    // 窗口在前台：不发系统通知（避免自己看着 app 还被系统横幅打扰）
    if (document.hasFocus()) return;

    for (const task of tasks) {
      const was = prev.get(task.id);
      if (
        task.runStatus === "awaiting_user" &&
        was !== undefined &&
        was !== "awaiting_user"
      ) {
        sendTaskNotification({
          title: task.title,
          body: buildBody(task),
          taskId: task.id,
        });
      }
    }
  }, [tasks, loaded]);

  return null;
};
