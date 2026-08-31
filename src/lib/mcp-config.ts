/**
 * MCP 配置常量（client / server 共用）
 *
 * 合并 Cursor + 自管配置的 mergeMcpSources 已删——运行时只读 fe 自管、
 * Cursor mcp.json 仅作能力页「从 Cursor 导入」源、不再做隐式合并。
 */
/** runtime 不允许用户占用：旧 HTTP 注入名 + SDK 合成 customTools 服务器名 */
export const RESERVED_MCP_NAMES = new Set(["flowshipChat", "custom-user-tools"]);
