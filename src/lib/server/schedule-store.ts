/**
 * 定时任务落盘层（`tasks/<id>/schedules.json`）。
 *
 * - 跟会话同生命周期：任务目录被删，定时文件随之消失；归档由 {@link cancelAllSchedulesForTask} 主动取消。
 * - 所有读改写都走 `withTaskLock` 内的 {@link mutateSchedules}：调度器 tick / 工具调用 / 管理页 API
 *   并发时不会丢更新。**fn 里不要再调 withTaskLock**（同一把锁，会死锁）。
 * - 「任务还活着才写」：落盘前锁内复查目录存在且没打删除标记，任务被删之后绝不把目录又建出来
 *  （同 subagent-transcript 的写法）。
 * - 内存里只留一个「哪些任务有会触发的定时」索引（给调度器 tick 用），权威数据始终是盘上文件。
 *   索引放 globalThis：Next dev 下不同 route 是不同 webpack chunk，模块级变量会各持一份。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildScheduleRecord,
  isFinishedStatus,
  isValidScheduleRecord,
  markCancelled,
  markPaused,
  markResumed,
  pruneFinished,
  SCHEDULE_FILE,
  SCHEDULE_MAX_ACTIVE_PER_TASK,
  type ScheduleCreateInput,
  type ScheduleFile,
  type ScheduleRecord,
} from "@/lib/schedule";

import { writePrivateFileAtomic } from "./data-root";
import { mapLimit } from "./map-limit";
import {
  DATA_DIR,
  DELETED_TOMBSTONE_FILE,
  taskDir,
  withTaskLock,
} from "./task-fs-core";

const warn = (msg: string, err?: unknown): void => {
  console.warn(`[schedule-store] ${msg}`, err instanceof Error ? err.message : (err ?? ""));
};

/**
 * 只读路径上的「文件损坏」告警限频：定时条 / 管理页 / 调度器 tick 都会反复读同一个坏文件，
 * 每次都 warn 会把日志刷满（真正动手处理——改名留证据——只发生在写路径，那边每次都是一次性的、照常告警）。
 */
export const CORRUPT_READ_WARN_INTERVAL_MS = 60_000;
const corruptWarnedAt = new Map<string, number>();
const warnCorruptRead = (taskId: string, err: unknown): void => {
  const now = Date.now();
  const last = corruptWarnedAt.get(taskId);
  if (last !== undefined && now - last < CORRUPT_READ_WARN_INTERVAL_MS) return;
  if (corruptWarnedAt.size > 200) corruptWarnedAt.clear(); // 防无界增长：清空只会多告警一次
  corruptWarnedAt.set(taskId, now);
  warn(`schedules.json 解析失败（读路径、不改文件；${CORRUPT_READ_WARN_INTERVAL_MS / 1000}s 内不重复提示） task=${taskId}`, err);
};

const filePath = (taskId: string): string => path.join(taskDir(taskId), SCHEDULE_FILE);

const isNotFound = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * 任务目录还在、且没被打逻辑删除标记。
 * 只有「确实不存在」（ENOENT / ENOTDIR）才算任务没了；EMFILE / EIO / EACCES 这类**读不出来**的错误向上抛——
 * 当成「任务没了」会把它从调度索引里悄悄摘掉、之后再也不 tick，而且没有任何日志。
 */
