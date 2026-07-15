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
import { getTask } from "@/lib/server/task-fs";
import {
  filterIdenticalTailRevisionsForDisplay,
  listActionRevisions,
  pruneIdenticalRevisions,
  readCurrentActionArtifact,
  shouldPruneIdenticalRevisionsOnList,
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

    // agent 活跃期间不 prune：question 刚 snapshot 时正文==快照，面板刷新若立刻清会误删
    // 这份「暂时相同」的快照 → AI 改完后修订开关不亮。只列不清；idle 后再清零差异。
    const task = await getTask(id);
    if (task && shouldPruneIdenticalRevisionsOnList(task, actionId)) {
      await pruneIdenticalRevisions(id, actionId).catch((err) => {
        console.warn(
          `[action-revisions] pruneIdenticalRevisions 失败 task=${id} action=${actionId}（吞错继续）：`,
          err,
        );
      });
    }

    const [revisions, current] = await Promise.all([
      listActionRevisions(id, actionId),
      readCurrentActionArtifact(id, actionId),
    ]);

    // running 态 prune 被闸住时，问类插话的相同快照仍会短暂进列表 → 假红点。
    // 展示层滤掉尾部相同项（不删文件）；红点「最新 ts > seenTs」随之自然正确。
    const visible = await filterIdenticalTailRevisionsForDisplay(
      id,
      revisions,
      current?.content ?? null,
    );

    return NextResponse.json({ revisions: visible, current });
  } catch (err) {
    console.error("[GET /api/tasks/[id]/action-revisions] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
