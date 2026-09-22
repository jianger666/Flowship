/**
 * GET /api/boot-warmup —— server 就绪后壳调一次，触发后台预热（fire-and-forget）。
 *
 * 必须是动态路由：静态预渲染会在 `next build` 期执行，那就变成构建期预热了。
 * 幂等：runBootWarmup 自带 started 单例，多调无害。
 */
import { NextResponse } from "next/server";

import { runBootWarmup } from "@/lib/server/boot-warmup";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  runBootWarmup();
  return NextResponse.json({ ok: true });
}
