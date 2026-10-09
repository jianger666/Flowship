/**
 * Flowship 性能报告：读 <dataRoot>/logs 下的结构化观测日志，按维度出分布与对比。
 *
 * 数据源（都是一行一条 JSON，按大小轮转为 file / file.1 / file.2 …）：
 * - run-perf.jsonl  每个 agent run 一行汇总（受理 / 首 token / 首工具 / 各工具聚合 / token / 受理前各阶段 /
 *                   MCP 探活 / 进程健康 / 会话规模 / 版本 / 防后台节流开关）
 * - warmup.jsonl    每次预热（窗口聚焦 / 输入框聚焦触发）的结果
 * - loop-lag.jsonl  Node 事件循环「慢秒」（某一秒内单次阻塞 ≥500ms）
 * - ui-perf.jsonl   渲染进程上报：长任务 / 慢交互 / 回前台追赶 / 页面规模
 *
 * 这里只有纯函数（buildReport / renderText / 文件读取），CLI 在 scripts/perf-report.mjs。
 * 隐私：这些日志本来就不含 prompt / 命令 / 路径，报告也只输出数字、枚举与工具名。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOG_FILES = {
  run: "run-perf.jsonl",
  ui: "ui-perf.jsonl",
  warmup: "warmup.jsonl",
  lag: "loop-lag.jsonl",
};

/**
 * 前端采集器默认心跳间隔（每 N 个可见且无信号的 interval 窗口出一条心跳）。
 * 必须与 src/lib/ui-perf-collector.ts 的 DEFAULT_HEARTBEAT_EVERY 一致（测试锁）。
 */
export const UI_HEARTBEAT_EVERY = 10;

/** 样本少于这个数的分组在报告里标「样本少」 */
export const DEFAULT_MIN_SAMPLES = 5;

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const col = (rows, fn) => rows.map(fn).filter(finite);

// ───────── 统计 ─────────

/** 线性插值分位（p ∈ [0,1]）；入参须升序 */
export const pctl = (sorted, p) => {
  if (sorted.length === 0) return undefined;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

/** 一组数的分布；非有限值丢弃；空 → { n: 0 } */
export const dist = (values) => {
  const xs = values.filter(finite).sort((a, b) => a - b);
  if (xs.length === 0) return { n: 0 };
  return {
    n: xs.length,
    p50: pctl(xs, 0.5),
    p90: pctl(xs, 0.9),
    p99: pctl(xs, 0.99),
    max: xs[xs.length - 1],
    mean: sum(xs) / xs.length,
  };
};

const groupBy = (arr, keyFn) => {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
};

// ───────── 分桶 ─────────

export const IDLE_BUCKETS = ["<1m", "1–5m", "5–30m", ">30m", "未知"];
/** 距该 task 上一个 run 结束的空闲时长（模型 prompt cache 约 5 分钟过期、连接 / MCP 探活也随空闲变冷） */
export const idleBucket = (ms) => {
  if (!finite(ms)) return "未知";
  if (ms < 60_000) return "<1m";
  if (ms < 300_000) return "1–5m";
  if (ms < 1_800_000) return "5–30m";
  return ">30m";
};

export const SCALE_BUCKETS = ["<1MB", "1–5MB", "5–20MB", "≥20MB", "未知"];
/** 该 agent 在 checkpoint store 里的体积（会话规模） */
export const scaleBucket = (mb) => {
  if (!finite(mb)) return "未知";
  if (mb < 1) return "<1MB";
  if (mb < 5) return "1–5MB";
  if (mb < 20) return "5–20MB";
  return "≥20MB";
};

const isSuccess = (r) => r.outcome === "ok" || r.outcome === "finished";

/** 预热后多久内发送算「享受到了预热」 */
export const WARMED_WITHIN_MS = 120_000;

// ───────── 各节计算 ─────────

const latencySection = (runs) => {
  const ok = runs.filter(isSuccess);
  return {
    // 受理耗时与 run 结果无关，统计所有已受理的；其余只统计成功的 run（失败 / 取消的时序没有可比性）
    acceptMs: dist(col(runs, (r) => r.acceptMs)),
    ttftMs: dist(col(ok, (r) => r.ttftMs)),
    firstToolMs: dist(col(ok, (r) => r.firstToolMs)),
    totalMs: dist(col(ok, (r) => r.totalMs)),
    thinkingMs: dist(col(ok, (r) => r.thinkingMs)),
  };
};

/**
 * 按 keyFn 分组并给出受理 / ttft 分布；order 给定则按它排序且只输出非空组。
 * @param {any[]} runs
 * @param {(r: any) => string} keyFn
 * @param {string[]} [order]
 */
const byKey = (runs, keyFn, order) => {
  const groups = groupBy(runs, keyFn);
  const keys = order ?? [...groups.keys()].sort();
  return keys
    .filter((k) => groups.has(k))
    .map((k) => {
      const rs = groups.get(k);
      const ok = rs.filter(isSuccess);
      return {
        key: k,
        n: rs.length,
        acceptMs: dist(col(rs, (r) => r.acceptMs)),
        ttftMs: dist(col(ok, (r) => r.ttftMs)),
      };
    });
};

const prepSection = (runs) => {
  const stages = new Map();
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.prep ?? {})) {
      if (!finite(v)) continue;
      if (!stages.has(k)) stages.set(k, []);
      stages.get(k).push(v);
    }
  }
  return [...stages.entries()]
    .map(([stage, vals]) => ({ stage, ...dist(vals) }))
    .sort((a, b) => (b.p90 ?? 0) - (a.p90 ?? 0));
};

