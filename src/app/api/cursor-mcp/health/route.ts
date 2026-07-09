/**
 * GET /api/cursor-mcp/health[?servers=a,b,c]
 *
 * 探测自管 MCP（config.json → settings.mcpServers、V0.13 独立化）各 server 的连通性、给设置页 + 任务面板
 * 展示「正常 / 失败」状态（V0.6.13 起两态、失败原因落 detail、前端可点开看日志）。
 *
 * `?servers=` 只探指定子集（逗号分隔的 server 名）——前端只探「已开启」的、或用户
 * 打开某个 MCP 时单独探这一个（对齐 Cursor：关闭的不连、不浪费那 ~6s 超时）。
 * 不传则探全部（兜底 / 调试用）。
 *
 * 探测前先 enrich 注入 OAuth token——这样飞书项目这类走 OAuth 的 server、已授权的能探出
 * ok、没授权 / 失效的才标 fail（detail 注明需要授权、否则永远 401）。跟起 agent 时容错探测同一套。
 *
 * 返回：{ ok: true, health: Record<serverName, McpHealth> }
 */

import { readEffectiveMcpServers } from "@/lib/server/cursor-config";
import { enrichMcpServersWithOAuth } from "@/lib/server/mcp-oauth";
import { probeMcpHealthAll } from "@/lib/server/mcp-probe";

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const all = await readEffectiveMcpServers();
  const enriched = await enrichMcpServersWithOAuth(all);

  // ?servers=a,b,c → 只探这几个（前端传「已开启」的 / 单个）；不传探全部
  const only = new URL(req.url).searchParams.get("servers");
  const wanted = only
    ? new Set(
        only
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  const target = wanted
    ? Object.fromEntries(
        Object.entries(enriched).filter(([name]) => wanted.has(name)),
      )
    : enriched;

  const health = await probeMcpHealthAll(target);
  return new Response(JSON.stringify({ ok: true, health }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
