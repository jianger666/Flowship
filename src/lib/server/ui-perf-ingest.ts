/**
 * 前端流畅度上报的服务端入口（POST /api/perf/ui）：纯逻辑、依赖注入，路由只是薄壳。
 *
 * 前端发来的东西一律不可信（旧版本 / 畸形 / 恶意）：
 * - 只落白名单字段，多余字段（哪怕是 prompt / url / userAgent）一律丢弃
 * - 数值裁剪到合理范围；非有限数 / 类型错误拒绝整条（必填字段）或省略（可选字段）
 * - 每分钟最多落 N 条，超了静默丢弃——观测不能反过来拖垮应用
 * - 体积上限 4KB
 *
 * 落盘到 <dataRoot>/logs/ui-perf.jsonl（按大小轮转，见 perf-journal），
 * 并带上 server 进程知道的版本号与防后台节流实验开关——前端渲染进程的节流设置
 * 正是该实验最主要的影响对象，A/B 对比需要这个字段。
 */
import { appendPerfRecord } from "./perf-journal";

export const MAX_UI_PERF_BODY_BYTES = 4096;

const REASONS = new Set(["interval", "hidden", "pagehide", "switch"]);
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_RE = /^[\w.+-]{1,32}$/;

const MAX_WINDOW_MS = 86_400_000;
const MAX_DURATION_MS = 3_600_000;
const MAX_COUNT = 1_000_000;
const MAX_HEAP_MB = 1_000_000;
const MAX_DOM_NODES = 100_000_000;

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const finite = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);

const clamp = (n: number, max: number): number => Math.min(max, Math.max(0, n));

/** 必填数值：非有限 → undefined（调用方据此拒绝整条） */
const req = (x: unknown, max: number): number | undefined =>
  finite(x) ? clamp(x, max) : undefined;

/** 可选数值：类型不对 → 省略 */
const opt = (x: unknown, max: number): number | undefined =>
  finite(x) ? clamp(x, max) : undefined;

const HIGHLIGHT_COUNT_KEYS = [
  "passthrough",
  "cacheHits",
  "submitted",
  "throttled",
  "flushed",
  "forks",
  "costCount",
  "slots",
] as const;
const HIGHLIGHT_MS_KEYS = ["costSumMs", "costMaxMs"] as const;

/**
 * 流式代码块高亮统计：requests 合法才收（它是「有没有在流式渲染代码块」的判据），
 * 其余字段各自可选、多余字段丢弃；旧版本前端不带这个字段是正常的。
 */
const sanitizeHighlight = (raw: unknown): Obj | undefined => {
  if (!isObj(raw)) return undefined;
  const requests = req(raw.requests, MAX_COUNT);
  if (requests === undefined) return undefined;
  const out: Obj = { requests };
  for (const k of HIGHLIGHT_COUNT_KEYS) {
    const v = opt(raw[k], MAX_COUNT);
    if (v !== undefined) out[k] = v;
  }
  for (const k of HIGHLIGHT_MS_KEYS) {
    const v = opt(raw[k], MAX_DURATION_MS);
    if (v !== undefined) out[k] = v;
  }
  return out;
};

