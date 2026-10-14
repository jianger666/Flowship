/**
 * task 模式「待送达」消息队列（轻量、与 chat-queue 独立）
 *
 * agent 真在跑时，属主输入 / 群消息 / 群回执不再 409，先入队；drain 在 task 空闲且
 * lifecycle 干净时串行重放 `handleTaskQuestionInject`（一条一个 run，不连珠炮）。
 * 纯内存、不落盘；变更经 SSE `talk_queue` 帧下发整份快照（含群模块 group_question 视图）。
 *
 * 容量：每 task FIFO 上限 TALK_QUEUE_MAX；满队调用方走 409「排队已满」。
 * TTL：超过 TALK_QUEUE_TTL_MS 未送达 → 丢弃并写 info 事件（不静默）。
 */

import type { TalkQueueItem, TalkQueueSource } from "@/lib/talk-queue";
import {
  listGroupQuestionQueueView,
  removeGroupQuestionFromQueue,
  subscribeGroupQuestionQueue,
} from "@/lib/server/feishu-bridge/group-shared";
import { getChatLifecycle } from "@/lib/server/chat-gate";
import { getTaskMeta } from "@/lib/server/task-fs";
import type { TaskQuestionInjectOptions } from "@/lib/server/task-question-inject";
import {
  publishTaskStreamEvent,
  runningTasks,
  writeEventAndPublish,
} from "@/lib/server/task-stream";

export const TALK_QUEUE_MAX = 10;
/** 排队条目最长躺内存时间（重放仍走完整校验，图 base64 可接受） */
export const TALK_QUEUE_TTL_MS = 30 * 60 * 1000;

/** 本模块持有的来源（group_question 由群模块单独队列，快照里合并） */
export type TalkQueueOwnedSource = Exclude<TalkQueueSource, "group_question">;

export type TalkQueueStoredItem = {
  itemId: string;
  source: TalkQueueOwnedSource;
  /** 可重放的原始 HTTP / 桥接请求体 */
  rawBody: unknown;
  /** 纯数据注入选项（重放时清 queueIfBusy，防死循环） */
  options: TaskQuestionInjectOptions;
  senderName?: string;
  senderIsBot?: boolean;
  preview: string;
  createdAt: number;
  /** 幂等键：app clientItemId / 群 message_id */
  dedupeKey?: string;
};

type TalkQueueGlobalState = {
  queues: Map<string, TalkQueueStoredItem[]>;
  nextSeq: number;
  drainTimers: Map<string, ReturnType<typeof setInterval>>;
  drainInFlight: Set<string>;
};

const GLOBAL_KEY = "__flowshipTaskTalkQueueV1__";
const SUBSCRIBE_KEY = "__flowshipTaskTalkQueueSubV1__";

const getState = (): TalkQueueGlobalState => {
  const g = globalThis as unknown as Record<string, TalkQueueGlobalState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      queues: new Map(),
      nextSeq: 1,
      drainTimers: new Map(),
      drainInFlight: new Set(),
    };
  }
  const s = g[GLOBAL_KEY]!;
  if (!s.drainTimers) s.drainTimers = new Map();
  if (!s.drainInFlight) s.drainInFlight = new Set();
  if (typeof s.nextSeq !== "number" || s.nextSeq < 1) s.nextSeq = 1;
  return s;
};

const allocItemId = (): string => {
  const st = getState();
  const id = `tq_${st.nextSeq++}`;
  return id;
};

const previewFromBody = (rawBody: unknown): string => {
  const text =
    typeof (rawBody as { text?: unknown })?.text === "string"
      ? ((rawBody as { text: string }).text ?? "")
      : "";
  const compact = text.replace(/\s+/g, " ").trim().slice(0, 120);
  if (compact) return compact;
  const imgs = (rawBody as { images?: unknown[] })?.images;
  const atts = (rawBody as { attachments?: unknown[] })?.attachments;
  if (Array.isArray(imgs) && imgs.length > 0) return "(附图片)";
  if (Array.isArray(atts) && atts.length > 0) return "(附文件)";
  return "(空正文)";
};

