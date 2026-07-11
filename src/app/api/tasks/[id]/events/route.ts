/**
 * /api/tasks/[id]/events
 *
 * GET（v1.0.x 事件懒加载）：分页拉「某条事件之前」的更早历史
 *   query：before=<eventId>（必填、锚点）、limit=<N>（默认 300）
 *   返回：{ events, hasMore }——events 按时间正序、紧邻 before 之前的 N 条
 *
 * POST：只支持追加事件。状态推进 / 切换走 /advance、/finalize。
 *
 * # POST Body
 *
 * ```
 * {
 *   kind: EventKind,
 *   actionId?: string,
 *   text: string,
 *   meta?: Record<string, unknown>,
 * }
 * ```
 *
 * # 用途
 *
 * 给 UI / 调试用、agent 自己写事件走 task-runner.writeEventAndPublish。
 */

import { NextResponse } from "next/server";
import { appendEvent, getTask } from "@/lib/server/task-fs";
import type { EventKind } from "@/lib/types";

const DEFAULT_PAGE = 300;

export const GET = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const before = url.searchParams.get("before") ?? "";
    if (!before) {
      return NextResponse.json({ error: "before 必填" }, { status: 400 });
    }
    const limitRaw = url.searchParams.get("limit");
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const limit =
      Number.isFinite(limitParsed) && limitParsed > 0
        ? Math.min(limitParsed, 2000)
        : DEFAULT_PAGE;

    const task = await getTask(id);
    if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const idx = task.events.findIndex((e) => e.id === before);
    if (idx < 0) {
      // 锚点不存在（事件被清 / id 错）——按「没有更早」处理、别 404 打断 UI
      return NextResponse.json({ events: [], hasMore: false });
    }
    const start = Math.max(0, idx - limit);
    return NextResponse.json({
      events: task.events.slice(start, idx),
      hasMore: start > 0,
    });
  } catch (err) {
    console.error("[GET /api/tasks/[id]/events] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};

const VALID_KINDS: EventKind[] = [
  "info",
  "thinking",
  "action_start",
  "action_ack",
  "action_failed",
  "tool_call",
  "user_reply",
  "assistant_message",
  "ask_user_request",
  "ask_user_reply",
  "error",
];

interface PostBody {
  kind: EventKind;
  actionId?: string;
  text: string;
  meta?: Record<string, unknown>;
}

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const body = (await req.json()) as Partial<PostBody>;

    if (!body.kind || !VALID_KINDS.includes(body.kind)) {
      return NextResponse.json({ error: "kind 非法" }, { status: 400 });
    }
    if (typeof body.text !== "string") {
      return NextResponse.json({ error: "text 必填" }, { status: 400 });
    }
    const actionId = typeof body.actionId === "string" ? body.actionId : undefined;

    const event = await appendEvent(id, {
      kind: body.kind,
      actionId,
      text: body.text,
      meta: body.meta,
    });
    if (!event) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, event });
  } catch (err) {
    console.error("[POST /api/tasks/[id]/events] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
