/**
 * chat 任务正文搜索（侧栏 P2）
 *
 * 简单 grep 式：扫各 chat task 的 events.jsonl 里 user_reply / assistant_message 的 text，
 * 命中则返回 taskId + 摘要片段。不引 FTS——对话量级本地足够。
 *
 * 约束：
 * - 只扫 mode=chat（task 列表不走正文搜）
 * - 单文件最多读末尾 MAX_BYTES（大日志不拖垮）
 * - 并发上限 CONCURRENCY，避免 N 开文件打爆
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildSearchSnippet,
  type ContentSearchHit,
} from "@/lib/sidebar-groups";
import { EVENTS_FILE, taskDir } from "@/lib/server/task-fs-core";
import { listTasks } from "@/lib/server/task-fs";
import type { TaskEvent } from "@/lib/types";

/** 单文件最多从尾部读这么多字节（约够近期对话） */
const MAX_BYTES = 512 * 1024;
/** 同时打开的 events 文件数 */
const CONCURRENCY = 4;
/** 反向读块大小 */
const CHUNK = 64 * 1024;

const SEARCHABLE_KINDS = new Set(["user_reply", "assistant_message"]);

const parseLine = (raw: string): TaskEvent | null => {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as TaskEvent;
  } catch {
    return null;
  }
};

/**
 * 从文件尾读最多 maxBytes，按行解析；命中 user_reply / assistant_message 即返 snippet。
 * 优先返回较新命中（从尾往头扫到的第一条）。
 */
export const searchTaskEventsFile = async (
  eventsPath: string,
  query: string,
): Promise<string | null> => {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;

  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(eventsPath, "r");
  } catch {
    return null;
  }

  try {
    const { size } = await fh.stat();
    if (size === 0) return null;

    const readFrom = Math.max(0, size - MAX_BYTES);
    let pos = size;
    let carry = Buffer.alloc(0);
    // 从尾部收集行（文本），遇到命中立刻返回
    while (pos > readFrom) {
      const toRead = Math.min(CHUNK, pos - readFrom);
      pos -= toRead;
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, pos);
      const data = Buffer.concat([buf.subarray(0, bytesRead), carry]);

      const linesFromRight: Buffer[] = [];
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        linesFromRight.push(data.subarray(i + 1, end));
        end = i;
      }
      if (pos > readFrom) {
        carry = data.subarray(0, end);
      } else {
        carry = Buffer.alloc(0);
        if (end > 0) linesFromRight.push(data.subarray(0, end));
      }

      for (const lineBuf of linesFromRight) {
        let s = lineBuf;
        if (s.length > 0 && s[s.length - 1] === 0x0d) {
          s = s.subarray(0, s.length - 1);
        }
        const ev = parseLine(s.toString("utf-8"));
        if (!ev || !SEARCHABLE_KINDS.has(ev.kind)) continue;
        const body = typeof ev.text === "string" ? ev.text : "";
        if (!body.toLowerCase().includes(q)) continue;
        return buildSearchSnippet(body, query);
      }
    }
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
};

/** 有界并发 map */
const mapPool = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

/**
 * 在所有 chat 任务里搜正文；返回命中列表（保持 listTasks 顺序中的相对序、仅含命中）。
 */
export const searchChatTaskContents = async (
  query: string,
): Promise<ContentSearchHit[]> => {
  const q = query.trim();
  if (q.length < 2) return [];

  const tasks = await listTasks();
  const chats = tasks.filter((t) => t.mode === "chat");

  const scanned = await mapPool(chats, CONCURRENCY, async (task) => {
    const eventsPath = path.join(taskDir(task.id), EVENTS_FILE);
    const snippet = await searchTaskEventsFile(eventsPath, q);
    if (!snippet) return null;
    return { taskId: task.id, snippet } satisfies ContentSearchHit;
  });

  return scanned.filter((x): x is ContentSearchHit => x !== null);
};
