/**
 * SDK JSONL store 自动瘦身（2026-09-04 OOM 根治：库级别）。
 *
 * 背景：`sdk-agent-store/checkpoints.ndjson` 只追加不删。每次推进起新 agent，
 * 旧 agent 的 blob 就成孤儿、再也不会被 resume（锚点只留最新的 sessionAgentId），
 * 但文件照样每次被 SDK 扛进内存。实测 210M/1.8万条里只有 2.7% 属于活会话，
 * 单次推进 3 分钟内堆爆、读几十KB小文件能卡出 11 秒墙钟。
 *
 * 做法：boot 后台 + 水位触发时，把不属于任何任务现行 sessionAgentId
 * 的 agent 行删掉（checkpoints / runs / agents / run_events 四份一起）。
 * fail-open：读不出活名单 / 写失败 = 跳过，下次再试，绝不挡启动、绝不丢活数据。
 * 不确定的行一律保留（宁可少删，不可误删）。
 *
 * 流式实现：大文件逐行读逐行写，内存占用 O(行) 而非 O(文件)，GC 自己不能先 OOM。
 */

import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";
import v8 from "node:v8";

import { dataRoot } from "./data-root";
import { SDK_AGENT_STORE_DIRNAME } from "./sdk-agent-store";

const CHECKPOINTS = "checkpoints.ndjson";
const RUNS = "runs.ndjson";
const AGENTS = "agents.ndjson";
const RUN_EVENTS = "run_events.ndjson";

/** 文件超过此大小才值得动（小库不动，避免无谓重写） */
export const GC_MIN_CHECKPOINTS_BYTES = 50 * 1024 * 1024;
/** 备份最多留几份（成功即删旧，只防当轮写坏） */
const KEEP_BACKUPS = 1;
/** 并发 guard：GC 进行中再调直接跳过 */
let gcInFlight = false;

/** 堆水位：超过即认为高压（advance/send 入口直接拒新活、保服务不死） */
export const HEAP_GUARD_RATIO = 0.85;

/** 内存高压错误：调用方一律 `instanceof` 判，别拿字符串匹配。 */
export class HeapPressureError extends Error {
  readonly usedMB: number;
  readonly limitMB: number;
  constructor(
    where: string,
    usedMB: number,
    limitMB: number,
  ) {
    super(
      `服务内存偏高（已用 ${usedMB}MB / 上限 ${limitMB}MB），${where}已拒绝、` +
        `等 10 秒自动清理完成后再试，不用重启。`,
    );
    this.name = "HeapPressureError";
    this.usedMB = usedMB;
    this.limitMB = limitMB;
  }
}

const storeDir = (): string => path.join(dataRoot(), SDK_AGENT_STORE_DIRNAME);

