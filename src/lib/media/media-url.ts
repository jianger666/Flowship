/**
 * 播放器要用的 URL 拼装（客户端）。路径一律 encodeURIComponent：中文 / 空格 / `#`（文件名里也可能有）都安全。
 * `v` 是版本戳（取自 ETag）：文件被覆盖重渲后换一个 URL，浏览器不会拿旧缓存冒充新文件；服务端不读它。
 */

export const localMediaUrl = (absolutePath: string, version?: string): string =>
  `/api/local-media?path=${encodeURIComponent(absolutePath)}${
    version ? `&v=${encodeURIComponent(version)}` : ""
  }`;

export const localMediaSubtitlesUrl = (mediaPath: string): string =>
  `/api/local-media/subtitles?path=${encodeURIComponent(mediaPath)}`;

export const localMediaSubtitleUrl = (subtitlePath: string): string =>
  `/api/local-media/subtitle?path=${encodeURIComponent(subtitlePath)}`;
