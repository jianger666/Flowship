/**
 * 任务注意力通知的决策（纯函数；TaskAttentionWatcher 调用）
 *
 * 为什么抽出来：watcher 是 .tsx（测试不能 import），而「什么时候该叫人」是纯逻辑、有两处要改——
 *
 * 1) 静音判定：旧逻辑是 `document.hasFocus()` 为真就整体静音。
 *    - 窗口聚焦但用户在看别的会话时，后台会话（含定时唤醒的）跑完没有任何提示；
 *    - 回到 app 时 focus→refresh() 才拿到转变，此刻 hasFocus 已真，转变沿被吞。
 *    现在只有「窗口聚焦 且 正看着的就是这个任务」才静音（那种情况用户本来就盯着它）。
 * 2) 放开静音后，久不在 app 回来时一次刷出多个转变会连发多条通知：
 *    单次最多 MAX_TASK_NOTIFICATIONS_PER_PASS 条，其余折成一条「另有 N 个任务有更新」
 *    （第三轮 R11-06：恰好多 1 条时不折——折成汇总条数不减、信息反而变少，直接单独发）。
 * 3) 跨轮次节流（第三轮 R11-01）：单次对比的上限挡不住「2s 一轮、飞书桥接里各群每跑完一轮都弹」。
 *    `applyNotifyThrottle`：同一任务**同一类型**30s 内只发一次（Q8-03：ask / 回复各算各的，异常类不受限）；
 *    全局 60s 内最多 4 条，超出的并成一条汇总（每个窗口最多一条；汇总数含 plan 汇总代表的任务、被 cooldown 吞掉的任务，
 *    窗口内汇总已发后的溢出结转进下一窗口的汇总，不再静默丢）。
 * 4) 「AI 在等你回答」（第三轮 D6-01）：ask 期间 runStatus 仍是 running，只看 runStatus 转变沿会漏掉这类停摆；
 *    加 hasPendingAsk 的 false→true 转变沿（头徽标 / 侧栏 / 读屏都已用它说「待回答」，通知也要说）。
 */
import type { RunStatus } from "@/lib/types";

/** 单次（一轮列表对比）最多单独发几条；超出折成一条汇总 */
export const MAX_TASK_NOTIFICATIONS_PER_PASS = 3;

/**
 * 通知类型（Q8-03）：节流的 cooldown 按「任务 + 类型」分开计，异常类（error）不受窗口限额约束、
 * 也不会被**别的类型**的 cooldown 吞掉——否则「回复通知后 20s 内转 error」「ask 通知后 25s 内跑完」的后一条会被前一条吞掉；
 * 但同任务连续的 error（自动重连抖动）仍受同类型 cooldown 约束（第五轮）。
 * 缺省 = "reply"（旧调用方 / 测试里手写的条目行为不变）。
 */
export type TaskNotifyKind = "ask" | "reply" | "error";

export interface TaskNotifyItem {
  title: string;
  body?: string;
  taskId?: string;
  kind?: TaskNotifyKind;
  /** 汇总条代表多少个任务（planTaskNotifications 产出的汇总带它；节流把它吞掉时按真实数计入新汇总） */
  count?: number;
}

