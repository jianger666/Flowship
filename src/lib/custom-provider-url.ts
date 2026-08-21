/**
 * 自定义 provider 的 baseUrl 归一（client / server 共用、无 Node-only 依赖）
 *
 * 用户填的是「API 根地址」，带不带末尾 `/v1` 都应等价。
 * OpenAI SDK 要的 baseURL 含 `/v1`（它只拼 `/chat/completions`）；
 * Anthropic SDK 要的是不含 `/v1` 的根（它自己拼 `/v1/messages`）。
 */

import type { CustomProviderFormat } from "@/lib/types";

/** 根地址：去尾斜杠、剥末尾 `/v1`（不剥 `/v1beta`） */
export const normalizeCustomBaseUrl = (raw: string): string => {
  let u = raw.trim().replace(/\/+$/, "");
  if (/\/v1$/i.test(u)) u = u.slice(0, -3).replace(/\/+$/, "");
  return u;
};

const looksLikeAnthropicPath = (root: string): boolean =>
  /\/anthropic$/i.test(root);

/** OpenAI SDK / pi openai-completions：根 + `/v1` */
export const customOpenAiSdkBaseUrl = (raw: string): string =>
  `${normalizeCustomBaseUrl(raw)}/v1`;

/** Anthropic SDK / pi anthropic-messages：根，不要 `/v1` */
export const customAnthropicSdkBaseUrl = (raw: string): string =>
  normalizeCustomBaseUrl(raw);

/** 按协议交给 pi 的 baseURL */
export const customSdkBaseUrl = (
  raw: string,
  format: CustomProviderFormat,
): string =>
  format === "anthropic"
    ? customAnthropicSdkBaseUrl(raw)
    : customOpenAiSdkBaseUrl(raw);

/**
 * 地址以 `/anthropic` 结尾时跟 Anthropic SDK 走（DeepSeek / Claude Code 同款）。
 * 其它地址不擅自改用户已选的协议。
 */
export const formatFromCustomBaseUrl = (
  raw: string,
  current: CustomProviderFormat,
): CustomProviderFormat => {
  if (looksLikeAnthropicPath(normalizeCustomBaseUrl(raw))) return "anthropic";
  return current;
};

export type ModelListAttempt = {
  url: string;
  headers: Record<string, string>;
};

type HeaderFn = (
  apiKey: string,
  format: CustomProviderFormat,
) => Record<string, string>;

/** 拉模型列表的候选：Anthropic 表面常常没有 GET /v1/models，回退到旁路 OpenAI 列表 */
export const customModelListAttempts = (
  baseUrl: string,
  apiKey: string,
  format: CustomProviderFormat,
  headersOf: HeaderFn,
): ModelListAttempt[] => {
  const root = normalizeCustomBaseUrl(baseUrl);
  const attempts: ModelListAttempt[] = [];
  const push = (url: string, headers: Record<string, string>) => {
    if (
      attempts.some(
        (a) =>
          a.url === url &&
          a.headers.authorization === headers.authorization &&
          a.headers["x-api-key"] === headers["x-api-key"],
      )
    ) {
      return;
    }
    attempts.push({ url, headers });
  };

  if (format === "anthropic") {
    push(`${root}/v1/models`, headersOf(apiKey, "anthropic"));
    if (looksLikeAnthropicPath(root)) {
      const openaiRoot = root.replace(/\/anthropic$/i, "");
      if (openaiRoot) {
        push(`${openaiRoot}/v1/models`, headersOf(apiKey, "openai"));
      }
    }
    push(`${root}/v1/models`, headersOf(apiKey, "openai"));
  } else {
    push(`${root}/v1/models`, headersOf(apiKey, "openai"));
  }
  return attempts;
};
