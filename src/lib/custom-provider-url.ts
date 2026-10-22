/**
 * 自定义 provider 的 baseUrl 归一（client / server 共用、无 Node-only 依赖）
 *
 * 用户填的是「API 根地址」，带不带末尾 `/v1` 都应等价。
 * OpenAI SDK 要的 baseURL 含 `/v1`（它只拼 `/chat/completions`）；
 * Anthropic SDK 要的是不含 `/v1` 的根（它自己拼 `/v1/messages`）。
 */

import type { CustomProviderFormat } from "@/lib/types";

/**
 * 根地址：去 `?query` / `#hash`、去尾斜杠、剥末尾 `/v1`（不剥 `/v1beta`）。
 * query / hash 必须先去掉：SDK 与 models 探测都是在地址**后面**拼路径，
 * 带着 `?api-version=…` 会拼出 `…?api-version=x/v1/models` 这种畸形请求（第二轮 review F4-05）。
 */
export const normalizeCustomBaseUrl = (raw: string): string => {
  let u = raw.trim().replace(/[?#][\s\S]*$/, "").replace(/\/+$/, "");
  // 粘贴了「具体接口地址」（官方文档 curl 里的完整 URL）：先剥掉接口尾段，再按 API 根处理（第三轮 D1-06）。
  // 否则 `…/v1/chat/completions` 会被 SDK 再拼一遍变成 404
  u = u.replace(ENDPOINT_TAIL_RE, "").replace(/\/+$/, "");
  if (/\/v1$/i.test(u)) u = u.slice(0, -3).replace(/\/+$/, "");
  return u;
};

/** OpenAI / Anthropic 兼容接口的具体路径尾段——用户应填到 API 根，不该带这些 */
const ENDPOINT_TAIL_RE =
  /\/(?:chat\/completions|completions|responses|models|messages|embeddings)$/i;

/**
 * 用户自己写的地址（去 `?#` / 端点尾段 / 尾斜杠之后）是否以 `/v1` 结尾。
 * normalize 会把尾 `/v1` 剥掉，需要记住「用户写过」好补回——否则
 * Cloudflare AI Gateway `…/v1/<acct>/<gw>/workers-ai/v1` 这类「路径更早处另有 /v1」的地址
 * 会被 hasVersionSegment 的全路径判定误认为「已带版本段」而不补回，请求落到 `…/workers-ai/chat/completions` 404（第四轮 Q2-01）。
 */
const userWroteTailV1 = (raw: string): boolean =>
  /\/v1$/i.test(
    raw
      .trim()
      .replace(/[?#][\s\S]*$/, "")
      .replace(/\/+$/, "")
      .replace(ENDPOINT_TAIL_RE, "")
      .replace(/\/+$/, ""),
  );

const looksLikeAnthropicPath = (root: string): boolean =>
  /\/anthropic$/i.test(root);

/**
 * 路径里是否已带版本段（`/v4`、`/v3`、`/v1beta`、`/v2alpha1` …）。
 * 智谱 `/api/paas/v4`、火山 `/api/v3`、Gemini `/v1beta/openai` 的「API 根」本身就带版本，
 * 再强拼 `/v1` 会变成 `…/v4/v1` 而用户没有办法去掉；Cloudflare AI Gateway
 * `/v1/<account>/<gateway>/openai`、Vertex `/v1/projects/…/endpoints/openapi` 的版本号在最前、后面还有多段，
 * 同样不该补（第三轮 R10b-02：之前的「版本段后最多再跟一段」位置规则会把它们补成 `…/openai/v1` → 404）。
 * 只看 pathname（host 里的 `v1.example.com` 不算）；`/v1` 结尾已在 normalizeCustomBaseUrl 里剥掉。
 * 唯一的例外：Cloudflare Workers AI `…/client/v4/accounts/<id>/ai` 里 `/client/v4/` 是 Cloudflare 自己
 * REST API 的版本、不是 OpenAI 兼容根的版本，匹配前先把它抹掉（第二轮 F4-02）。
 */
const hasVersionSegment = (root: string): boolean => {
  let pathname = root;
  try {
    pathname = new URL(root).pathname;
  } catch {
    // 没带协议头的写法：退回整串匹配（要求前导 `/`，host 不会误判）
  }
  const p = pathname.replace(/\/client\/v\d+(?=\/)/i, "/client");
  return /\/v\d+(?:alpha|beta)?\d*(?:\/|$)/i.test(p);
};

/**
 * OpenAI SDK / pi openai-completions：根 + `/v1`。
 * 用户**写了**尾 `/v1` 就保留（哪怕路径更早处还有别的 `/vN`）；没写才看根里是否已带版本段——带了则原样使用，否则补 `/v1`。
 */
export const customOpenAiSdkBaseUrl = (raw: string): string => {
  const root = normalizeCustomBaseUrl(raw);
  return userWroteTailV1(raw) || !hasVersionSegment(root) ? `${root}/v1` : root;
};

/** GET models 的地址：与 customOpenAiSdkBaseUrl 同口径（用户写了尾 /v1 → 保留；否则根里有版本段就不再补） */
const modelsUrl = (root: string, forceV1 = false): string =>
  !forceV1 && hasVersionSegment(root) ? `${root}/models` : `${root}/v1/models`;

/**
 * 接口地址的行内校验（设置页）：空串不报错（交给「未配置」），
 * 其余必须是 http(s) 绝对地址、且不带 userinfo。返回**错误**文案或 null。
 * `?` / `#`、具体接口尾段属于「已自动处理」的提示，走 `customBaseUrlNotice`（不是错误、不挡保存）。
 */
export const validateCustomBaseUrl = (raw: string): string | null => {
  const v = raw.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "地址格式不对，需要以 http:// 或 https:// 开头，例如 https://api.example.com/v1";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    // `localhost:11434/v1` → protocol 是 `localhost:`：没写协议头，不是「不支持的协议」
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(v)) {
      return "地址缺少 http:// 或 https:// 开头，例如 http://localhost:11434/v1";
    }
    return "只支持 http / https 地址";
  }
  if (u.username || u.password) {
    // 含凭据的地址 Node fetch 直接抛错并把整串（含密钥）回显到页面 / 日志（第三轮 D1-05）
    return "不要把用户名 / 密码写进地址，请把密钥填到下面的 API Key";
  }
  return null;
};

/**
 * 接口地址的「已自动处理」提示（非错误）：地址能用，只是说明实际会按什么处理。
 * 与 validateCustomBaseUrl 分开，是为了不用红字 / aria-invalid 说「已处理」（R10b-03）。
 */
export const customBaseUrlNotice = (raw: string): string | null => {
  const v = raw.trim();
  if (!v) return null;
  const noQuery = v.replace(/[?#][\s\S]*$/, "").replace(/\/+$/, "");
  if (ENDPOINT_TAIL_RE.test(noQuery)) {
    return "这是具体接口地址，只需要填到 API 根；已按根地址处理，不用改";
  }
  if (/[?#]/.test(v)) {
    return "地址里 ? 或 # 后面的参数已忽略：请求路径会拼在地址后面，带上会变成畸形地址";
  }
  return null;
};

/** 擦掉字符串里 URL 的 userinfo（`https://user:TOKEN@host` → `https://***@host`）——报错 / 日志通道用 */
export const redactUrlUserinfo = (text: string): string =>
  text
    // userinfo 一直吃到**最后一个** `@`（密码里可能有未编码的 `@`：`user:p@ss-TOK@host`）；
    // 遇 `/` 或空白即止，所以路径里的 `@scope`、前后文字里的邮箱不受影响（第四轮 Q2-06）
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^/\s]*@/gi, "$1***@")
    // 协议相对写法 `//user:TOK@host`（Node 报「Failed to parse URL from //user:TOK@host」时整串回显）
    .replace(/(^|[\s("'])(\/\/)[^/\s]*@/g, "$1$2***@");

/** 地址是否带 userinfo（`https://user:tok@host`）：能被 URL 解析且有用户名 / 密码才算（解析不了的走格式错误） */
export const hasUrlUserinfo = (raw: string): boolean => {
  try {
    const u = new URL(raw.trim());
    return !!(u.username || u.password);
  } catch {
    return false;
  }
};

/** Anthropic SDK / pi anthropic-messages：根，不要 `/v1` */
export const customAnthropicSdkBaseUrl = (raw: string): string =>
  normalizeCustomBaseUrl(raw);

/** 按已解析的请求面交给 pi 的 baseURL：responses / completions 都要 `/v1`（SDK 只拼尾段） */
export const customSdkBaseUrlForFace = (
  raw: string,
  face: "openai-completions" | "openai-responses" | "anthropic-messages",
): string =>
  face === "anthropic-messages"
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

/** 拉模型列表的候选：Anthropic 表面常常没有 GET /v1/models，回退到旁路 OpenAI 列表。
 *  auto（未显式选协议）：先 Bearer、再 x-api-key 各试一次。 */
export const customModelListAttempts = (
  baseUrl: string,
  apiKey: string,
  format: CustomProviderFormat,
  headersOf: HeaderFn,
): ModelListAttempt[] => {
  const root = normalizeCustomBaseUrl(baseUrl);
  const tailV1 = userWroteTailV1(baseUrl);
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

  if (format === "auto") {
    push(modelsUrl(root, tailV1), headersOf(apiKey, "openai"));
    if (looksLikeAnthropicPath(root)) {
      const openaiRoot = root.replace(/\/anthropic$/i, "");
      if (openaiRoot) {
        push(modelsUrl(openaiRoot), headersOf(apiKey, "openai"));
      }
    }
    push(modelsUrl(root, tailV1), headersOf(apiKey, "anthropic"));
  } else if (format === "anthropic") {
    push(modelsUrl(root, tailV1), headersOf(apiKey, "anthropic"));
    if (looksLikeAnthropicPath(root)) {
      const openaiRoot = root.replace(/\/anthropic$/i, "");
      if (openaiRoot) {
        push(modelsUrl(openaiRoot), headersOf(apiKey, "openai"));
      }
    }
    push(modelsUrl(root, tailV1), headersOf(apiKey, "openai"));
  } else {
    push(modelsUrl(root, tailV1), headersOf(apiKey, "openai"));
  }
  return attempts;
};
