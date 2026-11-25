/**
 * 内置浏览器收藏夹的落盘层（`<dataRoot>/browser-bookmarks.json`）。
 *
 * - 全局一份、不按任务分：和内置浏览器的持久登录档案一样，所有任务共用同一个浏览器。
 * - 文件形状 `{ v: 1, bookmarks: Bookmark[] }`，按 createdAt 倒序（最新在最前）。URL 规整 / 标题清洗 / 列表解析的口径
 *   在 `@/lib/browser-bookmarks`（客户端「星标亮不亮」与这里的去重共用同一份）。
 * - 所有读改写走进程内串行队列：面板的星标、对话框的删除 / 撤销可以并发打进来，不串行会丢更新。
 *   单文件原子写（tmp + fsync + rename，0600）保证读方无锁直读不会读到半截。
 * - 读路径宽容、写路径保守：
 *     · 文件不存在 = 空列表；读不出来（EACCES / EIO…）向上抛，**不当空列表**——否则下一次写会把读不出来的收藏夹覆盖掉；
 *     · 文件坏了（JSON 不合法 / 根结构不对 / 版本不认识）：读路径当空列表、不动文件；写路径先把坏文件改名 `.corrupt-<时间戳>` 留证据再写新的；
 *     · 单条坏数据（没 id / 地址不合法…）逐条丢弃，不连累其它收藏。
 * - 与 AI 无关：这是用户给自己的导航捷径，刻意不暴露成 AI 工具（页面里的指令没法借 AI 往收藏夹里塞东西、也读不到它）。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  BOOKMARK_LIMIT,
  cleanBookmarkTitle,
  normalizeBookmarkUrl,
  parseBookmarkList,
  sortBookmarks,
  type Bookmark,
} from "@/lib/browser-bookmarks";

import { dataRoot, stripBom, writePrivateFileAtomic } from "./data-root";

export const BOOKMARKS_FILE = "browser-bookmarks.json";
const FILE_VERSION = 1;

export const bookmarksPath = (): string => path.join(dataRoot(), BOOKMARKS_FILE);

export type BookmarkErrorCode = "invalid_url" | "limit_reached";

/** 预期内的业务失败：message 是中文、能直接给用户看；code 供路由映射状态码 */
export class BookmarkError extends Error {
  readonly code: BookmarkErrorCode;
  constructor(code: BookmarkErrorCode, message: string) {
    super(message);
    this.name = "BookmarkError";
    this.code = code;
  }
}

export const isBookmarkError = (err: unknown): err is BookmarkError => err instanceof BookmarkError;

const isNotFound = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

// ───────── 串行队列 ─────────
// chain 永不 reject（run 的失败只交给调用方，队列里留的是 catch 过的尾巴），所以 chain.then(fn) 一定会跑 fn
let chain: Promise<unknown> = Promise.resolve();
const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn);
  chain = run.catch(() => undefined);
  return run;
};

// ───────── 读 ─────────

interface Loaded {
  bookmarks: Bookmark[];
  /** 文件在但不能信（JSON 不合法 / 根结构不对 / 版本不认识）。写路径据此先备份再写 */
  corrupt: boolean;
}

const CORRUPT_WARN_INTERVAL_MS = 60_000;
let corruptWarnedAt = 0;
/** 读路径会被星标 / 对话框反复触发：坏文件的告警限频，别刷满日志（写路径那次改名照常告警） */
const warnCorruptRead = (): void => {
  const now = Date.now();
  if (now - corruptWarnedAt < CORRUPT_WARN_INTERVAL_MS) return;
  corruptWarnedAt = now;
  console.warn(`[browser-bookmarks] ${BOOKMARKS_FILE} 不能解析（读路径、不改文件；${CORRUPT_WARN_INTERVAL_MS / 1000}s 内不重复提示）`);
};

const load = async (): Promise<Loaded> => {
  let raw: string;
  try {
    raw = await fs.readFile(bookmarksPath(), "utf-8");
  } catch (err) {
    if (isNotFound(err)) return { bookmarks: [], corrupt: false };
    throw err;
  }
  try {
    const parsed = JSON.parse(stripBom(raw)) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { v?: unknown }).v !== FILE_VERSION ||
      !Array.isArray((parsed as { bookmarks?: unknown }).bookmarks)
    ) {
      return { bookmarks: [], corrupt: true };
    }
    return { bookmarks: parseBookmarkList((parsed as { bookmarks: unknown }).bookmarks), corrupt: false };
  } catch {
    return { bookmarks: [], corrupt: true };
  }
};

