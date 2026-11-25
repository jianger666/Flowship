/**
 * 飞书消息桥接引导检查 / 欢迎消息
 *
 * GET  → probeBridgeStatus（CLI / scope / cardkit / runtime 占位）
 * POST → { action: "welcome" } 给 owner 发欢迎私聊（用户点按钮触发）
 */

import { NextResponse } from "next/server";

import {
  getBridgeRuntimeStatus,
  hydrateBridgeInboundAt,
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
import { awaitWithCap } from "@/lib/server/feishu-bridge/await-with-cap";
import { LarkApiError } from "@/lib/server/feishu-bridge/types";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

/**
 * 等对账收尾的上限（R20-15）：并入在途对账的调用会一直等到那次收尾，而收尾要过 `event status`（lark-cli 默认 30 秒超时）
 * 和停 consumer（两段各最多 5 秒）——lark-cli 卡住时 status 会跟着挂几十秒。超过这个时间就放手、先返回当前能看到的状态。
 * 15 秒的依据：正常对账是秒级（起 / 停 consumer + 一次 event status），15 秒足够覆盖正常的慢；又明显短于最坏情形，
 * 设置页不至于转圈到用户以为卡死。纯经验值、没有真机压测过；可逆：调这个数，或去掉 awaitWithCap 回到无限等。
 * 放手 ≠ 取消：对账继续在后台跑完（它的错误由 onLateError 记日志），下一次 GET / 写盘通知 / 30 秒轮询都会再对账。
 * （route 模块只允许导出 HTTP 方法与路由配置，所以这个常量不导出；等待逻辑本身在 await-with-cap.ts、有单测。）
 */
const STATUS_SYNC_WAIT_CAP_MS = 15_000;

export const GET = async () => {
  try {
    // 先按当前开关同步一次 runtime（用户刚切开关就点重试时立即生效、不等 30s 轮询）。
    // 若这次调用被并入了在途同步，syncBridgeRuntime 会等在途那次（含补跑轮）收尾再返回，
    // 所以下面 getBridgeRuntimeStatus() 读到的 consumers 不是「还在 stopped / starting」的旧快照；
    // 并入方不会因在途那次抛错而抛；本调用自己发起的对账抛错也只记日志、不让 status 整个 500（第十九轮按推荐定的口径：
    // status 是诊断接口，对账失败时用户更需要看到「当前探测结果 + consumer 的真实状态」，而不是一句「桥接探测失败」；
    // 失败本身由对账层写进 consumer 状态 / 日志，30 秒轮询也会再试）。可逆：去掉这层 try/catch 即回到「对账抛错 → 500」。
    // 等待有上限（STATUS_SYNC_WAIT_CAP_MS）：等太久就放手返回当前状态，对账仍在后台继续。
    try {
      const synced = await awaitWithCap(
        syncBridgeRuntime(),
        STATUS_SYNC_WAIT_CAP_MS,
        (err) =>
          console.warn(
            "[feishu-bridge] status 放手之后，那次对账最终失败了：",
            err instanceof Error ? err.message : err,
          ),
      );
      if (synced.capped) {
        console.warn(
          `[feishu-bridge] status 等对账超过 ${STATUS_SYNC_WAIT_CAP_MS / 1000} 秒，先返回当前状态（对账仍在后台继续）`,
        );
      }
    } catch (err) {
      console.warn(
        "[feishu-bridge] status 触发的对账失败、仍返回当前状态：",
        err instanceof Error ? err.message : err,
      );
    }
    // 重启后「最近收到」从盘上回填（收消息自检不因重启归零）
    await hydrateBridgeInboundAt();
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
