/**
 * 自定义 HTTP provider（baseUrl + apiKey）的公共 helper
 *
 * 只放「跟 agent 库无关」的纯 HTTP 逻辑：鉴权头、模型列表拉取。
 * URL 归一在 `@/lib/custom-provider-url`（client 也能用）。
 * pi 后端（agent 循环）在 custom-agent-backend.ts 里单独接。
 *
 * 协议约定：
 * - openai：`{root}/v1/chat/completions`、`Authorization: Bearer <key>`、`{root}/v1/models`
 * - anthropic：`{root}/v1/messages`、`x-api-key: <key>` + `anthropic-version`
 *   拉模型优先 `{root}/v1/models`；像 DeepSeek `/anthropic` 没有该接口时，
 *   回退旁路 OpenAI `{host}/v1/models`。
 */

import type { CustomProviderFormat, ModelOption } from "@/lib/types";
import { withCatalogEffort } from "@/lib/custom-effort";
import { customModelListAttempts } from "@/lib/custom-provider-url";
import {
  getModelsDevIndex,
  lookupCatalogReasoning,
} from "@/lib/server/models-dev-catalog";

/** 模型列表拉取超时（网关挂死时 route 不能永久挂起） */
const LIST_TIMEOUT_MS = 15_000;

/** 按协议拼鉴权头（模型列表 / chat 调用共用） */
export const customProviderHeaders = (
  apiKey: string,
  format: CustomProviderFormat,
): Record<string, string> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (format === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers["authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
};

const parseModelList = (json: unknown): ModelOption[] => {
  const data = (json as { data?: unknown } | null)?.data;
  const rows = Array.isArray(data) ? data : [];
  const options: ModelOption[] = [];
  for (const m of rows) {
    if (!m || typeof m !== "object") continue;
    const rec = m as { id?: unknown; display_name?: unknown; displayName?: unknown };
    if (typeof rec.id !== "string" || !rec.id.trim()) continue;
    const displayName =
      (typeof rec.display_name === "string" && rec.display_name) ||
      (typeof rec.displayName === "string" && rec.displayName) ||
      rec.id;
    options.push({ id: rec.id, displayName });
  }
  options.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }),
  );
  return options;
};

const fetchOneModelList = async (
  url: string,
  headers: Record<string, string>,
): Promise<ModelOption[]> => {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`拉取模型列表失败：HTTP ${res.status}`);
  }
  return parseModelList(await res.json());
};

/**
 * 拉自定义 provider 的模型列表 → ModelOption[]（displayName 退用 id）。
 * effort 按 models.dev 该条 reasoning_options 补；上游 /v1/models 没有档位元数据。
 * 抛错让上层 route 转成 502。
 */
export const listCustomModels = async (args: {
  baseUrl: string;
  apiKey: string;
  format: CustomProviderFormat;
}): Promise<ModelOption[]> => {
  const attempts = customModelListAttempts(
    args.baseUrl,
    args.apiKey,
    args.format,
    customProviderHeaders,
  );
  const catalogP = getModelsDevIndex();
  let lastErr: Error | null = null;
  for (const attempt of attempts) {
    try {
      const options = await fetchOneModelList(attempt.url, attempt.headers);
      if (options.length > 0) {
        const index = await catalogP;
        return withCatalogEffort(options, (id) =>
          lookupCatalogReasoning(index, id),
        );
      }
      lastErr = new Error("拉取模型列表失败：列表为空");
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error("拉取模型列表失败");
};
