/**
 * /api/custom-actions/export
 *   POST → 把自定义 action 导出成 md 文件（body: { ids: string[], dir: string }）
 *
 * dir 来自桌面端原生目录 picker、每个 action 写一个 `<label>.md`（同存储格式、
 * 对方拿到直接导入）。目录内重名自动加 -2 / -3 后缀、不覆盖。
 */

import { NextResponse } from "next/server";
import path from "node:path";
import { exportCustomActions } from "@/lib/server/custom-action-fs";

export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as { ids?: unknown; dir?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((v): v is string => typeof v === "string")
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "ids 必填" }, { status: 400 });
    }
    if (typeof body.dir !== "string" || !path.isAbsolute(body.dir)) {
      return NextResponse.json(
        { error: "dir 必须是绝对路径" },
        { status: 400 },
      );
    }
    const result = await exportCustomActions(ids, body.dir);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[POST /api/custom-actions/export] failed", err);
    return NextResponse.json({ error: "export_failed" }, { status: 500 });
  }
};
