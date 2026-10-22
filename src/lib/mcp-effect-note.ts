/**
 * 任务 MCP 弹窗里「何时生效」的说明（纯函数、可单测；client / server 都能 import）
 *
 * 背景（第二轮 review V11-02）：弹窗里每个开关一点就 PATCH 落盘，但弹窗全文没有任何地方说
 * 「改了什么时候起作用」——运行中改开关的用户会以为正在跑的 AI 立刻换了工具集。
 *
 * 事实（读码确认，别编造）：
 *  - 开关只写 `task.disabledMcpServers`；
 *  - agent 的 MCP 集合在**新起 / 恢复会话**时由 buildMergedMcpForTask 现读（internalStartAgent、resumeTaskSession），
 *    已启动的 agent 不会热更新；task 模式没有 chat 那套「改了就懒重启」；
 *  - 推进时默认每个 action 新起 agent（reuseAgentDefault 缺省 false），勾「续用当前 agent」则沿用旧会话。
 */

import type { RunStatus } from "@/lib/types";

const WHEN_EFFECTIVE =
  "开关立即保存；已启动的 agent 不会热更新，下次推进新起 agent 时才按新开关加载（勾了「续用当前 agent」沿用旧会话时不会换）。";

export const mcpEffectNote = (runStatus: RunStatus): string =>
  runStatus === "running"
    ? `AI 正在运行：这次改动对它不生效。${WHEN_EFFECTIVE}`
    : WHEN_EFFECTIVE;
