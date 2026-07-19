/**
 * Chat 运行中消息排队（P5.1）+ MessageOperation aggregate（R35-1 / R35-6 / R36）
 *
 * agent 正在回时 chat-reply 不再 409，消息入 per-task 队列；
 * consumeChatRun 自然结束后 dequeue 依序 send（user_reply 在实际发送时才落）。
 * 纯函数便于单测；Map 挂 globalThis 防 dev hot reload 拆分。
 *
 * # 容量协议（S4 / 十二轮）
 *
 * 上限 CHAT_QUEUE_MAX 计入「队列长度 + in-flight」：
 *   - in-flight = flush 已 dequeue、尚未 send 成功 / 塞回 / 作废丢弃的那条
 *   - enqueue 判满：length + inflight >= MAX → full（HTTP 409，诚实拒绝新消息）
 *   - 已 202 的消息绝不因塞回超限被丢队尾；理论短暂 MAX+1 可接受（打 error 日志）
 *
 * # R33-1 QueueOperation 契约
 *
 * - itemId：客户端可预生成（clientItemId）；服务端无则兜底发号
 * - active（队内 + in-flight）+ bounded recentSettled ledger
 * - 所有清队终态只走 failQueuedItems（禁止业务路径直调 clearChatQueue）
 *
 * # R35-1 / R35-6 / R36 MessageOperation aggregate
 *
 * - 同步原子 claim → 唯一 handle（staged attachments + transfer/settle/release）
 * - phase：accepting → persisted → handedOff（成功终态）| failed 家族（失败终态）
 * - user_reply 落盘只到 persisted；runner 在 SDK send resolve 后才 settle handedOff
 * - terminal 与 recentSettled 同界淘汰（RECENT_SETTLED_MAX）；淘汰后同 id = absent 新受理
 * - fingerprint 唯一契约：共享 lib `computeChatPayloadFingerprint`（FNV + imageKeys）
 */

import { unlinkSync } from "node:fs";

import {
  computeChatPayloadFingerprint,
  imageKeysFromPayloads,
  type ChatSkillRef,
} from "@/lib/chat-payload-fingerprint";
import type {
  MessageOpFailureOutcome,
  MessageOpOutcome as WireMessageOpOutcome,
} from "@/lib/message-op-schema";

import type { ImageAttachmentSaved } from "./task-artifacts";
import type { AttachmentMeta } from "./route-helpers";
import { publish } from "./task-stream";

export const CHAT_QUEUE_MAX = 5;

/** R33-1：recentSettled FIFO 上限（断线重连可重放对账） */
export const RECENT_SETTLED_MAX = 50;

/**
 * R32-2 / R33-1 / R36-3：清队终态 reason（机器可读，经 queue_failed / message_op 下发前端）。
 * 单一来源 = 共享 wire schema（`@/lib/message-op-schema`）——client exhaustive decoder
 * 与 server 枚举编译期绑定，新增失败值只改 schema 一处。
 * - persist_failed：strict 落盘 EIO 等
 * - no_session：会话消失、无法按序送达
 * - task_gone：任务目录消失 / 非 chat
 * - flush_error：checkpoint / send / 后置步骤抛错
 * - stopped / cancelled / error / startup_failed / rewound / deleted：旁路清队统一 sink
 */
export type FailQueuedItemsReason = MessageOpFailureOutcome;

/**
 * R33-1 / R35-6：ledger 终态 outcome（= 共享 schema MessageOpOutcome）。
 * delivered = handedOff（agent 已真正接管），绝不是「仅有 user_reply 气泡」。
 */
export type QueueItemSettleOutcome = WireMessageOpOutcome;

export type RecentSettledEntry = {
  itemId: string;
  outcome: QueueItemSettleOutcome;
};

/**
 * R35-1 / R35-6 / R36：单条消息受理状态机 phase（wire 可复用）。
 * - accepting / persisted：非终态（active）
 * - handedOff：成功终态（对外 outcome=delivered）
 * - FailQueuedItemsReason：失败终态
 */
export type MessageOpPhase =
  | "accepting"
  | "persisted"
  | "handedOff"
  | FailQueuedItemsReason;

/** R36：wire 终态 outcome（= 共享 schema，经 QueueItemSettleOutcome 别名） */
export type MessageOpOutcome = QueueItemSettleOutcome;

export type MessageOperation = {
  itemId: string;
  fingerprint: string;
  phase: MessageOpPhase;
  /**
   * R36-12：claim 后落盘、尚未 transfer 的附件绝对路径。
   * release / failed-before-persist 时尽力删除；transfer 成功后清空清单（文件归 queue/事件持有）。
   */
  stagedAttachmentPaths?: string[];
};

