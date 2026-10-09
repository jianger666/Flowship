"use client";

/**
 * 前端流畅度上报：把渲染进程里的「长任务 / 慢交互 / 回前台追赶 / 页面规模」按窗口汇总后
 * 发给 /api/perf/ui（落 ui-perf.jsonl），供 scripts/perf-report.mjs 持续观察「流式渲染卡不卡」。
 *
 * 采集 / 汇总 / 上报策略全在 lib/ui-perf-collector（纯逻辑、有单测），这里只做浏览器 API 接线：
 * - PerformanceObserver：longtask（主线程占用 ≥50ms）、event（交互到下一次绘制，INP 口径）
 * - visibilitychange / pagehide：切后台 / 离开页面时结算
 * - 30s 定时结算
 * 任何一步失败都只是少一类数据，绝不影响页面。刻意没有常驻 rAF 循环（它自己就会增加每帧开销）。
 */
import { useEffect } from "react";

import { streamingCodePlugin } from "@/lib/streaming-code-highlighter";
import {
  createUiPerfCollector,
  type UiPerfProbe,
  type UiPerfReason,
  type UiPerfSample,
} from "@/lib/ui-perf-collector";

const FLUSH_INTERVAL_MS = 30_000;
/** 交互耗时低于它的不采（event timing 的最小有意义阈值是 16ms；40 足够覆盖「开始有点卡」） */
const EVENT_DURATION_THRESHOLD_MS = 40;

type EventTimingEntry = PerformanceEntry & { interactionId?: number };

const probe = (): UiPerfProbe => {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } })
    .memory;
  return {
    heapMB:
      typeof mem?.usedJSHeapSize === "number"
        ? mem.usedJSHeapSize / 1048576
        : undefined,
    domNodes: document.getElementsByTagName("*").length,
    // 流式代码块限频高亮的窗口统计（自上次上报以来）；只在决定上报时才取走并清零
    highlight: streamingCodePlugin.takeStats(),
  };
};

const send = (sample: UiPerfSample & { taskId?: string }): void => {
  try {
    void fetch("/api/perf/ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sample),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* 观测上报失败静默 */
  }
};

export function useUiPerfReporter(taskId: string | undefined): void {
  useEffect(() => {
    if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") {
      return;
    }
    const collector = createUiPerfCollector({
      at: performance.now(),
      visible: document.visibilityState === "visible",
    });

    const observers: PerformanceObserver[] = [];
    const observe = (
      type: string,
      extra: Record<string, unknown>,
      onEntries: (entries: PerformanceEntryList) => void,
    ): void => {
      try {
        const po = new PerformanceObserver((list) => {
          try {
            onEntries(list.getEntries());
          } catch {
            /* 单批条目处理失败不影响后续 */
          }
        });
        po.observe({ type, buffered: false, ...extra } as PerformanceObserverInit);
        observers.push(po);
      } catch {
        /* 该条目类型在当前内核不支持：只是少一类数据 */
      }
    };

    observe("longtask", {}, (entries) => {
      for (const e of entries) collector.onLongTask(e.duration, e.startTime);
    });
    observe("event", { durationThreshold: EVENT_DURATION_THRESHOLD_MS }, (entries) => {
      for (const e of entries) {
        // 只算真实交互（INP 口径）：有 interactionId 的 event timing
        if (((e as EventTimingEntry).interactionId ?? 0) > 0) {
          collector.onInput(e.duration);
        }
      }
    });

    const flush = (reason: UiPerfReason): void => {
      const sample = collector.flush(performance.now(), reason, probe);
      if (sample) send({ ...sample, ...(taskId ? { taskId } : {}) });
    };

    const timer = window.setInterval(() => flush("interval"), FLUSH_INTERVAL_MS);
    const onVisibility = (): void => {
      const visible = document.visibilityState === "visible";
      // 切后台：先结算（此刻 collector 仍标记为可见、能把可见时长算到现在），再标记不可见
      if (!visible) flush("hidden");
      collector.setVisible(visible, performance.now());
    };
    const onPageHide = (): void => flush("pagehide");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      // 换任务 / 卸载：把当前窗口里已有的信号结算掉再走
      flush("switch");
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      for (const po of observers) po.disconnect();
    };
  }, [taskId]);
}
