/**
 * shell 直播输出（ephemeral `tool_output_delta`）的收集逻辑——纯函数，chat / task 两处共用。
 *
 * 服务端（shell-output-bridge）把运行中 shell 的 stdout / stderr 按「≥500ms 或 ≥2KB」节流后
 * 以 ephemeral 帧推过来：只走 SSE、不落 events.jsonl、不进 task.events。前端按 callId
 * 累积一个「尾部 20 行」的窗口，喂给运行中的工具块（折叠行尾行 / 展开区直播）。
 *
 * 状态本身放在 React 里（见 `hooks/use-live-tool-outputs.ts`）；这里只管「一个事件怎么改缓冲」，
 * 好在 node 环境直接测。
 */

import { sliceLiveOutputTail } from "@/lib/live-output-cap";
import {
  isEphemeralToolOutputDelta,
  parseToolOutputDelta,
  trimLiveOutputLines,
} from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";

/** callId → 尾部窗口文本（≤ 20 行且 ≤ 8192 字符，`\r` 也算换行；口径见 lib/live-output-cap） */
export type LiveToolOutputs = Record<string, string>;

/** 「没有任何直播」的稳定引用（清空时复用，别每次造新 `{}` 白触发重渲染） */
export const EMPTY_LIVE_TOOL_OUTPUTS: LiveToolOutputs = Object.freeze({});

/**
 * 这个事件会不会动直播缓冲：ephemeral delta（累积）与 tool_result（该 callId 的最终输出已在 meta，清缓冲）。
 * 其它事件（assistant_message / tool_call …）与直播无关，调用方据此跳过 setState。
 */
export const affectsLiveToolOutputs = (ev: TaskEvent): boolean =>
  isEphemeralToolOutputDelta(ev) || ev.kind === "tool_result";

/**
 * 一个事件对直播缓冲的影响：
 * - ephemeral delta：把 chunk 接到该 callId 的窗口尾部、只留最后 20 行 / 8192 字符（无换行长流也有界）
 * - tool_result：删掉该 callId 的缓冲（最终 output 在事件 meta 里）
 * - 其它 / 残缺帧：原引用返回（让 React 的 setState 直接 bail out）
 */
export const reduceLiveToolOutputs = (
  prev: LiveToolOutputs,
  ev: TaskEvent,
): LiveToolOutputs => {
  const delta = parseToolOutputDelta(ev);
  if (delta) {
    return {
      ...prev,
      // 先把单帧本身封顶再拼：一次吐几 MB 时不白分配整串（窗口最终也只留尾部）
      [delta.callId]: trimLiveOutputLines(
        `${prev[delta.callId] ?? ""}${sliceLiveOutputTail(delta.chunk)}`,
      ),
    };
  }
  if (ev.kind === "tool_result") {
    const cid = typeof ev.meta?.callId === "string" ? ev.meta.callId : "";
    if (cid && cid in prev) {
      const next = { ...prev };
      delete next[cid];
      return next;
    }
  }
  return prev;
};
