/**
 * 提测收件箱「忽略」存储（<dataRoot>/mr-inbox-ignored.json）
 *
 * 形状：`{ [url]: ignoredAtMs }`（url = mrUrl 或 bugUrl、与 seen 同 key 语义）。
 * 唯一清理：加载时丢掉超 90 天的条目（复用 pruneSeenMap）。
 * 写入走 data-root 原子写；读改写套模块级 promise chain 互斥。
 */

import path from "node:path";
import { promises as fs } from "node:fs";

import { pruneSeenMap } from "@/lib/mr-inbox";
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

/** 读盘 + 解析容错（缺文件 / 坏 JSON → 空 map） */
const readIgnoredRaw = async (): Promise<Record<string, number>> => {
  try {
    const raw = await fs.readFile(ignoredFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    // ENOENT / JSON 坏都当空（忽略名单是轻量辅助数据、丢了可重新标）
  }
  return {};
};

/**
 * 读忽略名单（加载时仅内存 prune，不写盘）。
 * 写回 prune 放在 add* 写锁路径（read→prune→mutate→write），避免读路径
 * 用陈旧快照覆盖并发 add* 刚写入的标记。
 */
export const readMrInboxIgnored = async (): Promise<Record<string, number>> => {
  return pruneSeenMap(await readIgnoredRaw());
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
 * 返回更新后的 map。
 */
export const addMrInboxIgnored = (
  url: string,
): Promise<Record<string, number>> =>
  enqueueIgnoredWrite(async () => {
    const cur = pruneSeenMap(await readIgnoredRaw());
    const next = { ...cur, [url]: Date.now() };
    await writePrivateFileAtomic(
      ignoredFilePath(),
      JSON.stringify(next, null, 2),
    );
    return next;
  });
