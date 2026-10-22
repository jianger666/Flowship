/**
 * 全站 API 守门 middleware（CR-01）
 *
 * 所有 `/api/**` 请求校验 Host / Origin 必须是 loopback——配合服务端只绑
 * 127.0.0.1（package.json 脚本 -H / Electron HOSTNAME）形成双闸：
 * 即便端口被意外暴露到局域网、或攻击者用 DNS rebinding 让浏览器带非本机
 * Host/Origin 打进来、这里直接 403。
 *
 * OAuth callback（浏览器顶层导航 GET）无 Origin 头、Host 是 localhost——天然放行。
 *
 * 第三道（V10-05）：`Sec-Fetch-Site` 为 cross-site / same-site 的非顶层导航请求一律 403——
 * no-cors 的 GET 子资源（`<img src="http://127.0.0.1:端口/api/...">`）浏览器不带 Origin，前两道看不出来。
 * 自家页面是 same-origin、用户手输地址是 none、没带该头的非浏览器调用（curl / hooks / 飞书桥）照旧放行，
 * 只有 OAuth 回调（`GET /api/mcp-oauth/callback` 的跨站顶层导航）例外放行（第四轮 Q4-02 收窄）。判定细节与理由见 lib/local-request 的 isBlockedCrossSiteFetch。
 */
import { NextResponse, type NextRequest } from "next/server";

import { isAllowedLocalRequest, isBlockedCrossSiteFetch } from "@/lib/local-request";

export const middleware = (req: NextRequest): NextResponse => {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  const fetchMeta = {
    site: req.headers.get("sec-fetch-site"),
    mode: req.headers.get("sec-fetch-mode"),
    dest: req.headers.get("sec-fetch-dest"),
    path: req.nextUrl.pathname,
    method: req.method,
  };
  // 先单独判跨站：no-cors 子资源没有 Origin 头，Host / Origin 校验看不出来（V10-05，见 lib/local-request）
  if (isBlockedCrossSiteFetch(fetchMeta)) {
    return NextResponse.json(
      { error: "不接受来自其它网站页面的跨站请求" },
      { status: 403 },
    );
  }
  if (!isAllowedLocalRequest(host, origin, fetchMeta)) {
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
