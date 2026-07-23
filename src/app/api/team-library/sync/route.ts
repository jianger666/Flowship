/**
 * POST /api/team-library/sync
 * → 手动触发共享库 clone / fetch+reset
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { syncTeamLibrary } from "@/lib/server/team-library";

export const runtime = "nodejs";

export const POST = async () => {
  try {
    const result = await syncTeamLibrary();
    if (!result.ok) {
      return errorResponse(result.error ?? "sync 失败", 409);
    }
    return NextResponse.json({
      ok: true,
      syncedAt: result.syncedAt,
    });
  } catch (err) {
    console.error("[POST /api/team-library/sync] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : "sync_failed",
      500,
    );
  }
};
