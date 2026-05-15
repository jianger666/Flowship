/**
 * POST /api/tasks/[id]/events
 *
 * 行为：
 *   1. 可选：先按 body.patch 推进 phase / task 状态（patchPhase）
 *   2. 必：按 body 的 kind / phase / text / meta 追加一条事件
 *   3. 返回更新后的 Task（hydrate 过、含 events + artifacts）
 *
 * 为什么 patch + event 走同一个 POST：
 *   - 状态推进和事件记录在业务上是一个动作（如「ack spec」= phase 状态变 ack
 *     + 事件流加一条 phase_ack）、分两个 endpoint 客户端要发两次请求、
 *     中间出错会半残
 *   - V1 拍板「能用 atomic 就别拆」、这里就是个例子
 *
 * V1 这块还兼任「模拟动作」入口，详情页的「模拟 phase_start / 模拟 ack」
 * 都走它、便于跑通端到端 UI、接 SDK 后真启动 spec phase 也走这里。
 */

import { NextResponse } from "next/server";
import {
  appendEvent,
  patchPhase,
} from "@/lib/server/task-fs";
import type {
  EventKind,
  PhaseId,
  PhaseStatus,
  TaskStatus,
} from "@/lib/types";

const VALID_KINDS: EventKind[] = [
  "info",
  "thinking",
  "phase_start",
  "phase_ack",
  "phase_failed",
  "tool_call",
  "user_reply",
  "error",
];
const VALID_PHASES: PhaseId[] = ["plan", "build"];
const VALID_PHASE_STATUS: PhaseStatus[] = [
  "pending",
  "running",
  "awaiting_ack",
  "ack",
  "failed",
];
const VALID_TASK_STATUS: TaskStatus[] = [
  "draft",
  "running",
  "awaiting_user",
  "completed",
  "failed",
];

interface PatchInput {
  phaseId?: PhaseId;
  status?: PhaseStatus;
  taskStatus?: TaskStatus;
  currentPhase?: PhaseId;
}

interface PostBody {
  kind: EventKind;
  phase?: PhaseId;
  text: string;
  meta?: Record<string, unknown>;
  patch?: PatchInput;
}

interface Ctx {
  params: Promise<{ id: string }>;
}

const validatePatch = (p: unknown): PatchInput | { error: string } => {
  if (!p || typeof p !== "object") return { error: "patch 不合法" };
  const x = p as Partial<PatchInput>;
  if (x.phaseId && !VALID_PHASES.includes(x.phaseId)) {
    return { error: "patch.phaseId 非法" };
  }
  if (x.status && !VALID_PHASE_STATUS.includes(x.status)) {
    return { error: "patch.status 非法" };
  }
  // phaseId + status 必须成对出现（要改 phase 状态就两个都要给）
  if ((x.phaseId && !x.status) || (!x.phaseId && x.status)) {
    return { error: "phaseId 和 status 必须成对" };
  }
  if (x.taskStatus && !VALID_TASK_STATUS.includes(x.taskStatus)) {
    return { error: "patch.taskStatus 非法" };
  }
  if (x.currentPhase && !VALID_PHASES.includes(x.currentPhase)) {
    return { error: "patch.currentPhase 非法" };
  }
  return {
    phaseId: x.phaseId,
    status: x.status,
    taskStatus: x.taskStatus,
    currentPhase: x.currentPhase,
  };
};

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
    if (body.phase && !VALID_PHASES.includes(body.phase)) {
      return NextResponse.json({ error: "phase 非法" }, { status: 400 });
    }

    // 1. 可选 patch
    if (body.patch) {
      const patch = validatePatch(body.patch);
      if ("error" in patch) {
        return NextResponse.json({ error: patch.error }, { status: 400 });
      }
      const patched = await patchPhase(id, patch);
      if (!patched) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
    }

    // 2. 追加事件
    const updated = await appendEvent(id, {
      kind: body.kind,
      phase: body.phase,
      text: body.text,
      meta: body.meta,
    });
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ task: updated });
  } catch (err) {
    console.error("[POST /api/tasks/[id]/events] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
