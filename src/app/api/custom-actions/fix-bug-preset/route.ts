/**
 * POST /api/custom-actions/fix-bug-preset
 *   → 用户主动重装出厂「改bug」预置（skill + action）
 *
 * 跳过 presets-installed 记账早退：缺失才写、已有不覆盖，然后刷新两条记账时间戳。
 * 给收件箱 / 新建页「改bug」发现预置被删后的二次确认用。
 */

import { NextResponse } from "next/server";

import { reinstallBuiltinFixBugPreset } from "@/lib/server/preset-actions";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const POST = async () => {
  try {
    await reinstallBuiltinFixBugPreset();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/custom-actions/fix-bug-preset] failed", err);
    return errorResponse(msg, 500);
  }
};
