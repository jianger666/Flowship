/**
 * diff 语法高亮的「结果仓」：缓存（LRU + 体积上限）+ 同 key 合并请求 + 上游无响应兜底。
 *
 * 从 `use-diff-syntax-tokens`（React hook）里抽出来，为了能脱离 React / 真 Shiki 单测：
 * 上游高亮器作为参数注入，缓存淘汰、超时、并发合并都能用假高亮器 + 假定时器直接跑。
 *
 * 三件事（2026-10-17 复审补的，原先是「按条数封顶的 FIFO + 上游失败时永远 pending」）：
 *  1. **LRU**：被用到的（hook 的 effect 每次要这份结果时 {@link DiffSyntaxStore.touch}）挪到队尾，
 *     淘汰从最久没用的开始。原先只有写入刷新、命中不刷新，等于 FIFO——反复看的那几个大 hunk 反而最先被挤掉。
 *  2. **体积上限**：除了条数（maxEntries），再按「源码字符数」合计封顶（maxChars）。单个 hunk 最大 20 万字符，
 *     光按条数封顶，300 条理论上能吃掉几十 MB token 对象。刚写入的那条永不被本次淘汰（大于总预算的单条也得放得下）。
 *  3. **超时兜底**：上游 `highlight` 失败时它自己只 `console.error`、不回调我们（实测），
 *     原先 `inflight` 里会留一个永远 pending 的 Promise。现在 timeoutMs 内没回调就按「没有结果（null）」收尾并缓存、
 *     放掉 inflight；之后上游若又回来了，迟到的结果仍然会覆盖这个 null。
 *
 * 不碰上游自己的缓存（`@streamdown/code` 内部那张表无上限也没有清理接口，聊天代码块共用）——
 * 这是已知的、不在我们手里的上限。
 */

import {
  normalizeUpstreamResult,
  toUpstreamCode,
  type DiffSyntaxToken,
  type RawHighlightToken,
} from "@/lib/diff-syntax";

/** 上游返回的结果：只用到 tokens（形状与 Shiki 的 tokens 兼容，规整见 normalizeUpstreamResult） */
export type UpstreamHighlightResult = { tokens: unknown };

/**
 * 上游高亮器的调用形态（与 `@streamdown/code` 的 `highlight` 同构）：
 * 命中上游缓存 → 同步返回结果、不再回调；否则返回 null、结果稍后走回调。
 */
export type UpstreamHighlight = (
  language: string,
  code: string,
  callback: (result: UpstreamHighlightResult | null) => void,
) => UpstreamHighlightResult | null;

export interface DiffSyntaxStoreOptions {
  highlight: UpstreamHighlight;
  /** 最多缓存多少条（默认 300） */
  maxEntries?: number;
  /** 缓存的源码字符数合计上限（默认 1_500_000） */
  maxChars?: number;
  /** 上游多久没回调就按「没有结果」收尾（默认 10s） */
  timeoutMs?: number;
}

export interface DiffSyntaxStore {
  /** 取缓存（不改变新旧顺序——渲染期 / useMemo 里调，别在那里做有副作用的事）。undefined = 没缓存；null = 缓存了「没有结果」 */
  get(language: string, code: string): DiffSyntaxToken[][] | null | undefined;
  has(language: string, code: string): boolean;
  /** 标记「刚用过」：挪到队尾，淘汰时最后才轮到它。没缓存时无操作 */
  touch(language: string, code: string): void;
  /** 请求一份高亮：已缓存 / 在飞的复用，否则发给上游。永不 reject；超时也会 resolve */
  request(language: string, code: string): Promise<void>;
  /** 仅观测（测试 / 诊断）：当前条数 / 字符数合计 */
  stats(): { entries: number; chars: number };
}

export const DIFF_SYNTAX_CACHE_MAX_ENTRIES = 300;
export const DIFF_SYNTAX_CACHE_MAX_CHARS = 1_500_000;
export const DIFF_SYNTAX_REQUEST_TIMEOUT_MS = 10_000;

const keyOf = (language: string, code: string): string =>
  `${language}\u0000${code}`;

export const createDiffSyntaxStore = (
  opts: DiffSyntaxStoreOptions,
): DiffSyntaxStore => {
  const maxEntries = opts.maxEntries ?? DIFF_SYNTAX_CACHE_MAX_ENTRIES;
  const maxChars = opts.maxChars ?? DIFF_SYNTAX_CACHE_MAX_CHARS;
  const timeoutMs = opts.timeoutMs ?? DIFF_SYNTAX_REQUEST_TIMEOUT_MS;

  /** key → 规整后的 token；null = 这份源码高亮失败 / 核对不过 / 超时（也缓存，别反复请求） */
  const cache = new Map<
    string,
    { value: DiffSyntaxToken[][] | null; chars: number }
  >();
  let totalChars = 0;
  /** 正在跑的请求（同 key 多处同时要时只发一次） */
  const inflight = new Map<string, Promise<void>>();

  const remember = (
    key: string,
    value: DiffSyntaxToken[][] | null,
    chars: number,
  ): void => {
    const prev = cache.get(key);
    if (prev) totalChars -= prev.chars;
    cache.delete(key);
    cache.set(key, { value, chars });
    totalChars += chars;
    // 从最久没用的开始淘汰；刚写的这条在队尾、且至少留它自己
    while (cache.size > 1 && (cache.size > maxEntries || totalChars > maxChars)) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      totalChars -= cache.get(oldest)!.chars;
      cache.delete(oldest);
    }
  };

  const request = (language: string, code: string): Promise<void> => {
    const key = keyOf(language, code);
    if (cache.has(key)) return Promise.resolve();
    const existing = inflight.get(key);
    if (existing) return existing;

    const p = new Promise<void>((resolve) => {
      // 先排超时、再调上游：上游同步抛 / 同步返回时 finish 会立刻清掉它
      // （timer 回调是异步触发的，此时下面的 finish 早已定义）
      const timer = setTimeout(() => finish(null), timeoutMs);
      const finish = (result: UpstreamHighlightResult | null): void => {
        clearTimeout(timer);
        let value: DiffSyntaxToken[][] | null = null;
        if (result) {
          try {
            value = normalizeUpstreamResult(
              code,
              result.tokens as RawHighlightToken[][],
            );
          } catch {
            value = null;
          }
        }
        remember(key, value, code.length);
        resolve();
      };
      try {
        // 命中上游缓存会同步返回、不再回调；否则返回 null、结果走回调
        // 喂的是「源码 + 内容指纹行」：上游缓存键只看长度 + 首尾各 100 字符，同长度的新旧两侧会撞键（详见 toUpstreamCode）
        const sync = opts.highlight(language, toUpstreamCode(code), finish);
        if (sync) finish(sync);
      } catch {
        finish(null);
      }
    }).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
  };

  return {
    get: (language, code) => cache.get(keyOf(language, code))?.value,
    has: (language, code) => cache.has(keyOf(language, code)),
    touch: (language, code) => {
      const key = keyOf(language, code);
      const hit = cache.get(key);
      if (!hit) return;
      cache.delete(key);
      cache.set(key, hit);
    },
    request,
    stats: () => ({ entries: cache.size, chars: totalChars }),
  };
};
