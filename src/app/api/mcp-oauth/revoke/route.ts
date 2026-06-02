/**
 * POST /api/mcp-oauth/revoke
 *
 * 撤销某个 MCP server 的 OAuth 授权（删本地凭证文件）。撤销后起 agent 不再注入 token、
 * 需重新点授权。
 *
 * 入参：{ serverName }
 * 返回：{ ok } | { ok:false, error }
 */

import { clearMcpOAuth } from "@/lib/server/mcp-oauth";

export const runtime = "nodejs";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const POST = async (req: Request) => {
  let serverName: string;
  try {
    const body = (await req.json()) as { serverName?: unknown };
    if (typeof body.serverName !== "string" || !body.serverName.trim()) {
      return json({ ok: false, error: "缺 serverName" }, 400);
    }
    serverName = body.serverName.trim();
  } catch {
    return json({ ok: false, error: "请求体解析失败" }, 400);
  }

  await clearMcpOAuth(serverName);
  return json({ ok: true });
};
