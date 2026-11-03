/**
 * GET /api/local-media/subtitles?path=<媒体绝对路径>
 *
 * 列出与媒体文件同目录、同名的字幕（.srt / .vtt）：`{ items: [{ path, label }] }`。
 * 找不到不是错误（`items: []`）；媒体路径本身不合法才 4xx（走与媒体路由同一套守卫）。
 */

import { resolveLocalMediaFile } from "@/lib/server/local-media";
import { findSidecarSubtitles } from "@/lib/server/local-media-subtitles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (req: Request): Promise<Response> => {
  const raw = new URL(req.url).searchParams.get("path") ?? "";
  const resolved = await resolveLocalMediaFile(raw);
  if (!resolved.ok) {
    return Response.json({ error: resolved.error }, { status: resolved.status });
  }
  const items = await findSidecarSubtitles(resolved.file.real);
  return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
};
