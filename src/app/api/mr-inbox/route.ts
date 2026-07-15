/**
 * GET /api/mr-inbox（?refresh=1 强制重扫）
 *
 * 分组响应：pendingMr / myBugs / pendingRegression（各条带 seenAtMs）。
 * 已读 / 忽略不进扫描缓存——每次 GET 现读文件：先滤忽略、再 join seen。
 */

import { NextResponse } from "next/server";

import { getMrInbox } from "@/lib/server/mr-inbox-scanner";
import { readMrInboxIgnored } from "@/lib/server/mr-inbox-ignored";
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
    // 读缓存后再滤忽略（双保险：ignore 路由已剔缓存，这里兜住漏网 / 并发窗口）
    const [seen, ignored] = await Promise.all([
      readMrInboxSeen(),
      readMrInboxIgnored(),
    ]);
    const notIgnored = <T>(items: T[], keyOf: (it: T) => string): T[] =>
      items.filter((it) => !ignored[keyOf(it)]);
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
      pendingMr: withSeen(
        notIgnored(result.pendingMr, (it) => it.mrUrl),
        (it) => it.mrUrl,
      ),
      myBugs: withSeen(
        notIgnored(result.myBugs, (it) => it.bugUrl),
        (it) => it.bugUrl,
      ),
      pendingRegression: withSeen(
        notIgnored(result.pendingRegression, (it) => it.bugUrl),
        (it) => it.bugUrl,
      ),
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