/** 坏文件改名留证据（失败只记日志：改名不成也不能挡住用户收藏——最坏是新写入覆盖坏文件） */
const backupCorrupt = async (): Promise<void> => {
  const file = bookmarksPath();
  const backup = `${file}.corrupt-${Date.now()}`;
  try {
    await fs.rename(file, backup);
    console.warn(`[browser-bookmarks] ${BOOKMARKS_FILE} 损坏、已备份到 ${path.basename(backup)}`);
  } catch (err) {
    console.warn(`[browser-bookmarks] 备份损坏文件失败（继续写入）：${err instanceof Error ? err.message : String(err)}`);
  }
};

const write = async (bookmarks: readonly Bookmark[]): Promise<void> => {
  await writePrivateFileAtomic(bookmarksPath(), `${JSON.stringify({ v: FILE_VERSION, bookmarks }, null, 2)}\n`);
};

/** 写路径的「读」：坏文件先备份，再当空列表往下走 */
const loadForWrite = async (): Promise<Bookmark[]> => {
  const { bookmarks, corrupt } = await load();
  if (corrupt) await backupCorrupt();
  return bookmarks;
};

// ───────── 对外接口 ─────────

/** 全部收藏（最新在最前）。读不出来（权限 / IO）会抛；文件不存在 / 坏了都是空列表 */
export const listBookmarks = async (): Promise<Bookmark[]> => {
  const { bookmarks, corrupt } = await load();
  if (corrupt) warnCorruptRead();
  return bookmarks;
};

export interface AddBookmarkInput {
  url: unknown;
  title?: unknown;
  /**
   * 指定收藏时间（epoch 毫秒）。只给「撤销删除」用：带着被删那条原来的 createdAt 加回来，列表按 createdAt 倒序，
   * 它就回到原来的位置。不合法 / 比现在晚（超过 1 分钟的时钟误差）的值忽略、按现在算。
   */
  createdAt?: unknown;
}

export interface AddBookmarkResult {
  bookmark: Bookmark;
  /** false = 这个地址早就收藏过：只更新了标题、把它顶到最前（幂等，不产生重复） */
  created: boolean;
}

const CLOCK_SKEW_MS = 60_000;

const resolveCreatedAt = (value: unknown, now: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= now + CLOCK_SKEW_MS ? Math.floor(value) : now;

/**
 * 加一条收藏。地址不合法 → BookmarkError("invalid_url")；新增会超过上限 → BookmarkError("limit_reached")。
 * 同一个（规整后的）地址已存在：更新标题与时间、顶到最前，返回 created:false——重复点收藏、两个面板同时点都不会出重复项。
 */
export const addBookmark = (input: AddBookmarkInput): Promise<AddBookmarkResult> => {
  const normalized = normalizeBookmarkUrl(input.url);
  if (!normalized.ok) return Promise.reject(new BookmarkError("invalid_url", normalized.error));
  // 没给 / 清洗后为空的标题 = ""：已存在的收藏沿用它原来的好标题（页面还在加载、标题暂时为空时再点收藏，不能把标题冲成主机名）
  const givenTitle = cleanBookmarkTitle(input.title, "");
  return serialize(async () => {
    const list = await loadForWrite();
    const now = Date.now();
    const createdAt = resolveCreatedAt(input.createdAt, now);
    const existing = list.find((b) => b.url === normalized.url);
    if (existing) {
      const updated: Bookmark = { ...existing, title: givenTitle || existing.title, createdAt };
      await write(sortBookmarks([updated, ...list.filter((b) => b !== existing)]));
      return { bookmark: updated, created: false };
    }
    if (list.length >= BOOKMARK_LIMIT) {
      throw new BookmarkError("limit_reached", `收藏夹已满（最多 ${BOOKMARK_LIMIT} 个），请先删除一些`);
    }
    const bookmark: Bookmark = { id: randomUUID(), url: normalized.url, title: givenTitle || normalized.hostname, createdAt };
    // 新条目放最前再稳定排序：时间戳相同时新的排在前面
    await write(sortBookmarks([bookmark, ...list]));
    return { bookmark, created: true };
  });
};

/** 删一条；返回是否真的删了（id 不存在 = false，调用方回 404） */
export const removeBookmark = (id: unknown): Promise<boolean> => {
  if (typeof id !== "string" || id === "") return Promise.resolve(false);
  return serialize(async () => {
    // 用 load 而不是 loadForWrite：文件坏了 = 里面没有任何可删的东西，没必要为一次「删不到」把坏文件改名（真要写新内容时才备份）
    const { bookmarks: list } = await load();
    const next = list.filter((b) => b.id !== id);
    if (next.length === list.length) return false;
    await write(next);
    return true;
  });
};
