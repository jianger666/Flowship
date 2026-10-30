/**
 * 子代理「过程记录」：记 / 存 / 查（服务端）
 *
 * 前因见 `src/lib/subagent-run.ts` 头注释：子代理是工具调用里的嵌套子 agent，它自己的
 * thinking / 工具调用 / 回复不进主事件流。这里把它们记成一份和主事件流同形的 TaskEvent 列表，
 * 详情面板（事件流里的子代理卡 / 聊天框上方的「后台工作」条点开）按它渲染。
 *
 * # 三块职责
 * 1. **记录器**（{@link startSubagentRun}）：子 run 的每条 SDK 消息喂给 `onMessage`，
 *    翻成 thinking / assistant_message / tool_call / tool_result 事件（工具结果走和主流同一套抽文本 / 判状态，
 *    只是不落 `tool-outputs/` 全量文件，见 `buildInlineToolResultMeta`）。**记录器绝不能影响子代理本身**：
 *    调用方包 try/catch，这里也不抛、不 await、不阻塞。
 * 2. **存**：内存里一份（运行中实时更新，供轮询）+ 落盘 `tasks/<id>/subagent-runs/<key>.json`
 *    （运行中节流写、收尾立刻写；重开应用 / 翻历史还能看）。落盘前整份过凭据脱敏（与 events.jsonl 同口径）、
 *    文件 0600。任务目录不在了（任务被删）就不写，绝不把已删任务的目录又建出来——
 *    「检查目录还在 + 写」整段持任务锁（与 `deleteTask` 的持锁 rm 互斥，见 {@link writeIfTaskAlive}）。
 * 3. **查**（{@link getSubagentRunSnapshot}）：按 key（条用）或 callId（事件流卡片用）。先内存、再磁盘；
 *    磁盘里读出来还写着 running 的 = 进程已不是写它的那个（应用重启过）→ 改成 `interrupted`。
 *
 * # callId 怎么绑到记录上（事件流卡片按 callId 找）
 * 卡片手上只有主流里那条 `subagent` 工具调用的 `call_id`。记录来自子代理工具回调，回调的 `context.toolCallId`
 * 理论上就是它，但**没有真实 SDK 样本能证明两者逐字相等**（Cursor 原生 task 的 callId 带换行、格式特殊）。
 * 所以两路都留：
 *   - 精确：`toolCallId`（回调给的）和 `call_id`（主流消息里的）相等 → 直接绑；
 *   - 兜底：主流消息处理时 {@link noteSubagentToolCall} 带着那次调用的 **完整任务书** 来找「还没绑过 callId、
 *     任务书一致」的记录（最早的优先），反过来记录先到、消息后到也一样（待配对表）。
 *     两头起跑时间差超过 {@link CLAIM_WINDOW_MS}（60s）就不配——同一次调用的两头只差毫秒到数秒，
 *     差得远的是别的调用留下的陈旧项，宁可不绑也不误绑。
 * 任何一路绑上就行；都没绑上 → 卡片点开退回只展示它手上有的任务书 / 产出（界面有说明），不会空白。
 *
 * 依赖方向：只依赖 data-root / task-fs-core / tool-result-persist / event-secret-redact，
 * 不 import chat-runner / task-runner / cursor-subagent（被它们的装配层引用，避免环）。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  SUBAGENT_RUN_LIMITS,
  isSubagentRunTerminal,
  parseSubagentRunSnapshot,
  type SubagentRunMeta,
  type SubagentRunProvider,
  type SubagentRunSnapshot,
} from "@/lib/subagent-run";
import type { TaskEvent } from "@/lib/types";

import { writePrivateFileAtomic } from "./data-root";
import { redactCopyIfHit } from "./event-secret-redact";
import { DELETED_TOMBSTONE_FILE, taskDir, withTaskLock } from "./task-fs-core";
import {
  buildInlineToolResultMeta,
  sanitizeCallIdForPath,
} from "./tool-result-persist";

// ----------------- 对外类型 -----------------

/** 开始记录一次子代理调用 */
export interface SubagentRunInit {
  taskId: string;
  provider: SubagentRunProvider;
  description: string;
  /** 完整任务书 */
  prompt: string;
  model?: string;
  effort?: string;
  explore: boolean;
  resumed?: boolean;
  agentId?: string;
  /** 子代理工具回调拿到的 toolCallId（SDK 给的，可能没有） */
  toolCallId?: string;
  /** 一开始就是后台运行 */
  background?: boolean;
}

/** 一次调用的收尾结果 */
export type SubagentRunOutcome =
  | { status: "done"; result: string }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

/** 记录器句柄：调用方（子代理工具）只通过它写 */
export interface SubagentRunHandle {
  /** 记录 key（`sa_xxxxxxxxxx`） */
  readonly key: string;
  /** 喂子 run 流里的一条 SDK 消息（thinking / assistant / tool_call；其它忽略）。不抛。 */
  onMessage(msg: unknown): void;
  /** 转后台了（detached = 是前台转过去的）。不抛。 */
  setBackground(detached: boolean): void;
  /** 子 agent 的 id（建好后才知道）。不抛。 */
  setAgentId(agentId: string | undefined): void;
  /** 收尾；只认第一次。不抛。 */
  finish(outcome: SubagentRunOutcome): void;
}

