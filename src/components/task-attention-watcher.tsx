"use client";

/**
 * 任务注意力守望（v0.9.5、v0.9.10 去掉 Dock 角标只留系统通知）
 *
 * 盯全局任务列表（useTaskList；轮询分三档：有任务在跑 / 飞书桥接 2s、live 定时 30s / 60s 兜底）：
 *  - 某任务 runStatus 转入 awaiting_user（AI 停下来等人）→ 发系统通知
 *    （窗口聚焦且正看着这个任务时静音，见下方 V7-03）；点通知壳聚焦窗口 + 回传 taskId、这里 router.push 跳详情页
 *
 * task 交卷：后置检查只把 action 标 awaiting_ack；收尾旁白还在跑时 runStatus 仍是
 * running。话说完 consume 才切 awaiting_user——通知不会在「点回来还在处理中」时响。
 *
 * 只做「转变沿」检测：mount 时已在等待的任务不补发（陈旧噪声）。
 * V0.13.x 起 error 也通知：网络类失败已有自动重连兜底（重试 5 次）、真落到 error
 * 的都是需要人处理的问题、值得叫人回来（原「断线 error 噪声」的前提不再成立）。
 * 静音只在「窗口聚焦 且 正看着的就是这个任务」时成立（V7-03；旧逻辑是聚焦就整体静音，
 * 后台会话 / 定时唤醒的会话跑完无提示，回到 app 时才拿到的转变沿也被吞）；
 * 一次转变过多时最多发 3 条 + 1 条汇总，并有跨轮次节流（同任务 30s 一次、全局 60s ≤ 4 条，R11-01）；
 * AI 提问等人（hasPendingAsk 转变沿，此时 runStatus 仍是 running）也发「AI 在等你回答」（D6-01）。（见 lib/task-notify-plan）。
 * 不做 app 层开关（用户拍板：开关本质在系统层——系统通知权限；app 内再放一个 Switch 多余）。
 * 非桌面端没有 __notify 通道、shell-notify 封装内静默降级。
 */

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useTaskList } from "@/hooks/use-task-list";
import { ACTION_LABEL } from "@/lib/task-display";
import { onTaskNotifyClick, sendTaskNotification } from "@/lib/shell-notify";
import {
  activeTaskIdFromPathname,
  applyNotifyThrottle,
  createNotifyThrottle,
  planTaskNotifications,
} from "@/lib/task-notify-plan";
import type { RunStatus, TaskSummary } from "@/lib/types";

// 通知正文：按 mode / 最近 action 状态给一句话（文案简洁原则、不超一行）。
// TaskSummary 没有 custom action 的 label 快照、custom 显示兜底「自定义」可接受。
// 历史退役类型（learn 等）查表 miss 时回退原始 type 字符串。
const buildBody = (task: TaskSummary): string => {
  if (task.mode === "chat") return "AI 已回复";
  if (task.lastActionStatus === "awaiting_ack" && task.lastActionType) {
    return `「${ACTION_LABEL[task.lastActionType] ?? task.lastActionType}」已完成、等你确认`;
  }
  return "AI 在等你回复";
};

export const TaskAttentionWatcher = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { tasks, loaded } = useTaskList();
  // 上一轮各任务 runStatus 快照（null = 还没建立基线、首轮只记录不通知）
  const prevStatusRef = useRef<Map<string, RunStatus> | null>(null);
  // 上一轮各任务 hasPendingAsk 快照（D6-01）+ 跨轮次节流状态（R11-01）
  const prevAskRef = useRef<Map<string, boolean>>(new Map());
  const throttleRef = useRef(createNotifyThrottle());
  // 正看着的任务 id：放 ref 里给下面的列表 effect 读，不当依赖——
  // 切页本身不该触发一轮「对比 + 通知」（那一轮只该由列表变化驱动）
  const activeTaskIdRef = useRef<string | null>(null);
  activeTaskIdRef.current = activeTaskIdFromPathname(pathname);

  // 点通知 → 跳对应任务详情页（壳侧已负责聚焦窗口、这里只管路由）
  useEffect(
    () => onTaskNotifyClick((taskId) => router.push(`/tasks/${taskId}`)),
    [router],
  );

  useEffect(() => {
    if (!loaded) return;
    const prev = prevStatusRef.current;
    const prevAsk = prevAskRef.current;
    prevStatusRef.current = new Map(tasks.map((t) => [t.id, t.runStatus]));
    prevAskRef.current = new Map(tasks.map((t) => [t.id, t.hasPendingAsk === true]));
    // 首轮只建基线：已在等待的是陈旧状态、不补发（planTaskNotifications 内 prev 为 null 返回空）
    // 静音只在「窗口聚焦 且 正看着的就是这个任务」时成立（V7-03）：
    // 旧的「聚焦就整体静音」会让后台会话（含定时唤醒的）跑完毫无提示，
    // 也会让回到 app 时 focus→refresh() 才拿到的转变沿被吞。
    // 不做 app 层开关（用户拍板：开关本质在系统层、app 内 Switch 多余）
    const due = planTaskNotifications({
      prev,
      prevAsk,
      tasks,
      hasFocus: document.hasFocus(),
      activeTaskId: activeTaskIdRef.current,
      describeBody: buildBody,
    });
    for (const item of applyNotifyThrottle(due, throttleRef.current, Date.now())) {
      sendTaskNotification(item);
    }
  }, [tasks, loaded]);

  return null;
};
