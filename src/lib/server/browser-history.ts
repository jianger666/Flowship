/**
 * 内置浏览器「地址栏记忆」的落盘层（`<dataRoot>/browser-history.json`）。
 *
 * - 全局一份、不按任务分：和内置浏览器的持久登录档案一样，所有任务共用同一个浏览器（Chrome 的地址栏记忆也是跨标签页共享的）。
 * - 文件形状 `{ v: 1, history: HistoryEntry[] }`，按最近访问时间倒序，最多 1000 条，满了淘汰最久没访问的。
 *   URL 规整 / 标题清洗 / 列表解析 / 记一次访问的口径在 `@/lib/browser-history`（客户端联想与这里的去重共用同一份）。
 * - 所有读改写走进程内串行队列：多个面板可以并发打进来，不串行会丢更新。
 *   单文件原子写（tmp + fsync + rename，0600）保证读方无锁直读不会读到半截。
 * - 读路径宽容、写路径保守（与另一份用户数据文件同一套规矩）：
 *     · 文件不存在 = 空列表；读不出来（EACCES / EIO…）向上抛，**不当空列表**——否则下一次写会把读不出来的历史覆盖掉；
 *     · 文件坏了（JSON 不合法 / 根结构不对 / 版本不认识）：读路径当空列表、不动文件；写路径先把坏文件改名 `.corrupt-<时间戳>` 留证据再写新的；
 *     · 单条坏数据（没 id / 地址不合法…）逐条丢弃，不连累其它记录。
 * - 与 AI 无关：这是用户给自己的敲网址捷径，刻意不暴露成 AI 工具（页面里的指令没法借 AI 往里塞东西、也读不到用户去过哪些站）。
 * - 「清除」是真删：直接删文件（连坏文件也一起删，不留 `.corrupt` 备份——用户要清的就是这些内容）。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeHistoryUrl, parseHistoryList, removeVisit, upsertVisit, type HistoryEntry } from "@/lib/browser-history";

import { dataRoot, stripBom, writePrivateFileAtomic } from "./data-root";

export const HISTORY_FILE = "browser-history.json";
const FILE_VERSION = 1;

export const historyPath = (): string => path.join(dataRoot(), HISTORY_FILE);

export type HistoryErrorCode = "invalid_url";

/** 预期内的业务失败：message 是中文；code 供路由映射状态码 */
export class HistoryError extends Error {
  readonly code: HistoryErrorCode;
  constructor(code: HistoryErrorCode, message: string) {
    super(message);
    this.name = "HistoryError";
    this.code = code;
  }
}

export const isHistoryError = (err: unknown): err is HistoryError => err instanceof HistoryError;

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
  history: HistoryEntry[];
  /** 文件在但不能信（JSON 不合法 / 根结构不对 / 版本不认识）。写路径据此先备份再写 */
  corrupt: boolean;
}

const CORRUPT_WARN_INTERVAL_MS = 60_000;
let corruptWarnedAt = 0;
/** 读路径会被联想反复触发：坏文件的告警限频，别刷满日志（写路径那次改名照常告警） */
const warnCorruptRead = (): void => {
  const now = Date.now();
  if (now - corruptWarnedAt < CORRUPT_WARN_INTERVAL_MS) return;
  corruptWarnedAt = now;
  console.warn(`[browser-history] ${HISTORY_FILE} 不能解析（读路径、不改文件；${CORRUPT_WARN_INTERVAL_MS / 1000}s 内不重复提示）`);
};

const load = async (): Promise<Loaded> => {
  let raw: string;
  try {
    raw = await fs.readFile(historyPath(), "utf-8");
  } catch (err) {
    if (isNotFound(err)) return { history: [], corrupt: false };
    throw err;
  }
  try {
    const parsed = JSON.parse(stripBom(raw)) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { v?: unknown }).v !== FILE_VERSION ||
      !Array.isArray((parsed as { history?: unknown }).history)
    ) {
      return { history: [], corrupt: true };
    }
    return { history: parseHistoryList((parsed as { history: unknown }).history), corrupt: false };
  } catch {
    return { history: [], corrupt: true };
  }
};

