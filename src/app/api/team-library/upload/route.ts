/**
 * POST /api/team-library/upload
 * body: { skillNames: string[]; category: string; force?: boolean }
 * → 把本机自管 skill 上传到共享库 skills/<category>/
 * force=true：跳过敏感扫描阻断（误报出口）
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import {
  isSafeTeamCategory,
  uploadSkillsToTeamLibrary,
} from "@/lib/server/team-library";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: {
    skillNames?: unknown;
    category?: unknown;
    force?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }
  if (!Array.isArray(body.skillNames)) {
    return errorResponse("skillNames 必须是字符串数组");
  }
  // 混入非 string 元素一律 400（不再静默丢弃、避免调用方以为上传了实际没传）
  if (body.skillNames.some((n) => typeof n !== "string")) {
    return errorResponse("skillNames 必须是字符串数组");
  }
  const skillNames = body.skillNames as string[];
  if (skillNames.length === 0) {
    return errorResponse("skillNames 不能为空");
  }
  if (typeof body.category !== "string" || !body.category.trim()) {
    return errorResponse("category 必填");
  }
  const category = body.category.trim();
  if (!isSafeTeamCategory(category)) {
    return errorResponse(
      "category 非法（只允许小写字母数字连字符、1~32 位）",
    );
  }
  const force = body.force === true;

  try {
    const result = await uploadSkillsToTeamLibrary(skillNames, category, {
      force,
    });
    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error ?? "upload 失败",
          results: result.results,
          ...(result.sensitiveHits
            ? { sensitiveHits: result.sensitiveHits }
            : {}),
        },
        { status: 409 },
      );
    }
    // pendingReview + mrUrl：main 受保护时降级 MR（已提交待审核）
    return NextResponse.json({
      ok: true,
      results: result.results,
      ...(result.pendingReview
        ? { pendingReview: true, mrUrl: result.mrUrl }
        : {}),
    });
  } catch (err) {
    console.error("[POST /api/team-library/upload] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : "upload_failed",
      500,
    );
  }
};
