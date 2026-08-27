/**
 * Delivery Hub（harness-delivery-hub）可达性探测的纯逻辑
 *
 * 为什么探 `artifact-state` 而不是 `/health`：翻遍团队 harness 镜像
 * （`wk-harness/references/delivery-hub-sync.md` + `scripts/*.py`）**没有健康检查端点**，
 * 内部接口（激活 / 产物 / 事件）都挂 `/internal/harness/*`。探针仍用
 * `artifact-state`：它是「GET + 无副作用」——随便传个不存在的 key，hub 会回
 * `{"data":{"exists":false}}`，既证明网络通、鉴权有效，又证明对面确实是 harness。
 */

/** 探测结论：ok=确认是 hub；unexpected=连上了但不像 hub；unreachable=网络不通 */
export type WkHubProbeStatus = "ok" | "unexpected" | "unreachable" | "invalid-url";

export interface WkHubProbeResult {
  status: WkHubProbeStatus;
  /** 一行中文说明，直接显示在设置页 */
  message: string;
}

/** 官方 baseline 脚本查的探针路径 */
export const HUB_ARTIFACT_STATE_PATH = "/internal/harness/artifact-state";

/** 指令激活草案 / 确认（对齐 wk-activate.py） */
export const HUB_ACTIVATION_DRAFT_PATH = "/internal/harness/activation-draft";
export const HUB_ACTIVATE_PATH = "/internal/harness/activate";
/** 启用中的技术 Owner 候选（label=显示名、value=账号） */
export const HUB_ACTIVATION_OWNERS_PATH = "/internal/harness/activation-owners";

/** Hub 内部接口鉴权头（Bearer 也能过，官方脚本走这个） */
export const HUB_HARNESS_TOKEN_HEADER = "X-Delivery-Harness-Token";

/** 探测用的假 key：hub 查不到会老实回 exists:false，不会写任何东西 */
export const HUB_PROBE_ARTIFACT_KEY = "flowship:probe:connectivity";

/**
 * 规范化 base_url：只收 http(s)、去掉末尾斜杠（官方一律 `base_url.rstrip("/")` 后拼路径）。
 * 格式不合法返 null——探不通时的兜底校验也是它。
 */
export const normalizeHubUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  // 保留可能存在的路径前缀（官方允许 base_url 带前缀）、只去末尾斜杠
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

/** 探针 URL */
export const hubProbeUrl = (baseUrl: string): string =>
  `${baseUrl}${HUB_ARTIFACT_STATE_PATH}?artifactKey=${encodeURIComponent(
    HUB_PROBE_ARTIFACT_KEY,
  )}`;

/**
 * 响应像不像 harness 的 artifact-state。
 * 官方读法：`raw["data"]` 是对象就取它、否则用 raw 本身，再看 `exists` 字段。
 * 所以「顶层有 exists」或「有 data 对象」都算数。
 */
export const isArtifactStateShape = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const obj = body as Record<string, unknown>;
  if ("exists" in obj) return true;
  const data = obj["data"];
  return typeof data === "object" && data !== null && !Array.isArray(data);
};
