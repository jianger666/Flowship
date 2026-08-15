/**
 * 当前 agent provider 的凭据解析（client 侧共享 helper）
 *
 * - cursor：apiKey
 * - custom：baseUrl + apiKey + format
 *
 * 模型列表拉取 / run 启动凭据都从这里派生——别在各组件重复读 provider 分支。
 * （server 端对应的解析在 src/lib/server/custom-provider.ts + 各 runner 的 boot 凭据链）
 */

import { getSettings } from "@/lib/local-store";
import type { CustomProviderFormat } from "@/lib/types";

export interface ActiveModelCreds {
  apiKey: string;
  baseUrl?: string;
  format?: CustomProviderFormat;
}

/** 当前 provider 的活跃模型凭据（cursor=apiKey；custom=baseUrl+apiKey+format） */
export const getActiveModelCreds = (): ActiveModelCreds => {
  const s = getSettings();
  if (s.provider === "custom" && s.customProvider?.baseUrl?.trim()) {
    return {
      apiKey: s.customProvider.apiKey ?? "",
      baseUrl: s.customProvider.baseUrl,
      format: s.customProvider.format ?? "openai",
    };
  }
  return { apiKey: s.apiKey ?? "" };
};

/** 当前 provider 凭据是否齐备（cursor 有 key / custom 有 baseUrl）——能否拉模型列表 */
export const hasActiveModelCreds = (): boolean => {
  const c = getActiveModelCreds();
  return !!c.baseUrl?.trim() || !!c.apiKey?.trim();
};
