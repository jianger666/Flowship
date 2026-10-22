/**
 * chat 会话重建提示（S2a-05）：新会话接续历史时，让用户知道「AI 现在记得多少」。
 *
 * 为什么要有：懒重启（换模型 / MCP / 工作目录）、resume 失败降级、空闲回收后锚点丢失，
 * 都会走「起新会话 + 把最近几轮正文塞进起手 prompt」。AI 只保留了对话文字（不含工具过程、
 * 更早的轮次要自己回读事件日志），同提供方换模型时又没有任何提示——AI「失忆」而用户不知道。
 *
 * N 的口径：与 chat-runner 的 loadChatHistoryInject 同源——同一个 selectChatHistoryTurns、
 * 同样的尾部扫描窗口、同样的 truncated 判定（含 hasMore）。chat-inject 在 runChatSession 的**同步前奏跑完**之后调用
 * （「启动中」占位已挂上、会话已转交 runner；**不是**等会话真正建成才写——建会话是异步的，runChatSession 没被 await）。
 * 所以极少数情况下（占位挂上后建会话失败）用户会先看到「会话已重建」、随后看到失败提示；这条是提示、不是承诺，
 * 第四轮 Q5-08 起注释按现状写（之前写成「已确认起来」不实）。当前这条用户消息已落盘，所以要用 skipEventId / skipUserText
 * 把它排除（runChatSession 也是这么排的）。
 * 「轮」沿用 chat-history-inject 的定义：一条 user_reply 或 assistant_message 算一轮。
 *
 * best-effort：读盘 / 写事件失败只告警返回 false，绝不能影响发消息主流程。
 */
import {
  HISTORY_INJECT_SCAN_EVENTS,
  selectChatHistoryTurns,
} from "@/lib/chat-history-inject";
import { readEventsTail } from "./task-fs-core";
import { writeEventAndPublish } from "./task-stream";

/**
 * 给用户看的一句话。没有历史（新对话首条）→ null：那不叫「重建」。
 * 不出现内部工具名 / 协议词；被截断时才说「更早的细节」，没截断就不谎称有被省略的对话。
 */
export const buildSessionRebuiltText = (
  turnCount: number,
  truncated: boolean,
): string | null => {
  if (!Number.isFinite(turnCount) || turnCount <= 0) return null;
  const n = Math.floor(turnCount);
  return truncated
    ? `会话已重建：AI 保留了最近 ${n} 轮对话文字，更早的细节与工具过程需要回读事件日志。`
    : `会话已重建：AI 保留了全部 ${n} 轮对话文字，工具过程需要回读事件日志。`;
};

/**
 * 读事件尾、算出实际会灌进起手 prompt 的轮数，有历史就写一条 info。
 * @returns true = 已写入；false = 没有历史 / 读写失败（均不抛）
 */
export const announceSessionRebuilt = async (
  taskId: string,
  opts: { skipEventId?: string; skipUserText?: string } = {},
): Promise<boolean> => {
  try {
    const { events, hasMore } = await readEventsTail(
      taskId,
      HISTORY_INJECT_SCAN_EVENTS,
    );
    const selected = selectChatHistoryTurns(events, opts);
    // 扫描窗口之外可能还有更早的对话——与 runChatSession 一样算作 truncated
    const text = buildSessionRebuiltText(
      selected.turns.length,
      selected.truncated || hasMore,
    );
    if (!text) return false;
    const written = await writeEventAndPublish(taskId, { kind: "info", text });
    return written !== null;
  } catch (err) {
    console.warn(`[session-rebuilt] 写会话重建提示失败 task=${taskId}:`, err);
    return false;
  }
};
