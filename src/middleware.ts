/**
 * 全站 API 守门 middleware（CR-01）
 *
 * 所有 `/api/**` 请求校验 Host / Origin 必须是 loopback——配合服务端只绑
 * 127.0.0.1（package.json 脚本 -H / Electron HOSTNAME）形成双闸：
 * 即便端口被意外暴露到局域网、或攻击者用 DNS rebinding 让浏览器带非本机
 * Host/Origin 打进来、这里直接 403。
 *
 * OAuth callback（浏览器顶层导航 GET）无 Origin 头、Host 是 localhost——天然放行。
 */
import { NextResponse, type NextRequest } from "next/server";

import { isAllowedLocalRequest } from "@/lib/local-request";

export const middleware = (req: NextRequest): NextResponse => {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  if (!isAllowedLocalRequest(host, origin)) {
    return NextResponse.json(
      { error: "仅允许本机访问（Host/Origin 校验失败）" },
      { status: 403 },
    );
  }
  return NextResponse.next();
};

export const config = {
  matcher: "/api/:path*",
  // Node runtime（Next 15.5 起稳定）：默认 edge 编译会把 instrumentation.ts 链上的
  // node-only 模块（feishu-cli / cursor-config）一起拖进 webpack edge bundle、
  // 报 node: scheme 不支持；本应用只跑 Node server、没有 edge 场景
  runtime: "nodejs",
};
