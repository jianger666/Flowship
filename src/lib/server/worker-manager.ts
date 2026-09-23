/**
 * Worker 管理器（v3.1 §2 + §3.4 + §4：spawn/监控/重启/整机记账）。
 *
 * - 一 workspace 一 worker（调用方以 workspace/stateRoot 为 key 复用）；
 * - 整机记账：maxWorkers（动态公式）+ LRU 空闲逐出 + 全局软线先 reap 空闲；
 * - 重启阶梯的“何时重启”由调用方按 classifyWorkerMemory 决定，本模块只管
 *   spawn/kill/LRU/记账，不碰 SDK。
 * - 刻意不接入 task-runner 热路径：先 additive 落地，实验 A/B 出数据后再接线。
 */

import { fork, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EGRESS_BINARIES } from "./bash-policy";
import { dataRoot } from "./data-root";
import { shimIntentFile } from "./intent-log";
import {
  buildTotalRssLimit,
  IDLE_TTL_MINUTES,
  resolveMaxWorkers,
  SYSTEM_RESERVE_BYTES,
  WORKER_RSS_HARD_BYTES,
  WORKER_RSS_SOFT_BYTES,
} from "./mem-governance";
import { allocateWorkerEpoch } from "./worker-epoch";

export interface WorkerRecord {
  workspace: string;
  stateRoot: string;
  epoch: number;
  proc: ChildProcess;
  lastActiveAt: number;
  rssBytes: number;
  /** 本次 spawn 新建还是复用存量（复用跳过 ready 握手，沿用首次落位结论）。 */
  fresh: boolean;
}

export interface WorkerManagerOptions {
  maxWorkers?: number;
  idleTtlMs?: number;
  entryFile?: string;
}

const defaultEntry = (): string =>
  path.join(process.cwd(), "src/lib/server/worker-entry.ts");

export interface WorkerSelfReportMsg {
  type: "worker:self-report";
  workspace: string;
  epoch: number;
  /** ①修复：透传 old-space（双 guard 绝对值线）与 heapRatio（比例线），不许填 0。 */
  oldSpaceBytes: number;
  heapRatio?: number;
  rssBytes: number;
  level: "normal" | "soft" | "hard";
}

export type WorkerReportListener = (msg: WorkerSelfReportMsg) => void;

export class WorkerManager {
  private reportListeners = new Set<WorkerReportListener>();

  /** 订阅 worker 自上报（样本中继调用方负责映射到 task）。返回退订函数。 */
  onSelfReport(fn: WorkerReportListener): () => void {
    this.reportListeners.add(fn);
    return () => { this.reportListeners.delete(fn); };
  }

  /** 纯派发：worker-entry 的 process.send 消息进这里（spawn 内接线，可单测）。 */
  dispatchProcMessage(msg: unknown): void {
    try {
      const m = msg as Partial<WorkerSelfReportMsg>;
      if (!m || m.type !== "worker:self-report" || typeof m.workspace !== "string") return;
      const rec = this.workers.get(m.workspace);
      if (rec && typeof m.rssBytes === "number") {
        rec.rssBytes = m.rssBytes;
        rec.lastActiveAt = Date.now();
      }
      const full: WorkerSelfReportMsg = {
        type: "worker:self-report",
        workspace: m.workspace,
        epoch: typeof m.epoch === "number" ? m.epoch : 0,
        oldSpaceBytes: typeof m.oldSpaceBytes === "number" ? m.oldSpaceBytes : 0,
        heapRatio: typeof m.heapRatio === "number" ? m.heapRatio : undefined,
        rssBytes: typeof m.rssBytes === "number" ? m.rssBytes : 0,
        level: m.level === "hard" || m.level === "soft" ? m.level : "normal",
      };
      for (const fn of this.reportListeners) {
        try { fn(full); } catch { /* 监听器异常不传染 */ }
      }
    } catch {
      /* 埋点不许反伤 */
    }
  }

  private workers = new Map<string, WorkerRecord>();
  private rrQueue: string[] = [];
  readonly maxWorkers: number;
  readonly idleTtlMs: number;
  readonly entryFile: string;

