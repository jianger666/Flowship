/**
 * /api/custom-actions/import
 *   POST → 从本机文件夹导入 skill 包（body: { sourceDir }）
 *
 * 须含 SKILL.md → 拷进自管 skills（同名不覆盖）→ 若带 .flowship-action.json 顺手挂壳。
 * sourceDir 来自桌面端原生目录 picker。
 */

import { NextResponse } from "next/server";
import path from "node:path";

import { importCustomActionBundle } from "@/lib/server/custom-action-fs";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { sourceDir?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  if (
    typeof body.sourceDir !== "string" ||
    !path.isAbsolute(body.sourceDir)
  ) {
    return errorResponse("sourceDir 必须是绝对路径");
  }

  try {
    const result = await importCustomActionBundle(body.sourceDir);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isClient =
      /不存在|缺少|已存在|非法|必须是|必填|不是目录|不是合法/.test(msg);
    console.error("[POST /api/custom-actions/import] failed", err);
    return errorResponse(msg, isClient ? 400 : 500);
  }
};
