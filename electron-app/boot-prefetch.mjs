/**
 * 首次启动「并行预读」（纯函数 + 依赖注入，无 electron 依赖，可被 vitest 直接单测）。
 *
 * 背景：Windows 上 server 冷启动慢，慢的是「第一次碰到这批文件」——杀软 / Defender 对每个刚写盘的文件
 * 逐个放行（首次启动到可用要读 ~850 个文件）。而 Node 的 require 是**同步串行读**：
 * 每个文件的放行延迟 L 被一个接一个累加（总耗时 ≈ N×L），多核 / 多线程的杀软白白闲着。
 *
 * 做法：壳在拉起 server 之前，按构建期录好的「启动文件清单」用有限并发把这批文件先读一遍。
 * 杀软的放行结果被缓存后，server 再读就是热的；清单里的文件本来就是 server 一定会读的，
 * 所以预读不增加杀软的总工作量，只是把串行延迟摊开成并发。
 *
 * 边界（全部为了「预读本身绝不能比不预读更糟」）：
 * - 只读、失败静默（单个文件失败不影响其它、整体异常也只记日志）；
 * - 并发有上限（默认 8）：libuv 线程池是进程内共享的，开太大会堵住主进程自己的异步 fs；
 * - 有总时限（默认 90s）：杀软卡死时不会无限占着线程池；到点停止、不再派新文件；
 * - 只预读清单里的文件、且必须落在 server 目录内（清单是数据，不信任）；
 * - 只在 Windows + 首次启动（全新安装 / 刚更新）才跑；环境变量 FLOWSHIP_NO_PREFETCH=1 可关。
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

/** 清单文件名：构建期由 scripts/gen-boot-manifest.mjs 写在 app-server 根目录。 */
export const BOOT_MANIFEST_FILENAME = "boot-manifest.json";

/** 同时在途的读取数。线程池默认 4 个线程，8 = 把队列塞满又不至于饿死主进程的其它异步 fs。 */
export const PREFETCH_CONCURRENCY = 8;

/** 总时限：到点不再派新文件（在途的会自然结束）。 */
export const PREFETCH_DEADLINE_MS = 90_000;

/** 清单条数上限（清单是数据，防坏文件让我们读一辈子）。实测一份完整清单约 1.3k 条。 */
export const PREFETCH_MAX_FILES = 6_000;

/** 单文件体积上限：更大的不预读（清单里本来也不该有）。 */
export const PREFETCH_MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * 要不要预读：只有 Windows 首次启动才值得（Mac 没有杀软首扫问题；非首次启动文件早已被放行缓存）。
 * @param {{platform: string, firstBoot: boolean, env?: Record<string, string|undefined>}} p
 */
export const shouldPrefetch = ({ platform, firstBoot, env = {} }) =>
  platform === "win32" && firstBoot === true && env.FLOWSHIP_NO_PREFETCH !== "1";

/**
 * 解析并校验清单原文。任何不符合预期的形状都返回 null（调用方当「没有清单」处理）。
 * 清单里的路径必须是相对路径（POSIX 分隔）、不含 `..`、不含盘符——否则整条丢弃，不是整份报废。
 * @param {string|null|undefined} raw
 * @returns {{files: string[]}|null}
 */
export const parseBootManifest = (raw) => {
  if (typeof raw !== "string" || raw === "") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.files)) return null;
  const files = [];
  const seen = new Set();
  for (const item of data.files) {
    if (files.length >= PREFETCH_MAX_FILES) break;
    if (typeof item !== "string" || item === "") continue;
    if (item.includes("\\") || item.includes("\0") || item.startsWith("/")) continue;
    if (/^[a-zA-Z]:/.test(item)) continue;
    if (item.split("/").some((seg) => seg === ".." || seg === "")) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    files.push(item);
  }
  return files.length > 0 ? { files } : null;
};

/**
 * 默认读取：整文件读进内存即丢（目的是触发杀软放行 + 暖页缓存），返回字节数。
 * 超过体积上限的不读（返回 -1 记为跳过）。
 */
const defaultReadFile = async (absPath) => {
  const stat = await fsp.stat(absPath);
  if (!stat.isFile() || stat.size > PREFETCH_MAX_FILE_BYTES) return -1;
  const buf = await fsp.readFile(absPath);
  return buf.length;
};

const percentile = (sortedAsc, p) => {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
};

/**
 * 并行预读。永不抛错（异常都计入 failed）。
 * @param {object} opts
 * @param {string} opts.serverDir app-server 根目录
 * @param {string[]} opts.files 相对路径清单（POSIX 分隔，已过 parseBootManifest）
 * @param {number} [opts.concurrency]
 * @param {number} [opts.deadlineMs]
 * @param {() => number} [opts.now] 单测注入时钟
 * @param {(absPath: string) => Promise<number>} [opts.readFile] 单测注入读取（返回字节数、-1 = 跳过）
 */