const taskDirUsable = async (taskId: string): Promise<boolean> => {
  const dir = taskDir(taskId);
  let st: import("node:fs").Stats;
  try {
    st = await fs.stat(dir);
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
  if (!st.isDirectory()) return false;
  try {
    await fs.stat(path.join(dir, DELETED_TOMBSTONE_FILE));
    return false;
  } catch (err) {
    if (isNotFound(err)) return true;
    throw err;
  }
};

// ----------------- 「有会触发的定时」索引 -----------------

const INDEX_KEY = "__flowshipScheduleLiveIndexV1__";
const liveIndex = (): Set<string> => {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  if (!g[INDEX_KEY]) g[INDEX_KEY] = new Set();
  return g[INDEX_KEY]!;
};

/** 这条记录还需要调度器盯着：active（含正在投递的），或 paused 但有手动触发的待投递 */
const needsTicking = (r: ScheduleRecord): boolean =>
  r.status === "active" || r.pending !== undefined;

const refreshIndex = (taskId: string, list: readonly ScheduleRecord[]): void => {
  if (list.some(needsTicking)) liveIndex().add(taskId);
  else liveIndex().delete(taskId);
};

/**
 * 用一份刚读到的列表校正某任务在索引里的状态（调度器 tick 读完调）。
 * 索引只在写盘时刷新；tick 读到「已经没有需要盯的了」就该顺手摘掉，别让它每 5 秒白读一遍。
 */
export const syncScheduleIndex = (taskId: string, list: readonly ScheduleRecord[]): void =>
  refreshIndex(taskId, list);

/** 调度器 tick 用：当前有需要盯着的定时的任务 id */
export const scheduleLiveTaskIds = (): string[] => [...liveIndex()];

/** 任务被删：把它从索引里摘掉（文件随目录没了） */
export const forgetSchedulesForDeletedTask = (taskId: string): void => {
  liveIndex().delete(taskId);
};

// ----------------- 读 / 写 -----------------

type ParsedScheduleFile =
  | { kind: "ok"; list: ScheduleRecord[]; dropped: number }
  | { kind: "corrupt"; error: unknown };

/** 文件文本 → 记录；整体不是合法结构 = corrupt，单条坏记录丢弃并计数（dropped） */
const parseScheduleFile = (raw: string, taskId: string): ParsedScheduleFile => {
  try {
    const parsed = JSON.parse(raw) as Partial<ScheduleFile> | null;
    if (!parsed || !Array.isArray(parsed.schedules)) {
      return { kind: "corrupt", error: new Error("缺少 schedules 数组") };
    }
    const list = parsed.schedules.filter(isValidScheduleRecord).map((r) => ({
      ...r,
      // taskId 以所在目录为准（防手改 / 搬家后串号）
      taskId,
    }));
    return { kind: "ok", list, dropped: parsed.schedules.length - list.length };
  } catch (err) {
    return { kind: "corrupt", error: err };
  }
};

/** 读文件文本：没有文件 = null；其它读错误（EMFILE / EIO / EACCES / 路径是目录…）原样抛，绝不当成「空」 */
const readScheduleText = async (taskId: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath(taskId), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw err;
  }
};

/**
 * 读一个任务的全部定时记录（**只读**，不改任何文件）。
 * - 没有文件 → 空；
 * - 文件坏了（不是 JSON / 结构不对）→ 空 + 告警，单条坏记录丢弃；原文件原样留着，不在读路径上动它；
 * - 读不出来（EMFILE / EIO / EACCES…）→ 抛。调用方（tick / 工具 / 接口）各自接住，**不能**把它当空列表：
 *   接着写就会把只剩一条的新文件盖到旧文件上，其余定时无痕消失。
 */
export const readSchedules = async (taskId: string): Promise<ScheduleRecord[]> => {
  const raw = await readScheduleText(taskId);
  if (raw === null) return [];
  const parsed = parseScheduleFile(raw, taskId);
  if (parsed.kind === "corrupt") {
    warnCorruptRead(taskId, parsed.error);
    return [];
  }
  return parsed.list;
};

/**
 * 读改写路径专用的读：和 {@link readSchedules} 的区别是——**接下来要写**，所以绝不能让旧内容悄悄消失。
 * - 文件坏了 → 先把原文件改名 `schedules.json.corrupt-<ts>`（留证据、可手工找回）再从空开始；
 *   改名失败 → 抛，本次 mutate 放弃写入；
 * - 个别记录坏了（被丢弃）→ 同样先把原文件复制一份 `.corrupt-<ts>` 再写。
 */
const readForMutate = async (taskId: string): Promise<ScheduleRecord[]> => {
  const raw = await readScheduleText(taskId);
  if (raw === null) return [];
  const parsed = parseScheduleFile(raw, taskId);
  const file = filePath(taskId);
  if (parsed.kind === "corrupt") {
    const backup = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, backup);
    warn(`schedules.json 已损坏、原文件改名为 ${path.basename(backup)} task=${taskId}`, parsed.error);
    return [];
  }
  if (parsed.dropped > 0) {
    const backup = `${file}.corrupt-${Date.now()}`;
    await fs.copyFile(file, backup);
    warn(
      `schedules.json 有 ${parsed.dropped} 条无效记录被丢弃、原文件已备份为 ${path.basename(backup)} task=${taskId}`,
    );
  }
  return parsed.list;
};

