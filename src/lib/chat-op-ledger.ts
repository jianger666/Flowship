/**
 * R36-10 / R37-2：client MessageOperation ledger（per-task 进程内共享）
 *
 * 从 ChatView 组件 state 提升到此处：路由切换 / 卸载不丢 retry identity
 * （clientItemId + fingerprint）。terminal（task deleted）或明确 clear_all 才清。
 *
 * R37-2：唯一提交入口 `dispatchChatOp(taskId, action)`——禁止组件用 current
 * taskIdRef 给迟到 HTTP 定 owner；离屏 A 的结果只写 A ledger。
 * 挂 globalThis 防 route-chunk / HMR 分裂。
 */

import {
  emptyChatOpState,
  reduceChatOperation,
  type ChatOpAction,
  type ChatOpReduceResult,
  type ChatOpState,
} from "@/lib/chat-pending-reconcile";

type ChatOpListener = (state: ChatOpState) => void;

type ChatOpLedgerStore = {
  byTaskId: Map<string, ChatOpState>;
  /** R37-2：按 taskId 订阅；切任务后旧 listener 应已 unsubscribe */
  listeners: Map<string, Set<ChatOpListener>>;
};

const GLOBAL_KEY = "__feAiFlowChatOpLedgerR36" as const;

const getStore = (): ChatOpLedgerStore => {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: ChatOpLedgerStore;
  };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      byTaskId: new Map(),
      listeners: new Map(),
    };
  } else if (!g[GLOBAL_KEY].listeners) {
    // HMR 热更旧 shape → 补 listeners
    g[GLOBAL_KEY].listeners = new Map();
  }
  return g[GLOBAL_KEY];
};

const cloneState = (state: ChatOpState): ChatOpState => ({
  pending: state.pending.map((p) => ({ ...p })),
  settled: [...state.settled],
  outcomes: { ...state.outcomes },
});

/** R36-10：读 per-task ledger（无则空态，不写 Map） */
export const getChatOpLedger = (taskId: string): ChatOpState => {
  if (!taskId) return emptyChatOpState();
  const existing = getStore().byTaskId.get(taskId);
  if (!existing) return emptyChatOpState();
  return cloneState(existing);
};

/**
 * R36-10：写回 per-task ledger（测试 / 迁移便利）。
 * 生产路径请走 dispatchChatOp，避免绕过订阅通知。
 */
export const setChatOpLedger = (taskId: string, state: ChatOpState): void => {
  if (!taskId) return;
  const store = getStore();
  const next = cloneState(state);
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

/** 测试专用：清空全部 ledger + 订阅 */
export const __resetChatOpLedgerForTests = (): void => {
  const store = getStore();
  store.byTaskId.clear();
  store.listeners.clear();
};
