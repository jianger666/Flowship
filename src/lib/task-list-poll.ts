/**
 * 任务列表轮询策略（纯函数；use-task-list 与 GET /api/tasks 共用）
 *
 * 为什么要：定时 / 服务端发起的 run（到点把空闲 chat 唤醒并跑完）在渲染进程里没有任何触发点——
 * 列表轮询原先只在「有任务在跑 || 飞书桥接开」时开，会话空闲 + 窗口失焦时：
 *  - 侧栏不会转圈；
 *  - TaskAttentionWatcher 看不到 running → awaiting_user 的转变沿，一条通知都发不出；
 *  - 回到 app 时 focus→refresh() 只拿到终态，转变沿又被「聚焦即静音」吞掉。
 *
 * 取舍（方案 A：低频兜底轮询，而不是服务端推全局帧）：
 *  - 服务端推帧要新开全局 SSE + 在各 runner 的开始 / 结束处埋点，改动面大、且会碰别人的 runner 文件；
 *  - 兜底轮询只要「服务端告诉客户端有没有 live 定时」这一个信号：`GET /api/tasks` 给相关会话打
 *    `hasLiveSchedule`（读进程内索引、不读盘），客户端据此在没有别的轮询理由时 30s 刷一次。
 *  - 没有 live 定时 = 一次都不轮询（省电策略不变）；页面不可见降到 60s（不停：最需要通知的恰恰是窗口在后台时）。
 *  - 已知盲区：整个 run 比兜底间隔还短、且会话常态就是 awaiting_user（chat 首轮之后都是）时，
 *    两次轮询看到的状态相同，没有转变沿可通知。run ≥ 兜底间隔则一定会被某次轮询撞见 running，
 *    随即切到 2s 档并在结束沿通知。
 */

/** 有任务在忙 / 飞书桥接开时的原轮询间隔（本地读 meta.json 很轻、2s 兼顾实时与开销） */
export const TASK_LIST_BUSY_POLL_MS = 2000;

/** 仅有 live 定时时的兜底间隔（页面可见） */
export const TASK_LIST_SCHEDULE_POLL_MS = 30_000;

/** 仅有 live 定时时的兜底间隔（页面不可见：降频、不停，窗口在后台正是要通知的场景） */
export const TASK_LIST_SCHEDULE_POLL_HIDDEN_MS = 60_000;

export interface TaskListPollInput {
  /** 列表里有任务在忙（主 AI 在跑 / 后台子代理在跑） */
  busy: boolean;
  /** 飞书桥接开启（服务端随时可能被飞书消息唤醒） */
  bridgeOn: boolean;
  /** 最近一次列表响应里至少有一个会话带 `hasLiveSchedule` */
  scheduleLive: boolean;
  /** 页面不可见（最小化 / 切到别的标签） */
  pageHidden: boolean;
}

export interface TaskListPollPlan {
  intervalMs: number;
  /**
   * 仅由 live 定时兜底触发的低频档：刷新时内容没变就沿用旧列表引用，不让整棵树白白重渲。
   * 2s 档保持原行为（每次都换新引用），不在这里改。
   */
  quiet: boolean;
}

/**
 * 决定列表轮询的间隔；null = 不轮询。
 * 忙 / 桥接优先且不随页面可见性变（原行为不变）；其次才是 live 定时兜底。
 */
export const pickTaskListPollPlan = (input: TaskListPollInput): TaskListPollPlan | null => {
  if (input.busy || input.bridgeOn) {
    return { intervalMs: TASK_LIST_BUSY_POLL_MS, quiet: false };
  }
  if (input.scheduleLive) {
    return {
      intervalMs: input.pageHidden
        ? TASK_LIST_SCHEDULE_POLL_HIDDEN_MS
        : TASK_LIST_SCHEDULE_POLL_MS,
      quiet: true,
    };
  }
  return null;
};

/**
 * 服务端：给「还有会触发的定时」的会话打 `hasLiveSchedule: true`。
 * 没有任何 live 会话时原数组原样返回（大多数用户没有定时：payload 不变、零分配）；
 * 命中的行才展开拷贝，其余行保持同一引用。
 */
