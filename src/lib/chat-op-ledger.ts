/**
 * R36-10 / R37-2 / R41-2 / R42-1：client MessageOperation ledger（per-task 进程内共享）
 *
 * 从 ChatView 组件 state 提升到此处：路由切换 / 卸载不丢 retry identity
 * （clientItemId + fingerprint）。terminal（task deleted）或明确 clear_all 才清。
 *
 * R37-2：唯一提交入口 `dispatchChatOp(taskId, action)`——禁止组件用 current
 * taskIdRef 给迟到 HTTP 定 owner；离屏 A 的结果只写 A ledger。
 * 挂 globalThis 防 route-chunk / HMR 分裂。
 *
 * R41-2 / R42-1 key 决策：现行 `__feAiFlowChatOpLedgerR42`；旧
 * `__feAiFlowChatOpLedgerR36` 在 getStore **每次**检查——存在则合并进现行后
 * delete。为何每次而非「仅 R42 缺失时」：HMR 后新 chunk 先任何 dispatch/get
 * 就会建空 R42；旧 chunk 残留闭包（pending fetch .then）仍可能随后写 R36——
 * 若只在 R42 缺失时迁一次，晚到的 R36 永远收不回，响应丢失窗口的 retry
 * identity 静默丢。合并保守：现行同 id 优先、legacy 独有补入；迁完即删旧
 * key，正常路径只发生一次，混跑窗口每次写入后再收割一次（幂等）。
 */

import {
  emptyChatOpState,
  projectPendingUncertain,
  reduceChatOperation,
  type ChatOpAction,
  type ChatOpReduceResult,
  type ChatOperation,
  type ChatOpState,
  type PersistenceAxis,
  type TerminalKnowledgeAxis,
} from "@/lib/chat-pending-reconcile";

type ChatOpListener = (state: ChatOpState) => void;

type ChatOpLedgerStore = {
  byTaskId: Map<string, ChatOpState>;
  /** R37-2：按 taskId 订阅；切任务后旧 listener 应已 unsubscribe */
  listeners: Map<string, Set<ChatOpListener>>;
};

/** R41-2：三轴 shape 的现行 key（与旧 R36 并存窗口只做单向迁移） */
const GLOBAL_KEY = "__feAiFlowChatOpLedgerR42" as const;
/** R36～R40 时代的 key——getStore 读到后迁完即删，防止新旧代码互污染 */
const LEGACY_GLOBAL_KEY = "__feAiFlowChatOpLedgerR36" as const;

type GlobalLedgerBag = typeof globalThis & {
  [GLOBAL_KEY]?: ChatOpLedgerStore;
  [LEGACY_GLOBAL_KEY]?: ChatOpLedgerStore;
};

/**
 * 旧一维 shape（phase / uncertainCause）→ 三轴。
 * 已是三轴的条目原样归一（缺轴补默认），重复调用幂等。
 */
const upgradePendingOp = (raw: Record<string, unknown>): ChatOperation => {
  const itemId = typeof raw.itemId === "string" ? raw.itemId : "";
  const displayText =
    typeof raw.displayText === "string"
      ? raw.displayText
      : typeof raw.text === "string"
        ? raw.text
        : "";
  const text =
    typeof raw.text === "string"
      ? raw.text
      : typeof raw.displayText === "string"
        ? raw.displayText
        : "";
  const payloadFingerprint =
    typeof raw.payloadFingerprint === "string" ? raw.payloadFingerprint : "";

  const hasNewAxes =
    raw.persistence === "sending" ||
    raw.persistence === "persisted" ||
    raw.terminalKnowledge === "none" ||
    raw.terminalKnowledge === "unknown" ||
    typeof raw.networkUncertain === "boolean";

  let persistence: PersistenceAxis;
  let terminalKnowledge: TerminalKnowledgeAxis;
  let networkUncertain: boolean;

  if (hasNewAxes) {
    // 已迁 / 现行写入：只补缺轴，不再读 phase（避免旧字段污染）
    persistence =
      raw.persistence === "persisted" ? "persisted" : "sending";
    terminalKnowledge =
      raw.terminalKnowledge === "unknown" ? "unknown" : "none";
    networkUncertain = raw.networkUncertain === true;
  } else {
    // 旧 shape：phase + uncertainCause / uncertain
    persistence = raw.phase === "persisted" ? "persisted" : "sending";
    terminalKnowledge =
      raw.uncertainCause === "unknown_terminal" ? "unknown" : "none";
    // network：显式 network cause，或旧 uncertain/phase=uncertain 且非 unknown_terminal
    networkUncertain =
      raw.uncertainCause === "network" ||
      ((raw.phase === "uncertain" || raw.uncertain === true) &&
        raw.uncertainCause !== "unknown_terminal");
  }

  const product = { persistence, terminalKnowledge, networkUncertain };
  const op: ChatOperation = {
    itemId,
    payloadFingerprint,
    displayText,
    text,
    ...product,
  };
  if (Array.isArray(raw.images)) op.images = raw.images;
  if (Array.isArray(raw.attachments)) {
    op.attachments = raw.attachments.filter(
      (a): a is string => typeof a === "string",
    );
  }
  if (Array.isArray(raw.skillRefs)) {
    op.skillRefs = raw.skillRefs as ChatOperation["skillRefs"];
  }
  if (typeof raw.id === "string") op.id = raw.id;
  // UI 投影字段：派生，不进事实源；便于旧测试读 uncertain
  (op as ChatOperation & { uncertain?: boolean }).uncertain =
    projectPendingUncertain(product);
  return op;
};

