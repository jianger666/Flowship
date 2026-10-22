/**
 * 「300 条窗口」的锚点判定（纯函数）。
 *
 * 背景（第三轮 review D8-01 / D8-02 / D8-03）：task 页首屏与 watch-task 的 bootstrap 都只带最近 300 条事件，
 * 而错误卡的恢复入口、状态行的切片起点、↑ 输入历史都要「往前找一条触发这一轮的 user_reply / action_start」。
 * 一轮长 run（>150 对工具调用）之后重开页面，触发源落在窗口外，这些派生态就静默失效。
 *
 * 所以服务端读尾部时把窗口补到「含最近一条锚点事件」（设上限防巨型任务，见 task-fs-core 的 readEventsTail）。
 * 锚点的口径 = 派生态认的「触发源」：属主可见的 user_reply / action_start——
 * 群里陌生人的提问等对主流隐藏的事件走 isHiddenFromEventStream 这一个闸，不算锚点
 *（同 sliceCurrentRunEvents / resolveErrorRecovery / buildInputHistory 的口径）。
 */

import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import type { TaskEvent } from "@/lib/types";

export const isTailAnchorEvent = (ev: TaskEvent): boolean =>
  (ev.kind === "user_reply" || ev.kind === "action_start") &&
  !isHiddenFromEventStream(ev);
