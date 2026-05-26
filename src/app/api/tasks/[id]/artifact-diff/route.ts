/**
 * GET /api/tasks/[id]/artifact-diff?phase=plan&from=<timestamp>&to=<timestamp|current>
 *
 * V0.5.12：拉两个时刻的 artifact 正文做对比（前端拿到 raw、用 react-diff-viewer-continued 渲染）
 *
 * Query：
 *   - phase（必填）：phase id（"plan" | "build" | "review"）
 *   - from（必填）：revision timestamp（ms epoch、来自 artifact-revisions 返的 revisions[i].timestamp）
 *   - to（可选）：revision timestamp 或 "current"、默认 "current"
 *
 * 返：
 *   {
 *     from: { content: string; timestamp: number },
 *     to:   { content: string; timestamp: number | null },  // current 时 timestamp=null
 *   }
 *
 * 失败语义：
 *   - phase / from / to 格式错 → 400
 *   - from 找不到对应 revision（被 GC 删了 / 人工删了）→ 404
 *   - to=current 但 artifact 不存在 → 404
 *   - to 是 timestamp 但找不到对应 revision → 404
 *
 * 不接受前端传 raw path：from / to 都用 timestamp 索引、由服务端查 meta.revisions 拿 path、防穿越
 */

import { NextResponse } from "next/server";
import {
  readArtifactRevisionContent,
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
    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to") ?? "current";

    if (!phase || !PHASE_IDS.includes(phase as PhaseId)) {
      return NextResponse.json(
        { error: `phase 必填、且必须是 ${PHASE_IDS.join(" / ")} 之一` },
        { status: 400 },
      );
    }
    if (!fromRaw) {
      return NextResponse.json({ error: "from 必填" }, { status: 400 });
    }
    const fromTs = Number(fromRaw);
    if (!Number.isFinite(fromTs)) {
      return NextResponse.json(
        { error: "from 必须是数字（ms epoch）" },
        { status: 400 },
      );
    }
    const phaseId = phase as PhaseId;

    // from：必须是历史 revision
    const fromRev = await readArtifactRevisionContent(id, phaseId, fromTs);
    if (!fromRev) {
      return NextResponse.json(
        { error: `from=${fromTs} 对应的 revision 不存在（可能被 GC 清理）` },
        { status: 404 },
      );
    }

    // to：current 或历史 revision
    let toResult: { content: string; timestamp: number | null };
    if (toRaw === "current") {
      const current = await readCurrentArtifact(id, phaseId);
      if (!current) {
        return NextResponse.json(
          { error: "to=current 但当前 artifact 不存在" },
          { status: 404 },
        );
      }
      toResult = { content: current.content, timestamp: null };
    } else {
      const toTs = Number(toRaw);
      if (!Number.isFinite(toTs)) {
        return NextResponse.json(
          { error: 'to 必须是数字（ms epoch）或 "current"' },
          { status: 400 },
        );
      }
      const toRev = await readArtifactRevisionContent(id, phaseId, toTs);
      if (!toRev) {
        return NextResponse.json(
          { error: `to=${toTs} 对应的 revision 不存在（可能被 GC 清理）` },
          { status: 404 },
        );
      }
      toResult = { content: toRev.content, timestamp: toTs };
    }

    return NextResponse.json({
      from: { content: fromRev.content, timestamp: fromTs },
      to: toResult,
    });
  } catch (err) {
    console.error("[GET /api/tasks/[id]/artifact-diff] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
