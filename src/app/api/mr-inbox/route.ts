/**
 * GET /api/mr-inbox（?refresh=1 强制重扫）
 *
 * 分组响应：pendingMr / myBugs / pendingRegression（各条带 seenAtMs）。
 * 已读标记不进扫描缓存——每次 GET 现读 seen 文件合并。
 */

import { NextResponse } from "next/server";

import { getMrInbox } from "@/lib/server/mr-inbox-scanner";
import { readMrInboxSeen } from "@/lib/server/mr-inbox-seen";

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";

  try {
    const result = await getMrInbox({ refresh });
    if (result.status !== "ok") {
      return NextResponse.json(result);
    }
    const seen = await readMrInboxSeen();
    const withSeen = <T extends { mrUrl?: string; bugUrl?: string }>(
      items: T[],
      keyOf: (it: T) => string,
    ) =>
      items.map((it) => ({
        ...it,
        seenAtMs: seen[keyOf(it)] ?? null,
      }));

    return NextResponse.json({
      status: "ok",
      pendingMr: withSeen(result.pendingMr, (it) => it.mrUrl),
      myBugs: withSeen(result.myBugs, (it) => it.bugUrl),
      pendingRegression: withSeen(result.pendingRegression, (it) => it.bugUrl),
      scannedAt: result.scannedAt,
      gitTokenConfigured: result.gitTokenConfigured,
    });
  } catch (err) {
    console.error("[GET /api/mr-inbox] failed", err);
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};