const mcpSection = (runs) => {
  const rs = runs.filter((r) => r.mcp && finite(r.mcp.total));
  const total = sum(col(rs, (r) => r.mcp.total));
  const share = (field) =>
    total > 0 ? sum(col(rs, (r) => r.mcp[field])) / total : undefined;
  return {
    runs: rs.length,
    servers: total,
    hitRate: share("cacheHits"),
    freshShare: share("fresh"),
    staleShare: share("stale"),
    syncProbeShare: share("probedSync"),
    graceHits: sum(col(rs, (r) => r.mcp.staleRefreshedInGrace)),
    runsWithSyncProbe: rs.filter((r) => (r.mcp.probedSync ?? 0) > 0).length,
    waitMs: dist(col(rs, (r) => r.mcp.waitMs)),
  };
};

const warmupSection = (warmups, runs) => {
  const byStatus = {};
  const bySkip = {};
  for (const w of warmups) {
    byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
    if (w.status === "skipped" && w.reason) {
      bySkip[w.reason] = (bySkip[w.reason] ?? 0) + 1;
    }
  }
  const warmed = warmups.filter((w) => w.status === "warmed");

  // 预热效果：只在「空闲 ≥5 分钟或未知」的 run 里比（空闲短的本来就热、没有预热的用武之地）
  const coldish = runs.filter(
    (r) => !finite(r.idleBeforeMs) || r.idleBeforeMs >= 300_000,
  );
  const hit = coldish.filter(
    (r) => finite(r.warmedAgoMs) && r.warmedAgoMs <= WARMED_WITHIN_MS,
  );
  const miss = coldish.filter(
    (r) => !(finite(r.warmedAgoMs) && r.warmedAgoMs <= WARMED_WITHIN_MS),
  );
  const side = (rs) => {
    const ok = rs.filter(isSuccess);
    return {
      n: rs.length,
      acceptMs: dist(col(rs, (r) => r.acceptMs)),
      mcpStageMs: dist(col(rs, (r) => r.prep?.mcp)),
      mcpWaitMs: dist(col(rs, (r) => r.mcp?.waitMs)),
      ttftMs: dist(col(ok, (r) => r.ttftMs)),
    };
  };
  const warmedSide = side(hit);
  const coldSide = side(miss);
  const delta = (f) =>
    finite(warmedSide[f].p50) && finite(coldSide[f].p50)
      ? warmedSide[f].p50 - coldSide[f].p50
      : undefined;
  return {
    calls: warmups.length,
    byStatus,
    bySkip,
    totalMs: dist(col(warmed, (w) => w.totalMs)),
    mcpRefreshed: sum(col(warmed, (w) => w.mcp?.refreshed)),
    storePrefetchBlobs: sum(col(warmed, (w) => w.store?.blobs)),
    storePrefetchMB: sum(col(warmed, (w) => w.store?.bytes)) / 1048576,
    effect: {
      note: "仅统计空闲 ≥5 分钟或未知的 run；warmed = 发送前 2 分钟内被预热过。注意这是观察性对比（预热由用户聚焦窗口 / 输入框触发、不是随机分组），看趋势、别当因果",
      warmed: warmedSide,
      cold: coldSide,
      deltaP50: { acceptMs: delta("acceptMs"), mcpStageMs: delta("mcpStageMs"), ttftMs: delta("ttftMs") },
    },
  };
};