// ----------------- 内部状态 -----------------

/** 运行中的落盘节流：一次变化后最多隔这么久写一次 */
const PERSIST_THROTTLE_MS = 2000;
/**
 * 内存里最多留多少个任务 / 每个任务最多多少份记录 / 已收尾记录合计多少字符
 * （超出淘汰最旧的已收尾记录——磁盘上还有、查询会回落到磁盘；运行中的永不淘汰）。
 *
 * 字符数上限是兜底：单条记录最坏能到「600 条 × 每条 8KB 工具输出 + 32K 回复」几 MB，
 * 光靠「32 任务 × 60 份」的条数限制挡不住这种体量的记录堆在内存里。
 */
const MEMORY_TASKS_MAX = 32;
const MEMORY_RUNS_PER_TASK_MAX = SUBAGENT_RUN_LIMITS.maxRunsPerTask;
const MEMORY_CHARS_MAX = 32 * 1024 * 1024;
let memoryTasksMax = MEMORY_TASKS_MAX;
let memoryCharsMax = MEMORY_CHARS_MAX;
/** 待配对表：最多这么多条、超过这个时间没配上的丢掉 */
const PENDING_MAX = 32;
const PENDING_TTL_MS = 10 * 60 * 1000;
/**
 * 兜底按任务书配对时，「主流里的调用」和「子代理记录」的时间差不能超过这个。
 * 同一次调用的这两头（主流消息 / 工具回调起 run）实际只差毫秒到数秒；差得远的多半是
 * 别的调用留下的陈旧登记（比如上一次建子 agent 失败后没人认领的待配对项），任务书碰巧一样也不能认——
 * 误绑会让卡片点开看到另一次调用的过程，比「没绑上、退回只展示手上有的」更糟。
 */
const CLAIM_WINDOW_MS = 60 * 1000;
/** 因条数上限被丢掉的工具调用 callId 最多记多少个（去重计数用；超出就不再去重） */
const DROPPED_CALLS_MAX = 1000;
/** 一条记录最多绑多少个 callId（防脏数据） */
const CALL_IDS_MAX = 8;

const RUNS_DIR = "subagent-runs";
const RUN_FILE_RE = /^sa_[a-z0-9]+\.json$/;
const MARKER_PREFIX = "by-call-";

interface ToolSlot {
  /** tool_call 事件（args 流式补全时原地更新） */
  callEvent: TaskEvent;
  /** tool_result 已记（同 callId 只记一次） */
  resultDone: boolean;
}

interface RunRecord {
  taskId: string;
  meta: SubagentRunMeta;
  events: TaskEvent[];
  rev: number;
  droppedEvents: number;
  /** 已记的条目数（不含 tool_result；上限见 SUBAGENT_RUN_LIMITS.maxEvents） */
  itemCount: number;
  /** 事件 id 计数 */
  seq: number;
  /**
   * 正在累积的 thinking / 回复事件（遇到别的消息就封口）。
   * `ev === null` = 这一段因为条数上限被丢了：同一段的后续 chunk 直接忽略、别一块算一笔 dropped。
   */
  open: { kind: "thinking" | "assistant"; ev: TaskEvent | null } | null;
  tools: Map<string, ToolSlot>;
  /**
   * 因条数上限被丢掉的工具调用 callId：同一个 callId 的后续 running / completed 消息别再各算一笔 dropped
   * （一个调用 = 一笔，与文本「同一段只算一笔」同口径）。没有 call_id 的调用不进来（无法判定是不是同一个）。
   */
  droppedCalls: Set<string>;
  /** 收尾时估一次的内存占用（字符数；只对已收尾记录有意义——内容不再变，淘汰按它算总量） */
  sizeChars: number;
  /** 回调给的 toolCallId */
  toolCallId?: string;
  /** 主流消息处理时绑上的 callId */
  handlerCallIds: Set<string>;
  persistTimer: NodeJS.Timeout | null;
  /** 落盘串行化（节流写与收尾写不并发） */
  writing: Promise<void>;
}

interface PendingCall {
  callId: string;
  prompt: string;
  at: number;
}

interface Registry {
  /** taskId → key → 记录（Map 插入序 = 创建序，淘汰最旧用） */
  runs: Map<string, Map<string, RunRecord>>;
  /** taskId → 主流里出现过、还没配上记录的 subagent 调用 */
  pending: Map<string, PendingCall[]>;
}

type RegistryHolder = typeof globalThis & {
  __flowshipSubagentRunRegistry?: Registry;
};

/** 挂 globalThis：Next 多个路由 chunk 各 import 一份本模块时共用同一张表（与 cursor-subagent 的登记表同理） */
const registry = (): Registry => {
  const g = globalThis as RegistryHolder;
  g.__flowshipSubagentRunRegistry ??= { runs: new Map(), pending: new Map() };
  return g.__flowshipSubagentRunRegistry;
};

