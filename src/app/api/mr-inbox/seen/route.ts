/**
 * POST /api/mr-inbox/seen —— 标已读 / 取消已读
 *
 * body 二选一：
 * - 单条 `{ url: string, seen: boolean }`（一期曾用 mrUrl）
 * - 批量 `{ urls: string[], seen: boolean }`（一次读改写、不 N 次写盘）
 */

import { NextResponse } from "next/server";

import { normalizeInboxSeenUrl } from "@/lib/mr-inbox";
import { errorResponse } from "@/lib/server/route-helpers";
import {
  setMrInboxSeen,
  setMrInboxSeenMany,
} from "@/lib/server/mr-inbox-seen";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: {
    url?: unknown;
    mrUrl?: unknown;
    urls?: unknown;
    seen?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const seen = body.seen !== false;

  // 批量优先：有 urls 数组就走一次写盘（忽略同包里的 url 单字段）
  if (Array.isArray(body.urls)) {
    const urls = body.urls
      .filter((u): u is string => typeof u === "string")
      .map((u) => normalizeInboxSeenUrl(u))
      .filter((u) => u.length > 0);
    // 去重：同 canonical 多次出现只写一次
    const unique = [...new Set(urls)];
    if (unique.length === 0) return errorResponse("缺少 urls");
    try {
      await setMrInboxSeenMany(unique, seen);
      return NextResponse.json({ ok: true, urls: unique, seen });
    } catch (err) {
      console.error("[POST /api/mr-inbox/seen] batch failed", err);
      return errorResponse(
        err instanceof Error ? err.message : String(err),
        500,
      );
    }
  }

  const rawUrl =
    (typeof body.url === "string" ? body.url.trim() : "") ||
    (typeof body.mrUrl === "string" ? body.mrUrl.trim() : "");
  if (!rawUrl) return errorResponse("缺少 url");
  // MR URL 走 canonical；bug URL 原样（parseGitlabMrUrl 认不出就回落 raw）
  const url = normalizeInboxSeenUrl(rawUrl);

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
