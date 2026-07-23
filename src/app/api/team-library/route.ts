/**
 * GET /api/team-library
 * → 共享库状态 + 可安装的 team action 列表
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import {
  getTeamLibraryStatus,
  listTeamActions,
} from "@/lib/server/team-library";

export const runtime = "nodejs";

export const GET = async () => {
  try {
    const [status, actions] = await Promise.all([
      getTeamLibraryStatus(),
      listTeamActions(),
    ]);
    return NextResponse.json({ ok: true, status, actions });
  } catch (err) {
    console.error("[GET /api/team-library] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : "list_failed",
      500,
    );
  }
};
