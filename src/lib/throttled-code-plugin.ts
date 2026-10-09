/**
 * 流式代码块「限频高亮」插件（包装 @streamdown/code）
 *
 * 问题（浏览器实测，CDP CPU 采样）：
 *   上游 highlight() 的缓存键含 code.length，流式增长的代码块每一帧都是新键、必然未命中，
 *   于是每帧把「整块代码」重新做一遍 TextMate 分词（Shiki → findNextMatchSync）：
 *   n 帧 × 整块长度 = 二次方。代码密集的流式回复里它占主线程非空闲时间的 ~40%（busy 86%），
 *   并伴随 200ms+ 的长任务和丢帧。结果还会无上限地塞进上游模块级 Map（内存持续上涨）。
 *
 * 做法（目标：文字依然逐帧增长、只把「上色」摊薄）：
 *   - 同一代码块的连续增长请求，用「后一次 code 以前一次为前缀」识别；
 *   - 限频窗口内**不跑 Shiki**，直接用「上一次真实高亮结果 + 新增文字（无色 token）」即时返回，
 *     成本 O(新增量)；文字照常每帧增长，只是新增部分暂时是默认前景色；
 *   - 窗口到期（trailing）对最新的完整 code 真实高亮一次，整块补色；
 *   - 窗口长度 = 上次高亮耗时 × costFactor，夹在 [min, max]：块越大、机器越慢，间隔越长，
 *     高亮占主线程的比例被钉在 1/(1+costFactor) 以内，而不是随块长度失控；
 *   - 真实高亮结果回来时若文字已经又长了，用无色 token 补齐后再交给界面——**文字永不回退**；
 *   - 短代码（< minThrottleCodeLength）完全直通，行为与上游一致。
 *
 * 不变式（测试覆盖）：
 *   I1 不丢请求：被节流的请求要么被同块更新的请求取代，要么在窗口到期时被执行；
 *   I2 文字不回退：交给界面的结果，渲染文本始终 ≥ 此前交出的任何一次；
 *   I3 终态正确：流结束、定时器与高亮都落定后，界面拿到的最后一份结果的文本等于最终 code；
 *   I4 内存有界：slot ≤ maxSlots、结果缓存 ≤ maxResults，且同一 slot 只保留最新一份中间结果。
 *
 * 只在「流式中」使用（见 markdown-text.tsx）：静态渲染仍用上游插件，命中上游缓存即时上色。
 */

import type {
  CodeHighlighterPlugin,
  HighlightOptions,
  HighlightResult,
} from "@streamdown/code";

type Callback = (result: HighlightResult) => void;
type Line = HighlightResult["tokens"][number];
type Token = Line[number];

export interface ThrottleClock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface ThrottledCodePluginOptions {
  /** 短于此长度的代码不节流（分词只要几毫秒，节流只会徒增歧义） */
  minThrottleCodeLength?: number;
  /** 窗口下限：高亮再快也不会比它更勤 */
  minIntervalMs?: number;
  /** 窗口上限：高亮再慢也保证颜色会渐进补上 */
  maxIntervalMs?: number;
  /** 窗口 = 上次高亮耗时 × 该倍数（4 ≈ 高亮最多占主线程 20%） */
  costFactor?: number;
  /** 耗时平滑系数（EWMA，0~1，越大越跟手） */
  costSmoothing?: number;
  /** 同时跟踪的代码块上限 */
  maxSlots?: number;
  /** 闲置多久回收一个 slot */
  slotTtlMs?: number;
  /** 结果缓存条数上限 */
  maxResults?: number;
  /** 单个窗口内最多缓存的回调数（超出丢最早的，它们等价于同一个 setState） */
  maxPendingCallbacks?: number;
  clock?: ThrottleClock;
}

export interface ThrottledCodePluginStats {
  /** highlight() 调用总数 */
  requests: number;
  /** 直通（短代码）次数 */
  passthrough: number;
  /** 命中本层结果缓存、同步返回 */
  cacheHits: number;
  /** 真正提交给上游去高亮的次数 */
  submitted: number;
  /** 被节流（窗口内、改用「旧色 + 无色增量」返回）的次数 */
  throttled: number;
  /** trailing 到期触发的次数 */
  flushed: number;
  /** 分叉（同前缀的另一块）导致提前落地 pending 的次数 */
  forks: number;
  /** 高亮耗时（提交→回调）累计 / 最大 / 样本数，毫秒 */
  costSumMs: number;
  costMaxMs: number;
  costCount: number;
  /** 当前存活的 slot 数 */
  slots: number;
}

