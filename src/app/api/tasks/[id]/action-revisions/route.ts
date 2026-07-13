/**
 * GET /api/tasks/[id]/action-revisions?actionId=act_1
 *
 * V0.6 改 action 维度（替代 V0.5 artifact-revisions、phase → actionId）
 *
 * Query：
 *   - actionId（必填）：ActionRecord.id（如 "act_1"）
 *
 * 返：
 *   {
 *     revisions: ArtifactRevision[],     // 元数据列表、升序、不含正文
 *     current: { content: string; filename: string } | null,
 *   }
 */

import { NextResponse } from "next/server";
import {
  listActionRevisions,
  pruneIdenticalRevisions,
  readCurrentActionArtifact,
} from "@/lib/server/task-artifacts";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const GET = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const actionId = url.searchParams.get("actionId");
    if (!actionId || !/^[a-zA-Z0-9_-]+$/.test(actionId)) {
      return NextResponse.json({ error: "actionId 必填且只允许字母数字下划线" }, { status: 400 });
    }

    // 先清尾部与当前正文相同的快照（问句插话堆出来的零差异），失败吞错不挡 list
    await pruneIdenticalRevisions(id, actionId).catch((err) => {
      console.warn(
        `[action-revisions] pruneIdenticalRevisions 失败 task=${id} action=${actionId}（吞错继续）：`,
        err,
      );
    });

    const [revisions, current] = await Promise.all([
      listActionRevisions(id, actionId),
      readCurrentActionArtifact(id, actionId),
    ]);

    return NextResponse.json({ revisions, current });
  } catch (err) {
    console.error("[GET /api/tasks/[id]/action-revisions] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
