/**
 * POST /api/skills/import { names: string[] } → 从 ~/.cursor/skills 整目录拷进 app 自管
 *（含 scripts 等附属文件、同名覆盖）
 */

import { NextResponse } from "next/server";

import { importSkillsFromCursor } from "@/lib/server/app-skills";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { names?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON", 400);
  }
  const names = Array.isArray(body.names)
    ? body.names.filter((n) => typeof n === "string")
    : [];
  if (names.length === 0) return errorResponse("names 必填", 400);
  const result = await importSkillsFromCursor(names);
  return NextResponse.json({ ok: true, ...result });
};
