/**
 * /api/browser/history —— 内置浏览器地址栏记忆（用户侧；刻意不暴露成 AI 工具）
 *   GET    → { history }                         全部记录，最近访问的在最前
 *   POST   → body { url, title? }                记一次访问 → 201 { entry, created:true }；
 *                                                这个地址以前记过 → 200 { entry, created:false }（次数 +1、顶到最前、标题刷新）
 *            访问时间一律用服务端的现在，不接受客户端传
 *   DELETE → ?id=<记录 id>                        删一条 → { ok:true }；id 不存在 → 404
 *          → ?all=1                              清空全部 → { ok:true, removed:<清掉几条> }
 *
 * 业务失败走稳定 code：地址不可记录 400 invalid_url（error 是中文）。其余异常只回 `*_failed`、不把内部错误文本透出去。
 */

import { NextResponse } from "next/server";

import { clearHistory, isHistoryError, listHistory, recordHistoryVisit, removeHistoryEntry } from "@/lib/server/browser-history";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async () => {
  try {
    return NextResponse.json({ history: await listHistory() });
  } catch (err) {
    console.error("[GET /api/browser/history] failed", err);
    return errorResponse("读取浏览历史失败", 500, { code: "list_failed" });
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
  const { url, title } = body as Record<string, unknown>;
  try {
    const result = await recordHistoryVisit({ url, title });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (isHistoryError(err)) return errorResponse(err.message, 400, { code: err.code });
    console.error("[POST /api/browser/history] failed", err);
    return errorResponse("记录浏览历史失败", 500, { code: "record_failed" });
  }
};

export const DELETE = async (req: Request) => {
  const params = new URL(req.url).searchParams;
  if (params.get("all") === "1") {
    try {
      return NextResponse.json({ ok: true, removed: await clearHistory() });
    } catch (err) {
      console.error("[DELETE /api/browser/history?all=1] failed", err);
      return errorResponse("清除浏览历史失败", 500, { code: "clear_failed" });
    }
  }
  const id = params.get("id");
  if (!id) return errorResponse("缺少 id");
  try {
    const removed = await removeHistoryEntry(id);
    if (!removed) return errorResponse("这条记录不存在（可能已被删除）", 404, { code: "not_found" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/browser/history] failed", err);
    return errorResponse("删除浏览历史失败", 500, { code: "remove_failed" });
  }
};
