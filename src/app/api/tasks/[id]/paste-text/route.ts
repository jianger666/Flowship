/**
 * POST /api/tasks/[id]/paste-text
 *
 * 输入框粘贴超长纯文本 → 落盘 uploads/paste-<ts>.txt → 返回 absPath，
 * 客户端塞进 path 附件 pill（跟附文件同通道、发送时走 [ATTACHED_PATHS]）。
 *
 * 校验：task 存在、content 非空字符串、UTF-8 ≤ 2MB。
 */

import { getTask } from "@/lib/server/task-fs";
import { savePastedTextAttachment } from "@/lib/server/task-artifacts";
import { errorResponse } from "@/lib/server/route-helpers";
import { PASTE_TEXT_MAX_BYTES } from "@/lib/paste-text-attach";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const content =
    body && typeof body === "object" && "content" in body
      ? (body as { content: unknown }).content
      : undefined;
  if (typeof content !== "string" || content.length === 0) {
    return errorResponse("content 必须是非空字符串");
  }

  // 先按字节拦、省得超大 body 进锁写盘；与 savePastedTextAttachment 上限一致
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > PASTE_TEXT_MAX_BYTES) {
    return errorResponse(
      `粘贴文本过大：${(bytes / 1024 / 1024).toFixed(2)} MB（上限 2 MB）`,
      413,
    );
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  try {
    const saved = await savePastedTextAttachment(task.id, content);
    return new Response(
      JSON.stringify({ ok: true, absPath: saved.absPath }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 锁内复查「任务已删」→ 404；其余写盘失败 → 400
    if (message.includes("不存在") || message.includes("已删除")) {
      return errorResponse("not_found", 404);
    }
    return errorResponse(message, 400);
  }
};
