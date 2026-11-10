/**
 * 工具结果里的图片块（截图 base64，常见 100KB~1.5MB）→ 占位文字。
 *
 * 为什么需要：模型要看到图，所以 `browser_screenshot` 的结果里带完整 `{type:"image", data}`；但同一份结果对象还会
 * 流进「落事件 / 推 UI」那条链（`extractToolOutputText` → `stringifyMeta` 兜底 JSON.stringify 整个结果），
 * 不处理的话每张截图会被整段 base64 写进 events.jsonl、tool-outputs/ 全量文件、再经 SSE 推给前端。
 * 事件流里不需要像素，留一句「[图片 image/jpeg · 123KB 已省略]」就够了。
 *
 * 写成写时复制（没有图片块时原样返回同一个引用）：调用方多半把返回值当「原对象」比较 / 缓存。
 * 识别口径刻意宽：pi 形态 `{type:"image", data, mimeType}`、MCP / Cursor 形态里嵌套的
 * `{ data, mimeType:"image/…" }`（data 可能是 base64 字符串，也可能是 Uint8Array）。
 */

/** 小于它的 data 不当截图处理（图标 / 误判风险；占位文字比它还长就没意义了） */
const MIN_IMAGE_DATA_CHARS = 2048;
const MAX_DEPTH = 8;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const dataSize = (data: unknown): number => {
  if (typeof data === "string") return data.length;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
};

const isImageBlock = (v: Record<string, unknown>): boolean => {
  const mime = typeof v.mimeType === "string" ? v.mimeType : typeof v.mime_type === "string" ? v.mime_type : "";
  const looksImage = v.type === "image" || mime.startsWith("image/");
  return looksImage && dataSize(v.data) >= MIN_IMAGE_DATA_CHARS;
};

const placeholderOf = (v: Record<string, unknown>): string => {
  const mime = typeof v.mimeType === "string" ? v.mimeType : typeof v.mime_type === "string" ? v.mime_type : "image";
  const raw = dataSize(v.data);
  // base64 字符串按 3/4 估原始字节；二进制就是它自己
  const bytes = typeof v.data === "string" ? Math.floor((raw * 3) / 4) : raw;
  return `[图片 ${mime} · ${Math.max(1, Math.round(bytes / 1024))}KB 已省略]`;
};

/** 递归把图片块换成 `{type:"text", text:"[图片 … 已省略]"}`；没有图片块时返回原引用 */
export const stripImageBlocks = <T>(value: T, depth = 0): T => {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = stripImageBlocks(item, depth + 1);
      if (r !== item) changed = true;
      return r;
    });
    return (changed ? next : value) as T;
  }
  if (!isRecord(value)) return value;
  if (isImageBlock(value)) {
    return { type: "text", text: placeholderOf(value) } as unknown as T;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const r = stripImageBlocks(v, depth + 1);
    if (r !== v) changed = true;
    out[k] = r;
  }
  return (changed ? out : value) as T;
};
