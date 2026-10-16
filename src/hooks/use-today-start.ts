"use client";

/**
 * 「今天 0 点」时间戳（本地时区），过零点自动更新（S13-22）。
 *
 * 原来甘特的今天线用 `useMemo(..., [])` 只在挂载时算一次：页面开着过了零点，
 * 今天线 / 「今」标记还停在昨天。这里用定时器算到下一个零点再更新，卸载时清理；
 * 另外回前台（电脑休眠 / 标签页被节流后定时器会晚到）立即校正一次。
 */

import { useEffect, useState } from "react";

import { msUntilNextLocalMidnight, startOfLocalDay } from "@/lib/day-boundary";

export const useTodayStart = (): number => {
  const [today0, setToday0] = useState(() => startOfLocalDay(Date.now()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sync = () => {
      // 值没变（同一天）→ React 会跳过重渲染
      setToday0(startOfLocalDay(Date.now()));
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        sync();
        schedule();
      }, msUntilNextLocalMidnight(Date.now()));
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      sync();
      // 休眠醒来后原定时器的剩余时间已不可信，重排
      schedule();
    };

    // 挂载时再校正一次：初始 state 到 effect 之间可能恰好跨过零点
    sync();
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return today0;
};