const ownedToView = (item: TalkQueueStoredItem): TalkQueueItem => ({
  id: item.itemId,
  source: item.source,
  ...(item.senderName ? { senderName: item.senderName } : {}),
  ...(item.senderIsBot ? { senderIsBot: true } : {}),
  preview: item.preview,
  createdAt: item.createdAt,
});

const publishSnapshot = (taskId: string): void => {
  publishTaskStreamEvent(taskId, {
    kind: "talk_queue",
    items: buildTalkQueueSnapshot(taskId),
  });
};

const stopDrainTimerIfIdle = (taskId: string): void => {
  const st = getState();
  const q = st.queues.get(taskId);
  if (q && q.length > 0) return;
  const t = st.drainTimers.get(taskId);
  if (t) {
    clearInterval(t);
    st.drainTimers.delete(taskId);
  }
};

const ensureDrainTimer = (taskId: string): void => {
  const st = getState();
  if (st.drainTimers.has(taskId)) return;
  const timer = setInterval(() => {
    void tickDrain(taskId);
  }, 1000);
  timer.unref?.();
  st.drainTimers.set(taskId, timer);
};

const isBusy409 = async (res: Response): Promise<boolean> => {
  if (res.status !== 409) return false;
  try {
    const data = (await res.clone().json()) as { error?: unknown };
    const msg = typeof data.error === "string" ? data.error : "";
    return msg.includes("正在跑") || msg.includes("等它说完");
  } catch {
    return false;
  }
};

const discardWithInfo = async (
  taskId: string,
  reason: string,
  preview: string,
): Promise<void> => {
  const text = `排队的消息没送出去：${reason}${preview ? `（${preview.slice(0, 80)}）` : ""}`;
  await writeEventAndPublish(taskId, { kind: "info", text }).catch((err) => {
    console.warn(`[task-talk-queue] 写 info 失败 task=${taskId}:`, err);
  });
};

/** 把重放中的条目放回队首（队列可能在 await 期间被清空 / 删掉，所以每次现取） */
const putBackToHead = (taskId: string, item: TalkQueueStoredItem): void => {
  const st = getState();
  const q = st.queues.get(taskId);
  if (q) q.unshift(item);
  else st.queues.set(taskId, [item]);
  // 队列可能在重放期间被清空而停了定时器：放回后必须重新拉起，否则这条永远没人送
  ensureDrainTimer(taskId);
  publishSnapshot(taskId);
};

/** 清掉所有超过 TTL 的条目（不管任务忙不忙：躺满 30 分钟就该让用户知道没送出去） */
const sweepExpired = (taskId: string): void => {
  const st = getState();
  const q = st.queues.get(taskId);
  if (!q || q.length === 0) return;
  const now = Date.now();
  const keep = q.filter((e) => now - e.createdAt < TALK_QUEUE_TTL_MS);
  if (keep.length === q.length) return;
  const expired = q.filter((e) => now - e.createdAt >= TALK_QUEUE_TTL_MS);
  if (keep.length === 0) st.queues.delete(taskId);
  else st.queues.set(taskId, keep);
  for (const e of expired) {
    void discardWithInfo(taskId, "排队超过 30 分钟已过期", e.preview);
  }
  publishSnapshot(taskId);
};

