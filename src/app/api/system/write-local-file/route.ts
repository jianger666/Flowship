/**
 * POST /api/system/write-local-file
 *
 * Body: { path, content, eol: "lf"|"crlf", bom: boolean, expectedMtimeMs: number, force?: boolean }
 *
 * 预览窗「编辑 → 保存」的落盘入口。只能覆盖任务关联仓库 / 任务工作区 / 产物里**已存在**的文本文件，
 * 带 mtime 冲突检测与原子写，详见 lib/server/local-file-write 与 local-file-edit-policy。
 * 失败响应：{ error, code }；409 冲突时多带 currentMtimeMs / currentSize，前端据此让用户选「覆盖 / 放弃」。
 */

import { LocalFileWriteError, MAX_EDIT_BYTES, writeLocalFile } from "@/lib/server/local-file-write";

export const runtime = "nodejs";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** 请求体上限：内容上限的几倍（JSON 转义 / 多字节），超出直接拒绝，不去解析 */
const MAX_BODY_BYTES = MAX_EDIT_BYTES * 8;

export const POST = async (req: Request) => {
  // 只收 application/json：跨站 <form> 能发的 text/plain 不会被当成写文件请求（再叠加 middleware 的跨站拦截）
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type 必须是 application/json", code: "invalid" }, 415);
  }
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return json({ error: "请求体过大", code: "too_large" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "body 不是合法 JSON", code: "invalid" }, 400);
  }

  try {
    const result = await writeLocalFile({
      path: typeof body.path === "string" ? body.path : "",
      content: body.content as string,
      eol: body.eol as "lf" | "crlf",
      bom: body.bom === true,
      expectedMtimeMs: Number(body.expectedMtimeMs),
      force: body.force === true,
    });
    return json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof LocalFileWriteError) {
      return json({ error: err.message, code: err.code, ...(err.detail ?? {}) }, err.status);
    }
    return json({ error: `保存失败：${err instanceof Error ? err.message : String(err)}`, code: "io" }, 500);
  }
};
