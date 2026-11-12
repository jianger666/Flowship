/**
 * 按仓多预览位 dev server 管理（V0.10.1 单预览位 → 按仓多位）
 *
 * 背景：worktree 隔离后每个任务有独立工作区、想看页面效果得手动 cd 深路径起
 * dev server。本模块按 repoPath 隔离预览位——不同仓可同时各跑一个（端口天然
 * 不同、不撞）；同一个仓全局仍只有一个位（同仓同端口会撞），别的任务再起同仓
 * 预览时顶掉前一个。
 *
 * 设计要点：
 * - app 不理解命令语义：启动命令来自设置页 per-repo 配置（如 `npm run dev`）、只负责执行
 * - 进程组隔离：spawn detached + kill(-pid)——dev server 常拉子进程（node → webpack workers）、
 *   只杀父进程会留孤儿占端口
 * - pidfile 兜底（dataRoot/preview.json）：数组记录各仓 pid；app 重启 / 崩溃后内存丢了、
 *   但 dev server 还活着占端口——下次 start / boot 时按记录杀掉残留进程组
 *   （2026-11-12：此前归属核验靠「ps 命令行含记录的命令串」，而 `yarn custom` 这类命令 sh 会 exec 成
 *   `node /…/bin/yarn custom`——路径前缀让词边界匹配落空，被当成「PID 被复用」只清记录不杀进程，
 *   残留的 dev server 一直占着端口，下次启动自动 +1。现在主判据换成**进程启动时间指纹**，见 {@link killOneStaleRecord}；
 *   评审 R15：任何会发信号的路径都要有归属证据——写于本次开机之前的记录一律只清记录、查不了进程（ps 失败）不当成「进程不存在」、
 *   「组长已退但组还在」要组内成员的 cwd 落在该预览的工作目录 / 仓库 / worktree 根之下、Windows 也用启动时间做指纹）
 * - CR-10：start/stop 走全局串行队列（并发不交错）；pidfile 记 command + 随机 token、
 *   杀前核验 PID 归属防误杀、exit 回调按 token 只清自己那条
 * - 日志环形缓冲（最近 200 行）+ URL 探测（dev server 打出的 localhost 地址）、
 *   UI 轮询 status 拿去展示「打开」按钮 / 失败排查
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { dataRoot } from "./data-root";
import { getChatLifecycle } from "./chat-gate";
import { failpoint } from "./failpoints";
import { GITLAB_TOKEN_ENV_NAME } from "./git-token-env";
import { stripHostInjectedEnv } from "./host-env";
import { withHardDeadline } from "./hard-deadline";
import { getProcessCwds, registerManagedChild } from "./kill-orphans";
import { PREVIEW_LOG_TAIL_LINES } from "@/lib/preview-ui-state";
import { stripAnsi } from "@/lib/strip-ansi";
import type { PreviewSlotStatus } from "@/lib/types";

const execFileAsync = promisify(execFile);

/**
 * 预览命令（用户配置的 `pnpm dev` / `next dev` / umi 等）的子进程环境。
 *
 * 在 server 自己的环境上剔掉宿主注入的变量（见 `host-env.ts`）：
 * - PORT / HOSTNAME：Electron 壳给内置 Next server 注入的。原封漏给 dev server 会被 umi/webpack 等
 *   优先读走、顶掉用户 `--port` 配置，再因 8876 被 app 自己占着自动 +1 全跑到 8877
 *   （用户实测：--port=8888 实跑 8877）；
 * - ELECTRON_RUN_AS_NODE / `__NEXT_PRIVATE_*` / NEXT_DEPLOYMENT_ID / FLOWSHIP_DATA_DIR 等：
 *   用户项目若也是 Next，standalone 配置会让它的 `next dev` 报错；
 * - GitLab token 是给 agent 调 API 用的，用户随手配的预览命令用不到、也不该拿到。
 *
 * `base` 仅供测试注入；不改传入对象。
 */
export const buildPreviewEnv = (
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env = stripHostInjectedEnv(base);
  delete env[GITLAB_TOKEN_ENV_NAME];
  env.FORCE_COLOR = "0";
  return env;
};

// ----------------- per-task「启动中」计数（入队 → spawn 完成） -----------------

const PREVIEW_STARTING_KEY = "__flowshipPreviewStartingV1__";
const getPreviewStartingMap = (): Map<string, number> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, number> | undefined
  >;
  if (!g[PREVIEW_STARTING_KEY]) g[PREVIEW_STARTING_KEY] = new Map();
  return g[PREVIEW_STARTING_KEY]!;
};

const beginPreviewStarting = (taskId: string): void => {
  const m = getPreviewStartingMap();
  m.set(taskId, (m.get(taskId) ?? 0) + 1);
};

const endPreviewStarting = (taskId: string): void => {
  const m = getPreviewStartingMap();
  const n = (m.get(taskId) ?? 0) - 1;
  if (n <= 0) m.delete(taskId);
  else m.set(taskId, n);
};

/** 测试可见：某 task 是否仍有 startPreview 在「入队→spawn 完成」窗口 */
export const hasPreviewStarting = (taskId: string): boolean =>
  (getPreviewStartingMap().get(taskId) ?? 0) > 0;

/**
 * 等「启动中」归零（上限 ms）。
 * lifecycle 已占时 in-flight start 会在 spawn 前 admission 自退，短等即可，
 * 避免与卡在 preview.beforeSpawn 的 start 空耗满 10s。
 */
