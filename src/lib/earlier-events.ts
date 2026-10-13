/**
 * 上拉加载更早事件：一次上拉「拉到有可见进展为止」（纯函数、不碰 React / fetch）
 *
 * ## 为什么不能「一次上拉 = 固定拉一页」（2026-10-13 用户反馈：往回滚滚着滚着就滚不动了）
 *
 * 分页按**原始事件条数**切（一页 300 条），可渲染条目（item）却是按回合折叠的：
 * 一次长任务里 AI 连续调了几百次工具、中间一句话没说，这几百条事件在 chat 里是**同一个**
 * 「工作过程」组。如果上拉拉到的一整页都是这个组的成员，prepend 之后：
 *   - 它们全并进最顶上那一条（组 id = 首成员 id，条目数没变）；
 *   - `firstItemIndex` 的递减量 = 条目数差 = 0，Virtuoso 里第一项的绝对序号不变；
 *   - Virtuoso 的 `startReached` 带 distinctUntilChanged（序号没变就不再触发）——
 *     用户停在 scrollTop = 0，往上滚没有任何东西可滚，也没有任何东西再去拉下一页。
 * 表现就是：服务端明明 `hasMore: true`，界面却「滚不动了、看不了更早的」。
 * 实测（真实 6247 条的对话，一个工作过程组有 671 条原始事件）：翻到 14 页（4200 条）后卡死。
 *
 * ## 做法
 *
 * 一次上拉保证二选一：**顶部多出至少一条可见条目**（`firstItemIndex` 一定会变、
 * `startReached` 之后一定能再触发），或者**历史已经读完**。没有进展就接着往前拉，
 * 不把「空转」的一页提交出去。条目数怎么数由调用方注入（必须与渲染管线同一函数，
 * 否则跨页合并时差值不准），本模块不关心渲染。
 *
 * 为了不让一次提交太久没反馈，单批最多拉 `maxPages` 页；没进展且还有更早的，
 * 返回 `progressed: false`，调用方先提交这一批（工作过程组的步数会涨）再接着拉。
 */

import type { TaskEvent } from "@/lib/types";

/**
 * 一页拉多少条（与服务端 DEFAULT_PAGE 对齐）。
 * 每一页都用这个数、不在「没进展」时放大：真正让条目变多的最后一页应该和普通一页一样大，
 * 一次 prepend 的条目越多，Virtuoso 补偿滚动位置那一帧的错位越大。
 */
export const EARLIER_PAGE_SIZE = 300;
/** 单批最多拉几页（没进展的话调用方会接着再来一批；防单次提交等太久 / 攒太多） */
export const EARLIER_MAX_PAGES_PER_BATCH = 8;

export interface EarlierPage {
  /** 时间正序、紧邻 before 之前的一页 */
  events: TaskEvent[];
  hasMore: boolean;
}

export interface EarlierBatch {
  /** 时间正序、已按 id 去重（对本地已有 + 本批已拉到的）；可能为空 */
  fresh: TaskEvent[];
  /** 服务端是否还有更早的 */
  hasMore: boolean;
  /**
   * 这一批是否「可以收工」：条目数变多了，或者历史已读完。
   * false = 拉了 maxPages 页仍全部并进了已有条目、且还有更早的——调用方提交后要接着拉。
   */
  progressed: boolean;
  /** 本批实际请求了几页（诊断 / 测试用） */
  pages: number;
}

export interface FetchEarlierBatchOptions {
  /** 当前本地事件（时间正序）。每页回来都会重新读：拉的过程中可能有新事件 append */
  getCurrent: () => readonly TaskEvent[];
  /** 拉 `beforeId` 之前紧邻的 limit 条 */
  fetchPage: (beforeId: string, limit: number) => Promise<EarlierPage>;
  /**
   * 事件序列 → 可渲染条目数。必须与渲染管线（items useMemo / firstItemIndex 差值）
   * 是同一个函数，否则这里判「有进展」、Virtuoso 那边序号却没变。
   */
  countItems: (events: readonly TaskEvent[]) => number;
  /** 任务已切走等：每个 await 之后检查，true 则放弃整批（返回 null） */
  isCancelled?: () => boolean;
  pageSize?: number;
  maxPages?: number;
}

/**
 * 拉一批更早的事件，直到条目数变多 / 历史读完 / 到单批页数上限。
 * 返回 null = 被取消（调用方什么都不要做）。
 * 抛错 = 某一页拉取失败（已拉到的这一批也丢弃，调用方可原样重试）。
 */
export const fetchEarlierBatch = async (
  opts: FetchEarlierBatchOptions,
): Promise<EarlierBatch | null> => {
  const {
    getCurrent,
    fetchPage,
    countItems,
    isCancelled,
    pageSize = EARLIER_PAGE_SIZE,
    maxPages = EARLIER_MAX_PAGES_PER_BATCH,
  } = opts;

  const first = getCurrent()[0];
  if (!first) return { fresh: [], hasMore: false, progressed: true, pages: 0 };

  // 已拉到的更早事件（时间正序）与下一页的游标
  let acc: TaskEvent[] = [];
  let cursor = first.id;
  let hasMore = true;
  let pages = 0;

  while (pages < maxPages) {
    const page = await fetchPage(cursor, pageSize);
    if (isCancelled?.()) return null;
    pages += 1;
    hasMore = page.hasMore;

    // 服务端说还有、却给了空页：游标推不动，继续只会空转——当作到头
    if (page.events.length === 0) {
      hasMore = false;
      break;
    }
    // 游标推到这一页最早的一条（哪怕它们全是已知的，也保证往文件前面走）
    cursor = page.events[0]!.id;

    const cur = getCurrent();
    const known = new Set<string>();
    for (const e of cur) known.add(e.id);
    for (const e of acc) known.add(e.id);
    const fresh = page.events.filter((e) => !known.has(e.id));
    if (fresh.length > 0) acc = [...fresh, ...acc];

    if (!hasMore) break;
    if (acc.length > 0 && countItems([...acc, ...cur]) > countItems(cur)) break;
  }

  const cur = getCurrent();
  const known = new Set(cur.map((e) => e.id));
  const fresh = acc.filter((e) => !known.has(e.id));
  const progressed =
    !hasMore ||
    (fresh.length > 0 && countItems([...fresh, ...cur]) > countItems(cur));
  return { fresh, hasMore, progressed, pages };
};
