/**
 * GET /api/local-image?path=<绝对路径>
 *
 * 本地图片的 HTTP 通道（v1.0、用户同事实测：AI 在工作目录生成二维码图、
 * markdown 里 `![](/abs/path.png)` 渲染 404 不显示——本地文件浏览器加载不了）。
 * MarkdownImage 遇到本地绝对路径自动转到这里。
 *
 * 安全边界：本机单用户桌面 app（服务绑 loopback）——能打到这个 API 的进程本来就
 * 读得了本地文件、不扩大威胁面。仍做基本收敛：
 *   - 只服务图片扩展名白名单（不含 svg——内联脚本风险、AI 生成场景用不上）
 *   - 必须是绝对路径 + 真实存在的文件、大小上限 30MB
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};

const MAX_BYTES = 30 * 1024 * 1024;

const errorJson = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const raw = new URL(req.url).searchParams.get("path")?.trim() ?? "";
  if (!raw) return errorJson("path 必填");
  // 绝对路径校验（POSIX + Windows 盘符都认）
  if (!path.isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return errorJson("path 必须是绝对路径");
  }
  const ext = path.extname(raw).slice(1).toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (!mime) return errorJson(`不支持的图片类型：.${ext || "(无扩展名)"}`);

  try {
    const stat = await fs.stat(raw);
    if (!stat.isFile()) return errorJson("不是文件", 404);
    if (stat.size > MAX_BYTES) return errorJson("文件过大（>30MB）", 413);
    const buf = await fs.readFile(raw);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": mime,
        // 本地文件可能被 AI 重新生成（同名覆盖）、不做强缓存
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return errorJson("文件不存在或不可读", 404);
  }
};
