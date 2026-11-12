/**
 * 会话管理页「占用」的量尺缓存 + 后台量尺队列。
 *
 * 为什么要有它（2026-11-12 用户反馈「进会话管理特别卡」，实测定位）：
 * 旧的 GET /api/system/storage 每次请求都把 543 个任务目录 + 全部活任务的 worktree 重新 `du` 一遍。
 * 活任务的 worktree 带 node_modules，单个 3~8GB，实测 4 个合计 18GB、`du` 串起来 ~40 秒、内核态 CPU 吃满，
 * 而这页每次进入 / 每次删除后都会再扫一次——整台机器的磁盘被占住，界面自然卡。
 *
 * 做法：
 * - 量过的大小按 key 缓存（内存 + 落盘 `<dataRoot>/storage-size-cache.json`，重启后第一次进页面也不重扫）；
 * - 缓存命中的有效性：任务数据目录按 TTL；worktree 容器按「容器目录 mtime + TTL」
 *   （增删仓库工作区会改 mtime、立刻失效；node_modules 内部增长不改 mtime，靠 TTL 兜底、用户也可手动「重新统计」）；
 * - 没有缓存的 worktree **不在请求里同步量**：请求先带着「统计中」(null) 返回，后台**单路**慢慢量（不与界面抢磁盘），
 *   前端轮询到量完为止。
 *
 * 只缓存「大小数字」——不缓存目录内容、不缓存任何路径之外的信息；缓存丢了 / 损坏只是重新量一遍。
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "./data-root";
import { dirSize } from "./dir-size";

/** 任务数据目录（events / uploads …）大小缓存多久：增长慢、几分钟内不必重量 */
export const TASK_DATA_TTL_MS = 10 * 60_000;
/** worktree 大小缓存多久：几 GB 的 node_modules 量一遍要十几秒，6 小时内信缓存（增删仓库另有 mtime 失效） */
export const WORKTREE_TTL_MS = 6 * 60 * 60_000;
/** 某个目录「量不出」（du 超时 / 被杀）后，隔多久才允许后台再试一次（别让每次轮询都触发一次注定失败的 du） */
export const SCAN_FAILURE_RETRY_MS = 5 * 60_000;
/** 盘上缓存里的量尺时间比「现在」晚超过这个值 = 时钟回拨 / 脏数据，丢弃（否则 now - at 为负、永远「新鲜」） */
const FUTURE_SKEW_MS = 60_000;

interface Entry {
  bytes: number;
  /** 量出这个数的时间 */
  at: number;
  /** 失效戳（worktree 容器目录 mtimeMs；没有 = null，只靠 TTL） */
  stamp: number | null;
}

interface Job {
  key: string;
  dir: string;
  stamp: number | null;
}

interface State {
  loaded: Promise<void> | null;
  map: Map<string, Entry>;
  /** 已排队 / 在量的 key（去重） */
  queued: Set<string>;
  queue: Job[];
  running: boolean;
  /** 量不出的 key → 失败时间（SCAN_FAILURE_RETRY_MS 内不再排队重试；手动「重新统计」清空） */
  failed: Map<string, number>;
  /** 落盘串行链：两次 persistNow 不交错（慢盘上交错写同一个临时文件会写出半截 JSON） */
  persistChain: Promise<void>;
  persistTimer: ReturnType<typeof setTimeout> | null;
  /** 量尺代数：clear 后旧代的在途结果作废，防止刚清掉的缓存被迟到的老结果写回 */
  epoch: number;
  idleWaiters: Array<() => void>;
}

const STATE_KEY = "__flowshipStorageSizeCacheV2__";
const getState = (): State => {
  const g = globalThis as unknown as Record<string, State | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      loaded: null,
      map: new Map(),
      queued: new Set(),
      queue: [],
      running: false,
      failed: new Map(),
      persistChain: Promise.resolve(),
      persistTimer: null,
      epoch: 0,
      idleWaiters: [],
    };
  }
  return g[STATE_KEY]!;
};