export type MutateResult<T> =
  | { ok: true; result: T }
  | { ok: false; reason: "task_gone" };

/**
 * 锁内读 → 改 → 写。`fn` 返回新列表与要带出去的结果；`changed:false` 则不落盘。
 * 任务目录已不可用（确实不存在 / 已打删除标记）→ `{ok:false, reason:"task_gone"}`（也会把索引摘掉）。
 * 读不出来的 IO 错误（目录 stat / 文件读 / 坏文件改名失败）→ 抛：本次放弃写入，索引原样不动。
 */
export const mutateSchedules = <T>(
  taskId: string,
  fn: (list: ScheduleRecord[]) => { list: ScheduleRecord[]; result: T; changed?: boolean },
): Promise<MutateResult<T>> =>
  withTaskLock(taskId, async (): Promise<MutateResult<T>> => {
    if (!(await taskDirUsable(taskId))) {
      liveIndex().delete(taskId);
      return { ok: false, reason: "task_gone" };
    }
    const current = await readForMutate(taskId);
    const out = fn(current);
    const next = pruneFinished(out.list);
    if (out.changed !== false) {
      const body: ScheduleFile = { v: 1, schedules: next };
      await writePrivateFileAtomic(filePath(taskId), JSON.stringify(body, null, 2));
    }
    refreshIndex(taskId, next);
    return { ok: true, result: out.result };
  });

const replaceOne = (
  list: ScheduleRecord[],
  id: string,
  next: ScheduleRecord,
): ScheduleRecord[] => list.map((r) => (r.id === id ? next : r));

// ----------------- 业务操作 -----------------

export type CreateResult =
  | { ok: true; record: ScheduleRecord }
  | { ok: false; error: string };

export const createSchedule = async (
  taskId: string,
  input: ScheduleCreateInput,
  now: number = Date.now(),
): Promise<CreateResult> => {
  const out = await mutateSchedules<CreateResult>(taskId, (list) => {
    const active = list.filter((r) => r.status === "active" || r.status === "paused").length;
    if (active >= SCHEDULE_MAX_ACTIVE_PER_TASK) {
      return {
        list,
        changed: false,
        result: {
          ok: false,
          error: `这个会话的定时已经有 ${active} 条在跑，先取消不用的再建。`,
        },
      };
    }
    const record = buildScheduleRecord(taskId, input, now);
    return { list: [...list, record], result: { ok: true, record } };
  });
  if (!out.ok) return { ok: false, error: "会话已不存在，无法创建定时。" };
  return out.result;
};

export type OpResult =
  | { ok: true; record: ScheduleRecord }
  | { ok: false; error: string; code: "not_found" | "bad_state" | "task_gone" };

const opOne = async (
  taskId: string,
  id: string,
  step: (r: ScheduleRecord) => { next: ScheduleRecord } | { error: string },
): Promise<OpResult> => {
  const out = await mutateSchedules<OpResult>(taskId, (list) => {
    const cur = list.find((r) => r.id === id);
    if (!cur) {
      return {
        list,
        changed: false,
        result: { ok: false, error: "没有这条定时（可能已被清理）。", code: "not_found" },
      };
    }
    const s = step(cur);
    if ("error" in s) {
      return {
        list,
        changed: false,
        result: { ok: false, error: s.error, code: "bad_state" },
      };
    }
    return {
      list: replaceOne(list, id, s.next),
      result: { ok: true, record: s.next },
    };
  });
  if (!out.ok) return { ok: false, error: "会话已不存在。", code: "task_gone" };
  return out.result;
};

export const cancelSchedule = (
  taskId: string,
  id: string,
  note: string,
  now: number = Date.now(),
): Promise<OpResult> =>
  opOne(taskId, id, (r) =>
    isFinishedStatus(r.status)
      ? { error: "这条定时已经结束，不用取消。" }
      : { next: markCancelled(r, now, note) },
  );

