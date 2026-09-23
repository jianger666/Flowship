/**
 * 意图日志持久化 WAL（v3.1 §5：磁盘 WAL，不是进程内 dedup 表）。
 *
 * - 落盘位置：`<dataRoot>/intent-log/<taskId>.jsonl`，一行一条；
 * - 流程：appendIntent 落 intent → 执行外部操作 → markDone 落 done；
 *   查不到/对不上 → markAbandoned 人工兜底；
 * - 幂等键 `(taskId, actionId, toolCallId)`（mem-governance.buildSideEffectIdempotencyKey）；
 * - feishu-message / notify 无查询 API → at-most-once（宁漏勿重）+ 正文尾 `[ref:intentId]`
 *   标记供人工比对（封版纪要修订二1，产品决策）；
 * - 恢复时 sweepPending 按持久键反查外部系统（§5.1 查法表由调用方实现，本模块只给状态机）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot, ensurePrivateDir } from "./data-root";
import {
  buildIntentRefMarker,
  buildSideEffectIdempotencyKey,
  isAtMostOnceKind,
  type SideEffectIntent,
} from "./mem-governance";

export type IntentStatus = SideEffectIntent["status"];
export type IntentKind = SideEffectIntent["kind"];

export interface IntentRecord extends SideEffectIntent {
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
}

const logDir = (): string => path.join(dataRoot(), "intent-log");
const logFile = (taskId: string): string =>
  path.join(logDir(), `${taskId}.jsonl`);

export const intentIdempotencyKey = (
  taskId: string,
  actionId: string,
  toolCallId: string,
): string => buildSideEffectIdempotencyKey({ taskId, actionId, toolCallId });

/** 外发正文尾追加幂等标记（feishu/notify 人工比对用）。 */
export const withIntentRef = (body: string, taskId: string, actionId: string, toolCallId: string): string => {
  const marker = buildIntentRefMarker(intentIdempotencyKey(taskId, actionId, toolCallId));
  return body.includes(marker) ? body : `${body}\n${marker}`;
};

export const appendIntent = async (args: {
  taskId: string;
  actionId: string;
  toolCallId: string;
  kind: IntentKind;
  payloadHash: string;
}): Promise<IntentRecord> => {
  await ensurePrivateDir(logDir());
  const now = Date.now();
  const rec: IntentRecord = {
    taskId: args.taskId,
    actionId: args.actionId,
    toolCallId: args.toolCallId,
    kind: args.kind,
    payloadHash: args.payloadHash,
    status: "intent",
    idempotencyKey: intentIdempotencyKey(args.taskId, args.actionId, args.toolCallId),
    createdAt: now,
    updatedAt: now,
  };
  await fs.appendFile(logFile(args.taskId), `${JSON.stringify(rec)}\n`, "utf-8");
  return rec;
};

/** A2 修复：同 task 的 rewrite 进程内串行化（promise 队列），防两次 mark 并发互相覆盖。 */
const rewriteQueues = new Map<string, Promise<void>>();

const rewriteStatusInner = async (
  taskId: string,
  idempotencyKey: string,
  status: IntentStatus,
): Promise<void> => {
  const file = logFile(taskId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const now = Date.now();
  const out = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        const o = JSON.parse(l) as IntentRecord;
        if (o.idempotencyKey === idempotencyKey) {
          return JSON.stringify({ ...o, status, updatedAt: now });
        }
        return l;
      } catch {
        return l;
      }
    })
    .join("\n");
  // A2 修复：tmp 写完 rename 原子提交，直接覆盖 WAL 会在崩溃时截断整个意图日志。
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, out ? `${out}\n` : "", "utf-8");
  await fs.rename(tmp, file);
};

const rewriteStatus = (taskId: string, idempotencyKey: string, status: IntentStatus): Promise<void> => {
  const prev = rewriteQueues.get(taskId) ?? Promise.resolve();
  const next = prev.then(() => rewriteStatusInner(taskId, idempotencyKey, status));
  // 队列本身永不带错（错误只传给调用方），防一条失败卡死后继。
  rewriteQueues.set(taskId, next.catch(() => {}));
  return next;
};

