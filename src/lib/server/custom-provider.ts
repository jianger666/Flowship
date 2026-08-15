/**
 * 自定义 HTTP provider（baseUrl + apiKey）的公共 helper
 *
 * 只放「跟 agent 库无关」的纯 HTTP 逻辑：baseUrl 归一、鉴权头、模型列表拉取。
 * pi 后端（agent 循环）在 custom-agent-backend.ts 里单独接，避免这里过早依赖 pi。
 *
 * 协议约定（用户拍板两套都接）：
 * - openai：`{root}/v1/chat/completions`、`Authorization: Bearer <key>`、`{root}/v1/models`
 * - anthropic：`{root}/v1/messages`、`x-api-key: <key>` + `anthropic-version`、`{root}/v1/models`
 */

import type { CustomProviderFormat, ModelOption } from "@/lib/types";

/** 模型列表拉取超时（网关挂死时 route 不能永久挂起） */
const LIST_TIMEOUT_MS = 15_000;

/**
 * baseUrl 归一成「根地址」：去尾部 `/`、剥掉末尾 `/v1`（用户可能填了 `/v1` 尾巴）。
 * 归一后拼 `/v1/models` / `/v1/chat/completions` 等，避免出现 `/v1/v1/...` 或 `/v1//...`。
 */
export const normalizeCustomBaseUrl = (raw: string): string => {
  let u = raw.trim().replace(/\/+$/, "");
  if (/\/v1$/i.test(u)) u = u.slice(0, -3);
  return u;
};

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

/** 自定义 provider 的模型列表 URL（openai / anthropic 都是 `{root}/v1/models`） */
export const customModelsUrl = (baseUrl: string): string =>
  `${normalizeCustomBaseUrl(baseUrl)}/v1/models`;

/**
 * 拉自定义 provider 的模型列表 → ModelOption[]（无 parameters / variants 元数据，
 * displayName 退用 id；供 ModelSelect 展示，参数/变体选择在自定义 provider 下不可用）。
 * 抛错让上层 route 转成 502。
 */
export const listCustomModels = async (args: {
  baseUrl: string;
  apiKey: string;
  format: CustomProviderFormat;
}): Promise<ModelOption[]> => {
  const url = customModelsUrl(args.baseUrl);
  const res = await fetch(url, {
    headers: customProviderHeaders(args.apiKey, args.format),
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`拉取模型列表失败：HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: unknown; display_name?: unknown; displayName?: unknown }>;
  };
  const data = Array.isArray(json?.data) ? json.data : [];
  const options: ModelOption[] = [];
  for (const m of data) {
    if (!m || typeof m.id !== "string" || !m.id.trim()) continue;
    const displayName =
      (typeof m.display_name === "string" && m.display_name) ||
      (typeof m.displayName === "string" && m.displayName) ||
      m.id;
    options.push({ id: m.id, displayName });
  }
  options.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }),
  );
  return options;
};
