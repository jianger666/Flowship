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
 *
 * 两条路径（2026-10-08）：
 *   - store 路径（默认）：checkpoints 由 FastCheckpoints 独占写（单写者不变式），GC 不得绕过它
 *     直接改文件——否则会毁掉它的偏移索引，还会和它的追加互相覆盖丢数据。所以改走
 *     store 的公共 API（list / delete，agentIds 批量过滤），经它自己的写队列串行化。
 *   - 文件路径（旧）：直接流式改写四份 ndjson。只在没有句柄 / 回退到 SDK 自带实现时用，
 *     行为与改造前逐字一致。
 */

import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";
import v8 from "node:v8";

import type {
  LocalAgentDocument,
  LocalAgentRunDocument,
  LocalAgentStoreListResult,
} from "@cursor/sdk";

import { dataRoot } from "./data-root";
import { withRetry, type RetryOptions } from "./fast-checkpoint-store";
import {
  getSdkStoreHandle,
  SDK_AGENT_STORE_DIRNAME,
  type SdkStoreHandle,
} from "./sdk-agent-store";

const CHECKPOINTS = "checkpoints.ndjson";
const RUNS = "runs.ndjson";
const AGENTS = "agents.ndjson";
const RUN_EVENTS = "run_events.ndjson";

/** 文件超过此大小才值得动（小库不动，避免无谓重写） */
export const GC_MIN_CHECKPOINTS_BYTES = 50 * 1024 * 1024;
/** 备份最多留几份（成功即删旧，只防当轮写坏） */
const KEEP_BACKUPS = 1;
/**
 * 新建 / 刚活动过的 agent 不当孤儿：SDK 先落 agents 行 / checkpoint，Flowship 稍后才把
 * sessionAgentId 写进 meta.json，这个窗口里它不在活名单里。只看时间、不看 status——
 * 被打崩时遗留的「僵尸 running」要能被回收。
 */
export const GC_GRACE_MS = 10 * 60 * 1000;
/** store 公共 API 分页大小 / 翻页上限（防分页不收敛死循环） */
const LIST_PAGE = 500;
const MAX_LIST_PAGES = 10_000;
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

/**
 * 备份（只备四份 ndjson，不备整个目录）并裁剪旧备份。false = 备份目录都建不出来，调用方应跳过本轮。
 * store 路径下 checkpoints 可能正被追加：备份里最多多一个半行尾，恢复时 SDK / FastCheckpoints 都容忍。
 */
const backupStoreFiles = async (dir: string): Promise<boolean> => {
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
    return false;
  }
  await pruneBackups(dir);
  return true;
};

export interface GcStats {
  skipped?: string;
  /** 走了哪条路径：store = 经 store 公共 API；files = 直接改文件（旧） */
  via?: "store" | "files";
  checkpointsBefore?: number;
  checkpointsAfter?: number;
  bytesBefore?: number;
  bytesAfter?: number;
  /** store 路径：本轮清掉的孤儿 agent 数 */
  orphanAgents?: number;
}

export interface GcOptions {
  /** 覆盖 store 目录（单测用；默认 dataRoot 下的） */
  dir?: string;
  /** 覆盖触发水位（单测用小库） */
  minBytes?: number;
  /**
   * store 句柄：缺省取进程级单例；显式传 null = 强制走文件路径。
   * 指定了 `dir`（单测覆盖目录）又没传 handle 时一律走文件路径，避免测试误碰真实库。
   */
  handle?: SdkStoreHandle | null;
  /** 覆盖「刚活动过不当孤儿」的宽限（单测用） */
  graceMs?: number;
  /** 覆盖当前时间（单测用） */
  now?: number;
  /** 覆盖 store 列表分页大小（单测用，验证多页能翻完） */
  pageSize?: number;
  /** 覆盖文件路径里 rename 的重试参数（单测注入平台 / 免真等；生产不传） */
  retry?: RetryOptions;
}

/**
 * 旧路径：直接流式改写四份 ndjson。仅在没有 store 句柄 / 回退到 SDK 自带实现时使用，
 * 行为与 2026-10-08 改造前一致。调用方（gcSdkStoreOnce）负责 in-flight 互斥。
 */