const toolSection = (runs, top = 15) => {
  const m = new Map();
  for (const r of runs) {
    for (const [name, a] of Object.entries(r.tools ?? {})) {
      const t = m.get(name) ?? {
        name,
        n: 0,
        errors: 0,
        wallSum: 0,
        wallMax: 0,
        execN: 0,
        execSum: 0,
        wallWithExec: 0,
      };
      t.n += a.n ?? 0;
      t.errors += a.errors ?? 0;
      t.wallSum += a.wallSum ?? 0;
      t.wallMax = Math.max(t.wallMax, a.wallMax ?? 0);
      if (finite(a.sdkExecSum)) {
        t.execN += a.n ?? 0;
        t.execSum += a.sdkExecSum;
        t.wallWithExec += a.wallSum ?? 0;
      }
      m.set(name, t);
    }
  }
  return [...m.values()]
    .sort((a, b) => b.wallSum - a.wallSum)
    .slice(0, top)
    .map((t) => ({
      name: t.name,
      n: t.n,
      errors: t.errors,
      errorRate: t.n > 0 ? t.errors / t.n : 0,
      totalMs: t.wallSum,
      avgMs: t.n > 0 ? t.wallSum / t.n : 0,
      maxMs: t.wallMax,
      // wall − SDK 自报的执行耗时 ≈ 平台 / 事件管线开销（仅 shell 有）
      sdkOverheadAvgMs:
        t.execN > 0 ? (t.wallWithExec - t.execSum) / t.execN : undefined,
    }));
};

const loopSection = (runs, lag) => ({
  runEldP99Max: dist(col(runs, (r) => r.proc?.eldP99Max)),
  runEldMax: dist(col(runs, (r) => r.proc?.eldMax)),
  runSlowSeconds: dist(col(runs, (r) => r.proc?.slowSeconds)),
  slowSecondEvents: {
    n: lag.length,
    maxMs: dist(col(lag, (l) => l.max)),
    gcMaxMs: dist(col(lag, (l) => l.gcMax)),
    withActiveRunsShare:
      lag.length > 0
        ? lag.filter((l) => (l.activeRuns ?? 0) > 0).length / lag.length
        : undefined,
    rssMB: dist(col(lag, (l) => l.rssMB)),
  },
});

const scaleSection = (runs) => ({
  byAgentSize: byKey(runs, (r) => scaleBucket(r.store?.agentMB), SCALE_BUCKETS),
  promptBytes: dist(col(runs, (r) => r.promptBytes)),
  agentMB: dist(col(runs, (r) => r.store?.agentMB)),
});

const napLabel = (v) => (v === true ? "开" : v === false ? "关" : "未知");
const napSection = (runs) => byKey(runs, (r) => napLabel(r.appNap), ["关", "开", "未知"]);

/** ui 窗口 [ts−windowMs, ts] 与同 task 的某个 run [ts−totalMs, ts] 是否重叠 */
const overlapsRun = (u, runsByTask) => {
  const rs = runsByTask.get(u.taskId);
  if (!rs) return false;
  const uEnd = Date.parse(u.ts);
  if (!finite(uEnd)) return false;
  const uStart = uEnd - (u.windowMs ?? 0);
  return rs.some((r) => {
    const rEnd = Date.parse(r.ts);
    if (!finite(rEnd) || !finite(r.totalMs)) return false;
    return rEnd >= uStart && rEnd - r.totalMs <= uEnd;
  });
};

