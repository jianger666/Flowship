/**
 * GET /api/tasks/[id]/uploads/[filename]
 *
 * 前端拿用户附图、用于聊天气泡里的缩略图渲染。
 *
 * 文件落盘路径：data/tasks/<id>/uploads/<filename>
 * （由 task-fs.ts saveImageAttachments 生成、filename 形如 att_<ts>_<rnd>.<ext>）
 *
 * 安全：
 *   - taskId / filename 都走严格白名单正则、防 .. 路径穿越
 *   - 只 expose data/tasks/<id>/uploads/ 下、其他目录不让读
 *   - Content-Type 按后缀决定、不信任 magic bytes（够用了、上传时已校验）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { dataRoot } from "@/lib/server/data-root";

interface Ctx {
  params: Promise<{ id: string; filename: string }>;
}

// 跟 task-fs.ts ALLOWED_IMAGE_MIME 反向映射
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const errorJson = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// 防穿越：id 只允许 [a-zA-Z0-9_-]、filename 只允许 [a-zA-Z0-9_]+\.<ext>
const isSafeId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id);
const isSafeFilename = (name: string): boolean =>
  /^[a-zA-Z0-9_]+\.(png|jpg|jpeg|webp|gif)$/i.test(name);

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id, filename } = await params;
  if (!isSafeId(id)) return errorJson("非法 task id");
  if (!isSafeFilename(filename)) return errorJson("非法 filename");

  const ext = filename.split(".").pop()!.toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (!mime) return errorJson("不支持的图片扩展名");

  const absPath = path.join(dataRoot(), "tasks", id, "uploads", filename);
  try {
    const buf = await fs.readFile(absPath);
    // 一律以 Uint8Array 形式返回（避免 Node Buffer → Web Response 的类型差异）
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": mime,
        // 用户上传图不会变、放心 cache（按 filename 唯一）
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return errorJson("not_found", 404);
  }
};
