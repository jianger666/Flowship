/**
 * MCP 配置合并（client / server 共用）
 *
 * Cursor ~/.cursor/mcp.json 与 fe 自管 settings.mcpServers 合并；
 * 同名时 fe 覆盖（ intentional override）。
 */
import type { McpServerConfig } from "@cursor/sdk";

/** runtime 强制注入、不允许用户占用 */
export const RESERVED_MCP_NAMES = new Set(["aiFlowChat"]);

export const mergeMcpSources = (
  cursor: Record<string, McpServerConfig>,
  app: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> => {
  const out = { ...cursor };
  for (const [name, cfg] of Object.entries(app)) {
    if (!RESERVED_MCP_NAMES.has(name)) out[name] = cfg;
  }
  return out;
};
