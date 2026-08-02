/**
 * GET /api/system/local-file-bytes?path=<绝对路径>
 *
 * 预览用二进制通道（目前仅 PDF）。返回 application/pdf 字节流供 iframe / blob URL。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { detectLocalFileKind } from "@/lib/local-file-kind";

const MAX_PDF_BYTES = 30 * 1024 * 1024;

const errorJson = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const raw = new URL(req.url).searchParams.get("path")?.trim() ?? "";
  if (!raw) return errorJson("path 必填");
  if (!path.isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return errorJson("path 必须是绝对路径");
  }

  try {
    const real = await fs.realpath(raw);
    const ext = path.extname(real).slice(1).toLowerCase();
    if (detectLocalFileKind(ext) !== "pdf") {
      return errorJson(`不支持的二进制类型：.${ext || "(无)"}`);
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) return errorJson("不是文件", 404);
    if (stat.size > MAX_PDF_BYTES) return errorJson("文件过大", 413);
    const buf = await fs.readFile(real);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return errorJson("文件不存在", 404);
    return errorJson("读取失败", 500);
  }
};
