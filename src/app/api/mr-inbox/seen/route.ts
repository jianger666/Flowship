/**
 * POST /api/mr-inbox/seen —— 标已读 / 取消已读
 *
 * body: { url: string, seen: boolean }
 *（一期曾用 mrUrl；二期 bug 也用 URL 当 key，统一成 url）
 */

import { NextResponse } from "next/server";

import { parseGitlabMrUrl } from "@/lib/mr-inbox";
import { errorResponse } from "@/lib/server/route-helpers";
import { setMrInboxSeen } from "@/lib/server/mr-inbox-seen";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { url?: unknown; mrUrl?: unknown; seen?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const rawUrl =
    (typeof body.url === "string" ? body.url.trim() : "") ||
    (typeof body.mrUrl === "string" ? body.mrUrl.trim() : "");
  if (!rawUrl) return errorResponse("缺少 url");
  // MR URL 走 canonical；bug URL 原样（parseGitlabMrUrl 认不出就回落 raw）
  const url = parseGitlabMrUrl(rawUrl)?.canonicalUrl ?? rawUrl;
  const seen = body.seen !== false;

  try {
    await setMrInboxSeen(url, seen);
    return NextResponse.json({ ok: true, url, seen });
  } catch (err) {
    console.error("[POST /api/mr-inbox/seen] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};
