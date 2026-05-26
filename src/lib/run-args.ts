/**
 * 客户端「准备 SDK run 参数」公共 helper
 *
 * 抽出来的动机：chat-view.handleStart / task page handleStart / handleResumeWaiting
 * 三处都做同一段：
 *   getSettings() → 校验 apiKey → 校验 defaultModel → parseMcpServers → filterMcpServersByTask
 * 校验失败的 toast.error 文案完全一致、出错点没法集中改。
 *
 * 使用：
 * ```
 * const args = prepareRunArgs(task);
 * if (!args) return;          // 校验失败已经 toast 了、直接 return
 * const { apiKey, model, mcpServers } = args;
 * await startWorkflow(task.id, apiKey, model, mcpServers, { mode: "restart" });
 * ```
 *
 * 设计取舍：
 * - 直接在内部调 `toast.error`、调用方少写一截。校验失败这种「立即提示用户」的场景跟
 *   throw 比起来 toast 更顺手（throw 还得 try/catch、再 toast）
 * - 返 null 表示「校验失败 / 不要继续」、调用方早 return；返对象表示「可以发请求」
 * - mcpErrorPrefix 让不同场景能给出「修好再启动」/「修好再续接」之类语境化 toast
 */

import { toast } from "sonner";
import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import { getSettings } from "@/lib/local-store";
import { filterMcpServersByTask, parseMcpServers } from "@/lib/task-store";
import type { Task } from "@/lib/types";

export interface RunArgs {
  apiKey: string;
  model: ModelSelection;
  mcpServers: Record<string, McpServerConfig> | undefined;
}

interface PrepareRunArgsOptions {
  // MCP 解析失败时 toast 的 prefix、默认「修好再启动」、resume 场景传「修好再续接」
  mcpErrorPrefix?: string;
}

export const prepareRunArgs = (
  task: Task,
  options: PrepareRunArgsOptions = {},
): RunArgs | null => {
  const boot = prepareBootArgs(task, options);
  if (!boot) return null;

  // V0.5.1：优先用任务级 model（new-task-dialog 创建时表单挑的）、回退到 settings.defaultModel
  // 老数据没 task.model 字段、走 settings.defaultModel 兜底
  const settings = getSettings();
  const taskModel = task.model;
  const fallbackModel = settings.defaultModel;
  const model: ModelSelection | null =
    taskModel?.id?.trim()
      ? taskModel
      : fallbackModel?.id?.trim()
        ? fallbackModel
        : null;

  if (!model) {
    toast.error("缺少模型、请在任务表单或设置页选好");
    return null;
  }

  return { ...boot, model };
};

/**
 * 准备「只要 apiKey + mcpServers」的启动参数（不校验 model）
 *
 * 用在 fork 路径：用户在 ApprovePhaseDialog 里挑了 model、page.tsx 调时不需要再校验
 * 任务级 / settings 级 model、只要从 settings 读出 apiKey + 解析 mcpServers 即可。
 *
 * 跟 prepareRunArgs 的关系：prepareRunArgs 内部就调它再补 model 校验；
 * 调用方需要 model 时用 prepareRunArgs、不需要 model 时用 prepareBootArgs。
 *
 * 失败时 toast + 返 null（语义跟 prepareRunArgs 一致）。
 */
export const prepareBootArgs = (
  task: Task,
  options: PrepareRunArgsOptions = {},
): Omit<RunArgs, "model"> | null => {
  const { mcpErrorPrefix = "修好再启动" } = options;
  const settings = getSettings();

  if (!settings.apiKey?.trim()) {
    toast.error("缺少 API Key、请先在设置页填好");
    return null;
  }

  let mcpServers: Record<string, McpServerConfig> | undefined;
  try {
    mcpServers = parseMcpServers(settings.mcpServersJson);
  } catch (err) {
    toast.error(`MCP 配置有问题、${mcpErrorPrefix}：${(err as Error).message}`);
    return null;
  }
  // 按任务级黑名单过滤、被 disable 的 MCP 不传给 SDK
  mcpServers = filterMcpServersByTask(mcpServers, task.disabledMcpServers);

  return {
    apiKey: settings.apiKey,
    mcpServers,
  };
};
