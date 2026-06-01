/**
 * GET /api/cursor-mcp
 *
 * 读全局 Cursor MCP 配置（`~/.cursor/mcp.json`）原样返回、给前端只读展示。
 *
 * 背景（2026-06「跟 Cursor 共用工具」）：fe 不再让用户在设置页编辑 MCP、
 * 改为直接展示 Cursor 的配置（单一源、用户在 Cursor 改）。task 级只做「黑名单开关」。
 *
 * 不脱敏（用户拍板）：本地单机工具、用户看自己的配置、token/env 原样展示、跟 Cursor 一致。
 *
 * 返回：
 *   { ok: true, servers: Record<string, McpServerConfig>, dirs: string[] }
 *   - servers：mcp.json 里的 mcpServers 原样（含 type/url/command/env...）
 *   - dirs：读取候选目录（让用户知道配置读自哪个 ~/.cursor/）
 */

import {
  getGlobalCursorDirs,
  readGlobalCursorMcpServers,
} from "@/lib/server/cursor-config";

export const runtime = "nodejs";

export const GET = async () => {
  const servers = await readGlobalCursorMcpServers();
  return new Response(
    JSON.stringify({ ok: true, servers, dirs: getGlobalCursorDirs() }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
