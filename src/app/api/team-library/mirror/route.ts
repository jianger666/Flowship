/**
 * POST /api/team-library/mirror
 * → 把 wk-knowledgebase 镜像进共享库 knowledge/
 * 推送前跑敏感扫描；命中返回 sensitiveHits（已脱敏）、不推送
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { mirrorKnowledgeBase } from "@/lib/server/team-library";

export const runtime = "nodejs";

export const POST = async () => {
  try {
    const result = await mirrorKnowledgeBase();
    if (!result.ok) {
      // 敏感命中：透传脱敏清单（409），其余错误仍走 errorResponse
      if (result.sensitiveHits && result.sensitiveHits.length > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: result.error ?? "mirror 失败",
            sensitiveHits: result.sensitiveHits,
          },
          { status: 409 },
        );
      }
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
