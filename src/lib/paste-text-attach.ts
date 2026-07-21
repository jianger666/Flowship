/**
 * 粘贴超长文本 → 附件 pill（Cursor 同款）
 *
 * 阈值抽到 lib：Composer 拦截 + 单测共用同一判定，避免 hook / 组件里各写一份漂移。
 */

/** 字符数阈值：超过则转附件（含等于边界的下一字符） */
export const PASTE_TEXT_CHAR_THRESHOLD = 2000;
/** 行数阈值：超过则转附件 */
export const PASTE_TEXT_LINE_THRESHOLD = 24;
/** 服务端单次粘贴内容上限（UTF-8 字节） */
export const PASTE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 粘贴纯文本是否应拦截默认插入、改走附件流程。
 * 空串不转（调用方应先过滤）；字符或行数任一超阈即转。
 */
export const shouldConvertPasteToAttachment = (text: string): boolean => {
  if (!text) return false;
  if (text.length > PASTE_TEXT_CHAR_THRESHOLD) return true;
  // split('\n')：单行无换行 → length 1；N 个换行 → N+1 行
  const lines = text.split("\n").length;
  return lines > PASTE_TEXT_LINE_THRESHOLD;
};