  constructor(opts: WorkerManagerOptions = {}) {
    const total = os.totalmem();
    // RESERVE：系统余量 + 主进程预算由调用方实验 A 校准后传入；此处先用常量兜底。
    this.maxWorkers =
      opts.maxWorkers ??
      resolveMaxWorkers({ totalMemBytes: total, reserveBytes: SYSTEM_RESERVE_BYTES });
    this.idleTtlMs = opts.idleTtlMs ?? IDLE_TTL_MINUTES * 60 * 1000;
    this.entryFile = opts.entryFile ?? defaultEntry();
  }

  get size(): number {
    return this.workers.size;
  }

  /** placement 后的连接装配用（facade 拿 proc 建连接；不存在返回 undefined）。 */
  procOf(workspace: string): ChildProcess | undefined {
    const rec = this.workers.get(workspace);
    return rec && rec.proc.exitCode === null ? rec.proc : undefined;
  }

  totalRssLimit(mainProcRssBytes: number): number {
    return buildTotalRssLimit({ mainProcRssBytes, maxWorkers: this.maxWorkers });
  }

  /** 空闲 LRU 逐出：本函数内直接 SIGTERM 并摘除，返回被逐出的 workspace 列表。 */
  reapIdle(now = Date.now()): string[] {
    const out: string[] = [];
    for (const [ws, rec] of this.workers) {
      if (now - rec.lastActiveAt >= this.idleTtlMs) {
        out.push(ws);
        try {
          rec.proc.kill("SIGTERM");
        } catch {
          /* best-effort */
        }
        this.workers.delete(ws);
      }
    }
    return out;
  }

  /**
   * 准入：已存在直接 ok；否则先 reap 空闲，满员（达到 maxWorkers）或
   * 超全局软线（总 RSS >= 主进程 + 存量 worker 按软线估算）都进队列排队。
   */
  admit(workspace: string, totalRssBytes: number, mainProcRssBytes: number): "ok" | "queued" {
    if (this.workers.has(workspace)) return "ok";
    this.reapIdle();
    const full = this.workers.size >= this.maxWorkers;
    const soft =
      totalRssBytes >=
      mainProcRssBytes + this.workers.size * WORKER_RSS_SOFT_BYTES;
    if (full || soft) {
      if (!this.rrQueue.includes(workspace)) this.rrQueue.push(workspace);
      return "queued";
    }
    return "ok";
  }

  async spawn(
    workspace: string,
    stateRoot?: string,
    task?: { taskId?: string; actionId?: string; toolCallId?: string },
  ): Promise<WorkerRecord> {
    const existing = this.workers.get(workspace);
    if (existing && existing.proc.exitCode === null) {
      existing.lastActiveAt = Date.now();
      existing.fresh = false;
      return existing;
    }
    const root = stateRoot ?? path.join(dataRoot(), "workers", encodeURIComponent(workspace));
    const epoch = await allocateWorkerEpoch(root);
    // A3：report flags 恒带 + 轮转（留 5 份 + 总量 200MB，超限删最旧）。
    const reportDir = path.join(dataRoot(), "worker-reports");
    await fs.mkdir(reportDir, { recursive: true }).catch(() => {});
    void pruneWorkerReports(reportDir).catch(() => {});
    // A4：PATH shim 注入点——shim 目录 prepend 到 PATH，原二进制绝对路径按
    // EGRESS_BINARIES 逐个解析传入；INTENT_FILE 指到该 stateRoot 的 shim 文件。
    const shimEnv = await resolveShimEnv(root, task);
    const proc = fork(this.entryFile, [], {
      execArgv: [
        "--max-old-space-size=1536",
        "--report-on-fatalerror",
        "--report-uncaught-exception",
        `--report-directory=${reportDir}`,
      ],
      env: {
        ...process.env,
        ...shimEnv,
        FLOWSHIP_WORKER_WORKSPACE: workspace,
        FLOWSHIP_WORKER_EPOCH: String(epoch),
        FLOWSHIP_WORKER_STATE_ROOT: root,
      },
      silent: false,
    });
    const rec: WorkerRecord = {
      workspace,
      stateRoot: root,
      epoch,
      proc,
      lastActiveAt: Date.now(),
      rssBytes: 0,
      fresh: true,
    };
    proc.on("exit", () => {
      // 退出即摘除（兜底重启由调用方按 boot recovery 语义重建）。
      if (this.workers.get(workspace) === rec) this.workers.delete(workspace);
    });
    // worker-entry 自上报（ready/self-report）进统一派发（监听器异常自吞）。
    proc.on("message", (msg) => this.dispatchProcMessage(msg));
    this.workers.set(workspace, rec);
    return rec;
  }

