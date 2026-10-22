"use client";

import { useCallback, useState } from "react";

import {
  EMPTY_LIVE_TOOL_OUTPUTS,
  affectsLiveToolOutputs,
  reduceLiveToolOutputs,
  type LiveToolOutputs,
} from "@/lib/live-tool-outputs";
import { isEphemeralToolOutputDelta } from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";

/**
 * 运行中 shell 的直播输出（callId → 尾部 20 行），chat / task 两种页面共用（V4-04）。
 *
 * 用法（SSE onEvent 里最先调）：
 *   if (absorbLiveToolOutputEvent(ev)) return;   // true = ephemeral 直播帧、别再当持久事件处理
 *
 * - 返回的两个回调引用稳定（useCallback + 空依赖），可以放心进 effect 依赖数组；
 * - ⚠ `liveToolOutputs` 每个 delta 都是新对象：只往 EventStream 当 prop 传，
 *   **别**拿它去喂任何要扫全量 events 的 memo（HANDOFF「别进 activeStatus memo」）。
 */
export const useLiveToolOutputs = (): {
  liveToolOutputs: LiveToolOutputs;
  absorbLiveToolOutputEvent: (ev: TaskEvent) => boolean;
  clearLiveToolOutputs: () => void;
} => {
  const [liveToolOutputs, setLiveToolOutputs] = useState<LiveToolOutputs>(
    EMPTY_LIVE_TOOL_OUTPUTS,
  );

  const absorbLiveToolOutputEvent = useCallback((ev: TaskEvent): boolean => {
    // 与直播无关的事件（绝大多数）不白调 setState
    if (!affectsLiveToolOutputs(ev)) return false;
    setLiveToolOutputs((prev) => reduceLiveToolOutputs(prev, ev));
    // 只有 ephemeral 帧归调用方「到此为止」；tool_result 清完缓冲后还要继续走正常落盘流程
    return isEphemeralToolOutputDelta(ev);
  }, []);

  const clearLiveToolOutputs = useCallback(() => {
    setLiveToolOutputs((prev) =>
      Object.keys(prev).length === 0 ? prev : EMPTY_LIVE_TOOL_OUTPUTS,
    );
  }, []);

  return { liveToolOutputs, absorbLiveToolOutputEvent, clearLiveToolOutputs };
};