export const markLiveScheduleTasks = <T extends { id: string }>(
  tasks: T[],
  liveTaskIds: Iterable<string>,
): T[] => {
  const live = new Set(liveTaskIds);
  if (live.size === 0) return tasks;
  let changed = false;
  const out = tasks.map((t) => {
    if (!live.has(t.id)) return t;
    changed = true;
    return { ...t, hasLiveSchedule: true };
  });
  return changed ? out : tasks;
};

/** 客户端：这份列表里有没有带 live 定时标记的会话（开兜底轮询的开关） */
export const hasLiveScheduleTask = <T extends { hasLiveSchedule?: boolean }>(
  tasks: ReadonlyArray<T>,
): boolean => tasks.some((t) => t.hasLiveSchedule === true);

/**
 * 两份列表内容是否一致（顺序敏感）。
 * 用 JSON 比较：行是服务端 JSON 反序列化来的纯数据，同一服务端键序稳定；
 * 误判「不同」只会多重渲一次，不会漏更新，所以不需要更精细的深比较。
 */
export const sameTaskList = (prev: readonly object[], next: readonly object[]): boolean => {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i] === next[i]) continue;
    if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) return false;
  }
  return true;
};

// ----------------- Q8-06：在途守卫的超时 / 世代 + 慢轮询不回滚新状态 -----------------

/** 列表请求总超时（task-store.fetchTaskList 用）：挂起的请求会自己失败，不会永久占着在途守卫 */
export const TASK_LIST_FETCH_TIMEOUT_MS = 15_000;

/**
 * 在途守卫的超时：略小于请求超时。超过它还没返回的在途轮询视为「卡住」，允许发新一轮；
 * 否则一个永不返回的请求会让 2s / 30s 档轮询永久停摆（直到窗口聚焦走 refresh()）。
 */
export const TASK_LIST_POLL_INFLIGHT_TIMEOUT_MS = 12_000;

/** 在途轮询记录：token 是世代号（旧请求结束时不得清掉新请求的记录），startedAt 供超时判定 */
export interface PollInflight {
  token: number;
  startedAt: number;
}

/** 现在能不能发新一轮轮询：没有在途的，或在途的已超时（卡住） */
export const canStartPoll = (
  inflight: PollInflight | null,
  now: number,
  timeoutMs: number = TASK_LIST_POLL_INFLIGHT_TIMEOUT_MS,
): boolean => inflight === null || now - inflight.startedAt >= timeoutMs;

/** 这一轮结束时该不该清守卫：只有它仍是「当前在途」那一轮才清（世代保护） */
export const shouldClearPollInflight = (
  inflight: PollInflight | null,
  token: number,
): boolean => inflight !== null && inflight.token === token;

/**
 * 轮询 / refresh 响应落地前与当前列表合并：同一任务若本地行的 updatedAt **严格大于**响应行，
 * 说明响应是更早发出的慢请求（SSE `upsertTask` 回灌已经把这行推进了），保留本地行，
 * 不让它回跳（侧栏状态闪回、同一次完成被通知两次）。updatedAt 相等 / 响应更新 → 取响应。
 * 没有任何行需要保留时原样返回 next（同一引用）。
 */
export const keepNewerLocalRows = <T extends { id: string; updatedAt: number }>(
  prev: readonly T[],
  next: readonly T[],
): T[] => {
  if (prev.length === 0) return next as T[];
  const prevById = new Map(prev.map((t) => [t.id, t]));
  let replaced = false;
  const merged = next.map((row) => {
    const local = prevById.get(row.id);
    if (local && local.updatedAt > row.updatedAt) {
      replaced = true;
      return local;
    }
    return row;
  });
  return replaced ? merged : (next as T[]);
};