export const markIntentDone = (taskId: string, idempotencyKey: string): Promise<void> =>
  rewriteStatus(taskId, idempotencyKey, "done");

export const markIntentAbandoned = (taskId: string, idempotencyKey: string): Promise<void> =>
  rewriteStatus(taskId, idempotencyKey, "abandoned");

export const loadIntents = async (taskId: string): Promise<IntentRecord[]> => {
  try {
    const raw = await fs.readFile(logFile(taskId), "utf-8");
    const out: IntentRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as IntentRecord);
      } catch {
        /* 脏行跳过（启动日志由调用方告警） */
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
};

/** 有 intent 无 done 的条目（恢复时逐条按 §5.1 查法表反查）。 */
export const pendingIntents = async (taskId: string): Promise<IntentRecord[]> => {
  const all = await loadIntents(taskId);
  const latest = new Map<string, IntentRecord>();
  for (const r of all) latest.set(r.idempotencyKey, r);
  return [...latest.values()].filter((r) => r.status === "intent");
};

/**
 * 恢复策略（纯判定）：at-most-once 的 kind 且无法确认对方没收到 → 不重试，标 abandoned。
 * 调用方按 §5.1 表实现反查后，把 verifiedAbsent 传进来。
 */
export const decideIntentRecovery = (args: {
  kind: IntentKind;
  verifiedAbsent: boolean;
}): "retry" | "abandoned" => {
  if (!args.verifiedAbsent && isAtMostOnceKind(args.kind)) return "abandoned";
  if (!args.verifiedAbsent) return "abandoned";
  if (isAtMostOnceKind(args.kind)) return "abandoned";
  return "retry";
};

// ---------- B4：shim intent 纳入恢复扫描（两头对账，不许漏扫） ----------

/** worker stateRoot 下 shim 落 intent 的文件名（spawn 时 FLOWSHIP_INTENT_FILE 指到它）。 */
export const SHIM_INTENT_FILENAME = "shim-intent.jsonl" as const;

export const shimIntentFile = (stateRoot: string): string =>
  path.join(stateRoot, SHIM_INTENT_FILENAME);

export interface ShimIntentRow {
  taskId: string;
  actionId: string;
  toolCallId: string;
  kind?: string;
  via?: string;
  bin?: string;
  argv?: string[];
}

/** 读 shim intent 行并归一成 IntentRecord（幂等键按 task/action/toolCall 重算）。 */
export const loadShimIntents = async (stateRoot: string): Promise<IntentRecord[]> => {
  let raw: string;
  try {
    raw = await fs.readFile(shimIntentFile(stateRoot), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: IntentRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as ShimIntentRow;
      if (!o.taskId || !o.actionId || !o.toolCallId) continue;
      const now = Date.now();
      out.push({
        taskId: o.taskId,
        actionId: o.actionId,
        toolCallId: o.toolCallId,
        kind: "external-api",
        payloadHash: JSON.stringify({ bin: o.bin ?? "", argv: o.argv ?? [] }),
        status: "intent",
        idempotencyKey: intentIdempotencyKey(o.taskId, o.actionId, o.toolCallId),
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      /* 脏行跳过 */
    }
  }
  return out;
};

/**
 * 合并扫描：WAL + shim 两头对账。同一幂等键以 WAL 侧状态为准
 * （shim 行只有 intent 语义；WAL 侧 done/abandoned 覆盖它）。
 */
export const pendingIntentsWithShim = async (
  taskId: string,
  stateRoot: string,
): Promise<IntentRecord[]> => {
  const [wal, shim] = await Promise.all([pendingIntents(taskId), loadShimIntents(stateRoot)]);
  const walKeys = new Set((await loadIntents(taskId)).map((r) => r.idempotencyKey));
  const out = [...wal];
  for (const s of shim) {
    if (s.taskId !== taskId) continue;
    // WAL 里出现过（任何状态）即以 WAL 为准，不重复计入。
    if (walKeys.has(s.idempotencyKey)) continue;
    out.push(s);
  }
  return out;
};
