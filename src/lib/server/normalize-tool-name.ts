/**
 * 工具名归一化（chat / task / run-perf 共用）
 *
 * MCP 工具在 SDK 里 type="mcp" + args.providerIdentifier / toolName，
 * 归一成 `mcp:<server>:<innerTool>`，方便事件流配对与埋点、不泄参数内容。
 */

export type ToolCallNameSource = {
  type?: string;
  name?: string;
  args?: {
    providerIdentifier?: string;
    toolName?: string;
  };
};

/** 内置工具用 type（或 name）；MCP 归一为 mcp:<server>:<innerToolName> */
export const normalizeToolName = (toolCall: ToolCallNameSource): string => {
  const typeOrName = toolCall.type || toolCall.name || "";
  if (typeOrName === "mcp") {
    const server = toolCall.args?.providerIdentifier;
    const inner = toolCall.args?.toolName;
    if (server && inner) return `mcp:${server}:${inner}`;
    if (inner) return `mcp:?:${inner}`;
    if (server) return `mcp:${server}:?`;
    return "mcp";
  }
  return typeOrName || "unknown";
};
