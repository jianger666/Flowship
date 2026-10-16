/**
 * ask 卡片「已置态」登记表（纯内存、挂 globalThis）
 *
 * 从 ask-card-settle 拆出来的原因：card-stream 渲染整包 PUT 时也要读它
 *（已了结的 ask 不能把按钮带回来），而 ask-card-settle 反过来依赖 card-stream 的
 * element_id 工具——两边直接互相 import 会成环，所以把状态单独放一个无依赖的小模块。
 *
 * 两件事共用同一张表：
 * 1. 幂等占坑：一组 ask 只置一次态（`claimAskCardSettle` 同步占坑、中间零 await）
 * 2. 终态视图：置态时的逐题说明 / 提示行文案，流式卡整包 PUT 时按它渲染终态（无按钮）
 */

/** 终态视图：整包 PUT 时用它还原「置态后」的问题区（与 patchOneCard 的文案一致） */
export interface AskSettledView {
  /** 每题终态说明（key=questionId）；没给的题用 fallbackNote */
  noteByQuestion?: Record<string, string>;
  fallbackNote: string;
  /** 「还能怎么答」说明行换成这句 */
  hintNote: string;
}

/**
 * 登记项：占坑标记（claimed）与终态视图（view）是两件事、生命周期不同——
 * - claimed：「这组 ask 已有人在置态」。patch 一张都没成功 / 压根没有卡时**释放**（允许下一条了结链再试）
 * - view：「这组 ask 在业务上已了结」的事实。**释放占坑不清它**——否则 patch 失败 / 没有卡时，
 *   流式卡下一次整包 PUT 会拿 append 时的旧快照把按钮复活（用户能再点一次）。
 *   view 只在 {@link dropAskCardSettledView}（承载它的流式卡 finalize 之后不会再整包 PUT）/
 *   TTL 过期 / 容量上限 / 单测重置时清掉。
 */
type SettleEntry = {
  at: number;
  claimed: boolean;
  view?: AskSettledView;
  /**
   * 已经成功 patch 过终态的 cardId。给「失败后台重试」用：重试回调醒来时若这张卡已被别的链
   * （或首轮 / 先前的重试）置好，就不再盖一遍——重发既是白费一次飞书调用，也可能把后到那条链的
   * 终态文案覆盖掉。生命周期跟条目走（释放占坑 / 重新占坑都保留，条目被 TTL / 丢弃时一起消失）。
   */
  patchedCards?: Set<string>;
};

/** 登记保留时长——占坑只为「同一组 ask 别置两次态」、视图只为活着的流式卡整包 PUT，都无需长期留存 */
const SETTLE_TTL_MS = 24 * 60 * 60 * 1000;

/** 容量上限：兜底防泄漏（正常靠 finalize / TTL 清理，到不了这里）；超了从最老的开始丢 */
const SETTLE_MAX_ENTRIES = 2000;

const SETTLE_KEY = "__flowshipAskCardSettledV3__";

const getSettleMap = (): Map<string, SettleEntry> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, SettleEntry> | undefined
  >;
  if (!g[SETTLE_KEY]) g[SETTLE_KEY] = new Map();
  return g[SETTLE_KEY]!;
};

const settleKey = (taskId: string, askId: string): string =>
  `${taskId}\0${askId}`;

/** 顺手清过期 + 超容量的条目——置态是低频动作，随调随清足够，不另起定时器 */
const sweep = (m: Map<string, SettleEntry>, now: number): void => {
  for (const [k, e] of m) {
    if (now - e.at > SETTLE_TTL_MS) m.delete(k);
  }
  // Map 保持插入序：超限时丢最老的
  while (m.size > SETTLE_MAX_ENTRIES) {
    const oldest = m.keys().next();
    if (oldest.done) break;
    m.delete(oldest.value);
  }
};

/**
 * 同步原子占坑：这组 ask 的卡片还没人置过态才占上、返 true。
 * 「先占再 patch」而不是「patch 完再记」——并发两次调用第二次必然被挡。
 * 之前释放过占坑（视图还留着）的可以重新占。
 */
export const claimAskCardSettle = (taskId: string, askId: string): boolean => {
  if (!taskId || !askId) return false;
  const now = Date.now();
  const m = getSettleMap();
  sweep(m, now);
  const k = settleKey(taskId, askId);
  const cur = m.get(k);
  if (cur?.claimed) return false;
  if (cur) {
    cur.claimed = true;
    cur.at = now;
  } else {
    m.set(k, { at: now, claimed: true });
  }
  return true;
};

/**
 * 给已占上的坑补终态视图（占坑成功后立刻同步调、中间零 await）。
 * 必须早于任何 lark 往返：否则 patch 在途时恰好来一次整包 PUT，会读不到视图而把按钮带回来。
 */
export const recordAskCardSettledView = (
  taskId: string,
  askId: string,
  view: AskSettledView,
): void => {
  const e = getSettleMap().get(settleKey(taskId, askId));
  if (e) e.view = view;
};

/**
 * 一张卡都没 patch 成功时释放**占坑**——下一条了结链该允许再试。
 * 终态视图保留：这组 ask 业务上已经了结，流式卡整包 PUT 仍要渲染成无按钮的终态。
 */
export const releaseAskCardSettle = (taskId: string, askId: string): void => {
  const e = getSettleMap().get(settleKey(taskId, askId));
  if (!e) return;
  e.claimed = false;
  // 没有视图的空壳没有保留价值
  if (!e.view) getSettleMap().delete(settleKey(taskId, askId));
};

/** 记一笔：这张承载卡的终态 patch 已成功（条目不存在时静默忽略——它本来就在被清理） */
export const markAskCardPatched = (
  taskId: string,
  askId: string,
  cardId: string,
): void => {
  const e = getSettleMap().get(settleKey(taskId, askId));
  if (!e) return;
  (e.patchedCards ??= new Set()).add(cardId);
};

/** 这张承载卡的终态 patch 是否已成功过（后台重试回调据此跳过） */
export const isAskCardPatched = (
  taskId: string,
  askId: string,
  cardId: string,
): boolean =>
  getSettleMap().get(settleKey(taskId, askId))?.patchedCards?.has(cardId) ===
  true;

/** 这组 ask 的卡片已经置过终态了吗（失效分支据此跳过多余的单按钮 patch） */
export const isAskCardSettled = (taskId: string, askId: string): boolean =>
  getSettleMap().get(settleKey(taskId, askId))?.claimed === true;

/** 取终态视图；没置态（或还没补视图）返回 null。不看占坑标记——释放占坑后视图仍有效 */
export const getAskCardSettledView = (
  taskId: string,
  askId: string,
): AskSettledView | null =>
  getSettleMap().get(settleKey(taskId, askId))?.view ?? null;

/**
 * 丢掉终态视图（承载它的流式卡 finalize 之后调——此后不会再整包 PUT、视图没用了）。
 * 占坑标记不动（继续挡重复置态，靠 TTL 过期）；没占坑的空壳顺手删。
 */
export const dropAskCardSettledView = (
  taskId: string,
  askId: string,
): void => {
  const m = getSettleMap();
  const k = settleKey(taskId, askId);
  const e = m.get(k);
  if (!e) return;
  delete e.view;
  if (!e.claimed) m.delete(k);
};

/** 单测重置占坑表 */
export const __resetAskCardSettleForTest = (): void => {
  getSettleMap().clear();
};

/** 单测观察：当前登记条数（泄漏断言用） */
export const __askCardSettleSizeForTest = (): number => getSettleMap().size;