/**
 * R36-5：claim 赢家持有的唯一 handle——route 外层 finally 只认三种出口：
 * transfer（queue/runner 接管）/ settle terminal（phase 已终态）/ release（仍 accepting）。
 */
export type MessageOpHandle = {
  readonly itemId: string;
  readonly taskId: string;
  /** R36-5：queue / runner 已接管——finally 不再 release */
  transfer: () => void;
  /** R36-12：登记本批 staged 附件（仅 accepting 有效） */
  stageAttachments: (absPaths: readonly string[]) => void;
  /**
   * R36-5：finally 出口。
   * - 已 transfer → no-op
   * - 已终态 → no-op
   * - accepting → release + 回滚 staged
   * - persisted 仍挂着（异常漏 settle）→ settleFailed(flush_error)
   */
  finalize: () => void;
};

/** R36-4：watch bootstrap 完整 operation snapshot 条目 */
export type MessageOpSnapshotEntry = {
  itemId: string;
  phase: MessageOpPhase;
};

/** payload 指纹输入（与共享 lib 对齐；落盘前即可算） */
export type MessagePayloadForFingerprint = {
  text: string;
  images?: Array<{ data?: string; mimeType?: string; filename?: string }>;
  attachmentPaths?: string[];
  skills?: Array<{ name: string; absPath: string }>;
};

/**
 * R36：稳定 payload 指纹——委托共享 `computeChatPayloadFingerprint`
 *（FNV + imageKeysFromPayloads 的 filename / mime+len 键，不再 SHA-256 图内容）。
 */
export const fingerprintFromMessagePayload = (
  payload: MessagePayloadForFingerprint,
): string =>
  computeChatPayloadFingerprint({
    text: payload.text,
    imagePaths: imageKeysFromPayloads(
      (payload.images ?? []).map((img) => ({
        data: img.data ?? "",
        mimeType: img.mimeType ?? "application/octet-stream",
        filename: img.filename,
      })),
    ),
    attachmentPaths: [...(payload.attachmentPaths ?? [])],
    skills: (payload.skills ?? []) as ChatSkillRef[],
  });

/** R35-1 / R36-5：claim 结果（claimed 时带唯一 handle） */
export type ClaimMessageOperationResult =
  | { status: "claimed"; itemId: string; handle: MessageOpHandle }
  | {
      status: "active";
      phase: "accepting" | "persisted";
      itemId: string;
      queuedCount: number;
    }
  | {
      status: "settled";
      itemId: string;
      outcome: QueueItemSettleOutcome;
      queuedCount: number;
    }
  | { status: "payload_mismatch"; itemId: string };

/** R36-12：尽力删除 staged 附件（release 补偿；失败吞掉） */
const rollbackStagedFiles = (paths: readonly string[]): void => {
  for (const p of paths) {
    if (!p) continue;
    try {
      unlinkSync(p);
    } catch {
      /* 尽力而为：文件可能已被删 / 权限瞬断 */
    }
  }
};

const isMessageOpTerminal = (phase: MessageOpPhase): boolean =>
  phase !== "accepting" && phase !== "persisted";

const terminalPhaseToOutcome = (
  phase: MessageOpPhase,
): QueueItemSettleOutcome | null => {
  if (phase === "handedOff") return "delivered";
  if (phase === "accepting" || phase === "persisted") return null;
  return phase;
};

/**
 * R31-1 / R33-7：进程内单调短 id，供 202 ↔ pending ↔ queue_failed 对账。
 * 发号器挂 globalThis（与 queue state 同对象），防 route-chunk / HMR 撞号。
 * 客户端预生成 UUID 后此发号器只剩兜底。
 */
export const allocChatQueueItemId = (): string => {
  const state = getQueueState();
  const seq = state.nextItemSeq++;
  return `cq_${Date.now().toString(36)}_${seq.toString(36)}`;
};

/** 队列里暂存的待发消息（纯文本 + 已落盘的图 / 附件路径） */
export type QueuedChatMsg = {
  /**
   * R31-1：稳定队列项 id（入队时分配；202 / pending / queue_failed 对账用）。
   * 调用方可不传——enqueue / enqueueFront 会自动补。
   */
  itemId: string;
  /** 进 agent 的文本（可含 skill 指引） */
  agentText: string;
  /** 落 user_reply 气泡的用户原文 */
  displayText: string;
  imageAbsPaths?: string[];
  /** 写进 user_reply.meta.images 的完整 meta */
  savedImages?: ImageAttachmentSaved[];
  attachmentAbsPaths?: string[];
  /** 写进 user_reply.meta.attachments */
  attachmentMetas?: AttachmentMeta[];
  enqueuedAt: number;
  /**
   * 消息对应的 user_reply 事件已由入队方落盘（如并发起会话被吞后改入队、
   * chat-reply 模式 2 已 persistReplyAndCheckpoint）。flush 发出后不要再落一条重复气泡。
   */
  skipPersistEvent?: boolean;
};

