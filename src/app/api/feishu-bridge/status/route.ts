/**
 * 飞书消息桥接引导检查 / 欢迎消息
 *
 * GET  → probeBridgeStatus（CLI / scope / cardkit / runtime 占位）
 * POST → { action: "welcome" } 给 owner 发欢迎私聊（用户点按钮触发）
 */

import { NextResponse } from "next/server";

import {
  getBridgeRuntimeStatus,
  syncBridgeRuntime,
} from "@/lib/server/feishu-bridge/inbound";
import { ensureFeishuBridgeBootstrapped } from "@/lib/server/feishu-bridge/bootstrap";

// 桥接 bootstrap 挂 route 模块加载（不能挂 instrumentation：那个 bundle 不吃
// serverExternalPackages、会把 @cursor/sdk 拖进 webpack 编译炸掉全部路由）
ensureFeishuBridgeBootstrapped();
import {
  probeBridgeStatus,
  sendWelcomeMessage,
} from "@/lib/server/feishu-bridge/probe";
import { LarkApiError } from "@/lib/server/feishu-bridge/types";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async () => {
  try {
    // 先按当前开关同步一次 runtime（用户刚切开关就点重试时立即生效、不等 30s 轮询）
    await syncBridgeRuntime();
    const status = await probeBridgeStatus();
    return NextResponse.json({
      ok: true,
      ...status,
      // probe 只管前置条件；consumer 运行态在这里合入（避免 probe 拖入 inbound 依赖图）
      runtime: getBridgeRuntimeStatus(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(`桥接探测失败：${msg}`, 500);
  }
};

interface PostBody {
  action?: string;
}

export const POST = async (req: Request) => {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  if (body.action === "welcome") {
    try {
      const result = await sendWelcomeMessage();
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof LarkApiError) {
        // P2P 未建立时常见「chat not found」——透出给设置页提示用户先给 bot 发一条
        return errorResponse(err.message, 409);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(`发送欢迎消息失败：${msg}`, 409);
    }
  }

  return errorResponse("未知 action");
};
