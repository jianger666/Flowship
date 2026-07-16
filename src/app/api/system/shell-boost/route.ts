/**
 * GET/POST /api/system/shell-boost
 *
 * 设置页「Agent shell 提速」：探测 / 一键注入 Cursor agent 非交互 shell 守卫。
 * 业务逻辑在 shell-boost.ts，本文件只做 HTTP 壳。
 */

import { NextResponse } from "next/server";

import {
  detectAgentShellKind,
  injectAllShellBoost,
  probeAllShellBoost,
} from "@/lib/server/shell-boost";

export const runtime = "nodejs";

/** 探测各目标配置：存在？已含守卫？附带当前 Agent shell 类型 */
export const GET = async () => {
  try {
    const files = await probeAllShellBoost();
    return NextResponse.json({
      files,
      agentShellKind: detectAgentShellKind(),
    });
  } catch (err) {
    console.error("[GET /api/system/shell-boost] failed", err);
    return NextResponse.json(
      {
        error: "probe_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
};

/** 对已存在的目标 rc 顶插守卫（缺文件不创建、已含跳过） */
export const POST = async () => {
  try {
    const results = await injectAllShellBoost();
    return NextResponse.json({ results });
  } catch (err) {
    console.error("[POST /api/system/shell-boost] failed", err);
    return NextResponse.json(
      {
        error: "inject_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
};
