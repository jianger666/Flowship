/**
 * 启动诊断三件套（纯函数 + 依赖注入，无 electron 依赖，可被 vitest 直接单测）。
 *
 * 目的：Windows 慢机器「启动慢 / 首页慢」只靠几条零散日志分不清慢在哪一段。这里补三类取证，
 * 全部只观察、不改任何行为，结果在首页亮出后一次性写进 main.log（诊断包会带上）：
 *
 * 1. 时间线（createBootTimeline）：各里程碑距「主进程启动」的秒数 + 相邻两段的差值。
 *    基准是 process.uptime()，所以第一个里程碑 appReady 本身就包含了「Flowship.exe 被杀软扫描 +
 *    Chromium 初始化 + 加载 main.js」这一段（点图标到我们的第一行代码跑起来）。
 * 2. 主线程卡顿（createLagMonitor）：setInterval 的实际间隔减去期望间隔 = 主线程被占住的时间。
 *    杀软在同步 fs 调用上拦截会让整个主进程卡住（窗口无响应），这是它唯一的可观测信号。
 * 3. 首页请求明细（createRequestRecorder）：首页加载期间每个本机请求的首字节 / 总耗时。
 *    server 就绪后到首页可用之间还有十几秒（冷读路由模块），要靠它看是哪几个接口 / 静态资源在拖。
 *    只记路径（不含查询串）、不记请求头 / 正文。
 */

// ---------- 1. 时间线 ----------

/**
 * @param {{ now?: () => number }} [opts] now 返回「距进程启动的秒数」，单测注入
 */
export const createBootTimeline = ({ now = () => process.uptime() } = {}) => {
  /** @type {Map<string, number>} */
  const marks = new Map();
  return {
    /** 同名里程碑只记第一次（重试 / 多次触发不覆盖最早的时间点）。 */
    mark(name) {
      if (!marks.has(name)) marks.set(name, now());
    },
    has: (name) => marks.has(name),
    get: (name) => marks.get(name),
    /** 按发生时间排序后的 [名字, 秒] 列表。 */
    entries() {
      return [...marks].sort((a, b) => a[1] - b[1]);
    },
    /** 一行：name=12.3s(+4.5) …，括号里是距上一个里程碑的差值——「慢在哪一段」直接读出来。 */
    summary() {
      const list = this.entries();
      if (list.length === 0) return "（无）";
      let prev = 0;
      return list
        .map(([name, sec]) => {
          const out = `${name}=${sec.toFixed(1)}s(+${(sec - prev).toFixed(1)})`;
          prev = sec;
          return out;
        })
        .join(" ");
    },
  };
};

// ---------- 2. 主线程卡顿 ----------

/**
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] 采样间隔
 * @param {number} [opts.stallMs] 单次延迟达到这个值算一次「卡顿」
 * @param {() => number} [opts.now] 毫秒级单调时钟，单测注入
 * @param {typeof setInterval} [opts.setIntervalFn] 单测注入
 * @param {typeof clearInterval} [opts.clearIntervalFn] 单测注入
 */
