/**
 * GET|HEAD /api/local-media?path=<绝对路径>
 *
 * 本地音视频的流式通道（支持 Range，播放器拖进度 / 边下边播靠它）。
 * 守卫、缓存口径、Range 细节都在 `lib/server/local-media`，这里只做路由壳。
 * HEAD 供播放器探测「文件有没有被重新生成」（读 ETag / Content-Length，不开文件流）。
 */

import { serveLocalMedia } from "@/lib/server/local-media";

export const runtime = "nodejs";
// 每次请求都读盘、不要被 Next 当静态路由缓存
export const dynamic = "force-dynamic";

export const GET = (req: Request): Promise<Response> => serveLocalMedia(req);
export const HEAD = (req: Request): Promise<Response> => serveLocalMedia(req);
