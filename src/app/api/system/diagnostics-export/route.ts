/**
 * POST /api/system/diagnostics-export
 *
 * 一键导出诊断包（单个 txt、含版本 / IDE 探测 / 脱敏配置 / main.log 尾部）到
 * 用户「下载」目录、返回落盘路径给前端 toast。组装逻辑见 server/diagnostics.ts。
 *
 * Body: { appVersion?: string }（客户端从 window.__appVersion 带来）
 */

import { NextResponse } from "next/server";
import { exportDiagnostics } from "@/lib/server/diagnostics";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let appVersion: string | undefined;
  try {
    const body = (await req.json()) as { appVersion?: string };
    appVersion = typeof body.appVersion === "string" ? body.appVersion : undefined;
  } catch {
    // body 可空
  }
  try {
    const filePath = await exportDiagnostics(appVersion);
    return NextResponse.json({ ok: true, path: filePath });
  } catch (err) {
    console.error("[diagnostics-export] failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};
