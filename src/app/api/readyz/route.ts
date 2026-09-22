/**
 * GET /api/readyz —— 存活探针（壳的 waitForReady 轮询它，不再轮询 `/`）。
 *
 * 故意零业务：无参、无动态标记，可被构建期预渲染——响应只证明 HTTP 栈起来了，
 * 不跑任何服务端逻辑。之前的 `/` 轮询把"监听起来"和"首页渲完"混在一起，
 * 首页稍慢就会被误判成 server 没起。
 */
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true });
}