const safeJson = (line: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(line) as unknown;
    return typeof o === "object" && o !== null
      ? (o as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const strAt = (o: Record<string, unknown>, p: string[]): string | null => {
  let cur: unknown = o;
  for (const k of p) {
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" ? cur : null;
};

/** 收集所有任务现行 sessionAgentId（活名单）。失败返 null = 跳过本轮 GC。 */
export const collectLiveAgentIds = async (
  tasksDir?: string,
): Promise<Set<string> | null> => {
  try {
    const dir = tasksDir ?? path.join(dataRoot(), "tasks");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const live = new Set<string>();
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const raw = await fs.readFile(
          path.join(dir, e.name, "meta.json"),
          "utf-8",
        );
        const meta = JSON.parse(raw) as { sessionAgentId?: unknown };
        if (typeof meta.sessionAgentId === "string" && meta.sessionAgentId) {
          live.add(meta.sessionAgentId);
        }
      } catch {
        // 单个 meta 坏了不影响整轮
      }
    }
    return live;
  } catch {
    return null;
  }
};

type AgentOfLine = { agentId: string | null; runId: string | null };

const agentOfLine = (file: string, o: Record<string, unknown>): AgentOfLine => {
  if (file === RUN_EVENTS) {
    const agentId =
      strAt(o, ["payload", "agentId"]) ??
      strAt(o, ["payload", "message", "agent_id"]) ??
      strAt(o, ["payload", "message", "agentId"]) ??
      (typeof o.agentId === "string" ? o.agentId : null);
    const runId =
      typeof o.runId === "string"
        ? o.runId
        : (strAt(o, ["payload", "runId"]) ?? null);
    return { agentId, runId };
  }
  const agentId = typeof o.agentId === "string" ? o.agentId : null;
  const runId = typeof o.runId === "string" ? o.runId : null;
  return { agentId, runId };
};

/**
 * 纯函数：这一行要不要留。live 命中留；拿不到归属 / 解析不出留（fail-open）；
 * 只有明确孤儿才删。单测直接锁这条。
 */
export const shouldKeepLine = (
  file: string,
  line: string,
  live: Set<string>,
  runToAgent: Map<string, string>,
): boolean => {
  if (!line.trim()) return false;
  const o = safeJson(line);
  if (!o) return true;
  const found = agentOfLine(file, o);
  const runId = found.runId;
  let agentId = found.agentId;
  if (!agentId && runId && runToAgent.has(runId)) {
    agentId = runToAgent.get(runId)!;
  }
  if (!agentId) return true;
  return live.has(agentId);
};

const pruneBackups = async (dir: string): Promise<void> => {
  try {
    const entries = await fs.readdir(dir);
    const baks = entries.filter((n) => n.startsWith(".gc-backup-")).sort();
    while (baks.length > KEEP_BACKUPS) {
      const oldest = baks.shift()!;
      await fs.rm(path.join(dir, oldest), { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
};

export interface GcStats {
  skipped?: string;
  checkpointsBefore?: number;
  checkpointsAfter?: number;
  bytesBefore?: number;
  bytesAfter?: number;
}

export interface GcOptions {
  /** 覆盖 store 目录（单测用；默认 dataRoot 下的） */
  dir?: string;
  /** 覆盖触发水位（单测用小库） */
  minBytes?: number;
}

/**
 * 跑一轮瘦身。调用方直接 await 或 fire-and-forget 均可，内部永不抛。
 * @returns 统计（含 skipped 原因）
 */
export const gcSdkStoreOnce = async (opts?: GcOptions): Promise<GcStats> => {
  if (gcInFlight) return { skipped: "in-flight" };
  gcInFlight = true;
  try {
    const dir = opts?.dir ?? storeDir();
    const minBytes = opts?.minBytes ?? GC_MIN_CHECKPOINTS_BYTES;
    const cpPath = path.join(dir, CHECKPOINTS);
    let cpSize: number;
    try {
      cpSize = (await fs.stat(cpPath)).size;
    } catch {
      return { skipped: "no-store" };
    }
    if (cpSize < minBytes) {
      return { skipped: "small" };
    }
    const live = await collectLiveAgentIds(path.join(path.dirname(dir), "tasks"));
    if (!live) return { skipped: "no-live-list" };
    if (live.size === 0) {
      console.warn(
        `[sdk-store-gc] checkpoints 已 ${Math.round(cpSize / 1048576)}MB 但活名单为空、不敢删（全清任务后的残留），跳过本轮`,
      );
      return { skipped: "empty-live-list" };
    }

    // runId → agentId 映射（runs 文件小，全量读没事；run_events 靠它兜底）
    const runToAgent = new Map<string, string>();
    try {
      const runsRaw = await fs.readFile(path.join(dir, RUNS), "utf-8");
      for (const line of runsRaw.split("\n")) {
        if (!line.trim()) continue;
        const o = safeJson(line);
        if (!o) continue;
        const { agentId, runId } = agentOfLine(RUNS, o);
        if (agentId && runId) runToAgent.set(runId, agentId);
      }
    } catch {
      /* runs 读不到就只靠行内 agentId */
    }

    // 备份（只备四份 ndjson，不备整个目录）
    const bakDir = path.join(dir, `.gc-backup-${Date.now()}`);
    try {
      await fs.mkdir(bakDir, { recursive: true });
      for (const f of [CHECKPOINTS, RUNS, AGENTS, RUN_EVENTS]) {
        try {
          await fs.copyFile(path.join(dir, f), path.join(bakDir, f));
        } catch {
          /* 单文件缺失不管 */
        }
      }
    } catch {
      return { skipped: "backup-failed" };
    }
    await pruneBackups(dir);

    let bytesBefore = 0;
    let bytesAfter = 0;
    let cpBefore = 0;
    let cpAfter = 0;
    for (const f of [CHECKPOINTS, RUNS, AGENTS, RUN_EVENTS]) {
      const p = path.join(dir, f);
      let st: { size: number };
      try {
        st = await fs.stat(p);
      } catch {
        continue;
      }
      bytesBefore += st.size;
      const tmp = `${p}.gc-tmp`;
      let kept = 0;
      let total = 0;
      const out = fsSync.createWriteStream(tmp, { encoding: "utf-8" });
      try {
        const rl = readline.createInterface({
          input: fsSync.createReadStream(p, { encoding: "utf-8" }),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (!line.trim()) continue;
          total += 1;
          if (shouldKeepLine(f, line, live, runToAgent)) {
            kept += 1;
            if (!out.write(`${line}\n`)) {
              await new Promise<void>((res) => out.once("drain", () => res()));
            }
          }
        }
      } finally {
        await new Promise<void>((res, rej) => {
          out.end(() => res());
          out.on("error", rej);
        });
      }
      await fs.rename(tmp, p);
      bytesAfter += (await fs.stat(p)).size;
      if (f === CHECKPOINTS) {
        cpBefore = total;
        cpAfter = kept;
      }
    }
    console.log(
      `[sdk-store-gc] checkpoints ${cpBefore}→${cpAfter} 行、` +
        `${Math.round(bytesBefore / 1048576)}MB→${Math.round(bytesAfter / 1048576)}MB，活 agent ${live.size} 个`,
    );
    return {
      checkpointsBefore: cpBefore,
      checkpointsAfter: cpAfter,
      bytesBefore,
      bytesAfter,
    };
  } catch (err) {
    console.warn("[sdk-store-gc] 本轮跳过:", err);
    return { skipped: "error" };
  } finally {
    gcInFlight = false;
  }
};

/** fire-and-forget 包装：boot / 定时任务用，不抛。 */
export const maybeGcSdkStore = (): void => {
  void gcSdkStoreOnce().catch(() => {});
};

// ---------- 堆内存门 ----------

export interface HeapPressure {
  usedMB: number;
  limitMB: number;
  ratio: number;
  over: boolean;
}

export const heapPressure = (): HeapPressure => {
  const stats = v8.getHeapStatistics();
  const limit = stats.heap_size_limit || 2 * 1024 * 1024 * 1024;
  const used = stats.used_heap_size || 0;
  const ratio = limit > 0 ? used / limit : 0;
  return {
    usedMB: Math.round(used / 1048576),
    limitMB: Math.round(limit / 1048576),
    ratio,
    over: ratio >= HEAP_GUARD_RATIO,
  };
};

/**
 * 入口门禁：堆高压时直接抛 HeapPressureError（调用方冒到 UI，不建新 agent）。
 * 抛之前顺手触发一轮异步 GC。调用方判 `instanceof HeapPressureError`。
 */
export const assertHeapOk = (where: string): void => {
  const p = heapPressure();
  if (!p.over) return;
  maybeGcSdkStore();
  throw new HeapPressureError(where, p.usedMB, p.limitMB);
};
