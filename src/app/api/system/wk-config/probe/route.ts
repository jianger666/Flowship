/**
 * POST /api/system/wk-config/probe
 *
 * 探一下 Delivery Hub 地址通不通（服务端发请求，绕开内网 hub 没配 CORS 的问题）。
 * 探测逻辑在 `@/lib/server/wk-hub-probe`，本文件只做 HTTP 壳。
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { readWkHubToken } from "@/lib/server/wk-config";
import { probeWkHub } from "@/lib/server/wk-hub-probe";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { baseUrl?: unknown; token?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
    return errorResponse("缺少 baseUrl");
  }
  if (
    body.token !== undefined &&
    (typeof body.token !== "string" || body.token.length > 4096)
  ) {
    return errorResponse("Delivery Hub Token 格式不对");
  }

  try {
    // 用户正在输入新 Token 时优先试草稿；未传时读取已落盘值。两种情况下都不把明文返回前端。
    const token =
      typeof body.token === "string" && body.token.trim()
        ? body.token.trim()
        : await readWkHubToken();
    return NextResponse.json(await probeWkHub(body.baseUrl, fetch, token));
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
