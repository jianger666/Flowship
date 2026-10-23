"use client";

/**
 * 单个文件 diff 的拉取（改动面板右侧用）。
 *
 * 两份数据：
 * - base：`-U3` 的 diff，选中文件就拉（很轻，首屏用）；
 * - full：整文件 diff（`-U1000000`），用户第一次点「展开上下文」才拉（loadFull）。
 *   拿到后展开 / 收起全在本地，不再请求。
 *
 * 缓存：模块级 FIFO（key = 文件统计签名 + query）。运行中文件可能还在被改——不信缓存、
 * 每次清单刷新（updatedAt 变）都静默重拉；已有同一份内容时保留旧内容、不闪 loading。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { changesQueryKey, type ChangesQuery } from "@/lib/changes/scope";
import { fetchTaskChangeFileDiff } from "@/lib/task-store";
import type { TaskChangeFileDiff } from "@/lib/types";

const CACHE_MAX = 80;
const cache = new Map<string, TaskChangeFileDiff>();

const remember = (key: string, data: TaskChangeFileDiff): void => {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, data);
};

/** 丢掉全部缓存（手动刷新用：文件内容变了但增删统计恰好没变时，签名对不上不了新旧） */
export const clearFileDiffCache = (): void => {
  cache.clear();
};

export type DiffSlot =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: TaskChangeFileDiff };

interface SlotArgs {
  /** null = 不拉 */
  key: string | null;
  enabled: boolean;
  running: boolean;
  updatedAt: number;
  nonce: number;
  load: (signal: AbortSignal) => Promise<TaskChangeFileDiff>;
}

/** 一份 diff 的「拉取 + 缓存 + 静默刷新」状态机（base / full 各用一份） */
const useDiffSlot = ({ key, enabled, running, updatedAt, nonce, load }: SlotArgs): DiffSlot | null => {
  const [slot, setSlot] = useState<{ key: string; slot: DiffSlot } | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled || !key) return;
    const cached = running ? undefined : cache.get(key);
    if (cached) {
      setSlot({ key, slot: { status: "ok", data: cached } });
      return;
    }
    const ctl = new AbortController();
    // 已有同一份内容时保留旧内容（静默刷新不闪 loading）
    setSlot((prev) =>
      prev && prev.key === key && prev.slot.status === "ok"
        ? prev
        : { key, slot: { status: "loading" } },
    );
    loadRef
      .current(ctl.signal)
      .then((data) => {
        if (ctl.signal.aborted) return;
        remember(key, data);
        setSlot({ key, slot: { status: "ok", data } });
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setSlot({
          key,
          slot: { status: "error", message: err instanceof Error ? err.message : "未知错误" },
        });
      });
    return () => ctl.abort();
  }, [enabled, key, running, updatedAt, nonce]);

  // 切回已缓存的文件：首帧就直接给内容（不先闪一下 loading）
  const cachedNow = !running && enabled && key ? cache.get(key) : undefined;
  if (cachedNow) return { status: "ok", data: cachedNow };
  return slot && slot.key === key ? slot.slot : null;
};

interface Args {
  taskId: string;
  /** 当前要看的文件；null = 不拉 */
  target: { repoPath: string; path: string; oldPath?: string } | null;
  /** 文件统计签名：变了就当作文件被改过（缓存失效） */
  signature: string | null;
  query: ChangesQuery;
  /** 面板是否打开 */
  active: boolean;
  /** agent 运行中：不信缓存、清单每刷新一次就静默重拉 */
  running: boolean;
  /** 清单最近一次刷新的戳 */
  updatedAt: number;
  /** 手动刷新计数：变了就重拉（配合 clearFileDiffCache 丢缓存） */
  refreshKey?: number;
}

export interface FileDiffState {
  /** -U3 的 diff；null = 还没开始 */
  base: DiffSlot | null;
  /** 整文件 diff；null = 用户还没要过 */
  full: DiffSlot | null;
  /** 要整文件（点 gap 时调；幂等） */
  loadFull: () => void;
  /** 丢缓存重拉（出错后点重试） */
  retry: () => void;
}

export const useFileDiff = ({
  taskId,
  target,
  signature,
  query,
  active,
  running,
  updatedAt,
  refreshKey = 0,
}: Args): FileDiffState => {
  const [retryCount, setRetryCount] = useState(0);
  const nonce = retryCount + refreshKey;
  const [wantFull, setWantFull] = useState(false);

  const queryKey = changesQueryKey(query);
  const repoPath = target?.repoPath ?? null;
  const path = target?.path ?? null;
  const oldPath = target?.oldPath ?? null;

  // 切文件 / 切范围：「要整文件」复位（同一个文件内容变了不复位——用户展开过就保持展开）
  const fileKey = repoPath && path ? `${taskId}\0${repoPath}\0${path}\0${queryKey}` : null;
  const [prevFileKey, setPrevFileKey] = useState(fileKey);
  if (prevFileKey !== fileKey) {
    setPrevFileKey(fileKey);
    setWantFull(false);
  }

  const baseKey = fileKey && signature ? `${fileKey}\0${signature}` : null;
  const fullKey = baseKey ? `${baseKey}\0full` : null;

  // 不用 useCallback：useDiffSlot 通过 ref 取「最新一次渲染」的 load，effect 又只在 key 变化时才会调用它；
  // key 里已含 queryKey / signature，所以永远用到的是与当前 key 对应的参数
  const fetchOne = (full: boolean) => (signal: AbortSignal) =>
    fetchTaskChangeFileDiff(
      taskId,
      { repoPath: repoPath ?? "", path: path ?? "", ...(oldPath ? { oldPath } : {}) },
      { ...query, full },
      signal,
    );

  const base = useDiffSlot({
    key: baseKey,
    enabled: active,
    running,
    updatedAt,
    nonce,
    load: fetchOne(false),
  });
  const fullSlot = useDiffSlot({
    key: fullKey,
    enabled: active && wantFull,
    running,
    updatedAt,
    nonce,
    load: fetchOne(true),
  });

  const loadFull = useCallback(() => setWantFull(true), []);
  const retry = useCallback(() => {
    if (baseKey) cache.delete(baseKey);
    if (fullKey) cache.delete(fullKey);
    setRetryCount((n) => n + 1);
  }, [baseKey, fullKey]);

  return {
    base,
    full: wantFull ? (fullSlot ?? { status: "loading" }) : null,
    loadFull,
    retry,
  };
};
