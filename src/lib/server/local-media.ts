/**
 * 本地音视频的 HTTP 通道（`GET|HEAD /api/local-media?path=<绝对路径>`）
 *
 * 和 `/api/local-image` 的区别：媒体文件动辄几百 MB（2K 成片 340–430 MB），不能整文件读进内存，
 * 也不能设 30MB 上限——这里**流式**读盘，并完整支持 Range（拖进度条 / 边下边播靠它）。
 *
 * 安全边界（与 local-image 同口径，本机单用户桌面 app、服务只绑 loopback、全站 middleware 另挡跨站）：
 *   - UNC / 设备路径在碰文件系统之前拒绝（Windows 上 realpath 会触发 SMB / NTLM 外发）
 *   - 必须是绝对路径；扩展名白名单（见 media-kind）；`realpath` 之后再验一遍扩展名——防软链指到非媒体文件
 *   - 只服务普通文件（目录 / 设备 / 管道都是 404）
 *   - 不发 CORS 头：别的来源的页面既读不到内容，middleware 也先 403 了
 *
 * 缓存口径：同名覆盖是常态（AI 反复重渲同一个 preview.mp4），所以 `Cache-Control: no-cache`（每次问一下）
 * + 强 ETag（大小 + 修改时间）。播放器自己在 URL 上带 `v=<etag>` 做版本区分，文件变了换 URL、不吃旧缓存。
 */

import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import {
  detectMediaKind,
  mimeForMedia,
  type MediaKind,
} from "@/lib/media/media-kind";
import {
  buildMediaEtag,
  ifNoneMatchHits,
  ifRangeAllowsRange,
  parseRangeHeader,
} from "@/lib/media/media-range";
import { nonLocalPathReason } from "@/lib/unc-path";

export interface LocalMediaFile {
  /** realpath 之后的真实路径 */
  real: string;
  size: number;
  mtimeMs: number;
  ext: string;
  mime: string;
  kind: MediaKind;
  etag: string;
  lastModified: string;
}

export type ResolveLocalMediaResult =
  | { ok: true; file: LocalMediaFile }
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string): ResolveLocalMediaResult => ({
  ok: false,
  status,
  error,
});

/**
 * 校验并解析一个媒体路径：返回真实路径 + 文件事实，或带状态码的失败原因。
 * 所有媒体路由（含 HEAD 探测）共用，避免各写一套守卫。
 */
export const resolveLocalMediaFile = async (
  rawInput: string,
): Promise<ResolveLocalMediaResult> => {
  const raw = rawInput.trim();
  if (!raw) return fail(400, "path 必填");
  const nonLocal = nonLocalPathReason(raw);
  if (nonLocal) return fail(400, nonLocal);
  if (!path.isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return fail(400, "path 必须是绝对路径");
  }
  // 请求路径先过扩展名白名单（快失败）；realpath 之后再验一遍
  if (!mimeForMedia(raw)) {
    const ext = path.extname(raw).slice(1).toLowerCase();
    return fail(400, `不支持的音视频类型：.${ext || "(无扩展名)"}`);
  }
  let real: string;
  try {
    real = await fs.realpath(raw);
  } catch {
    return fail(404, "文件不存在或不可读");
  }
  const mime = mimeForMedia(real);
  const kind = detectMediaKind(real);
  if (!mime || !kind) return fail(404, "不是音视频文件");
  let stat;
  try {
    stat = await fs.stat(real);
  } catch {
    return fail(404, "文件不存在或不可读");
  }
  if (!stat.isFile()) return fail(404, "不是文件");
  return {
    ok: true,
    file: {
      real,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ext: path.extname(real).slice(1).toLowerCase(),
      mime,
      kind,
      etag: buildMediaEtag(stat.size, stat.mtimeMs),
      lastModified: new Date(stat.mtimeMs).toUTCString(),
    },
  };
};

const jsonError = (message: string, status: number): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const baseHeaders = (file: LocalMediaFile): Record<string, string> => ({
  "Content-Type": file.mime,
  "Accept-Ranges": "bytes",
  "Cache-Control": "no-cache",
  ETag: file.etag,
  "Last-Modified": file.lastModified,
  "X-Content-Type-Options": "nosniff",
});

/** 读 [start, end]（闭区间）的字节流；客户端断开 / 取消时销毁底层文件流，避免拖进度时泄漏文件句柄 */
const streamBody = (
  file: LocalMediaFile,
  start: number,
  end: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> => {
  // 请求在我们 await realpath / stat 的间隙里已经被取消：根本不开文件，给一个已关闭的空流（没人会读）。
  // 不能「先创建再 destroy」：Readable.toWeb(已销毁的流) 返回的是已 cancel 的 stream，
  // `new Response(它)` 会抛 TypeError（Response body object should not be disturbed or locked）→ 路由 500
  if (signal?.aborted) {
    return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  }
  const node = createReadStream(file.real, { start, end, highWaterMark: 256 * 1024 });
  signal?.addEventListener("abort", () => node.destroy(), { once: true });
  // 流出错（文件被删 / 被截断）只终止这条响应，别抛成未处理异常
  node.on("error", () => node.destroy());
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
};

/**
 * 处理一次媒体请求（GET / HEAD 共用）。
 * 返回值总是 Response：成功 200 / 206 / 304，失败 400 / 404 / 416 的 JSON 错误。
 */
export const serveLocalMedia = async (req: Request): Promise<Response> => {
  const isHead = req.method === "HEAD";
  const raw = new URL(req.url).searchParams.get("path") ?? "";
  const resolved = await resolveLocalMediaFile(raw);
  if (!resolved.ok) return jsonError(resolved.error, resolved.status);
  const { file } = resolved;
  const headers = baseHeaders(file);

  // 条件请求：If-None-Match 命中 → 304（浏览器的 no-cache 重新验证走这条）
  if (ifNoneMatchHits(req.headers.get("if-none-match"), file.etag)) {
    return new Response(null, { status: 304, headers });
  }

  const rangeAllowed = ifRangeAllowsRange(
    req.headers.get("if-range"),
    file.etag,
    file.lastModified,
  );
  const range = rangeAllowed
    ? parseRangeHeader(req.headers.get("range"), file.size)
    : ({ kind: "none" } as const);

  if (range.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${file.size}` },
    });
  }

  if (range.kind === "range") {
    const length = range.end - range.start + 1;
    const partial = {
      ...headers,
      "Content-Range": `bytes ${range.start}-${range.end}/${file.size}`,
      "Content-Length": String(length),
    };
    if (isHead) return new Response(null, { status: 206, headers: partial });
    return new Response(streamBody(file, range.start, range.end, req.signal), {
      status: 206,
      headers: partial,
    });
  }

  const full = { ...headers, "Content-Length": String(file.size) };
  if (isHead || file.size === 0) return new Response(null, { status: 200, headers: full });
  return new Response(streamBody(file, 0, file.size - 1, req.signal), {
    status: 200,
    headers: full,
  });
};
