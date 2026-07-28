/**
 * 「分享到需求群」客户端侧纯函数（单一来源）
 *
 * 出站正文的两种口径按 kind 分流：
 * - `artifact`（整份产物）→ **不截断**。卡片已经不渲染正文了（只留需求名 / action 标题 /
 *   链接按钮 / 署名），全文走紧跟其后的 md 文件消息，截断只会让人拿到半份产物。
 * - `message` / `question` → 截断 4000。这两种要塞进卡片 markdown，超长会撑爆卡片。
 *
 * 放 lib 不放 hook：单测（node 环境、只收 tests/**\/*.test.ts）能直接引，
 * 而且 artifact-panel 的「选中一段分享」和 hook 的出站处理共用同一份口径。
 */

import type { ShareToGroupInput, ShareToGroupKind } from "@/lib/task-store";

/** 进卡片的正文上限：防超长消息撑爆飞书卡片 markdown */
export const SHARE_TO_GROUP_CONTENT_MAX = 4000;

/** 截断进卡片的正文（尾加省略号，方便人眼看出被截） */
export const truncateShareContent = (text: string): string => {
  if (text.length <= SHARE_TO_GROUP_CONTENT_MAX) return text;
  return `${text.slice(0, SHARE_TO_GROUP_CONTENT_MAX)}…`;
};

/** 出站前按 kind 决定截不截断（见文件头） */
export const prepareShareContent = (
  kind: ShareToGroupKind,
  content: string,
): string => (kind === "artifact" ? content : truncateShareContent(content));

/**
 * 「选中产物里的一段 → 分享这段」的请求载荷。
 *
 * kind 走 `message` 而不是 `artifact`：选中段是用户挑出来给人看的原文、本就短，
 * 直接进卡片正文即可，不该再发一个 md 文件。选区为空返 null（调用方跳过发送）。
 */
export const buildSelectionShareInput = (
  selection: string,
  title?: string,
): ShareToGroupInput | null => {
  const text = selection.trim();
  if (!text) return null;
  const trimmedTitle = title?.trim();
  return {
    kind: "message",
    ...(trimmedTitle ? { title: trimmedTitle } : {}),
    content: truncateShareContent(text),
  };
};
