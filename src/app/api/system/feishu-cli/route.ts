/**
 * 飞书 CLI 集成状态 / 操作（V0.12 P0）
 *
 * GET  → { larkCli, meegle, install, logins }（设置页轮询）
 * POST → { action: "install" } 一键安装两个 CLI + 官方 skills
 *        { action: "login", tool: "lark-cli" | "meegle", meegleHost? } 发起登录
 */

import { NextResponse } from "next/server";

import {
  getFeishuCliStatus,
  getInstallState,
  getLoginState,
  startInstall,
  startLogin,
} from "@/lib/server/feishu-cli";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async () => {
  const status = await getFeishuCliStatus();
  return NextResponse.json({
    ok: true,
    ...status,
    install: getInstallState(),
    logins: {
      larkCli: getLoginState("lark-cli"),
      meegle: getLoginState("meegle"),
    },
  });
};

interface PostBody {
  action?: string;
  tool?: string;
  meegleHost?: string;
}

export const POST = async (req: Request) => {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  if (body.action === "install") {
    const started = startInstall();
    return NextResponse.json({ ok: true, started });
  }

  if (body.action === "login") {
    if (body.tool !== "lark-cli" && body.tool !== "meegle") {
      return errorResponse("tool 必须是 lark-cli 或 meegle");
    }
    const result = await startLogin(body.tool, { meegleHost: body.meegleHost });
    if (!result.ok) return errorResponse(result.error ?? "登录发起失败", 409);
    return NextResponse.json({ ok: true });
  }

  return errorResponse("未知 action");
};
