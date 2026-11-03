/**
 * HTTP Range / 条件请求解析（`/api/local-media` 用；纯函数、不碰 fs）
 *
 * 浏览器的 <video> / <audio> 拖进度、边下边播全靠 `Range: bytes=…`。
 * 口径（RFC 9110 §14）：
 * - 只认 `bytes` 单位的**单段**范围；多段（`bytes=0-1,5-9`）当没带 Range，整段返回 200（规范允许，媒体元素从不发多段）
 * - 语法不对的 Range 头一律当没带（200 整段）；语法对但越界才 416
 * - `end` 超出文件末尾 → 截到最后一个字节；`bytes=-N`（尾部 N 字节）N 超过文件大小 → 整段
 */

export type ParsedRange =
  /** 没有（可用的）Range：整段 200 */
  | { kind: "none" }
  /** 语法合法但起点越界：416，响应头 Content-Range 的区间部分写星号、斜杠后接文件大小 */
  | { kind: "unsatisfiable" }
  /** 闭区间 [start, end]，都在 [0, size-1] 内 */
  | { kind: "range"; start: number; end: number };

const RANGE_RE = /^bytes=(\d*)-(\d*)$/i;

export const parseRangeHeader = (header: string | null | undefined, size: number): ParsedRange => {
  if (!header) return { kind: "none" };
  const text = header.trim();
  // 多段范围：当没带
  if (text.includes(",")) return { kind: "none" };
  const m = RANGE_RE.exec(text);
  if (!m) return { kind: "none" };
  const [, a = "", b = ""] = m;
  // `bytes=-` 两头都空：语法不对
  if (a === "" && b === "") return { kind: "none" };
  if (!Number.isSafeInteger(size) || size < 0) return { kind: "none" };

  // 尾部 N 字节
  if (a === "") {
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return { kind: "none" };
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - n);
    return { kind: "range", start, end: size - 1 };
  }

  const start = Number(a);
  if (!Number.isSafeInteger(start)) return { kind: "none" };
  if (start >= size) return { kind: "unsatisfiable" };
  if (b === "") return { kind: "range", start, end: size - 1 };
  const end = Number(b);
  if (!Number.isSafeInteger(end)) return { kind: "none" };
  // 起点大于终点：语法上不合法，按没带处理
  if (end < start) return { kind: "none" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
};

/** 强 ETag：`"<size>-<mtimeMs 取整>"`。If-Range 要求强校验器，所以不用弱标记 */
export const buildMediaEtag = (size: number, mtimeMs: number): string =>
  `"${size}-${Math.floor(mtimeMs)}"`;

/**
 * If-Range 校验：返回 true = 可以按 Range 返回 206；false = 资源已变，忽略 Range 整段返回 200。
 * 没带 If-Range → true。带的是 ETag（以 `"` 开头）→ 必须与当前强 ETag 完全一致；
 * 带的是 HTTP 日期 → 必须与 Last-Modified 完全一致（秒级）。弱 ETag（`W/`）在 If-Range 里无效 → false。
 */
export const ifRangeAllowsRange = (
  ifRange: string | null | undefined,
  etag: string,
  lastModified: string,
): boolean => {
  if (!ifRange) return true;
  const v = ifRange.trim();
  if (v.startsWith("W/")) return false;
  if (v.startsWith('"')) return v === etag;
  return v === lastModified;
};

/**
 * If-None-Match 是否命中当前 ETag（命中 → 304）。支持 `*`、逗号分隔多个、弱标记前缀。
 */
export const ifNoneMatchHits = (
  ifNoneMatch: string | null | undefined,
  etag: string,
): boolean => {
  if (!ifNoneMatch) return false;
  const v = ifNoneMatch.trim();
  if (v === "*") return true;
  return v.split(",").some((part) => part.trim().replace(/^W\//, "") === etag);
};
