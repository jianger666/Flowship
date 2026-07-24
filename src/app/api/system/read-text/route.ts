/**
 * GET /api/system/read-text?path=<绝对路径>
 *
 * 桌面端读本机文本文件（设置页「导入环境配置」：pickNativePaths 选 json 后读内容）。
 * 安全边界同 local-image：服务绑 loopback、本机单用户；仍做绝对路径 + 扩展名 + 大小上限。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const ALLOWED_EXT = new Set(["json", "txt", "md"]);
const MAX_BYTES = 2 * 1024 * 1024;

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
  const ext = path.extname(raw).slice(1).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return errorJson(`不支持的文件类型：.${ext || "(无扩展名)"}`);
  }

  try {
    const real = await fs.realpath(raw);
    const realExt = path.extname(real).slice(1).toLowerCase();
    if (!ALLOWED_EXT.has(realExt)) {
      return errorJson("扩展名不匹配", 404);
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) return errorJson("不是文件", 404);
    if (stat.size > MAX_BYTES) return errorJson("文件过大（>2MB）", 413);
    const text = await fs.readFile(real, "utf-8");
    return new Response(JSON.stringify({ text }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return errorJson("文件不存在", 404);
    const message = err instanceof Error ? err.message : String(err);
    return errorJson(`读取失败：${message}`, 500);
  }
};
