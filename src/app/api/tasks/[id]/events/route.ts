/**
 * POST /api/tasks/[id]/events
 *
 * V0.6：只支持追加事件。状态推进 / 切换走 /advance、/action-ack、/finalize。
 *
 * 替代 V0.5 路由：events（原来支持 patch + event 二合一、phase 维度）
 *
 * # Body
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
 * 给 UI / 调试 / 老 V0.5 task 调试视图用、agent 自己写事件走 task-runner.writeEventAndPublish。
 */

import { NextResponse } from "next/server";
import { appendEvent } from "@/lib/server/task-fs";
import type { EventKind } from "@/lib/types";

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
