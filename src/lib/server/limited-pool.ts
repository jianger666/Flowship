/**
 * 有并发上限、能按总时限「放手」的任务池（Q10-03，MR 收件箱扫描后半段用）。
 *
 * 为什么不直接 `Promise.all(items.map(...))`：
 *  - 一次发出 N 个请求：GitLab 被打满；逐 bug 拉评论还会一口气塞满 meegle 的进程级串行队列
 *    （排队时间不计超时，别的 meegle 操作全被堵在后面）；
 *  - 不看总时限：`Promise.all` 要等最慢的那个，扫描总时限形同虚设，partial 永远是 false。
 *
 * 行为：
 *  - 同一时刻最多 `limit` 个 worker 在跑（lane 模型：每条 lane 做完一个再领下一个）；
 *  - 每次领新任务前问 `guard.shouldStop()`，返回 true 就不再领——队里没轮到的任务不会发出任何请求；
 *  - `guard.deadlineAt` 到点时不再等在途任务：带着已完成的部分直接返回，并调一次 `onAbandon`。
 *    在途任务不会被取消（fetch / meegle 子进程没有取消接口），自行跑完、结果丢弃——最多 `limit` 个。
 *
 * 返回与入参等长的槽数组：`{ value }` = 跑完；`undefined` = 没跑完（没领到 / 到点放手时还在途）。
 * 用槽而不是裸值：worker 自己也可能返回 undefined，哨兵不能和结果混。
 * worker 不应抛错（调用方自己 try/catch）；抛了就整体 reject（与 Promise.all 一致）。
 */

export interface PoolGuard {
  /** 每次领新任务前问一次：返回 true = 不再领（调用方在这里把「超时」记进失败） */
  shouldStop: () => boolean;
  /** 绝对时间（ms）：到点后不再等在途任务，直接带着已完成的部分返回 */
  deadlineAt: number;
  /** 到点放手时调一次——只有「定时器先到、在途任务还没跑完」才会走到；任务自己先跑完不会调 */
  onAbandon: () => void;
}

/** 池结果槽：`undefined` = 这一项没跑完（没领到 / 到点放手时还在途） */
export type PoolSlot<R> = { value: R } | undefined;

export const runWithLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  guard?: PoolGuard,
): Promise<Array<PoolSlot<R>>> => {
  if (items.length === 0) return [];

  const results: Array<PoolSlot<R>> = new Array<PoolSlot<R>>(items.length).fill(
    undefined,
  );
  let next = 0;
  let abandoned = false;
  const lane = async (): Promise<void> => {
    for (;;) {
      if (abandoned || guard?.shouldStop()) return;
      // next++ 与上面的判断之间没有 await：单线程下各 lane 不会领到同一项
      const index = next++;
      if (index >= items.length) return;
      results[index] = { value: await worker(items[index] as T) };
    }
  };

  // 上限夹到 [1, items.length]：0 / 负数 / NaN 当 1，不会因为传错值把整个池卡死
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const done = Promise.all(Array.from({ length: width }, () => lane())).then(
    () => "done" as const,
  );

  if (!guard) {
    await done;
    return results;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(
      () => resolve("expired"),
      Math.max(0, guard.deadlineAt - Date.now()),
    );
  });
  try {
    if ((await Promise.race([done, expired])) === "expired") {
      // 先挂标志再通知：放手后在途 lane 跑完手上这一个也不会再领新任务（不依赖调用方的 shouldStop 是「粘」的）
      abandoned = true;
      guard.onAbandon();
    }
  } finally {
    clearTimeout(timer);
  }
  // 返回快照：放手之后在途 worker 还会往 results 写，不能让它改到调用方手里的结果
  return results.slice();
};
