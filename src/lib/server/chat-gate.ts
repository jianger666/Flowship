/**
 * Chat per-task 破坏性操作门闩 + 新会话启动占位（进程内原子状态）
 *
 * 解决两类竞态：
 *
 * 1. rewind（破坏性恢复仓库文件）与 chat-reply 启动新 run 并发：
 *    rewind 先 `tryBeginChatRewind` 占门闩，再复查「无运行中 / 无启动占位」；
 *    chat-reply 的 send / 起新会话在最后一个同步点检查门闩、被占则拒绝或入队。
 *
 * 2. 无会话时并发两条首消息：两个请求都过 `hasChatSession()===false` 检查后
 *    各自 fire `runChatSession`，后到的被幂等 early-return 静默吞掉。
 *    改为路由在决定起新会话前 `tryReserveChatStart` 同步占位（Node 单线程、
 *    check-and-set 原子），失败方转入队。
 *
 * 启动预约改为可取消 lease（token + cancelled）。
 * stop/DELETE 在 checkpoint 长窗口内到达时 `cancelChatStart` 标取消，
 * owner 在每个 await 后用 `isChatStartLeaseValid` 发现并中止，避免为已删任务
 * 落 user_reply / 置 running / 起 SDK agent。
 *
 * stop/DELETE 收尾有多段 await，仅 cancel 一次不够——cancelled
 * lease 曾允许立刻被新请求覆盖并起新 Agent。增加 per-task lifecycle
 *（stopping / deleting）：进行中一律拒绝 tryReserve / 使 lease 失效；
 * stop 完成后才放开「立刻重发」。
 *
 * finalize 也占 lifecycle（finalizing）——与 stopping 同级、deleting 可从二者升级；
 * 终结窗口内 isOpOwner 全 false，新 advance 不得合法 claim。
 *
 * reopen 原子占 `reopening`——与 finalizing/deleting/stopping 互斥；
 * DELETE 已占 deleting 时 reopen begin 失败 → 409（关并发穿越写 developing）。
 *
 * 状态挂 globalThis：Next dev 多 chunk 下纯模块级 Map 会分裂（同 chat-queue）。
 * 纯同步、无 IO——调用方必须在「检查 → 动作」之间不让出事件循环，才有原子性。
 */

interface StartLease {
  token: number;
  cancelled: boolean;
}

/**
 * stop / DELETE / finalize / reopen 收尾窗口的生命周期相位。
 * 优先级：deleting > stopping = finalizing = reopening
 * （后三者互不覆盖；deleting 可从 stopping/finalizing/reopening 升级）。
 */
export type ChatLifecyclePhase =
  | "stopping"
  | "deleting"
  | "finalizing"
  | "reopening";

interface ChatGateGlobalState {
  /** rewind 进行中的 taskId */
  rewinding: Set<string>;
  /**
   * 已决定起新会话、runChatSession 尚未注册进 runningChats 的 lease。
   * token 进程内单调递增；cancelled 由 stop/DELETE 置位，owner 负责 release。
   */
  startReservations: Map<string, StartLease>;
  /** 下一枚启动预约 token（模块级单调） */
  nextStartToken: number;
  /**
   * stop / DELETE / finalize / reopen 收尾进行中——此窗口内禁止覆盖 cancelled lease、禁止新预约。
   * deleting 优先于 stopping / finalizing / reopening（可升级、不可降级）。
   */
  lifecycle: Map<string, ChatLifecyclePhase>;
}

// V5：加 reopening；换 key 防 hot-reload 读到不知 reopening 的旧 V4 state
const CHAT_GATE_GLOBAL_KEY = "__flowshipChatGateV5__";

const getState = (): ChatGateGlobalState => {
  const g = globalThis as unknown as Record<
    string,
    ChatGateGlobalState | undefined
  >;
  if (!g[CHAT_GATE_GLOBAL_KEY]) {
    g[CHAT_GATE_GLOBAL_KEY] = {
      rewinding: new Set(),
      startReservations: new Map(),
      nextStartToken: 1,
      lifecycle: new Map(),
    };
  }
  const state = g[CHAT_GATE_GLOBAL_KEY]!;
  // hot-reload 兜底：旧 chunk 可能写出缺字段的半残 state
  if (!state.rewinding) state.rewinding = new Set();
  if (!state.startReservations) state.startReservations = new Map();
  if (typeof state.nextStartToken !== "number") state.nextStartToken = 1;
  if (!state.lifecycle) state.lifecycle = new Map();
  return state;
};

// ----------------- rewind 门闩 -----------------

/** rewind 开始前占门闩；已被占（并发 rewind）→ false */
export const tryBeginChatRewind = (taskId: string): boolean => {
  const s = getState();
  if (s.rewinding.has(taskId)) return false;
  s.rewinding.add(taskId);
  return true;
};

/** rewind 结束（成功 / 失败都必须调、finally 里） */
export const endChatRewind = (taskId: string): void => {
  getState().rewinding.delete(taskId);
};

export const isChatRewindInProgress = (taskId: string): boolean =>
  getState().rewinding.has(taskId);

// ----------------- stop / DELETE / finalize 生命周期 -----------------
//
// lifecycle 是 task-wide 操作门——不止 chat-reply，task 模式的
// /advance、/question、/ask-reply 与 internalStartAgent / sendToTaskSession
// 也在关键点读 getChatLifecycle；进行中一律拒绝新启动/作废 pendingStop。
// finalizing 与 stopping 同级——finalize 期间新 advance 的 isOpOwner 失败。

