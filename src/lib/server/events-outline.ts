/**
 * events.jsonl → 提问时间线大纲（`GET /api/tasks/:id/outline` 的数据源）。
 *
 * 只挑 user_reply / action_start（口径见 `lib/stream-outline.toOutlineItem`），整文件**顺序**扫一遍、
 * 不整份 parse：每行先用字节子串过一遍（`"kind":"user_reply"` / `"kind":"action_start"`，事件行是
 * `JSON.stringify` 写的、键值之间没有空格），命中才 parse——绝大多数行（thinking / tool_result 大行）
 * 只是 `Buffer.includes`。
 *
 * ## 增量缓存
 * 长会话的 events.jsonl 可以是几十 MB，每次打开 / 每次回退都全量扫太浪费。按 taskId 缓存「已扫到的字节偏移 +
 * 已挑出的项」，下次只扫新追加的部分。缓存只是**提示**、用之前必校验：
 *  - inode 没变（回退走 tmp + rename 整文件替换 → 新 inode，缓存作废）；
 *  - 文件没缩短（size ≥ 已扫偏移）；
 *  - 文件头 64 字节、偏移前 64 字节都与缓存时一致（inode 不可靠的平台——Windows 上 ino 可能恒为 0——的兜底；
 *    头尾各取一段：回退保留的头部相同但尾部必然换了内容，原地改写开头则头部对不上）。
 * 任何一条不满足就从头扫。只认**完整行**（以 \n 结尾）：半行（正在追加 / 崩溃残留）留给下一次。
 *
 * 回退与追加的互斥不在这里管：这里只读，读到的要么是回退前的旧文件、要么是回退后的新文件
 * （rename 原子），都是自洽的快照；回退由前端另行裁掉（`mergeOutline(rewindFromEventId)`）。
 */

import { promises as fs } from "node:fs";

import {
  OUTLINE_MAX_ITEMS,
  toOutlineItem,
  type OutlineItem,
} from "@/lib/stream-outline";
import { getEventsLogPath, parseEventLineBuf } from "./task-fs-core";

const SCAN_CHUNK = 1024 * 1024;
const FINGERPRINT_BYTES = 64;
/**
 * 缓存里最多留多少项：接口永远只回最新的 OUTLINE_MAX_ITEMS 项，`truncated` 只需要知道「是否多于它」，
 * 所以多留 1 项就够判断（再多只是白占内存：32 个任务 × 每项约 350B，留 2 万项最坏近 200MB；本项目有 OOM 历史）。
 */
const MAX_CACHED_ITEMS = OUTLINE_MAX_ITEMS + 1;
const CACHE_MAX_TASKS = 32;

const KIND_USER = Buffer.from('"kind":"user_reply"');
const KIND_ACTION = Buffer.from('"kind":"action_start"');