const gcByFiles = async (opts?: GcOptions): Promise<GcStats> => {
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
    if (!(await backupStoreFiles(dir))) return { skipped: "backup-failed" };

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
      // Windows：杀毒 / 索引器 / 云同步会随机占住目标文件（EPERM / EBUSY），稍等就好——退避重试；
      // POSIX 上只重试句柄耗尽类，真权限错误不白等。耗尽预算仍失败 = 抛给外层 fail-open（原文件没动）
      await withRetry(() => fs.rename(tmp, p), opts?.retry);
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
      via: "files",
      checkpointsBefore: cpBefore,
      checkpointsAfter: cpAfter,
      bytesBefore,
      bytesAfter,
    };
  } catch (err) {
    console.warn("[sdk-store-gc] 本轮跳过:", err);
    return { skipped: "error" };
  }
};

// ---------- store 路径：经 store 公共 API 清孤儿 ----------

type AgentLite = Pick<LocalAgentDocument, "agentId" | "createdAt" | "updatedAt">;
type RunLite = Pick<
  LocalAgentRunDocument,
  "runId" | "agentId" | "createdAt" | "updatedAt"
>;

export interface OrphanPlanInput {
  /** 任务现行 sessionAgentId */
  live: ReadonlySet<string>;
  /** checkpoints 里出现过的 agentId（含 agents 表里已没有记录的残留） */
  checkpointAgentIds: readonly string[];
  agents: readonly AgentLite[];
  runs: readonly RunLite[];
  /** 本进程写过 checkpoint 的 agent（含刚创建、meta 还没落盘的） */
  touched: ReadonlySet<string>;
  now: number;
  graceMs: number;
}

export interface OrphanPlan {
  /** 要清掉的 agentId */
  orphans: string[];
  /** 这些 agent 名下的 runId（run_events 按它删） */
  orphanRunIds: string[];
  /** 候选里因 live / 本进程写过 / 宽限期 / id 不确定而保留的 agent 数 */
  kept: number;
}

/**
 * 纯函数：算出孤儿 agent。保守原则——live、本进程写过、近期（created / updated 在宽限内）、
 * id 不确定的一律保留；只有「哪都不认」的才是孤儿。单测直接锁这条。
 */
export const planOrphans = (i: OrphanPlanInput): OrphanPlan => {
  const recent = new Set<string>();
  const stamp = (agentId: string, createdAt: number, updatedAt: number): void => {
    const t = Math.max(createdAt, updatedAt);
    // 时间字段异常（NaN / 非有限）按「近期」处理——宁可少删
    if (!Number.isFinite(t) || i.now - t < i.graceMs) recent.add(agentId);
  };
  for (const a of i.agents) stamp(a.agentId, a.createdAt, a.updatedAt);
  for (const r of i.runs) stamp(r.agentId, r.createdAt, r.updatedAt);

  const candidates = new Set<string>(i.checkpointAgentIds);
  for (const a of i.agents) candidates.add(a.agentId);
  for (const r of i.runs) candidates.add(r.agentId);

  const orphans: string[] = [];
  let kept = 0;
  for (const id of candidates) {
    if (!id || i.live.has(id) || i.touched.has(id) || recent.has(id)) {
      kept += 1;
      continue;
    }
    orphans.push(id);
  }
  const doomed = new Set(orphans);
  const orphanRunIds = i.runs
    .filter((r) => doomed.has(r.agentId))
    .map((r) => r.runId);
  return { orphans, orphanRunIds, kept };
};

/**
 * SDK 的删除过滤器约定「列表为空 = 匹配全部」（见 LocalAgentRunFilter 等的注释）。
 * 空数组传进去就是清库，所以每次删除前都过这道守卫：宁可抛错也不清空。
 */
export const nonEmpty = <T>(list: readonly T[], what: string): readonly T[] => {
  if (list.length === 0) {
    throw new Error(`拒绝用空 ${what} 过滤器删除（SDK 约定空 = 匹配全部）`);
  }
  return list;
};

/** 翻完 store 的分页列表。MAX_LIST_PAGES 防分页不收敛死循环。 */
const drain = async <T>(
  page: (cursor: string | undefined) => Promise<LocalAgentStoreListResult<T>>,
): Promise<T[]> => {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < MAX_LIST_PAGES; n += 1) {
    const r = await page(cursor);
    out.push(...r.items);
    if (!r.nextCursor) return out;
    cursor = r.nextCursor;
  }
  throw new Error(`store 列表翻页超过 ${MAX_LIST_PAGES} 页仍未结束`);
};

const storeFilesBytes = async (dir: string): Promise<number> => {
  let n = 0;
  for (const f of [CHECKPOINTS, RUNS, AGENTS, RUN_EVENTS]) {
    try {
      n += (await fs.stat(path.join(dir, f))).size;
    } catch {
      /* 缺失当 0 */
    }
  }
  return n;
};