/**
 * 进入 stop / DELETE / finalize / reopen 收尾窗口。
 *
 * 语义：
 * - 无相位 → 写入 phase、返 true（调用方拥有、负责 end）
 * - 同 phase 重入 → 返 false（勿 end，避免清掉进行中的同相位 owner）
 * - 已是 deleting → begin 任何相位返 false（deleting 优先、不可降级；reopen 一律 409）
 * - 已是 stopping / finalizing / reopening → begin("deleting") 升级并返 true；
 *   begin("stopping"|"finalizing"|"reopening") 在其它同级相位时返 false（互不覆盖）
 */
export const beginChatLifecycle = (
  taskId: string,
  phase: ChatLifecyclePhase,
): boolean => {
  const s = getState();
  const current = s.lifecycle.get(taskId);
  if (!current) {
    s.lifecycle.set(taskId, phase);
    return true;
  }
  if (current === phase) return false;
  // deleting 优先：不可被 stopping / finalizing / reopening 覆盖
  if (current === "deleting") return false;
  // stopping / finalizing / reopening → deleting 可升级（DELETE 在收尾窗口到达）
  if (
    (current === "stopping" ||
      current === "finalizing" ||
      current === "reopening") &&
    phase === "deleting"
  ) {
    s.lifecycle.set(taskId, phase);
    return true;
  }
  // stopping ↔ finalizing ↔ reopening 同级：互不覆盖
  return false;
};

/**
 * 退出生命周期窗口。
 * @param phase 若传入，仅当当前相位仍是该值时才清——防止 stop finally 误清
 *   已被升级成 deleting 的条目。
 */
export const endChatLifecycle = (
  taskId: string,
  phase?: ChatLifecyclePhase,
): void => {
  const s = getState();
  const current = s.lifecycle.get(taskId);
  if (!current) return;
  if (phase !== undefined && current !== phase) return;
  s.lifecycle.delete(taskId);
};

export const getChatLifecycle = (
  taskId: string,
): ChatLifecyclePhase | null => getState().lifecycle.get(taskId) ?? null;

// ----------------- 新会话启动占位（可取消 lease） -----------------

/**
 * 同步占「起新会话」lease。rewind / lifecycle 进行中 / 已有未取消占位 → null。
 * 成功返回 token；runChatSession 注册进 runningChats 时（或启动失败时）必须
 * `releaseChatStart(taskId, token)`。
 *
 * 已取消（cancelled）的旧 lease：仅在无 lifecycle 时允许新请求覆盖——
 * 允许 stop **完成**后立刻重发；stop/DELETE 收尾 await 期间由 lifecycle 挡住，
 * 避免「停止成功但新 Agent 已起」。
 */
export const tryReserveChatStart = (taskId: string): number | null => {
  const s = getState();
  if (s.rewinding.has(taskId)) return null;
  // stopping/deleting/finalizing/reopening 收尾窗口内禁止新预约（含覆盖 cancelled）
  if (s.lifecycle.has(taskId)) return null;
  const existing = s.startReservations.get(taskId);
  if (existing && !existing.cancelled) return null;
  const token = s.nextStartToken++;
  s.startReservations.set(taskId, { token, cancelled: false });
  return token;
};

/**
 * owner 正常释放 lease。带 token 时仅匹配才删（防误清新 owner 的预约）；
 * 不带 token 时无条件删（resume finally 等兼容路径）。
 */
export const releaseChatStart = (taskId: string, token?: number): void => {
  const s = getState();
  const lease = s.startReservations.get(taskId);
  if (!lease) return;
  if (token !== undefined && lease.token !== token) return;
  s.startReservations.delete(taskId);
};

/**
 * stop / DELETE：撤销进行中的启动预约。
 * 标 cancelled=true、保留条目让 hasChatStartReservation 仍为真（rewind 交叉闭合），
 * 由 owner 在 await 间隙发现后 `releaseChatStart` 自清。
 * 覆盖 cancelled 条目须等 lifecycle 结束（见 tryReserveChatStart）；lifecycle
 * 进行中新请求一律拿不到 token。
 * 选用「标取消留键」而非直接删：实现简单、owner 路径统一用 isChatStartLeaseValid，
 * 且 cancelled 僵尸可被 re-reserve / clearChatGate 清掉，不易长期泄漏。
 */
export const cancelChatStart = (taskId: string): void => {
  const lease = getState().startReservations.get(taskId);
  if (!lease) return;
  lease.cancelled = true;
};

/**
 * owner 在每个 await 后复查：条目存在、token 匹配、未被 cancel、且无 lifecycle。
 * lifecycle 进行中一律 false——owner 在 stop/DELETE 收尾 await 后复查即失效。
 */
export const isChatStartLeaseValid = (
  taskId: string,
  token: number,
): boolean => {
  const s = getState();
  if (s.lifecycle.has(taskId)) return false;
  const lease = s.startReservations.get(taskId);
  return !!lease && lease.token === token && !lease.cancelled;
};

export const hasChatStartReservation = (taskId: string): boolean =>
  getState().startReservations.has(taskId);

/**
 * 测试 / 删任务收尾用：清某 task 的全部门闩状态（含 lifecycle）。
 * 只能在确认 rewind 已退出、所有 owner 已终止后调用——DELETE 须先等待
 * rewind 结束，再 clear（否则会替仍在跑的 rewind「释放」门闩，见）。
 */
export const clearChatGate = (taskId: string): void => {
  const s = getState();
  s.rewinding.delete(taskId);
  s.startReservations.delete(taskId);
  s.lifecycle.delete(taskId);
};
