/**
 * localStorage 配置存取层
 * - 所有 settings 都序列化到一个 key、整体读写、避免局部 setItem 撕裂
 * - SSR 安全：服务器端没 window、所有读操作返回默认值；写操作直接 noop
 * - 数据 schema 看 src/lib/types.ts，未来加字段记得在 getSettings 里
 *   做向后兼容的 fallback
 */

import type { FeAiFlowSettings, ModelSelection, RepoConfig } from "./types";

const KEY = "fe-ai-flow:settings";

// MCP 配置默认值：与 Cursor IDE 的 ~/.cursor/mcp.json 同 schema
// 用 mcpServers 外层 wrapper 是为了让用户能直接从 IDE 配置粘贴过来
// export 出去给 use-settings / mcp-card 等复用、避免多处独立定义漂移
export const DEFAULT_MCP_JSON = `{
  "mcpServers": {}
}`;

export const DEFAULT_SETTINGS: FeAiFlowSettings = {
  apiKey: "",
  defaultModel: { id: "" },
  repos: [],
  mcpServersJson: DEFAULT_MCP_JSON,
};

const isBrowser = (): boolean =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined";

// 兼容老 schema：早期 defaultModel 是纯 string、新版本是 ModelSelection
// 用户已经存了的旧值要 graceful 升级、不要直接覆盖丢失
const migrateDefaultModel = (raw: unknown): ModelSelection => {
  if (typeof raw === "string") return { id: raw };
  if (raw && typeof raw === "object" && "id" in raw && typeof (raw as { id: unknown }).id === "string") {
    return raw as ModelSelection;
  }
  return { id: "" };
};

// 判断 mcpServers 内层是否合法（必须是非数组的 plain object）
// 老数据可能是 { mcpServers: null } / { mcpServers: [] } 这种半残态、要识别出来当损坏处理
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// 兼容老 schema：早期 mcpServersJson 没有 mcpServers wrapper（裸 server map）
// 现在统一加一层、跟 IDE mcp.json 对齐；解析失败 / 已经带 wrapper / 全空都直接返回
const migrateMcpJson = (raw: unknown): string => {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_MCP_JSON;
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) {
      // 已经带 wrapper：进一步校验 wrapper 内是合法 object、否则用默认覆盖
      if ("mcpServers" in parsed) {
        if (isPlainObject(parsed.mcpServers)) return raw;
        return DEFAULT_MCP_JSON;
      }
      // 裸 map 升级成带 wrapper、空对象就用默认
      if (Object.keys(parsed).length === 0) return DEFAULT_MCP_JSON;
      return JSON.stringify({ mcpServers: parsed }, null, 2);
    }
  } catch {
    // 解析失败保留原文、让用户自己看到错误（settings 页会校验提示）
    return raw;
  }
  return DEFAULT_MCP_JSON;
};

export const getSettings = (): FeAiFlowSettings => {
  if (!isBrowser()) return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<FeAiFlowSettings> & {
      defaultModel?: unknown;
      mcpServersJson?: unknown;
    };
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      defaultModel: migrateDefaultModel(parsed.defaultModel),
      mcpServersJson: migrateMcpJson(parsed.mcpServersJson),
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
    };
  } catch (err) {
    // 静默 fallback 会让用户在下次 saveSettings 时把损坏的 JSON 一起覆盖、
    // 排查时根本不知道发生过什么；先 warn 提醒、用户 / devtool 能看到
    console.warn(
      "[local-store] settings JSON 损坏、已 fallback 到默认值",
      err
    );
    return DEFAULT_SETTINGS;
  }
};

/**
 * 写设置到 localStorage
 *
 * @returns true=写入成功；false=被浏览器拒绝（quota 满 / 隐私模式 / 其它 DOMException）
 *          调用方需要据此 toast.error 提示用户、避免「显示已保存但其实没存」
 */
export const saveSettings = (next: FeAiFlowSettings): boolean => {
  if (!isBrowser()) return false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
    return true;
  } catch (err) {
    console.error("[local-store] saveSettings 失败", err);
    return false;
  }
};

export const getApiKey = (): string => getSettings().apiKey;
export const getDefaultModel = (): ModelSelection => getSettings().defaultModel;
export const getRepos = (): RepoConfig[] => getSettings().repos;
export const getMcpServersJson = (): string => getSettings().mcpServersJson;
