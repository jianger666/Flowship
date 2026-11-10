/**
 * 把一张图当成「粘贴」送进当前输入框的附件区（仅浏览器端）
 *
 * 为什么用合成 paste 事件、而不是新开一条桥：输入框的图片附件状态（useImageAttach）住在编辑器内部，
 * 外部拿不到 addFiles；而编辑器已经有现成的「粘贴图片」入口（composer-editor 的 PasteImagePlugin：
 * PASTE_COMMAND 里见到 image/* 文件就走 attach.onPaste）。往编辑器派发一个带图片的 paste 事件，
 * 走的就是用户亲手粘贴截图的同一条路径——mime 白名单 / 大小 / 张数上限 / 去重 / 切页快照一个不少，
 * 也不用去改 event-stream / task-talk-composer 这两个大文件。
 */

import { parseImageDataUrl } from "./pick-compose";

/** 找到要接收图片的输入框编辑器：优先当前焦点所在的（insertIntoComposer 刚把焦点给了它），否则取第一个可见的 */
export const findComposerEditor = (doc: Document): HTMLElement | null => {
  const active = doc.activeElement;
  if (
    active instanceof HTMLElement &&
    active.getAttribute("data-lexical-editor") === "true" &&
    active.isContentEditable
  ) {
    return active;
  }
  const all = doc.querySelectorAll<HTMLElement>('[data-lexical-editor="true"]');
  for (const el of all) {
    if (el.isContentEditable && el.getClientRects().length > 0) return el;
  }
  return null;
};

/**
 * 派发「粘贴图片」；返回是否真的派发出去了（没找到输入框 / dataURL 不合法 / 环境不支持 = false）。
 * 注意：是否被附件区接收（比如已满 6 张）由输入框自己 toast，这里无从得知。
 */
export const pasteImageIntoComposer = (dataUrl: string, filename = "picked-element.jpg"): boolean => {
  if (typeof document === "undefined") return false;
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return false;
  const editor = findComposerEditor(document);
  if (!editor) return false;
  try {
    const bin = atob(parsed.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], filename, { type: parsed.mimeType });
    const dt = new DataTransfer();
    dt.items.add(file);
    const event = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);
    return true;
  } catch {
    return false;
  }
};