const waitPreviewStartingClear = async (
  taskId: string,
  maxMs: number,
): Promise<void> => {
  const deadline = Date.now() + maxMs;
  while (hasPreviewStarting(taskId) && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
};

/**
 * spawn 前最终准入——fresh 读盘 repoStatus + lifecycle。
 * 用 readTaskRepoStatusFresh（轻量、不 hydrate）避 preview-manager ↔ task-fs 环，
 * 且不踩 getTask 的 hydrate failpoint。
 */
const admitPreviewSpawn = async (
  taskId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  if (getChatLifecycle(taskId) !== null) {
    return { ok: false, reason: "任务正在停止/终结、暂不能起预览" };
  }
  const { readTaskRepoStatusFresh } = await import("./task-fs");
  const status = await readTaskRepoStatusFresh(taskId);
  if (status === null) {
    return { ok: false, reason: "task 不存在" };
  }
  if (status === "merged" || status === "abandoned") {
    return { ok: false, reason: "任务已终结、不能起预览" };
  }
  return { ok: true };
};

// ----------------- 类型 -----------------

interface PreviewSlot extends Omit<PreviewSlotStatus, "logTail"> {
  /** 存活时持有；进程 exit 后置 null，避免弱泄漏（保留 status / 日志快照） */
  proc: ChildProcess | null;
  log: string[];
  /** 本次 spawn 的随机 ownership token（pidfile 归属核验用、CR-10） */
  token: string;
  /**
   * 主进程自己退出后「清理同组残留成员」的在途 promise（评审 R16-07 d）。
   * stop / 同仓重启要等它做完：否则它最长 2 秒的「TERM → 等 → KILL」还在跑时新预览已经起了，端口可能还被将死的 worker 占着。
   */
  groupCleanup: Promise<void> | null;
}

// ----------------- 进程级单例（dev hot reload 下不同 chunk 共享） -----------------

// V2：按 repoPath 多预览位；换 key 名避免 hot reload 残留 V1 单 slot 结构
const SLOTS_KEY = "__flowshipPreviewSlotsV2__";
const getSlotsRef = (): Map<string, PreviewSlot> => {
  const g = globalThis as unknown as Record<string, Map<string, PreviewSlot> | undefined>;
  if (!g[SLOTS_KEY]) g[SLOTS_KEY] = new Map();
  return g[SLOTS_KEY]!;
};

// start / stop 全局串行队列（CR-10）：并发双 start / start+stop 交错会导致
// 「先起的进程变孤儿没人能停」「stop 停掉的是别人」——所有变更操作排队执行
const QUEUE_KEY = "__flowshipPreviewOpQueueV1__";
const getQueueRef = (): { current: Promise<void> } => {
  const g = globalThis as unknown as Record<
    string,
    { current: Promise<void> } | undefined
  >;
  if (!g[QUEUE_KEY]) g[QUEUE_KEY] = { current: Promise.resolve() };
  return g[QUEUE_KEY]!;
};

const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const q = getQueueRef();
  const run = q.current.then(fn);
  // 队列指针只关心「上一个是否结束」、错误由调用方消费、不传染下一个
  q.current = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const MAX_LOG_LINES = 200;

// ----------------- pidfile（跨进程残留兜底 + 归属核验、CR-10） -----------------

// app 重启后内存 slot 丢、dev server 还占着端口——pidfile 记下各仓 spawn 的进程、
// 下次 boot / start 前清残留。CR-10 起额外记 command + 随机 token：
// - command：杀前对照 ps 输出、PID 被系统复用给无关进程时不误杀
// - token：exit 回调 / stop 只清「自己写的那条」、旧进程迟到退出不清新进程的
interface PidFileRecord {
  pid: number;
  at: number;
  token: string;
  command: string;
  repoPath: string;
  /** dev server 实际运行目录（隔离 task = worktree）。归属核验里「进程 cwd 是否落在这个预览的目录之下」用；旧记录没有 */
  workDir?: string;
  /**
   * spawn 后立刻取的「进程启动时间指纹」（`ps -o lstart=`，1 秒精度）。
   * 杀前核验归属的主判据：PID 被系统复用给别的进程时启动时间必然不同；命令行匹配（yarn / pnpm / npx 经 shell exec
   * 后命令行形态五花八门）只作旧记录（无指纹）的退路。unix 取 `ps -o lstart=`（UTC、1 秒精度），
   * Windows 取 PowerShell 的 `StartTime`（UTC、ISO）；取不到 = 缺省。
   */
  startedFp?: string;
}

/** 磁盘上读出来的半结构化记录 → 合法记录（缺关键字段 = null、丢弃）。四处读改写共用，别各抄一份丢字段 */
const toRecord = (r: Partial<PidFileRecord>): PidFileRecord | null => {
  if (typeof r.pid !== "number" || !r.token || !r.command || !r.repoPath) return null;
  return {
    pid: r.pid,
    at: typeof r.at === "number" ? r.at : Date.now(),
    token: r.token,
    command: r.command,
    repoPath: r.repoPath,
    ...(typeof r.workDir === "string" && r.workDir ? { workDir: r.workDir } : {}),
    ...(typeof r.startedFp === "string" && r.startedFp ? { startedFp: r.startedFp } : {}),
  };
};

const pidFilePath = (): string => path.join(dataRoot(), "preview.json");

/** 读 pidfile 数组；旧格式单对象包成数组（升级后残留 dev server 还能被杀） */
const readPidFile = async (): Promise<Partial<PidFileRecord>[]> => {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(pidFilePath(), "utf8"));
    if (Array.isArray(raw)) return raw as Partial<PidFileRecord>[];
    if (raw && typeof raw === "object") return [raw as Partial<PidFileRecord>];
    return [];
  } catch {
    return [];
  }
};

const writePidFileAll = async (recs: PidFileRecord[]): Promise<void> => {
  try {
    if (recs.length === 0) {
      await fs.rm(pidFilePath(), { force: true });
      return;
    }
    await fs.writeFile(pidFilePath(), JSON.stringify(recs));
  } catch {
    // 写不进去只是失去崩溃兜底、不挡启动
  }
};

/** 写入 / 覆盖同仓那条（同仓单位语义） */
const upsertPidFile = async (rec: PidFileRecord): Promise<void> => {
  const cur = await readPidFile();
  const kept: PidFileRecord[] = [];
  for (const r of cur) {
    const norm = toRecord(r);
    if (!norm) continue;
    // 同仓旧记录丢掉（即将被本次覆盖）；无 repoPath 的旧格式 toRecord 已丢（全局单位时代残留）
    if (norm.repoPath === rec.repoPath) continue;
    kept.push(norm);
  }
  kept.push(rec);
  await writePidFileAll(kept);
};

/**
 * 清 pidfile。带 token 时只删「token 匹配的那条」——旧进程迟到的 exit 回调
 * 绝不能把新进程刚写的记录清掉（否则崩溃兜底失效、残留进程没人杀）。
 * 不带 token = 整文件清（killStale 扫完后用）。
 */
const clearPidFileIf = async (token?: string): Promise<void> => {
  if (!token) {
    await fs.rm(pidFilePath(), { force: true }).catch(() => {});
    return;
  }
  const cur = await readPidFile();
  const next: PidFileRecord[] = [];
  for (const r of cur) {
    if (r.token === token) continue; // 自己那条、删
    const norm = toRecord(r);
    if (norm) next.push(norm);
  }
  await writePidFileAll(next);
};

// ----------------- 进程探测（杀前核验用） -----------------

/** 探测子进程（ps / pgrep / powershell / tasklist）的超时：它们跑在全局串行队列里，一个卡住会拖住所有仓的 start / stop（R15-11） */
const PROBE_TIMEOUT_MS = 2000;
/** Windows 的 PowerShell 冷启动慢，给宽一点 */
const WIN_PROBE_TIMEOUT_MS = 5000;

interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  windowsHide?: boolean;
}
type ProbeExec = (file: string, args: string[], opts?: ProbeOptions) => Promise<{ stdout: string }>;

const defaultProbeExec: ProbeExec = async (file, args, opts) => {
  // 带 timeout 的探测外面再包一层硬期限：子进程陷在不可中断睡眠时，execFile 的 timeout 杀不掉它、回调不来（评审 R16-01）
  const run = execFileAsync(file, args, {
    ...opts,
    encoding: "utf8",
    ...(opts?.timeout ? { killSignal: "SIGKILL" as const } : {}),
  });
  const { stdout } = opts?.timeout ? await withHardDeadline(run, opts.timeout + 1000, file) : await run;
  return { stdout };
};
let probeExec: ProbeExec = defaultProbeExec;

/** 仅测试用：注入探测命令的执行器（模拟 ps 失败 / 超时等）；传 null 恢复真实实现 */
export const __setPreviewProbeExecForTest = (fn: ProbeExec | null): void => {
  probeExec = fn ?? defaultProbeExec;
};

/**
 * 进程命令行探测的三种结果——**必须区分「确实不存在」与「没查成」**（R15-04）：
 * ps 自己失败（EAGAIN / EMFILE / 超时）时不能当成「进程不存在」去走「组长已退」分支。
 * - gone：确认不存在（ps 退出码 1 且无输出 / tasklist 无匹配）
 * - error：没查成（spawn 失败 / 超时 / 其它退出码）→ 调用方一律不发信号
 */
type CommandProbe = { kind: "gone" } | { kind: "error" } | { kind: "ok"; command: string };

const probeProcessCommand = async (pid: number): Promise<CommandProbe> => {
  try {
    if (process.platform === "win32") {
      const { stdout } = await probeExec(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { windowsHide: true, timeout: WIN_PROBE_TIMEOUT_MS },
      );
      const m = stdout.match(/^"([^"]+)"/m);
      return m ? { kind: "ok", command: m[1] } : { kind: "gone" };
    }
    const { stdout } = await probeExec("ps", ["-p", String(pid), "-o", "command="], {
      timeout: PROBE_TIMEOUT_MS,
    });
    const command = stdout.trim();
    return command ? { kind: "ok", command } : { kind: "gone" };
  } catch (err) {
    // ps 找不到该 pid 时退出码为 1、无输出（BSD / procps 一致）；其它一切失败都算「没查成」
    const e = err as { code?: unknown; stdout?: unknown };
    const noOutput = typeof e.stdout !== "string" || e.stdout.trim() === "";
    return process.platform !== "win32" && e.code === 1 && noOutput ? { kind: "gone" } : { kind: "error" };
  }
};

/**
 * 进程启动时间指纹。进程不存在 / 查不了返回 null。
 * - unix：`ps -o lstart=`（形如 `Thu Nov 12 08:44:21 2026`）。固定 C locale **和 UTC 时区**取：
 *   同一进程在 server 重启前后各取一次要得到完全相同的字符串，不能被两次启动环境里的 LANG / LC_ALL（星期 / 月份本地化）
 *   或 TZ / 夏令时切换搅黄（R15-10）。
 * - Windows（R15-05）：PowerShell `(Get-Process -Id X).StartTime` 转 UTC 的 ISO 串。冷启动较慢（几百毫秒），
 *   放在 spawn 之后、带超时；取不到就不带指纹，核验退回映像名。
 */
export const getProcessStartFingerprint = async (pid: number): Promise<string | null> => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const { stdout } = await probeExec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { windowsHide: true, timeout: WIN_PROBE_TIMEOUT_MS },
      );
      return stdout.trim() || null;
    }
    const { stdout } = await probeExec("ps", ["-p", String(pid), "-o", "lstart="], {
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
      timeout: PROBE_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/** 指纹串 → 毫秒（unix 的 lstart 按 UTC 解析、Windows 已是带 Z 的 ISO）；解析不了 = null */
const fingerprintToMs = (fp: string): number | null => {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}T/.test(fp) ? fp : `${fp} UTC`);
  return Number.isNaN(t) ? null : t;
};

/** 指纹容差：lstart 只有秒精度，Linux 上还会随 NTP 校时漂移 1~2 秒（R15-10）；PID 复用的两个进程启动时间不会这么近 */
const FINGERPRINT_TOLERANCE_MS = 2000;

/** 记录的指纹与现在取到的是否同一个进程：字符串相等，或解析成时间后相差不超过容差 */
export const fingerprintsMatch = (recorded: string, current: string): boolean => {
  if (recorded === current) return true;
  const a = fingerprintToMs(recorded);
  const b = fingerprintToMs(current);
  return a !== null && b !== null && Math.abs(a - b) <= FINGERPRINT_TOLERANCE_MS;
};

/** 记录写于本次开机之前的判定留的余量（时钟漂移 / uptime 取整） */
const BOOT_MARGIN_MS = 60_000;

/**
 * 记录是不是写在本次开机之前。开机会让整个 PID 空间重置——此后任何进程都不可能是记录里的那个 dev server，
 * 所以这样的记录一律只清记录、绝不发信号（R15-04 ②：PID 复用概率最高的就是「重启电脑后」）。
 * `at` 缺失（旧格式）= 判不了，按「不是」处理。
 */
export const isRecordFromBeforeBoot = (
  recordedAt: number | undefined,
  now: number = Date.now(),
  uptimeSec: number = os.uptime(),
): boolean =>
  typeof recordedAt === "number" &&
  Number.isFinite(recordedAt) &&
  recordedAt + BOOT_MARGIN_MS < now - uptimeSec * 1000;

/** 组长 PID 在内核里**确实**不存在（kill(pid,0) = ESRCH）。EPERM / 其它 = 存在或不确定 → false */
const leaderGoneConfirmed = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/** 进程组成员 pid（pgrep -g）；没有 / 失败 = null */
const listGroupMembers = async (pgid: number): Promise<number[] | null> => {
  try {
    const { stdout } = await probeExec("pgrep", ["-g", String(pgid)], { timeout: PROBE_TIMEOUT_MS });
    const pids = stdout
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 1);
    return pids.length > 0 ? pids : null;
  } catch {
    return null;
  }
};

/** 一组 pid 的 cwd。Linux 直接读 /proc；其余走 lsof（kill-orphans 同一实现） */
const readProcessCwds = async (pids: number[]): Promise<string[]> => {
  if (process.platform === "linux") {
    const out: string[] = [];
    for (const pid of pids) {
      try {
        out.push(await fs.readlink(`/proc/${pid}/cwd`));
      } catch {
        /* 已退出 / 无权限 */
      }
    }
    if (out.length > 0) return out;
  }
  return [...(await getProcessCwds(pids)).values()];
};