/**
 * 慢轮询响应落地前，把「请求发出之后才在本地冒出来」的行补回（第五轮 Q8-06 同族缺口）：
 * `keepNewerLocalRows` 只在响应里**有**这一行时才比 updatedAt；刚创建的任务（`upsertTask` 即时插入、侧栏马上显示）
 * 若响应是创建之前发出的慢请求，响应里压根没有它 → 合并后这一行被抹掉，侧栏里新建的任务「闪没了」直到下一轮才回来。
 *
 * 规则：本地行不在响应里、且它最近一次被本地 upsert 的时间 ≥ 本轮请求发出时间 → 保留（放在最前，与 upsertTask 插入位置一致）。
 * 请求发出之前就在本地的行若响应里没有 = 服务端确实没有了（别处删除）→ 照旧丢掉。删除路径另有 sticky / epoch 守卫，不经过这里。
 * 没有行需要补时原样返回 next（同一引用）。
 */
export const keepRowsUpsertedDuringFetch = <T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
  upsertedAt: ReadonlyMap<string, number>,
  fetchStartedAt: number,
): T[] => {
  if (prev.length === 0 || upsertedAt.size === 0) return next as T[];
  const inNext = new Set(next.map((t) => t.id));
  const keep = prev.filter((t) => {
    if (inNext.has(t.id)) return false;
    const at = upsertedAt.get(t.id);
    return at !== undefined && at >= fetchStartedAt;
  });
  return keep.length === 0 ? (next as T[]) : [...keep, ...next];
};

/** 本地 upsert 时间表的保留期：只需覆盖「一次请求的最长在途时间」，超过的记录没用、清掉防止无界增长 */
export const UPSERT_TRACK_TTL_MS = TASK_LIST_FETCH_TIMEOUT_MS * 2;

/** 清掉过期的 upsert 记录（就地） */
export const pruneUpsertTimes = (upsertedAt: Map<string, number>, now: number): void => {
  for (const [id, at] of upsertedAt) {
    if (now - at > UPSERT_TRACK_TTL_MS) upsertedAt.delete(id);
  }
};

/**
 * 「本地 upsert 时间表 + 响应落地合并」收成一个无 React 的小对象（第六轮 P3-3：hook 里这段接线原先只有「文本包含」测试，
 * 把 `upsertedAtRef.current` 换成 `new Map()`、补回永不生效而全套测试仍绿）。
 * hook 只做两件事：`upsertTask` 里 `mark(id)`、响应落地时 `merge(prev, response, fetchStartedAt, isGone)`——
 * 序列行为（请求发出 → 本地新建 → 慢响应落地）在 tests/task-list-poll.test.ts 里用真对象测，不再依赖 hook 内部怎么传参。
 */
export interface TaskListUpsertTracker {
  /** 记一次本地 upsert（`upsertTask`：新建任务即时插入 / SSE 回灌）；顺手清掉过期记录 */
  mark(id: string, now?: number): void;
  /**
   * 慢轮询响应落地的合并：先 {@link keepNewerLocalRows}（本地更新的行不被回滚），
   * 再 {@link keepRowsUpsertedDuringFetch}（补回请求之后才本地新建、响应里没有的行）。
   * @param isGone 删除中 / 已删除 / 终态删除的 id：这些行不得被补回（与对响应行的过滤同口径，防复活）
   */
  merge<T extends { id: string; updatedAt: number }>(
    prev: readonly T[],
    response: readonly T[],
    fetchStartedAt: number,
    isGone?: (id: string) => boolean,
  ): T[];
}

export const createTaskListUpsertTracker = (): TaskListUpsertTracker => {
  const upsertedAt = new Map<string, number>();
  return {
    mark(id, now = Date.now()) {
      upsertedAt.set(id, now);
      pruneUpsertTimes(upsertedAt, now);
    },
    merge(prev, response, fetchStartedAt, isGone) {
      const newer = keepNewerLocalRows(prev, response);
      const eligible = isGone ? prev.filter((t) => !isGone(t.id)) : prev;
      return keepRowsUpsertedDuringFetch(eligible, newer, upsertedAt, fetchStartedAt);
    },
  };
};
