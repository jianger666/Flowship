/**
 * POST /api/custom-actions/fix-bug-preset
 *   → 用户主动重装出厂「改bug」预置（skill + action）
 *
 * 跳过 presets-installed 记账早退；按「skill 可见 / action 可用」判定，
 * 不可用则覆盖恢复出厂（目录存在≠可见，见 reinstallBuiltinFixBugPreset 注释）。
 * 给收件箱 / 新建页「改bug」发现预置不可用后的二次确认用。
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