/** 一次 drain：task 空闲且 lifecycle 干净时，取队首重放一条（调用方已持 drainInFlight 锁） */
const drainOnce = async (taskId: string): Promise<void> => {
  const st = getState();
  // 先做同步的廉价判断再读 meta：agent 在跑的几十分钟里每秒读一次盘没必要
  if (getChatLifecycle(taskId) !== null) return;
  if (runningTasks.has(taskId)) return;

  const task = await getTaskMeta(taskId);
  if (!task || task.mode === "chat") {
    clearTalkQueue(taskId);
    return;
  }
  if (task.runStatus === "running") return;
  // await 期间 lifecycle / run 可能变了（停止、删除、用户又发了一句）——放行前复查
  if (getChatLifecycle(taskId) !== null || runningTasks.has(taskId)) return;

  // 队列在 await 期间可能被清 / 被删 / 被重建：必须现取，不能沿用 await 前拿的数组引用
  // （否则会把已被用户删掉的条目重放出去）
  const q = st.queues.get(taskId);
  if (!q || q.length === 0) {
    stopDrainTimerIfIdle(taskId);
    return;
  }
  const item = q.shift()!;
  if (q.length === 0) st.queues.delete(taskId);
  publishSnapshot(taskId);

  try {
    const { handleTaskQuestionInject } = await import(
      "@/lib/server/task-question-inject"
    );
    // 重放必须清 queueIfBusy：否则 drain 遇到「刚好又忙」会再入队，形成死循环
    const replayOptions: TaskQuestionInjectOptions = {
      ...item.options,
      queueIfBusy: undefined,
      userReplyMetaExtra: {
        ...(item.options.userReplyMetaExtra ?? {}),
        fromQueue: true,
        queuedAt: item.createdAt,
      },
    };
    const res = await handleTaskQuestionInject(
      taskId,
      item.rawBody,
      replayOptions,
    );
    if (res.ok || res.status === 202) return;
    if (await isBusy409(res)) {
      // 仍在跑（竞态）：放回队首等下一轮，保持 FIFO
      putBackToHead(taskId, item);
      return;
    }
    let reason = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === "string") reason = data.error;
    } catch {
      /* noop */
    }
    await discardWithInfo(taskId, reason, item.preview);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await discardWithInfo(taskId, reason, item.preview);
  } finally {
    stopDrainTimerIfIdle(taskId);
  }
};

const tickDrain = async (taskId: string): Promise<void> => {
  const st = getState();
  sweepExpired(taskId);
  const q = st.queues.get(taskId);
  if (!q || q.length === 0) {
    stopDrainTimerIfIdle(taskId);
    return;
  }
  // 锁必须在第一个 await 之前占上：定时器每秒一跳，meta 读盘慢时两跳会重叠，
  // 两次都通过检查就会同时重放两条（连珠炮）
  if (st.drainInFlight.has(taskId)) return;
  st.drainInFlight.add(taskId);
  try {
    await drainOnce(taskId);
  } finally {
    st.drainInFlight.delete(taskId);
  }
};

// HMR 安全：群队列变化也重发 talk_queue 快照（只订一次）
(() => {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (g[SUBSCRIBE_KEY]) return;
  g[SUBSCRIBE_KEY] = true;
  subscribeGroupQuestionQueue((taskId) => {
    publishSnapshot(taskId);
  });
})();

export type EnqueueTalkMessageInput = {
  source: TalkQueueOwnedSource;
  rawBody: unknown;
  options: TaskQuestionInjectOptions;
  senderName?: string;
  senderIsBot?: boolean;
  preview?: string;
  clientItemId?: string;
};

export type EnqueueTalkMessageResult =
  | { ok: true; itemId: string; position: number; duplicate?: true }
  | { ok: false; reason: "full" };

