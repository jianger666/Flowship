/**
 * 用户在内置浏览器里的操作 → 给 AI 的文字摘要。
 *
 * 两条送达路径共用这里的拉取与格式化：
 * - 路径 1：browser_* 工具返回时附带（tools.ts，抬头 `[用户刚才的操作]`）；
 * - 路径 2：用户发消息时，server 拼给 AI 的那条消息尾部附一段（本文件的 {@link buildBrowserActivityNote}，
 *   抬头 `[浏览器·用户刚才的操作]`，接线点见 chat-inject / task-question-inject）。
 *
 * 先 `status` 看 `pendingCount`，有未送达的才调 `user_activity {markSeen:true}`——大多数时候用户根本没碰浏览器，
 * 这条路必须便宜：bridge 不可用时第一行就返回 null，零开销、不报错。
 *
 * 摘要里的文字（按钮名 / 输入框标签 / 页面标题）来自网页，**不是可信文本**，一律经 content.ts 包装。
 */

import { getBrowserBridge, isBrowserBridgeAvailable } from "./bridge";
import { ToolResultBuilder, wrapUntrustedInline } from "./content";
import type {
  BrowserActivityEntry,
  BrowserStatusResult,
  BrowserUserActivityResult,
} from "./types";

/** 摘要里最多列多少条（更早的折叠成一句）；主进程环形缓冲 500、单次 limit 100，这里再收一道保 prompt 体积 */
export const ACTIVITY_NOTE_MAX_ENTRIES = 30;

const NOTE_HEADER_MESSAGE = "[浏览器·用户刚才的操作]";
export const TOOL_ACTIVITY_HEADER = "[用户刚才的操作]";

export interface PendingUserActivity {
  entries: BrowserActivityEntry[];
  title: string | null;
  url: string | null;
}

/**
 * 拉取未送达的用户操作（会推进「已送达」游标）。没有 / 不可用 / 任何失败 → null。
 * 只保留 actor 为 user / system 的条目（AI 自己的动作 AI 本来就知道）。
 */
export const fetchPendingUserActivity = async (
  taskId: string,
): Promise<PendingUserActivity | null> => {
  if (!taskId || !isBrowserBridgeAvailable()) return null;
  const bridge = getBrowserBridge();
  if (!bridge) return null;
  try {
    const status = (await bridge.request(taskId, "status", {}, { timeoutMs: 3000 })) as
      | BrowserStatusResult
      | undefined;
    if (!status || status.exists !== true || !((status.pendingCount ?? 0) > 0)) return null;
    const act = (await bridge.request(
      taskId,
      "user_activity",
      { markSeen: true, limit: 100 },
      { timeoutMs: 5000 },
    )) as BrowserUserActivityResult | undefined;
    const entries = (act?.entries ?? []).filter((e) => e.actor === "user" || e.actor === "system");
    if (entries.length === 0) return null;
    return { entries, title: status.title ?? null, url: status.url ?? null };
  } catch (err) {
    // 附带摘要是锦上添花：任何失败都不能影响主流程（用户发消息 / 工具返回）
    console.warn(
      `[browser-activity] 拉取用户操作失败（忽略）task=${taskId}：`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};

/** 条目 → 「时间 摘要」行。时间只到分钟之内的相对顺序没意义，直接按序号列、不带时间戳省 token */
const entryLines = (entries: BrowserActivityEntry[]): string => {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const omitted = Math.max(0, sorted.length - ACTIVITY_NOTE_MAX_ENTRIES);
  const shown = omitted > 0 ? sorted.slice(-ACTIVITY_NOTE_MAX_ENTRIES) : sorted;
  const lines = shown.map((e) => `- ${e.summary}`);
  if (omitted > 0) lines.unshift(`…（更早的 ${omitted} 条已省略）`);
  return lines.join("\n");
};

/**
 * 把一批用户操作追加进一个结果拼装器（工具返回里附带时用：和工具自己的页面内容共用一次「不可信」提醒）。
 * @param header 抬头（工具附带 / 用户消息附带 / 交还各用各的）
 * @param page 当前页面（可选）：标题与 URL 都是页面可控的，包装后附在末尾
 */
export const appendUserActivity = (
  b: ToolResultBuilder,
  entries: BrowserActivityEntry[],
  opts: {
    header: string;
    page?: { title?: string | null; url?: string | null };
    /** 末尾提示（默认提示可以用 browser_snapshot 看当前页面） */
    hint?: string;
  },
): void => {
  b.trusted(opts.header);
  b.untrusted(entryLines(entries), { url: opts.page?.url ?? undefined });
  const hint = opts.hint ?? "（需要时调用 browser_snapshot 查看）";
  if (opts.page && (opts.page.title || opts.page.url)) {
    const pageText = `${opts.page.title || "（无标题）"} | ${opts.page.url ?? ""}`.slice(0, 400);
    b.trusted(`当前页面：${wrapUntrustedInline(pageText)}${hint}`).markUntrusted();
  } else {
    b.trusted(hint);
  }
};

/** 独立成一段文字（用户消息尾部 / 交还消息用） */
export const formatUserActivity = (
  entries: BrowserActivityEntry[],
  opts: Parameters<typeof appendUserActivity>[2],
): string => {
  const b = new ToolResultBuilder();
  appendUserActivity(b, entries, opts);
  return b.build();
};

/**
 * 用户发消息时附在 AI 消息尾部的摘要。无未送达操作 / bridge 不可用 → null。
 * 只附摘要 + 当前页面标题 / URL，**不附整页快照**。
 */
export const buildBrowserActivityNote = async (taskId: string): Promise<string | null> => {
  const pending = await fetchPendingUserActivity(taskId);
  if (!pending) return null;
  return formatUserActivity(pending.entries, {
    header: NOTE_HEADER_MESSAGE,
    page: { title: pending.title, url: pending.url },
  });
};

/**
 * 哪些 user_reply 来源可以附浏览器摘要：只有「用户本人」从 app 输入条 / 飞书私聊发的话（无 source 与 feishu）。
 * 群里别人的话（feishu_group）、定时到点（schedule）、交还消息本身（browser，已自带摘要）都不附——
 * 附了等于把属主的浏览器操作细节喂给陌生人触发的那一轮，或者重复送达。
 */
export const shouldAttachBrowserNote = (meta: Record<string, unknown> | undefined): boolean => {
  const source = meta?.source;
  return source === undefined || source === "feishu";
};

/** 给「交还」用：把 note + 摘要拼成一整段（handback.ts 用） */
export const wrapActivityEntriesForHandback = (
  entries: BrowserActivityEntry[],
  page?: { title?: string | null; url?: string | null },
): string =>
  formatUserActivity(entries, {
    header: "[浏览器·用户交还了操作权] 用户刚才在浏览器里做了：",
    page,
  });