const isPathInside = (p: string, root: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * 这些进程里有没有谁的 cwd 落在「这条预览记录的目录」之下。
 * 根的口径（评审 R16-07 b，收窄过）：新记录带 `workDir`（dev server 实际运行目录）→ **只认它**；
 * 旧记录没有 workDir（隔离任务的 dev server 当时跑在 worktree 里、记录里却只有原仓库）→ 原仓库 + worktree 根，
 * 不然旧记录的残留永远认不出。以前一律把「整个 worktree 根」也算上，别的任务 worktree 里的进程也会被认成「我们的」。
 * lsof 报的是真实路径（软链摊平），所以每个根都连 realpath 一起比。查不到 cwd = false（宁可漏杀、不误杀）。
 */
const cwdBelongsToRecord = async (pids: number[], rec: Partial<PidFileRecord>): Promise<boolean> => {
  const roots = new Set<string>();
  // worktree 根与 task-worktrees.getWorktreesRoot 同一口径（那边 import 链太重，这里不引）
  const candidates =
    typeof rec.workDir === "string" && rec.workDir
      ? [rec.workDir]
      : [rec.repoPath, path.join(dataRoot(), "worktrees")];
  for (const r of candidates) {
    if (typeof r !== "string" || !r) continue;
    const abs = path.resolve(r);
    roots.add(abs);
    try {
      roots.add(await fs.realpath(abs));
    } catch {
      /* 目录已不存在：字面量足够 */
    }
  }
  const cwds = await readProcessCwds(pids);
  return cwds.some((c) => [...roots].some((r) => isPathInside(c, r)));
};

/**
 * PID 归属核验的**命令行退路**（CR-10；主判据见 {@link killOneStaleRecord} 的启动时间指纹）：
 * 仅用于旧 pidfile 记录（没有指纹）/ 取不到指纹时。pidfile 里的 PID 可能已被系统复用给无关进程、盲发信号会误杀。
 *
 * unix 下 spawn(shell:true) 的子进程命令行有两种形态：
 *   ① `/bin/sh -c <command>`（整条命令作为一个 argv、ps 展平成空格连接）；
 *   ② sh 直接 exec 成命令本体——此时可执行文件带**绝对路径**：`yarn custom` → `node /Users/x/.nvm/…/bin/yarn custom`，
 *      `npm run dev` → `node /…/npm-cli.js run dev`。
 * 旧实现只认 ① 的「词边界子串」，② 里命令名前面是 `/`、不满足「前面是空白 / `-c `」→ 判成「PID 被复用」→ 不杀只清记录
 * （2026-11-12 实测：用户的 `yarn custom` 重启 Flowship 后一直占着端口，再启动端口 +1）。
 * 现在补上 ②：把记录的命令切成 token，在 ps 的 token 序列里找一段连续相等的窗口，**首个 token（可执行文件）按 basename 比**。
 *
 * 词边界匹配（禁止纯前缀）：`npm run develop` / `npm run dev:local` 不得命中记录的
 * `npm run dev`——否则 PID 复用场景会误杀。
 *
 * win 的 tasklist 只给映像名、只能弱校验是 shell/node 家族。
 */
export const pidLooksOurs = (psCommand: string, recCommand: string): boolean => {
  if (process.platform === "win32") {
    return /^(cmd\.exe|node\.exe|powershell\.exe)$/i.test(psCommand.trim());
  }
  if (!recCommand) return false;
  // ① 词边界子串（`sh -c "<整条命令>"`，含 && / 环境变量前缀等复合命令）
  let from = 0;
  while (from <= psCommand.length) {
    const idx = psCommand.indexOf(recCommand, from);
    if (idx === -1) break;
    const beforeOk =
      idx === 0 ||
      /\s/.test(psCommand.charAt(idx - 1)) ||
      (idx >= 3 && psCommand.slice(idx - 3, idx) === "-c ");
    const afterIdx = idx + recCommand.length;
    const afterOk =
      afterIdx >= psCommand.length || /[\s;&|]/.test(psCommand.charAt(afterIdx));
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
  // ② sh exec 成命令本体：首 token 是带路径的可执行文件。
  // 记录里的命令可能带环境变量前缀（`PORT=3000 yarn dev`）：sh 把它们设进环境后 exec 命令本体，ps 里看不到——先剥掉
  const rec = recCommand.trim().split(/\s+/).filter(Boolean);
  while (rec.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rec[0])) rec.shift();
  const ps = psCommand.trim().split(/\s+/).filter(Boolean);
  if (rec.length === 0) return false;
  const base = (tok: string): string => tok.replace(/^.*[\\/]/, "");
  for (let i = 0; i + rec.length <= ps.length; i++) {
    if (base(ps[i]) !== base(rec[0])) continue;
    let ok = true;
    for (let j = 1; j < rec.length; j++) {
      if (ps[i + j] !== rec[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
};

/** 进程是否仍存活（kill(pid,0)；ESRCH = 已退出） */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * 进程组是否仍存在。
 * shell:true + detached 时组长常是 shell——TERM 后 shell 可能先退，占端口的
 * 子进程仍在同一组；只查组长 PID 会误判「已清干净」而跳过 SIGKILL。
 * Unix：kill(-pid,0) 探组；EPERM 也表示组内仍有成员，仅 ESRCH 表示组已空。
 * 负号语义不可用时回退 processAlive（查组长）。
 */
const processGroupAlive = (pid: number): boolean => {
  if (pid <= 0) return processAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return processAlive(pid);
  }
};

// 杀整棵进程树。
// - mac/linux：detached spawn 后 pid = 进程组长、kill(-pid) 杀全组；先 TERM 给优雅退出机会、
//   按「进程组是否仍在」轮询最多 2s、超时再对 -pid 发 KILL 兜底（组已空则提前返回）
// - Windows（V0.11.1）：没有进程组负号语义、kill(-pid) 会抛——用 `taskkill /T /F` 杀整棵树
//   （dev server 常见 node → webpack workers 多级子进程、只杀父进程会留孤儿占端口）

// 正在走「TERM → 等 → KILL」的进程组 pid（slot 已从 map 摘掉、但组还没确认死）。
// 退出时的同步强杀（forceKillAllPreviewsSync）除了在册 slot，也要覆盖这些「摘了但没死透」的组——
// 否则 stop 进行到一半就 process.exit，等它的那一发 KILL 就丢了（评审 R1-9）。
const STOPPING_PGIDS_KEY = "__flowshipPreviewStoppingPgidsV1__";
const getStoppingPgids = (): Set<number> => {
  const g = globalThis as unknown as Record<string, Set<number> | undefined>;
  if (!g[STOPPING_PGIDS_KEY]) g[STOPPING_PGIDS_KEY] = new Set();
  return g[STOPPING_PGIDS_KEY]!;
};

/**
 * `groupOnly`：只对进程组（`-pid`）发信号，组不存在就算了，**不退到单 PID**。
 * 杀「记录里的残留进程」（pidfile 路径）必须开：从核验到发信号之间隔着 pgrep / lsof 的 await，组可能恰好在这几秒里死光、
 * PID 被复用，单 PID 退路会把 TERM 发给无关进程（评审 R16-07 c）。自己刚 spawn 的进程（stop / 退出清理）不需要。
 */
const killProcessGroup = async (pid: number, opts: { groupOnly?: boolean } = {}): Promise<void> => {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true },
        () => resolve(), // 进程已死等错误一律吞、best-effort
      );
    });
    return;
  }
  const tryKill = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      if (opts.groupOnly) return false;
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (!tryKill("SIGTERM")) return;
  const stopping = getStoppingPgids();
  stopping.add(pid);
  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (!processGroupAlive(pid)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!processGroupAlive(pid)) return;
    tryKill("SIGKILL");
  } finally {
    stopping.delete(pid);
  }
};

