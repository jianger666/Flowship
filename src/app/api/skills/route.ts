/**
 * Skills 管理 API（V0.13-P1 独立化、设置页 Skills 卡用）
 *
 * GET    /api/skills                    → 列全部来源 skill（带 source 标签）+ 可导入的 Cursor 全局清单
 * POST   /api/skills                    → 新增 / 覆盖 app 自管 skill { name, content }
 * DELETE /api/skills?name=<n>           → 删 app 自管 skill
 */

import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";

import {
  deleteAppSkill,
  listCursorGlobalSkills,
  listSkillsWithSource,
  shortenHomePath,
  writeAppSkill,
} from "@/lib/server/app-skills";
import { getAppSkillsDir } from "@/lib/server/skills-loader";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async () => {
  // 顺手保证自管目录存在：「AI 帮建」开对话要拿它当 cwd、不存在 agent 起不来
  const appSkillsDir = getAppSkillsDir();
  await fs.mkdir(appSkillsDir, { recursive: true }).catch(() => {});
  const [skills, cursorGlobal] = await Promise.all([
    listSkillsWithSource(),
    listCursorGlobalSkills(),
  ]);
  return NextResponse.json({
    ok: true,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      editable: s.editable,
      absPath: shortenHomePath(s.absPath),
    })),
    cursorGlobal,
    appSkillsDir,
  });
};

export const POST = async (req: Request) => {
  let body: { name?: string; content?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON", 400);
  }
  const name = (body.name ?? "").trim();
  const content = body.content ?? "";
  const failure = await writeAppSkill(name, content);
  if (failure) return errorResponse(failure, 400);
  return NextResponse.json({ ok: true });
};

export const DELETE = async (req: Request) => {
  const name = new URL(req.url).searchParams.get("name")?.trim() ?? "";
  if (!name) return errorResponse("name 必填", 400);
  const failure = await deleteAppSkill(name);
  if (failure) return errorResponse(failure, 400);
  return NextResponse.json({ ok: true });
};