/** 入队入参：itemId 可选（缺则自动分配） */
export type QueuedChatMsgInput = Omit<QueuedChatMsg, "itemId"> & {
  itemId?: string;
};

const withItemId = (msg: QueuedChatMsgInput): QueuedChatMsg => ({
  ...msg,
  itemId:
    typeof msg.itemId === "string" && msg.itemId.trim()
      ? msg.itemId.trim()
      : allocChatQueueItemId(),
});

interface ChatQueueGlobalState {
  queues: Map<string, QueuedChatMsg[]>;
  /**
   * per-task 单调递增「作废世代」：clearChatQueue（stop / rewind / 删任务）时 +1。
   * flush drain 从 dequeue 到塞回队首之间若 generation 变了，说明中途已清队、
   * 该消息已被判定作废，不得 enqueueFront 复活（否则会带着回退前旧上下文再发）。
   */
  generations: Map<string, number>;
  /**
   * S4（十二轮）：per-task in-flight 计数（通常 0|1）。
   * flush 成功 dequeue 后 +1，send 成功 / 塞回 / generation 作废 / 异常清队后归零。
   * 计入容量，避免 dequeue 空出窗口时新消息 202 再塞满、塞回时静默丢已接受消息。
   */
  inFlight: Map<string, number>;
  /**
   * R32-2：in-flight 条的 itemId（与 inFlight 同步寿命）。
   * watch bootstrap 的 queue_state 需把「已 dequeue、尚未出路」的条算进服务端存活集合，
   * 否则重连会把正当 in-flight 误判成幽灵 pending。
   */
  inFlightItemIds: Map<string, string>;
  /**
   * R33-1：per-task 有界终态 ledger（FIFO）。
   * failQueuedItems / handedOff(delivered) 都记；watch bootstrap 重放对账。
   * R35-6：只含真终态，不含 persisted。
   */
  recentSettled: Map<string, RecentSettledEntry[]>;
  /**
   * R35-1：per-task MessageOperation 表（itemId → op）。
   * direct / firstMessage / queued / queue-priority / flush 共用；挂 globalThis 防分裂。
   */
  messageOps: Map<string, Map<string, MessageOperation>>;
  /** R33-7：全局 item 发号器（与 Map 同寿命，防 resetModules 撞号） */
  nextItemSeq: number;
}

// V6：相对 V5 增 messageOps（R35-1）；换 key 防 hot-reload 缺字段分裂
const CHAT_QUEUE_GLOBAL_KEY = "__feAiFlowChatQueueV6__";

const getQueueState = (): ChatQueueGlobalState => {
  const g = globalThis as unknown as Record<
    string,
    ChatQueueGlobalState | undefined
  >;
  if (!g[CHAT_QUEUE_GLOBAL_KEY]) {
    g[CHAT_QUEUE_GLOBAL_KEY] = {
      queues: new Map(),
      generations: new Map(),
      inFlight: new Map(),
      inFlightItemIds: new Map(),
      recentSettled: new Map(),
      messageOps: new Map(),
      nextItemSeq: 1,
    };
  }
  const state = g[CHAT_QUEUE_GLOBAL_KEY]!;
  // hot-reload：旧 state 可能缺字段
  if (!state.generations) state.generations = new Map();
  if (!state.inFlight) state.inFlight = new Map();
  if (!state.inFlightItemIds) state.inFlightItemIds = new Map();
  if (!state.recentSettled) state.recentSettled = new Map();
  if (!state.messageOps) state.messageOps = new Map();
  if (typeof state.nextItemSeq !== "number" || state.nextItemSeq < 1) {
    state.nextItemSeq = 1;
  }
  return state;
};

const queues = () => getQueueState().queues;
const generations = () => getQueueState().generations;
const inFlightMap = () => getQueueState().inFlight;
const inFlightItemIdsMap = () => getQueueState().inFlightItemIds;
const recentSettledMap = () => getQueueState().recentSettled;
const messageOpsMap = () => getQueueState().messageOps;

const taskMessageOps = (taskId: string): Map<string, MessageOperation> => {
  const map = messageOpsMap();
  let ops = map.get(taskId);
  if (!ops) {
    ops = new Map();
    map.set(taskId, ops);
  }
  return ops;
};

const activeQueuedCount = (taskId: string): number =>
  (queues().get(taskId)?.length ?? 0) + (inFlightMap().get(taskId) ?? 0);

/**
 * R33-1 / R35-6 / R36-11：把 item 记入 per-task recentSettled（已有则跳过；超上限 FIFO 丢最老）。
 * first-outcome-wins：只接受真终态（delivered=handedOff / failed 家族）。
 * 同步推进 messageOps phase；淘汰的 terminal 条目从 messageOps 同步删除
 *（active/persisted 绝不淘汰；淘汰后同 id 重试语义 = absent 新受理）。
 */
