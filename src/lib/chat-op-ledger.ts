/**
 * R36-10：client MessageOperation ledger（per-task 进程内共享）
 *
 * 从 ChatView 组件 state 提升到此处：路由切换 / 卸载不丢 retry identity
 * （clientItemId + fingerprint）。terminal（task deleted）或明确 clear_all 才清。
 * 挂 globalThis 防 route-chunk / HMR 分裂。
 */

import {
  emptyChatOpState,
  type ChatOpState,
} from "@/lib/chat-pending-reconcile";

type ChatOpLedgerStore = {
  byTaskId: Map<string, ChatOpState>;
};

const GLOBAL_KEY = "__feAiFlowChatOpLedgerR36" as const;

const getStore = (): ChatOpLedgerStore => {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: ChatOpLedgerStore;
  };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { byTaskId: new Map() };
  }
  return g[GLOBAL_KEY];
};

/** R36-10：读 per-task ledger（无则空态，不写 Map） */
export const getChatOpLedger = (taskId: string): ChatOpState => {
  if (!taskId) return emptyChatOpState();
  const existing = getStore().byTaskId.get(taskId);
  if (!existing) return emptyChatOpState();
  return {
    pending: existing.pending.map((p) => ({ ...p })),
    settled: [...existing.settled],
    outcomes: { ...existing.outcomes },
  };
};

/** R36-10：写回 per-task ledger（组件 commit 后同步） */
export const setChatOpLedger = (taskId: string, state: ChatOpState): void => {
  if (!taskId) return;
  getStore().byTaskId.set(taskId, {
    pending: state.pending.map((p) => ({ ...p })),
    settled: [...state.settled],
    outcomes: { ...state.outcomes },
  });
};

/**
 * R36-10：terminal / 明确放弃时清该 task 的 ledger。
 * 切路由不得调用——否则丢 retry identity。
 */
export const clearChatOpLedger = (taskId: string): void => {
  if (!taskId) return;
  getStore().byTaskId.delete(taskId);
};

/** 测试专用：清空全部 ledger */
export const __resetChatOpLedgerForTests = (): void => {
  getStore().byTaskId.clear();
};