/** 仅测试：清空内存状态（不动磁盘）并停掉所有落盘定时器 */
export const __resetSubagentRunsForTests = (): void => {
  const g = globalThis as RegistryHolder;
  for (const byKey of g.__flowshipSubagentRunRegistry?.runs.values() ?? []) {
    for (const rec of byKey.values()) {
      if (rec.persistTimer) clearTimeout(rec.persistTimer);
    }
  }
  g.__flowshipSubagentRunRegistry = undefined;
  memoryTasksMax = MEMORY_TASKS_MAX;
  memoryCharsMax = MEMORY_CHARS_MAX;
};

/** 仅测试：等所有记录的落盘队列排空 */
export const __flushSubagentRunWritesForTests = async (): Promise<void> => {
  const all: Promise<void>[] = [];
  for (const byKey of registry().runs.values()) {
    for (const rec of byKey.values()) all.push(rec.writing);
  }
  await Promise.all(all);
};

// ----------------- 小工具 -----------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const warn = (what: string, err: unknown): void => {
  console.warn(
    `[subagent-transcript] ${what}：`,
    err instanceof Error ? err.message : err,
  );
};

const OMITTED_SUFFIX = "…(后面的内容已省略)";

/** 往已有文本后追加，累计不超过 max；超出只留一次省略标记，之后的追加一律忽略 */
const appendCapped = (
  current: string,
  chunk: string,
  max: number,
): { text: string; capped: boolean } => {
  if (current.length >= max) return { text: current, capped: true };
  const room = max - current.length;
  if (chunk.length <= room) return { text: current + chunk, capped: false };
  return { text: current + chunk.slice(0, room) + OMITTED_SUFFIX, capped: true };
};

const stringifyArgs = (args: unknown): string => {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return String(args);
  }
};

const truncateChars = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(truncated ${s.length - max} chars)`;

const newRunKey = (): string => `sa_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

const isSafeKey = (key: string): boolean => /^sa_[a-z0-9]+$/.test(key);

const runsDir = (taskId: string): string => path.join(taskDir(taskId), RUNS_DIR);
const runFilePath = (taskId: string, key: string): string =>
  path.join(runsDir(taskId), `${key}.json`);
const markerPath = (taskId: string, callId: string): string =>
  path.join(
    runsDir(taskId),
    `${MARKER_PREFIX}${sanitizeCallIdForPath(callId)}.json`,
  );