export const recordQueueItemSettled = (
  taskId: string,
  itemId: string,
  outcome: QueueItemSettleOutcome,
): void => {
  if (!itemId) return;
  const map = recentSettledMap();
  const cur = map.get(taskId) ?? [];
  if (cur.some((e) => e.itemId === itemId)) return;
  const next = [...cur, { itemId, outcome }];
  const ops = taskMessageOps(taskId);
  if (next.length > RECENT_SETTLED_MAX) {
    const dropped = next.slice(0, next.length - RECENT_SETTLED_MAX);
    const kept = next.slice(next.length - RECENT_SETTLED_MAX);
    map.set(taskId, kept);
    // R36-11：与 recentSettled 同一有界索引淘汰 terminal messageOps
    for (const e of dropped) {
      const op = ops.get(e.itemId);
      if (op && isMessageOpTerminal(op.phase)) {
        ops.delete(e.itemId);
      }
    }
  } else {
    map.set(taskId, next);
  }
  // R35-1：ledger 与 operation 同推进（保留 staged 清单直至终态）
  const existing = ops.get(itemId);
  if (!existing || !isMessageOpTerminal(existing.phase)) {
    ops.set(itemId, {
      itemId,
      fingerprint: existing?.fingerprint ?? "",
      phase: outcome === "delivered" ? "handedOff" : outcome,
      // 终态不再需要回滚清单
      stagedAttachmentPaths: undefined,
    });
  }
  // R36-2：终态实时下发（纯内存帧）——成功终态（delivered）此前只有 recentSettled
  // 重放可见、在线 client 无法实时清 pending；失败侧与 queue_failed 双发无害
  //（client reducer first-outcome-wins 幂等）。
  publish(taskId, {
    kind: "message_op",
    itemId,
    phase: outcome === "delivered" ? "handedOff" : outcome,
    outcome,
  });
};

/** R33-1：只读快照——bootstrap queue_state.recentSettled */
export const listRecentSettled = (taskId: string): RecentSettledEntry[] => [
  ...(recentSettledMap().get(taskId) ?? []),
];

/**
 * 入队结果：ok + 当前条数 + itemId；满了返回 full。
 * R34-4：同 (taskId, clientItemId) 幂等——已 active 返 alreadyAccepted；
 * 已在 recentSettled 返 already_settled（调用方映射终态 JSON，禁止再 append）。
 */
export type EnqueueResult =
  | {
      ok: true;
      queuedCount: number;
      itemId: string;
      /** R34-4：同 id 已在队内/in-flight，幂等命中未再 append */
      alreadyAccepted?: boolean;
    }
  | { ok: false; reason: "full"; queuedCount: number }
  | {
      ok: false;
      reason: "already_settled";
      itemId: string;
      outcome: QueueItemSettleOutcome;
      queuedCount: number;
    };

/** R34-4：查 recentSettled 中某 item 的终态（无则 undefined） */
export const findRecentSettledEntry = (
  taskId: string,
  itemId: string,
): RecentSettledEntry | undefined =>
  recentSettledMap()
    .get(taskId)
    ?.find((e) => e.itemId === itemId);

/** R35-1：只读某条 MessageOperation（测试 / 诊断） */
export const getMessageOperation = (
  taskId: string,
  itemId: string,
): MessageOperation | undefined => taskMessageOps(taskId).get(itemId);

/**
 * R36-4：完整 MessageOperation aggregate 快照（含 accepting/persisted/handedOff/failed）。
 * 供 watch bootstrap——不再用 queue+in-flight 子集冒充全部 active。
 */
export const listMessageOperationSnapshot = (
  taskId: string,
): MessageOpSnapshotEntry[] => {
  const ops = messageOpsMap().get(taskId);
  if (!ops || ops.size === 0) return [];
  return [...ops.values()].map((op) => ({
    itemId: op.itemId,
    phase: op.phase,
  }));
};

/** R36-12：把本批落盘附件挂到 accepting op（transfer 前可回滚） */
export const stageMessageAttachments = (
  taskId: string,
  itemId: string,
  absPaths: readonly string[],
): void => {
  if (!itemId || absPaths.length === 0) return;
  const ops = taskMessageOps(taskId);
  const cur = ops.get(itemId);
  if (!cur || cur.phase !== "accepting") return;
  ops.set(itemId, {
    ...cur,
    stagedAttachmentPaths: [
      ...(cur.stagedAttachmentPaths ?? []),
      ...absPaths.filter(Boolean),
    ],
  });
};

/**
 * R36-12：transfer 成功——清空回滚清单（文件已归 queue / user_reply 持有，不再随 release 删）。
 */