const cacheFilePath = (): string => path.join(dataRoot(), "storage-size-cache.json");

interface PersistedFile {
  v: 1;
  entries: Record<string, [number, number, number | null]>;
}

/** 首次使用时从盘上读入（幂等；读不到 / 损坏 = 空缓存，不抛） */
export const loadSizeCache = (): Promise<void> => {
  const st = getState();
  if (st.loaded) return st.loaded;
  st.loaded = (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(cacheFilePath(), "utf8")) as Partial<PersistedFile>;
      if (raw?.v !== 1 || !raw.entries || typeof raw.entries !== "object") return;
      for (const [key, v] of Object.entries(raw.entries)) {
        if (!Array.isArray(v)) continue;
        const [bytes, at, stamp] = v;
        if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) continue;
        if (typeof at !== "number" || !Number.isFinite(at)) continue;
        // 量尺时间在「未来」：时钟回拨 / 脏数据——丢掉，重新量（否则它会一直被判新鲜）
        if (at > Date.now() + FUTURE_SKEW_MS) continue;
        if (st.map.has(key)) continue; // 本进程已量出更新的就不覆盖
        st.map.set(key, { bytes, at, stamp: typeof stamp === "number" ? stamp : null });
      }
    } catch {
      // 没有缓存文件 / 损坏：当空的、重新量
    }
  })();
  return st.loaded;
};

const persistOnce = async (): Promise<void> => {
  const st = getState();
  const entries: PersistedFile["entries"] = {};
  for (const [key, e] of st.map) entries[key] = [e.bytes, e.at, e.stamp];
  const file = cacheFilePath();
  // 临时文件名带随机段：即便将来有别的写入方，也不会写到同一个临时文件上
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify({ v: 1, entries } satisfies PersistedFile));
    await fs.rename(tmp, file);
  } catch {
    // 写不进去只是下次重启要重量一遍
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
};

/** 落盘：串行（上一次写完才写下一次）；每次写的是调用那一刻的最新内存态 */
const persistNow = (): Promise<void> => {
  const st = getState();
  st.persistChain = st.persistChain.then(persistOnce, persistOnce);
  return st.persistChain;
};

/** 去抖落盘：连续量完一批只写一次 */
const schedulePersist = (): void => {
  const st = getState();
  if (st.persistTimer) return;
  st.persistTimer = setTimeout(() => {
    st.persistTimer = null;
    void persistNow();
  }, 1000);
  // 别让这个定时器拖住进程退出
  st.persistTimer.unref?.();
};

/** 命中且有效的大小；过期 / 戳对不上 / 没量过 → null */
export const getFreshSize = (
  key: string,
  opts: { stamp: number | null; ttlMs: number; now?: number },
): number | null => {
  const e = getState().map.get(key);
  if (!e) return null;
  const now = opts.now ?? Date.now();
  // now < e.at：量尺时间在未来（时钟回拨）——不可信，当过期（否则 now - e.at 为负、永远「新鲜」）
  if (now < e.at || now - e.at >= opts.ttlMs) return null;
  // 两边都有戳才比；一边没有（旧缓存 / 取不到 mtime）就只看 TTL
  if (opts.stamp !== null && e.stamp !== null && opts.stamp !== e.stamp) return null;
  return e.bytes;
};

/**
 * 缓存里这条的大小，**不看过期 / 戳**（没量过 = null）。
 * 给「先拿旧值顶着、后台重量」用：过期的旧数字远比「统计中」有用，界面照常显示、量完下一轮轮询自然换新。
 */
export const getAnySize = (key: string): number | null =>
  getState().map.get(key)?.bytes ?? null;

/** 缓存里这条的量尺时间（没有 = null；不看是否过期——给界面显示「更新于」用） */
export const getSizeMeasuredAt = (key: string): number | null =>
  getState().map.get(key)?.at ?? null;

