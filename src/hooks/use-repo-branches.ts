"use client";

/**
 * useRepoBranches（v0.9.11）
 *
 * 按路径批量拉仓库分支候选（/api/repo-branches）、给设置页仓库卡片 /
 * 新建 · 编辑任务 dialog 的分支 Combobox 供数据。
 *
 * 为什么是「批量 map」而不是单路径 hook：调用方的仓库行都是 map 渲染的
 * （repo-card N 行 / dialog N 个选中仓）、hook 不能进循环——顶层调一次、行内查结果。
 *
 * 语义约定（调用方据此控制禁用态）：
 * - map[path] === undefined → 还没拉回来（加载中、先禁用）
 * - { isRepo: false }       → 非 git 仓 / 路径无效（保持禁用、「没有 git 的就不用选」）
 * - { isRepo: true, branches } → 放开、branches 作候选
 *
 * 生命周期内每路径只拉一次（组件级防重复）+ refresh 模式 5 分钟会话缓存——
 * 重开页面 / dialog 命中缓存直接给、不再打远端（与 BranchSwitcher 同窗对齐）；
 * 缓存过期或研发刚推分支，关掉重开 dialog 即刷新，不需要手动失效机制。
 *
 * opts.refresh：先让服务端最佳努力 git fetch 一次再列（研发刚推的分支也可见；
 * 离线 / 无 remote / 鉴权失败自动降级本地、不抛）。设置页仓库卡片不需要最新、别开
 * （N 个仓串起来 fetch 慢）；新建 · 编辑任务的被测分支 Combobox 开。
 */

import { useEffect, useRef, useState } from "react";

import type { RepoBranchList } from "@/lib/types";

// 会话级 refresh 缓存：新建/编辑 dialog 每开一次就挂载一次，无缓存就是一阵 fetch。
// 与 BranchSwitcher 的 5 分钟窗对齐；命中直接给上次结果，不再打远端。
const REFRESH_CACHE_MS = 5 * 60 * 1000;
const refreshCache = new Map<string, { at: number; data: RepoBranchList }>();

export const useRepoBranches = (
  paths: string[],
  opts?: { refresh?: boolean },
): Record<string, RepoBranchList | undefined> => {
  // 每路径的拉取结果（undefined = 还没回来）
  const [map, setMap] = useState<Record<string, RepoBranchList>>({});
  // 已发起过的请求 key（含 in-flight）：路径 + 模式，防 paths 引用每 render 变导致重复拉
  const requestedRef = useRef(new Set<string>());
  // 组件是否还活着：卸载后丢弃迟到的响应（不能用 effect cleanup 的 cancelled——
  // paths 变化会重跑 effect、把仍然需要的 in-flight 结果误丢）
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // paths 数组每次 render 新引用、串成稳定 key 进 deps
  const pathsKey = paths.join("\n");
  const refresh = opts?.refresh === true;
  useEffect(() => {
    for (const p of pathsKey.split("\n")) {
      if (!p) continue;
      // 去重 key 带上模式：同一路径两种模式各拉一次（调用方目前固定一边、防御未来混用）
      const key = `${refresh ? "r" : "l"}\n${p}`;
      if (requestedRef.current.has(key)) continue;
      requestedRef.current.add(key);
      // refresh 模式先看会话缓存：命中直接给，不再打远端（dialog 开开关关不 fetch 风暴）
      if (refresh) {
        const hit = refreshCache.get(key);
        if (hit && Date.now() - hit.at < REFRESH_CACHE_MS) {
          const data = hit.data;
          if (aliveRef.current) setMap((prev) => ({ ...prev, [p]: data }));
          continue;
        }
      }
      const url =
        `/api/repo-branches?path=${encodeURIComponent(p)}` +
        (refresh ? "&refresh=1" : "");
      void fetch(url)
        .then((r) =>
          r.ok
            ? (r.json() as Promise<RepoBranchList>)
            : { isRepo: false, branches: [] as string[] },
        )
        // 拉失败归一成「非 git」：禁用下拉（本机 app 网络失败罕见、不值得区分错误态）
        .catch(() => ({ isRepo: false, branches: [] as string[] }))
        .then((res) => {
          if (refresh) refreshCache.set(key, { at: Date.now(), data: res });
          if (aliveRef.current) setMap((prev) => ({ ...prev, [p]: res }));
        });
    }
  }, [pathsKey, refresh]);

  return map;
};
