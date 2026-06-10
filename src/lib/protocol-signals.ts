/**
 * 协议信号单一常量源（V0.6.27）
 *
 * 背景：agent 与 server 之间的通信协议是「wait-ack stdout 写带方括号头的文本行」、
 * 这些信号字符串原来散落三处手写：
 *   1. `chat-mcp.ts` formatToolReturnAsText（生成）
 *   2. `wait-ack/route.ts`（KEEPALIVE / INVALID_TOKEN / INTERNAL_ERROR 生成）
 *   3. prompt 模板 / 工具 describe（向 agent 解释怎么读）
 * 三处漂移过（如 INTERNAL_ERROR 在 grep 终态列表里、_super.md 却没教）。本文件收口
 * 全部信号、代码生成点一律引用这里；prompt 文档里的字面量由 vitest 一致性测试校验
 * （见 tests/protocol-signals.test.ts）、改信号忘了同步 prompt 会在测试期炸掉。
 */

// 固定文本信号（整行 = 信号本身、或信号头 + 空行 + body）
export const SIGNALS = {
  ACTION_ACK_APPROVE: "[ACTION_ACK approve]",
  ACTION_ACK_REVISE: "[ACTION_ACK revise]",
  USER_REPLY: "[USER_REPLY]",
  TASK_DONE: "[TASK_DONE]",
  TASK_ABANDONED: "[TASK_ABANDONED]",
  CANCELLED: "[CANCELLED]",
  STALE: "[STALE]",
  INVALID_TOKEN: "[INVALID_TOKEN]",
  INTERNAL_ERROR: "[INTERNAL_ERROR]",
  // wait_for_user / ask_user MCP 工具立即返回值的头（引导 agent 跑 shell long-poll）
  SHELL_WAIT_GUIDE: "[SHELL_WAIT_GUIDE]",
  // 附件清单段头（跟在主信号 body 后）
  ATTACHED_IMAGES: "[ATTACHED_IMAGES]",
  ATTACHED_PATHS: "[ATTACHED_PATHS]",
} as const;

// 带参信号的固定前缀（完整形态如 `[NEXT_ACTION action_id=... type=... n=...]`）
export const SIGNAL_PREFIXES = {
  NEXT_ACTION: "[NEXT_ACTION",
  KEEPALIVE: "[KEEPALIVE",
} as const;

// 60s 心跳行（wait-ack 路由写、agent 忽略）
export const keepaliveLine = (): string => `[KEEPALIVE ts=${Date.now()}]\n`;

// wait_for_user / ask_user 工具立即返回值的头（带 token 参数形态）
export const shellWaitGuideHead = (token: string): string =>
  `[SHELL_WAIT_GUIDE token=${token}]`;

/**
 * 构造 `[NEXT_ACTION ...]` 头部（参数缺省自动跳过）
 *
 * 两个生成点共用：task-runner buildNextActionMessage（拼进首启 prompt）、
 * chat-mcp formatToolReturnAsText（wait-ack stdout 推送）——格式必须一致、agent 才能用同一套解析。
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

// shell long-poll 的「终态行」token 列表——curl 输出命中任一 token 即退出重连循环。
// 必须覆盖 formatToolReturnAsText 所有可能的头 + wait-ack 路由直写的错误头、
// 少一个 = agent 拿到结果却继续空转重连。
export const TERMINAL_SIGNAL_TOKENS = [
  "NEXT_ACTION",
  "ACTION_ACK",
  "USER_REPLY",
  "CANCELLED",
  "STALE",
  "INVALID_TOKEN",
  "TASK_DONE",
  "TASK_ABANDONED",
  "INTERNAL_ERROR",
] as const;

// 给 shell guidance 内嵌的 grep -qE 模式（单引号包裹使用、注意 shell 转义已含 \\[）
export const terminalSignalGrepPattern = (): string =>
  `\\[(${TERMINAL_SIGNAL_TOKENS.join("|")})`;
