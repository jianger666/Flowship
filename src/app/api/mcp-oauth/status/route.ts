/**
 * GET /api/mcp-oauth/status
 *
 * 列所有已（尝试）授权的 MCP server 状态、给设置页 MCP 卡片展示「已授权 / 未授权 / 过期」。
 * 返回：{ ok, statuses: Record<serverName, McpOAuthStatus> }
 */

import { listMcpOAuthStatuses } from "@/lib/server/mcp-oauth";

export const runtime = "nodejs";

export const GET = async () => {
  const statuses = await listMcpOAuthStatuses();
  return new Response(JSON.stringify({ ok: true, statuses }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