/** 任务目录还在、且没被打逻辑删除标记（任务被删之后绝不把目录又建出来） */
const taskDirUsable = async (taskId: string): Promise<boolean> => {
  try {
    const dir = taskDir(taskId);
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return false;
    try {
      await fs.stat(path.join(dir, DELETED_TOMBSTONE_FILE));
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
};

// ----------------- 快照 / 落盘 -----------------

const snapshotOf = (rec: RunRecord): SubagentRunSnapshot => ({
  meta: { ...rec.meta, callIds: [...rec.meta.callIds] },
  events: rec.events.map((e) => ({ ...e })),
  rev: rec.rev,
  droppedEvents: rec.droppedEvents,
});

/**
 * 「任务还活着才写」：检查 + 写盘整段持任务锁。
 *
 * `writePrivateFileAtomic` 会递归建父目录；只在写之前检查一次的话，检查通过后、真正写之前任务被删
 *（`deleteTask` 在同一把锁里 `fs.rm` 整个任务目录），这次写就会把 `tasks/<id>/subagent-runs/`
 * 又建出来——留下一个没有 meta 的孤儿目录。删除与 `writeMeta` 的同类竞态早先就是这样堵的
 *（见 `deleteTask` 注释），这里同口径：删除持锁 rm 时我们排在后面，轮到我们时目录已不在 → 直接跳过。
 *
 * 只锁「检查 + 写」这一小段（序列化在锁外做完），不会长时间挡住别的任务状态写。
 * 返回 false = 任务已不可用、没写。
 */
const writeIfTaskAlive = (
  taskId: string,
  finalPath: string,
  content: string,
): Promise<boolean> =>
  withTaskLock(taskId, async () => {
    if (!(await taskDirUsable(taskId))) return false;
    await writePrivateFileAtomic(finalPath, content);
    return true;
  });

const writeRunFile = async (rec: RunRecord): Promise<void> => {
  // 先快速判一次：任务已经没了就别白做序列化 / 脱敏（真正的防线在 writeIfTaskAlive 的锁内复查）
  if (!(await taskDirUsable(rec.taskId))) return;
  // 脱敏后再序列化：与 events.jsonl 同口径（命中凭据才深拷贝，没命中零拷贝）
  const data = JSON.stringify(redactCopyIfHit(snapshotOf(rec)));
  await writeIfTaskAlive(rec.taskId, runFilePath(rec.taskId, rec.meta.key), data);
};

const persistNow = (rec: RunRecord): Promise<void> => {
  if (rec.persistTimer) {
    clearTimeout(rec.persistTimer);
    rec.persistTimer = null;
  }
  rec.writing = rec.writing
    .then(() => writeRunFile(rec))
    .catch((err) => warn(`落盘失败 task=${rec.taskId} key=${rec.meta.key}`, err));
  return rec.writing;
};

const schedulePersist = (rec: RunRecord): void => {
  if (rec.persistTimer) return;
  rec.persistTimer = setTimeout(() => {
    rec.persistTimer = null;
    void persistNow(rec);
  }, PERSIST_THROTTLE_MS);
  rec.persistTimer.unref?.();
};

/** 绑定 callId 的磁盘标记（按 callId 找记录用）：tiny 文件 `{ key }`，best-effort */
const writeMarker = async (rec: RunRecord, callId: string): Promise<void> => {
  try {
    await writeIfTaskAlive(
      rec.taskId,
      markerPath(rec.taskId, callId),
      JSON.stringify({ key: rec.meta.key }),
    );
  } catch (err) {
    warn(`写 callId 标记失败 task=${rec.taskId}`, err);
  }
};

/**
 * 清理一个任务名下超限的旧记录（best-effort）：只留最近 maxRunsPerTask 份，
 * 内存里还在跑的不删；顺手删掉指向已不存在记录的 callId 标记。
 */
const pruneRunsDir = async (taskId: string): Promise<void> => {
  try {
    const dir = runsDir(taskId);
    const names = await fs.readdir(dir);
    const runFiles = names.filter((n) => RUN_FILE_RE.test(n));
    if (runFiles.length <= SUBAGENT_RUN_LIMITS.maxRunsPerTask) return;
    const live = registry().runs.get(taskId);
    const stats = await Promise.all(
      runFiles.map(async (name) => {
        const st = await fs.stat(path.join(dir, name)).catch(() => null);
        return { name, mtime: st?.mtimeMs ?? 0 };
      }),
    );
    stats.sort((a, b) => a.mtime - b.mtime);
    const excess = stats.length - SUBAGENT_RUN_LIMITS.maxRunsPerTask;
    const kept = new Set(stats.map((s) => s.name));
    let removed = 0;
    for (const { name } of stats) {
      if (removed >= excess) break;
      const key = name.replace(/\.json$/, "");
      const mem = live?.get(key);
      if (mem && !isSubagentRunTerminal(mem.meta.status)) continue;
      await fs.rm(path.join(dir, name), { force: true });
      kept.delete(name);
      removed += 1;
    }
    if (removed === 0) return;
    for (const name of names) {
      if (!name.startsWith(MARKER_PREFIX)) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")) as {
          key?: unknown;
        };
        if (typeof raw.key === "string" && kept.has(`${raw.key}.json`)) continue;
      } catch {
        /* 读不出来 = 标记坏了，一并清掉 */
      }
      await fs.rm(path.join(dir, name), { force: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warn(`清理旧记录失败 task=${taskId}`, err);
    }
  }
};

// ----------------- 记录器 -----------------

const bump = (rec: RunRecord): void => {
  rec.rev += 1;
  schedulePersist(rec);
};

const pushEvent = (
  rec: RunRecord,
  ev: Pick<TaskEvent, "kind" | "text" | "meta">,
): TaskEvent => {
  rec.seq += 1;
  const full: TaskEvent = {
    id: `sr_${rec.seq}`,
    ts: Date.now(),
    kind: ev.kind,
    text: ev.text,
    ...(ev.meta ? { meta: ev.meta } : {}),
  };
  rec.events.push(full);
  return full;
};

/** 还能再记一个新条目吗；不能就计一笔 dropped（界面据此提示「后面的过程没有记录」） */
const reserveItem = (rec: RunRecord): boolean => {
  if (rec.itemCount >= SUBAGENT_RUN_LIMITS.maxEvents) {
    rec.droppedEvents += 1;
    return false;
  }
  rec.itemCount += 1;
  return true;
};

const textOfAssistant = (msg: Record<string, unknown>): string => {
  const message = msg.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  let out = "";
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      out += block.text;
    }
  }
  return out;
};

const onText = (
  rec: RunRecord,
  kind: "thinking" | "assistant",
  chunk: string,
  durationMs?: number,
): void => {
  if (!chunk) return;
  const max =
    kind === "thinking"
      ? SUBAGENT_RUN_LIMITS.thinkingTextMax
      : SUBAGENT_RUN_LIMITS.assistantTextMax;
  if (rec.open && rec.open.kind === kind) {
    // 同一段的后续 chunk（ev 为 null = 这段被条数上限丢了，忽略）
    if (!rec.open.ev) return;
    rec.open.ev.text = appendCapped(rec.open.ev.text, chunk, max).text;
  } else {
    // 换了一种消息：上一段封口
    if (!reserveItem(rec)) {
      rec.open = { kind, ev: null };
      return;
    }
    const ev = pushEvent(rec, {
      kind: kind === "thinking" ? "thinking" : "assistant_message",
      text: appendCapped("", chunk, max).text,
    });
    rec.open = { kind, ev };
  }
  if (kind === "thinking" && durationMs && rec.open?.ev) {
    const meta = (rec.open.ev.meta ??= {});
    const prev = typeof meta.durationMs === "number" ? meta.durationMs : 0;
    meta.durationMs = prev + durationMs;
  }
  bump(rec);
};

