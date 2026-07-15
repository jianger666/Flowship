/**
 * POST /api/mr-inbox/ignore —— 忽略收件箱条目（永久不再出现）
 *
 * body: { url: string }
 * 写入忽略存储后双调剔缓存（MR / bug 命中哪个算哪个）。
 */

import { NextResponse } from "next/server";

import { parseGitlabMrUrl } from "@/lib/mr-inbox";
import { errorResponse } from "@/lib/server/route-helpers";
import { addMrInboxIgnored } from "@/lib/server/mr-inbox-ignored";
import {
  removeBugFromInboxCache,
  removeMrFromInboxCache,
} from "@/lib/server/mr-inbox-scanner";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl) return errorResponse("缺少 url");
  // MR URL 走 canonical；bug URL 原样（parseGitlabMrUrl 认不出就回落 raw）
  const url = parseGitlabMrUrl(rawUrl)?.canonicalUrl ?? rawUrl;

  try {
    await addMrInboxIgnored(url);
    // 双调：条目是 MR 或 bug 二选一、命中哪个算哪个（同 stop 路由对 cancel 的双调）
    removeMrFromInboxCache(url);
    removeBugFromInboxCache(url);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/mr-inbox/ignore] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};