export type ThrottledCodePlugin = CodeHighlighterPlugin & {
  /** 观测用：生命期累计统计的快照（只读，不清零） */
  getStats: () => ThrottledCodePluginStats;
  /**
   * 观测用：取走「自上次调用以来」的窗口增量并重置窗口（costMaxMs 是窗口内最大值，slots 是当前值）。
   * 前端流畅度上报每次决定上报时调一次。
   */
  takeStats: () => ThrottledCodePluginStats;
};

export const THROTTLED_CODE_DEFAULTS = {
  minThrottleCodeLength: 240,
  minIntervalMs: 120,
  maxIntervalMs: 1000,
  costFactor: 4,
  costSmoothing: 0.6,
  maxSlots: 16,
  slotTtlMs: 30_000,
  maxResults: 48,
  maxPendingCallbacks: 128,
} as const;

const realClock: ThrottleClock = {
  now: () =>
    typeof performance !== "undefined" ? performance.now() : Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const themeName = (t: unknown): string =>
  typeof t === "string"
    ? t
    : ((t as { name?: string } | null | undefined)?.name ?? "custom");

const themeKeyOf = (themes: HighlightOptions["themes"]): string =>
  `${themeName(themes[0])}|${themeName(themes[1])}`;

const resultKeyOf = (req: HighlightOptions): string =>
  `${req.language}\u0000${themeKeyOf(req.themes)}\u0000${req.code}`;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

/**
 * 把「prevCode 对应的高亮结果」延展成「nextCode 的结果」：
 * 前缀行原样复用（保留颜色），新增文字作为无色 token 追加。O(新增量 + 行数)。
 *
 * 要求 nextCode 以 prevCode 为前缀；否则原样返回（调用方保证，这里只做防御）。
 * 渲染出的文本恒等于 nextCode（按 \n 分行）。
 */
export const extendHighlightResult = (
  result: HighlightResult,
  prevCode: string,
  nextCode: string,
): HighlightResult => {
  if (nextCode === prevCode || !nextCode.startsWith(prevCode)) return result;

  const suffix = nextCode.slice(prevCode.length);
  const segments = suffix.split("\n");
  const tokens: Line[] = result.tokens.slice();

  // 上游对尾随换行的行数处理未必一致：按 prevCode 的行数把末尾补齐，保证「续写落在正确的行」
  const expectedLines = prevCode.split("\n").length;
  while (tokens.length < expectedLines) tokens.push([]);

  const plain = (content: string, offset: number): Token =>
    ({ content, offset }) as Token;

  let offset = prevCode.length;
  const head = segments[0] ?? "";
  if (head) {
    const lastIdx = tokens.length - 1;
    const kept = tokens[lastIdx].filter((t) => t.content !== "");
    tokens[lastIdx] = [...kept, plain(head, offset)];
  }
  offset += head.length;

  for (let i = 1; i < segments.length; i++) {
    offset += 1; // 被 split 吃掉的 "\n"
    const seg = segments[i];
    tokens.push(seg ? [plain(seg, offset)] : []);
    offset += seg.length;
  }
  return { ...result, tokens };
};

interface Slot {
  language: string;
  themeKey: string;
  /** 最近一次提交给上游的 code（同一块的增长序列都以它为前缀） */
  submitted: string;
  submittedAt: number;
  /** 最近一次收到的请求 code（含被节流的）——真实高亮回来时据此补齐，保证文字不回退 */
  latest: string;
  /** 最近一次真实高亮结果及其对应的 code */
  last?: { code: string; result: HighlightResult };
  lastResultKey?: string;
  /** 近期高亮耗时（EWMA，毫秒） */
  costMs: number;
  touchedAt: number;
  pending?: { req: HighlightOptions; cbs: Callback[] };
  timer?: unknown;
}

export const createThrottledCodePlugin = (
  base: CodeHighlighterPlugin,
  options: ThrottledCodePluginOptions = {},
): ThrottledCodePlugin => {
  const cfg = { ...THROTTLED_CODE_DEFAULTS, ...options };
  const clock = options.clock ?? realClock;

  const slots: Slot[] = [];
  /** LRU：Map 迭代序即插入序，命中时 delete+set 挪到队尾 */
  const results = new Map<string, HighlightResult>();
  const stats: ThrottledCodePluginStats = {
    requests: 0,
    passthrough: 0,
    cacheHits: 0,
    submitted: 0,
    throttled: 0,
    flushed: 0,
    forks: 0,
    costSumMs: 0,
    costMaxMs: 0,
    costCount: 0,
    slots: 0,
  };
  /** 上次 takeStats 时的累计快照 + 窗口内最大耗时 */
  let taken: ThrottledCodePluginStats = { ...stats };
  let windowCostMax = 0;

  const recall = (key: string): HighlightResult | null => {
    const hit = results.get(key);
    if (!hit) return null;
    results.delete(key);
    results.set(key, hit);
    return hit;
  };

  const store = (
    slot: Slot,
    key: string,
    code: string,
    result: HighlightResult,
  ) => {
    // 同一个 slot 的中间态没有复用价值：被新结果取代时立刻释放，缓存只留「最新一份」
    if (slot.lastResultKey && slot.lastResultKey !== key) {
      results.delete(slot.lastResultKey);
    }
    slot.lastResultKey = key;
    results.delete(key);
    results.set(key, result);
    while (results.size > cfg.maxResults) {
      const oldest = results.keys().next().value;
      if (oldest === undefined) break;
      results.delete(oldest);
    }
    slot.last = { code, result };
  };

  const intervalOf = (slot: Slot): number =>
    clamp(slot.costMs * cfg.costFactor, cfg.minIntervalMs, cfg.maxIntervalMs);

  const safeCall = (cb: Callback, result: HighlightResult) => {
    try {
      cb(result);
    } catch {
      // 界面回调出错不能拖垮高亮链路
    }
  };

  /** 把请求真正交给上游；extra = 被本次提交取代的、更早的 pending 回调 */
  const submit = (
    slot: Slot,
    req: HighlightOptions,
    callback: Callback | undefined,
    extra: Callback[] = [],
  ): HighlightResult | null => {
    stats.submitted++;
    const startedAt = clock.now();
    slot.submitted = req.code;
    slot.submittedAt = startedAt;
    const key = resultKeyOf(req);
    const cbs = callback ? [...extra, callback] : extra;

    const onDone: Callback = (result) => {
      const cost = Math.max(0, clock.now() - startedAt);
      slot.costMs =
        slot.costMs === 0
          ? cost
          : slot.costMs * (1 - cfg.costSmoothing) + cost * cfg.costSmoothing;
      stats.costSumMs += cost;
      stats.costCount++;
      if (cost > stats.costMaxMs) stats.costMaxMs = cost;
      if (cost > windowCostMax) windowCostMax = cost;
      // 上游按调用顺序回调，这里仍兜一道：若已有比本次更长的结果，旧结果不能覆盖它（文字会回退）
      const newer =
        slot.last && slot.last.code.length > req.code.length ? slot.last : null;
      if (!newer) store(slot, key, req.code, result);
      const basis = newer ?? { code: req.code, result };
      // 文字已经比这份结果更长了：补上无色增量再交出去，界面上的文字不能回退
      const out =
        slot.latest.length > basis.code.length &&
        slot.latest.startsWith(basis.code)
          ? extendHighlightResult(basis.result, basis.code, slot.latest)
          : basis.result;
      for (const f of cbs) safeCall(f, out);
    };

    let sync: HighlightResult | null = null;
    try {
      sync = base.highlight(req, onDone);
    } catch {
      return null;
    }
    if (sync) {
      // 上游缓存同步命中：它不会再回调，这里补发给被取代的 pending 回调
      store(slot, key, req.code, sync);
      for (const f of extra) safeCall(f, sync);
      return sync;
    }
    return null;
  };

  const cancelTimer = (slot: Slot) => {
    if (slot.timer !== undefined) {
      clock.clearTimer(slot.timer);
      slot.timer = undefined;
    }
  };

  const takePending = (slot: Slot): Callback[] => {
    const cbs = slot.pending?.cbs ?? [];
    slot.pending = undefined;
    return cbs;
  };

  /** 把 pending 落地（定时器到期 / 分叉 / 回收时） */
  const flush = (slot: Slot) => {
    slot.timer = undefined;
    const pending = slot.pending;
    if (!pending) return;
    slot.pending = undefined;
    stats.flushed++;
    submit(slot, pending.req, undefined, pending.cbs);
  };

  const dropSlot = (slot: Slot) => {
    cancelTimer(slot);
    if (slot.pending) flush(slot);
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
  };

  const prune = (t: number) => {
    for (const slot of slots.slice()) {
      if (!slot.pending && t - slot.touchedAt > cfg.slotTtlMs) dropSlot(slot);
    }
    while (slots.length > cfg.maxSlots) {
      // 最久没碰过的先走；有 pending 的会在 dropSlot 里先落地，不丢请求
      const oldest = slots.reduce((a, b) => (b.touchedAt < a.touchedAt ? b : a));
      dropSlot(oldest);
    }
  };

  /** 同一块 = 同语言同主题，且新 code 以 slot 上次提交的 code 为前缀；多个都符合取最长（最精确） */
  const findSlot = (
    language: string,
    themeKey: string,
    code: string,
  ): Slot | undefined => {
    let best: Slot | undefined;
    for (const s of slots) {
      if (s.language !== language || s.themeKey !== themeKey) continue;
      if (!code.startsWith(s.submitted)) continue;
      if (!best || s.submitted.length > best.submitted.length) best = s;
    }
    return best;
  };

  const addSlot = (req: HighlightOptions, t: number): Slot => {
    const slot: Slot = {
      language: req.language,
      themeKey: themeKeyOf(req.themes),
      submitted: "",
      submittedAt: 0,
      latest: req.code,
      costMs: 0,
      touchedAt: t,
    };
    slots.push(slot);
    return slot;
  };

  const highlight: CodeHighlighterPlugin["highlight"] = (req, callback) => {
    stats.requests++;
    const t = clock.now();

    const hit = recall(resultKeyOf(req));
    if (hit) {
      stats.cacheHits++;
      return hit;
    }

    if (req.code.length < cfg.minThrottleCodeLength) {
      stats.passthrough++;
      try {
        return base.highlight(req, callback);
      } catch {
        return null;
      }
    }

    prune(t);
    let slot = findSlot(req.language, themeKeyOf(req.themes), req.code);

    // 分叉：有 pending，且新请求不是它的延伸（两个块共享长前缀）——
    // 旧 pending 先落地（不丢），新请求另起一块
    if (slot?.pending && !req.code.startsWith(slot.pending.req.code)) {
      stats.forks++;
      cancelTimer(slot);
      flush(slot);
      slot = undefined;
    }

    if (!slot) {
      const fresh = addSlot(req, t);
      stats.slots = slots.length;
      return submit(fresh, req, callback);
    }

    slot.touchedAt = t;
    slot.latest = req.code;

    const dueIn = slot.submittedAt + intervalOf(slot) - t;
    if (dueIn <= 0) {
      cancelTimer(slot);
      return submit(slot, req, callback, takePending(slot));
    }

    // 窗口内：登记 trailing，立刻给出「旧色 + 无色增量」
    stats.throttled++;
    if (slot.pending) {
      slot.pending.req = req;
      if (callback) {
        slot.pending.cbs.push(callback);
        if (slot.pending.cbs.length > cfg.maxPendingCallbacks) {
          slot.pending.cbs.shift();
        }
      }
    } else {
      slot.pending = { req, cbs: callback ? [callback] : [] };
    }
    if (slot.timer === undefined) {
      const target = slot;
      slot.timer = clock.setTimer(() => flush(target), dueIn);
    }
    const last = slot.last;
    return last && req.code.startsWith(last.code)
      ? extendHighlightResult(last.result, last.code, req.code)
      : null;
  };

  return {
    name: base.name,
    type: base.type,
    supportsLanguage: (language) => base.supportsLanguage(language),
    getSupportedLanguages: () => base.getSupportedLanguages(),
    getThemes: () => base.getThemes(),
    highlight,
    getStats: () => ({ ...stats, slots: slots.length }),
    takeStats: () => {
      const cur: ThrottledCodePluginStats = { ...stats, slots: slots.length };
      const delta: ThrottledCodePluginStats = {
        requests: cur.requests - taken.requests,
        passthrough: cur.passthrough - taken.passthrough,
        cacheHits: cur.cacheHits - taken.cacheHits,
        submitted: cur.submitted - taken.submitted,
        throttled: cur.throttled - taken.throttled,
        flushed: cur.flushed - taken.flushed,
        forks: cur.forks - taken.forks,
        costSumMs: cur.costSumMs - taken.costSumMs,
        costMaxMs: windowCostMax,
        costCount: cur.costCount - taken.costCount,
        slots: cur.slots,
      };
      taken = cur;
      windowCostMax = 0;
      return delta;
    },
  };
};
