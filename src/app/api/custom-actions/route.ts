/**
 * /api/custom-actions
 *   GET  → 自定义 action 列表
 *   POST → 新建（body: { label, playbook, summary?, skills?, checkCommands?, freshAgent? }）
 *
 * 定义存 dataRoot()/custom-actions/<id>.md、CRUD 归 custom-action-fs.ts、route 只做 IO + 校验。
 */

import { NextResponse } from "next/server";
import {
  createCustomAction,
  listCustomActions,
  sanitizeCheckCommands,
  sanitizeSkills,
} from "@/lib/server/custom-action-fs";

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

export const GET = async () => {
  try {
    const actions = await listCustomActions();
    return NextResponse.json({ actions });
  } catch (err) {
    console.error("[GET /api/custom-actions] failed", err);
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
};

export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (!isNonEmptyString(body.label)) {
      return NextResponse.json({ error: "label 必填" }, { status: 400 });
    }
    if (!isNonEmptyString(body.playbook)) {
      return NextResponse.json({ error: "playbook 必填" }, { status: 400 });
    }
    const action = await createCustomAction({
      label: body.label,
      playbook: body.playbook,
      summary: isNonEmptyString(body.summary) ? body.summary : undefined,
      skills: sanitizeSkills(body.skills),
      checkCommands: sanitizeCheckCommands(body.checkCommands),
      freshAgent:
        typeof body.freshAgent === "boolean" ? body.freshAgent : undefined,
    });
    return NextResponse.json({ action }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/custom-actions] failed", err);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
};
