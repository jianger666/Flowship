"use client";

import { useCallback, useState } from "react";

import {
  EMPTY_LIVE_TOOL_OUTPUTS,
  affectsLiveToolOutputs,
  reduceLiveToolOutputs,
  replaceLiveToolOutputs,
  type LiveToolOutputSnapshotEntry,
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
 * - 返回的回调引用稳定（useCallback + 空依赖），可以放心进 effect 依赖数组；
 * - `applyToolOutputSnapshot`：SSE `tool_output_snapshot`（每次连接 bootstrap 一帧）→ **替换**整份直播缓冲
 *   （切走再切回 / 重连后工具块实时输出不再是空的；不是追加，否则会和重连后的增量重复）；
 * - ⚠ `liveToolOutputs` 每个 delta 都是新对象：只往 EventStream 当 prop 传，
 *   **别**拿它去喂任何要扫全量 events 的 memo（HANDOFF「别进 activeStatus memo」）。
 */
export const useLiveToolOutputs = (): {
  liveToolOutputs: LiveToolOutputs;
  absorbLiveToolOutputEvent: (ev: TaskEvent) => boolean;
  clearLiveToolOutputs: () => void;
  applyToolOutputSnapshot: (
    snapshot: readonly LiveToolOutputSnapshotEntry[],
  ) => void;
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

  const applyToolOutputSnapshot = useCallback(
    (snapshot: readonly LiveToolOutputSnapshotEntry[]) => {
      // 与现值逐项相同（同页重连的常态）→ reducer 返回原引用，React 直接 bail out、不重渲染
      setLiveToolOutputs((prev) => replaceLiveToolOutputs(prev, snapshot));
    },
    [],
  );

  return {
    liveToolOutputs,
    absorbLiveToolOutputEvent,
    clearLiveToolOutputs,
    applyToolOutputSnapshot,
  };
};
