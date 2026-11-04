/**
 * 「本轮由群里非属主触发」的按轮次标记——给 Flowship 系统工具的硬拒闸用（见 flowship-tools.invokeFlowshipTool）。
 *
 * # 为什么需要它
 * 非属主的消息并入同一个任务会话后，会话的工具集是建会话时一次性挂好的（按 callerToken），工具 handler 只认
 * callerToken + task_id，不知道「这一轮是谁触发的」。陌生人若能诱导 agent 调 `submit_work` / `ask_user` /
 * `schedule` / `share_to_group`，就能越过提示词里的口头约束（典型链：诱导 agent `ask_user` 问属主，再自己回「确认」）。
 * 所以由发起这一轮的注入链在 `agent.send` 之前登记本标记，handler 入口按 taskId 查到就拒。
 *
 * # 生命周期（宁可多清也别漏清——漏清 = 属主自己的 submit_work 被拒）
 * - `beginNonOwnerTurn`：sendToTaskSessionBody 在 `agent.send` 之前登记，返回 token；
 * - `endNonOwnerTurn(taskId, token)`：consumeSessionRun 的最外层 finally（按 token，不误清后继）；
 *   send 失败 / stale / 让位等没交给 consume 的出口由 sendToTaskSessionBody 的 finally 兜；
 * - `clearNonOwnerTurn(taskId)`：属主自己的 send 起点、会话被关、任务被停——无条件清；
 * - TTL（{@link NON_OWNER_TURN_TTL_MS}）：任何异常漏清的最后兜底，过期视为不在非属主轮。
 *   **滑动**：这一轮只要还在调工具（含白名单里的 `wait`），工具咽喉就调 {@link touchNonOwnerTurn} 续期——
 *   固定窗口会被「连调两次 30 分钟的 wait」熬过期（第 20 轮评审 N1），之后 submit_work / shell 就放行了。
 *   TTL 因此只兜「漏清后再没有任何工具调用」。
 *
 * 只记在内存（进程重启 = 会话全断、标记自然消失）；模块级单例走 globalThis，抗 HMR / 多入口重复加载。
 */

const KEY = "__flowshipNonOwnerTurnGuardV1__";

/** 兜底 TTL：一轮答疑远不会跑这么久；漏清时最多让属主的系统工具被拒这么长时间 */
export const NON_OWNER_TURN_TTL_MS = 45 * 60 * 1000;

type Marker = { token: string; startedAt: number };
type Store = { marks: Map<string, Marker>; seq: number };

const store = (): Store => {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  if (!g[KEY]) g[KEY] = { marks: new Map(), seq: 0 };
  return g[KEY]!;
};

/** 登记「本轮是非属主触发」；覆盖旧标记（同 task 同一时刻只有一轮）。返回本轮 token。 */
export const beginNonOwnerTurn = (taskId: string, now = Date.now()): string => {
  const s = store();
  s.seq += 1;
  const token = `no-${now.toString(36)}-${s.seq}`;
  s.marks.set(taskId, { token, startedAt: now });
  return token;
};

/** 按 token 收口：标记已被后继覆盖 / 已清则 no-op */
export const endNonOwnerTurn = (
  taskId: string,
  token: string | undefined,
): void => {
  if (!token) return;
  const s = store();
  if (s.marks.get(taskId)?.token === token) s.marks.delete(taskId);
};

/** 无条件清（属主的 send 起点 / 会话关闭 / 任务停止删除） */
export const clearNonOwnerTurn = (taskId: string): void => {
  store().marks.delete(taskId);
};

/** 此刻该 task 是否处在非属主触发的一轮里（过期自动视为否并顺手清掉） */
export const isNonOwnerTurnActive = (
  taskId: string | undefined,
  now = Date.now(),
): boolean => {
  if (!taskId) return false;
  const s = store();
  const m = s.marks.get(taskId);
  if (!m) return false;
  if (now - m.startedAt > NON_OWNER_TURN_TTL_MS) {
    s.marks.delete(taskId);
    return false;
  }
  return true;
};

/**
 * 续期：这一轮还在调工具（含白名单里的 wait）就把起点刷新到 now，固定 TTL 只兜「漏清后没人再调工具」。
 * 返回此刻是否仍在非属主轮（过期的视为否，并顺手清掉）。工具咽喉（invokeFlowshipTool / pi 的 execute 包装）调用；
 * {@link isNonOwnerTurnActive} 保持纯查询，不续期。
 */
export const touchNonOwnerTurn = (
  taskId: string | undefined,
  now = Date.now(),
): boolean => {
  if (!isNonOwnerTurnActive(taskId, now)) return false;
  const m = store().marks.get(taskId!);
  if (m) m.startedAt = now;
  return true;
};

/** 单测重置 */
export const __resetNonOwnerTurnGuardForTest = (): void => {
  store().marks.clear();
  store().seq = 0;
};