export const createLagMonitor = ({
  intervalMs = 50,
  stallMs = 250,
  now = () => performance.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) => {
  let timer = null;
  let last = 0;
  let maxMs = 0;
  let stalls = 0;
  let samples = 0;
  let totalLagMs = 0;
  const tick = () => {
    const t = now();
    // 期望 intervalMs 后触发；多出来的部分就是事件循环被占住的时间
    const lag = Math.max(0, t - last - intervalMs);
    last = t;
    samples++;
    totalLagMs += lag;
    if (lag > maxMs) maxMs = lag;
    if (lag >= stallMs) stalls++;
  };
  return {
    start() {
      if (timer) return;
      last = now();
      timer = setIntervalFn(tick, intervalMs);
      // 观测用的定时器不能拖住进程退出
      if (timer && typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
    snapshot: () => ({ maxMs, stalls, samples, totalLagMs, intervalMs, stallMs }),
  };
};

export const formatLagSummary = (s) =>
  `mainLoop maxLag=${Math.round(s.maxMs)}ms stalls(>=${s.stallMs}ms)=${s.stalls} ` +
  `totalLag=${(s.totalLagMs / 1000).toFixed(1)}s samples=${s.samples}`;

// ---------- 3. 首页请求明细 ----------

const percentile = (sortedAsc, p) => {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
};

/** 只留路径、不要查询串 / hash（可能带 token），并截断。 */
const pathOf = (url) => {
  try {
    return new URL(url).pathname.slice(0, 100) || "/";
  } catch {
    return String(url).split(/[?#]/)[0].slice(0, 100);
  }
};

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now] 毫秒级单调时钟，单测注入
 * @param {number} [opts.maxEntries] 记录条数上限（防止长时间运行内存涨）
 */
export const createRequestRecorder = ({ now = () => performance.now(), maxEntries = 800 } = {}) => {
  /** @type {Map<number|string, {path: string, type: string, start: number, ttfb: number|null, status: number, fromCache: boolean, total?: number, error?: string|null}>} */
  const inflight = new Map();
  const done = [];
  let dropped = 0;
  let maxConcurrent = 0;
  let firstStart = null;
  let lastEnd = null;
  let errors = 0;

  return {
    /** 请求发出。同一个 id 重复触发（重定向）保留最早的起点。 */
    start(id, url, type) {
      if (inflight.has(id)) return;
      if (done.length + inflight.size >= maxEntries) {
        dropped++;
        return;
      }
      const t = now();
      if (firstStart === null) firstStart = t;
      inflight.set(id, {
        path: pathOf(url),
        type: type || "?",
        start: t,
        ttfb: null,
        status: 0,
        fromCache: false,
      });
      if (inflight.size > maxConcurrent) maxConcurrent = inflight.size;
    },
    responseStarted(id, status, fromCache) {
      const e = inflight.get(id);
      if (!e || e.ttfb !== null) return;
      e.ttfb = now() - e.start;
      e.status = Number(status) || 0;
      e.fromCache = Boolean(fromCache);
    },
    /**
     * @param {number|string} id
     * @param {{ error?: string | null }} [opts]
     */
    finish(id, { error = null } = {}) {
      const e = inflight.get(id);
      if (!e) return;
      inflight.delete(id);
      const t = now();
      e.total = t - e.start;
      e.error = error;
      if (error) errors++;
      lastEnd = t;
      done.push(e);
    },
    snapshot({ top = 8 } = {}) {
      const t = now();
      // 还没结束的也算进去（总耗时 = 到现在为止），否则「一直没回来」的请求反而看不见
      const pending = [...inflight.values()].map((e) => ({ ...e, total: t - e.start, pending: true }));
      const all = [...done, ...pending];
      const byType = {};
      for (const e of all) byType[e.type] = (byType[e.type] || 0) + 1;
      const ttfbs = done
        .filter((e) => e.ttfb !== null)
        .map((e) => e.ttfb)
        .sort((a, b) => a - b);
      const slowest = [...all]
        .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
        .slice(0, top)
        .map((e) => ({
          path: e.path,
          type: e.type,
          status: e.status,
          ttfbMs: e.ttfb,
          totalMs: e.total ?? 0,
          pending: Boolean(e.pending),
          error: e.error || null,
        }));
      return {
        n: done.length,
        pending: inflight.size,
        errors,
        dropped,
        maxConcurrent,
        spanMs: firstStart !== null && lastEnd !== null ? lastEnd - firstStart : 0,
        byType,
        ttfbP50: percentile(ttfbs, 50),
        ttfbP95: percentile(ttfbs, 95),
        ttfbMax: ttfbs.length ? ttfbs[ttfbs.length - 1] : 0,
        slowest,
      };
    },
  };
};

/** 多行日志：第一行汇总、后面每个慢请求一行（路径只含 URL 路径部分）。 */
export const formatRequestSummary = (s) => {
  const types =
    Object.entries(s.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(",") || "（无）";
  const lines = [
    `requests done=${s.n} pending=${s.pending} errors=${s.errors} dropped=${s.dropped} ` +
      `maxConcurrent=${s.maxConcurrent} span=${(s.spanMs / 1000).toFixed(1)}s ` +
      `ttfb p50=${Math.round(s.ttfbP50)}ms p95=${Math.round(s.ttfbP95)}ms max=${Math.round(s.ttfbMax)}ms ` +
      `byType=${types}`,
  ];
  s.slowest.forEach((e, i) => {
    const ttfb = e.ttfbMs === null ? "-" : `${Math.round(e.ttfbMs)}ms`;
    lines.push(
      `req-slow #${i + 1} total=${Math.round(e.totalMs)}ms ttfb=${ttfb} status=${e.status} type=${e.type}` +
        `${e.pending ? " PENDING" : ""}${e.error ? ` error=${e.error}` : ""} ${e.path}`,
    );
  });
  return lines;
};
