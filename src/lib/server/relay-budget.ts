/**
 * 接力消息硬预算（v3.1 §6：≤8k token，超限二级摘要）。
 *
 * -  token 估算用 chars/4（实现粒度，不调模型）；
 * - `buildRelayMessage` 单点替换位：默认「近 N 轮 + artifact 索引」规则版，
 *    LLM 摘要后置（与 task-runner 现实现同语义，预算超限才触发二级）；
 * - 真相源索引化回读见 events-index.ts（只 seek 命中段）。
 */

import { isRelayOverBudget, RELAY_BUDGET_TOKENS } from "./mem-governance";

export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4);

export interface RelayInput {
  recentTurns: string[];
  artifactIndex: string[];
  taskId: string;
  actionsDir: string;
  eventsPath: string;
  workDir: string;
}

export const buildRelayMessage = (input: RelayInput): { message: string; truncated: boolean } => {
  const header = [
    "（系统：上一轮执行因上下文过长已自动截断续接，这是正常压缩、不是错误，不必向用户说明。）",
    "接着完成当前 Action、做完照常交卷。别重复已完成的工作、细节按需回读：",
    `- 任务事件日志（完整历史）：${input.eventsPath}`,
    `- 已交 artifact 目录（先看已有什么）：${input.actionsDir}`,
    `- 工作目录：${input.workDir}`,
  ].join("\n");

  let turns = [...input.recentTurns];
  let index = [...input.artifactIndex];
  let message = `${header}\n近 ${turns.length} 轮：\n${turns.join("\n")}\nartifact 索引：\n${index.join("\n")}`;
  let truncated = false;
  // 超预算：先砍 artifact 索引，再砍远古轮（二级摘要的规则版，占位 LLM 摘要接口）。
  while (isRelayOverBudget(estimateTokens(message)) && (index.length > 0 || turns.length > 1)) {
    truncated = true;
    if (index.length > 0) {
      index = index.slice(0, Math.max(0, index.length - Math.ceil(index.length / 2)));
    } else {
      turns = turns.slice(turns.length - Math.max(1, Math.floor(turns.length / 2)));
    }
    message = `${header}\n近 ${turns.length} 轮：\n${turns.join("\n")}\nartifact 索引：\n${index.join("\n")}`;
    if (turns.length <= 1 && index.length === 0) break;
  }
  void RELAY_BUDGET_TOKENS;
  return { message, truncated };
};