export const pauseSchedule = (
  taskId: string,
  id: string,
  now: number = Date.now(),
): Promise<OpResult> =>
  opOne(taskId, id, (r) =>
    r.status !== "active" ? { error: "只有进行中的定时才能暂停。" } : { next: markPaused(r, now) },
  );

export const resumeSchedule = (
  taskId: string,
  id: string,
  now: number = Date.now(),
): Promise<OpResult> =>
  opOne(taskId, id, (r) =>
    r.status !== "paused" ? { error: "只有已暂停的定时才能恢复。" } : { next: markResumed(r, now) },
  );

/** 从历史里删掉一条「已结束」的记录（管理页清理用）。还活着的不许删——先取消 */
export const removeFinishedSchedule = async (
  taskId: string,
  id: string,
): Promise<OpResult> => {
  const out = await mutateSchedules<OpResult>(taskId, (list) => {
    const cur = list.find((r) => r.id === id);
    if (!cur) {
      return {
        list,
        changed: false,
        result: { ok: false, error: "没有这条定时（可能已被清理）。", code: "not_found" },
      };
    }
    if (!isFinishedStatus(cur.status)) {
      return {
        list,
        changed: false,
        result: { ok: false, error: "还在进行的定时不能直接删除，先取消。", code: "bad_state" },
      };
    }
    return { list: list.filter((r) => r.id !== id), result: { ok: true, record: cur } };
  });
  if (!out.ok) return { ok: false, error: "会话已不存在。", code: "task_gone" };
  return out.result;
};

/** 归档 / 任务终结：把这个会话所有还活着的定时取消。返回被取消的条数 */
export const cancelAllSchedulesForTask = async (
  taskId: string,
  note: string,
  now: number = Date.now(),
): Promise<number> => {
  const out = await mutateSchedules<number>(taskId, (list) => {
    let n = 0;
    const next = list.map((r) => {
      if (isFinishedStatus(r.status)) return r;
      n += 1;
      return markCancelled(r, now, note);
    });
    return { list: next, result: n, changed: n > 0 };
  });
  return out.ok ? out.result : 0;
};

// ----------------- 全局枚举 -----------------

/** 扫目录时 stat 的并发上限：任务目录可能有几千个，别一次性全发出去占满线程池 */
const SCAN_CONCURRENCY = 32;

/** 扫数据目录：哪些任务目录里有 schedules.json（管理页 / 启动重建索引用） */
export const listTaskIdsWithScheduleFile = async (): Promise<string[]> => {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  // 数据目录里可能混着手工目录（含点号等）；taskDir() 对非法 id 会抛，这里先挡掉
  const names = entries
    .filter((e) => e.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(e.name))
    .map((e) => e.name);
  // 有界并发；结果按目录顺序（不随 stat 完成先后抖）
  const hits = await mapLimit(names, SCAN_CONCURRENCY, async (name) => {
    try {
      await fs.stat(path.join(DATA_DIR, name, SCHEDULE_FILE));
      return name;
    } catch {
      return null; // 没有定时文件
    }
  });
  return hits.filter((n): n is string => n !== null);
};

/** 启动时重建索引（只读，不改任何文件；每个任务在它自己的任务锁内读） */
export const rebuildScheduleIndex = async (): Promise<void> => {
  const ids = await listTaskIdsWithScheduleFile();
  for (const id of ids) {
    try {
      // 锁内读 + 刷新：与同任务的 mutate 串行，避免用一份读在前、写在后的旧列表覆盖刚被 mutate 刷新的索引
      await withTaskLock(id, async () => refreshIndex(id, await readSchedules(id)));
    } catch (err) {
      // 读不出来 ≠ 没有定时：先留在索引里，让 tick 之后再读（读好了会按真实内容校正）。
      // 当成「没有」摘掉的话，一次瞬时的 EMFILE / EIO 就会让这个任务的定时到重启前都不再触发
      liveIndex().add(id);
      warn(`重建索引时读取失败、先留在索引里等 tick 重试 task=${id}`, err);
    }
  }
};