const uiSummary = (rows) => ({
  windows: rows.length,
  longTaskN: sum(col(rows, (u) => u.longTasks?.n)),
  longTaskN250: sum(col(rows, (u) => u.longTasks?.n250)),
  longTaskMaxMs: dist(col(rows, (u) => u.longTasks?.maxMs)),
  slowInputN: sum(col(rows, (u) => u.inputs?.n200)),
});

/**
 * 流式代码块「限频高亮」的效果（前端上报附带的 highlight 字段，自上次上报以来的窗口统计）：
 * 摊薄比例 = 被摊薄的次数 / (被摊薄 + 实际交给 Shiki 的次数)；
 * 单次耗时 = 提交→回调（含排队），近似一次整块分词的成本。
 * 旧版本前端不带该字段、窗口内没流式代码块也不带——全空时返回 undefined。
 * @param {object[]} rows ui-perf 记录
 */
const highlightSection = (rows) => {
  const hs = rows
    .map((u) => u.highlight)
    .filter((h) => h && typeof h === "object" && finite(h.requests));
  if (hs.length === 0) return undefined;
  const submitted = sum(col(hs, (h) => h.submitted));
  const throttled = sum(col(hs, (h) => h.throttled));
  const costCount = sum(col(hs, (h) => h.costCount));
  return {
    windows: hs.length,
    requests: sum(col(hs, (h) => h.requests)),
    submitted,
    throttled,
    flushed: sum(col(hs, (h) => h.flushed)),
    forks: sum(col(hs, (h) => h.forks)),
    cacheHits: sum(col(hs, (h) => h.cacheHits)),
    throttledShare: submitted + throttled > 0 ? throttled / (submitted + throttled) : undefined,
    avgCostMs: costCount > 0 ? sum(col(hs, (h) => h.costSumMs)) / costCount : undefined,
    costMaxMs: dist(col(hs, (h) => h.costMaxMs)),
    slots: dist(col(hs, (h) => h.slots)),
  };
};

const uiSection = (ui, runs) => {
  const interval = ui.filter((u) => u.reason === "interval");
  const heartbeats = interval.filter((u) => u.heartbeat === true);
  const signal = interval.filter((u) => u.heartbeat !== true);
  const nonInterval = ui.filter((u) => u.reason !== "interval");
  const signalAll = ui.filter((u) => u.heartbeat !== true);
  // 只上报「有信号」的窗口 + 每 N 个无信号窗口一条心跳，所以不能直接算「每分钟长任务数」（分母缺了没卡的窗口）；
  // 但能估：卡顿窗口占比 ≈ 信号窗口 / (信号窗口 + N × 心跳数)
  const denom = signal.length + UI_HEARTBEAT_EVERY * heartbeats.length;

  const runsByTask = groupBy(runs, (r) => r.taskId);
  const withTask = signalAll.filter((u) => typeof u.taskId === "string");
  const during = withTask.filter((u) => overlapsRun(u, runsByTask));
  const outside = withTask.filter((u) => !overlapsRun(u, runsByTask));

  return {
    windows: ui.length,
    intervalWindows: interval.length,
    heartbeats: heartbeats.length,
    signalWindows: signal.length,
    nonIntervalSignalWindows: nonInterval.filter((u) => u.heartbeat !== true).length,
    estimatedJankWindowShare: denom > 0 ? signal.length / denom : undefined,
    longTasks: {
      total: sum(col(signalAll, (u) => u.longTasks?.n)),
      n250: sum(col(signalAll, (u) => u.longTasks?.n250)),
      maxMs: dist(col(signalAll, (u) => u.longTasks?.maxMs)),
      sumMs: dist(col(signalAll, (u) => u.longTasks?.sumMs)),
    },
    slowInputs: {
      windows: signalAll.filter((u) => (u.inputs?.n200 ?? 0) > 0).length,
      n200: sum(col(signalAll, (u) => u.inputs?.n200)),
      maxMs: dist(col(signalAll, (u) => u.inputs?.maxMs)),
    },
    afterShowMs: dist(col(signalAll, (u) => u.afterShowMs)),
    heapMB: dist(col(ui, (u) => u.heapMB)),
    domNodes: dist(col(ui, (u) => u.domNodes)),
    highlight: highlightSection(ui),
    duringStreaming: uiSummary(during),
    notStreaming: uiSummary(outside),
    byAppNap: ["关", "开", "未知"]
      .map((label) => ({
        key: label,
        ...uiSummary(signalAll.filter((u) => napLabel(u.appNap) === label)),
      }))
      .filter((x) => x.windows > 0),
  };
};

