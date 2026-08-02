/**
 * GET /api/system/read-local-file?path=<绝对路径>
 *
 * 本地文件预览的数据源：返回 kind + 文本 / HTML / 媒体 URL。
 * 安全边界同 local-image：loopback 桌面端；绝对路径 + realpath + 大小截断。
 */

import { readLocalFileForPreview } from "@/lib/server/local-file-read";

const errorJson = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const raw = new URL(req.url).searchParams.get("path")?.trim() ?? "";
  if (!raw) return errorJson("path 必填");

  try {
    const data = await readLocalFileForPreview(raw);
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return errorJson("文件不存在", 404);
    return errorJson(`读取失败：${message}`, 500);
  }
};
