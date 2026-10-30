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

/**
 * server / tool 名里的 `:` 与 `%` 转义成 `%3A` / `%25`（R14 Q11b-07）：server 名是用户在能力页起的、
 * 可以带 `:`，不转义时 server `a:b` + tool `c` 与 server `a` + tool `b:c` 都是 `mcp:a:b:c`，
 * 事件流配对 / 埋点聚合 / 按名过滤会把两个不同的工具当成同一个。`%` 也要转，映射才是单射。
 * 只转这两个字符、其余原样（CJK / 空格等不会变成一串 `%E5…`）；不含 `:` 与 `%` 的名字输出不变。
 */
export const escapeToolNamePart = (part: string): string =>
  part.replace(/%/g, "%25").replace(/:/g, "%3A");

/** 内置工具用 type（或 name）；MCP 归一为 mcp:<server>:<innerToolName>（名字里的 `:` / `%` 已转义） */
export const normalizeToolName = (toolCall: ToolCallNameSource): string => {
  const typeOrName = toolCall.type || toolCall.name || "";
  if (typeOrName === "mcp") {
    const server = toolCall.args?.providerIdentifier;
    const inner = toolCall.args?.toolName;
    if (server && inner) {
      return `mcp:${escapeToolNamePart(server)}:${escapeToolNamePart(inner)}`;
    }
    if (inner) return `mcp:?:${escapeToolNamePart(inner)}`;
    if (server) return `mcp:${escapeToolNamePart(server)}:?`;
    return "mcp";
  }
  return typeOrName || "unknown";
};