// ───────── 主入口 ─────────

/**
 * @param {{ run?: object[], ui?: object[], warmup?: object[], lag?: object[] }} input 已解析的记录
 * @param {{ sinceMs?: number, taskId?: string, minSamples?: number, parseErrors?: number, now?: number }} [opts]
 */
export const buildReport = (input, opts = {}) => {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const keep = (r, byTask) => {
    if (byTask && opts.taskId && r.taskId !== opts.taskId) return false;
    if (opts.sinceMs !== undefined) {
      const t = Date.parse(r.ts);
      if (!(t >= opts.sinceMs)) return false;
    }
    return true;
  };
  const runs = (input.run ?? []).filter((r) => keep(r, true));
  const ui = (input.ui ?? []).filter((r) => keep(r, true));
  const warmups = (input.warmup ?? []).filter((r) => keep(r, true));
  // loop-lag 是进程级、没有 taskId：只按时间过滤
  const lag = (input.lag ?? []).filter((r) => keep(r, false));

  const times = [...runs, ...ui, ...warmups, ...lag]
    .map((r) => Date.parse(r.ts))
    .filter(finite);
  const versions = {};
  for (const r of runs) {
    const v = r.version ?? "未知";
    versions[v] = (versions[v] ?? 0) + 1;
  }
  const outcomes = {};
  for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;

  const warnings = [];
  if (runs.length === 0) warnings.push("没有 run 记录（run-perf.jsonl 为空或被过滤掉了）");
  else if (runs.length < 30) {
    warnings.push(`run 样本较少（${runs.length}），分位数仅供参考`);
  }
  const abnormal = (outcomes["timeout"] ?? 0) + (outcomes["never-attached"] ?? 0);
  if (runs.length > 0 && abnormal / runs.length > 0.02) {
    warnings.push(
      `异常收口（timeout / never-attached）占 ${((abnormal / runs.length) * 100).toFixed(1)}%：看门狗在兜底，可能有 run 丢了终态`,
    );
  }
  if (Object.keys(versions).length > 1) {
    warnings.push(`混合了多个版本的数据：${Object.entries(versions).map(([v, n]) => `${v}×${n}`).join("、")}（升级前后对比时请用 --since 切开）`);
  }
  if ((opts.parseErrors ?? 0) > 0) {
    warnings.push(`有 ${opts.parseErrors} 行日志无法解析（已跳过）`);
  }

  return {
    meta: {
      generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
      range: times.length
        ? {
            from: new Date(Math.min(...times)).toISOString(),
            to: new Date(Math.max(...times)).toISOString(),
          }
        : undefined,
      counts: { run: runs.length, ui: ui.length, warmup: warmups.length, lag: lag.length },
      versions,
      minSamples,
      filter: { taskId: opts.taskId, sinceMs: opts.sinceMs },
    },
    outcomes,
    latency: latencySection(runs),
    byIdle: byKey(runs, (r) => idleBucket(r.idleBeforeMs), IDLE_BUCKETS),
    byPath: byKey(runs, (r) => r.tags?.path ?? "未知"),
    byKind: byKey(runs, (r) => r.kind ?? "未知"),
    prep: prepSection(runs),
    mcp: mcpSection(runs),
    warmup: warmupSection(warmups, runs),
    tools: toolSection(runs),
    loop: loopSection(runs, lag),
    scale: scaleSection(runs),
    appNap: napSection(runs),
    ui: uiSection(ui, runs),
    warnings,
  };
};

// ───────── 文本渲染 ─────────

export const fmtMs = (v) => {
  if (!finite(v)) return "-";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  return a >= 1000 ? `${sign}${(a / 1000).toFixed(2)}s` : `${sign}${Math.round(a)}ms`;
};
const pct = (v) => (finite(v) ? `${(v * 100).toFixed(1)}%` : "-");
const num = (v) => (finite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : "-");
/** 带符号的耗时差值：负 = 变快 */
export const fmtDelta = (v) => (finite(v) && v > 0 ? `+${fmtMs(v)}` : fmtMs(v));

