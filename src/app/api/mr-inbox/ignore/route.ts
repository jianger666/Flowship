/**
 * POST /api/mr-inbox/ignore —— 忽略收件箱条目（不再出现、直到被撤销或 90 天 prune）
 * DELETE /api/mr-inbox/ignore —— 撤销忽略（「已忽略」toast 的撤销入口）
 *
 * GET /api/mr-inbox/ignore —— 已忽略条目列表（面板「已忽略」常驻入口；旧数据缺标题时只有 url）
 *
 * body: { url: string, meta?: { title?, group?, ref? } }（meta 仅 POST、服务端清洗后落盘）
 * POST 写入忽略存储后双调剔缓存（MR / bug 命中哪个算哪个）；
 * DELETE 从忽略存储移除、清掉近期补丁里该 url 的记录并作废扫描缓存
 *（缓存里已没有这条、下次 GET 必须重扫才会回来；recentMutations 不清的话重扫结果仍被它滤掉 10 分钟）。
 */

import { NextResponse } from "next/server";

import { parseGitlabMrUrl } from "@/lib/mr-inbox";
import { errorResponse } from "@/lib/server/route-helpers";
import { sanitizeIgnoredMeta } from "@/lib/mr-inbox-ignored-meta";
import {
  addMrInboxIgnored,
  listMrInboxIgnored,
  removeMrInboxIgnored,
} from "@/lib/server/mr-inbox-ignored";
import {
  clearRecentMutation,
  invalidateMrInboxCache,
  removeBugFromInboxCache,
  removeMrFromInboxCache,
} from "@/lib/server/mr-inbox-scanner";

export const runtime = "nodejs";

export const GET = async () => {
  try {
    return NextResponse.json({ ok: true, items: await listMrInboxIgnored() });
  } catch (err) {
    console.error("[GET /api/mr-inbox/ignore] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};

export const POST = async (req: Request) => {
  let body: { url?: unknown; meta?: unknown };
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
    await addMrInboxIgnored(url, sanitizeIgnoredMeta(body.meta));
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

export const DELETE = async (req: Request) => {
  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl) return errorResponse("缺少 url");
  const url = parseGitlabMrUrl(rawUrl)?.canonicalUrl ?? rawUrl;

  try {
    await removeMrInboxIgnored(url);
    // 忽略时 url 被记进 recentMutations（10 分钟）；不清的话撤销后重扫仍被滤掉
    clearRecentMutation(url);
    invalidateMrInboxCache();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/mr-inbox/ignore] failed", err);
    return errorResponse(
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
};
