/**
 * GET /api/local-media/subtitle?path=<字幕文件绝对路径>
 *
 * 返回 WebVTT 文本（.srt 在服务端转换、编码自动识别 UTF-8 / GB18030），给 `<track>` 用。
 */

import { readSubtitleAsVtt } from "@/lib/server/local-media-subtitles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (req: Request): Promise<Response> => {
  const raw = new URL(req.url).searchParams.get("path") ?? "";
  const result = await readSubtitleAsVtt(raw);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return new Response(result.vtt, {
    status: 200,
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
