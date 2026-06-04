/**
 * GET /api/cursor-mcp/health
 *
 * 探测全局 Cursor MCP（`~/.cursor/mcp.json`）各 server 的连通性、给设置页 + 任务面板
 * 展示「正常 / 未授权 / 连不上 / 本地」状态（不再只有开关）。
 *
 * 探测前先 enrich 注入 OAuth token——这样飞书项目这类走 OAuth 的 server、已授权的能探出
 * ok、没授权 / 失效的才标 unauthorized（否则永远 401）。跟起 agent 时的容错探测同一套逻辑。
 *
 * 返回：{ ok: true, health: Record<serverName, McpHealth> }
 */

import { readGlobalCursorMcpServers } from "@/lib/server/cursor-config";
import { enrichMcpServersWithOAuth } from "@/lib/server/mcp-oauth";
import { probeMcpHealthAll } from "@/lib/server/mcp-probe";

export const runtime = "nodejs";

export const GET = async () => {
  const servers = await readGlobalCursorMcpServers();
  const enriched = await enrichMcpServersWithOAuth(servers);
  const health = await probeMcpHealthAll(enriched);
  return new Response(JSON.stringify({ ok: true, health }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
