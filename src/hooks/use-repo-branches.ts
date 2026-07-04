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
 * 生命周期内每路径只拉一次（组件级、不做模块缓存——重开页面 / dialog 自然刷新、
 * 用户 fetch 新分支后重进即可见、不需要手动失效机制）。
 */

import { useEffect, useRef, useState } from "react";

import type { RepoBranchList } from "@/lib/types";

export const useRepoBranches = (
  paths: string[],
): Record<string, RepoBranchList | undefined> => {
  // 每路径的拉取结果（undefined = 还没回来）
  const [map, setMap] = useState<Record<string, RepoBranchList>>({});
  // 已发起过请求的路径（含 in-flight）、防 paths 引用每 render 变导致重复拉
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
  useEffect(() => {
    for (const p of pathsKey.split("\n")) {
      if (!p || requestedRef.current.has(p)) continue;
      requestedRef.current.add(p);
      void fetch(`/api/repo-branches?path=${encodeURIComponent(p)}`)
        .then((r) =>
          r.ok
            ? (r.json() as Promise<RepoBranchList>)
            : { isRepo: false, branches: [] as string[] },
        )
        // 拉失败归一成「非 git」：禁用下拉（本机 app 网络失败罕见、不值得区分错误态）
        .catch(() => ({ isRepo: false, branches: [] as string[] }))
        .then((res) => {
          if (aliveRef.current) setMap((prev) => ({ ...prev, [p]: res }));
        });
    }
  }, [pathsKey]);

  return map;
};
