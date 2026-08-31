"use client";

/**
 * 「疑似卡住」提示：agent 在跑（runStatus=running），但事件流 / 流式输出
 * 已经超过 5 分钟没有任何更新。判定见 `@/lib/suspect-stuck`。
 *
 * 只提示、不中断。交卷后 runStatus 归 awaiting_user，不在判定窗口。
 * 提问后 runStatus 仍是 running（等答案靠 curl）——有未答提问也不亮。
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";
import { findPendingAskEvent } from "@/lib/ask-pending";
import type { Task } from "@/lib/types";
import { isSuspectStuck, latestEventTs } from "@/lib/suspect-stuck";

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
  // 流式 delta / 工具直播没有持久 ts，用收到时刻当活跃锚
  const lastLiveAtRef = useRef(0);
  const [stuck, setStuck] = useState(false);
  const lastEventAt = latestEventTs(task.events);
  // 和悬浮条 / 推进按钮同一判定：有未答提问 = 在等你，不是卡住
  const awaitingAsk = !!findPendingAskEvent(task.events);

  useEffect(() => {
    lastLiveAtRef.current = 0;
  }, [task.id, task.runStatus]);

  useEffect(() => {
    if (streamingText) lastLiveAtRef.current = Date.now();
  }, [streamingText]);

  useEffect(() => {
    if (!liveToolOutputs) return;
    for (const v of Object.values(liveToolOutputs)) {
      if (v) {
        lastLiveAtRef.current = Date.now();
        return;
      }
    }
  }, [liveToolOutputs]);

  useEffect(() => {
    const running = task.runStatus === "running";
    const tick = () => {
      setStuck(
        isSuspectStuck(running, lastEventAt, lastLiveAtRef.current, Date.now(), {
          awaitingAsk,
        }),
      );
    };
    tick();
    if (!running) return;
    const iv = setInterval(tick, STUCK_TICK_MS);
    return () => clearInterval(iv);
  }, [
    task.id,
    task.runStatus,
    lastEventAt,
    awaitingAsk,
    streamingText,
    liveToolOutputs,
  ]);

  if (!stuck) return null;

  return (
    <div className={cn("flex items-center gap-1.5 text-xs text-warning", className)}>
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="font-medium">疑似卡住</span>
      <span className="text-muted-foreground">已超过5分钟无事件 / 输出，可停止后继续</span>
    </div>
  );
};