/**
 * 退出前的**同步**最后一道强杀（process.exit 之前由退出钩子经 kill-orphans 调）：
 * 对每个仍在册 slot 的进程组、以及「stop 进行到一半」的进程组直接发 SIGKILL。
 *
 * 为什么需要：优雅停（TERM → 等 2s → KILL）比退出钩子的 1.5s 上限还长，还排在预览全局串行队列里
 * （前面有慢 start 就轮不到）；不听 SIGTERM 的 dev server 在 process.exit 时只收到过 TERM，
 * 又因为是 detached 独立进程组、壳按 server 进程组的整组清理扫不到——会一直占着端口。
 * 这里不进队列、不 await、不依赖优雅停的进度，调用时刻现查。
 *
 * 只对「组长还活着」的 slot 发（slot.proc 在 exit 后置 null）：组长早已退出的 pid 可能已被系统复用，
 * 对 -pid 发 KILL 会误杀无关进程组——这种极端残留仍由下次启动的 pidfile 归属核验兜底。
 * Windows 保持原样（taskkill 是异步子进程、没法在 exit 前同步完成；优雅停路径不变）。
 */
export const forceKillAllPreviewsSync = (): void => {
  if (process.platform === "win32") return;
  const pids = new Set<number>(getStoppingPgids());
  for (const slot of getSlotsRef().values()) {
    const pid = slot.proc?.pid;
    if (pid && !slot.exited) pids.add(pid);
  }
  for (const pid of pids) {
    if (pid <= 1) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH（已死）/ EPERM：best-effort
    }
  }
};

/** 一次启动恢复的取消开关：超过总时限后置 true，之后任何在途的核验都不得再发信号 / 写 pidfile（评审 R16-01） */
interface StaleCtl {
  cancelled: boolean;
}

/**
 * 对单条记录的处理结果：
 * - cleared：处理完了（杀了 / 确认不是我们的 / 进程已不在）→ 记录可以丢
 * - keep：**这次没能核验**（探测出错 / 取不到现值），不发信号；记录保留、下次再试（评审 R16-07 a）。
 *   ps 超时 / EAGAIN 多半是瞬时的，一清记录就永远没有第二次机会，真是残留的 dev server 就成了「端口 +1」。
 *   记录超过 {@link STALE_KEEP_MAX_AGE_MS} 就不再留（持续出错的机器别让它一直挂着）。
 */
type StaleOutcome = "cleared" | "keep";

const STALE_KEEP_MAX_AGE_MS = 24 * 3600_000;

/** 整轮启动恢复的总时限：超了就放弃剩下的（记录留着下次再试），不让读任务的接口一直等（评审 R16-01） */
const STALE_SWEEP_BUDGET_MS = 15_000;

/**
 * 对单条 pidfile 记录做归属核验后 kill（匹配才杀、不匹配只丢记录）。
 *
 * 原则：**任何会发信号的路径都要有归属证据，拿不到证据就不发信号**（宁可漏杀、不误杀）。顺序：
 * 0. 记录写于本次开机之前 → 只清记录。开机重置了整个 PID 空间，现在这个 PID 上的任何进程都不可能是当初那个 dev server。
 *    PID 就是 Flowship 自己 / 自己的父进程 → 只清记录（绝不对自己的进程组发信号）。
 * 1. 探测进程命令行：**没查成（ps 失败 / 超时）→ 不发信号**，不当成「进程不存在」（R15-04 B），记录保留下次再试（R16-07 a）。
 * 2. 组长已不在（探测确认不存在）、进程组还有成员（yarn / sh 组长先退、webpack / next worker 继续占端口）：
 *    必须同时满足 ① 内核也确认组长 PID 不存在（kill(pid,0)=ESRCH，不是只信 ps）② 组里没有 Flowship 自己 / 自己的父进程
 *    ③ 组内有成员的 cwd 落在该预览的工作目录之下，才按组杀。POSIX 只保证「组存在期间该 PID 不被复用」，不保证组一直存在——
 *    旧组早已清空、PID 被无关进程拿走再成了新组长、它退出后组里留有成员，这种情形光靠「组还在」会整组误杀（R15-04 A），
 *    cwd 证据把它挡掉。Windows 没有进程组语义，保持「进程已不在」。
 * 3. 组长还在 + 记录带**启动时间指纹** → 指纹一致（容 ±2 秒）才杀；不一致 = PID 被复用、不发信号。
 *    **记录带指纹却取不到现值 → 不发信号、不落退路**（R16-02）：带指纹说明这是新版本刚写的记录、不存在「升级后第一次」，
 *    取不到现值只可能是 ps / PowerShell 被禁用 / 超时 / 权限——这时再靠映像名弱校验去 `taskkill /T /F` 整棵树，
 *    等于在最没有证据的时候发信号。记录保留下次再试。
 * 4. 命令行退路（**只给没有指纹的旧记录**）：{@link pidLooksOurs}，unix 下还要进程 cwd 落在该预览的目录之下
 *    （用户终端里的 `yarn dev` 在 ps 里与事故形态完全一样，光看命令行会误认，R15-12）；对不上只清记录。
 *    Windows 的旧记录仍只有映像名弱校验（升级后第一次启动不想重现「端口 +1」，已接受的取舍，R15-05）。
 *
 * 所有信号都只发给进程组（`groupOnly`），并在发之前再看一眼 `ctl.cancelled`。
 */
