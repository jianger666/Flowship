/**
 * run 终结时闭合未配对的 tool_call（running → interrupted）。
 *
 * 工具事件是双阶段：tool_call(running) + tool_result(success|error) 靠 callId 配对。
 * cancel / ERROR / 自然 finished 时 SDK 不会再推完成帧 → 未闭合行会永远转圈。
 * 本模块由 run 收尾持有者（chat finalize / task consume finally）在 lease 下补写终态。
 */

import { readEventsTail } from "./task-fs-core";
import { writeOwnedEventAndPublish } from "./task-stream";
import type { TaskEvent } from "@/lib/types";

/**
 * 只扫事件流尾部这么多条。
 *
 * 全量扫的后果（升级前的老任务踩过）：几个月前留下的未闭合 tool_call 会在**本次** run
 * 收尾时被补上「已中断」——那几条新事件落在流的最末尾，用户看到的是「刚跑完就冒出
 * 一堆孤儿中断块」。本次 run 的事件必然在尾部窗口内，扫尾部就够。
 *
 * 配对不受窗口影响：tool_result 一定晚于它的 tool_call，call 在窗口内、result 也在。
 */
const FINALIZE_SCAN_TAIL = 1000;

export type OpenToolCall = {
  callId: string;
  name: string;
  actionId?: string;
};

/**
 * 扫描事件流：有 tool_call、尚无同 callId 的 tool_result → 未闭合。
 * 同 callId 多条 tool_call（历史双写）只计一次。
 */
export const collectOpenToolCalls = (
  events: readonly TaskEvent[],
): OpenToolCall[] => {
  const done = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== "tool_result") continue;
    const cid = typeof ev.meta?.callId === "string" ? ev.meta.callId : "";
    if (cid) done.add(cid);
  }

  const seen = new Set<string>();
  const open: OpenToolCall[] = [];
  for (const ev of events) {
    if (ev.kind !== "tool_call") continue;
    const cid = typeof ev.meta?.callId === "string" ? ev.meta.callId : "";
    if (!cid || done.has(cid) || seen.has(cid)) continue;
    seen.add(cid);
    const name =
      typeof ev.meta?.name === "string" && ev.meta.name.trim()
        ? ev.meta.name
        : "tool";
    open.push({
      callId: cid,
      name,
      actionId: ev.actionId,
    });
  }
  return open;
};

/**
 * 为所有未闭合 tool_call 补写 status=interrupted 的 tool_result。
 * 只看事件流**尾部窗口**（见 FINALIZE_SCAN_TAIL）——本次 run 的工具都在里面，
 * 更早的历史遗留不归这轮收尾管。
 * 每次写前复查 lease——失主立即停（并发所有权：只能由收尾持有者执行）。
 *
 * @returns 成功落盘的条数
 */
export const finalizeOpenToolCalls = async (
  taskId: string,
  lease: () => boolean,
): Promise<number> => {
  if (!lease()) return 0;
  const { events } = await readEventsTail(taskId, FINALIZE_SCAN_TAIL);
  if (!lease()) return 0;

  const open = collectOpenToolCalls(events);
  if (open.length === 0) return 0;

  let written = 0;
  for (const tool of open) {
    if (!lease()) break;
    const ev = await writeOwnedEventAndPublish(taskId, lease, {
      kind: "tool_result",
      text: `工具已中断 ${tool.name}`,
      ...(tool.actionId ? { actionId: tool.actionId } : {}),
      meta: {
        callId: tool.callId,
        name: tool.name,
        status: "interrupted",
        output: "",
      },
    });
    if (ev) written += 1;
  }
  if (written > 0) {
    console.log(
      `[finalize-open-tools] task=${taskId} 闭合未完成工具 ${written}/${open.length}`,
    );
  }
  return written;
};