interface CacheEntry {
  ino: number;
  /** 已处理到的字节偏移（= 最后一个完整行的行尾 + 1） */
  offset: number;
  /** 文件开头最多 64 字节 */
  head: Buffer;
  /** offset 之前最多 64 字节，校验已扫部分没被改写 */
  fingerprint: Buffer;
  items: OutlineItem[];
  /** 缓存里丢过最老的项 */
  trimmed: boolean;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<OutlineResult>>();

export interface OutlineResult {
  items: OutlineItem[];
  /** 还有更早的没带上（超过 OUTLINE_MAX_ITEMS / 缓存上限） */
  truncated: boolean;
}

const EMPTY: OutlineResult = { items: [], truncated: false };

/** 测试用：清掉所有缓存 */
export const clearEventsOutlineCache = (): void => {
  cache.clear();
  inflight.clear();
};

/** 测试用：缓存里是否有这个任务（验证增量 / 失效） */
export const peekOutlineCacheOffset = (taskId: string): number | null =>
  cache.get(taskId)?.offset ?? null;

/** 测试用：缓存里这个任务留了几项（验证内存有界） */
export const peekOutlineCacheItemCount = (taskId: string): number | null =>
  cache.get(taskId)?.items.length ?? null;

/** 读 [pos, pos+len) 这一段（文件不够长就读到哪算哪） */
const readRange = async (
  fh: import("node:fs/promises").FileHandle,
  pos: number,
  len: number,
): Promise<Buffer> => {
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
};

/** offset 之前最多 64 字节 */
const readFingerprint = (
  fh: import("node:fs/promises").FileHandle,
  offset: number,
): Promise<Buffer> => {
  const len = Math.min(FINGERPRINT_BYTES, offset);
  return readRange(fh, offset - len, len);
};

/** 文件开头最多 64 字节（只取已扫过的范围内） */
const readHead = (
  fh: import("node:fs/promises").FileHandle,
  offset: number,
): Promise<Buffer> => readRange(fh, 0, Math.min(FINGERPRINT_BYTES, offset));

const handleLine = (line: Buffer, out: OutlineItem[]): void => {
  if (line.length === 0) return;
  if (!line.includes(KIND_USER) && !line.includes(KIND_ACTION)) return;
  const ev = parseEventLineBuf(line);
  if (!ev || typeof ev.id !== "string" || typeof ev.ts !== "number") return;
  const item = toOutlineItem(ev);
  if (item) out.push(item);
};

/**
 * 从 from 扫到 size，把完整行里的时间线项 push 进 out；返回新的「已处理偏移」。
 * 末尾没有换行的半行不处理、偏移停在它前面。
 */
const scanFrom = async (
  fh: import("node:fs/promises").FileHandle,
  from: number,
  size: number,
  out: OutlineItem[],
): Promise<number> => {
  let pos = from;
  let consumed = from;
  // 跨块的未完成行：块边界正好切在一行中间时攒着
  let carry: Buffer[] = [];
  while (pos < size) {
    const len = Math.min(SCAN_CHUNK, size - pos);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    if (bytesRead === 0) break;
    const chunk = buf.subarray(0, bytesRead);
    let lineStart = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, lineStart);
      if (nl < 0) break;
      const piece = chunk.subarray(lineStart, nl);
      const line = carry.length > 0 ? Buffer.concat([...carry, piece]) : piece;
      carry = [];
      handleLine(line, out);
      consumed = pos + nl + 1;
      lineStart = nl + 1;
    }
    if (lineStart < chunk.length) carry.push(chunk.subarray(lineStart));
    pos += bytesRead;
  }
  return consumed;
};

const compute = async (taskId: string): Promise<OutlineResult> => {
  const file = getEventsLogPath(taskId);
  let fh: import("node:fs/promises").FileHandle;
  try {
    fh = await fs.open(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache.delete(taskId);
      return EMPTY;
    }
    throw err;
  }
  try {
    const st = await fh.stat();
    const prev = cache.get(taskId);
    let from = 0;
    let items: OutlineItem[] = [];
    let trimmed = false;
    if (
      prev &&
      prev.ino === st.ino &&
      st.size >= prev.offset &&
      prev.head.equals(await readHead(fh, prev.offset)) &&
      prev.fingerprint.equals(await readFingerprint(fh, prev.offset))
    ) {
      from = prev.offset;
      items = prev.items;
      trimmed = prev.trimmed;
    }
    // 先扫进临时数组、成功了再并进缓存（复用缓存时 items 就是缓存本体）：
    // 扫到一半抛错不能把缓存里的项留成「半截 + 旧偏移」（下次会重复）
    const added: OutlineItem[] = [];
    const offset = await scanFrom(fh, from, st.size, added);
    for (const it of added) items.push(it);
    if (items.length > MAX_CACHED_ITEMS) {
      items.splice(0, items.length - MAX_CACHED_ITEMS);
      trimmed = true;
    }
    const entry: CacheEntry = {
      ino: st.ino,
      offset,
      head: await readHead(fh, offset),
      fingerprint: await readFingerprint(fh, offset),
      items,
      trimmed,
    };
    // LRU：重新插入 = 最近使用
    cache.delete(taskId);
    cache.set(taskId, entry);
    while (cache.size > CACHE_MAX_TASKS) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return {
      items: items.length > OUTLINE_MAX_ITEMS ? items.slice(-OUTLINE_MAX_ITEMS) : items.slice(),
      truncated: trimmed || items.length > OUTLINE_MAX_ITEMS,
    };
  } finally {
    await fh.close().catch(() => {});
  }
};

/**
 * 读一个任务的提问大纲（时间正序、最多 OUTLINE_MAX_ITEMS 项、取最新的）。
 * 同一任务并发请求共用一次扫描。文件不存在 = 空大纲。
 */
export const readEventsOutline = (taskId: string): Promise<OutlineResult> => {
  const running = inflight.get(taskId);
  if (running) return running;
  const p = compute(taskId).finally(() => {
    if (inflight.get(taskId) === p) inflight.delete(taskId);
  });
  inflight.set(taskId, p);
  return p;
};