const killOneStaleRecord = async (
  rec: Partial<PidFileRecord>,
  ctl: StaleCtl = { cancelled: false },
): Promise<StaleOutcome> => {
  if (typeof rec.pid !== "number" || rec.pid <= 1) return "cleared";
  const pid = rec.pid;
  const killGroup = async (): Promise<void> => {
    if (ctl.cancelled) return;
    await killProcessGroup(pid, { groupOnly: true });
  };
  const retryLater = (): StaleOutcome =>
    typeof rec.at === "number" && Date.now() - rec.at < STALE_KEEP_MAX_AGE_MS ? "keep" : "cleared";

  if (isRecordFromBeforeBoot(rec.at)) {
    console.warn(`[preview] pidfile 的 PID ${pid} 记录写于本次开机之前、PID 空间已重置，不发信号只清记录`);
    return "cleared";
  }
  if (pid === process.pid || pid === process.ppid) {
    console.warn(`[preview] pidfile 的 PID ${pid} 就是 Flowship 自己 / 它的父进程，绝不发信号，只清记录`);
    return "cleared";
  }

  const probe = await probeProcessCommand(pid);
  if (probe.kind === "error") {
    console.warn(`[preview] pidfile 的 PID ${pid} 探测失败（ps / tasklist 出错或超时），无法确认归属，不发信号；记录保留、下次再试`);
    return retryLater();
  }

  if (probe.kind === "gone") {
    if (process.platform === "win32") return "cleared";
    if (!leaderGoneConfirmed(pid)) return "cleared"; // ps 说没有、内核说有（或 EPERM）：矛盾、不动
    if (!processGroupAlive(pid)) return "cleared";
    const members = await listGroupMembers(pid);
    if (members && (members.includes(process.pid) || members.includes(process.ppid))) {
      console.warn(`[preview] pidfile 的 PID ${pid} 的进程组里有 Flowship 自己 / 它的父进程，绝不按组清理，只清记录`);
      return "cleared";
    }
    if (members && (await cwdBelongsToRecord(members, rec))) {
      console.warn(`[preview] pidfile 的 PID ${pid} 组长已退出、但进程组仍有残留成员（dev server 子进程），按组清理`);
      await killGroup();
    } else {
      console.warn(`[preview] pidfile 的 PID ${pid} 组长已退出、进程组仍有成员，但没有证据表明它们属于这个预览（cwd 不在预览目录下 / 查不到），不发信号只清记录`);
    }
    return "cleared";
  }

  const psCommand = probe.command;
  if (typeof rec.startedFp === "string" && rec.startedFp) {
    const nowFp = await getProcessStartFingerprint(pid);
    if (nowFp === null) {
      console.warn(
        `[preview] pidfile 的 PID ${pid} 记录带启动时间指纹、但现在取不到现值（ps / PowerShell 被禁用 / 超时 / 无权限），没有归属证据，不发信号；记录保留、下次再试`,
      );
      return retryLater();
    }
    if (fingerprintsMatch(rec.startedFp, nowFp)) {
      await killGroup();
    } else {
      console.warn(
        `[preview] pidfile 的 PID ${pid} 启动时间对不上（记录「${rec.startedFp}」、现为「${nowFp}」），PID 已被复用、不发信号只清记录`,
      );
    }
    return "cleared";
  }
  if (typeof rec.command === "string" && rec.command && pidLooksOurs(psCommand, rec.command)) {
    if (process.platform === "win32" || (await cwdBelongsToRecord([pid], rec))) {
      await killGroup();
    } else {
      console.warn(
        `[preview] pidfile 的 PID ${pid} 命令行像、但进程 cwd 不在该预览的目录下（现为「${psCommand}」），疑似别处同名命令、不发信号只清记录`,
      );
    }
  } else {
    console.warn(
      `[preview] pidfile 的 PID ${pid} 命令行对不上（现为「${psCommand}」）、疑似被复用、不发信号只清记录`,
    );
  }
  return "cleared";
};

/**
 * 清上一次进程遗留的全部 dev server（pidfile 兜底、boot 调）。
 * CR-10：杀前核验 PID 归属——对不上（PID 被复用 / 旧格式 pidfile 无 command）
 * 只清记录不发信号、绝不误杀无关进程。
 *
 * 总时限（评审 R16-01）：本函数挂在 `ensureBootRecovery` 里，而那个 promise 被好几个读任务的接口 `await`——
 * 任何一个探测卡住（lsof 遇到失联挂载等）都会让任务列表 / 详情整个拿不到返回。超过 `budgetMs`（默认 15 秒）就放弃剩下的：
 * 置 `ctl.cancelled`（在途的核验之后不得再发信号、也不得再写 pidfile），记录原样留着，下次启动 / 同仓启动再试。
 */
export const killStalePreview = async (opts: { budgetMs?: number } = {}): Promise<void> => {
  const ctl: StaleCtl = { cancelled: false };
  const sweep = async (): Promise<void> => {
    const recs = await readPidFile();
    const keep: PidFileRecord[] = [];
    for (const rec of recs) {
      if (ctl.cancelled) return;
      if ((await killOneStaleRecord(rec, ctl)) === "keep") {
        const norm = toRecord(rec);
        if (norm) keep.push(norm);
      }
    }
    if (ctl.cancelled) return;
    await writePidFileAll(keep); // 没有要保留的 = 删文件（与以前整文件清一致）
  };
  const work = sweep();
  work.catch(() => {}); // 超时后它再失败也不是 unhandled rejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), opts.budgetMs ?? STALE_SWEEP_BUDGET_MS);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  if (timedOut) {
    ctl.cancelled = true;
    console.warn(
      `[preview] 清理上次遗留的预览进程超过 ${(opts.budgetMs ?? STALE_SWEEP_BUDGET_MS) / 1000} 秒还没做完（某个进程探测卡住了？），放弃本轮、记录保留、下次再试`,
    );
  }
};

/**
 * 只清指定仓的 pidfile 残留（start 同仓顶掉前调用、不动其它仓）。
 * 无 repoPath 的旧格式记录也一并清（全局单位时代残留、归属不明）。
 * 同仓记录这次没能核验（keep）时也留着；但随后新预览 spawn 成功会按「同仓单位」覆盖它（upsertPidFile），
 * 所以这只对「新预览没起成」的情形有意义——同仓一个预览位的设计下，没法同时跟踪两个进程。
 */
const killStalePreviewForRepo = async (repoPath: string): Promise<void> => {
  const recs = await readPidFile();
  const keep: PidFileRecord[] = [];
  for (const rec of recs) {
    const sameRepo = !rec.repoPath || rec.repoPath === repoPath;
    if (sameRepo && (await killOneStaleRecord(rec)) === "cleared") continue;
    const norm = toRecord(rec);
    if (norm) keep.push(norm);
  }
  await writePidFileAll(keep);
};

