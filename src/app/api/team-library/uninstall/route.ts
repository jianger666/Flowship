/**
 * POST /api/team-library/uninstall
 * body: { name: string }
 * → 卸载 team skill：只写 skill-states disabled（派生的推进 action 随之消失）。
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import {
  isSafeTeamSkillName,
  uninstallTeamSkill,
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
    const result = await uninstallTeamSkill(name);
    if (!result.ok) return errorResponse(result.error, 400);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/team-library/uninstall] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : "uninstall_failed",
      500,
    );
  }
};
