/**
 * /api/skills
 *   GET → 当前可用 skill 列表（平台自带 skills/ + 全局 ~/.cursor/skills/）
 *
 * 给自定义 action 编辑页的「带哪些 skill」勾选清单用。复用 skills-loader.loadSkills。
 * 只回 name + description——absPath 是本机绝对路径、前端勾选用不上。
 */

import { NextResponse } from "next/server";
import { loadSkills } from "@/lib/server/skills-loader";

export const GET = async () => {
  try {
    const skills = await loadSkills();
    return NextResponse.json({
      skills: skills.map((s) => ({ name: s.name, description: s.description })),
    });
  } catch (err) {
    console.error("[GET /api/skills] failed", err);
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
};
