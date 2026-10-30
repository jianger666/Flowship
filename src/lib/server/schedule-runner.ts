/**
 * 定时任务调度核心（纯编排，无重依赖）：到点判定 → 认领 → 投递 → 结算。
 *
 * 为什么依赖全部注入：真实投递要走 chat-inject / task-question-inject（拖着 @cursor/sdk 一串模块），
 * 单测里用假时钟 + 假投递就能把「错过不补 / 忙则重试 / 窗口耗尽 / 手动触发」这些语义钉死。
 * 真实接线在 `schedule-service.ts`。
 *
 * # 并发与幂等
 * - 同一条定时同一时刻只允许一个「步进」在跑（`inflight` 集合）。集合放 globalThis：Next dev 下
 *   不同 route 是不同 webpack chunk，模块级变量会各持一份——手动触发与后台 tick 若各看各的集合就会双发。
 * - 认领（claim）在任务锁内复查「确实到点且还是 active」后才改状态，tick 与 UI 操作交叉也只会有一方赢。
 * - 幂等键 `<id>.<seq>.<attempt>`：上一次若是**明确**「没送达」（忙 / 暂时不可用），
 *   同键重试会被下游当成「已结算的失败」直接回放、不会真的再送——所以换新键（attempt+1）；
 *   但上一次若是**结果不明**（deliver 抛了、下游可能已受理；或已送达但结算写盘失败），必须**沿用同一个键**，
 *   让下游把它认成「已送达」的回放，否则换新键就是重复投递。重启后 attempt 归零 = 回到第 1 次的键，同理。
 * - 同一个会话的投递串行（`deliveryLocks`）：同一时刻到点的多条定时一条一条送，
 *   第二条看到的是第一条已经把会话推进到「在跑」之后的状态，而不是并行过同一道「空闲」判断。
 */
import {
  buildScheduleFireMeta,
  buildScheduleInfoMeta,
  classifyDue,
  claimFire,
  formatScheduleFireMessage,
  formatScheduleTime,
  markDelivered,
  markDeliveryFailed,
  markMissed,
  SCHEDULE_AUTO_PAUSE_FAILURES,
  SCHEDULE_DELIVERY_WINDOW_MS,
  type ScheduleRecord,
  type SchedulePending,
} from "@/lib/schedule";

import {
  mutateSchedules,
  readSchedules,
  scheduleLiveTaskIds,
  syncScheduleIndex,
} from "./schedule-store";

export interface DeliverRequest {
  taskId: string;
  record: ScheduleRecord;
  pending: SchedulePending;
  /** 送进会话的正文（同时是 user_reply 的 text） */
  text: string;
  /** user_reply.meta（source=schedule 等，UI 据此渲染） */
  meta: Record<string, unknown>;
  /** 本次尝试的幂等键 */
  clientItemId: string;
}

/**
 * - delivered：已被会话接收（含「排进会话队列、稍后由队列送出」——那条路径下游保证送出）
 * - retry：这会儿送不进去（忙 / 正在停止 / 有未答提问…），投递窗口内继续试
 * - failed：这一次送不进去且不再试（会话没了 / 缺凭据…）。
 *   `permanent`：再等多久也送不进去（会话已不存在 / 已归档 / 任务已终结）——周期定时遇到直接取消；
 *   不带 permanent 的失败（缺凭据 / 参数问题…）可能被用户修好，周期定时连续失败几次后自动暂停。
 */
export type DeliverOutcome =
  | { kind: "delivered" }
  | { kind: "retry"; reason: string }
  | { kind: "failed"; reason: string; permanent?: boolean };

export interface ScheduleRunnerDeps {
  now: () => number;
  liveTaskIds: () => string[];
  read: (taskId: string) => Promise<ScheduleRecord[]>;
  mutate: typeof mutateSchedules;
  /** 读完一个任务的列表后校正「有没有需要盯的定时」索引（可选；默认依赖里接的是 store 的索引） */
  syncIndex?: (taskId: string, list: readonly ScheduleRecord[]) => void;
  deliver: (req: DeliverRequest) => Promise<DeliverOutcome>;
  /** 往会话事件流写一条 info（错过 / 失败提示）。失败不得影响调度 */
  notify: (taskId: string, text: string, meta: Record<string, unknown>) => Promise<void>;
  /** 一次 `deliver` 最多等多久（毫秒）；缺省 {@link SCHEDULE_DELIVER_TIMEOUT_MS}。主要给单测缩短用 */
  deliverTimeoutMs?: number;
}

