/**
 * POST /api/team-library/mirror
 * → 把 wk-knowledgebase 镜像进共享库 knowledge/
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { mirrorKnowledgeBase } from "@/lib/server/team-library";

export const runtime = "nodejs";

export const POST = async () => {
  try {
    const result = await mirrorKnowledgeBase();
    if (!result.ok) {
      return errorResponse(result.error ?? "mirror 失败", 409);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/team-library/mirror] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : "mirror_failed",
      500,
    );
  }
};
