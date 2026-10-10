/**
 * 启动链 ephemeral 进度（不落盘）。
 *
 * 用户回车后到 AI 开口之间的空窗里，前端用它把「我现在在等什么」说清楚——
 * 取代之前只有一个虚线气泡写着「发送中…」：
 *   - mcp     正在检查 MCP…        （新建会话路径）
 *   - create  正在创建会话…        （新建会话路径）
 *   - resume  正在恢复对话…        （续聊路径、内存里没会话：空闲 12 分钟被回收 / 重启后 ~1.5–2.3s）
 *   - send    正在发送… / 首包     （首包 / 恢复完成后真正把消息交给 SDK）
 *
 * 会话还热着（内存里有）的续聊没有任何阶段可说（0.3–0.7s 就受理），不发——
 * 前端对「已发出、还没动静」另有兜底的「准备环境…」行。
 *
 * 契约：
 * - id 前缀 ephemeral_boot_、meta.bootStage=true：前端 lib/chat-stream-display.isBootStageInfo
 *   识别、渐进单行显示（每阶段最少停留 700ms）、agent 真活动（正文 / thinking / 工具 / 错误）出现即整组消失；
 * - user_reply 不会让它消失（boot 期间排队进来的消息不该把进度顶没）；
 * - 只推 SSE、绝不 appendEvent：reload 后天然为空、不污染事件日志；
 * - 尽力而为：推送失败只 debug，**绝不**影响发送主流程。
 */
import { publishTaskStreamEvent } from "./task-stream";

export type BootStage = "mcp" | "resume" | "create" | "send";

/** 续聊（resume）路径的两个阶段文案 */
export const BOOT_TEXT_RESUME = "正在恢复对话…";
export const BOOT_TEXT_SEND = "正在发送…";

export const publishBootProgress = (
  taskId: string,
  stage: BootStage,
  text: string,
): void => {
  try {
    publishTaskStreamEvent(taskId, {
      kind: "event",
      event: {
        id: `ephemeral_boot_${stage}_${Date.now()}`,
        ts: Date.now(),
        kind: "info",
        text,
        // bootStage：前端「渐进单行」判定标（lib/chat-stream-display.isBootStageInfo）
        meta: { stage, bootStage: true },
      },
    });
  } catch (err) {
    console.debug(`[boot-progress] 推送 ${stage} 失败（忽略）task=${taskId}`, err);
  }
};
