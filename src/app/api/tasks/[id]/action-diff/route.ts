/**
 * GET /api/tasks/[id]/action-diff?actionId=act_1&from=<timestamp>&to=<timestamp|current>
 *
 * V0.6 改 action 维度（替代 V0.5 artifact-diff、phase → actionId）
 *
 * Query：
 *   - actionId（必填）：ActionRecord.id
 *   - from（必填）：revision timestamp（ms epoch）
 *   - to（可选）：revision timestamp 或 "current"、默认 "current"
 *
 * 返：
 *   {
 *     from: { content: string; timestamp: number },
 *     to:   { content: string; timestamp: number | null },
 *   }
 */

import { NextResponse } from "next/server";
import {
  readActionRevisionContent,
  readCurrentActionArtifact,
} from "@/lib/server/task-fs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const GET = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const actionId = url.searchParams.get("actionId");
    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to") ?? "current";

    if (!actionId || !/^[a-zA-Z0-9_-]+$/.test(actionId)) {
      return NextResponse.json({ error: "actionId 必填且只允许字母数字下划线" }, { status: 400 });
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

    const fromRev = await readActionRevisionContent(id, actionId, fromTs);
    if (!fromRev) {
      return NextResponse.json(
        { error: `from=${fromTs} 对应的 revision 不存在（可能被 GC 清理）` },
        { status: 404 },
      );
    }

    let toResult: { content: string; timestamp: number | null };
    if (toRaw === "current") {
      const current = await readCurrentActionArtifact(id, actionId);
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
      const toRev = await readActionRevisionContent(id, actionId, toTs);
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
    console.error("[GET /api/tasks/[id]/action-diff] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
