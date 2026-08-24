"use client";

/**
 * 滚动抖动取证探针（2026-08-24 排查「事件流回滚后持续高频抖动」引入）
 *
 * 背景：事件流往回滚到某些位置后滚动条+内容持续上下振荡，历史上修过三轮
 * （overflow-anchor / scrollbar-gutter / 跟随状态机重构）都没治本。静态排查
 * 剩下的嫌疑全是「运行时才看得见」的：Virtuoso 尺寸补偿、Shiki/Mermaid 异步
 * 渲染回填、某个 JS 写入方在跟用户抢 scrollTop——没有调用栈就无法定凶。
 *
 * 设计：
 * - **默认零开销**：只在 `localStorage["flowship:scroll-debug"] === "1"` 时工作，
 *   开关读取一次（attach 时），不设定时器不挂监听。
 * - 区分两类滚动来源：**程序写入**（包装实例的 scrollTop setter、抓调用栈）
 *   vs **原生滚动**（scroll 事件总数 − 程序写入数）。谁在高频写 scrollTop，
 *   栈一打出来就知道是 Virtuoso 补偿、follow 控制器还是别的。
 * - 同步记录几何（scrollTop / scrollHeight / clientHeight）：scrollHeight 在
 *   振荡 = 布局层高度不稳定；只有 scrollTop 振 = 有写入方在拉扯。
 * - 高频自动报案：任意 1s 窗口内滚动事件 ≥ 阈值 → 打一份聚合报告（按调用栈
 *   去重、限流防刷屏）；另挂 window.__scrollProbeDump 手动导出原始环形缓冲。
 *
 * 用法见 docs 或使用现场提示：开开关 → 刷新 → 复现 → 看 Console / 导出。
 */

export const SCROLL_DEBUG_FLAG = "flowship:scroll-debug";

/** 1s 窗口内滚动事件达到该数量视为「正在抖动」 */
const JITTER_RATE_THRESHOLD = 15;
/** 两次自动报案的最小间隔（防持续抖动刷屏 / 刷接口） */
const REPORT_THROTTLE_MS = 8_000;
/** 环形缓冲容量：足够覆盖几秒钟的高频现场 */
const RING_CAPACITY = 600;
/** 抓调用栈的帧数（够定位到业务/Virtuoso 函数即可，别太长） */
const STACK_FRAMES = 6;

interface ProbeEntry {
  t: number;
  /** scrollTop 写入后的值 */
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** true = 程序写入（带栈）；false = 原生滚动 */
  programmatic: boolean;
  stack?: string;
}

export interface ScrollProbeHandle {
  detach: () => void;
}

/**
 * 给滚动容器挂探针。返回 detach；未开启调试开关时返回 null（零开销路径）。
 * @param label 报案前缀（区分 chat / task 多个流实例）
 */
