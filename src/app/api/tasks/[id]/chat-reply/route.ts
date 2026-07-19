/**
 * POST /api/tasks/[id]/chat-reply
 *
 * 业务逻辑在 `chat-inject.ts`（飞书桥接复用同一入口，行为零漂移）。
 */

import { handleChatReplyInject } from "@/lib/server/chat-inject";
import { ensureFeishuBridgeBootstrapped } from "@/lib/server/feishu-bridge/bootstrap";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

// 飞书桥接 bootstrap 锚点（与 /api/tasks 同款）：chat 详情页可能不经任务列表直达本路由
//（不能挂 instrumentation：会把 @cursor/sdk 拖进 webpack 编译炸掉路由）
ensureFeishuBridgeBootstrapped();

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  return handleChatReplyInject(id, body);
};
