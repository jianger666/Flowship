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
  DANGLING_TASK_PROVIDER_MESSAGE,
  bootArgsForTask,
  customProviderNotReadyReason,
  hasModelCredsForProvider,
  isTaskProviderDangling,
  resolveTaskProvider,
} from "@/lib/agent-provider";
import { getSettings, isSettingsLoaded } from "@/lib/local-store";
import { settingsUrl } from "@/lib/settings-link";
import { isCursorProvider, type Task } from "@/lib/types";

export interface RunArgs {
  apiKey: string;
  model: ModelSelection;
}

export const prepareRunArgs = (task: Task): RunArgs | null => {
  const settings = getSettings();
  // 绑定的自定义提供方已被删除：别悄悄改走 Cursor（数据会出域）。配置没加载成功时 customProviders 只是默认空值，不能据此判「已删除」
  if (isSettingsLoaded() && isTaskProviderDangling(task, settings)) {
    toast.error(DANGLING_TASK_PROVIDER_MESSAGE);
    return null;
  }
  const providerId = resolveTaskProvider(task, settings);
  const isCustom = !isCursorProvider(providerId);

  if (!hasModelCredsForProvider(settings, providerId)) {
    // 自定义条目「地址写了但无效」（含 userinfo / 缺协议头）时说真原因，别说「缺少接口地址」（第四轮 Q2-07）
    const reason = isCustom
      ? (customProviderNotReadyReason(settings, providerId) ?? "缺少自定义 Provider 接口地址")
      : "缺少 API Key";
    toast.error(reason, {
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