export const attachScrollProbe = (
  scroller: HTMLElement,
  label: string,
): ScrollProbeHandle | null => {
  let enabled = false;
  try {
    enabled =
      typeof window !== "undefined" &&
      window.localStorage?.getItem(SCROLL_DEBUG_FLAG) === "1";
  } catch {
    /* 存储被禁：当没开 */
  }
  if (!enabled || !scroller) return null;

  const desc = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  const rawSet = desc?.set;
  const rawGet = desc?.get;
  if (!rawSet || !rawGet) return null;

  const ring: ProbeEntry[] = [];
  let ringCursor = 0;
  // 1s 滑窗计数（时间戳队列）
  const recentTs: number[] = [];
  let lastReportAt = 0;

  const push = (e: Omit<ProbeEntry, "t">) => {
    const entry: ProbeEntry = { ...e, t: Date.now() };
    ring[ringCursor % RING_CAPACITY] = entry;
    ringCursor++;
    recentTs.push(entry.t);
    while (recentTs.length > 0 && entry.t - recentTs[0]! > 1000) {
      recentTs.shift();
    }
    if (recentTs.length >= JITTER_RATE_THRESHOLD) {
      maybeReport(entry.t);
    }
  };

  const readGeom = () => ({
    scrollTop: Math.round(rawGet.call(scroller)),
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
  });

  // 包装实例的 scrollTop setter：程序化写入（Virtuoso / follow 控制器 / 恢复逻辑）
  // 都会走这里并留下调用栈；用户手滚只触发 scroll 事件、不走 setter。
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => desc.get!.call(scroller),
    set(v: number) {
      rawSet.call(scroller, v);
      push({
        ...readGeom(),
        programmatic: true,
        stack: new Error().stack
          ?.split("\n")
          .slice(2, 2 + STACK_FRAMES)
          .join("\n"),
      });
    },
  });

  const onScroll = () => {
    // setter 已经记过程序写入；这里补原生滚动的样本（programmatic=false）
    const last = ring[(ringCursor - 1 + RING_CAPACITY) % RING_CAPACITY];
    if (!last || Date.now() - last.t > 50 || !last.programmatic) {
      push({ ...readGeom(), programmatic: false });
    }
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });

  const dedupStacks = (entries: ProbeEntry[]) => {
    const byStack = new Map<string, { count: number; sample: string }>();
    for (const e of entries) {
      if (!e.stack) continue;
      // 只取前两帧做指纹（同一次补偿调用的重复写入归并）
      const key = e.stack.split("\n").slice(0, 2).join("\n");
      const cur = byStack.get(key);
      if (cur) cur.count++;
      else byStack.set(key, { count: 1, sample: e.stack });
    }
    return [...byStack.entries()].sort((a, b) => b[1].count - a[1].count);
  };

  /** 把最近样本批量上报服务端落盘（fire-and-forget；诊断包导出时自动带走） */
  const shipToServer = (entries: ProbeEntry[]) => {
    try {
      void fetch("/api/debug/scroll-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          samples: entries.map((e) => ({
            t: e.t,
            st: e.scrollTop,
            sh: e.scrollHeight,
            ch: e.clientHeight,
            src: e.programmatic ? "prog" : "native",
            ...(e.stack ? { stack: e.stack } : {}),
          })),
        }),
      }).catch(() => {
        /* 取证上报失败静默 */
      });
    } catch {
      /* noop */
    }
  };

  const maybeReport = (now: number) => {
    if (now - lastReportAt < REPORT_THROTTLE_MS) return;
    lastReportAt = now;
    try {
      const size = Math.min(ringCursor, RING_CAPACITY);
      const entries: ProbeEntry[] = [];
      for (let i = size - 1; i >= 0 && entries.length < size; i--) {
        const e = ring[(ringCursor - 1 - i + RING_CAPACITY * 2) % RING_CAPACITY];
        if (e && now - e.t <= 1500) entries.unshift(e);
      }
      // 落盘：整段现场样本发给服务端（含完整栈），诊断包导出时带走
      if (entries.length > 0) shipToServer(entries);
      const prog = entries.filter((e) => e.programmatic);
      const tops = entries.map((e) => e.scrollTop);
      const heights = entries.map((e) => e.scrollHeight);
      const spread = (xs: number[]) =>
        xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
      console.warn(
        `[scroll-probe:${label}] ⚠️ 检测到高频滚动（1s 内 ${recentTs.length} 次）\n` +
          `程序写入=${prog.length}/${entries.length} | ` +
          `scrollTop 振幅=${spread(tops)}px | scrollHeight 振幅=${spread(heights)}px\n` +
          (prog.length > 0
            ? `高频写入方 TOP：\n${dedupStacks(prog)
                .slice(0, 3)
                .map(([k, v]) => `- x${v.count}: ${k}`)
                .join("\n")}`
            : `无程序写入 → 原生/布局层在拉扯（看 scrollHeight 振幅判断是否内容高度不稳）`),
      );
      // 完整栈手动导出
      (window as unknown as Record<string, unknown>).__scrollProbeDump = () => {
        console.table(
          entries.slice(-80).map((e) => ({
            t: e.t - now,
            st: e.scrollTop,
            sh: e.scrollHeight,
            ch: e.clientHeight,
            src: e.programmatic ? "prog" : "native",
          })),
        );
        for (const [, v] of dedupStacks(prog).slice(0, 5)) {
          console.log(`x${v.count}:\n${v.sample}`);
        }
        return `共 ${entries.length} 条样本`;
      };
      console.warn(
        "[scroll-probe] 完整样本已挂到 window.__scrollProbeDump()，随时可导出",
      );
    } catch {
      /* 探针自身绝不影响业务 */
    }
  };

  console.log(
    `[scroll-probe:${label}] 已挂载（抖动时自动报案；window.__scrollProbeDump() 导出完整样本）`,
  );

  return {
    detach: () => {
      scroller.removeEventListener("scroll", onScroll);
      delete (scroller as { scrollTop?: unknown }).scrollTop;
      try {
        delete (window as unknown as Record<string, unknown>)
          .__scrollProbeDump;
      } catch {
        /* noop */
      }
    },
  };
};
