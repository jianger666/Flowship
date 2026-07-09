/**
 * GET /api/skills/content?name=<n> → 读 app 自管 skill 的 SKILL.md 全文（编辑 dialog 用）
 */

import { NextResponse } from "next/server";

import { readAppSkillContent } from "@/lib/server/app-skills";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const name = new URL(req.url).searchParams.get("name")?.trim() ?? "";
  if (!name) return errorResponse("name 必填", 400);
  const content = await readAppSkillContent(name);
  if (content === null) return errorResponse(`自管 skill「${name}」不存在`, 404);
  return NextResponse.json({ ok: true, content });
};
