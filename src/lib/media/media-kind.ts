/**
 * 音视频文件类型（客户端 / server 共用的单一来源）
 *
 * 为什么单独一个文件：`/api/local-media` 的扩展名白名单、播放器的「这是视频还是音频」、
 * 路径链接要不要变成播放入口、消息末尾的媒体条，都要同一套判定，散着写必漂移。
 *
 * 白名单只放浏览器内核（Chromium / Electron）原生能播的容器，不含 mkv / avi / wmv 这类
 * 要转码才能播的——它们落到「系统播放器打开」兜底。`ts` 故意不收：与 TypeScript 源码撞扩展名。
 */

export type MediaKind = "video" | "audio";

/** 视频容器扩展名（小写、不带点） */
export const VIDEO_EXTS = ["mp4", "m4v", "mov", "webm"] as const;
/** 音频容器扩展名（小写、不带点） */
export const AUDIO_EXTS = ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"] as const;

const VIDEO_SET: ReadonlySet<string> = new Set(VIDEO_EXTS);
const AUDIO_SET: ReadonlySet<string> = new Set(AUDIO_EXTS);

/** 扩展名 → Content-Type */
export const MEDIA_MIME: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  // .opus 文件是 Ogg 封装的 Opus
  opus: "audio/ogg",
};

/**
 * 取扩展名（小写、不带点）。只看最后一段文件名（目录名里的点不算）；
 * 兼容 `/` 与 `\` 分隔符；没有扩展名返回空串。
 */
export const mediaExtOf = (pathOrExt: string): string => {
  const raw = pathOrExt.trim();
  if (!raw) return "";
  const sep = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  const base = sep >= 0 ? raw.slice(sep + 1) : raw;
  const dot = base.lastIndexOf(".");
  // 裸扩展名（"mp4" / ".mp4"）：没有分隔符也没有点、或点在开头
  if (dot < 0) return sep < 0 ? base.toLowerCase() : "";
  return base.slice(dot + 1).toLowerCase();
};

/** 路径（或裸扩展名）→ 媒体类型；不是音视频 → null */
export const detectMediaKind = (pathOrExt: string): MediaKind | null => {
  const ext = mediaExtOf(pathOrExt);
  if (!ext) return null;
  if (VIDEO_SET.has(ext)) return "video";
  if (AUDIO_SET.has(ext)) return "audio";
  return null;
};

export const isMediaPath = (pathOrExt: string): boolean =>
  detectMediaKind(pathOrExt) !== null;

/** 路径（或裸扩展名）→ Content-Type；不在白名单 → null */
export const mimeForMedia = (pathOrExt: string): string | null => {
  const ext = mediaExtOf(pathOrExt);
  if (!detectMediaKind(ext)) return null;
  return MEDIA_MIME[ext] ?? null;
};

/** 字幕 sidecar 扩展名（只认这两种，srt 在 server 侧转成 WebVTT） */
export const SUBTITLE_EXTS = ["srt", "vtt"] as const;

export const isSubtitlePath = (pathOrExt: string): boolean =>
  (SUBTITLE_EXTS as readonly string[]).includes(mediaExtOf(pathOrExt));