export const commitMessageStagedAttachments = (
  taskId: string,
  itemId: string,
): void => {
  if (!itemId) return;
  const ops = taskMessageOps(taskId);
  const cur = ops.get(itemId);
  if (!cur?.stagedAttachmentPaths?.length) return;
  ops.set(itemId, { ...cur, stagedAttachmentPaths: undefined });
};

/** R36-5：构造 claim 赢家 handle */
const createMessageOpHandle = (
  taskId: string,
  itemId: string,
): MessageOpHandle => {
  let transferred = false;
  return {
    itemId,
    taskId,
    transfer: () => {
      transferred = true;
      // R36-12：接管成功 → 提交 staged（保留磁盘文件）
      commitMessageStagedAttachments(taskId, itemId);
    },
    stageAttachments: (absPaths) => {
      stageMessageAttachments(taskId, itemId, absPaths);
    },
    finalize: () => {
      if (transferred) return;
      const op = taskMessageOps(taskId).get(itemId);
      if (!op) return;
      if (isMessageOpTerminal(op.phase)) return;
      if (op.phase === "accepting") {
        releaseMessageOperation(taskId, itemId);
        return;
      }
      // R36-5：persisted 却未 transfer/settle → 明确失败终态，禁止幽灵 active
      settleMessageFailed(taskId, itemId, "flush_error");
    },
  };
};

/**
 * R35-1 / R36-5：同步原子 claim——必须在任何附件落盘 / checkpoint / send 之前调用。
 *
 * - absent → 登记 accepting，返 claimed + handle
 * - 同 id + 同 fingerprint → 返当前 active / settled（绝不再次受理）
 * - 同 id + 不同 fingerprint → payload_mismatch（409，不静默吞新内容）
 * - R36-11：terminal 已被有界淘汰后 → 视作 absent，允许同 id 新受理
 */
export const claimMessageOperation = (
  taskId: string,
  clientItemId: string,
  payloadFingerprint: string,
): ClaimMessageOperationResult => {
  if (!clientItemId) {
    // 无 id 不建 op——返回空 handle 占位（route 不应走到 claim）
    return {
      status: "claimed",
      itemId: clientItemId,
      handle: createMessageOpHandle(taskId, clientItemId),
    };
  }
  const queuedCount = activeQueuedCount(taskId);
  const ops = taskMessageOps(taskId);
  const existing = ops.get(clientItemId);

  if (existing) {
    // 旁路 settle 可能留下空 fingerprint——仅当双方都非空且不同才 mismatch
    if (
      existing.fingerprint &&
      payloadFingerprint &&
      existing.fingerprint !== payloadFingerprint
    ) {
      return { status: "payload_mismatch", itemId: clientItemId };
    }
    if (isMessageOpTerminal(existing.phase)) {
      return {
        status: "settled",
        itemId: clientItemId,
        outcome: terminalPhaseToOutcome(existing.phase)!,
        queuedCount,
      };
    }
    // 非终态只可能是 accepting | persisted（供 ClaimMessageOperationResult.active 收窄）
    const activePhase =
      existing.phase === "persisted" ? "persisted" : "accepting";
    return {
      status: "active",
      phase: activePhase,
      itemId: clientItemId,
      queuedCount,
    };
  }

  // 兼容：仅有 recentSettled、尚无 op（旧路径 / 测试直调 record）
  const settled = findRecentSettledEntry(taskId, clientItemId);
  if (settled) {
    ops.set(clientItemId, {
      itemId: clientItemId,
      fingerprint: payloadFingerprint,
      phase: settled.outcome === "delivered" ? "handedOff" : settled.outcome,
    });
    return {
      status: "settled",
      itemId: clientItemId,
      outcome: settled.outcome,
      queuedCount,
    };
  }

  // 队内 / in-flight 但无 op（未走 claim 的旧入队）→ 视作 active，补登记
  const inFlightId = inFlightItemIdsMap().get(taskId);
  const inQueue = (queues().get(taskId) ?? []).some(
    (m) => m.itemId === clientItemId,
  );
  if (inQueue || inFlightId === clientItemId) {
    ops.set(clientItemId, {
      itemId: clientItemId,
      fingerprint: payloadFingerprint,
      phase: "accepting",
    });
    return {
      status: "active",
      phase: "accepting",
      itemId: clientItemId,
      queuedCount,
    };
  }

  ops.set(clientItemId, {
    itemId: clientItemId,
    fingerprint: payloadFingerprint,
    phase: "accepting",
  });
  return {
    status: "claimed",
    itemId: clientItemId,
    handle: createMessageOpHandle(taskId, clientItemId),
  };
};

/**
 * R35-6：user_reply 落盘后推进到 persisted（非终态）。
 * 已终态则 no-op；无 op 时补登记（flush 旧条无 claim 的兜底）。
 */