const upgradeChatOpState = (raw: ChatOpState): ChatOpState => {
  const pendingSrc = Array.isArray(raw.pending) ? raw.pending : [];
  const settledSrc = Array.isArray(raw.settled) ? raw.settled : [];
  const outcomesSrc =
    raw.outcomes && typeof raw.outcomes === "object" ? raw.outcomes : {};
  return {
    pending: pendingSrc.map((p) =>
      upgradePendingOp(p as unknown as Record<string, unknown>),
    ),
    settled: [...settledSrc],
    outcomes: { ...outcomesSrc },
  };
};

/** 幂等：把 store 内全部 task 的 pending 升到三轴（就地写回，保留 Map 引用） */
const upgradeStoreInPlace = (store: ChatOpLedgerStore): void => {
  if (!store.listeners) store.listeners = new Map();
  for (const [taskId, state] of store.byTaskId) {
    store.byTaskId.set(taskId, upgradeChatOpState(state));
  }
};

/**
 * 同一 task：现行优先、legacy 独有补入（不丢响应丢失窗口的 retry identity）。
 * - pending：同 itemId 保留现行（新代码写的更新）；legacy 独有 id 追加
 * - settled：去重合并（现行序在前，再补 legacy 独有）
 * - outcomes：现行 key 优先，再补 legacy 独有
 */
const mergeChatOpStates = (
  current: ChatOpState,
  legacy: ChatOpState,
): ChatOpState => {
  const cur = upgradeChatOpState(current);
  const leg = upgradeChatOpState(legacy);
  const currentIds = new Set(
    cur.pending.map((p) => p.itemId).filter(Boolean),
  );
  const pending = [
    ...cur.pending,
    ...leg.pending.filter((p) => p.itemId && !currentIds.has(p.itemId)),
  ];
  const settledSeen = new Set(cur.settled);
  const settled = [...cur.settled];
  for (const id of leg.settled) {
    if (!id || settledSeen.has(id)) continue;
    settledSeen.add(id);
    settled.push(id);
  }
  const outcomes = { ...leg.outcomes, ...cur.outcomes };
  return { pending, settled, outcomes };
};

/** 把 legacy listeners 并入现行（同一 Set 引用可共享，避免丢订阅） */
const mergeListenersInto = (
  current: Map<string, Set<ChatOpListener>>,
  legacy: Map<string, Set<ChatOpListener>> | undefined,
): void => {
  if (!legacy) return;
  for (const [taskId, set] of legacy) {
    let cur = current.get(taskId);
    if (!cur) {
      cur = new Set();
      current.set(taskId, cur);
    }
    for (const listener of set) cur.add(listener);
  }
};

/**
 * R42-1：每次 getStore 收割 legacy key——合并进现行后 delete。
 * 现行无该 task → 整份迁入；两边都有 → mergeChatOpStates。
 */
const harvestLegacyInto = (current: ChatOpLedgerStore): void => {
  const g = globalThis as GlobalLedgerBag;
  const legacy = g[LEGACY_GLOBAL_KEY];
  if (!legacy) return;

  for (const [taskId, legacyState] of legacy.byTaskId ?? []) {
    const existing = current.byTaskId.get(taskId);
    if (!existing) {
      current.byTaskId.set(taskId, upgradeChatOpState(legacyState));
    } else {
      current.byTaskId.set(taskId, mergeChatOpStates(existing, legacyState));
    }
  }
  mergeListenersInto(current.listeners, legacy.listeners);
  delete g[LEGACY_GLOBAL_KEY];
};

