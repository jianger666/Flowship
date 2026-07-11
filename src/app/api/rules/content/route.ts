/**
 * 读单个自管 rule 的 .mdc 全文（编辑 dialog 用）
 * GET /api/rules/content?name=<n>
 */

import { NextResponse } from "next/server";

import { readAppRuleContent } from "@/lib/server/app-rules";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const name = new URL(req.url).searchParams.get("name")?.trim() ?? "";
  if (!name) return errorResponse("name 必填", 400);
  const content = await readAppRuleContent(name);
  if (content === null) return errorResponse("rule 不存在", 404);
  return NextResponse.json({ ok: true, content });
};
