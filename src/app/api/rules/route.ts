/**
 * Rules 管理 API（v1.1.x Rules 独立化、能力页 Rules tab 用）
 *
 * GET    /api/rules            → 自管 rules（带 enabled）
 * POST   /api/rules            → 新增 / 覆盖自管 rule { name, content }
 * DELETE /api/rules?name=<n>   → 删自管 rule
 */

import { NextResponse } from "next/server";

import {
  deleteAppRule,
  listAppRules,
  writeAppRule,
} from "@/lib/server/app-rules";
import { readSettingsFile } from "@/lib/server/settings-fs";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async () => {
  const [appRules, settings] = await Promise.all([
    listAppRules(),
    readSettingsFile(),
  ]);
  const disabledArr = settings?.disabledRules;
  const disabled = new Set(
    Array.isArray(disabledArr)
      ? disabledArr.filter((s): s is string => typeof s === "string")
      : [],
  );
  return NextResponse.json({
    ok: true,
    rules: appRules.map((r) => ({
      ...r,
      enabled: !disabled.has(r.name),
    })),
  });
};

export const POST = async (req: Request) => {
  let body: { name?: string; content?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON", 400);
  }
  // as 断言挡不住非 string 的 name / content——.trim() 会 TypeError 变 500、显式验类型
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  const failure = await writeAppRule(name, content);
  if (failure) return errorResponse(failure, 400);
  return NextResponse.json({ ok: true });
};

export const DELETE = async (req: Request) => {
  const name = new URL(req.url).searchParams.get("name")?.trim() ?? "";
  if (!name) return errorResponse("name 必填", 400);
  const failure = await deleteAppRule(name);
  if (failure) return errorResponse(failure, 400);
  return NextResponse.json({ ok: true });
};
