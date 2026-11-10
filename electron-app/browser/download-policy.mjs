/**
 * 下载放行策略（评审 R1-10）：纯函数、不 import electron，可直接单测。
 *
 * 下载一律落到系统「下载」目录（路径不由页面决定，见 index.mjs），但「要不要落」此前完全由页面说了算：
 * 一个页面脚本可以不经任何用户操作就往用户磁盘上写任意多、任意大的文件（drive-by download / 磁盘填满）。
 * 这里加三道闸：
 *  1. 没有用户手势（`item.hasUserGesture() === false`）且不是「浏览器自己发起」的：拦。真 Electron 实测（scripts/browser-e2e/r1-lifecycle.cjs）：
 *     AI 经 CDP 派发的点击、用户真点、点击后 1~2 秒内异步触发的下载都是 true；页面 setTimeout 里自己 a.click() 是 false；
 *     **browser_navigate 直达附件 URL、点 target=_blank 的下载链接、点击里 window.open(下载URL) 也是 false**（R2 复审实测：
 *     这三条都走 tab.navigate → wc.loadURL，对 Chromium 来说是 browser-initiated 导航，不带手势）。它们不是页面脚本自己发起的
 *     （前者是 AI 的工具调用；后两者新标签页的创建已在 session 层过了「opener 最近有真实手势」那道闸），所以由 tab 记下
 *     「这次导航是我们发起的」，匹配到同一个 URL 的下载按 browserInitiated 放行（一次性，见 BrowserTab.consumeBrowserInitiatedDownload）；
 *  2. 声明的总大小超过上限（未知大小 = 0，下载过程中再按已收字节兜底，见 exceedsSizeCap）；
 *  3. 同一会话同时在途 / 一分钟内新开的下载过多。
 */

/** 单个下载的字节上限：2GB（够下常见安装包 / 数据集，又不会无声无息填满磁盘） */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
/** 同一会话同时在途的下载数上限 */
export const MAX_ACTIVE_DOWNLOADS = 5;
/** 同一会话滑动窗口内新开下载数上限 */
export const MAX_DOWNLOADS_PER_WINDOW = 10;
export const DOWNLOAD_WINDOW_MS = 60_000;
/** 同一会话「暂停 / interrupted（可恢复）」下载数上限（R3-07 ③）：这类下载不占并发名额，但不能无限累积 */
export const MAX_PAUSED_DOWNLOADS = 20;

/**
 * @param {{
 *   hasUserGesture: boolean | undefined,
 *   browserInitiated?: boolean,
 *   navExpired?: boolean,
 *   totalBytes: number,
 *   activeCount: number,
 *   recentCount: number,
 * }} input hasUserGesture 取不到（undefined，老版本 Electron 无该 API）按放行处理，不能因此误杀所有下载；
 *   navExpired：这个下载的 URL 恰好对应一个已过期的「浏览器发起的导航」令牌（只用来把拦截文案说准：是超时、不是页面偷偷下载）
 * @returns {{ allow: true } | { allow: false, reason: string, code: "no-gesture" | "nav-expired" | "too-large" | "too-many-active" | "too-frequent" }}
 */
export const decideDownload = ({ hasUserGesture, browserInitiated = false, navExpired = false, totalBytes, activeCount, recentCount }) => {
  if (hasUserGesture === false && browserInitiated !== true) {
    if (navExpired === true) {
      return {
        allow: false,
        code: "nav-expired",
        reason: "这次由浏览器发起的导航等了太久才开始下载，授权已过期（已拦截；请重新导航到该文件，或点击页面上的下载按钮）",
      };
    }
    return { allow: false, code: "no-gesture", reason: "页面没有经过用户操作就自动发起了下载（已拦截；需要下载请点击页面上的下载按钮）" };
  }
  if (Number.isFinite(totalBytes) && totalBytes > MAX_DOWNLOAD_BYTES) {
    return { allow: false, code: "too-large", reason: `文件过大（超过 ${Math.round(MAX_DOWNLOAD_BYTES / 1024 ** 3)}GB 上限）` };
  }
  if (activeCount >= MAX_ACTIVE_DOWNLOADS) {
    return { allow: false, code: "too-many-active", reason: `同时进行的下载过多（上限 ${MAX_ACTIVE_DOWNLOADS} 个），请等当前下载完成` };
  }
  if (recentCount >= MAX_DOWNLOADS_PER_WINDOW) {
    return { allow: false, code: "too-frequent", reason: `下载过于频繁（${DOWNLOAD_WINDOW_MS / 1000} 秒内超过 ${MAX_DOWNLOADS_PER_WINDOW} 个）` };
  }
  return { allow: true };
};

