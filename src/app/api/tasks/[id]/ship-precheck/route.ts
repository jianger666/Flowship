/**
 * GET /api/tasks/[id]/ship-precheck
 *
 * V0.6.25 review：ship 前置预检——返回最新 build 的 CheckRun gate 结论（含工作区指纹比对）。
 *
 * 纯给 advance-dialog 展示用：决定是否显示「仍继续提测」override 区、不让 client 自己用
 * checkRun.status 猜（client 算不了 git 指纹）。gate 逻辑单一源在 server（checkShipCheckGate）。
 *
 * ⚠ 不是最终授权：实际 ship 走 POST /advance、那里会再跑一次同一套 gate
 *   （防 precheck 到 submit 之间用户又改了工作区）。
 *
 * Next.js 15 dynamic params 是 Promise、要 await。
 */

import { NextResponse } from "next/server";
import { getTask } from "@/lib/server/task-fs";
import { getShipPrecheck } from "@/lib/server/task-runner";

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