  reportRss(workspace: string, rssBytes: number): void {
    const rec = this.workers.get(workspace);
    if (!rec) return;
    rec.rssBytes = rssBytes;
    rec.lastActiveAt = Date.now();
  }

  workerRssHardBytes(): number {
    return WORKER_RSS_HARD_BYTES;
  }
}

// ---------- A3：report 轮转（留 5 份 + 总量 200MB，超限删最旧） ----------

export const WORKER_REPORT_KEEP = 5 as const;
export const WORKER_REPORT_MAX_BYTES = 200 * 1024 * 1024;

export const pruneWorkerReports = async (
  reportDir: string,
  keep = WORKER_REPORT_KEEP,
  maxBytes = WORKER_REPORT_MAX_BYTES,
): Promise<{ kept: number; removed: number }> => {
  const entries: { name: string; mtime: number; size: number }[] = [];
  try {
    const names = await fs.readdir(reportDir);
    for (const name of names) {
      if (!name.startsWith("report.")) continue;
      try {
        const st = await fs.stat(path.join(reportDir, name));
        entries.push({ name, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* 单文件读不到不管 */
      }
    }
  } catch {
    return { kept: 0, removed: 0 };
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  // 先按份数留最新的 keep 份，其余删。
  const survivors = entries.slice(0, keep);
  const doomed = entries.slice(keep);
  let removed = 0;
  for (const e of doomed) {
    await fs.rm(path.join(reportDir, e.name), { force: true }).catch(() => {});
    removed += 1;
  }
  // 再按总量：超 200MB 时从最旧的幸存者开始删，直到达标。
  let total = survivors.reduce((s, e) => s + e.size, 0);
  for (let i = survivors.length - 1; i >= 0 && total > maxBytes; i--) {
    await fs.rm(path.join(reportDir, survivors[i].name), { force: true }).catch(() => {});
    total -= survivors[i].size;
    removed += 1;
  }
  return { kept: entries.length - removed, removed };
};

// ---------- A4：PATH shim env 解析 ----------

export const WORKER_PATH_SHIM_DIR = path.join(
  process.cwd(),
  "scripts/worker-path-shim",
);

const CANDIDATE_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"];

const findRealBinary = async (name: string): Promise<string | null> => {
  for (const dir of CANDIDATE_BIN_DIRS) {
    const p = path.join(dir, name);
    try {
      await fs.access(p);
      return p;
    } catch {
      /* 继续找 */
    }
  }
  return null;
};

/**
 * A4：shim env 注入点。shim 目录 prepend 到 PATH；FLOWSHIP_REAL_<NAME> 逐个解析；
 * INTENT_FILE 指到该 stateRoot 的 shim 文件；TASK/ACTION/TOOLCALL 由 IPC 下发时更新。
 */
export const resolveShimEnv = async (
  stateRoot: string,
  task?: { taskId?: string; actionId?: string; toolCallId?: string },
): Promise<Record<string, string>> => {
  const env: Record<string, string> = {
    PATH: `${WORKER_PATH_SHIM_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
    FLOWSHIP_INTENT_FILE: shimIntentFile(stateRoot),
    FLOWSHIP_TASK_ID: task?.taskId ?? "unknown",
    FLOWSHIP_ACTION_ID: task?.actionId ?? "unknown",
    FLOWSHIP_TOOLCALL_ID: task?.toolCallId ?? "unknown",
  };
  await Promise.all(
    [...EGRESS_BINARIES].map(async (bin) => {
      const real = await findRealBinary(bin);
      if (real) env[`FLOWSHIP_REAL_${bin.toUpperCase()}`] = real;
    }),
  );
  return env;
};