export const markMessagePersisted = (taskId: string, itemId: string): void => {
  if (!itemId) return;
  const ops = taskMessageOps(taskId);
  const cur = ops.get(itemId);
  if (cur && isMessageOpTerminal(cur.phase)) return;
  ops.set(itemId, {
    itemId,
    fingerprint: cur?.fingerprint ?? "",
    phase: "persisted",
  });
};

/**
 * R35-6：agent 真正接管后 settle handedOff（ledger outcome=delivered）。
 * first-outcome-wins：已有真终态则跳过。
 */
export const settleMessageHandedOff = (
  taskId: string,
  itemId: string,
): void => {
  recordQueueItemSettled(taskId, itemId, "delivered");
};

/**
 * R35-6：明确失败终态 + ledger（queue_failed 由 failQueuedItems 统一 publish）。
 */
export const settleMessageFailed = (
  taskId: string,
  itemId: string,
  reason: FailQueuedItemsReason,
): void => {
  recordQueueItemSettled(taskId, itemId, reason);
};

/**
 * R35-1 / R36-12：受理后、persisted 前的软失败（409 停止 / 队满等）→ 释放 claim，
 * 允许同 id 重试；同步尽力回滚本批 staged 附件。
 * 已 persisted / 终态不得释放（应走 settleFailed 或 skipPersist 重排）。
 */
export const releaseMessageOperation = (
  taskId: string,
  itemId: string,
): boolean => {
  if (!itemId) return false;
  const ops = taskMessageOps(taskId);
  const cur = ops.get(itemId);
  if (!cur || cur.phase !== "accepting") return false;
  const staged = cur.stagedAttachmentPaths ?? [];
  ops.delete(itemId);
  rollbackStagedFiles(staged);
  return true;
};

/** R35-6：是否已 handedOff（重排闸门） */
export const isMessageHandedOff = (taskId: string, itemId: string): boolean => {
  const phase = taskMessageOps(taskId).get(itemId)?.phase;
  if (phase === "handedOff") return true;
  return findRecentSettledEntry(taskId, itemId)?.outcome === "delivered";
};

/** R35-6：是否已是真终态（handedOff / failed）——禁止再重排 */
export const isMessageOperationTerminal = (
  taskId: string,
  itemId: string,
): boolean => {
  const phase = taskMessageOps(taskId).get(itemId)?.phase;
  if (phase && isMessageOpTerminal(phase)) return true;
  return !!findRecentSettledEntry(taskId, itemId);
};

/**
 * R34-4 / R35-1：按 (taskId, clientItemId) 查幂等受理态（enqueue 防御 / 只读）。
 * - active：operation 非终态，或队内 / in-flight
 * - settled：真终态
 * - absent：可新鲜受理
 */
export const lookupQueueItemAcceptance = (
  taskId: string,
  itemId: string,
):
  | { status: "active"; queuedCount: number }
  | { status: "settled"; outcome: QueueItemSettleOutcome; queuedCount: number }
  | { status: "absent" } => {
  if (!itemId) return { status: "absent" };
  const queuedCount = activeQueuedCount(taskId);
  const op = taskMessageOps(taskId).get(itemId);
  if (op) {
    if (isMessageOpTerminal(op.phase)) {
      return {
        status: "settled",
        outcome: terminalPhaseToOutcome(op.phase)!,
        queuedCount,
      };
    }
    return { status: "active", queuedCount };
  }
  const inFlightId = inFlightItemIdsMap().get(taskId);
  const inQueue = (queues().get(taskId) ?? []).some((m) => m.itemId === itemId);
  if (inQueue || inFlightId === itemId) {
    return { status: "active", queuedCount };
  }
  const settled = findRecentSettledEntry(taskId, itemId);
  if (settled) {
    return {
      status: "settled",
      outcome: settled.outcome,
      queuedCount,
    };
  }
  return { status: "absent" };
};

/**
 * 纯函数：在现有列表上尝试追加（不碰 Map）。
 * 满了（已有 >= max）返 full；否则返新列表。
 * 注意：Map 侧 enqueue 另计入 in-flight（见 enqueueChatMessage）。
 */
export const tryEnqueueMsg = (
  current: QueuedChatMsg[],
  msg: QueuedChatMsgInput,
  max = CHAT_QUEUE_MAX,
): { ok: true; next: QueuedChatMsg[] } | { ok: false; reason: "full" } => {
  if (current.length >= max) return { ok: false, reason: "full" };
  return { ok: true, next: [...current, withItemId(msg)] };
};

/** 当前 task 的 in-flight 占位数（无记录返 0） */
export const getChatQueueInFlight = (taskId: string): number =>
  inFlightMap().get(taskId) ?? 0;

