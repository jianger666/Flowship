/**
 * MCP 工具名：Cursor SDK 侧展示用 `mcp:<server>:<tool>`（冒号分隔、好读）；
 * 自定义 provider 走 Anthropic / OpenAI 兼容面时，工具名必须匹配
 * `^[a-zA-Z0-9_-]+$`（DeepSeek Anthropic 400：`tools[n].name` 含冒号直接拒）。
 *
 * 送给模型的 API 名用 `mcp__server__tool`；事件流展示再映回冒号形式。
 */

/** OpenAI function name 上限 64；Anthropic 更宽，取严的一边 */
export const API_TOOL_NAME_MAX = 64;

export const isMcpToolName = (name: string): boolean =>
  name.startsWith("mcp:") || name.startsWith("mcp__");

/** 把任意字符串压成 API 合法片段（字母数字 _ -） */
export const toApiSafeToolName = (
  raw: string,
  maxLen = API_TOOL_NAME_MAX,
): string => {
  let s = raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_");
  s = s.replace(/^_+|_+$/g, "");
  if (!s) s = "tool";
  if (s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/_+$/g, "") || "tool";
  }
  return s;
};

/** pi / 自定义端点送给模型的 MCP 工具名 */
export const mcpApiToolName = (serverName: string, toolName: string): string => {
  const prefix = "mcp__";
  const sep = "__";
  // server / tool 各留一段，超长时优先削 tool
  const serverMax = 24;
  const server = toApiSafeToolName(serverName, serverMax);
  const rest = API_TOOL_NAME_MAX - prefix.length - server.length - sep.length;
  const tool = toApiSafeToolName(toolName, Math.max(8, rest));
  let name = `${prefix}${server}${sep}${tool}`;
  if (name.length > API_TOOL_NAME_MAX) {
    name = name.slice(0, API_TOOL_NAME_MAX).replace(/_+$/g, "");
  }
  return name;
};

/** 事件流展示：`mcp__feishu__add_comment` → `mcp:feishu:add_comment` */
export const mcpDisplayName = (apiName: string): string => {
  if (!apiName.startsWith("mcp__")) return apiName;
  const rest = apiName.slice("mcp__".length);
  const i = rest.indexOf("__");
  if (i <= 0) return apiName;
  return `mcp:${rest.slice(0, i)}:${rest.slice(i + 2)}`;
};
