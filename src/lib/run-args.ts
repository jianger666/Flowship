/**
 * 客户端「准备 SDK run 参数」公共 helper
 *
 * 抽出来的动机：chat-view.handleUserReply / task page handleStart 都做同一段：
 *   getSettings() → 校验凭据 → 算 model（task.model || 本窗口 provider 的默认模型）
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

import {
  bootArgsForTask,
  hasModelCredsForProvider,
  resolveTaskProvider,
} from "@/lib/agent-provider";
import { getSettings } from "@/lib/local-store";
import { settingsUrl } from "@/lib/settings-link";
import { isCursorProvider, type Task } from "@/lib/types";

export interface RunArgs {
  apiKey: string;
  model: ModelSelection;
}

export const prepareRunArgs = (task: Task): RunArgs | null => {
  const settings = getSettings();
  const providerId = resolveTaskProvider(task, settings);
  const isCustom = !isCursorProvider(providerId);

  if (!hasModelCredsForProvider(settings, providerId)) {
    toast.error(isCustom ? "缺少自定义 Provider 接口地址" : "缺少 API Key", {
      action: {
        label: "去设置",
        onClick: () => {
          window.location.href = settingsUrl("model");
        },
      },
    });
    return null;
  }

  const { apiKey, model } = bootArgsForTask(task, settings);

  if (!model.id?.trim()) {
    // 对话 / 推进弹窗里已经有模型选择器，缺的是「这一窗选了没」，不是设置页默认
    toast.error("请选择模型", { id: "run-args-pick-model" });
    return null;
  }

  return { apiKey, model };
};
