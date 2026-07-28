/**
 * POST /api/system/wk-config/probe
 *
 * 探一下 Delivery Hub 地址通不通（服务端发请求，绕开内网 hub 没配 CORS 的问题）。
 * 探测逻辑在 `@/lib/server/wk-hub-probe`，本文件只做 HTTP 壳。
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { probeWkHub } from "@/lib/server/wk-hub-probe";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { baseUrl?: unknown };
  try {
    body = (await req.json()) as { baseUrl?: unknown };
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
    return errorResponse("缺少 baseUrl");
  }

  try {
    return NextResponse.json(await probeWkHub(body.baseUrl));
  } catch (err) {
    console.error("[POST /api/system/wk-config/probe] failed", err);
    return NextResponse.json(
      {
        error: "probe_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
};
