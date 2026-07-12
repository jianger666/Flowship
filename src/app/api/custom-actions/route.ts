/**
 * /api/custom-actions
 *   GET  → 自定义 action 列表
 *   POST → 新建（body: { label, skill, summary?, output?, placeholder? }）
 *
 * 定义存 dataRoot()/custom-actions/<id>/ACTION.md（skill 挂载壳）、CRUD 归 custom-action-fs.ts。
 */

import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import {
  createCustomAction,
  customActionsDir,
  listCustomActions,
  sanitizeSkillName,
} from "@/lib/server/custom-action-fs";

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

export const GET = async () => {
  try {
    // 顺手保证目录存在（list 空目录也 OK）
    const dir = customActionsDir();
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const actions = await listCustomActions();
    return NextResponse.json({ actions, customActionsDir: dir });
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
    const skill = sanitizeSkillName(body.skill);
    if (!skill) {
      return NextResponse.json({ error: "skill 必填" }, { status: 400 });
    }
    const action = await createCustomAction({
      label: body.label,
      skill,
      summary: isNonEmptyString(body.summary) ? body.summary : undefined,
      // 多行产出要求：trim 后空则不写（跟 summary 同构）
      output: isNonEmptyString(body.output) ? body.output.trim() : undefined,
      placeholder: isNonEmptyString(body.placeholder)
        ? body.placeholder
        : undefined,
    });
    return NextResponse.json({ action }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/custom-actions] failed", err);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
};