/** 校验并清洗；null = 整条丢弃 */
export const sanitizeUiPerfSample = (raw: unknown): Obj | null => {
  if (!isObj(raw)) return null;
  if (raw.v !== 1) return null;
  if (typeof raw.reason !== "string" || !REASONS.has(raw.reason)) return null;

  const windowMs = req(raw.windowMs, MAX_WINDOW_MS);
  const visibleMs = req(raw.visibleMs, MAX_WINDOW_MS);
  if (windowMs === undefined || visibleMs === undefined) return null;

  const lt = raw.longTasks;
  const inp = raw.inputs;
  if (!isObj(lt) || !isObj(inp)) return null;
  const ltN = req(lt.n, MAX_COUNT);
  const ltSum = req(lt.sumMs, MAX_DURATION_MS);
  const ltMax = req(lt.maxMs, MAX_DURATION_MS);
  const ltN100 = req(lt.n100, MAX_COUNT);
  const ltN250 = req(lt.n250, MAX_COUNT);
  const inN = req(inp.n, MAX_COUNT);
  const inP50 = req(inp.p50Ms, MAX_DURATION_MS);
  const inMax = req(inp.maxMs, MAX_DURATION_MS);
  const inN200 = req(inp.n200, MAX_COUNT);
  if (
    ltN === undefined ||
    ltSum === undefined ||
    ltMax === undefined ||
    ltN100 === undefined ||
    ltN250 === undefined ||
    inN === undefined ||
    inP50 === undefined ||
    inMax === undefined ||
    inN200 === undefined
  ) {
    return null;
  }

  const out: Obj = {
    v: 1,
    reason: raw.reason,
    windowMs,
    visibleMs,
    longTasks: { n: ltN, sumMs: ltSum, maxMs: ltMax, n100: ltN100, n250: ltN250 },
    inputs: { n: inN, p50Ms: inP50, maxMs: inMax, n200: inN200 },
  };
  const afterShowMs = opt(raw.afterShowMs, MAX_DURATION_MS);
  if (afterShowMs !== undefined) out.afterShowMs = afterShowMs;
  if (raw.heartbeat === true) out.heartbeat = true;
  const heapMB = opt(raw.heapMB, MAX_HEAP_MB);
  if (heapMB !== undefined) out.heapMB = heapMB;
  const domNodes = opt(raw.domNodes, MAX_DOM_NODES);
  if (domNodes !== undefined) out.domNodes = domNodes;
  const highlight = sanitizeHighlight(raw.highlight);
  if (highlight) out.highlight = highlight;
  if (typeof raw.taskId === "string" && TASK_ID_RE.test(raw.taskId)) {
    out.taskId = raw.taskId;
  }
  return out;
};

/** 固定窗口限频；被拒绝的请求不占名额 */
export const createIngestLimiter = (opts: { max: number; windowMs: number }) => {
  let start = Number.NEGATIVE_INFINITY;
  let count = 0;
  return {
    allow(now: number): boolean {
      if (now - start >= opts.windowMs) {
        start = now;
        count = 0;
      }
      if (count >= opts.max) return false;
      count += 1;
      return true;
    },
  };
};

export interface UiPerfIngestDeps {
  now: () => number;
  limiter: { allow: (now: number) => boolean };
  record: (file: string, rec: Record<string, unknown>) => void;
  env: Record<string, string | undefined>;
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/**
 * 处理一次上报。204 = 收下（含被限频静默丢弃——不让前端重试）；
 * 400 = 坏 JSON / 字段不合法；413 = 超体积。
 */
export const handleUiPerfPost = (
  text: string,
  deps: UiPerfIngestDeps,
): { status: 204 | 400 | 413 } => {
  if (text.length > MAX_UI_PERF_BODY_BYTES || byteLength(text) > MAX_UI_PERF_BODY_BYTES) {
    return { status: 413 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 400 };
  }
  const sample = sanitizeUiPerfSample(parsed);
  if (!sample) return { status: 400 };
  if (!deps.limiter.allow(deps.now())) return { status: 204 };

  const version = deps.env.FLOWSHIP_APP_VERSION;
  if (typeof version === "string" && VERSION_RE.test(version)) {
    sample.version = version;
  }
  const nap = deps.env.FLOWSHIP_PREVENT_APP_NAP;
  if (typeof nap === "string" && nap.length > 0) sample.appNap = nap === "1";

  try {
    deps.record("ui-perf.jsonl", sample);
  } catch {
    /* 观测写失败不外泄 */
  }
  return { status: 204 };
};

const G = globalThis as unknown as {
  __feUiPerfLimiter?: ReturnType<typeof createIngestLimiter>;
};

/** 路由用的默认依赖：限频器挂 globalThis（dev HMR / 多 chunk 下共享同一个计数） */
export const defaultUiPerfDeps = (): UiPerfIngestDeps => ({
  now: () => Date.now(),
  limiter: (G.__feUiPerfLimiter ??= createIngestLimiter({
    max: 20,
    windowMs: 60_000,
  })),
  record: (file, rec) => appendPerfRecord(file, rec),
  env: process.env,
});
