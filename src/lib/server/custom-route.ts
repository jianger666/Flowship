/**
 * 自定义 provider 的协议路由（自动档）
 *
 * 数据驱动、无厂商分支：models.dev 目录里每个模型的 npm SDK 包名决定它走
 * 哪个协议面（opencode 客户端同款机制）。两级闸门：
 * 1. 用户 baseUrl 必须精确命中目录里某提供方的 `api` 字段；
 * 2. 模型 id 在该提供方的表里查（同 id 精确 → 斜杠尾巴）。
 * 任一级没命中 → 回落 openai-completions（历史行为，零变化）。
 * 用户显式选了 openai / anthropic 时完全跳过目录（override 优先）。
 */

import type { CustomProviderFormat } from "@/lib/types";
import {
  getModelsDevRouteIndex,
  lookupCatalogNpm,
} from "@/lib/server/models-dev-catalog";

/** pi 支持的三种请求面 */
export type CustomFace =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

/** 目录 npm → 请求面。只认两个有特殊含义的包名，其余一律默认 chat/completions */
export const faceFromCatalogNpm = (npm: string | null): CustomFace => {
  if (npm === "@ai-sdk/openai") return "openai-responses";
  if (npm === "@ai-sdk/anthropic") return "anthropic-messages";
  return "openai-completions";
};

/** 显式 override / 自动路由统一收敛成一个请求面 */
export const resolveModelFace = async (
  baseUrl: string,
  modelId: string,
  format: CustomProviderFormat,
): Promise<CustomFace> => {
  if (format === "anthropic") return "anthropic-messages";
  if (format === "openai") return "openai-completions";
  const index = await getModelsDevRouteIndex();
  return faceFromCatalogNpm(lookupCatalogNpm(index, baseUrl, modelId));
};
