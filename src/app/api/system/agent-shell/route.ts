/**
 * GET /api/system/agent-shell
 *
 * 设置页「Agent shell 用 Git Bash」：当前壳类型 + Git Bash 路径（仅 win32 有路径）。
 */

import { NextResponse } from "next/server";

import {
  detectAgentShellKind,
  detectGitBashPath,
} from "@/lib/server/agent-shell";

export const runtime = "nodejs";

export const GET = async () => {
  try {
    const gitBashPath = await detectGitBashPath();
    return NextResponse.json({
      agentShellKind: detectAgentShellKind(),
      platform: process.platform,
      gitBashPath,
    });
  } catch (err) {
    console.error("[GET /api/system/agent-shell] failed", err);
    return NextResponse.json(
      {
        error: "probe_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
};
