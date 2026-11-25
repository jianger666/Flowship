/**
 * /api/browser/bookmarks —— 内置浏览器收藏夹（用户侧；刻意不暴露成 AI 工具）
 *   GET    → { bookmarks }                       全部收藏，最新在最前
 *   POST   → body { url, title?, createdAt? }    加一条 → 201 { bookmark, created:true }；
 *                                                同一个地址已收藏 → 200 { bookmark, created:false }（更新标题、顶到最前，幂等）
 *            createdAt 只给「撤销删除」用：带着原来的时间加回来，列表按时间倒序它就回到原位
 *   DELETE → ?id=<收藏 id>                       删一条 → { ok:true }；id 不存在 → 404
 *
 * 业务失败走稳定 code：地址不可收藏 400 invalid_url、收藏夹满了 409 limit_reached（error 是中文、可直接给用户看）。
 * 其余异常只回 `*_failed`、不把内部错误文本透出去。
 */

import { NextResponse } from "next/server";

import { addBookmark, isBookmarkError, listBookmarks, removeBookmark } from "@/lib/server/browser-bookmarks";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async () => {
  try {
    return NextResponse.json({ bookmarks: await listBookmarks() });
  } catch (err) {
    console.error("[GET /api/browser/bookmarks] failed", err);
    return errorResponse("读取收藏夹失败", 500, { code: "list_failed" });
  }
};

export const POST = async (req: Request) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("body 不是合法 JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("body 必须是对象");
  }
  const { url, title, createdAt } = body as Record<string, unknown>;
  try {
    const result = await addBookmark({ url, title, createdAt });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (isBookmarkError(err)) {
      return errorResponse(err.message, err.code === "limit_reached" ? 409 : 400, { code: err.code });
    }
    console.error("[POST /api/browser/bookmarks] failed", err);
    return errorResponse("保存收藏失败", 500, { code: "add_failed" });
  }
};

export const DELETE = async (req: Request) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return errorResponse("缺少 id");
  try {
    const removed = await removeBookmark(id);
    if (!removed) return errorResponse("收藏不存在（可能已被删除）", 404, { code: "not_found" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/browser/bookmarks] failed", err);
    return errorResponse("删除收藏失败", 500, { code: "remove_failed" });
  }
};