/** 从路由 pathname 取「正看着的任务 id」：只认 /tasks/<id>（chat / task 详情都在这里） */
export const activeTaskIdFromPathname = (pathname: string | null | undefined): string | null => {
  if (!pathname) return null;
  const m = /^\/tasks\/([^/?#]+)/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // 坏编码：原样当 id 用（匹配不上任何任务，等于不静音，偏向「多通知」而不是漏）
    return m[1];
  }
};

/** 窗口聚焦 且 正看着这个任务 → 静音；其余一律该通知 */
export const shouldMuteTaskNotification = (input: {
  hasFocus: boolean;
  activeTaskId: string | null;
  taskId: string;
}): boolean => input.hasFocus && input.activeTaskId !== null && input.activeTaskId === input.taskId;

interface PlanTask {
  id: string;
  title: string;
  runStatus: RunStatus;
  /** 有待答的 ask_user（TaskSummary.hasPendingAsk）；缺省 = 没有 */
  hasPendingAsk?: boolean;
}

/** 同一任务两次通知之间的最短间隔 */
export const TASK_NOTIFY_COOLDOWN_MS = 30_000;
/** 全局滑动窗口长度 */
export const TASK_NOTIFY_WINDOW_MS = 60_000;
/** 窗口内最多单独发几条 */
export const TASK_NOTIFY_WINDOW_MAX = 4;

/** 跨轮次节流的状态（放在 ref 里跨渲染保留；applyNotifyThrottle 会就地更新它） */
export interface NotifyThrottleState {
  /** cooldown 记录：key = `<taskId>|<kind>`（见 throttleKey），value = 上次发出时间 */
  lastByTask: Map<string, number>;
  /** 窗口内已发出的时间戳 */
  recent: number[];
  /** 上一次发汇总的时间（0 = 没发过） */
  summaryAt: number;
  /** 汇总已发后又溢出的任务数：结转到下一窗口开头的汇总（Q8-03②） */
  carried: number;
  /** 被 cooldown 吞掉的任务（taskId → 时间）：下一次汇总计入「另有 N 个」，但它本身不触发汇总 */
  swallowed: Map<string, number>;
}

export const createNotifyThrottle = (): NotifyThrottleState => ({
  lastByTask: new Map(),
  recent: [],
  summaryAt: 0,
  carried: 0,
  swallowed: new Map(),
});

const throttleKey = (item: TaskNotifyItem): string => `${item.taskId}|${item.kind ?? "reply"}`;

/**
 * 跨轮次节流：返回这一轮真正该发的通知，并更新 state（就地）。
 * - 同一任务**同一类型**的重复通知 TASK_NOTIFY_COOLDOWN_MS 内丢掉（用户刚被叫过一次）；
 *   不同类型各算各的；异常类（kind:"error"）不受**窗口限额**约束（需要人处理的问题不能被别的任务挤掉），
 *   但同任务的 error 抖动（error→running→error）仍按 cooldown 节流；
 * - 全局 TASK_NOTIFY_WINDOW_MS 内最多 TASK_NOTIFY_WINDOW_MAX 条，超出的并成一条「另有 N 个任务有更新」，
 *   每个窗口最多一条汇总（汇总本身不占名额，也不进 cooldown）。N = 真实未送达的任务数：
 *   被限额挡掉的条目各算 1（汇总条被挡则按它的 count 计）、被 cooldown 吞掉的任务也计入（但 cooldown 本身不触发汇总，
 *   否则飞书桥接每 2s 一轮的重复完成会不停冒汇总）；
 * - 本窗口汇总已发过后又溢出的数量结转（state.carried），在下一个窗口的第一次调用并入汇总，不再静默丢弃。
 * 汇总类条目（planTaskNotifications 产出的、不带 taskId 的）按普通条目计数。
 */
export const applyNotifyThrottle = (
  items: readonly TaskNotifyItem[],
  state: NotifyThrottleState,
  now: number,
): TaskNotifyItem[] => {
  state.recent = state.recent.filter((t) => now - t < TASK_NOTIFY_WINDOW_MS);
  for (const [id, at] of state.swallowed) {
    if (now - at >= TASK_NOTIFY_WINDOW_MS) state.swallowed.delete(id);
  }
  const out: TaskNotifyItem[] = [];
  let overflowed = 0;
  const deliveredTasks = new Set<string>();
  for (const item of items) {
    // 异常类只豁免「全局窗口限额」（需要人处理的问题不能被别的任务挤掉）；
    // 同任务同类型的 cooldown 对它也生效（第五轮 Q8-03 同族：自动重连兜底的 error→running→error 抖动，
    // 以前每转一次发一条，现在 TASK_NOTIFY_COOLDOWN_MS 内的重复被吞——key 含类型，所以「回复后 20s 内转 error」仍照发）
    const exempt = item.kind === "error" && !!item.taskId;
    if (item.taskId) {
      const last = state.lastByTask.get(throttleKey(item));
      if (last !== undefined && now - last < TASK_NOTIFY_COOLDOWN_MS) {
        state.swallowed.set(item.taskId, now);
        continue;
      }
    }
    if (!exempt && state.recent.length >= TASK_NOTIFY_WINDOW_MAX) {
      overflowed += item.taskId ? 1 : Math.max(1, item.count ?? 1);
      continue;
    }
    if (!exempt) state.recent.push(now);
    if (item.taskId) {
      // 异常类也记一笔：同任务下一次 error 在 cooldown 内会被吞（不同类型不受影响，见 throttleKey）
      state.lastByTask.set(throttleKey(item), now);
      deliveredTasks.add(item.taskId);
    }
    out.push(item);
  }
  // 清掉早已过期的 cooldown 记录，避免 Map 无界增长
  for (const [key, t] of state.lastByTask) {
    if (now - t >= TASK_NOTIFY_COOLDOWN_MS) state.lastByTask.delete(key);
  }
  const summaryAllowed = state.summaryAt === 0 || now - state.summaryAt >= TASK_NOTIFY_WINDOW_MS;
  // 结转只搭「这一轮本来就要发通知」的便车（items 为空的轮次不凭空弹汇总）
  if (summaryAllowed && (overflowed > 0 || (state.carried > 0 && items.length > 0))) {
    // 被 cooldown 吞掉、且这一轮没有以别的类型送达的任务，一并计入
    let swallowedCount = 0;
    for (const id of state.swallowed.keys()) if (!deliveredTasks.has(id)) swallowedCount += 1;
    const total = overflowed + state.carried + swallowedCount;
    state.carried = 0;
    state.swallowed.clear();
    state.summaryAt = now;
    out.push({ title: "Flowship", body: `另有 ${total} 个任务有更新` });
  } else if (overflowed > 0) {
    // 本窗口汇总已发过：不再弹，结转到下一窗口开头的汇总
    state.carried += overflowed;
  }
  return out;
};

/**
 * 对比上一轮各任务 runStatus 快照与当前列表，产出本轮该发的通知。
 * 只做「转变沿」检测：没有基线（prev=null）/ 新任务首见 / 状态没变都不通知（陈旧状态不补发）。
 */
export const planTaskNotifications = <T extends PlanTask>(input: {
  prev: ReadonlyMap<string, RunStatus> | null;
  /** 上一轮各任务 hasPendingAsk 快照；缺省 = 不检测「AI 在等你回答」转变沿 */
  prevAsk?: ReadonlyMap<string, boolean> | null;
  tasks: readonly T[];
  hasFocus: boolean;
  activeTaskId: string | null;
  /** awaiting_user 转变的正文（按 mode / 最近 action 状态给一句话，由调用方持有文案表） */
  describeBody: (task: T) => string;
}): TaskNotifyItem[] => {
  const { prev, prevAsk, tasks, hasFocus, activeTaskId, describeBody } = input;
  if (!prev) return [];

  const due: TaskNotifyItem[] = [];
  for (const task of tasks) {
    const was = prev.get(task.id);
    if (was === undefined) continue; // 新任务首见、只记录基线
    let item: TaskNotifyItem | null = null;
    if (task.hasPendingAsk === true && prevAsk && prevAsk.get(task.id) !== true) {
      // D6-01：AI 提问等人时 runStatus 仍是 running，不会有 awaiting_user 的转变沿；单独认 ask 的转变沿。
      // 与同一轮的 awaiting_user / error 转变合并成一条（以「在等你回答」为准），不重复叫人
      item = { title: task.title, body: "AI 在等你回答", taskId: task.id, kind: "ask" };
    } else if (task.runStatus === "awaiting_user" && was !== "awaiting_user") {
      item = { title: task.title, body: describeBody(task), taskId: task.id, kind: "reply" };
    } else if (task.runStatus === "error" && was !== "error") {
      // 自动重连兜底后真落到 error 的都是需要人处理的问题
      item = { title: task.title, body: "任务异常中断、点击查看", taskId: task.id, kind: "error" };
    }
    if (!item) continue;
    if (shouldMuteTaskNotification({ hasFocus, activeTaskId, taskId: task.id })) continue;
    due.push(item);
  }

  // 恰好多 1 条时不折：折成「另有 1 个」条数不减、还丢了标题与点击跳转（R11-06）
  if (due.length <= MAX_TASK_NOTIFICATIONS_PER_PASS + 1) return due;
  const head = due.slice(0, MAX_TASK_NOTIFICATIONS_PER_PASS);
  const rest = due.length - MAX_TASK_NOTIFICATIONS_PER_PASS;
  // 汇总不带 taskId：点通知只聚焦窗口，用户自己看侧栏
  // count：代表 rest 个任务——节流再把它挡掉时按真实数计入汇总（Q8-03③，不再低估成 1）
  return [...head, { title: "Flowship", body: `另有 ${rest} 个任务有更新`, count: rest }];
};
