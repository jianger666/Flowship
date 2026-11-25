/**
 * POST /api/tasks/[id]/context-docs
 *
 * 给任务加一条 / 多条上下文文档。
 *
 * Body（V0.6.0.1 重写、支持贴图）：
 *
 * ```
 * {
 *   title?: string;       // 用户填的主条目标题（trim 后 ≤ 100 字）
 *   content?: string;     // URL / 路径 / 自由文本（trim 后 ≤ 50000 字）
 *   images?: Array<{ data: string; mimeType: string; filename?: string }>;
 * }
 * ```
 *
 * 至少一个非空：
 *   - 仅 title+content：加 1 条主条目（type 由后端按内容自动推断）
 *   - 仅 images：加 N 条独立 image doc（title 自动生成「贴图 / 贴图 N」）
 *   - 都有：加 1 条主条目 + N 条 image doc（image 标题前缀复用主条目 title）
 *
 * 返回最新 task（含完整 contextDocs）。
 * 例外：文档已写进 meta、但读回最新任务视图失败时，回 201 `{ ok: true, committed: true, warning }`（没有 task），
 * 调用方要按「已添加、请刷新确认」处理，别当失败重试。
 *
 * 不做的事：
 *   - 不主动改 task.status（用户加上下文不算业务进展、但会 bump updatedAt）
 *   - 不通知 agent run（节奏同步问题暂时由 UI 提示「下次启动 / revise 时生效」处理）
 */

import { addContextDoc, isContextDocCommittedError } from "@/lib/server/task-fs";
import { discardSavedImages, saveImageAttachments } from "@/lib/server/task-artifacts";
import { parseAndValidateImages } from "@/lib/server/route-helpers";
import type { AddContextDocInput } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

const errorResponse = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// 上下文文档允许的贴图张数（一次提交、防一次性塞 N 张超大图把任务上下文撑爆）
const MAX_IMAGES_PER_DOC = 6;

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: AddContextDocInput;
  try {
    body = (await req.json()) as AddContextDocInput;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";

  if (title.length > 100) return errorResponse("title 不能超过 100 字");
  if (content.length > 50_000) {
    return errorResponse("content 不能超过 50000 字");
  }

  // 校验 images（同 ask-reply / question 路由的处理）
  const imagesResult = parseAndValidateImages(body.images, MAX_IMAGES_PER_DOC);
  if (!imagesResult.ok) return imagesResult.errorResponse;
  const images = imagesResult.images;

  // title+content 要么都填、要么都不填（避免一头一尾的歧义）
  const hasMain = title.length > 0 && content.length > 0;
  const partialMain =
    (title.length > 0 && content.length === 0) ||
    (title.length === 0 && content.length > 0);
  if (partialMain) {
    return errorResponse("title / content 必须一起填、或者一起省略");
  }
  if (!hasMain && images.length === 0) {
    return errorResponse("至少填一个：title+content 主条目 或 贴图");
  }

  // 图片先落盘（拿绝对路径）、文档再写进 meta：中间任何一步失败（所有者备注超限等校验在 addContextDoc 的锁内、读到最新文档之后才做，
  // 预检挡不住并发写入；写 meta 失败；任务刚好被删），已落盘的图片没人引用了，必须收回——否则每次被拒的「备注 + 贴图」都在 uploads/ 里留一批孤儿图片
  // （第三轮评审：以前这里先落盘再校验，超限就留孤儿）
  let imagePaths: string[] | undefined;
  try {
    if (images.length > 0) {
      const saved = await saveImageAttachments(id, images);
      imagePaths = saved.map((s) => s.absPath);
    }

    const updated = await addContextDoc(id, {
      mainDoc: hasMain ? { title, content } : undefined,
      imagePaths,
    });
    if (!updated) {
      await discardSavedImages(id, imagePaths);
      return errorResponse("not_found", 404);
    }
    return new Response(JSON.stringify({ ok: true, task: updated }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // 文档已经写进 meta、只是读回最新任务视图失败：图片已被文档引用，这时回收就留下悬空引用（第四轮评审 P2）。
    // 只回收「没加上」的那种失败（校验被拒 / 写 meta 失败 / 任务没了）
    const committed = isContextDocCommittedError(err);
    const msg = err instanceof Error ? err.message : String(err);
    if (committed) {
      // 已生效的失败：文档已经落盘、请求本身成功了，只是没法回最新任务视图（所以没有 task）。
      // 回 201 + warning 而不是 500：500 会让前端当成「没加上」弹错误、不清表单，用户再点一次就重复添加（第五轮评审 N3）
      return new Response(JSON.stringify({ ok: true, committed: true, warning: msg }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    await discardSavedImages(id, imagePaths);
    return errorResponse(msg, 400);
  }
};
