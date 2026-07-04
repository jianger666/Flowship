/**
 * /api/custom-actions/import
 *   POST → 从本机文件夹批量导入自定义 action（body: { dir: string }）
 *
 * dir 来自桌面端原生目录 picker、server 扫目录第一层的 md 逐个导入——跟
 * /api/repo-branches 同一信任模型（本地单用户桌面 app）。id 重新生成防撞、
 * 单文件失败不影响其余、返回成功 / 失败清单给前端 toast 汇总。
 */

import { NextResponse } from "next/server";
import path from "node:path";
import { importCustomActionsFromDir } from "@/lib/server/custom-action-fs";

export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as { dir?: unknown };
    if (typeof body.dir !== "string" || !path.isAbsolute(body.dir)) {
      return NextResponse.json(
        { error: "dir 必须是绝对路径" },
        { status: 400 },
      );
    }
    const result = await importCustomActionsFromDir(body.dir);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[POST /api/custom-actions/import] failed", err);
    return NextResponse.json({ error: "import_failed" }, { status: 500 });
  }
};
