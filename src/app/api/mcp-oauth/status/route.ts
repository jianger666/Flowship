/**
 * GET /api/mcp-oauth/status
 *
 * 读 Cursor mcp.json、探测各 http/sse server 是否要 OAuth + 合并落盘授权状态、
 * 给设置页 MCP 卡片决定「显示哪些 server + 已授权 / 未授权」。
 * 只返回「探测出要授权」或「已授权过」的 server（本地 / url 自带 token / 公开 MCP 不返回）。
 * 返回：{ ok, statuses: Record<serverName, McpOAuthStatus> }
 */

import { readMergedMcpServers } from "@/lib/server/cursor-config";
import { evaluateMcpOAuthStatuses } from "@/lib/server/mcp-oauth";

export const runtime = "nodejs";

export const GET = async () => {
  const servers = await readMergedMcpServers();
  const statuses = await evaluateMcpOAuthStatuses(servers);
  return new Response(JSON.stringify({ ok: true, statuses }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
