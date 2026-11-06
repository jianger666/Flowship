/**
 * GET /api/system/local-file-stat?path=<绝对路径>
 *
 * 预览窗轮询用：只返回 mtime / size，用来发现「文件在磁盘上被别处改了」。
 * 不读内容、不做任何解析，开销是一次 stat。UNC / 非本地路径在碰文件系统之前拒绝（同 read-local-file）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { nonLocalPathReason } from "@/lib/unc-path";

export const runtime = "nodejs";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const GET = async (req: Request) => {
  const raw = new URL(req.url).searchParams.get("path")?.trim() ?? "";
  if (!raw) return json({ error: "path 必填" }, 400);
  const nonLocal = nonLocalPathReason(raw);
  if (nonLocal) return json({ error: nonLocal }, 400);
  if (!path.isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return json({ error: "path 必须是绝对路径" }, 400);
  }
  try {
    const st = await fs.stat(raw);
    if (!st.isFile()) return json({ exists: false });
    return json({ exists: true, mtimeMs: st.mtimeMs, size: st.size });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return json({ exists: false });
    return json({ error: "无法读取文件状态" }, 500);
  }
};
