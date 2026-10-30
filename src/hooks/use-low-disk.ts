"use client";

/**
 * 低磁盘读数（R14 B2-4c / Q15-10）：挂载时取一次 `GET /api/system/disk`，之后每 5 分钟取一次；
 * 窗口重新聚焦 / 页面回到前台时（距上次取数 ≥ 30s）补取，让「腾出空间后红条自己消失」不用干等。
 *
 * 调度逻辑在 lib/low-disk-poller.ts（假定时器可单测），这里只接 fetch / window 事件 / React state。
 * 返回 null = 还没取到过读数（首帧、或一直没取成功）——此时不画条。
 * 这次没量到（unknown）或请求失败都不覆盖上一次的结论（mergeDiskReading），避免红条闪烁。
 */
import { useEffect, useState } from "react";

import { isDiskReading, mergeDiskReading, type DiskReading } from "@/lib/low-disk";
import { createLowDiskPoller } from "@/lib/low-disk-poller";

/** 单次请求的超时：服务端只做一次 statfs，几百毫秒内必回；挂住就放弃这次（否则在飞标记会卡住后续所有轮询） */
const FETCH_TIMEOUT_MS = 10_000;

const fetchDiskReading = async (): Promise<DiskReading | null> => {
  try {
    const res = await fetch("/api/system/disk", {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return isDiskReading(data) ? data : null;
  } catch {
    return null;
  }
};

export const useLowDisk = (): DiskReading | null => {
  const [reading, setReading] = useState<DiskReading | null>(null);

  useEffect(() => {
    const poller = createLowDiskPoller({
      fetchReading: fetchDiskReading,
      onReading: (next) => setReading((prev) => mergeDiskReading(prev, next)),
      isVisible: () => document.visibilityState === "visible",
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const nudge = (): void => poller.nudge();
    poller.start();
    window.addEventListener("focus", nudge);
    document.addEventListener("visibilitychange", nudge);
    return () => {
      window.removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", nudge);
      poller.stop();
    };
  }, []);

  return reading;
};