export const MISSED_NOTE = "应用当时没开或电脑睡眠，没有补发";

/**
 * R14 Q20-02：一次 `deps.deliver` 最多等多久。
 * 下游（chat-inject / task-question-inject）任何一处 await 永不返回（磁盘 / SDK resume / 锁等待）时，
 * 没有超时就会让该任务的 `tickingTasks` 永不释放——这个会话之后的全部定时都不再触发（连「错过」都不会记），直到重启。
 * 超时按「结果不明」处理（同 deliver 抛错）：沿用同一个幂等键重试，下游认回放；投递窗口（10 分钟）里还有多次重试机会。
 * 取 60 秒：远长于下游正常路径，又不会让同会话的其它定时被一次挂死拖太久。
 */
export const SCHEDULE_DELIVER_TIMEOUT_MS = 60_000;

/** `deliver` 超时（见 {@link SCHEDULE_DELIVER_TIMEOUT_MS}）；单独成类只为让 catch 里能认出它、给更明确的原因 */
class DeliverTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`投递超过 ${Math.round(timeoutMs / 1000)} 秒没返回（结果不明，稍后用同一个编号重试）`);
    this.name = "DeliverTimeoutError";
  }
}

const warn = (msg: string, err?: unknown): void => {
  console.warn(`[schedule] ${msg}`, err instanceof Error ? err.message : (err ?? ""));
};

/**
 * 成功路径的一行日志（认领 / 送达 / 错过 / 失败）。排查「为什么没触发」不该只能翻 schedules.json。
 * `late` = 实际处理时刻 − 计划时刻：睡眠唤醒 / macOS App Nap 后台节流让 tick 晚到时，一眼能看出晚了多久（是否被误判成错过）。
 */
const log = (msg: string): void => {
  console.log(`[schedule] ${msg}`);
};
const lateSec = (now: number, dueAt: number | null | undefined): string =>
  dueAt === null || dueAt === undefined ? "?" : `${Math.round((now - dueAt) / 1000)}s`;

// ----------------- 全局状态（globalThis） -----------------

const STATE_KEY = "__flowshipScheduleRunnerStateV1__";
/** 一次投递尝试的记账：n = 第几次；unknown = 上一次结果不明（下一次必须沿用同一个幂等键） */
interface AttemptRecord {
  n: number;
  unknown: boolean;
}
interface RunnerState {
  inflight: Set<string>;
  attempts: Map<string, AttemptRecord>;
  /** 正在被 tick 处理的任务：上一轮还没处理完（慢投递）就不再重入，别的任务不受影响 */
  tickingTasks: Set<string>;
  /** 每个任务的投递串行链 */
  deliveryLocks: Map<string, Promise<void>>;
  /** 读取失败告警的节流（任务 id → 上次告警时刻） */
  readWarnAt: Map<string, number>;
}
const state = (): RunnerState => {
  const g = globalThis as unknown as Record<string, Partial<RunnerState> | undefined>;
  const s = (g[STATE_KEY] ??= {});
  // dev 热重载下 globalThis 上可能留着旧形状的状态：缺的字段补齐
  s.inflight ??= new Set();
  s.attempts ??= new Map();
  s.tickingTasks ??= new Set();
  s.deliveryLocks ??= new Map();
  s.readWarnAt ??= new Map();
  return s as RunnerState;
};

/** 测试用：清空运行态 */
export const __resetScheduleRunnerStateForTest = (): void => {
  const s = state();
  s.inflight.clear();
  s.attempts.clear();
  s.tickingTasks.clear();
  s.deliveryLocks.clear();
  s.readWarnAt.clear();
};

