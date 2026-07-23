/**
 * POST /api/team-library/delete
 * body: { name: string }
 * → 从共享库远端删除 skills/<cat>/<name>/（knowledge 镜像不允许删）
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import {
  deleteFromTeamLibrary,
  isSafeTeamSkillName,
} from "@/lib/server/team-library";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return errorResponse("name 必填");
  if (!isSafeTeamSkillName(name)) {
    return errorResponse("name 非法（字母数字中文与 ._-，不以 . 开头）", 400);
  }

  try {
    const result = await deleteFromTeamLibrary(name);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      ...(result.pendingReview
        ? { pendingReview: true, mrUrl: result.mrUrl }
        : {}),
    });
  } catch (err) {
    console.error("[POST /api/team-library/delete] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : "delete_failed",
      500,
    );
  }
};
