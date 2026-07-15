/**
 * GET /api/mr-inbox/bug-transitions?projectKey=&workItemId=
 *
 * 懒加载：某 bug 当前可流转的目标状态列表（给「我的 BUG」状态 chip 下拉用）。
 * label 缺失的条目过滤掉（没法在 UI 展示）。
 */

import { NextResponse } from "next/server";

import {
  fetchMyUserKey,
  listBugStateTransitions,
  MeegleError,
} from "@/lib/server/meegle-cli";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const url = new URL(req.url);
  const projectKey = url.searchParams.get("projectKey")?.trim() ?? "";
  const workItemId = url.searchParams.get("workItemId")?.trim() ?? "";

  if (!projectKey || !workItemId) {
    return errorResponse("缺少 projectKey / workItemId");
  }

  try {
    const userKey = await fetchMyUserKey();
    if (!userKey) {
      return errorResponse("meegle 未登录、请先在设置页授权", 401);
    }

    const raw = await listBugStateTransitions(projectKey, workItemId, userKey);
    const transitions = raw
      .filter(
        (t) =>
          !!t.transitionId &&
          typeof t.targetStateLabel === "string" &&
          t.targetStateLabel.trim().length > 0,
      )
      .map((t) => ({
        transitionId: t.transitionId,
        targetStateKey: t.targetStateKey,
        targetStateLabel: t.targetStateLabel!.trim(),
      }));

    return NextResponse.json({ transitions });
  } catch (err) {
    if (err instanceof MeegleError) {
      const status =
        err.kind === "not_authed"
          ? 401
          : err.kind === "not_installed"
            ? 503
            : 502;
      return errorResponse(err.message, status);
    }
    console.error("[GET /api/mr-inbox/bug-transitions] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};
