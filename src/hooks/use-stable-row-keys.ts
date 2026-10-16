"use client";

/**
 * 列表行稳定 key hook（算法与依据见 `@/lib/stable-row-keys`）
 *
 * 在 render 期同步对账（不用 effect）：key 必须在本次渲染就用上，
 * 放 effect 里会让第一帧仍用旧下标 key、状态串一帧。
 * 重复 render（StrictMode）幂等：同一 rows 引用第二次进来时行数相同、直接复用。
 */

import { useRef } from "react";

import {
  nextRowKey,
  reconcileRowKeys,
  type RowKeySnapshot,
} from "@/lib/stable-row-keys";

export const useStableRowKeys = <T,>(
  rows: readonly T[],
  sig: (row: T) => string,
): string[] => {
  // 上一次渲染的行与 key 快照
  const snapshotRef = useRef<RowKeySnapshot<T> | null>(null);
  if (snapshotRef.current === null) {
    snapshotRef.current = { rows, keys: rows.map(() => nextRowKey()) };
  } else if (snapshotRef.current.rows !== rows) {
    snapshotRef.current = {
      rows,
      keys: reconcileRowKeys(snapshotRef.current, rows, sig),
    };
  }
  return snapshotRef.current.keys as string[];
};
