/**
 * POST /api/system/wk-config/probe
 *
 * 探一下 Delivery Hub 地址通不通（服务端发请求，绕开内网 hub 没配 CORS 的问题）。
 * 探测逻辑在 `@/lib/server/wk-hub-probe`，本文件只做 HTTP 壳。
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import { readWkConfig, readWkHubToken } from "@/lib/server/wk-config";
import { probeWkHub } from "@/lib/server/wk-hub-probe";
import { isSameHubOrigin } from "@/lib/wk-hub";

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
    // 已落盘的 Token 只发给「配置里那个 Hub」（同源）：请求体 baseUrl 可以是任意地址，
    // 不加这道闸，任何能打到本机 API 的调用方都能让 server 把落盘 Token 发去它指定的主机（评审 P2）。
    // 草稿 Token 是调用方自己带来的、不受限。地址与已配置的 Hub 不同源 → 不带 Token 探（Hub 返回 401 也是有效的探测结论）
    let token: string;
    if (typeof body.token === "string" && body.token.trim()) {
      token = body.token.trim();
    } else {
      // 配置读不出来（文件被占 / 手改坏）：当没有已配置的 Hub，不带 Token 探——宁可探出 401 也不乱发
      const saved = await readWkConfig().catch(() => null);
      token =
        saved && isSameHubOrigin(body.baseUrl, saved.hubBaseUrl)
          ? await readWkHubToken()
          : "";
    }
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
