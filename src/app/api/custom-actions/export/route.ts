/**
 * /api/custom-actions/export
 *   POST → 导出单个自定义 action（body: { id, targetDir }）
 *
 * 把主 skill 整目录拷到 `<targetDir>/<skill名>/`，并写 .flowship-action.json（挂载参数、不含 id）。
 * targetDir 来自桌面端原生目录 picker；主 skill 须本机找得到。
 */

import { NextResponse } from "next/server";
import path from "node:path";

import { exportCustomAction } from "@/lib/server/custom-action-fs";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { id?: unknown; targetDir?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  if (typeof body.id !== "string" || !body.id.trim()) {
    return errorResponse("id 必填");
  }
  if (typeof body.targetDir !== "string" || !path.isAbsolute(body.targetDir)) {
    return errorResponse("targetDir 必须是绝对路径");
  }

  try {
    const result = await exportCustomAction(body.id.trim(), body.targetDir);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 业务校验失败（不存在 / 找不到 skill / 路径非法）→ 400；其它 → 500
    const isClient =
      /不存在|找不到|必须是|必填|不是目录/.test(msg);
    console.error("[POST /api/custom-actions/export] failed", err);
    return errorResponse(msg, isClient ? 400 : 500);
  }
};