const onToolCall = (rec: RunRecord, msg: Record<string, unknown>): void => {
  rec.open = null;
  const status = typeof msg.status === "string" ? msg.status : "running";
  const name = typeof msg.name === "string" && msg.name ? msg.name : "tool";
  const realCallId =
    typeof msg.call_id === "string" && msg.call_id ? msg.call_id : undefined;
  // 已经因条数上限被丢过的调用：它后续的 running / completed 消息直接忽略、不再各算一笔 dropped
  if (realCallId && rec.droppedCalls.has(realCallId)) return;
  const callId = realCallId ?? `auto_${rec.seq + 1}`;
  const argsStr = truncateChars(
    stringifyArgs(msg.args),
    SUBAGENT_RUN_LIMITS.toolArgsMax,
  );

  let slot = rec.tools.get(callId);
  if (!slot) {
    if (!reserveItem(rec)) {
      if (realCallId && rec.droppedCalls.size < DROPPED_CALLS_MAX) {
        rec.droppedCalls.add(realCallId);
      }
      return;
    }
    const callEvent = pushEvent(rec, {
      kind: "tool_call",
      text: `调用 ${name}${argsStr ? `:${argsStr.slice(0, 120)}` : ""}`,
      meta: { callId, name, ...(argsStr ? { args: argsStr } : {}) },
    });
    slot = { callEvent, resultDone: false };
    rec.tools.set(callId, slot);
  } else if (argsStr) {
    // SDK 对长 args 工具会流式补全：同 callId 的后续 running 只升级成更长的 args
    const prev =
      typeof slot.callEvent.meta?.args === "string" ? slot.callEvent.meta.args : "";
    if (argsStr.length > prev.length) {
      slot.callEvent.meta = { ...slot.callEvent.meta, args: argsStr };
      slot.callEvent.text = `调用 ${name}:${argsStr.slice(0, 120)}`;
    }
  }

  if (status === "running" || slot.resultDone) {
    bump(rec);
    return;
  }
  // completed / error：补 tool_result（和主流同一套抽文本 / 判状态）
  slot.resultDone = true;
  const resultMeta = buildInlineToolResultMeta({
    callId,
    rawName: name,
    args: msg.args,
    result: msg.result,
    msgStatus: status,
  });
  pushEvent(rec, {
    kind: "tool_result",
    text:
      resultMeta.status === "error"
        ? `工具失败 ${resultMeta.name}`
        : `工具完成 ${resultMeta.name}`,
    meta: { ...resultMeta },
  });
  bump(rec);
};

const handleMessage = (rec: RunRecord, msg: unknown): void => {
  if (!isRecord(msg) || isSubagentRunTerminal(rec.meta.status)) return;
  switch (msg.type) {
    case "thinking": {
      const text = typeof msg.text === "string" ? msg.text : "";
      const dur =
        typeof msg.thinking_duration_ms === "number" &&
        Number.isFinite(msg.thinking_duration_ms)
          ? msg.thinking_duration_ms
          : undefined;
      onText(rec, "thinking", text, dur);
      return;
    }
    case "assistant":
      onText(rec, "assistant", textOfAssistant(msg));
      return;
    case "tool_call":
      onToolCall(rec, msg);
      return;
    case "auto_retry_start":
      // pi 内层自动重试，那条回复要整个重新生成一遍：只封口，让重新生成的文本另起一条——半截保留着（用户看过），
      // 但不和全文焊成一段。不落说明条目：过程记录只认 thinking / assistant_message / tool_call / tool_result
      // 四类（subagent-run.ts 的 RUN_EVENT_KINDS），别的读出来一律丢（R14 Q11-02）
      rec.open = null;
      return;
    default:
      return;
  }
};

const bindCallId = (rec: RunRecord, callId: string): void => {
  if (!callId || rec.meta.callIds.includes(callId)) return;
  if (rec.meta.callIds.length >= CALL_IDS_MAX) return;
  rec.meta.callIds.push(callId);
  bump(rec);
  void writeMarker(rec, callId);
};

const matchesCall = (rec: RunRecord, callId: string): boolean =>
  rec.toolCallId === callId || rec.handlerCallIds.has(callId);

/** 估一份已收尾记录占的内存（字符数）：任务书 + 产出 + 各事件的文本 / meta 里的字符串（工具输出 / diff / args） */
const estimateChars = (rec: RunRecord): number => {
  let n =
    rec.meta.prompt.length +
    (rec.meta.result?.length ?? 0) +
    (rec.meta.error?.length ?? 0);
  for (const ev of rec.events) {
    n += ev.text.length;
    if (!ev.meta) continue;
    for (const v of Object.values(ev.meta)) {
      if (typeof v === "string") n += v.length;
    }
  }
  return n;
};

