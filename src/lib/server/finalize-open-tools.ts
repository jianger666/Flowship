/**
 * run 终结时闭合未配对的 tool_call（running → interrupted）。
 *
 * 工具事件是双阶段：tool_call(running) + tool_result(success|error) 靠 callId 配对。
 * cancel / ERROR / 自然 finished 时 SDK 不会再推完成帧 → 未闭合行会永远转圈。
 * 本模块由 run 收尾持有者（chat finalize / task consume finally）在 lease 下补写终态。
 */

import { readEventsTail } from "./task-fs-core";
import { stopBackgroundShellTracking } from "./shell-background-tracker";
import { writeOwnedEventAndPublish } from "./task-stream";
import {
  buildShellBackgroundEvent,
  collectRunningBackgroundShells,
} from "@/lib/shell-background";
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
  /**
   * 这条 tool_call 属于哪一轮群答疑旁路 run（`meta.groupRun` = runTag）；属主自己的工具没有。
   * 补写的终态必须带回同一个标——旁路事件整条链靠它被 UI 折进「群问答」tab，
   * 漏了标，call 被藏、result 却露在属主主流里，成了一块孤儿「已中断」。
   */
  groupRun?: string;
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
    // 判定口径与 UI 的 groupRunTagOf 一致（非空字符串才算），server 侧不反向 import src/lib/group-qa
    const rawTag = ev.meta?.groupRun;
    const groupRun = typeof rawTag === "string" ? rawTag.trim() : "";
    open.push({
      callId: cid,
      name,
      actionId: ev.actionId,
      ...(groupRun ? { groupRun } : {}),
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

  // 本轮收尾：不再轮询后台 shell 的终端文件（它们由下面补写 ended 收掉）。
  // **必须在读事件尾巴之前**、并等在途追踪落定：追踪可能正好在写 running 标记，
  // 先读尾巴再停的话，读到的快照里没有这条 running，它晚到落盘后就成了永远没人补 ended 的孤儿。
  await stopBackgroundShellTracking(taskId);
  if (!lease()) return 0;

  const { events } = await readEventsTail(taskId, FINALIZE_SCAN_TAIL);
  if (!lease()) return 0;

  const open = collectOpenToolCalls(events);

  let written = 0;
  for (const tool of open) {
    if (!lease()) break;
    const ev = await writeOwnedEventAndPublish(
      taskId,
      lease,
      {
        kind: "tool_result",
        text: `工具已中断 ${tool.name}`,
        ...(tool.actionId ? { actionId: tool.actionId } : {}),
        meta: {
          callId: tool.callId,
          name: tool.name,
          status: "interrupted",
          output: "",
        },
      },
      // 旁路遗留的 call：走和旁路 run 自己一样的写盘路径（origin = runTag，sink 据此打 meta.groupRun
      // 并让 publish 信封带 origin，群出向不会把它误当属主 run 的事件）；属主自己的工具不传
      tool.groupRun,
    );
    if (ev) written += 1;
  }
  if (written > 0) {
    console.log(
      `[finalize-open-tools] task=${taskId} 闭合未完成工具 ${written}/${open.length}`,
    );
  }

  await closeRunningBackgroundShells(taskId, lease, events);
  return written;
};

/**
 * 群答疑旁路 run 收尾：只收**它自己**（`origin` = runTag）起的后台 shell。
 *
 * 旁路 run 的 lease 只在被取消时才翻（见 restricted-question 的 record.cancelled）、正常结束不翻——
 * 不在这里收尾的话，它的追踪会一直轮询到进程退出（dev server 就是永远），「群问答」里的转圈也永远不停。
 * 与属主 run 的收尾口径一致：停追踪（等在途写入落定）→ 补写 ended(run-ended)（不是杀进程）。
 * 永不 reject：收尾失败不能影响旁路 run 自己的收口。
 */
export const finalizeSideRunBackgroundShells = async (
  taskId: string,
  origin: string,
  lease: () => boolean,
): Promise<void> => {
  try {
    await stopBackgroundShellTracking(taskId, origin);
    if (!lease()) return;
    const { events } = await readEventsTail(taskId, FINALIZE_SCAN_TAIL);
    const mine = collectRunningBackgroundShells(events).filter(
      (shell) => shell.groupRun === origin,
    );
    for (const shell of mine) {
      if (!lease()) return;
      await writeOwnedEventAndPublish(
        taskId,
        lease,
        buildShellBackgroundEvent({
          callId: shell.callId,
          phase: "ended",
          reason: "run-ended",
        }),
        origin,
      );
    }
  } catch (err) {
    console.warn(
      `[finalize-open-tools] 旁路 run 后台 shell 收尾失败 task=${taskId}`,
      err,
    );
  }
};

/**
 * 收尾时仍标着「后台运行中」的 shell：补写 ended(run-ended)。
 *
 * shell 转后台后 tool_call 早已完成，不归上面的「未配对 tool_call」管；但它的 running 标记会让
 * 渲染层继续转圈——不收的话，下一轮对话一开始（会话重新 running）这块旧 shell 又会转起来。
 * 进程可能还活着（比如留了个 dev server），这里收的是「这一轮不再展示转圈」，不是杀进程。
 * 不计入返回值（返回值只数被中断的工具）。同样只看尾部窗口、写前复查 lease。
 */
const closeRunningBackgroundShells = async (
  taskId: string,
  lease: () => boolean,
  events: readonly TaskEvent[],
): Promise<void> => {
  for (const shell of collectRunningBackgroundShells(events)) {
    if (!lease()) return;
    await writeOwnedEventAndPublish(
      taskId,
      lease,
      buildShellBackgroundEvent({
        callId: shell.callId,
        phase: "ended",
        reason: "run-ended",
      }),
      // 与 running 标记同一个身份：旁路 run 的标记要由同一个 origin 收，才会一起被折叠
      shell.groupRun,
    );
  }
};
