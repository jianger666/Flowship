/**
 * GET /api/tasks/[id]/ship-precheck
 *
 * ship 前置预检——v0.9.13 CheckRun 门禁删除后只剩「最新 build 后没 review 过」流程提醒
 * （非阻断、advance-dialog 展示黄条、用户可无视直接提测）。
 *
 * Next.js 15 dynamic params 是 Promise、要 await。
 */

import { NextResponse } from "next/server";
import { getTask } from "@/lib/server/task-fs";
import { getShipPrecheck } from "@/lib/server/action-gates";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const GET = async (_req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const task = await getTask(id);
    if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const precheck = await getShipPrecheck(task);
    return NextResponse.json({ precheck });
  } catch (err) {
    console.error("[GET /api/tasks/[id]/ship-precheck] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