/** 淘汰出内存前把还没写的变化落一次盘（收尾后才绑上的 callId 之类），之后查询走磁盘 */
const flushBeforeEvict = (rec: RunRecord): void => {
  if (rec.persistTimer) void persistNow(rec);
};

const isBucketIdle = (bucket: Map<string, RunRecord>): boolean => {
  for (const r of bucket.values()) {
    if (!isSubagentRunTerminal(r.meta.status)) return false;
  }
  return true;
};

/**
 * 内存淘汰：三道上限，都只动「已收尾」的记录（磁盘上有、查询回落到磁盘），运行中的永不淘汰。
 *  1. 单个任务的记录数；
 *  2. 内存里的任务数——按 LRU 顺序**逐个看、跳过还有运行中记录的任务**继续往后找
 *     （早先遇到第一个有运行中记录的就整体放弃，后面全是已收尾任务时也一个都淘汰不了）；
 *  3. 已收尾记录的字符数合计——按创建先后（任务 LRU 序 + 记录创建序）淘汰最旧的。
 * 当前任务（taskId）不会被 2 / 3 淘汰。
 */
const evictOldRuns = (taskId: string, byKey: Map<string, RunRecord>): void => {
  while (byKey.size > MEMORY_RUNS_PER_TASK_MAX) {
    let victim: string | undefined;
    for (const [key, rec] of byKey) {
      if (isSubagentRunTerminal(rec.meta.status)) {
        victim = key;
        break;
      }
    }
    if (victim === undefined) break; // 全在跑：不淘汰
    flushBeforeEvict(byKey.get(victim)!);
    byKey.delete(victim);
  }

  const reg = registry();
  if (reg.runs.size > memoryTasksMax) {
    for (const [id, bucket] of [...reg.runs]) {
      if (reg.runs.size <= memoryTasksMax) break;
      if (id === taskId || !isBucketIdle(bucket)) continue;
      for (const rec of bucket.values()) flushBeforeEvict(rec);
      reg.runs.delete(id);
    }
  }

  let total = 0;
  for (const bucket of reg.runs.values()) {
    for (const rec of bucket.values()) {
      if (isSubagentRunTerminal(rec.meta.status)) total += rec.sizeChars;
    }
  }
  if (total <= memoryCharsMax) return;
  for (const [id, bucket] of [...reg.runs]) {
    if (id === taskId) continue;
    for (const [key, rec] of [...bucket]) {
      if (total <= memoryCharsMax) return;
      if (!isSubagentRunTerminal(rec.meta.status)) continue;
      total -= rec.sizeChars;
      flushBeforeEvict(rec);
      bucket.delete(key);
    }
    if (bucket.size === 0) reg.runs.delete(id);
  }
};

/** 仅测试：把内存淘汰的任务数 / 字符数上限改小（不传 = 恢复默认），免得为了触发它真造几十 MB 数据 */
export const __setMemoryLimitsForTests = (
  limits: { tasksMax?: number; charsMax?: number } = {},
): void => {
  memoryTasksMax = limits.tasksMax ?? MEMORY_TASKS_MAX;
  memoryCharsMax = limits.charsMax ?? MEMORY_CHARS_MAX;
};

/**
 * 开始记录一次子代理调用。返回的句柄**不会抛**（内部出错只告警、丢这条记录的后续更新）。
 * 调用方要在拿到子 run 之后再调（建子 agent 失败的用法错误不值得留一份记录）。
 */