/** 终端显示宽度：CJK / 全角字符占 2 列（中文标签对齐用） */
export const wlen = (s) => {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe4f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6));
    w += wide ? 2 : 1;
  }
  return w;
};
export const padW = (s, n) => s + " ".repeat(Math.max(0, n - wlen(s)));

const D = (d, min, unit = fmtMs) =>
  !d || d.n === 0
    ? "无数据"
    : `n=${d.n}  p50 ${unit(d.p50)}  p90 ${unit(d.p90)}  p99 ${unit(d.p99)}  max ${unit(d.max)}${d.n < min ? "  （样本少）" : ""}`;

export const renderText = (report) => {
  const min = report.meta.minSamples;
  const L = [];
  const h = (t) => L.push("", `■ ${t}`);
  const row = (label, d, unit) => L.push(`  ${padW(label, 16)} ${D(d, min, unit)}`);

  L.push(`Flowship 性能报告（生成于 ${report.meta.generatedAt}）`);
  const c = report.meta.counts;
  L.push(
    `数据：run ${c.run} 条 · 预热 ${c.warmup} 条 · 事件循环慢秒 ${c.lag} 条 · 前端上报 ${c.ui} 条` +
      (report.meta.range ? `\n范围：${report.meta.range.from} → ${report.meta.range.to}` : ""),
  );
  L.push(
    `版本：${Object.entries(report.meta.versions).map(([v, n]) => `${v}×${n}`).join("、") || "-"}`,
  );
  for (const w of report.warnings) L.push(`⚠ ${w}`);

  h("一、结果与整体延迟（耗时只统计成功收口的 run；受理统计所有已受理的）");
  L.push(`  结果分布：${Object.entries(report.outcomes).map(([k, n]) => `${k}×${n}`).join("  ") || "-"}`);
  row("受理 accept", report.latency.acceptMs);
  row("首 token ttft", report.latency.ttftMs);
  row("首个工具", report.latency.firstToolMs);
  row("整轮 total", report.latency.totalMs);
  row("思考 thinking", report.latency.thinkingMs);

  /** sub = true：同一节内的小标题（不另起 ■ 大节） */
  const groupLines = (title, groups, { sub = false } = {}) => {
    if (sub) L.push("", `  ▸ ${title}`);
    else h(title);
    if (groups.length === 0) return L.push("  无数据");
    for (const g of groups) {
      L.push(`  [${g.key}] n=${g.n}${g.n < min ? "（样本少）" : ""}`);
      L.push(`      受理 ${D(g.acceptMs, min)}`);
      L.push(`      ttft ${D(g.ttftMs, min)}`);
    }
  };
  groupLines("二、空闲越久越慢吗？（按距上个 run 结束的空闲时长分桶；>5 分钟模型 prompt cache 过期）", report.byIdle);
  groupLines("按发送路径（create 新建会话 / resume 恢复会话 / followup 等）", report.byPath, { sub: true });

  h("三、受理前各阶段耗时（按 p90 降序）与 MCP 探活");
  if (report.prep.length === 0) L.push("  无数据");
  for (const s of report.prep) {
    L.push(`  ${String(s.stage).padEnd(14)} ${D(s, min)}`);
  }
  const m = report.mcp;
  if (m.runs === 0) L.push("  MCP 探活：无数据");
  else {
    L.push(
      `  MCP 探活：${m.runs} 个 run、${m.servers} 个 server 次；无需同步等待 ${pct(m.hitRate)}` +
        `（fresh ${pct(m.freshShare)} + stale-while-revalidate ${pct(m.staleShare)}）；同步探测 ${pct(m.syncProbeShare)}` +
        `；${m.runsWithSyncProbe}/${m.runs} 个 run 至少同步探测过一次；grace 内当场拿到新结果 ${m.graceHits} 次`,
    );
    L.push(`  MCP 同步等待 ${D(m.waitMs, min)}`);
  }

  h("四、预热效果（窗口 / 输入框聚焦时后台刷新探活缓存 + 预读会话存储）");
  const w = report.warmup;
  if (w.calls === 0) L.push("  无预热记录");
  else {
    L.push(
      `  预热 ${w.calls} 次：${Object.entries(w.byStatus).map(([k, n]) => `${k}×${n}`).join("  ")}` +
        (Object.keys(w.bySkip).length ? `；跳过原因 ${Object.entries(w.bySkip).map(([k, n]) => `${k}×${n}`).join("  ")}` : "") +
        `；刷新探活 ${w.mcpRefreshed} 个 server，预读 store ${w.storePrefetchBlobs} 块 / ${w.storePrefetchMB.toFixed(1)}MB`,
    );
    L.push(`  预热耗时 ${D(w.totalMs, min)}`);
  }
  const e = w.effect;
  L.push(`  效果对比（${e.note}）：`);
  for (const [label, s] of [["享受到预热", e.warmed], ["没预热", e.cold]]) {
    L.push(`    ${label}：n=${s.n}${s.n < min ? "（样本少）" : ""}`);
    L.push(`      受理 ${D(s.acceptMs, min)}`);
    L.push(`      MCP 阶段 ${D(s.mcpStageMs, min)}`);
    L.push(`      ttft ${D(s.ttftMs, min)}`);
  }
  L.push(
    `    p50 差值（预热 − 没预热，负 = 变快）：受理 ${fmtDelta(e.deltaP50.acceptMs)}  MCP 阶段 ${fmtDelta(e.deltaP50.mcpStageMs)}  ttft ${fmtDelta(e.deltaP50.ttftMs)}`,
  );

  h("五、工具耗时 Top（按总耗时降序）");
  if (report.tools.length === 0) L.push("  无数据");
  for (const t of report.tools) {
    L.push(
      `  ${t.name.padEnd(22)} n=${String(t.n).padEnd(5)} 平均 ${fmtMs(t.avgMs).padEnd(8)} 最大 ${fmtMs(t.maxMs).padEnd(8)} 总计 ${fmtMs(t.totalMs).padEnd(9)} 失败 ${pct(t.errorRate)}` +
        (t.sdkOverheadAvgMs !== undefined ? `  平台开销均值 ${fmtMs(t.sdkOverheadAvgMs)}` : ""),
    );
  }

  h("六、Node 事件循环（server 进程被占住会让所有流式事件一起卡）");
  const lp = report.loop;
  row("run 内 ELD p99", lp.runEldP99Max);
  row("run 内 ELD max", lp.runEldMax);
  row("run 内慢秒数", lp.runSlowSeconds, num);
  const se = lp.slowSecondEvents;
  L.push(
    `  慢秒事件 ${se.n} 条` +
      (se.n > 0
        ? `；单次阻塞 ${D(se.maxMs, min)}；其中有 run 在跑的占 ${pct(se.withActiveRunsShare)}；GC 最大 ${D(se.gcMaxMs, min)}`
        : ""),
  );

  groupLines("七、会话规模对速度的影响（按该 agent 在 checkpoint store 的体积分桶）", report.scale.byAgentSize);
  L.push("");
  row("prompt 体积", report.scale.promptBytes, (v) => `${(v / 1024).toFixed(1)}KB`);
  row("agent 存储体积", report.scale.agentMB, (v) => `${num(v)}MB`);

  groupLines("八、防后台节流实验 A/B（关 = 默认；开需 touch PREVENT_APP_NAP 后重启）", report.appNap);

  h("九、前端流畅度（渲染进程上报；只记有信号的窗口 + 低频心跳）");
  const u = report.ui;
  if (u.windows === 0) L.push("  无数据");
  else {
    L.push(
      `  上报 ${u.windows} 条：信号窗口 ${u.signalWindows}、心跳 ${u.heartbeats}、切后台 / 离开时的信号 ${u.nonIntervalSignalWindows}` +
        `；估算卡顿窗口占比 ${pct(u.estimatedJankWindowShare)}（每条心跳 ≈ ${UI_HEARTBEAT_EVERY} 个没卡的窗口）`,
    );
    L.push(`  长任务：${u.longTasks.total} 次（≥250ms ${u.longTasks.n250} 次）；每窗口最长 ${D(u.longTasks.maxMs, min)}`);
    L.push(`  慢交互（≥200ms）：${u.slowInputs.n200} 次、涉及 ${u.slowInputs.windows} 个窗口；最长 ${D(u.slowInputs.maxMs, min)}`);
    L.push(`  回前台 3s 内追赶 ${D(u.afterShowMs, min)}`);
    L.push(`  页面规模：JS 堆 ${D(u.heapMB, min, (v) => `${Math.round(v)}MB`)}`);
    L.push(`            DOM 节点 ${D(u.domNodes, min, (v) => String(Math.round(v)))}`);
    if (u.highlight) {
      const x = u.highlight;
      L.push(
        `  流式代码块高亮：${x.windows} 条上报带有该统计，请求 ${x.requests} 次 → 实际交给 Shiki ${x.submitted} 次` +
          `（摊薄 ${pct(x.throttledShare)}）；单次耗时均值 ${fmtMs(x.avgCostMs)}，每条上报的最大值 ${D(x.costMaxMs, min)}`,
      );
    } else {
      L.push("  流式代码块高亮：无数据（没有流式渲染代码块、或上报来自旧版本）");
    }
    L.push(
      `  信号窗口落在流式期间 ${u.duringStreaming.windows} 个（长任务 ${u.duringStreaming.longTaskN} 次、≥250ms ${u.duringStreaming.longTaskN250} 次、慢交互 ${u.duringStreaming.slowInputN} 次）` +
        ` / 非流式期间 ${u.notStreaming.windows} 个（长任务 ${u.notStreaming.longTaskN} 次、≥250ms ${u.notStreaming.longTaskN250} 次、慢交互 ${u.notStreaming.slowInputN} 次）`,
    );
    for (const g of u.byAppNap) {
      L.push(`  防节流=${g.key}：信号窗口 ${g.windows}、长任务 ${g.longTaskN} 次（≥250ms ${g.longTaskN250}）、慢交互 ${g.slowInputN} 次`);
    }
  }
  L.push("");
  return L.join("\n");
};