/** 坏文件改名留证据（失败只记日志：改名不成也不能挡住记录——最坏是新写入覆盖坏文件） */
const backupCorrupt = async (): Promise<void> => {
  const file = historyPath();
  const backup = `${file}.corrupt-${Date.now()}`;
  try {
    await fs.rename(file, backup);
    console.warn(`[browser-history] ${HISTORY_FILE} 损坏、已备份到 ${path.basename(backup)}`);
  } catch (err) {
    console.warn(`[browser-history] 备份损坏文件失败（继续写入）：${err instanceof Error ? err.message : String(err)}`);
  }
};

const write = async (history: readonly HistoryEntry[]): Promise<void> => {
  await writePrivateFileAtomic(historyPath(), `${JSON.stringify({ v: FILE_VERSION, history }, null, 2)}\n`);
};

/** 写路径的「读」：坏文件先备份，再当空列表往下走 */
const loadForWrite = async (): Promise<HistoryEntry[]> => {
  const { history, corrupt } = await load();
  if (corrupt) await backupCorrupt();
  return history;
};

// ───────── 对外接口 ─────────

/** 全部记录（最近访问的在最前）。读不出来（权限 / IO）会抛；文件不存在 / 坏了都是空列表 */
export const listHistory = async (): Promise<HistoryEntry[]> => {
  const { history, corrupt } = await load();
  if (corrupt) warnCorruptRead();
  return history;
};

export interface RecordVisitInput {
  url: unknown;
  /** 页面标题；没给 / 清洗后为空 = 不覆盖已有条目的标题（新条目用主机名） */
  title?: unknown;
}

export interface RecordVisitResult {
  entry: HistoryEntry;
  /** false = 这个地址以前记过：只累加了次数、刷新了时间与标题（幂等友好，不产生重复） */
  created: boolean;
}

/**
 * 记一次访问（时间一律用服务端的现在，不信客户端传的）。地址不可记录（非 http(s) / 无法解析 / 过长）→ HistoryError("invalid_url")。
 * 同一个（规整后的）地址已存在：次数 +1、顶到最前，返回 created:false。超过上限淘汰最久没访问的。
 */
export const recordHistoryVisit = (input: RecordVisitInput): Promise<RecordVisitResult> => {
  if (!normalizeHistoryUrl(input.url).ok) return Promise.reject(new HistoryError("invalid_url", "这个地址不记入浏览历史"));
  return serialize(async () => {
    const list = await loadForWrite();
    const result = upsertVisit(list, { url: input.url, title: input.title, at: Date.now(), makeId: randomUUID });
    // 前面已经校验过地址，upsertVisit 不会再拒；留一道防线免得将来两边口径漂移时静默丢数据
    if (!result) throw new HistoryError("invalid_url", "这个地址不记入浏览历史");
    await write(result.list);
    return { entry: result.entry, created: result.created };
  });
};

/** 删一条；返回是否真的删了（id 不存在 = false，调用方回 404） */
export const removeHistoryEntry = (id: unknown): Promise<boolean> => {
  if (typeof id !== "string" || id === "") return Promise.resolve(false);
  return serialize(async () => {
    // 用 load 而不是 loadForWrite：文件坏了 = 里面没有任何可删的东西，没必要为一次「删不到」把坏文件改名
    const { history: list } = await load();
    const next = removeVisit(list, id);
    if (next === list) return false;
    await write(next);
    return true;
  });
};

/** 清空全部记录，返回清掉了几条（本来就是空 = 0、不碰文件）。坏文件也一并删掉。读不出来（权限 / IO）会抛 */
export const clearHistory = (): Promise<number> =>
  serialize(async () => {
    const { history, corrupt } = await load();
    if (history.length === 0 && !corrupt) return 0;
    await fs.rm(historyPath(), { force: true });
    return history.length;
  });