export const startSubagentRun = (init: SubagentRunInit): SubagentRunHandle => {
  const key = newRunKey();
  const rec: RunRecord = {
    taskId: init.taskId,
    meta: {
      key,
      provider: init.provider,
      description: init.description.trim() || "子任务",
      prompt: init.prompt,
      ...(init.model ? { model: init.model } : {}),
      ...(init.effort ? { effort: init.effort } : {}),
      explore: init.explore,
      resumed: init.resumed === true,
      ...(init.agentId ? { agentId: init.agentId } : {}),
      background: init.background === true,
      detached: false,
      status: "running",
      startedAt: Date.now(),
      callIds: [],
    },
    events: [],
    rev: 1,
    droppedEvents: 0,
    itemCount: 0,
    seq: 0,
    open: null,
    tools: new Map(),
    droppedCalls: new Set(),
    sizeChars: 0,
    toolCallId: init.toolCallId?.trim() || undefined,
    handlerCallIds: new Set(),
    persistTimer: null,
    writing: Promise.resolve(),
  };

  const reg = registry();
  let byKey = reg.runs.get(init.taskId);
  if (!byKey) {
    byKey = new Map();
    reg.runs.set(init.taskId, byKey);
  } else {
    // LRU：最近用到的任务挪到队尾
    reg.runs.delete(init.taskId);
    reg.runs.set(init.taskId, byKey);
  }
  byKey.set(key, rec);
  evictOldRuns(init.taskId, byKey);

  // 精确绑：回调给的 toolCallId
  if (rec.toolCallId) bindCallId(rec, rec.toolCallId);
  // 兜底绑：主流消息先到（待配对表里已有同任务书的调用）
  claimPending(rec);
  schedulePersist(rec);

  const safe = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      warn(`${what} 出错（已忽略）`, err);
    }
  };

  return {
    key,
    onMessage: (msg) => safe("onMessage", () => handleMessage(rec, msg)),
    setBackground: (detached) =>
      safe("setBackground", () => {
        if (isSubagentRunTerminal(rec.meta.status)) return;
        rec.meta.background = true;
        rec.meta.detached = detached;
        bump(rec);
      }),
    setAgentId: (agentId) =>
      safe("setAgentId", () => {
        if (!agentId || rec.meta.agentId === agentId) return;
        rec.meta.agentId = agentId;
        bump(rec);
      }),
    finish: (outcome) =>
      safe("finish", () => {
        if (isSubagentRunTerminal(rec.meta.status)) return;
        rec.open = null;
        rec.meta.status = outcome.status;
        rec.meta.endedAt = Date.now();
        if (outcome.status === "done") {
          rec.meta.result = truncateChars(
            outcome.result,
            SUBAGENT_RUN_LIMITS.resultMax,
          );
        } else if (outcome.status === "failed") {
          rec.meta.error = truncateChars(
            outcome.error,
            SUBAGENT_RUN_LIMITS.resultMax,
          );
        }
        rec.rev += 1;
        rec.sizeChars = estimateChars(rec);
        void persistNow(rec).then(() => pruneRunsDir(rec.taskId));
      }),
  };
};

// ----------------- callId 绑定（兜底路径） -----------------

const pendingOf = (taskId: string): PendingCall[] => {
  const reg = registry();
  let list = reg.pending.get(taskId);
  if (!list) {
    list = [];
    reg.pending.set(taskId, list);
  }
  const cutoff = Date.now() - PENDING_TTL_MS;
  const fresh = list.filter((p) => p.at >= cutoff);
  if (fresh.length !== list.length) {
    list = fresh;
    reg.pending.set(taskId, list);
  }
  return list;
};

/** 记录先到：看待配对表里有没有「任务书一致」的主流调用，有就绑（并从表里拿掉） */
const claimPending = (rec: RunRecord): void => {
  const list = pendingOf(rec.taskId);
  if (list.length === 0) return;
  // 精确：待配对的 callId 就是回调给的 toolCallId
  let idx = rec.toolCallId ? list.findIndex((p) => p.callId === rec.toolCallId) : -1;
  if (idx < 0) {
    // 兜底：任务书一致、且登记时间离本记录起跑不远的（陈旧登记不认，见 CLAIM_WINDOW_MS）；多个取最早的
    const prompt = rec.meta.prompt.trim();
    idx = prompt
      ? list.findIndex(
          (p) =>
            p.prompt === prompt && rec.meta.startedAt - p.at <= CLAIM_WINDOW_MS,
        )
      : -1;
  }
  if (idx < 0) return;
  const [hit] = list.splice(idx, 1);
  rec.handlerCallIds.add(hit!.callId);
  bindCallId(rec, hit!.callId);
};

/**
 * 主事件流里处理到一条 `subagent` 工具调用消息时调（任何状态都调、可重复调，幂等）：
 * 把这个 callId 绑到对应的记录上；记录还没建好就先登记在待配对表里，记录出现时再认领。
 *
 * `prompt` 要给**消息里的完整任务书**（落事件前的原始 args，不是被截到 2000 字的展示版）。
 * 任务书不一致 / 缺失就只能等精确匹配（toolCallId === callId）。
 */
export const noteSubagentToolCall = (
  taskId: string,
  call: { callId: string; prompt?: string },
): void => {
  try {
    const callId = call.callId;
    if (!taskId || !callId) return;
    const byKey = registry().runs.get(taskId);
    const runs = byKey ? [...byKey.values()] : [];
    // 1. 已绑过 / 回调给的 toolCallId 恰好就是它：补一次绑定（幂等）
    const exact = runs.find((r) => matchesCall(r, callId));
    if (exact) {
      exact.handlerCallIds.add(callId);
      bindCallId(exact, callId);
      return;
    }
    // 2. 任务书一致、起跑时间离这次调用不远（陈旧记录不认，见 CLAIM_WINDOW_MS）、
    //    且还没被主流消息绑过的最早一条
    const prompt = (call.prompt ?? "").trim();
    if (prompt) {
      const now = Date.now();
      const cand = runs
        .filter(
          (r) =>
            r.handlerCallIds.size === 0 &&
            r.meta.prompt.trim() === prompt &&
            now - r.meta.startedAt <= CLAIM_WINDOW_MS,
        )
        .sort((a, b) => a.meta.startedAt - b.meta.startedAt)[0];
      if (cand) {
        cand.handlerCallIds.add(callId);
        bindCallId(cand, callId);
        return;
      }
    }
    // 3. 记录还没建好：登记待配对（同 callId 只留一条，任务书取更长的——流式补全 args 时前几帧是残缺的）
    const list = pendingOf(taskId);
    const existing = list.find((p) => p.callId === callId);
    if (existing) {
      if (prompt.length > existing.prompt.length) existing.prompt = prompt;
      return;
    }
    list.push({ callId, prompt, at: Date.now() });
    while (list.length > PENDING_MAX) list.shift();
  } catch (err) {
    warn("noteSubagentToolCall 出错（已忽略）", err);
  }
};

