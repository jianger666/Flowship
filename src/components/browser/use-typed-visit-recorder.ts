"use client";

/**
 * typed-visit-recorder.ts 的 React 薄壳：把面板里的标签状态喂给它，面板卸载时让它收摊。
 * 登记 / 判定 / 到点复核 / 记录的逻辑都在 createTypedVisitRecorder 里（无 React，有单测）。
 */
import { useEffect, useMemo } from "react";

import type { TabInfo } from "@/lib/browser-bridge-types";

import { createTypedVisitRecorder, type TypedVisitRecorderDeps } from "./typed-visit-recorder";

const NO_TABS: readonly TabInfo[] = [];

export const useTypedVisitRecorder = ({ tabs, record }: { tabs: readonly TabInfo[] | undefined; record: TypedVisitRecorderDeps["record"] }) => {
  // record 引用要稳定（history store 的方法是稳定的）：换了就等于换了一个新的执行体、旧的待判定作废
  const recorder = useMemo(() => createTypedVisitRecorder({ record }), [record]);

  // 主进程每推一次标签状态就复核一次
  useEffect(() => {
    recorder.update(tabs ?? NO_TABS);
  }, [recorder, tabs]);

  useEffect(() => () => recorder.dispose(), [recorder]);

  return { begin: recorder.begin };
};