/** 入队；满队返回 reason=full */
export const enqueueTalkMessage = (
  taskId: string,
  input: EnqueueTalkMessageInput,
): EnqueueTalkMessageResult => {
  if (!taskId) return { ok: false, reason: "full" };
  const st = getState();
  let q = st.queues.get(taskId);
  if (!q) {
    q = [];
    st.queues.set(taskId, q);
  }

  const dedupeKey = input.clientItemId?.trim() || undefined;
  if (dedupeKey) {
    const idx = q.findIndex((e) => e.dedupeKey === dedupeKey);
    if (idx >= 0) {
      publishSnapshot(taskId);
      return {
        ok: true,
        itemId: q[idx]!.itemId,
        position: idx + 1,
        duplicate: true,
      };
    }
  }

  if (q.length >= TALK_QUEUE_MAX) {
    return { ok: false, reason: "full" };
  }

  const item: TalkQueueStoredItem = {
    itemId: allocItemId(),
    source: input.source,
    rawBody: input.rawBody,
    options: {
      ...input.options,
      queueIfBusy: undefined,
    },
    ...(input.senderName ? { senderName: input.senderName } : {}),
    ...(input.senderIsBot ? { senderIsBot: true } : {}),
    preview: input.preview?.trim() || previewFromBody(input.rawBody),
    createdAt: Date.now(),
    ...(dedupeKey ? { dedupeKey } : {}),
  };
  q.push(item);
  ensureDrainTimer(taskId);
  publishSnapshot(taskId);
  return { ok: true, itemId: item.itemId, position: q.length };
};

/** 本模块队列条目（不含 group_question） */
export const listTalkQueue = (taskId: string): TalkQueueItem[] =>
  (getState().queues.get(taskId) ?? []).map(ownedToView);

/** UI / SSE 用：合并本模块 + 群 group_question */
export const buildTalkQueueSnapshot = (taskId: string): TalkQueueItem[] => {
  const owned = listTalkQueue(taskId);
  const groupQ = listGroupQuestionQueueView(taskId).map(
    (g): TalkQueueItem => ({
      id: g.id,
      source: "group_question",
      senderName: g.senderName,
      senderIsBot: g.senderIsBot,
      preview: g.preview,
      createdAt: g.createdAt,
    }),
  );
  return [...owned, ...groupQ].sort((a, b) => a.createdAt - b.createdAt);
};

export const removeTalkQueueItems = (
  taskId: string,
  itemIds: readonly string[],
): string[] => {
  const removed: string[] = [];
  for (const id of itemIds) {
    if (removeGroupQuestionFromQueue(taskId, id)) {
      removed.push(id);
      continue;
    }
    const st = getState();
    const q = st.queues.get(taskId);
    if (!q) continue;
    const idx = q.findIndex((e) => e.itemId === id);
    if (idx >= 0) {
      q.splice(idx, 1);
      removed.push(id);
      if (q.length === 0) st.queues.delete(taskId);
    }
  }
  if (removed.length > 0) {
    publishSnapshot(taskId);
    stopDrainTimerIfIdle(taskId);
  }
  return removed;
};

export const clearTalkQueue = (
  taskId: string,
  opts?: { onlySources?: readonly TalkQueueSource[] },
): number => {
  const only = opts?.onlySources;
  let n = 0;
  // group_question 的真身在群模块队列；只有显式要清（或整队清）才动，停止只清 app 不动群来源
  if (!only || only.includes("group_question")) {
    for (const g of listGroupQuestionQueueView(taskId)) {
      if (removeGroupQuestionFromQueue(taskId, g.id)) n++;
    }
  }
  const st = getState();
  const q = st.queues.get(taskId);
  if (q) {
    if (!only) {
      n += q.length;
      st.queues.delete(taskId);
    } else {
      const keep = q.filter((e) => !only.includes(e.source));
      const removed = q.length - keep.length;
      n += removed;
      if (keep.length === 0) st.queues.delete(taskId);
      else st.queues.set(taskId, keep);
    }
  }
  if (n > 0) publishSnapshot(taskId);
  stopDrainTimerIfIdle(taskId);
  return n;
};

/** 单测：手动跑一轮 drain（不依赖 setInterval） */
export const __tickTalkQueueDrainForTest = tickDrain;

/** 单测 / 热更：清全局队列与 drain 定时器 */
export const __resetTaskTalkQueueForTest = (): void => {
  const st = getState();
  for (const t of st.drainTimers.values()) clearInterval(t);
  st.drainTimers.clear();
  st.drainInFlight.clear();
  st.queues.clear();
  st.nextSeq = 1;
};
