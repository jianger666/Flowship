/**
 * /api/custom-actions
 *   GET  → 自定义 action 列表（app: / team: 双源派生 + legacy）
 *   POST → 新建（body: { label, skill, output?, placeholder?, requiresKnowledge? }）
 *         → 写 skills/<skill>/.flowship-action.json
 */

import { NextResponse } from "next/server";
import {
  createCustomAction,
  isCustomActionFsError,
  listCustomActions,
  sanitizeSkillName,
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
    const skill = sanitizeSkillName(body.skill);
    if (!skill) {
      return NextResponse.json({ error: "skill 必填" }, { status: 400 });
    }
    const action = await createCustomAction({
      label: body.label,
      skill,
      // 多行产出要求：trim 后空则不写（跟 placeholder 同构）
      output: isNonEmptyString(body.output) ? body.output.trim() : undefined,
      placeholder: isNonEmptyString(body.placeholder)
        ? body.placeholder
        : undefined,
      ...(body.requiresKnowledge === true
        ? { requiresKnowledge: true }
        : {}),
    });
    return NextResponse.json({ action }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/custom-actions] failed", err);
    // 业务冲突 / 校验走稳定 code，禁止文案子串（「已挂载」≠「已有」曾误成 500）
    if (isCustomActionFsError(err)) {
      const status = err.code === "ALREADY_MOUNTED" ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
};
