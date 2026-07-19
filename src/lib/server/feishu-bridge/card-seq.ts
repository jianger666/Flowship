/**
 * 按卡片共享的 sequence 分配器
 *
 * CardKit 要求同一张卡的所有更新 sequence 严格递增。卡片会被多个模块更新
 * （card-stream 流式 / card-action 按钮终态），各自维护计数器会互相撞序号
 * （飞书拒绝 300317）——统一走这里：
 *
 * seq = max(该卡上次用过的 + 1, floor)
 * - 进程内：floor = 秒级墙钟，同秒多次靠 last+1
 * - 冷启动 miss：先读 `<bridgeDataDir>/card-seq.json` 恢复
 * - 盘上也没有：floor = 墙钟秒 + 7200（2h 余量）——流式期间每秒可分配
 *   4~8 个 seq，长回复会把内存 seq 推到墙钟前方几十分钟；重启后若只用
 *   墙钟秒作 floor，会低于历史 seq → 300317。2h 余量覆盖常见长会话。
 *
 * int32 上限守卫保留（毫秒会溢出、秒级 2038 年前安全）。
 */

import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";

import { dataRoot, writePrivateFileAtomic } from "@/lib/server/data-root";

const SEQ_KEY = "__flowshipFeishuCardSeqV1__";
const DISK_HYDRATED_KEY = "__flowshipFeishuCardSeqDiskHydratedV1__";

const INT32_MAX = 2_147_483_647;
/** 防膨胀：卡片实体最多存活 14 天，映射超限时清最旧的一半 */
const SEQ_MAP_MAX = 1000;
/** 冷启动无盘记录时的墙钟余量（秒）——见文件头注释 */
const RESTART_SLACK_SEC = 7200;
/** 落盘节流默认 5s；finalize 走 flushCardSeqToDisk 立即刷 */
const DEFAULT_PERSIST_THROTTLE_MS = 5000;

/** cardId → 上次分配的 sequence（挂 globalThis，dev HMR 不丢） */
const getSeqMap = (): Map<string, number> => {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  if (!g[SEQ_KEY]) g[SEQ_KEY] = new Map();
  return g[SEQ_KEY]!;
};

const isDiskHydrated = (): boolean => {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  return g[DISK_HYDRATED_KEY] === true;
};

const setDiskHydrated = (v: boolean): void => {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  g[DISK_HYDRATED_KEY] = v;
};

/** 与 card-map 并列的独立落盘文件（不写 card-map，避免并发写族冲突） */
const seqFilePath = (): string =>
  path.join(dataRoot(), "feishu-bridge", "card-seq.json");

type SeqStore = Record<string, number>;

/** 同步读盘（冷启动首次 miss）；坏 JSON / 缺文件 → 空 */
const readSeqStoreSync = (): SeqStore => {
  try {
    const raw = readFileSync(seqFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: SeqStore = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        out[k] = Math.min(Math.floor(v), INT32_MAX);
      }
    }
    return out;
  } catch {
    return {};
  }
};

/**
 * 进程内首次需要 seq 时把盘上值灌进内存 Map（已有内存值不覆盖——
 * 同进程内 last+1 仍是权威）。
 */
const hydrateFromDiskSync = (): void => {
  if (isDiskHydrated()) return;
  setDiskHydrated(true);
  const map = getSeqMap();
  const store = readSeqStoreSync();
  for (const [cardId, seq] of Object.entries(store)) {
    if (!map.has(cardId)) map.set(cardId, seq);
  }
};

// —— 节流落盘（独立写队列，不与 card-map 共享） ——
let persistThrottleMs = DEFAULT_PERSIST_THROTTLE_MS;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDirty = false;
let writeChain: Promise<void> = Promise.resolve();

const clearPersistTimer = (): void => {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
};

const schedulePersist = (): void => {
  persistDirty = true;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushCardSeqToDisk();
  }, persistThrottleMs);
};

/** 立即把内存 Map 原子写到 card-seq.json（finalize / 单测用） */
export const flushCardSeqToDisk = (): Promise<void> => {
  clearPersistTimer();
  // 即使当前不 dirty 也允许强制刷（finalize 收尾保证落盘）
  persistDirty = true;
  writeChain = writeChain
    .then(async () => {
      if (!persistDirty) return;
      persistDirty = false;
      // 写前再 hydrate 一次：避免「从未 next 过、空 Map 覆盖有盘」的极端
      hydrateFromDiskSync();
      const map = getSeqMap();
      const obj: SeqStore = {};
      for (const [k, v] of map) obj[k] = v;
      await writePrivateFileAtomic(seqFilePath(), JSON.stringify(obj, null, 2));
    })
    .catch((err) => {
      // 落盘失败不抛——seq 仍在内存；下次 schedule / flush 再试
      persistDirty = true;
      console.warn(
        "[feishu-bridge/card-seq] 落盘失败:",
        err instanceof Error ? err.message : err,
      );
    });
  return writeChain;
};

/** 分配该卡下一个 sequence（严格递增、int32 内） */
export const nextCardSequence = (cardId: string): number => {
  hydrateFromDiskSync();
  const map = getSeqMap();
  const last = map.get(cardId);
  const sec = Math.floor(Date.now() / 1000);
  // 冷 miss（内存+盘都没有）：floor 抬到墙钟+2h，见文件头
  const floor = last === undefined ? sec + RESTART_SLACK_SEC : sec;
  const next = Math.min(Math.max((last ?? 0) + 1, floor), INT32_MAX);
  if (map.size >= SEQ_MAP_MAX && !map.has(cardId)) {
    const keys = [...map.keys()].slice(0, Math.floor(SEQ_MAP_MAX / 2));
    for (const k of keys) map.delete(k);
  }
  map.set(cardId, next);
  schedulePersist();
  return next;
};

/** 单测改节流间隔；传 null 恢复默认 */
export const __setCardSeqPersistThrottleForTest = (ms: number | null): void => {
  persistThrottleMs = ms == null ? DEFAULT_PERSIST_THROTTLE_MS : ms;
};

/**
 * 单测重置内存 + 水合标记。
 * `unlinkDisk: true`（默认）顺带删落盘文件，避免用例互污；
 * 测「读盘恢复」时传 `unlinkDisk: false` 并事先写好文件。
 */
export const __resetCardSeqForTest = async (
  opts?: { unlinkDisk?: boolean },
): Promise<void> => {
  clearPersistTimer();
  persistDirty = false;
  // 等在途写结束再清，避免写回污染
  await writeChain.catch(() => undefined);
  writeChain = Promise.resolve();
  getSeqMap().clear();
  setDiskHydrated(false);
  if (opts?.unlinkDisk === false) return;
  try {
    await fs.unlink(seqFilePath());
  } catch {
    // ENOENT 忽略
  }
};
