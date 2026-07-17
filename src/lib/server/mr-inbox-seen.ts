/**
 * 提测收件箱「已读标记」存储（<dataRoot>/mr-inbox-seen.json）
 *
 * 形状：`{ [mrUrl]: seenAtMs }`。唯一清理规则：加载时丢掉超 90 天的条目
 *（pruneSeenMap、用户拍板其它清理都不要）。写入走 data-root 原子写；
 * 读改写套模块级 promise chain 互斥、防并发标已读互相覆盖。
 */

import path from "node:path";
import { promises as fs } from "node:fs";

import { pruneSeenMap } from "@/lib/mr-inbox";
import { dataRoot, writePrivateFileAtomic } from "./data-root";

const seenFilePath = (): string => path.join(dataRoot(), "mr-inbox-seen.json");

// 读改写互斥链挂 globalThis：Next dev 多 chunk 下 module-level Promise 各持一份、锁失效
// （同 task-fs-core withTaskLock 踩坑；审查发现本文件原先用 module 级 let）
const SEEN_WRITE_CHAIN_KEY = "__feAiFlowMrInboxSeenWriteChainV1__";
const getSeenWriteChain = (): { current: Promise<unknown> } => {
  const g = globalThis as unknown as Record<
    string,
    { current: Promise<unknown> } | undefined
  >;
  if (!g[SEEN_WRITE_CHAIN_KEY]) {
    g[SEEN_WRITE_CHAIN_KEY] = { current: Promise.resolve() };
  }
  return g[SEEN_WRITE_CHAIN_KEY]!;
};

/** 读盘 + 解析容错（缺文件 / 坏 JSON → 空 map） */
const readSeenRaw = async (): Promise<Record<string, number>> => {
  try {
    const raw = await fs.readFile(seenFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    // ENOENT / JSON 坏都当空（已读标记是轻量辅助数据、丢了可重新标）
  }
  return {};
};

/**
 * 读已读标记（加载即清 90 天过期条目；有清理就写回盘、失败只 warn 不阻断读）。
 */
export const readMrInboxSeen = async (): Promise<Record<string, number>> => {
  const raw = await readSeenRaw();
  const pruned = pruneSeenMap(raw);
  if (pruned !== raw) {
    void enqueueSeenWrite(async () => {
      try {
        await writePrivateFileAtomic(seenFilePath(), JSON.stringify(pruned, null, 2));
      } catch (err) {
        console.warn(
          "[mr-inbox] 已读标记清理写回失败:",
          err instanceof Error ? err.message : err,
        );
      }
    });
  }
  return pruned;
};

/** 串行执行一个写任务（读改写整段进链、防交叉覆盖） */
const enqueueSeenWrite = <T>(job: () => Promise<T>): Promise<T> => {
  const chain = getSeenWriteChain();
  const next = chain.current.then(job, job);
  // 链上吞掉错误、不让上一个失败传染下一个任务
  chain.current = next.catch(() => {});
  return next;
};

/**
 * 标已读 / 取消已读。返回更新后的 map。
 */
export const setMrInboxSeen = (
  mrUrl: string,
  seen: boolean,
): Promise<Record<string, number>> =>
  enqueueSeenWrite(async () => {
    const cur = pruneSeenMap(await readSeenRaw());
    const next = { ...cur };
    if (seen) {
      next[mrUrl] = Date.now();
    } else {
      delete next[mrUrl];
    }
    await writePrivateFileAtomic(seenFilePath(), JSON.stringify(next, null, 2));
    return next;
  });

/**
 * 批量标已读 / 取消已读（一次读 + 一次写盘；勿循环调单条造成 N 次写）。
 * urls 须已归一（canonical MR / 原样 bug URL）。
 */
export const setMrInboxSeenMany = (
  urls: string[],
  seen: boolean,
): Promise<Record<string, number>> =>
  enqueueSeenWrite(async () => {
    const cur = pruneSeenMap(await readSeenRaw());
    if (urls.length === 0) return cur;
    const next = { ...cur };
    const now = Date.now();
    for (const url of urls) {
      if (!url) continue;
      if (seen) {
        next[url] = now;
      } else {
        delete next[url];
      }
    }
    await writePrivateFileAtomic(seenFilePath(), JSON.stringify(next, null, 2));
    return next;
  });