type FastHandle = SdkStoreHandle & {
  fast: NonNullable<SdkStoreHandle["fast"]>;
};

const gcViaStore = async (
  handle: FastHandle,
  opts?: GcOptions,
): Promise<GcStats> => {
  const { store, fast, dir } = handle;
  const minBytes = opts?.minBytes ?? GC_MIN_CHECKPOINTS_BYTES;
  const before = fast.getStats();
  if (before.bytes < minBytes) return { skipped: "small" };

  const live = await collectLiveAgentIds(path.join(path.dirname(dir), "tasks"));
  if (!live) return { skipped: "no-live-list" };
  if (live.size === 0) {
    console.warn(
      `[sdk-store-gc] checkpoints 已 ${Math.round(before.bytes / 1048576)}MB 但活名单为空、不敢删（全清任务后的残留），跳过本轮`,
    );
    return { skipped: "empty-live-list" };
  }

  const limit = opts?.pageSize ?? LIST_PAGE;
  const [agents, runs, checkpointAgentIds] = await Promise.all([
    drain((cursor) => store.agents.list({ filter: { cursor, limit } })),
    drain((cursor) => store.runs.list({ filter: { cursor, limit } })),
    fast.agentIds(),
  ]);
  const plan = planOrphans({
    live,
    checkpointAgentIds,
    agents,
    runs,
    touched: fast.touchedAgentIds(),
    now: opts?.now ?? Date.now(),
    graceMs: opts?.graceMs ?? GC_GRACE_MS,
  });
  const bytesBefore = await storeFilesBytes(dir);
  if (plan.orphans.length === 0) {
    return {
      via: "store",
      checkpointsBefore: before.blobs,
      checkpointsAfter: before.blobs,
      bytesBefore,
      bytesAfter: bytesBefore,
      orphanAgents: 0,
    };
  }

  if (!(await backupStoreFiles(dir))) return { skipped: "backup-failed" };

  // 顺序：先依赖（run_events → runs → checkpoints），agents 行最后删——中途失败时孤儿
  // 仍留着 agents 行，下一轮会被重新识别并接着清（幂等、可重入）。
  if (plan.orphanRunIds.length > 0) {
    await store.runEvents.delete({
      filter: { runIds: nonEmpty(plan.orphanRunIds, "runIds") },
    });
  }
  const agentIds = nonEmpty(plan.orphans, "agentIds");
  await store.runs.delete({ filter: { agentIds } });
  await store.checkpoints.delete({ filter: { agentIds } });
  // agents.delete 在「一个都没匹配」时会抛 `No agents matched delete filter`（SDK 约定）。
  // 幽灵孤儿（只剩 checkpoints 残留）没有 agents 行，所以只对快照里真有行的删。
  const rowIds = new Set(agents.map((a) => a.agentId));
  const withRow = agentIds.filter((id) => rowIds.has(id));
  if (withRow.length > 0) {
    await store.agents.delete({
      filter: { agentIds: nonEmpty(withRow, "agentIds") },
    });
  }

  const after = fast.getStats();
  const bytesAfter = await storeFilesBytes(dir);
  console.log(
    `[sdk-store-gc] checkpoints ${before.blobs}→${after.blobs} 条、` +
      `${Math.round(bytesBefore / 1048576)}MB→${Math.round(bytesAfter / 1048576)}MB，` +
      `清孤儿 agent ${plan.orphans.length} 个、保留 ${plan.kept} 个（经 store API）`,
  );
  return {
    via: "store",
    checkpointsBefore: before.blobs,
    checkpointsAfter: after.blobs,
    bytesBefore,
    bytesAfter,
    orphanAgents: plan.orphans.length,
  };
};

/**
 * 跑一轮瘦身。调用方直接 await 或 fire-and-forget 均可，内部永不抛。
 * 路径选择见文件头；@returns 统计（含 skipped 原因）
 */
export const gcSdkStoreOnce = async (opts?: GcOptions): Promise<GcStats> => {
  if (gcInFlight) return { skipped: "in-flight" };
  gcInFlight = true;
  try {
    // handle：显式传入（含 null = 强制文件路径）以传入为准；缺省取进程级单例，
    // 但单测覆盖了 dir 时不碰单例（它指向真实数据目录）。
    const handle =
      opts?.handle !== undefined
        ? opts.handle
        : opts?.dir
          ? null
          : await getSdkStoreHandle();
    if (handle?.mode === "fast" && handle.fast) {
      return await gcViaStore({ ...handle, fast: handle.fast }, opts);
    }
    return await gcByFiles(opts);
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
