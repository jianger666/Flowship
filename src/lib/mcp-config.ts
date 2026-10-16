/**
 * MCP 配置常量（client / server 共用）
 *
 * 合并 Cursor + 自管配置的 mergeMcpSources 已删——运行时只读 fe 自管、
 * Cursor mcp.json 仅作能力页「从 Cursor 导入」源、不再做隐式合并。
 */
/** runtime 不允许用户占用：旧 HTTP 注入名 + SDK 合成 customTools 服务器名 */
export const RESERVED_MCP_NAMES = new Set(["flowshipChat", "custom-user-tools"]);

/** 高级「整体 JSON」解析结果 */
export type BulkMcpJsonResult =
  | { ok: true; servers: Record<string, Record<string, unknown>> }
  | { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 校验「高级：整体 JSON 编辑」的草稿（S13-09）。
 * 原实现每次击键只要 JSON.parse 成功就整包落盘——粘贴到一半的合法片段（比如只剩一个 server、
 * 或 `{"mcpServers":{}}`）会直接清空已配置的 MCP。现在只做校验、由用户点「保存」才落盘。
 * 规则与单条编辑 dialog 对齐：名称非空、不占内置保留名、每个 server 是对象。
 */
export const parseBulkMcpJson = (raw: string): BulkMcpJsonResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    return { ok: false, error: "顶层需要 { \"mcpServers\": { ... } }" };
  }
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
    if (!name.trim()) return { ok: false, error: "server 名称不能为空" };
    if (RESERVED_MCP_NAMES.has(name)) {
      return { ok: false, error: `「${name}」是内置保留名、换一个` };
    }
    if (!isPlainObject(cfg)) {
      return { ok: false, error: `「${name}」的配置必须是对象` };
    }
    servers[name] = cfg;
  }
  return { ok: true, servers };
};