// ───────── 读取 ─────────

/**
 * 读 base 及其轮转文件（base.N … base.1、base；旧→新），逐行 JSON.parse；坏行计数跳过。
 */
export const readJsonl = async (dir, base) => {
  const records = [];
  let errors = 0;
  const names = [];
  for (let i = 5; i >= 1; i--) names.push(`${base}.${i}`);
  names.push(base);
  for (const name of names) {
    let text;
    try {
      text = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o === "object" && !Array.isArray(o)) records.push(o);
        else errors += 1;
      } catch {
        errors += 1;
      }
    }
  }
  return { records, errors };
};

/** 读全部四类日志 */
export const loadLogs = async (dir) => {
  const [run, ui, warmup, lag] = await Promise.all([
    readJsonl(dir, LOG_FILES.run),
    readJsonl(dir, LOG_FILES.ui),
    readJsonl(dir, LOG_FILES.warmup),
    readJsonl(dir, LOG_FILES.lag),
  ]);
  return {
    input: { run: run.records, ui: ui.records, warmup: warmup.records, lag: lag.records },
    parseErrors: run.errors + ui.errors + warmup.errors + lag.errors,
  };
};

/**
 * 默认日志目录：FLOWSHIP_DATA_DIR/logs，否则按平台推断的 userData/fe-ai-flow/data/logs
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @param {string} [home]
 */
export const defaultLogsDir = (
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) => {
  if (env.FLOWSHIP_DATA_DIR) return path.join(env.FLOWSHIP_DATA_DIR, "logs");
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "fe-ai-flow", "data", "logs");
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "fe-ai-flow", "data", "logs");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "fe-ai-flow", "data", "logs");
};

/** "7d" / "24h" / "90m" / ISO 日期 → epoch ms；无效抛错 */
export const parseSince = (s, now = Date.now()) => {
  const m = /^(\d+)\s*([dhm])$/i.exec(String(s).trim());
  if (m) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2].toLowerCase()];
    return now - Number(m[1]) * unit;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`无法解析 --since：${s}（示例：7d、24h、90m、2026-10-09）`);
  return t;
};
