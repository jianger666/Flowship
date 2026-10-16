/**
 * POST /api/csp-report —— CSP Report-Only 违规收集端点（next.config.mjs 的 `report-uri` 指向这里）。
 *
 * 只收不存：解析、脱敏、限体积、限频、内存去重、`console.warn` 一行都在
 * lib/server/csp-report（这里只是薄壳）。不读写任务数据、不落盘。
 *
 * 访问控制：沿用全站 `/api/**` 的 middleware 守门（src/middleware.ts：Host 必须是 loopback，
 * 带 Origin 时必须与 Host 同源）——浏览器给同源页面发的违规报告 Origin 就是页面自身、天然通过；
 * 本机其它端口 / 局域网 / DNS rebinding 的伪造上报在 middleware 就被 403。
 * 本路由不另开口子（不放宽 Origin、不加 CORS 头）。
 *
 * 状态码：204 收下（含被限频 / 畸形 / 非 CSP 报文——不让浏览器重试）、413 超体积、
 * 其它方法一律 405（显式导出而不是靠 Next 默认：行为可测，也不会让 Next 自动实现的
 * OPTIONS 把别的方法宣告成「允许」）。
 */
import { defaultCspReportDeps, handleCspReportPost } from "@/lib/server/csp-report";

export const runtime = "nodejs";

export const POST = async (req: Request): Promise<Response> => {
  try {
    const status = await handleCspReportPost(req, defaultCspReportDeps());
    return new Response(null, { status });
  } catch {
    // handler 内部已吞掉解析 / 读取异常；这里是最后一道兜底：上报端点永不 5xx
    return new Response(null, { status: 204 });
  }
};

const methodNotAllowed = (): Response =>
  new Response(null, { status: 405, headers: { Allow: "POST" } });

export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
