/**
 * 相邻 thinking 收成一条。
 *
 * 自定义提供方（pi）的 thinking_delta 是 token 级；中间再插 `\n` 会把一段思考
 * 拆成上万行空白感很强的碎片。块与块自带的换行保留在 text 里，这里只做拼接。
 */

import type { TaskEvent } from "@/lib/types";

export const coalesceAdjacentThinking = (
  events: readonly TaskEvent[],
): TaskEvent[] => {
  const out: TaskEvent[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (
      ev.kind === "thinking" &&
      last &&
      last.kind === "thinking" &&
      last.actionId === ev.actionId
    ) {
      const lastDur = Number(last.meta?.durationMs) || 0;
      const curDur = Number(ev.meta?.durationMs) || 0;
      out[out.length - 1] = {
        ...last,
        text: `${last.text}${ev.text}`,
        meta: {
          ...(last.meta ?? {}),
          durationMs: lastDur + curDur,
        },
      };
    } else {
      out.push(ev);
    }
  }
  return out;
};
