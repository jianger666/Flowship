/**
 * POST /api/team-library/install
 * body: { name: string }
 * → 安装 team skill：只写 skill-states enabled；
 *   带 .flowship-action.json 的推进 action 由 deriveTeamActions 实时派生（无第二份持久化）。
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import {
  installTeamSkill,
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
    const result = await installTeamSkill(name);
    if (!result.ok) return errorResponse(result.error, 400);
    return NextResponse.json({
      ok: true,
      ...(result.actionLabel ? { actionLabel: result.actionLabel } : {}),
    });
  } catch (err) {
    console.error("[POST /api/team-library/install] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : "install_failed",
      500,
    );
  }
};
