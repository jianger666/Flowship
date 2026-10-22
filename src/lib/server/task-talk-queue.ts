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
  buildDroppedQueueNotice,
  describeDroppedAttachments,
  type DroppedNoticeItem,
} from "@/lib/dropped-queue-notice";
import { redactSecretsInText } from "@/lib/server/event-secret-redact";
import {
  listGroupQuestionQueueView,
  removeGroupQuestionFromQueue,
  subscribeGroupQuestionQueue,
} from "@/lib/server/feishu-bridge/group-shared";
import { getChatLifecycle } from "@/lib/server/chat-gate";
import { getTaskMeta } from "@/lib/server/task-fs";
import {
  fingerprintTaskQuestionBody,
  TASK_INJECT_BUSY_CODE,
  TASK_INJECT_PHASE_STOPPING,
} from "@/lib/server/task-inject-shared";
import type { TaskQuestionInjectOptions } from "@/lib/server/task-question-inject";
import {
  agentSessions,
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
  /** 幂等键：app clientItemId（群来源目前不传） */
  dedupeKey?: string;
  /**
   * 入队时正文的指纹（与空闲直送的去重 key 同口径，见 task-inject-shared）。只在带 dedupeKey 时记。
   * 去重 = dedupeKey 与指纹**都**相同：同 id 不同正文是另一条消息、不能被当重复吞掉（K2-04）；
   * 直送成功后也据此摘掉同一条（K2-05）。
   */
  bodyFingerprint?: string;
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

/**
 * stop 的清队语义里**被清掉**的来源——与 stop-task.ts 的 `clearTalkQueue(id, { onlySources: ["app"] })`
 * 同口径（改一边必须改另一边；真实 stop 的行为由 tests/talk-queue-clear-callsites.test.ts 守住）。
 * 群来源（group_owner / group_reply）保留、空闲后照常送达。
 */
const STOP_CLEARED_SOURCES: readonly TalkQueueOwnedSource[] = ["app"];

/**
 * 重放得到的 409 分三类：
 * - `busy`：还忙 / 会自己恢复 → 放回队首等下一轮；
 * - `stopping`：任务**正在停止**（stop 收尾窗口，也是会自己恢复的一类，第八轮 L3-02）→ 放回还是丢弃
 *   看来源（见 drainOnce）；
 * - `other`：别的原因 → 丢弃并写 info。
 *
 * 认**结构化标记**（`code: "task_busy"`，注入链给会自己恢复的 409 打；停止中另带 `phase: "stopping"`）——
 * 文案是给人看的、会改，判忙不能靠它：此前只认「正在跑 / 等它说完」子串，在途等待超时的「还在处理中」
 * 认不出，被当非忙丢弃（第七轮 K2-03）。**文案子串仍保留作兜底**（老调用方 / 测试替身只回文案、不带 code
 * 时仍认得；只认「正在跑 / 等它说完」，**不**认「正在停止」——停止中靠 phase 标记）。
 */
type ReplayConflict = "busy" | "stopping" | "other";
const classifyReplayConflict = async (res: Response): Promise<ReplayConflict> => {
  if (res.status !== 409) return "other";
  try {
    const data = (await res.clone().json()) as {
      error?: unknown;
      code?: unknown;
      phase?: unknown;
    };
    if (data.code === TASK_INJECT_BUSY_CODE) {
      return data.phase === TASK_INJECT_PHASE_STOPPING ? "stopping" : "busy";
    }
    const msg = typeof data.error === "string" ? data.error : "";
    return msg.includes("正在跑") || msg.includes("等它说完") ? "busy" : "other";
  } catch {
    return "other";
  }
};

/**
 * 丢弃时把完整原文放进事件 meta 的来源：**用户自己的话**（app 输入条 / 群属主）。
 * 托办回执（group_reply）是外部机器人的回执，不是用户要重发的话，只留单行摘要、不把全文存进 meta。
 */
const USER_TEXT_SOURCES: readonly TalkQueueOwnedSource[] = ["app", "group_owner"];

const bodyTextOf = (item: TalkQueueStoredItem): string => {
  const raw = (item.rawBody as { text?: unknown } | null | undefined)?.text;
  return typeof raw === "string" ? raw : "";
};

/**
 * 条目里**用户自己的话**的完整文本（已脱敏、未截断）；非用户来源 / 没有文本（纯图片、纯文件）返回 ""。
 * 必须在截断（摘要 80 字 / meta 2000 字）之前脱敏：落盘前全局那道脱敏按完整精确值匹配，
 * 凭据一旦横跨截断点就只剩半截前缀、命不中（同 chat-runner 清队的口径）。
 */
const userTextOf = (item: TalkQueueStoredItem): string =>
  USER_TEXT_SOURCES.includes(item.source) ? redactSecretsInText(bodyTextOf(item)) : "";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** 条目带的图片 / 文件的文字占位（「2 张图片」）；没有附件返回 ""（Q6-04：纯图片 / 文件条被清时卡里要看得到） */
const attachmentsOf = (item: TalkQueueStoredItem): string => {
  const raw = item.rawBody as { images?: unknown; attachments?: unknown } | null | undefined;
  const n = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return describeDroppedAttachments(n(raw?.images), n(raw?.attachments));
};

const discardWithInfo = async (
  taskId: string,
  reason: string,
  item: TalkQueueStoredItem,
): Promise<void> => {
  const header = `排队的消息没送出去：${oneLine(reason)}`;
  const text = userTextOf(item);
  let notice: ReturnType<typeof buildDroppedQueueNotice>;
  if (text.trim()) {
    notice = buildDroppedQueueNotice({
      header,
      count: 1,
      items: [{ itemId: item.itemId, text }],
    });
  } else {
    // 没有可放进卡片的文本（纯图片 / 纯文件 / 外部回执）：单行摘要，与以前一致。
    // 摘要取自**脱敏后的全文**再截 80 字（item.preview 入队时已截到 120 字，凭据横跨那个点就只剩半截前缀）
    const body = oneLine(redactSecretsInText(bodyTextOf(item)));
    const snippet = (body || item.preview).slice(0, 80);
    notice = { text: snippet ? `${header}（${snippet}）` : header };
  }
  await writeEventAndPublish(taskId, {
    kind: "info",
    text: notice.text,
    ...(notice.meta ? { meta: notice.meta } : {}),
  }).catch((err) => {
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
    void discardWithInfo(taskId, "排队超过 30 分钟已过期", e);
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
    // 托办回执（group_reply）入队时只在「活会话在场」才被当数据喂回会话——群侧的承诺是
    // 会话不在就不自动唤醒、不拉起全权限 agent（见 group-route 文件头）。可它是在 agent
    // 正跑时入的队、到这里已隔了一整轮：典型是用户点了停止（会话被关、action 标 cancelled，
    // 群来源按设计保留），此时注入链会走唤醒分支，外部机器人的回执就把刚停下的 agent 叫醒了。
    // 所以重放前必须再判一次会话；不在就丢弃并写 info（不静默，属主能在事件流看到去向）。
    // 只管 group_reply：属主本人的话（app / group_owner）本来就允许在空闲时唤醒。
    if (item.source === "group_reply" && !agentSessions.has(taskId)) {
      await discardWithInfo(
        taskId,
        "会话已断开，托办回执不会自动唤醒 agent",
        item,
      );
      return;
    }
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
    const conflict = await classifyReplayConflict(res);
    if (conflict === "stopping" && STOP_CLEARED_SOURCES.includes(item.source)) {
      // 重放恰好落在 stop 收尾窗口：这一条早被 shift 出队，stop 的清队（在 await 之后才跑）清不到它。
      // stop 要清的来源（app）在这里等价地丢掉——放回队首的话，stop 结束后会被重放成一次用户点了停止
      // 之后的意外新 run。群来源（stop 保留的）走下面的放回，stop 结束后照常送达。写 info 不静默。
      await discardWithInfo(
        taskId,
        "任务被停止，输入条排的队已按停止清除",
        item,
      );
      return;
    }
    if (conflict !== "other") {
      // 仍在跑 / 正在停止的群来源（竞态）：放回队首等下一轮，保持 FIFO
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
    await discardWithInfo(taskId, reason, item);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await discardWithInfo(taskId, reason, item);
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
  | { ok: false; reason: "full" | "closing" };

/** 入队；满队返回 reason=full，任务正在停止 / 删除 / 终结返回 reason=closing */
export const enqueueTalkMessage = (
  taskId: string,
  input: EnqueueTalkMessageInput,
): EnqueueTalkMessageResult => {
  if (!taskId) return { ok: false, reason: "full" };
  // 调用方（task-question-inject）入口查过一次 lifecycle，可到入队之间还隔着读尾部事件的
  // await：这段时间里 stop / DELETE / finalize 的清队调用可能已经跑完，晚到的在途请求
  // 再入队就会把用户刚取消的输入条复活，或给已删 / 已终结的任务留下带启动凭据的条目。
  // 入队这一刻同步复查是本模块唯一能做的一道闸；opGen 要调用方传进来才判得了。
  if (getChatLifecycle(taskId) !== null) return { ok: false, reason: "closing" };
  const st = getState();
  let q = st.queues.get(taskId);
  if (!q) {
    q = [];
    st.queues.set(taskId, q);
  }

  const dedupeKey = input.clientItemId?.trim() || undefined;
  // 去重 = id 与正文指纹都相同（与空闲直送的去重 key 同口径）：只比 id 的话，同 id 带新正文的
  // 一条会被当「重复」静默吞掉——回 202 成功、队里留的却是旧正文，用户的新内容凭空消失（K2-04）。
  // 客户端正常只在内容一致时复用 id（talk-send-attempt），所以这条只防异常 / 旧客户端 / 恶意。
  const bodyFingerprint = dedupeKey
    ? fingerprintTaskQuestionBody(input.rawBody)
    : undefined;
  if (dedupeKey) {
    const idx = q.findIndex(
      (e) => e.dedupeKey === dedupeKey && e.bodyFingerprint === bodyFingerprint,
    );
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
    ...(dedupeKey && bodyFingerprint ? { dedupeKey, bodyFingerprint } : {}),
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

/**
 * 摘掉队列里与 (clientItemId, 正文指纹) 都相同的条目（同步、无 await）。返回摘掉几条。
 *
 * 为什么要有（K2-05）：同一条消息先排了队（202，响应丢了），客户端用同一个 id 重发、恰好 agent 已空闲
 * → 直送成功。直送登记的「已送达」只留 2 分钟，而队列项能躺 30 分钟：直送起的新 run 把 drain 挡住
 * 超过 2 分钟后，队列项重放时已送达表早已过期、查不到，同一句话就第二次注入。所以直送 200 的那一刻
 * 就把队里同一条摘掉——不靠「已送达表还没过期」这个会过期的前提。
 *
 * 指纹也要相同：同 id 不同正文是另一条消息（K2-04），它没送达过，不能被顺手摘掉。
 * 不碰 group_question（群模块自己的队列，不带 clientItemId）。
 */
export const removeTalkQueueItemsByDedupe = (
  taskId: string,
  clientItemId: string,
  bodyFingerprint: string,
): number => {
  const st = getState();
  const q = st.queues.get(taskId);
  if (!q || q.length === 0) return 0;
  const keep = q.filter(
    (e) => !(e.dedupeKey === clientItemId && e.bodyFingerprint === bodyFingerprint),
  );
  const removed = q.length - keep.length;
  if (removed === 0) return 0;
  if (keep.length === 0) st.queues.delete(taskId);
  else st.queues.set(taskId, keep);
  publishSnapshot(taskId);
  stopDrainTimerIfIdle(taskId);
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

/**
 * 同 clearTalkQueue，但把被清掉的**用户自己的话**的完整文本一并返回（已脱敏、未截断），
 * 给调用方落「排队消息未送达」事件用（D8-04）。
 *
 * 为什么要单独一个函数：clearTalkQueue 清完就拿不到文本了，快照必须在清之前、**同步**取；
 * 调用方（stop-task）要把「清队」留在原位置（早于一连串 await），事件稍后再落。
 * `count` 与 clearTalkQueue 返回值同义（含群问题等拿不到文本的）；`items` 含有文本**或带图片 / 文件**的用户来源条
 * （附件条只带 `attachments` 文字占位，Q6-04）。
 */
export const clearTalkQueueCapturing = (
  taskId: string,
  opts?: { onlySources?: readonly TalkQueueSource[] },
): { count: number; items: DroppedNoticeItem[] } => {
  const only = opts?.onlySources;
  const removing = (getState().queues.get(taskId) ?? []).filter(
    (e) => !only || only.includes(e.source),
  );
  const items: DroppedNoticeItem[] = [];
  for (const e of removing) {
    const text = userTextOf(e);
    // 图片 / 文件只取数量做文字占位（本体不进事件）；只对用户自己的话来源（托办回执不是用户要重发的东西）
    const attachments = USER_TEXT_SOURCES.includes(e.source) ? attachmentsOf(e) : "";
    if (text.trim() || attachments) {
      items.push({ itemId: e.itemId, text, ...(attachments ? { attachments } : {}) });
    }
  }
  return { count: clearTalkQueue(taskId, opts), items };
};

/**
 * 排队的话被清掉后，往事件流落一条「未送达」info（带 meta.droppedTexts，前端画 DroppedQueueCard）。
 * 失败只告警、不抛——它是提示，不能反过来拖垮 stop 之类的收尾。count ≤ 0 不写。
 * `header` 是首行（卡片标题），如「已停止，2 条排队消息未送达、请重新发送」。
 */
export const noticeTalkQueueDropped = async (
  taskId: string,
  args: { header: string; count: number; items: readonly DroppedNoticeItem[] },
): Promise<void> => {
  if (args.count <= 0) return;
  const notice = buildDroppedQueueNotice(args);
  await writeEventAndPublish(taskId, {
    kind: "info",
    text: notice.text,
    ...(notice.meta ? { meta: notice.meta } : {}),
  }).catch((err) => {
    console.warn(`[task-talk-queue] 写未送达提示失败 task=${taskId}:`, err);
  });
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