// ----------------- 查 -----------------

export interface SubagentRunQuery {
  /** 记录 key（聊天框上方的条） */
  key?: string;
  /** 主流里 subagent 工具调用的 callId（事件流卡片） */
  callId?: string;
}

const findLive = (
  taskId: string,
  query: SubagentRunQuery,
): RunRecord | undefined => {
  const byKey = registry().runs.get(taskId);
  if (!byKey) return undefined;
  if (query.key) return byKey.get(query.key);
  if (query.callId) {
    for (const rec of byKey.values()) {
      if (matchesCall(rec, query.callId)) return rec;
    }
  }
  return undefined;
};

const readRunFromDisk = async (
  taskId: string,
  key: string,
): Promise<SubagentRunSnapshot | null> => {
  if (!isSafeKey(key)) return null;
  const file = runFilePath(taskId, key);
  try {
    const [text, st] = await Promise.all([
      fs.readFile(file, "utf-8"),
      fs.stat(file),
    ]);
    const snap = parseSubagentRunSnapshot(JSON.parse(text));
    if (!snap) return null;
    // 写这份记录的进程已经不在了（内存里没有它）：不能再显示成「运行中」
    if (snap.meta.status === "running") {
      return {
        ...snap,
        meta: {
          ...snap.meta,
          status: "interrupted",
          endedAt: snap.meta.endedAt ?? st.mtimeMs,
        },
      };
    }
    return snap;
  } catch {
    return null;
  }
};

const readKeyByCallId = async (
  taskId: string,
  callId: string,
): Promise<string | null> => {
  try {
    const raw = JSON.parse(
      await fs.readFile(markerPath(taskId, callId), "utf-8"),
    ) as { key?: unknown };
    return typeof raw.key === "string" && isSafeKey(raw.key) ? raw.key : null;
  } catch {
    return null;
  }
};

/**
 * 取一份过程记录快照（已脱敏）。找不到返回 null。
 * 先内存（运行中的实时值）、再磁盘；按 callId 找磁盘记录时要核对记录里确实绑着这个 callId
 *（标记文件名是消毒后的，理论上可能撞名，核对不上就当没有）。
 */
export const getSubagentRunSnapshot = async (
  taskId: string,
  query: SubagentRunQuery,
): Promise<SubagentRunSnapshot | null> => {
  if (!query.key && !query.callId) return null;
  const live = findLive(taskId, query);
  if (live) return redactCopyIfHit(snapshotOf(live));

  // 读盘前确认任务还活着：延迟删除分支里目录还在、只有逻辑删除标记，不能让它的记录继续被读到。
  // 只有「不在内存里」的记录才走到这里（运行中的每秒轮询都命中上面的内存），多两次 stat 无所谓
  if (!(await taskDirUsable(taskId))) return null;

  let key = query.key ?? null;
  if (!key && query.callId) key = await readKeyByCallId(taskId, query.callId);
  if (!key) return null;
  const snap = await readRunFromDisk(taskId, key);
  if (!snap) return null;
  if (query.callId && !query.key && !snap.meta.callIds.includes(query.callId)) {
    return null;
  }
  return redactCopyIfHit(snap);
};

/**
 * 任务被删时调：把这个任务在内存里的过程记录和待配对项一并丢掉（停掉它们的落盘定时器）。
 *
 * 不碰磁盘：任务目录由 `deleteTask` 删；还没停干净的记录再落盘时会在锁内复查任务目录、没了就跳过
 *（{@link writeIfTaskAlive}）。不清内存的话，已删任务的任务书 / 过程在被 LRU 挤出之前仍能被 GET 读到。
 * 不抛。
 */
export const forgetSubagentRunsForDeletedTask = (taskId: string): void => {
  try {
    const reg = registry();
    for (const rec of reg.runs.get(taskId)?.values() ?? []) {
      if (rec.persistTimer) {
        clearTimeout(rec.persistTimer);
        rec.persistTimer = null;
      }
    }
    reg.runs.delete(taskId);
    reg.pending.delete(taskId);
  } catch (err) {
    warn(`清理已删任务的内存记录失败 task=${taskId}`, err);
  }
};

/** 仅测试：内存里某任务当前有哪些记录 key */
export const __runKeysForTests = (taskId: string): string[] => [
  ...(registry().runs.get(taskId)?.keys() ?? []),
];