export const runPrefetch = async ({
  serverDir,
  files,
  concurrency = PREFETCH_CONCURRENCY,
  deadlineMs = PREFETCH_DEADLINE_MS,
  now = Date.now,
  readFile = defaultReadFile,
}) => {
  const root = path.resolve(serverDir);
  const startedAt = now();
  const durations = [];
  let cursor = 0;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let bytes = 0;
  let timedOut = false;

  const worker = async () => {
    for (;;) {
      if (now() - startedAt > deadlineMs) {
        timedOut = true;
        return;
      }
      const index = cursor++;
      if (index >= files.length) return;
      const abs = path.resolve(root, ...files[index].split("/"));
      // 二次防线：解析后必须仍在 server 目录内（parseBootManifest 已挡 `..`，这里再确认一次）
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        skipped++;
        continue;
      }
      const t0 = now();
      try {
        const n = await readFile(abs);
        if (n < 0) skipped++;
        else {
          ok++;
          bytes += n;
        }
      } catch {
        failed++;
      }
      durations.push(now() - t0);
    }
  };

  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, files.length || 1));
  await Promise.all(Array.from({ length: workers }, worker));

  const sorted = [...durations].sort((a, b) => a - b);
  const sum = durations.reduce((acc, d) => acc + d, 0);
  return {
    total: files.length,
    ok,
    failed,
    skipped,
    notReached: Math.max(0, files.length - (ok + failed + skipped)),
    bytes,
    elapsedMs: now() - startedAt,
    // 单个文件从发起到读完的平均耗时 = 这台机器上「首次读一个文件」的真实延迟 L。
    // 并发读下它包含排队时间，所以是 L 的上界；p95 / max 用来看有没有被个别文件拖住。
    avgMs: durations.length ? sum / durations.length : 0,
    p95Ms: percentile(sorted, 95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    concurrency: workers,
    timedOut,
  };
};

// ---------- 读延迟探针（冷读 vs 热读） ----------
//
// 预读统计里的 avgPerFile 是「并发排队后的单文件耗时」，只能当上界。要真正回答
// 「这台机器上首次读一个文件到底要多久」，得有一组不被并发污染的串行读数，
// 再紧接着把同一批文件热读一遍做对照：冷 / 热的比值就是杀软 / 磁盘的拦截成本。
// 采样点均匀分布在清单里（清单本来就是 server 一定会读的文件，探针读过它们不算多余的活），
// 并有总时限——冷读极慢的机器上不能让探针自己把启动拖住。

/** 探针采样文件数。 */
export const READ_PROBE_SAMPLE = 16;

/** 冷读阶段总时限（到点不再读新文件）。 */
export const READ_PROBE_CAP_MS = 1_500;

const pickEvenly = (items, k) => {
  if (items.length <= k) return [...items];
  return Array.from({ length: k }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / k)]);
};

const timingStats = (durations) => {
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = durations.reduce((acc, d) => acc + d, 0);
  return {
    n: durations.length,
    avgMs: durations.length ? sum / durations.length : 0,
    p95Ms: percentile(sorted, 95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
  };
};

/**
 * 串行冷读一批采样文件、再串行热读同一批。永不抛错。
 * @param {object} opts
 * @param {string} opts.serverDir
 * @param {string[]} opts.files 相对路径清单（已过 parseBootManifest）
 * @param {number} [opts.sample]
 * @param {number} [opts.capMs]
 * @param {() => number} [opts.now] 毫秒级单调时钟（默认 performance.now：热读是亚毫秒级，Date.now 量不出来）
 * @param {(absPath: string) => Promise<number>} [opts.readFile]
 */
export const runReadProbe = async ({
  serverDir,
  files,
  sample = READ_PROBE_SAMPLE,
  capMs = READ_PROBE_CAP_MS,
  now = () => performance.now(),
  readFile = defaultReadFile,
}) => {
  const root = path.resolve(serverDir);
  const picks = pickEvenly(files, sample);
  const startedAt = now();
  const coldDurations = [];
  const readable = [];
  let failed = 0;
  let capped = false;

  for (const rel of picks) {
    if (now() - startedAt > capMs) {
      capped = true;
      break;
    }
    const abs = path.resolve(root, ...rel.split("/"));
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    const t0 = now();
    try {
      const n = await readFile(abs);
      if (n >= 0) {
        coldDurations.push(now() - t0);
        readable.push(abs);
      }
    } catch {
      failed++;
    }
  }

  // 热读：同一批、同样串行。刚读过的文件在系统缓存 / 杀软放行缓存里，差值就是首次访问的额外成本
  const warmDurations = [];
  for (const abs of readable) {
    const t0 = now();
    try {
      await readFile(abs);
      warmDurations.push(now() - t0);
    } catch {
      failed++;
    }
  }

  return {
    requested: picks.length,
    failed,
    capped,
    cold: timingStats(coldDurations),
    warm: timingStats(warmDurations),
    elapsedMs: now() - startedAt,
  };
};

/** 一行日志：冷 / 热各自的平均、p95、最大，便于一眼看出倍数。 */
export const formatReadProbe = (r) =>
  `cold n=${r.cold.n}/${r.requested} avg=${r.cold.avgMs.toFixed(1)}ms p95=${r.cold.p95Ms.toFixed(1)}ms max=${r.cold.maxMs.toFixed(1)}ms` +
  ` | warm n=${r.warm.n} avg=${r.warm.avgMs.toFixed(2)}ms p95=${r.warm.p95Ms.toFixed(2)}ms max=${r.warm.maxMs.toFixed(2)}ms` +
  ` | failed=${r.failed} capped=${r.capped} elapsed=${(r.elapsedMs / 1000).toFixed(1)}s`;

/** 一行日志（只含数字，便于事后 grep / 对比）。 */
export const formatPrefetchSummary = (s) =>
  `files=${s.ok}/${s.total} failed=${s.failed} skipped=${s.skipped} notReached=${s.notReached} ` +
  `bytes=${(s.bytes / 1048576).toFixed(1)}MB elapsed=${(s.elapsedMs / 1000).toFixed(1)}s ` +
  `avgPerFile=${s.avgMs.toFixed(1)}ms p95=${s.p95Ms.toFixed(0)}ms max=${s.maxMs.toFixed(0)}ms ` +
  `concurrency=${s.concurrency} timedOut=${s.timedOut}`;
