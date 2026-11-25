/**
 * 「哪些任务名下可能还开着电脑操作会话」的 server 侧登记。
 *
 * 为什么需要：用户点「停止」/ 删除任务时，停止钩子（browser/tools.ts 的 installBrowserStopHook）原本只在
 * 「该任务有挂起的请求」时才通知桌面壳。可电脑操作会话有大段空档——模型正在想下一步、没有任何请求在飞——
 * 而此刻电脑可能是我们解锁的、屏幕上盖着遮罩。这时点停止，钩子看到「没有挂起请求」就什么都不发，
 * 电脑会一直解着，直到空闲超时（最长 3 分钟）。有了这份登记，停止钩子就知道「这个任务可能还开着会话」，补发一次任务级 cancel，
 * 主进程当场撤遮罩、把我们解锁的电脑锁回去。
 *
 * 登记的是「可能开着」，不是「一定开着」：
 * - 开会话类的请求（截图 / 点击 / 打字 …）一发出就记（哪怕之后失败 / 超时——会话可能已经开了）；
 * - `desktop_end_session` 成功、主进程推来 `session_ended` 等「会话没了」的事件、或停止钩子发出 cancel 之后清掉；
 * - 过时（该清没清）的代价只是停止时多发一条无害的 cancel（主进程发现不是持有者就忽略）；
 *   漏登记的代价才是电脑多解几分钟——所以宁多勿少。
 *
 * 叶子模块：不 import 任何业务代码（浏览器工具要引它，反过来引会成环）。
 * 按 globalThis 单例：HMR / 多 bundle 共用一份，否则停止钩子和工具各看各的。
 */

interface OpenSessionsState {
  /** taskId → 登记序号（Map 保持插入顺序，满了丢最老的） */
  tasks: Map<string, number>;
  seq: number;
}

const KEY = "__flowshipDesktopOpenSessionsV1__";

/** 主进程同一时间只有一个会话，登记再多也只是「试过开」的任务；留个上限防止长期运行下无限增长 */
export const MAX_TRACKED_TASKS = 200;

const state = (): OpenSessionsState => {
  const g = globalThis as unknown as Record<string, OpenSessionsState | undefined>;
  if (!g[KEY]) g[KEY] = { tasks: new Map(), seq: 0 };
  return g[KEY]!;
};

/** 与 server / 主进程同口径的 taskId 形态；不合格的一律不登记（不让奇怪的 key 进表） */
const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;

/** 这个任务发出了会开电脑操作会话的请求：登记「可能开着」 */
export const markDesktopSessionOpen = (taskId: string): void => {
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return;
  const st = state();
  st.tasks.delete(taskId); // 重新登记 = 挪到最新
  st.tasks.set(taskId, ++st.seq);
  while (st.tasks.size > MAX_TRACKED_TASKS) {
    const oldest = st.tasks.keys().next().value;
    if (oldest === undefined) break;
    st.tasks.delete(oldest);
  }
};

/** 这个任务的会话已经确定没了（或我们已经通知主进程去结束它）：清掉登记 */
export const markDesktopSessionClosed = (taskId: string): void => {
  if (typeof taskId !== "string") return;
  state().tasks.delete(taskId);
};

/** 这个任务名下可能还开着电脑操作会话吗（停止钩子用） */
export const hasOpenDesktopSession = (taskId: string): boolean => typeof taskId === "string" && state().tasks.has(taskId);

/** 仅测试：清空登记 */
export const __resetDesktopOpenSessionsForTest = (): void => {
  state().tasks.clear();
  state().seq = 0;
};