// 从 dev server 输出探本地访问地址（umi/vite/next 都会打 localhost URL）
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+[^\s'"]*/;

const toStatus = (slot: PreviewSlot): PreviewSlotStatus => ({
  taskId: slot.taskId,
  taskTitle: slot.taskTitle,
  repoPath: slot.repoPath,
  workDir: slot.workDir,
  command: slot.command,
  startedAt: slot.startedAt,
  url: slot.url,
  exited: slot.exited,
  exitCode: slot.exitCode,
  logTail: slot.log.slice(-PREVIEW_LOG_TAIL_LINES),
});

// ----------------- 对外 API -----------------

/** 返回当前全部预览位状态（按仓） */
export const getPreviewStatus = (): PreviewSlotStatus[] =>
  [...getSlotsRef().values()].map(toStatus);

/** 停指定仓预览（没有在跑也算成功、幂等）。经全局串行队列。 */
export const stopPreview = (repoPath: string): Promise<void> =>
  enqueue(() => doStopPreview(repoPath));

/** 停全部预览位（boot / DELETE 不带 repoPath / 全清用） */
export const stopAllPreviews = (): Promise<void> => enqueue(doStopAllPreviews);

// server 退出（SIGTERM → 退出钩子 stopAllManagedChildren）时一并停掉全部预览 dev server（评审 R1-9）：
// 它们 spawn 时 `detached` 自成进程组，Electron 壳按 server 的进程组收尾时碰不到，
// 不在这里停的话 Cmd+Q 之后 dev server 会一直占着端口 / 继续吃 CPU，直到下次启动的 pidfile 兜底（killStalePreview）才清。
// 按 id 幂等覆盖（globalThis 登记表、dev HMR 不累积）；stop 不抛（doStopAllPreviews 内部 best-effort）
// 包一层 try/catch：这是 import 时执行的副作用（task-fs 等一大批模块都会间接 import 本文件），
// 登记失败（注册表不可用 / 测试里整个 mock 掉 kill-orphans 而没提供该导出）不能让整条 import 链炸掉——
// 失败的代价只是退出时不主动停预览，下次启动仍有 pidfile 兜底（killStalePreview）。
try {
  registerManagedChild("preview-manager:all", {
    label: "preview dev servers",
    stop: () => stopAllPreviews(),
    // 退出钩子在 process.exit 之前同步强杀（优雅停比钩子上限还久、且排在预览队列里）
    forceKill: forceKillAllPreviewsSync,
  });
} catch (err) {
  console.warn("[preview-manager] 登记退出钩子失败（忽略）：", err instanceof Error ? err.message : err);
}

/**
 * 停掉属于某 task 的所有 slot（删任务 / 终结任务前调用）。
 * 先等「启动中」归零（覆盖已过 route 闸、还在队列里的 start），再停已有 slot。
 * 不经全局 start 队列直接停——避免与卡在 preview.beforeSpawn 的 doStartPreview 死锁；
 * spawn 后另有终态复查自停孤儿。
 */
export const stopPreviewsForTask = async (taskId: string): Promise<void> => {
  // lifecycle 已占（finalize/DELETE）→ admission 会挡 spawn，短等；否则最多 ~10s
  const cap = getChatLifecycle(taskId) !== null ? 500 : 10_000;
  await waitPreviewStartingClear(taskId, cap);
  await doStopPreviewsForTask(taskId);
};

const doStopPreview = async (repoPath: string): Promise<void> => {
  const map = getSlotsRef();
  const slot = map.get(repoPath);
  if (!slot) return;
  map.delete(repoPath);
  if (slot.proc?.pid) await killProcessGroup(slot.proc.pid);
  // 主进程早已自己退出、同组残留还在清（TERM → 等 → KILL）：等它做完再返回，stop 返回 = 进程组确实没了（R16-07 d）
  await slot.groupCleanup;
  // 只清自己那条（token 核验）——理论上串行队列已保证无交错、token 是带子
  await clearPidFileIf(slot.token);
};

const doStopAllPreviews = async (): Promise<void> => {
  const map = getSlotsRef();
  const slots = [...map.entries()];
  for (const [repoPath] of slots) map.delete(repoPath);
  // 并行杀：每个 killProcessGroup 对不听 TERM 的进程最长等 2s，串行的话 N 个预览要 2N 秒、
  // 远超退出钩子的 1.5s 上限（评审 R1-9）。pidfile 是数组读改写，清记录仍串行（并发 RMW 会互相覆盖）。
  await Promise.allSettled(
    slots.map(([, slot]) =>
      Promise.all([
        slot.proc?.pid ? killProcessGroup(slot.proc.pid) : undefined,
        slot.groupCleanup, // 主进程自己退出后还在清同组残留的（R16-07 d）
      ]),
    ),
  );
  for (const [, slot] of slots) {
    // 只清自己那条（token 核验）
    await clearPidFileIf(slot.token);
  }
};

const doStopPreviewsForTask = async (taskId: string): Promise<void> => {
  const map = getSlotsRef();
  const paths = [...map.values()]
    .filter((s) => s.taskId === taskId)
    .map((s) => s.repoPath);
  for (const repoPath of paths) {
    await doStopPreview(repoPath);
  }
};

export interface StartPreviewInput {
  taskId: string;
  taskTitle: string;
  repoPath: string;
  /** dev server 实际运行目录（隔离 task = worktree、否则 = 原仓库） */
  workDir: string;
  command: string;
}

/** startPreview 返回值；yielded=true 表示最终准入拒绝、未 spawn（route → 409） */
export interface StartPreviewResult {
  replacedTaskTitle: string | null;
  status: PreviewSlotStatus;
  /** spawn 前最终准入失败 */
  yielded?: boolean;
  yieldReason?: string;
}

/**
 * 起预览（按仓单位：只停同 repoPath 旧位、其它仓不动）。
 * 经全局串行队列（CR-10）：同仓并发双 start 顺序执行、后到的顶掉先到的。
 * 入队起登记「启动中」，cleanup 后、spawn 前最终准入复查。
 */
export const startPreview = (
  input: StartPreviewInput,
): Promise<StartPreviewResult> => {
  // 入队即登记——stopPreviewsForTask 可等「还在队列里」的窗口
  beginPreviewStarting(input.taskId);
  return enqueue(() => doStartPreview(input)).finally(() => {
    endPreviewStarting(input.taskId);
  });
};

const doStartPreview = async (
  input: StartPreviewInput,
): Promise<StartPreviewResult> => {
  const map = getSlotsRef();
  const replaced = map.get(input.repoPath) ?? null;
  const replacedTaskTitle =
    replaced && !replaced.exited && replaced.taskId !== input.taskId
      ? replaced.taskTitle
      : null;

  // 只停同仓旧位（内存）+ 同仓 pidfile 残留——不动其它仓
  //（直接调 do 版本：本函数已在队列内、再 enqueue 会自锁）
  await doStopPreview(input.repoPath);
  await killStalePreviewForRepo(input.repoPath);

  // cleanup 之后、紧贴 spawn 前——插桩 + 最终准入（fresh task + lifecycle）
  await failpoint("preview.beforeSpawn");
  const admission = await admitPreviewSpawn(input.taskId);
  if (!admission.ok) {
    // 让位：不 spawn；合成已退出 status 给调用方（无 pid）
    const yieldedStatus: PreviewSlotStatus = {
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      repoPath: input.repoPath,
      workDir: input.workDir,
      command: input.command,
      startedAt: Date.now(),
      url: null,
      exited: true,
      exitCode: null,
      logTail: [`最终准入拒绝——${admission.reason}`],
    };
    return {
      replacedTaskTitle: null,
      status: yieldedStatus,
      yielded: true,
      yieldReason: admission.reason,
    };
  }

  // shell 模式跑用户配置的命令串（可能带 && / 环境变量前缀）。
  // - unix：detached 自成进程组、kill(-pid) 整组杀
  // - Windows：detached 会给子进程开独立控制台黑框（用户可见）、而树杀走 taskkill /T
  //   本就不依赖进程组 → 不 detach + windowsHide 压掉窗口
  // 环境剔掉宿主注入的变量，见 buildPreviewEnv
  const env = buildPreviewEnv();
  const proc = spawn(input.command, {
    cwd: input.workDir,
    shell: true,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  // 随机 ownership token：pidfile 归属核验（exit 回调 / stop 只清自己写的那条）
  const token = randomBytes(8).toString("hex");
  const slot: PreviewSlot = {
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    repoPath: input.repoPath,
    workDir: input.workDir,
    command: input.command,
    startedAt: Date.now(),
    url: null,
    exited: false,
    exitCode: null,
    proc,
    log: [],
    token,
    groupCleanup: null,
  };

  const onChunk = (chunk: Buffer): void => {
    // 先剥 ANSI 转义再切行（Q13-09）：`buildPreviewEnv` 的 FORCE_COLOR=0 管不住 picocolors（vite）——它把 "0" 当真值、
    // 反而上色，端口被 ESC 码夹在中间（`localhost:ESC[1m5173ESC[22m/`），URL_RE 探不到；整段上色时尾部的 ESC[39m 还会进地址。
    // 日志尾巴（logTail）也跟着干净。
    const lines = stripAnsi(chunk.toString("utf8")).split(/\r?\n/).filter(Boolean);
    slot.log.push(...lines);
    if (slot.log.length > MAX_LOG_LINES) {
      slot.log.splice(0, slot.log.length - MAX_LOG_LINES);
    }
    if (!slot.url) {
      for (const line of lines) {
        const m = line.match(URL_RE);
        if (m) {
          // 0.0.0.0 是监听地址不是可访问地址、换成 localhost
          slot.url = m[0].replace("0.0.0.0", "localhost");
          break;
        }
      }
    }
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);
  proc.on("exit", (code) => {
    slot.exited = true;
    slot.exitCode = code;
    // 自然退出：放下 ChildProcess 引用，保留 status / 日志快照，避免弱泄漏
    slot.proc = null;
    // 组长（yarn / sh 包装层）退了、同组的 worker 还活着——它们仍占着端口、却没人跟踪（下面马上要清 pidfile），
    // 下次启动端口 +1 就是这么来的。整组清掉。只在「自己仍是该仓当前预览位」时做（stop / 被顶掉的路径自己会杀）；
    // 这里和 pidfile 路径不同：exit 事件就是此刻的组长刚退，pgid 是我们自己 spawn 出来的，不存在「PID 被复用」的问题。
    const leaderPid = proc.pid;
    if (
      leaderPid &&
      process.platform !== "win32" &&
      map.get(input.repoPath) === slot &&
      processGroupAlive(leaderPid)
    ) {
      slot.log.push(
        "（预览命令的主进程已退出，但它拉起的子进程还在运行——预览命令需要前台常驻（别用 & / nohup 丢到后台），已一并清理，避免残留占用端口）",
      );
      // 记在 slot 上：stop / 同仓重启要等它做完（端口确定释放后再起新的），见 doStopPreview（评审 R16-07 d）。
      // 不进全局串行队列——它最长 2 秒，排进去会让别的仓的 start / stop 白等
      slot.groupCleanup = killProcessGroup(leaderPid).catch(() => {});
    }
    // CR-10：只有自己还是「该仓当前预览位」才清 pidfile——被顶掉的旧进程迟到的 exit
    // 不得清掉新进程刚写的那条（token 双保险）。
    // 必须进串行队列：pidfile 现在是数组读改写、exit 回调裸跑会与别的仓
    // start 的 upsertPidFile 交错、可能丢掉对方刚写的记录（崩溃兜底失效）
    if (map.get(input.repoPath) === slot) {
      void enqueue(() => clearPidFileIf(token));
    }
  });
  proc.on("error", (err) => {
    slot.exited = true;
    slot.log.push(`spawn 失败：${err.message}`);
  });

  map.set(input.repoPath, slot);
  if (proc.pid) {
    // 启动时间指纹：app 重启 / 崩溃后按它核验「这个 PID 还是不是当初那个 dev server」（见 killOneStaleRecord）。
    // 取不到（win32 / ps 失败）就不带，boot 时退回命令行核验
    const startedFp = await getProcessStartFingerprint(proc.pid);
    await upsertPidFile({
      pid: proc.pid,
      at: Date.now(),
      token,
      command: input.command,
      repoPath: input.repoPath,
      workDir: input.workDir,
      ...(startedFp ? { startedFp } : {}),
    });
  }

  // spawn 后终态复查——stopPreviewsForTask 可能已在 admission~map.set 窗口跑过
  const post = await admitPreviewSpawn(input.taskId);
  if (!post.ok) {
    map.delete(input.repoPath);
    if (proc.pid) await killProcessGroup(proc.pid);
    await clearPidFileIf(token);
    return {
      replacedTaskTitle: null,
      status: {
        ...toStatus(slot),
        exited: true,
        logTail: [`spawn 后复查拒绝——${post.reason}`],
      },
      yielded: true,
      yieldReason: post.reason,
    };
  }

  return { replacedTaskTitle, status: toStatus(slot) };
};