const getStore = (): ChatOpLedgerStore => {
  const g = globalThis as GlobalLedgerBag;

  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      byTaskId: new Map(),
      listeners: new Map(),
    };
  }

  upgradeStoreInPlace(g[GLOBAL_KEY]);
  // 每次检查 legacy（见模块顶 R42-1：HMR 残留闭包可晚写 R36）
  harvestLegacyInto(g[GLOBAL_KEY]);
  return g[GLOBAL_KEY];
};

const cloneState = (state: ChatOpState): ChatOpState => ({
  pending: state.pending.map((p) => ({ ...p })),
  settled: [...state.settled],
  outcomes: { ...state.outcomes },
});

/** R36-10：读 per-task ledger（无则空态，不写 Map）；入口触发 shape upgrade */
export const getChatOpLedger = (taskId: string): ChatOpState => {
  if (!taskId) return emptyChatOpState();
  const existing = getStore().byTaskId.get(taskId);
  if (!existing) return emptyChatOpState();
  // 再升一次：setChatOpLedger 绕过 getStore 写入的旧 shape 也能被纠正
  const upgraded = upgradeChatOpState(existing);
  getStore().byTaskId.set(taskId, upgraded);
  return cloneState(upgraded);
};

/**
 * R36-10：写回 per-task ledger（测试 / 迁移便利）。
 * 生产路径请走 dispatchChatOp，避免绕过订阅通知。
 */
export const setChatOpLedger = (taskId: string, state: ChatOpState): void => {
  if (!taskId) return;
  const store = getStore();
  // 写入前升级——测试若 seed 旧 shape 经 set 也能变成三轴
  const next = cloneState(upgradeChatOpState(state));
  store.byTaskId.set(taskId, next);
  const set = store.listeners.get(taskId);
  if (set) {
    for (const listener of set) listener(cloneState(next));
  }
};

/**
 * R37-2：单提交入口——显式 taskId + action，原子 reduce 写回并通知订阅者。
 * ChatView / HTTP / SSE 全部走这里，不再自己拼 refs。
 */
export const dispatchChatOp = (
  taskId: string,
  action: ChatOpAction,
): ChatOpReduceResult & { taskId: string } => {
  if (!taskId) {
    return { ...reduceChatOperation(emptyChatOpState(), action), taskId };
  }
  const prev = getChatOpLedger(taskId);
  const result = reduceChatOperation(prev, action);
  setChatOpLedger(taskId, result.state);
  return { ...result, taskId };
};

/**
 * R37-2：订阅某 task 的 ledger 变更（当前页 ChatView 用）。
 * 返回 unsubscribe；切 task 时必须解绑，避免把 A 的更新刷进 B UI。
 */
export const subscribeChatOp = (
  taskId: string,
  listener: ChatOpListener,
): (() => void) => {
  if (!taskId) return () => {};
  const store = getStore();
  let set = store.listeners.get(taskId);
  if (!set) {
    set = new Set();
    store.listeners.set(taskId, set);
  }
  set.add(listener);
  return () => {
    const cur = store.listeners.get(taskId);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) store.listeners.delete(taskId);
  };
};

/**
 * R36-10：terminal / 明确放弃时清该 task 的 ledger。
 * 切路由不得调用——否则丢 retry identity。
 */
export const clearChatOpLedger = (taskId: string): void => {
  if (!taskId) return;
  const store = getStore();
  store.byTaskId.delete(taskId);
  const set = store.listeners.get(taskId);
  if (set) {
    const empty = emptyChatOpState();
    for (const listener of set) listener(empty);
  }
};

/** 测试专用：清空全部 ledger + 订阅（含遗留 R36 key，避免用例串味） */
export const __resetChatOpLedgerForTests = (): void => {
  const g = globalThis as GlobalLedgerBag;
  if (g[GLOBAL_KEY]) {
    g[GLOBAL_KEY].byTaskId.clear();
    g[GLOBAL_KEY].listeners.clear();
  }
  if (g[LEGACY_GLOBAL_KEY]) {
    g[LEGACY_GLOBAL_KEY].byTaskId.clear();
    g[LEGACY_GLOBAL_KEY].listeners?.clear();
    delete g[LEGACY_GLOBAL_KEY];
  }
};
