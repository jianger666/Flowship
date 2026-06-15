/**
 * /api/mcp/chat-tool
 *
 * 这是 ai-flow 自己起的 HTTP MCP server endpoint、
 * Cursor SDK 启的 agent 会作为 MCP 客户端连过来、调里面的 `wait_for_user` 工具。
 *
 * 全部 GET / POST / DELETE 都直接转给 chat-mcp 模块里的 transport 处理、
 * 这一层只负责把 Next.js 的 Request → MCP transport.handleRequest。
 *
 * 注意：
 * - runtime 必须是 nodejs（要能起 SSE / setTimeout 长跑）
 * - dynamic 强制不缓存（MCP 是 RPC、每次都得真打过去）
 * - maxDuration 500：单个工具调用最长 ~10 分钟（保活间隔）、加点余量
 */

import { handleChatMcpRequest } from "@/lib/server/chat-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 单次工具调用最多 10 分钟保活、给点余量到 ~9 分钟、不超 next.js 默认上限
// （maxDuration 单位是秒）
export const maxDuration = 600;

export const GET = async (req: Request): Promise<Response> =>
  handleChatMcpRequest(req);

export const POST = async (req: Request): Promise<Response> =>
  handleChatMcpRequest(req);

export const DELETE = async (req: Request): Promise<Response> =>
  handleChatMcpRequest(req);
