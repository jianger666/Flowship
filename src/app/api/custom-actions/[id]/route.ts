/**
 * /api/custom-actions/[id]
 *   GET    → 单个自定义 action
 *   PATCH  → 更新（部分字段：label / summary / playbook / skills / checkCommands / freshAgent）
 *   DELETE → 删除
 *
 * Next.js 15 的 dynamic route params 是 Promise、要 await。
 */

import { NextResponse } from "next/server";
import {
  getCustomAction,
  removeCustomAction,
  sanitizeCheckCommands,
  sanitizeSkills,
  updateCustomAction,
  type CustomActionInput,
} from "@/lib/server/custom-action-fs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (_req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const action = await getCustomAction(id);
    if (!action)
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ action });
  } catch (err) {
    console.error("[GET /api/custom-actions/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};

export const PATCH = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const body = (await req.json()) as Record<string, unknown>;

    // 只收传了的字段（部分更新）——没传的保留原值
    const patch: Partial<CustomActionInput> = {};
    if ("label" in body) {
      if (typeof body.label !== "string" || !body.label.trim()) {
        return NextResponse.json(
          { error: "label 必须是非空字符串" },
          { status: 400 },
        );
      }
      patch.label = body.label;
    }
    if ("playbook" in body) {
      if (typeof body.playbook !== "string" || !body.playbook.trim()) {
        return NextResponse.json(
          { error: "playbook 必须是非空字符串" },
          { status: 400 },
        );
      }
      patch.playbook = body.playbook;
    }
    if ("summary" in body) {
      patch.summary = typeof body.summary === "string" ? body.summary : "";
    }
    if ("skills" in body) {
      patch.skills = sanitizeSkills(body.skills);
    }
    if ("checkCommands" in body) {
      patch.checkCommands = sanitizeCheckCommands(body.checkCommands);
    }
    if ("freshAgent" in body) {
      patch.freshAgent =
        typeof body.freshAgent === "boolean" ? body.freshAgent : undefined;
    }

    const action = await updateCustomAction(id, patch);
    return NextResponse.json({ action });
  } catch (err) {
    // updateCustomAction 找不到定义会抛
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("不存在")) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error("[PATCH /api/custom-actions/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};

export const DELETE = async (_req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    await removeCustomAction(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/custom-actions/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
