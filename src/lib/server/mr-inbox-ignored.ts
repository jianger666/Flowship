/**
 * 提测收件箱「忽略」存储（<dataRoot>/mr-inbox-ignored.json）
 *
 * 形状：`{ [url]: ignoredAtMs | { at, title?, group?, ref? } }`（url = mrUrl 或 bugUrl、与 seen 同 key 语义；
 * 旧数据是纯时间戳、新数据带条目简要信息，两种可混存）。
 * 唯一清理：加载时丢掉超 90 天的条目（复用 pruneSeenMap）。
 * 写入走 data-root 原子写；读改写套模块级 promise chain 互斥。
 */

import path from "node:path";
import { promises as fs } from "node:fs";

import { pruneSeenMap } from "@/lib/mr-inbox";
import {
  sanitizeIgnoredMeta,
  type IgnoredEntry,
  type IgnoredMeta,
} from "@/lib/mr-inbox-ignored-meta";
import { dataRoot, writePrivateFileAtomic } from "./data-root";

const ignoredFilePath = (): string =>
  path.join(dataRoot(), "mr-inbox-ignored.json");

// 读改写互斥链挂 globalThis：Next dev 多 chunk 下 module-level Promise 各持一份、锁失效
// （同 task-fs-core withTaskLock 踩坑；审查发现本文件原先用 module 级 let）
const IGNORED_WRITE_CHAIN_KEY = "__flowshipMrInboxIgnoredWriteChainV1__";
const getIgnoredWriteChain = (): { current: Promise<unknown> } => {
  const g = globalThis as unknown as Record<
    string,
    { current: Promise<unknown> } | undefined
  >;
  if (!g[IGNORED_WRITE_CHAIN_KEY]) {
    g[IGNORED_WRITE_CHAIN_KEY] = { current: Promise.resolve() };
  }
  return g[IGNORED_WRITE_CHAIN_KEY]!;
};

/** 盘上一条：旧格式 = 纯时间戳；新格式 = { at, title?, group?, ref? }（向后兼容、两种可混存） */
interface StoredIgnored {
  at: number;
  meta?: IgnoredMeta;
}

/** 读盘 + 解析容错（缺文件 / 坏 JSON → 空 map；旧数值与新对象两种值都认） */
const readIgnoredStored = async (): Promise<Record<string, StoredIgnored>> => {
  try {
    const raw = await fs.readFile(ignoredFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, StoredIgnored> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          out[k] = { at: v };
        } else if (v && typeof v === "object" && !Array.isArray(v)) {
          const at = (v as { at?: unknown }).at;
          if (typeof at === "number" && Number.isFinite(at)) {
            const meta = sanitizeIgnoredMeta(v);
            out[k] = meta ? { at, meta } : { at };
          }
        }
      }
      return out;
    }
  } catch {
    // ENOENT / JSON 坏都当空（忽略名单是轻量辅助数据、丢了可重新标）
  }
  return {};
};

/** 90 天 prune（复用 pruneSeenMap 的口径：过期 / 未来时间戳都丢） */
const pruneStored = (
  cur: Record<string, StoredIgnored>,
): Record<string, StoredIgnored> => {
  const atMap: Record<string, number> = {};
  for (const [k, v] of Object.entries(cur)) atMap[k] = v.at;
  const kept = pruneSeenMap(atMap);
  if (kept === atMap) return cur;
  const out: Record<string, StoredIgnored> = {};
  for (const k of Object.keys(kept)) out[k] = cur[k]!;
  return out;
};

/** 落盘：没有 meta 的仍写旧格式（纯数字），保持与旧版本互读 */
const writeStored = (cur: Record<string, StoredIgnored>): Promise<void> => {
  const obj: Record<string, number | (IgnoredMeta & { at: number })> = {};
  for (const [k, v] of Object.entries(cur)) {
    obj[k] = v.meta ? { at: v.at, ...v.meta } : v.at;
  }
  return writePrivateFileAtomic(ignoredFilePath(), JSON.stringify(obj, null, 2));
};

const toAtMap = (cur: Record<string, StoredIgnored>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cur)) out[k] = v.at;
  return out;
};

/**
 * 读忽略名单（加载时仅内存 prune，不写盘）。
 * 写回 prune 放在 add* 写锁路径（read→prune→mutate→write），避免读路径
 * 用陈旧快照覆盖并发 add* 刚写入的标记。
 */
export const readMrInboxIgnored = async (): Promise<Record<string, number>> => {
  return toAtMap(pruneStored(await readIgnoredStored()));
};

/** 已忽略条目列表（最近忽略的在前）；旧数据缺 meta 字段时只有 url + at */
export const listMrInboxIgnored = async (): Promise<IgnoredEntry[]> => {
  const cur = pruneStored(await readIgnoredStored());
  return Object.entries(cur)
    .map(([url, v]) => ({ url, at: v.at, ...(v.meta ?? {}) }))
    .sort((a, b) => b.at - a.at);
};

/** 串行执行一个写任务（读改写整段进链、防交叉覆盖） */
const enqueueIgnoredWrite = <T>(job: () => Promise<T>): Promise<T> => {
  const chain = getIgnoredWriteChain();
  const next = chain.current.then(job, job);
  // 链上吞掉错误、不让上一个失败传染下一个任务
  chain.current = next.catch(() => {});
  return next;
};

/**
 * 写入忽略（永久从收件箱去掉，直到 90 天 prune 后可能再出现）。
 * meta = 条目简要信息（标题 / 分组 / 引用，供「已忽略」列表展示）；重复忽略且未传 meta 时沿用旧 meta。
 * 返回更新后的 map。
 */
export const addMrInboxIgnored = (
  url: string,
  meta?: IgnoredMeta,
): Promise<Record<string, number>> =>
  enqueueIgnoredWrite(async () => {
    const cur = pruneStored(await readIgnoredStored());
    const clean = sanitizeIgnoredMeta(meta);
    const keep = clean ?? cur[url]?.meta;
    const next: Record<string, StoredIgnored> = {
      ...cur,
      [url]: keep ? { at: Date.now(), meta: keep } : { at: Date.now() },
    };
    await writeStored(next);
    return toAtMap(next);
  });

/**
 * 取消忽略（「撤销」入口用）。幂等：本来就没忽略也不报错。
 * 返回更新后的 map。
 */
export const removeMrInboxIgnored = (
  url: string,
): Promise<Record<string, number>> =>
  enqueueIgnoredWrite(async () => {
    const cur = pruneStored(await readIgnoredStored());
    if (!(url in cur)) return toAtMap(cur);
    const next = { ...cur };
    delete next[url];
    await writeStored(next);
    return toAtMap(next);
  });
