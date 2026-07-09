/**
 * 协议信号单一常量源（V0.6.27 立、V0.11 瘦身）
 *
 * V0.11 起 agent 与 server 之间的「用户操作」以 `agent.send(新消息)` 送达、消息头部用
 * 方括号信号标注语义。生成点唯一：`chat-pending.ts` buildAgentMessage；prompt 文档里的
 * 字面量由 vitest 一致性测试校验（见 tests/protocol-signals.test.ts）、改信号忘了同步
 * prompt 会在测试期炸掉。
 *
 * 旧 wait 协议信号（TASK_DONE / CANCELLED / STALE / INVALID_TOKEN / KEEPALIVE /
 * SHELL_WAIT_GUIDE 等）已随协议退役删除、见 git 历史。
 */

// 固定文本信号（消息头 + 空行 + body）
export const SIGNALS = {
  USER_REPLY: "[USER_REPLY]",
  // V0.13.x 统一消息（原 [USER_QUESTION] + [ACTION_ACK revise] 合一、用户拍板「别这么多分支」）：
  // 任务页输入条的任何消息——AI 自主二分类（疑问就答 / 要改就改）；带「产出审阅中」
  // 上下文标注时处理完须重新交卷、否则不推进任务链
  USER_MESSAGE: "[USER_MESSAGE]",
  // 附件清单段头（跟在主信号 body 后）
  ATTACHED_IMAGES: "[ATTACHED_IMAGES]",
  ATTACHED_PATHS: "[ATTACHED_PATHS]",
} as const;

// 带参信号的固定前缀（完整形态如 `[NEXT_ACTION action_id=... type=... n=...]`）
export const SIGNAL_PREFIXES = {
  NEXT_ACTION: "[NEXT_ACTION",
} as const;

/**
 * 构造 `[NEXT_ACTION ...]` 头部（参数缺省自动跳过）
 *
 * 两个生成点共用：task-prompts buildNextActionDirective（拼进首启 prompt）、
 * chat-pending buildAgentMessage（send 续接消息）——格式必须一致、agent 用同一套解析。
 */
export const buildNextActionHead = (args: {
  actionId?: string;
  actionType?: string;
  n?: number;
  artifactPath?: string;
}): string =>
  [
    SIGNAL_PREFIXES.NEXT_ACTION,
    args.actionId ? `action_id=${args.actionId}` : null,
    args.actionType ? `type=${args.actionType}` : null,
    typeof args.n === "number" ? `n=${args.n}` : null,
    args.artifactPath ? `artifact_path=${args.artifactPath}` : null,
  ]
    .filter(Boolean)
    .join(" ") + "]";
