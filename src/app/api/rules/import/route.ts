/**
 * 从全局 ~/.cursor/rules 导入 rule（拷贝为自管副本、之后互不影响）
 * POST /api/rules/import { names: string[] }
 */

import { NextResponse } from "next/server";

import { importRulesFromCursor } from "@/lib/server/app-rules";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { names?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON", 400);
  }
  const names = Array.isArray(body.names)
    ? body.names.filter((n): n is string => typeof n === "string")
    : [];
  if (names.length === 0) return errorResponse("names 必填", 400);
  const result = await importRulesFromCursor(names);
  return NextResponse.json({ ok: true, ...result });
};
