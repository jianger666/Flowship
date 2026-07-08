/**
 * GET /api/system/ide-tools
 *
 * 探测本机装了哪些代码跳转工具（Cursor / VS Code / IDEA / WebStorm）——
 * 设置页「代码跳转工具」下拉按这份结果动态列（未装的置灰）、不再写死两个。
 * 探测逻辑 + 60s 缓存在 ide-tools.ts。
 */

import { NextResponse } from "next/server";
import { listIdeTools } from "@/lib/server/ide-tools";

export const runtime = "nodejs";

export const GET = async () => {
  try {
    const tools = await listIdeTools();
    return NextResponse.json({ tools });
  } catch (err) {
    console.error("[GET /api/system/ide-tools] failed", err);
    return NextResponse.json({ error: "detect_failed" }, { status: 500 });
  }
};
