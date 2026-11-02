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
 * SSE `tool_output_snapshot` 帧里的一条：某个在跑 shell 服务端已发出的尾部窗口。
 * 每次（重）连接 bootstrap 补发，让切走再切回 / 重连后的工具块实时输出不是空的。
 */
export interface LiveToolOutputSnapshotEntry {
  callId: string;
  /** 服务端已发出的尾部窗口（≤20 行 / ≤8KB，已脱敏） */
  text: string;
}

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

/**
 * 用服务端 `tool_output_snapshot` 整份**替换**直播缓冲（不是 reduceLiveToolOutputs 那种追加）：
 * - 快照 = 服务端「订阅那一刻之前已发出的」各 callId 尾部窗口；快照之后的实时 delta 由服务端排在它后面回放，
 *   所以这里整份换掉、之后接着追加才不重不漏。若复用追加语义，重连时本地已有的尾巴会被再拼一遍；
 * - 本地有、快照没有的 callId（断线期间这个 shell 已经结束 / 服务端已不再追踪）一并清掉——快照是权威；
 * - 入口再封顶一次（窗口口径与服务端同一套）：帧是外部输入，别让一帧超长文本撑爆直播缓冲；
 * - 与现值逐项相同 → 原引用返回（重连时快照与本地一致是常态，让 React 的 setState 直接 bail out）；
 *   结果为空 → 复用稳定的 EMPTY 引用。
 */
export const replaceLiveToolOutputs = (
  prev: LiveToolOutputs,
  snapshot: readonly LiveToolOutputSnapshotEntry[],
): LiveToolOutputs => {
  const next: Record<string, string> = {};
  for (const { callId, text } of snapshot) {
    if (!callId || !text) continue;
    next[callId] = trimLiveOutputLines(sliceLiveOutputTail(text));
  }
  const nextKeys = Object.keys(next);
  const prevKeys = Object.keys(prev);
  if (
    prevKeys.length === nextKeys.length &&
    nextKeys.every((k) => prev[k] === next[k])
  ) {
    return prev;
  }
  return nextKeys.length === 0 ? EMPTY_LIVE_TOOL_OUTPUTS : next;
};
