"use client";

/**
 * 「疑似卡住」提示（v1.8.x）：agent 活跃运行（runStatus=running）但超过
 * SUSPECT_STUCK_MS 没有任何活跃信号 → 输入框附近给一个只读小提示。
 *
 * 活跃信号 = 持久事件（task.updatedAt，服务端 ~5s 节流）+ assistant 流式 delta
 * + 工具输出直播（chat 模式）。ask_user / 交卷等待时服务端会把 runStatus 归回
 * awaiting_user、不在判定窗口内，不会误伤。
 *
 * 只提示、不做任何中断动作——长命令静默超过阈值时宁可多一个提示（行内文案已说明）。
 * chat / task 两处输入框共用本组件。
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types";

/** 阈值：正常活跃间隙实测最长 ~40s（工具调用），5 分钟余量足够 */
export const SUSPECT_STUCK_MS = 5 * 60 * 1000;
/** 判定轮询间隔（轻量、只在页面开着时跑） */
const STUCK_TICK_MS = 30 * 1000;

interface SuspectStuckHintProps {
  task: Task;
  /** assistant 流式文本（SSE delta、变化即活跃） */
  streamingText?: string;
  /** 工具输出直播（chat 模式：callId → 累积文本、变化即活跃） */
  liveToolOutputs?: Record<string, string>;
  className?: string;
}

export const SuspectStuckHint = ({
  task,
  streamingText,
  liveToolOutputs,
  className,
}: SuspectStuckHintProps) => {
  const lastActivityAtRef = useRef<number>(Date.now());
  const [stuck, setStuck] = useState(false);
  const anchoredRef = useRef(false);

  // 持久事件 / task 快照：updatedAt 每有新事件都会前进。
  // 首帧直接以 updatedAt 为锚——页面打开时任务可能已经静默很久（卡住态要立即亮）
  useEffect(() => {
    if (!anchoredRef.current) {
      lastActivityAtRef.current = task.updatedAt;
      anchoredRef.current = true;
    } else if (task.updatedAt > lastActivityAtRef.current) {
      lastActivityAtRef.current = task.updatedAt;
    }
  }, [task.updatedAt]);

  // assistant 流式 delta：正在吐字 = 活跃
  useEffect(() => {
    if (streamingText) lastActivityAtRef.current = Date.now();
  }, [streamingText]);

  // 工具输出直播：长命令持续吐输出 = 活跃（chat 模式才有）
  useEffect(() => {
    lastActivityAtRef.current = Date.now();
  }, [liveToolOutputs]);

  // 判定：runStatus 变 running 时重启计时；events 高频变化不重启（只读 runStatus / id）
  useEffect(() => {
    const running = task.runStatus === "running";
    const tick = () => {
      setStuck(
        running && Date.now() - lastActivityAtRef.current > SUSPECT_STUCK_MS,
      );
    };
    tick();
    const iv = setInterval(tick, STUCK_TICK_MS);
    return () => clearInterval(iv);
  }, [task.id, task.runStatus]);

  if (!stuck) return null;

  return (
    <div className={cn("flex items-center gap-1.5 text-xs text-warning", className)}>
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="font-medium">疑似卡住</span>
      <span className="text-muted-foreground">已超过5分钟无事件 / 输出，可停止后继续</span>
    </div>
  );
};