/** 同一个任务的投递排队执行（失败不阻塞后面的） */
const withDeliveryLock = <T>(taskId: string, fn: () => Promise<T>): Promise<T> => {
  const locks = state().deliveryLocks;
  const prev = locks.get(taskId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(taskId, tail);
  void tail.then(() => {
    if (locks.get(taskId) === tail) locks.delete(taskId);
  });
  return run;
};

/** 读取失败告警每个任务最多每分钟一条（持续的 IO 故障不能每 5 秒刷一屏） */
const READ_WARN_INTERVAL_MS = 60_000;

// ----------------- 下游响应分类 -----------------

/**
 * 把 chat-inject / task-question-inject 的 HTTP 响应归成三类。
 * - 200 / 202 → 送达（202 = 排进了会话队列，下游保证稍后送出并落 user_reply）
 * - 200 但 `settled:true` 且 outcome 不是 delivered → 幂等回放了一次「已失败」的结算 → 重试
 * - 404 → 会话没了（永久失败）
 * - 409 / 5xx / 网络类 → 暂时送不进（重试）
 * - 其余 4xx（缺凭据 / 模型非法 / 参数问题）→ 永久失败，把下游的话带出去
 */
export const classifyInjectResponse = (
  status: number,
  body: unknown,
): DeliverOutcome => {
  const b = (body && typeof body === "object" ? body : {}) as {
    error?: unknown;
    settled?: unknown;
    outcome?: unknown;
  };
  const error = typeof b.error === "string" && b.error.trim() ? b.error.trim() : "";
  if (status === 200 || status === 202) {
    if (b.settled === true && typeof b.outcome === "string" && b.outcome !== "delivered") {
      return { kind: "retry", reason: `上一次尝试没送达（${b.outcome}）` };
    }
    return { kind: "delivered" };
  }
  if (status === 404) return { kind: "failed", reason: error || "会话已不存在", permanent: true };
  if (status === 409 || status >= 500) {
    return { kind: "retry", reason: error || `暂时送不进会话（HTTP ${status}）` };
  }
  return { kind: "failed", reason: error || `送入会话失败（HTTP ${status}）` };
};

// ----------------- 提示文案 -----------------

const missedText = (rec: ScheduleRecord, now: number): string => {
  if (rec.kind === "once") {
    return `定时「${rec.title}」没能按时触发（${MISSED_NOTE}）。可以在「定时任务」页点「立即触发」。`;
  }
  const last = rec.history[rec.history.length - 1];
  const times = last?.note?.match(/错过 (\d+) 次/)?.[1];
  const head = times ? `错过了 ${times} 次` : "错过了一次";
  const tail =
    rec.nextFireAt !== null ? `，下次 ${formatScheduleTime(rec.nextFireAt, now)} 继续` : "";
  return `周期定时「${rec.title}」${head}（${MISSED_NOTE}）${tail}。`;
};

/** `after` = 结算后的记录：周期定时因此被自动取消 / 自动暂停时，把这件事一并告诉用户（不然它悄悄停了） */
const failedText = (rec: ScheduleRecord, reason: string, after?: ScheduleRecord | null): string => {
  const head = `定时「${rec.title}」到点了但没能送进会话：${reason}`;
  if (rec.kind !== "every" || !after) return head;
  if (after.status === "cancelled") return `${head}。这条周期定时已自动取消。`;
  if (after.status === "paused") {
    return `${head}。已连续 ${SCHEDULE_AUTO_PAUSE_FAILURES} 次没送进会话，这条周期定时已自动暂停；处理好后可在「定时任务」页恢复。`;
  }
  return head;
};

// ----------------- 调度器 -----------------

type StepDecision =
  | { kind: "none" }
  | { kind: "claimed"; record: ScheduleRecord }
  | { kind: "missed"; record: ScheduleRecord };

export interface ScheduleRunner {
  /** 扫一遍所有有定时的任务：到点的认领并投递、晚点的记错过、窗口耗尽的记失败 */
  tick: () => Promise<void>;
  /** 手动「立即触发」：额外多发一次（不改原计划）；已错过的一次性任务会被拉回再送 */
  fireNow: (
    taskId: string,
    scheduleId: string,
  ) => Promise<
    | { ok: true; record: ScheduleRecord; outcome: DeliverOutcome["kind"] }
    | { ok: false; error: string; code: "not_found" | "bad_state" | "task_gone" | "busy" }
  >;
}

export const createScheduleRunner = (deps: ScheduleRunnerDeps): ScheduleRunner => {
  const keyOf = (taskId: string, id: string): string => `${taskId}/${id}`;

  const safeNotify = async (
    taskId: string,
    text: string,
    meta: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await deps.notify(taskId, text, meta);
    } catch (err) {
      warn(`写提示事件失败 task=${taskId}`, err);
    }
  };

  /** 对一条已有 pending 的记录做一次投递尝试并结算（同会话串行） */
  const attemptDelivery = (
    taskId: string,
    rec: ScheduleRecord,
  ): Promise<DeliverOutcome["kind"]> => withDeliveryLock(taskId, () => doAttemptDelivery(taskId, rec));

  const doAttemptDelivery = async (
    taskId: string,
    rec: ScheduleRecord,
  ): Promise<DeliverOutcome["kind"]> => {
    const p = rec.pending;
    if (!p) return "delivered";
    const now = deps.now();
    const attemptKey = `${rec.id}#${p.seq}`;

    // 投递窗口耗尽：一直接不了 → 记失败（once = missed）
    if (now - p.since > SCHEDULE_DELIVERY_WINDOW_MS) {
      const note = `会话一直没空（忙 / 有未答的提问），超过 ${Math.round(SCHEDULE_DELIVERY_WINDOW_MS / 60_000)} 分钟没送进去`;
      const r = await deps.mutate(taskId, (list) => {
        const cur = list.find((x) => x.id === rec.id);
        if (!cur || cur.pending?.seq !== p.seq) return { list, changed: false, result: null };
        const next = markDeliveryFailed(cur, now, note);
        return { list: list.map((x) => (x.id === rec.id ? next : x)), result: next };
      });
      if (r.ok && r.result) {
        log(`failed task=${taskId} id=${rec.id} seq=${p.seq} reason=投递窗口耗尽 → ${r.result.status}`);
        await safeNotify(taskId, failedText(rec, note, r.result), buildScheduleInfoMeta(rec.id, "failed"));
      }
      state().attempts.delete(attemptKey);
      return "failed";
    }

    // 上一次结果不明就沿用同一个幂等键（见文件头）；明确没送达才换新键
    const prevAttempt = state().attempts.get(attemptKey);
    const attempt = prevAttempt ? (prevAttempt.unknown ? prevAttempt.n : prevAttempt.n + 1) : 1;
    state().attempts.set(attemptKey, { n: attempt, unknown: false });
    const markUnknown = (): void => {
      state().attempts.set(attemptKey, { n: attempt, unknown: true });
    };

    const opts = { seq: p.seq, dueAt: p.dueAt, manual: p.manual };
    let outcome: DeliverOutcome;
    // R14 Q20-02：deliver 外包超时——挂死的投递不能永远占着这个任务的 tick（见 SCHEDULE_DELIVER_TIMEOUT_MS）。
    // 超时后被丢下的 deliver 若稍后才 reject：Promise.race 已订阅它，不会变成 unhandledRejection
    const timeoutMs = deps.deliverTimeoutMs ?? SCHEDULE_DELIVER_TIMEOUT_MS;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      outcome = await Promise.race([
        deps.deliver({
          taskId,
          record: rec,
          pending: p,
          text: formatScheduleFireMessage(rec, { ...opts, now }),
          meta: buildScheduleFireMeta(rec, opts),
          clientItemId: `${rec.id}.${p.seq}.${attempt}`,
        }),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new DeliverTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } catch (err) {
      // 抛出 / 超时 = 下游可能已经受理了、只是没把结果带回来：结果不明
      markUnknown();
      outcome = {
        kind: "retry",
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }

    if (outcome.kind === "delivered") {
      try {
        await deps.mutate(taskId, (list) => {
          const cur = list.find((x) => x.id === rec.id);
          if (!cur || cur.pending?.seq !== p.seq) return { list, changed: false, result: null };
          const next = markDelivered(cur, deps.now());
          return { list: list.map((x) => (x.id === rec.id ? next : x)), result: next };
        });
      } catch (err) {
        // 已经送进会话了、只是「已送达」没写成：记录里 pending 还在，下一个 tick 会再投——
        // 必须沿用同一个幂等键，让下游认出这是同一条消息的回放
        markUnknown();
        throw err;
      }
      state().attempts.delete(attemptKey);
      log(`delivered task=${taskId} id=${rec.id} seq=${p.seq} attempt=${attempt}`);
      return "delivered";
    }
    if (outcome.kind === "failed") {
      const reason = outcome.reason;
      const permanent = outcome.permanent === true;
      const r = await deps.mutate(taskId, (list) => {
        const cur = list.find((x) => x.id === rec.id);
        if (!cur || cur.pending?.seq !== p.seq) return { list, changed: false, result: null };
        const next = markDeliveryFailed(cur, deps.now(), reason, { permanent });
        return { list: list.map((x) => (x.id === rec.id ? next : x)), result: next };
      });
      if (r.ok && r.result) {
        log(`failed task=${taskId} id=${rec.id} seq=${p.seq} permanent=${permanent} reason=${reason} → ${r.result.status}`);
        await safeNotify(taskId, failedText(rec, reason, r.result), buildScheduleInfoMeta(rec.id, "failed"));
      }
      state().attempts.delete(attemptKey);
      return "failed";
    }
    // retry：保留 pending，下个 tick 再试（窗口内）
    log(`retry task=${taskId} id=${rec.id} seq=${p.seq} attempt=${attempt} reason=${outcome.reason}`);
    return "retry";
  };

  /**
   * `tickNow`（R14 Q20-01）：这一轮 tick 的**起点**时刻。「晚点」要度量的是调度器发现它到点的时刻，不是前面兄弟占用的时间——
   * 同会话两条同刻到点的定时，第一条投递慢（会话要先恢复）占了 70 秒，轮到第二条时再取 `deps.now()` 会把它误判成
   * 「应用当时没开或电脑睡眠」。睡眠唤醒后的 tick 起点本身已经晚了，仍会被正确判成错过。不传（单测直接调）= 现取。
   */
  const stepOne = async (taskId: string, id: string, tickNow?: number): Promise<void> => {
    const now = tickNow ?? deps.now();
    const decided = await deps.mutate<StepDecision>(taskId, (list) => {
      const cur = list.find((r) => r.id === id);
      if (!cur) return { list, changed: false, result: { kind: "none" } };
      const cls = classifyDue(cur, now);
      if (cls === "fire") {
        const next = claimFire(cur, now);
        return {
          list: list.map((r) => (r.id === id ? next : r)),
          result: { kind: "claimed", record: next },
        };
      }
      if (cls === "missed") {
        const next = markMissed(cur, now, MISSED_NOTE);
        return {
          list: list.map((r) => (r.id === id ? next : r)),
          result: { kind: "missed", record: next },
        };
      }
      return { list, changed: false, result: { kind: "none" } };
    });
    if (!decided.ok) return;

    let rec: ScheduleRecord | undefined;
    if (decided.result.kind === "missed") {
      rec = decided.result.record;
      const lastMiss = rec.history[rec.history.length - 1];
      log(`missed task=${taskId} id=${rec.id} dueAt=${lastMiss?.dueAt ?? "?"} late=${lateSec(now, lastMiss?.dueAt)}`);
      await safeNotify(taskId, missedText(rec, now), buildScheduleInfoMeta(rec.id, "missed"));
    } else if (decided.result.kind === "claimed") {
      rec = decided.result.record;
      log(`claimed task=${taskId} id=${rec.id} seq=${rec.pending?.seq} late=${lateSec(now, rec.pending?.dueAt)}`);
    } else {
      rec = (await deps.read(taskId)).find((r) => r.id === id);
    }
    if (rec?.pending) await attemptDelivery(taskId, rec);
  };

  const step = async (taskId: string, id: string, tickNow?: number): Promise<void> => {
    const key = keyOf(taskId, id);
    const s = state();
    if (s.inflight.has(key)) return;
    s.inflight.add(key);
    try {
      await stepOne(taskId, id, tickNow);
    } catch (err) {
      warn(`调度出错 task=${taskId} id=${id}`, err);
    } finally {
      s.inflight.delete(key);
    }
  };

  const warnReadFailed = (taskId: string, err: unknown): void => {
    const s = state();
    const now = deps.now();
    const last = s.readWarnAt.get(taskId);
    if (last !== undefined && now - last < READ_WARN_INTERVAL_MS) return;
    s.readWarnAt.set(taskId, now);
    warn(`读取失败 task=${taskId}`, err);
  };

  /**
   * 投递中途被取消 / 暂停 / 手动结算的定时，`attempts` 里的记账没人清（只在送达 / 失败时删）。
   * 量很小，但别让它无限累积：读到「这条已经没有待投递」且当前没人在处理它 → 删它的所有记账。
   * 正在处理的（inflight）不碰：删了会让「明确没送达」的下一次又用回旧键，被下游当成已结算的失败回放。
   */
  const pruneStaleAttempts = (taskId: string, list: readonly ScheduleRecord[]): void => {
    const s = state();
    if (s.attempts.size === 0) return;
    for (const r of list) {
      if (r.pending !== undefined || s.inflight.has(keyOf(taskId, r.id))) continue;
      for (const key of [...s.attempts.keys()]) {
        if (key.startsWith(`${r.id}#`)) s.attempts.delete(key);
      }
    }
  };

  const tickTask = async (taskId: string): Promise<void> => {
    const s = state();
    // 这个任务上一轮还没处理完（慢投递）：不重入，免得叠出一串并行的读改写
    if (s.tickingTasks.has(taskId)) return;
    s.tickingTasks.add(taskId);
    try {
      let list: ScheduleRecord[];
      try {
        list = await deps.read(taskId);
      } catch (err) {
        warnReadFailed(taskId, err);
        return;
      }
      s.readWarnAt.delete(taskId);
      deps.syncIndex?.(taskId, list);
      pruneStaleAttempts(taskId, list);
      // 只处理「真有事」的：有待投递的、或已到点 / 已晚点的。没到点的 active 不必抢任务锁（那把锁和 meta / 事件写入共用）
      const tickNow = deps.now();
      const due = list.filter((r) => r.pending !== undefined || classifyDue(r, tickNow) !== "not_due");
      // 同一任务内逐条串行：多条同时到点时一条一条送进会话（并行会让它们同时通过「会话空闲」判断）。
      // 每一条都用同一个 tickNow 判到点 / 晚点（R14 Q20-01，见 stepOne）：前一条慢不该让后一条被判成错过
      for (const r of due) {
        await step(taskId, r.id, tickNow);
      }
    } finally {
      s.tickingTasks.delete(taskId);
    }
  };

  const tick = async (): Promise<void> => {
    await Promise.all(deps.liveTaskIds().map(tickTask));
  };

  const fireNow: ScheduleRunner["fireNow"] = async (taskId, id) => {
    const key = keyOf(taskId, id);
    const s = state();
    if (s.inflight.has(key)) {
      return { ok: false, error: "这条定时正在送达，稍等一下。", code: "busy" };
    }
    s.inflight.add(key);
    try {
      const now = deps.now();
      const claimed = await deps.mutate<
        | { ok: true; record: ScheduleRecord }
        | { ok: false; error: string; code: "not_found" | "bad_state" }
      >(taskId, (list) => {
        const cur = list.find((r) => r.id === id);
        if (!cur) {
          return {
            list,
            changed: false,
            result: { ok: false, error: "没有这条定时。", code: "not_found" },
          };
        }
        if (cur.status === "done" || cur.status === "cancelled") {
          return {
            list,
            changed: false,
            result: { ok: false, error: "这条定时已经结束，不能再触发。", code: "bad_state" },
          };
        }
        const next = claimFire(cur, now, { manual: true });
        return {
          list: list.map((r) => (r.id === id ? next : r)),
          result: { ok: true, record: next },
        };
      });
      if (!claimed.ok) return { ok: false, error: "会话已不存在。", code: "task_gone" };
      if (!claimed.result.ok) return claimed.result;
      const outcome = await attemptDelivery(taskId, claimed.result.record);
      const fresh = (await deps.read(taskId)).find((r) => r.id === id) ?? claimed.result.record;
      return { ok: true, record: fresh, outcome };
    } catch (err) {
      warn(`手动触发出错 task=${taskId} id=${id}`, err);
      return { ok: false, error: "触发失败，稍后再试。", code: "bad_state" };
    } finally {
      s.inflight.delete(key);
    }
  };

  return { tick, fireNow };
};

/** 默认依赖里「读 / 改 / 索引」三件（投递 / 通知由 schedule-service 接线） */
export const defaultStoreDeps = (): Pick<
  ScheduleRunnerDeps,
  "liveTaskIds" | "read" | "mutate" | "syncIndex"
> => ({
  liveTaskIds: scheduleLiveTaskIds,
  read: readSchedules,
  mutate: mutateSchedules,
  syncIndex: syncScheduleIndex,
});
