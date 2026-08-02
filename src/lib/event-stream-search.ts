/**
 * 事件流内联搜索（纯函数）
 *
 * 仅索引 UI 可高亮字段；tool_call/tool_result 在渲染管线中变为 ToolBlock、
 * 不索引 meta 路径/输出等无法在行内 mark 的字段。
 */

import { markdownToSearchableFields } from "@/lib/markdown-visible-search";
import { isEphemeralToolOutputDelta } from "@/lib/tool-display";
import {
  findOccurrencesInFields,
  type SearchOccurrence,
  type SearchableField,
} from "@/lib/text-search-highlight";
import type { TaskEvent } from "@/lib/types";

export const normalizeEventStreamSearchQuery = (query: string): string =>
  query.trim().toLowerCase();

/** 事件流搜索只覆盖 AI 最终回复；思考、工具过程、系统提示和用户输入均不索引。 */
const BODY_INDEX_KINDS = new Set<TaskEvent["kind"]>([
  "assistant_message",
]);

/** 事件流内走 MarkdownText 渲染、索引须用可见 markdown 分段 */
const MARKDOWN_BODY_KINDS = new Set<TaskEvent["kind"]>([
  "assistant_message",
]);

/** 单条事件的可搜索字段（顺序与 UI / occurrence 导航一致） */
export const extractSearchableFieldsFromEvent = (
  ev: TaskEvent,
): SearchableField[] => {
  if (isEphemeralToolOutputDelta(ev)) return [];
  if (!BODY_INDEX_KINDS.has(ev.kind)) return [];

  const t = ev.text?.trim();
  if (!t) return [];
  if (MARKDOWN_BODY_KINDS.has(ev.kind)) {
    return markdownToSearchableFields(t, ev.id, "body");
  }
  return [{ ownerId: ev.id, field: "body", text: t }];
};

/** 单条事件的可搜索文本（UI 可见口径；兼容旧测试） */
export const extractSearchableTextsFromEvent = (ev: TaskEvent): string[] => {
  if (isEphemeralToolOutputDelta(ev)) return [];
  if (!BODY_INDEX_KINDS.has(ev.kind)) return [];
  const t = ev.text?.trim();
  if (!t) return [];
  if (MARKDOWN_BODY_KINDS.has(ev.kind)) {
    return markdownToSearchableFields(t, ev.id, "body").map((f) => f.text);
  }
  return [t];
};

export interface EventStreamSearchExtra {
  id: string;
  texts: string[];
  /** 与 MarkdownText 渲染一致时用可见 markdown 分段索引 */
  markdown?: boolean;
}

/**
 * 事件流实际交给 Virtuoso 的渲染条目（保留结构最小集，避免搜索层依赖组件类型）。
 * 工作过程组已经完成 thinking 合并和工具配对，因此必须以这里的 id/text 建索引，
 * 不能再回到原始 task.events，否则会产生界面中不存在的 ownerId。
 */
export interface EventStreamSearchRenderItem {
  id: string;
  kind: string;
  text?: string;
  members?: readonly EventStreamSearchRenderItem[];
}

export const eventTextsMatchQuery = (
  texts: readonly string[],
  query: string,
): boolean => {
  const q = normalizeEventStreamSearchQuery(query);
  if (!q) return false;
  return texts.join("\n").toLowerCase().includes(q);
};

/** 按文本 occurrence 计数与导航（顺序 = 事件时间序 → 字段序） */
export const searchEventStreamOccurrences = (
  events: readonly TaskEvent[],
  query: string,
  extras: readonly EventStreamSearchExtra[] = [],
): SearchOccurrence[] => {
  const q = normalizeEventStreamSearchQuery(query);
  if (!q) return [];

  const fields: SearchableField[] = [];
  for (const ev of events) {
    fields.push(...extractSearchableFieldsFromEvent(ev));
  }
  for (const extra of extras) {
    extra.texts.forEach((text, i) => {
      const t = text.trim();
      if (!t) return;
      const field = `extra${i}`;
      if (extra.markdown) {
        fields.push(...markdownToSearchableFields(t, extra.id, field));
      } else {
        fields.push({ ownerId: extra.id, field, text: t });
      }
    });
  }
  return findOccurrencesInFields(fields, query);
};