/**
 * flush 成功 dequeue 后占位：计入容量，直到 send 成功 / 塞回 / 作废丢弃。
 * 幂等设为 1（同 task 同时只会有一条 in-flight）。
 * R32-2：可选 itemId 一并挂上，供 queue_state bootstrap 对账。
 */
export const beginChatQueueInFlight = (
  taskId: string,
  itemId?: string,
): void => {
  inFlightMap().set(taskId, 1);
  if (itemId) inFlightItemIdsMap().set(taskId, itemId);
};

/** 清零 in-flight 占位（send 出路 / finally / clear 共用） */
export const endChatQueueInFlight = (taskId: string): void => {
  inFlightMap().delete(taskId);
  inFlightItemIdsMap().delete(taskId);
};

/** 入队；超上限返 full（调用方 409「排队已满」）。容量 = 队列长 + in-flight */
export const enqueueChatMessage = (
  taskId: string,
  msg: QueuedChatMsgInput,
): EnqueueResult => {
  const map = queues();
  const cur = map.get(taskId) ?? [];
  const inflight = getChatQueueInFlight(taskId);
  const activeCount = cur.length + inflight;

  // R34-4 / R35-1：客户端预生成 id → 先查 operation / 队内+in-flight / recentSettled
  const clientId =
    typeof msg.itemId === "string" && msg.itemId.trim()
      ? msg.itemId.trim()
      : undefined;
  if (clientId) {
    const acceptance = lookupQueueItemAcceptance(taskId, clientId);
    if (acceptance.status === "active") {
      // 已 claim 尚未入队（accepting）→ 本调用负责 append；已在队内则幂等
      const inFlightId = inFlightItemIdsMap().get(taskId);
      const alreadyInQueue =
        cur.some((m) => m.itemId === clientId) || inFlightId === clientId;
      if (alreadyInQueue) {
        return {
          ok: true,
          queuedCount: activeCount,
          itemId: clientId,
          alreadyAccepted: true,
        };
      }
      // accepting 且未入队：继续下面 append（claim 赢家的首次 enqueue）
    } else if (acceptance.status === "settled") {
      return {
        ok: false,
        reason: "already_settled",
        itemId: clientId,
        outcome: acceptance.outcome,
        queuedCount: activeCount,
      };
    }
  }

  // S4（十二轮）：in-flight 占容量，dequeue 窗口内新消息诚实 409，不靠塞回丢尾
  if (cur.length + inflight >= CHAT_QUEUE_MAX) {
    return {
      ok: false,
      reason: "full",
      queuedCount: activeCount,
    };
  }
  const result = tryEnqueueMsg(cur, msg);
  if (!result.ok) {
    return { ok: false, reason: "full", queuedCount: activeCount };
  }
  map.set(taskId, result.next);
  const itemId = result.next[result.next.length - 1]!.itemId;
  return { ok: true, queuedCount: result.next.length, itemId };
};

/** 取出队首；空队列返 null */
export const dequeueChatMessage = (taskId: string): QueuedChatMsg | null => {
  const map = queues();
  const cur = map.get(taskId);
  if (!cur || cur.length === 0) return null;
  const [head, ...rest] = cur;
  if (rest.length === 0) map.delete(taskId);
  else map.set(taskId, rest);
  return head;
};

/**
 * 塞回队首（send 失败 / run 又占上时保序）。
 * S4（十二轮）：容量已预留 in-flight，正常不会超限；若理论超限仍保留塞回
 *（旧条已 202 优先），允许短暂 MAX+1 并打 error——绝不可静默丢已接受消息。
 */
export const enqueueChatMessageFront = (
  taskId: string,
  msg: QueuedChatMsgInput,
): void => {
  const map = queues();
  const cur = map.get(taskId) ?? [];
  const next = [withItemId(msg), ...cur];
  if (next.length > CHAT_QUEUE_MAX) {
    console.error(
      `[chat-queue] task=${taskId} 塞回队首后短暂超上限（${next.length} > ${CHAT_QUEUE_MAX}）、` +
        `保留全部已接受消息（允许 MAX+1），绝不丢队尾`,
    );
  }
  map.set(taskId, next);
};

/**
 * R31-1：同步取出并清空剩余排队条目的 itemId（不含已 dequeue 的 in-flight 条）。
 * 不碰 generation / in-flight——调用方随后 clearChatQueue 统一收尾。
 */
export const takeRemainingChatQueueItemIds = (taskId: string): string[] => {
  const map = queues();
  const cur = map.get(taskId) ?? [];
  map.delete(taskId);
  return cur.map((m) => m.itemId);
};

/**
 * R32-2：只读快照——当前服务端仍「存活」的 queue itemId（队内 + in-flight）。
 * 供 watch-task bootstrap 的 queue_state；不改 generation / 不消费队列。
 */
