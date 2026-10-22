/**
 * 「排队消息未送达」事件的构造（纯函数，D8-04）。
 *
 * 排队的话被服务端丢掉时（重放失败 / 过期 / 用户点停止清队），要往事件流落一条 info：
 * 正文是一行 header + 每条的 80 字摘要（不渲染卡片的地方 / 搜索 / 老前端仍看得到去向），
 * 完整原文放在 `meta.droppedTexts`——前端 `DroppedQueueCard`（chat / log 两形态共用）按它画
 * 「排队消息未送达」卡：完整展示 + 复制（chat 另有「放回输入框」）。
 *
 * 与 chat-runner.noticeQueuedItemsDropped 同口径（摘要 80 字 / 最多列 5 条 / meta 单条 ≤ 2000 字、
 * `droppedItemIds` 与 `droppedTexts` 下标一一对应）。纯图片 / 文件的排队条（没有文字）与带附件的条用 `droppedAttachments`
 * 文字占位列在卡里（Q6-04：以前这类条被丢后卡里只有一行、看不出丢了什么）。chat 那份写在 chat-runner 里、本模块是 task 侧
 * （task-talk-queue）用的同款，改一边请同步另一边。
 *
 * 脱敏**不在这里**：调用方必须在截断之前、对完整文本先过 redactSecretsInText——
 * 落盘前全局那道脱敏按「完整的精确值」匹配，先截断再脱敏的话凭据一旦横跨截断点就只剩半截前缀，
 * 精确匹配命不中、前缀原样写进 events.jsonl。
 */

/** 提示正文里每条消息的摘要上限（字符） */
export const DROPPED_NOTICE_SNIPPET_MAX = 80;
/** 提示正文里最多列几条 */
export const DROPPED_NOTICE_LIST_MAX = 5;
/** meta.droppedTexts 里单条完整文本的上限（字符）——只存文本，附件 / 图片绝不放进来 */
export const DROPPED_META_TEXT_MAX = 2000;

/**
 * `attachments` 是这条排队消息带的图片 / 文件的**文字占位**（如「2 张图片」「1 张图片、1 个文件」，
 * 见 {@link describeDroppedAttachments}）——图片 / 文件本体绝不进事件（Q6-04）。没有附件就不传。
 */
export type DroppedNoticeItem = { itemId: string; text: string; attachments?: string };

export type DroppedNoticeMeta = {
  droppedItemIds: string[];
  droppedTexts: string[];
  /**
   * 带图片 / 文件的排队条的占位说明（每条一句，如「一条只有 2 张图片、没有文字」「第 1 条附带 1 个文件」）。
   * 图片 / 文件放不回输入框，卡片只把它们列出来提醒用户重新添加；只在确有附件条时才有这个字段。
   */
  droppedAttachments?: string[];
};

/** 图片 / 文件数 → 占位文字；都是 0 返回 ""（调用方据此判断「没有附件」） */
export const describeDroppedAttachments = (images: number, files: number): string => {
  const parts: string[] = [];
  if (images > 0) parts.push(`${images} 张图片`);
  if (files > 0) parts.push(`${files} 个文件`);
  return parts.join("、");
};

/**
 * 取出 `meta.droppedAttachments`（落盘数据不可全信：非字符串 / 纯空白的脏项丢掉）。
 * 前端「未送达」卡据此列出被丢的图片 / 文件条（Q6-04）。
 */
export const extractDroppedAttachments = (
  meta: Record<string, unknown> | null | undefined,
): string[] => {
  const raw = meta?.droppedAttachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
};

/** 按码点截断（不劈开 emoji 的代理对），超长补省略号 */
const truncateChars = (s: string, max: number): string => {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
};

/**
 * @param header 首行（卡片标题就是它去掉尾部冒号后的样子），如「已停止，2 条排队消息未送达、请重新发送」
 * @param count 被丢的总条数（含拿不到文本、也没附件的条——如已出队的 in-flight 条）
 * @param items 其中有文本或有附件的条（文本需已脱敏）；既无文本也无附件的条被忽略
 * @returns 没有任何有文本 / 附件的条时不带 meta（不画空卡，退回单行 info）
 */
export const buildDroppedQueueNotice = (args: {
  header: string;
  count: number;
  items: readonly DroppedNoticeItem[];
}): { text: string; meta?: DroppedNoticeMeta } => {
  const hasText = (it: DroppedNoticeItem): boolean => it.text.trim().length > 0;
  const attachmentOf = (it: DroppedNoticeItem): string => (it.attachments ?? "").trim();
  const items = args.items.filter((it) => hasText(it) || attachmentOf(it).length > 0);
  if (items.length === 0) return { text: args.header };

  const listed = items.slice(0, DROPPED_NOTICE_LIST_MAX);
  const lines = listed.map((it) => {
    const snippet = truncateChars(
      it.text.replace(/\s+/g, " ").trim(),
      DROPPED_NOTICE_SNIPPET_MAX,
    );
    const att = attachmentOf(it);
    if (hasText(it)) return `- ${snippet}${att ? `（附 ${att}）` : ""}`;
    return `- （只有 ${att}，没有文字）`;
  });
  let text = `${args.header}：\n${lines.join("\n")}`;
  if (args.count > listed.length) text += `\n…等 ${args.count} 条`;

  const textItems = items.filter(hasText);
  // 附件说明里的「第 N 条」指卡片里第 N 块原文（与 droppedTexts 下标一致）
  const attachmentNotes: string[] = [];
  for (const it of items) {
    const att = attachmentOf(it);
    if (!att) continue;
    attachmentNotes.push(
      hasText(it)
        ? `第 ${textItems.indexOf(it) + 1} 条附带 ${att}`
        : `一条只有 ${att}、没有文字`,
    );
  }

  return {
    text,
    meta: {
      droppedItemIds: textItems.map((it) => it.itemId),
      droppedTexts: textItems.map((it) => truncateChars(it.text, DROPPED_META_TEXT_MAX)),
      ...(attachmentNotes.length > 0 ? { droppedAttachments: attachmentNotes } : {}),
    },
  };
};
