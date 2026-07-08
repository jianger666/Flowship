/**
 * POST /api/mcp-oauth/start
 *
 * 发起某个 MCP server 的 OAuth 授权：读 Cursor mcp.json 拿该 server 的 url、跑 SDK 的发现 +
 * DCR 注册 + 生成 PKCE 授权 URL、把授权 URL 返给前端（前端开浏览器让用户登录授权）。
 *
 * 入参：{ serverName }（mcp.json 里的 key）
 * 返回：{ ok, authorizationUrl } | { ok, alreadyAuthorized } | { ok:false, error }
 */

import { readMergedMcpServers } from "@/lib/server/cursor-config";
import { startMcpOAuth } from "@/lib/server/mcp-oauth";

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

  // 从 Cursor mcp.json 拿这个 server 的 url（只有 http/sse 类能走 oauth）
  const servers = await readMergedMcpServers();
  const cfg = servers[serverName];
  if (!cfg || !("url" in cfg)) {
    return json(
      { ok: false, error: `MCP server「${serverName}」不存在或不是 http 类` },
      404,
    );
  }

  try {
    const authorizationUrl = await startMcpOAuth(serverName, cfg.url);
    if (!authorizationUrl) {
      return json({ ok: true, alreadyAuthorized: true });
    }
    return json({ ok: true, authorizationUrl });
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
};