export const putSize = (key: string, bytes: number, stamp: number | null): void => {
  getState().map.set(key, { bytes, at: Date.now(), stamp });
  schedulePersist();
};

/** 清掉不在 live 集合里的 key（任务删了 / worktree 没了，别让缓存无限长） */
export const pruneSizeCache = (live: Set<string>): void => {
  const st = getState();
  let changed = false;
  for (const key of [...st.map.keys()]) {
    if (!live.has(key)) {
      st.map.delete(key);
      changed = true;
    }
  }
  for (const key of [...st.failed.keys()]) if (!live.has(key)) st.failed.delete(key);
  if (changed) schedulePersist();
};

/** 手动「重新统计」：整表作废（排队中的后台量尺一并丢弃，在途的那一个结果也不再写回） */
export const clearSizeCache = (): void => {
  const st = getState();
  st.map.clear();
  st.failed.clear();
  st.queue.length = 0;
  st.queued.clear();
  st.epoch += 1;
  schedulePersist();
};

/** 还在排队 / 量尺中的个数（前端据此决定要不要继续轮询） */
export const pendingScanCount = (): number => getState().queued.size;

/** 最近量不出的 key 个数（du 超时 / 被杀）：这些目录不在排队、也没有新值，界面标「量不出」而不是一直转圈 */
export const failedScanCount = (): number => getState().failed.size;

const notifyIdleIfDone = (): void => {
  const st = getState();
  if (st.running || st.queue.length > 0) return;
  const waiters = st.idleWaiters.splice(0);
  for (const w of waiters) w();
};

const drain = async (): Promise<void> => {
  const st = getState();
  if (st.running) return;
  st.running = true;
  try {
    // 单路：一次只量一个——3~8GB 的 worktree 一个就要十几秒，并发开几路只会把磁盘打满、拖慢界面
    for (let job = st.queue.shift(); job; job = st.queue.shift()) {
      const epoch = st.epoch;
      try {
        const bytes = await dirSize(job.dir);
        // 期间被手动清空过（epoch 变了）：这个结果属于旧一代，丢掉
        if (epoch === st.epoch) {
          if (bytes === null) {
            // 量不出（du 超时 / 被杀）：保留旧值（如有）、记一笔失败，一段时间内不再重试
            st.failed.set(job.key, Date.now());
          } else {
            st.failed.delete(job.key);
            putSize(job.key, bytes, job.stamp);
          }
        }
      } catch {
        // 量不出来就留空、下次请求再排
      } finally {
        if (epoch === st.epoch) st.queued.delete(job.key);
      }
    }
  } finally {
    st.running = false;
    notifyIdleIfDone();
  }
};

/** 把一个目录排进后台量尺队列（同 key 已在队里就不重复）；立即返回、不等量完 */
export const scheduleSizeScan = (key: string, dir: string, stamp: number | null): void => {
  const st = getState();
  if (st.queued.has(key)) return;
  // 刚量不出的目录先别再试：每次前端轮询都起一次注定失败（甚至超时 120 秒）的 du，会把磁盘和队列一直占着
  const failedAt = st.failed.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < SCAN_FAILURE_RETRY_MS) return;
  st.queued.add(key);
  st.queue.push({ key, dir, stamp });
  void drain();
};

/** 仅供测试：等后台量尺队列排空 */
export const whenScansIdle = (): Promise<void> => {
  const st = getState();
  if (!st.running && st.queue.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => st.idleWaiters.push(resolve));
};

/** 仅供测试：丢掉全部内存态（不碰盘上文件）+ 等落盘定时器放掉 */
export const __resetSizeCacheForTest = (): void => {
  const st = getState();
  if (st.persistTimer) clearTimeout(st.persistTimer);
  st.persistTimer = null;
  st.loaded = null;
  st.map.clear();
  st.failed.clear();
  st.queued.clear();
  st.queue.length = 0;
  st.epoch += 1;
};

/** 仅供测试：立刻落盘 */
export const __persistSizeCacheNowForTest = (): Promise<void> => persistNow();
