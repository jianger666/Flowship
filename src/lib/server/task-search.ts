/**
 * 任务全文检索（纯逻辑）
 *
 * 扫 listTasks 摘要：标题命中优先；未命中标题再流式扫 events.jsonl
 * 里 user_reply / assistant_message 的 text，取首个命中片段做摘要。
 * 个人规模任务量（几十~几百）直接读文件即可，不引搜索引擎。
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { listTasks } from "@/lib/server/task-fs";
import { getEventsLogPath } from "@/lib/server/task-fs-core";
import type { TaskMode } from "@/lib/types";

/** 单条搜索结果（API / UI 共用） */
export interface TaskSearchResult {
  taskId: string;
  title: string;
  mode: TaskMode;
  /** 内容命中时的摘要（标题命中可无） */
  snippet?: string;
  matchedIn: "title" | "content";
  /** 排序用时间戳（任务 updatedAt） */
  ts: number;
}

/** 可注入依赖（单测用 tmp 目录 / mock，生产走默认 listTasks + events 路径） */
export interface TaskSearchDeps {
  listSummaries: () => Promise<
    Array<{ id: string; title: string; mode?: TaskMode; updatedAt: number }>
  >;
  getEventsPath: (taskId: string) => string;
}

const DEFAULT_LIMIT = 30;
/** 命中词前后各保留的大致字数 */
const SNIPPET_RADIUS = 40;

/** 内容检索关心的事件 kind */
const CONTENT_KINDS = new Set(["user_reply", "assistant_message"]);

const defaultDeps = (): TaskSearchDeps => ({
  listSummaries: async () => {
    const tasks = await listTasks();
    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      mode: t.mode,
      updatedAt: t.updatedAt,
    }));
  },
  getEventsPath: getEventsLogPath,
});

/**
 * 大小写不敏感子串匹配；needle 空则永不命中（调用方应先 trim）。
 */
export const includesIgnoreCase = (haystack: string, needle: string): boolean => {
  if (!needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
};

/**
 * 从正文截取命中摘要：命中词前后各 ~radius 字，超出加省略号。
 * 找不到命中（理论上不应发生）则截前 2*radius 字。
 */
export const buildSnippet = (
  text: string,
  query: string,
  radius = SNIPPET_RADIUS,
): string => {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx < 0) {
    const cut = text.slice(0, radius * 2);
    return cut.length < text.length ? `${cut}…` : cut;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
};

/**
 * 流式读 events.jsonl，遇到首个 user_reply / assistant_message 正文命中即停。
 * 文件不存在 / 读失败 → null（该任务无内容命中）。
 */
export const findFirstContentMatch = async (
  eventsPath: string,
  query: string,
): Promise<string | null> => {
  let stream: ReturnType<typeof createReadStream> | undefined;
  try {
    stream = createReadStream(eventsPath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const ev = parsed as { kind?: unknown; text?: unknown };
      if (typeof ev.kind !== "string" || !CONTENT_KINDS.has(ev.kind)) continue;
      if (typeof ev.text !== "string" || !ev.text) continue;
      if (includesIgnoreCase(ev.text, query)) {
        rl.close();
        stream.destroy();
        return buildSnippet(ev.text, query);
      }
    }
    return null;
  } catch {
    // ENOENT 等：无 events 文件或不可读 → 当无内容命中
    stream?.destroy();
    return null;
  }
};

/**
 * 全文检索入口。
 * q 空/全空白 → []；标题命中优先于内容命中，同组内按 updatedAt 倒序；上限 30。
 */
export const searchTasks = async (
  q: string,
  deps: TaskSearchDeps = defaultDeps(),
  limit = DEFAULT_LIMIT,
): Promise<TaskSearchResult[]> => {
  const query = q.trim();
  if (!query) return [];

  const summaries = await deps.listSummaries();
  const titleHits: TaskSearchResult[] = [];
  const contentHits: TaskSearchResult[] = [];

  for (const t of summaries) {
    const title = t.title ?? "";
    const mode: TaskMode = t.mode === "chat" ? "chat" : "task";
    const ts = t.updatedAt;

    if (includesIgnoreCase(title, query)) {
      titleHits.push({
        taskId: t.id,
        title,
        mode,
        matchedIn: "title",
        ts,
      });
      continue;
    }

    const snippet = await findFirstContentMatch(
      deps.getEventsPath(t.id),
      query,
    );
    if (snippet != null) {
      contentHits.push({
        taskId: t.id,
        title,
        mode,
        snippet,
        matchedIn: "content",
        ts,
      });
    }
  }

  const byMtimeDesc = (a: TaskSearchResult, b: TaskSearchResult) =>
    b.ts - a.ts;

  titleHits.sort(byMtimeDesc);
  contentHits.sort(byMtimeDesc);

  return [...titleHits, ...contentHits].slice(0, limit);
};
