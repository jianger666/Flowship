/**
 * GET /api/skills/content?name=<n>&source=<optional>
 * → 读已知来源 skill 的 SKILL.md 全文（编辑 dialog + 只读详情共用）
 *
 * source 可选：同名多来源时消歧；不传则取 listSkillsWithSource 首个命中。
 * 名字必须落在已知列表内——防任意路径读。
 */

import { NextResponse } from "next/server";

import {
  readSkillContentByName,
  type SkillSource,
} from "@/lib/server/app-skills";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

const VALID_SOURCES = new Set<SkillSource>([
  "builtin",
  "app",
  "feishu-cli",
  "team",
]);

export const GET = async (req: Request) => {
  const url = new URL(req.url);
  const name = url.searchParams.get("name")?.trim() ?? "";
  if (!name) return errorResponse("name 必填", 400);
  const rawSource = url.searchParams.get("source")?.trim() ?? "";
  let source: SkillSource | undefined;
  if (rawSource) {
    if (!VALID_SOURCES.has(rawSource as SkillSource)) {
      return errorResponse(`source 非法：${rawSource}`, 400);
    }
    source = rawSource as SkillSource;
  }
  const content = await readSkillContentByName(name, source);
  if (content === null) {
    return errorResponse(
      source
        ? `skill「${name}」（${source}）不存在`
        : `skill「${name}」不存在`,
      404,
    );
  }
  return NextResponse.json({ ok: true, content });
};
