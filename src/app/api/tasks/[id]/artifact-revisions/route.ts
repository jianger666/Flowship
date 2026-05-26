/**
 * GET /api/tasks/[id]/artifact-revisions?phase=plan
 *
 * V0.5.12：拉某 phase 的修订历史 + 当前正文
 *
 * Query：
 *   - phase（必填）：phase id（"plan" | "build" | "review"）
 *
 * 返：
 *   {
 *     revisions: ArtifactRevision[],     // 元数据列表、升序（最老在前）、不含正文
 *     current: { content: string; filename: string } | null,
 *   }
 *
 * 用法：
 *   - 前端 artifact-panel 切 phase 时 fetch 一次、拿到 revisions 数组填 dropdown options
 *   - 配合 current 作为 diff 的 "to"（用户切「对比上次」时 diff API 拉 "from"）
 *
 * 为什么不顺便返每个 revision 的 content：
 *   - 10 个 revision × 20KB 每条 = 200KB、再加 current 220KB、第一次进 phase 拉确实大
 *   - 切 phase 频繁、首屏体验更重要、改成走 artifact-diff 路由按需拉、cheap path 是 banner 直接显示
 *   - 用户不点 Diff 切换、就只拉 current（200KB → 20KB）
 */

import { NextResponse } from "next/server";
import {
  listArtifactRevisions,
  readCurrentArtifact,
} from "@/lib/server/task-fs";
import { PHASE_IDS, type PhaseId } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const GET = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const phase = url.searchParams.get("phase");
    if (!phase || !PHASE_IDS.includes(phase as PhaseId)) {
      return NextResponse.json(
        { error: `phase 必填、且必须是 ${PHASE_IDS.join(" / ")} 之一` },
        { status: 400 },
      );
    }
    const phaseId = phase as PhaseId;

    // 并行读：revisions 列表 + 当前正文
    const [revisions, current] = await Promise.all([
      listArtifactRevisions(id, phaseId),
      readCurrentArtifact(id, phaseId),
    ]);

    return NextResponse.json({
      revisions,
      current,
    });
  } catch (err) {
    console.error("[GET /api/tasks/[id]/artifact-revisions] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