/** 按 Virtuoso 实际渲染顺序和合并结果建立 occurrence。 */
export const searchEventStreamRenderOccurrences = (
  items: readonly EventStreamSearchRenderItem[],
  query: string,
): SearchOccurrence[] => {
  const q = normalizeEventStreamSearchQuery(query);
  if (!q) return [];

  const fields: SearchableField[] = [];
  const visit = (item: EventStreamSearchRenderItem): void => {
    if (item.kind === "__work_group__") {
      item.members?.forEach(visit);
      return;
    }
    if (item.kind === "__streaming__") {
      const text = item.text?.trim();
      if (text) {
        fields.push(...markdownToSearchableFields(text, item.id, "extra0"));
      }
      return;
    }
    if (item.kind === "__pending_local__") return;
    if (item.kind.startsWith("__")) return;
    fields.push(...extractSearchableFieldsFromEvent(item as TaskEvent));
  };

  items.forEach(visit);
  return findOccurrencesInFields(fields, query);
};

/** 命中事件 id 列表（顺序 = 事件时间序；保留供兼容测试） */
export const searchTaskEvents = (
  events: readonly TaskEvent[],
  query: string,
  extras: readonly EventStreamSearchExtra[] = [],
): string[] => {
  const q = normalizeEventStreamSearchQuery(query);
  if (!q) return [];

  const hits: string[] = [];
  for (const ev of events) {
    if (eventTextsMatchQuery(extractSearchableTextsFromEvent(ev), query)) {
      hits.push(ev.id);
    }
  }
  for (const extra of extras) {
    if (eventTextsMatchQuery(extra.texts, query)) {
      hits.push(extra.id);
    }
  }
  return hits;
};

/** 虚拟项 / 流式占位 → 在 items 数组中的下标 */
export const findRenderIndexForEventId = (
  items: ReadonlyArray<{
    id: string;
    kind: string;
    members?: ReadonlyArray<{ id: string }>;
  }>,
  eventId: string,
): number => {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.id === eventId) return i;
    if (it.kind === "__work_group__" && it.members?.some((m) => m.id === eventId)) {
      return i;
    }
  }
  return -1;
};

export const stepSearchHitIndex = (
  current: number,
  total: number,
  direction: "next" | "prev",
): number => {
  if (total <= 0) return -1;
  if (current < 0) return direction === "next" ? 0 : total - 1;
  if (direction === "next") return (current + 1) % total;
  return (current - 1 + total) % total;
};

/**
 * 新事件到达时保持当前选中 eventId（若仍命中），否则钳制下标。
 */
export const stabilizeSearchSelection = (
  prevEventId: string | null,
  hits: readonly string[],
  prevIndex: number,
): { index: number; eventId: string | null } => {
  if (hits.length === 0) return { index: -1, eventId: null };
  if (prevEventId) {
    const idx = hits.indexOf(prevEventId);
    if (idx >= 0) return { index: idx, eventId: prevEventId };
  }
  if (prevIndex >= 0 && prevIndex < hits.length) {
    return { index: prevIndex, eventId: hits[prevIndex] ?? null };
  }
  return { index: 0, eventId: hits[0] ?? null };
};

/** 行级高亮：当前命中 vs 其它可见命中 */
export const resolveSearchHighlightForItem = (
  item: { id: string; kind: string; members?: ReadonlyArray<{ id: string }> },
  hitIds: ReadonlySet<string>,
  currentHitId: string | null,
): { weak: boolean; current: boolean } => {
  if (!currentHitId && hitIds.size === 0) {
    return { weak: false, current: false };
  }

  const itemHitIds: string[] = [];
  if (hitIds.has(item.id)) itemHitIds.push(item.id);
  if (item.kind === "__work_group__") {
    for (const m of item.members ?? []) {
      if (hitIds.has(m.id)) itemHitIds.push(m.id);
    }
  }

  if (itemHitIds.length === 0) return { weak: false, current: false };

  const current = Boolean(
    currentHitId &&
      (item.id === currentHitId ||
        (item.kind === "__work_group__" &&
          item.members?.some((m) => m.id === currentHitId))),
  );

  return { weak: !current, current };
};