export const listChatQueueItemIds = (taskId: string): string[] => {
  const queued = (queues().get(taskId) ?? []).map((m) => m.itemId);
  const inflightId = inFlightItemIdsMap().get(taskId);
  if (inflightId && !queued.includes(inflightId)) {
    return [inflightId, ...queued];
  }
  return queued;
};

/**
 * R32-2 / R33-1 / R35-6：唯一清队终态提交入口（QueueOperation sink）。
 *
 * 契约：
 * 1. 取出剩余队内 itemIds + in-flight（未显式传 currentItemId 时自动纳入）
 * 2. 可选 currentItemId：已 dequeue 的当前条
 *    - currentHandedOff=true → 已真正交给 agent，不进 failed（确保 delivered ledger）
 *    - 仅 persisted（有气泡未 handoff）→ 进 failed + queue_failed（R35-6：禁止当 delivered）
 *    - 兼容旧名 currentReplyPersisted：现等价于「未 handoff 仍失败」（语义已纠正）
 * 3. clear（+generation、清 in-flight）——业务路径禁止直调 clearChatQueue
 * 4. failedIds 记入 recentSettled 并纯内存 publish `queue_failed`
 * 5. 返回实际 failed 的 itemIds（供调用方写 info 文案）
 */
export const failQueuedItems = (
  taskId: string,
  options: {
    reason: FailQueuedItemsReason;
    currentItemId?: string;
    /**
     * R35-6：当前条已 handedOff（send===sent / run owner 接管）。
     * 仅此时不算 failed；「有气泡」不够。
     */
    currentHandedOff?: boolean;
    /**
     * @deprecated R35-6：旧名误把 persisted 当 delivered。
     * 仍接受以防漏改调用方，但不再豁免失败——请改用 currentHandedOff。
     */
    currentReplyPersisted?: boolean;
  },
): string[] => {
  const remaining = takeRemainingChatQueueItemIds(taskId);
  // R33-1：stop/cancelled 等旁路常不传 currentItemId——自动纳入 in-flight
  const inflightId = inFlightItemIdsMap().get(taskId);
  const currentId = options.currentItemId ?? inflightId;
  // R35-6：只有真 handoff 才豁免；persisted 旧标志不再当 delivered
  const handedOff =
    options.currentHandedOff === true ||
    (!!currentId && isMessageHandedOff(taskId, currentId));

  const failedIds: string[] = [];
  if (currentId && !handedOff) {
    failedIds.push(currentId);
  } else if (currentId && handedOff) {
    settleMessageHandedOff(taskId, currentId);
  }
  for (const id of remaining) {
    if (!failedIds.includes(id)) failedIds.push(id);
  }

  // R33-1：clear 仅允许经本 sink（内部私有语义；导出留给 DELETE/测试）
  clearChatQueue(taskId);

  for (const id of failedIds) {
    settleMessageFailed(taskId, id, options.reason);
  }
  if (failedIds.length > 0) {
    publish(taskId, {
      kind: "queue_failed",
      itemIds: failedIds,
      reason: options.reason,
    });
  }
  return failedIds;
};

/** 当前排队条数（不含 in-flight） */
export const getChatQueueCount = (taskId: string): number =>
  queues().get(taskId)?.length ?? 0;

/**
 * 当前 task 的队列 generation（无记录返 0）。
 * drain 侧：dequeue 前记下 gen，塞回前比对——变了说明中途 clear，消息已作废。
 */
export const getChatQueueGeneration = (taskId: string): number =>
  generations().get(taskId) ?? 0;

/**
 * 清空队列 + 递增 generation（不做终态 publish / 不写 ledger）。
 *
 * ⚠️ R33-1：业务清队必须走 failQueuedItems。本函数仅供：
 * - failQueuedItems 内部
 * - DELETE / rewind 门闩路径（另代理范围或已有门闩、评估清单见验收报告）
 * - 单测清理
 */
export const clearChatQueue = (taskId: string): void => {
  queues().delete(taskId);
  endChatQueueInFlight(taskId);
  const gens = generations();
  gens.set(taskId, (gens.get(taskId) ?? 0) + 1);
};

/**
 * 删任务收尾：队列 + generation + in-flight + recentSettled 一起清（复审 11 轮：
 * generations 只增不删、长跑进程积键）。必须在 clearChatQueue（作废在途 drain）
 * 且活跃 drain 退出后调用。
 */
export const cleanupChatQueueState = (taskId: string): void => {
  queues().delete(taskId);
  generations().delete(taskId);
  endChatQueueInFlight(taskId);
  recentSettledMap().delete(taskId);
  // R35-1：operation 表一并清（与 ledger 同寿命）
  messageOpsMap().delete(taskId);
};
