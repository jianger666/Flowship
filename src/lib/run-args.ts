/**
 * 客户端「准备 SDK run 参数」公共 helper
 *
 * 抽出来的动机：chat-view.handleUserReply / task page handleStart 都做同一段：
 *   getSettings() → 校验 apiKey → 算 model（task.model || settings.defaultModel）
 * 校验失败的 toast.error 文案完全一致、出错点没法集中改。
 *
 * 使用：
 * ```
 * const args = prepareRunArgs(task);
 * if (!args) return;          // 校验失败已经 toast 了、直接 return
 * const { apiKey, model } = args;
 * ```
 *
 * 设计取舍：
 * - 直接在内部调 `toast.error`、调用方少写一截。返 null 表示「校验失败 / 不要继续」、
 *   调用方早 return；返对象表示「可以发请求」。
 *
 * V0.6.2 起 MCP 不再走这里：MCP 由 server 端读全局 `~/.cursor/mcp.json` + 按
 * task.disabledMcpServers 过滤（详见 cursor-config.ts）、client 不再解析 / 传 mcpServers。
 */

import { toast } from "sonner";
import type { ModelSelection } from "@cursor/sdk";

import { getSettings } from "@/lib/local-store";
import type { Task } from "@/lib/types";

export interface RunArgs {
  apiKey: string;
  model: ModelSelection;
}

export const prepareRunArgs = (task: Task): RunArgs | null => {
  const settings = getSettings();

  if (!settings.apiKey?.trim()) {
    toast.error("缺少 API Key、请先在设置页填好");
    return null;
  }

  // V0.5.1：优先用任务级 model（new-task-dialog 创建时表单挑的）、回退到 settings.defaultModel
  // 老数据没 task.model 字段、走 settings.defaultModel 兜底
  const taskModel = task.model;
  const fallbackModel = settings.defaultModel;
  const model: ModelSelection | null = taskModel?.id?.trim()
    ? taskModel
    : fallbackModel?.id?.trim()
      ? fallbackModel
      : null;

  if (!model) {
    toast.error("缺少模型、请在任务表单或设置页选好");
    return null;
  }

  return { apiKey: settings.apiKey, model };
};