/** 下载过程中的字节兜底：声明大小为 0（未知）的流式下载也不能无限写 */
export const exceedsSizeCap = (receivedBytes) => Number.isFinite(receivedBytes) && receivedBytes > MAX_DOWNLOAD_BYTES;

/**
 * 滑动窗口计数器（每个 key 一份，如会话 taskId）：count 会先淘汰过期的，record 记一笔。
 * @param {{ now?: () => number }} [deps]
 */
export const createDownloadWindow = ({ now = Date.now } = {}) => {
  /** @type {Map<string, number[]>} */
  const times = new Map();
  const prune = (key) => {
    const t = now();
    const list = (times.get(key) ?? []).filter((x) => t - x < DOWNLOAD_WINDOW_MS);
    if (list.length === 0) times.delete(key);
    else times.set(key, list);
    return list;
  };
  return {
    count: (key) => prune(key).length,
    record: (key) => {
      const list = prune(key);
      list.push(now());
      times.set(key, list);
    },
  };
};

/** 同一会话的「下载被拦截」记录最小间隔（R1-10 复审②）：页面循环触发时每次都写日志 / 活动条目 / 推状态不可接受 */
export const BLOCK_REPORT_INTERVAL_MS = 5_000;

/**
 * 拦截记录节流：cancel 必须每次都做（否则 Electron 弹原生另存为），但「记录」按间隔节流。
 * key 由调用方组成「会话|原因」（R3-07 ②：不同原因各记各的——页面的无手势自动下载不能吞掉用户真点的那次「文件过大」）。
 * hit(key) → { report, suppressed }：report=true 才写日志 / 活动条目 / 推状态；suppressed = 自上次报告以来被吞掉的次数（报告时清零）。
 * 被吞掉的计数不会石沉大海：有 onFlush 时，第一次吞掉就起一个定时器，到点（距上次报告 intervalMs）把累计次数交给 onFlush；
 * drop(prefix) 在会话销毁时把该会话所有 key（`prefix` 或 `prefix|…`）的未报告计数也先交给 onFlush 再清掉。
 * @param {{
 *   now?: () => number,
 *   intervalMs?: number,
 *   onFlush?: (key: string, suppressed: number) => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (t: unknown) => void,
 * }} [deps]
 */
export const createBlockThrottle = ({
  now = Date.now,
  intervalMs = BLOCK_REPORT_INTERVAL_MS,
  onFlush,
  setTimer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t?.unref?.();
    return t;
  },
  clearTimer = (t) => clearTimeout(t),
} = {}) => {
  /** @type {Map<string, { at: number, suppressed: number, timer: unknown }>} */
  const state = new Map();
  const flush = (key) => {
    const cur = state.get(key);
    if (!cur) return;
    cur.timer = null;
    if (cur.suppressed > 0) {
      const n = cur.suppressed;
      cur.suppressed = 0;
      cur.at = now();
      try {
        onFlush?.(key, n);
      } catch {
        /* 记录失败不影响下载策略 */
      }
    }
  };
  return {
    hit: (key) => {
      const t = now();
      const cur = state.get(key);
      if (!cur || t - cur.at >= intervalMs) {
        if (cur?.timer) clearTimer(cur.timer);
        state.set(key, { at: t, suppressed: 0, timer: null });
        return { report: true, suppressed: cur?.suppressed ?? 0 };
      }
      cur.suppressed += 1;
      if (onFlush && !cur.timer) cur.timer = setTimer(() => flush(key), Math.max(0, intervalMs - (t - cur.at)));
      return { report: false, suppressed: cur.suppressed };
    },
    drop: (prefix) => {
      for (const key of [...state.keys()]) {
        if (key !== prefix && !key.startsWith(`${prefix}|`)) continue;
        const cur = state.get(key);
        if (cur?.timer) clearTimer(cur.timer);
        if (cur && cur.suppressed > 0) {
          try {
            onFlush?.(key, cur.suppressed);
          } catch {
            /* 同上 */
          }
        }
        state.delete(key);
      }
    },
  };
};
