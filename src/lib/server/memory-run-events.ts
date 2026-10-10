/**
 * SDK JSONL store 的 run_events 子 store：内存实现。
 *
 * 背景（2026-10-10 实测）：`@cursor/sdk` 1.0.37 的本地运行时把 run 的**每一条**流式消息（每个
 * thinking 片段、每个文本片段、每次工具更新）都 `await runEvents.append(...)`，而 `run.stream()`
 * 又经 `runEvents.list(...)` 从存储里读回来——也就是说 run_events 存储就是进程内「生产者 → 消费者」
 * 的传输通道，吐字的每一步都要过它。SDK 自带 JSONL 实现的 append / list 每次都把
 * `run_events.ndjson` 整份读进内存、逐行 JSON.parse（append 还要整文件重写，且和所有 store 操作共用
 * 一条全局串行队列），代价 O(文件大小)：
 *   - 18.5MB / 35,925 条记录时，append 平均 243ms、100% 占满一个核、事件循环阻塞 p99 187ms；
 *     串行吞吐上限约 4 条/秒——吐字被钉死在个位数事件/秒，server 主线程常年 85%~110%；
 *   - 文件只增不减（每个长 run 约 +5MB / 1 万条），所以是「越用越卡」的定时炸弹；
 *   - 头注释里 sdk-agent-store.ts 曾写「其余三份小文件仍用 SDK 自带实现」——run_events 并不小，
 *     sdk-store-gc.ts 里「run_events 几乎不写」的实测也已被证伪（近 24h 写入 3.5 万条）。
 *
 * 为什么可以不落盘：Flowship 从不读历史 run 的事件（没有 getRun / listRuns / conversation 调用，
 * 三处 run 入口都是 `for await (run.stream())` + `run.wait()`），会话跨进程恢复走自己的
 * events.jsonl；SDK 的 resume / 追加 run 只看 agents + runs 两张表（activeRunId + 状态），不看事件。
 * run 本身跑在本进程里，进程没了 run 也没了——持久化这些事件对 Flowship 没有任何读者。
 *
 * 做法：只替换 runEvents 这一层，经 SDK 公开 API `composeLocalAgentStore` 组合；agents / runs /
 * checkpoints 不动。append / list 都是内存操作，O(1) / O(返回条数)。
 *
 * 不变式（review 时请逐条核对）：
 *   1. 语义与 SDK `JsonlLocalAgentStore.runEvents` 逐项一致：seq 从 1 递增、offset = String(seq)、
 *      list 的 afterOffset 是「严格大于」、limit 缺省 100、nextOffset 仅在「还有更多」时给出、
 *      幂等键命中返回已有记录、delete 空 runIds = 全删。tests/memory-run-events.test.ts 用真 SDK
 *      做随机差分对照。
 *   2. 所有方法体内**没有 await**：调用顺序 = 生效顺序（等价于 SDK 实现里那条全局串行队列），
 *      调用方不 await 也能立刻在下一个 list 里读到。同步抛错（如 payload 含 BigInt）仍表现为 reject。
 *   3. 内存回收只丢「list 已经返回过」的事件（`returnedUpTo`）：run 闲置 trimIdleMs（5 分钟）后丢掉已读
 *      前缀，从未被读走的事件不会因闲置被丢（唯一例外是 ghostIdleMs=6 小时没有任何追加的「幽灵 run」，
 *      防止从来没人读的 run 永久占内存）。
 *   4. `nextSeq` 永不回退（只有 delete 会清）：事件被丢后同一个 run 继续追加，序号接着排，
 *      消费者手里的 afterOffset 依然有效——长时间等用户回答（工具阻塞）之后续写不会断流。
 *   5. 无定时器、无 IO、无全局状态：清扫在 append / list 里顺带做（按时间节流），时钟可注入。
 *   6. payload 在 append 时序列化成 JSON 字符串存（和落盘实现一样与调用方后续的修改隔离，
 *      也比对象图省内存），list 时才 parse 被返回的那几条。
 */
import type {
  LocalAgentRunEventDocument,
  LocalAgentRunEventFilter,
  LocalAgentRunEventListResult,
  LocalAgentStoreRunEvents,
} from "@cursor/sdk";

/** SDK 实现的 list 默认页大小 */
const DEFAULT_LIST_LIMIT = 100;
/** 已读事件闲置多久后从内存丢掉（run 仍可继续追加，序号不回退） */
const DEFAULT_TRIM_IDLE_MS = 5 * 60_000;
/** 幽灵 run 兜底：这么久没有任何追加 / 读取，整份事件都丢（连没读过的） */
const DEFAULT_GHOST_IDLE_MS = 6 * 3_600_000;
/** 清扫节流：最多每隔这么久扫一遍 */
const DEFAULT_SWEEP_EVERY_MS = 30_000;

export interface MemoryRunEventsOptions {
  /** 时钟（单测注入）；默认 Date.now */
  now?: () => number;
  trimIdleMs?: number;
  ghostIdleMs?: number;
  sweepEveryMs?: number;
}

export interface MemoryRunEventsStats {
  /** 见过的 run 数（含已被清空事件、只剩序号的） */
  runs: number;
  /** 当前还留在内存里的事件条数 */
  retainedEvents: number;
  /** 当前还留在内存里的 payload JSON 总字符数（≈ 内存占用的下界；UTF-16 字符串实际约 ×2） */
  retainedChars: number;
  /** 进程内累计被回收的事件条数 */
  trimmedEvents: number;
}

export interface MemoryRunStats {
  /** 这个 run 累计追加过多少条事件（delete 后清零） */
  appended: number;
  /** 其中还留在内存里的 */
  retained: number;
}

interface StoredEvent {
  readonly seq: number;
  readonly eventType: string;
  readonly payloadJson: string;
  readonly payloadRef: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: number;
}

interface RunBuffer {
  /** 下一条事件的 seq（≥ 1，永不回退） */
  nextSeq: number;
  /** events[0] 的 seq；events 为空时恒等于 nextSeq */
  baseSeq: number;
  events: StoredEvent[];
  /** events 里 payload JSON 的总字符数 */
  chars: number;
  /** list 返回过的最大 seq（0 = 从没返回过）；只有 ≤ 它的事件允许被回收 */
  returnedUpTo: number;
  /** 幂等键 → 事件；只有用过幂等键的 run 才有（SDK 本地运行时不传，兼容契约用） */
  idem: Map<string, StoredEvent> | null;
  /** 最近一次「有实际内容」的活动（追加 / 返回了事件 / 新建）；空轮询不算 */
  touchedAt: number;
}

const toDoc = (
  runId: string,
  e: StoredEvent,
  payload?: unknown,
): LocalAgentRunEventDocument => ({
  runId,
  seq: e.seq,
  offset: String(e.seq),
  eventType: e.eventType,
  payload: payload !== undefined ? payload : JSON.parse(e.payloadJson),
  payloadRef: e.payloadRef,
  idempotencyKey: e.idempotencyKey,
  createdAt: e.createdAt,
});

export class MemoryRunEvents implements LocalAgentStoreRunEvents {
  private readonly buffers = new Map<string, RunBuffer>();
  private readonly now: () => number;
  private readonly trimIdleMs: number;
  private readonly ghostIdleMs: number;
  private readonly sweepEveryMs: number;
  private lastSweepAt: number;
  private trimmedTotal = 0;

  constructor(opts: MemoryRunEventsOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.trimIdleMs = opts.trimIdleMs ?? DEFAULT_TRIM_IDLE_MS;
    this.ghostIdleMs = opts.ghostIdleMs ?? DEFAULT_GHOST_IDLE_MS;
    this.sweepEveryMs = opts.sweepEveryMs ?? DEFAULT_SWEEP_EVERY_MS;
    this.lastSweepAt = this.now();
  }

  async append(input: {
    readonly runId: string;
    readonly eventType: string;
    readonly payload?: unknown;
    readonly payloadRef?: string | null;
    readonly idempotencyKey?: string | null;
  }): Promise<LocalAgentRunEventDocument> {
    const now = this.now();
    const buf = this.buffers.get(input.runId);

    // 幂等键命中 → 返回已有记录（与 SDK 实现一致：只在传了键时才查）
    if (input.idempotencyKey) {
      const hit = buf?.idem?.get(input.idempotencyKey);
      if (hit) return toDoc(input.runId, hit);
    }

    // 先序列化再动状态：payload 不可序列化（循环引用 / BigInt）时整个 append 失败、不留半截状态
    const payloadJson = JSON.stringify(input.payload ?? null) ?? "null";

    let target = buf;
    if (!target) {
      target = {
        nextSeq: 1,
        baseSeq: 1,
        events: [],
        chars: 0,
        returnedUpTo: 0,
        idem: null,
        touchedAt: now,
      };
      this.buffers.set(input.runId, target);
    }

    const ev: StoredEvent = {
      seq: target.nextSeq,
      eventType: input.eventType,
      payloadJson,
      payloadRef: input.payloadRef ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
    };
    target.nextSeq += 1;
    // 不变式「events 为空时 baseSeq === nextSeq」由 dropFirst 维持，这里无需再对齐
    target.events.push(ev);
    target.chars += payloadJson.length;
    if (ev.idempotencyKey) (target.idem ??= new Map()).set(ev.idempotencyKey, ev);
    target.touchedAt = now;

    this.sweep(now);
    // 与 SDK 实现一致：返回里的 payload 是调用方传入的那个对象（不是 parse 出来的副本）
    return toDoc(input.runId, ev, input.payload ?? null);
  }

  async list(input: {
    readonly runId: string;
    readonly afterOffset?: string | null;
    readonly limit?: number;
  }): Promise<LocalAgentRunEventListResult> {
    const buf = this.buffers.get(input.runId);
    if (!buf) return { items: [] };

    // 与 SDK 实现同一口径：parseInt；解析不出数字 = 「seq > NaN」恒假 = 什么都不返回
    const after = Number.parseInt(input.afterOffset ?? "0", 10);
    if (Number.isNaN(after)) return { items: [] };

    // events 里第一条 seq > after 的下标
    const startIdx = Math.max(0, after + 1 - buf.baseSeq);
    const total = Math.max(0, buf.events.length - startIdx);

    // 与 `Array.prototype.slice(0, limit)` 同语义（含 0 / 负数 / 小数 / NaN）
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    const n = Number.isNaN(limit) ? 0 : Math.trunc(limit);
    const take = n >= 0 ? Math.min(total, n) : Math.max(0, total + n);

    if (take === 0) return { items: [] };

    const items: LocalAgentRunEventDocument[] = new Array(take);
    for (let i = 0; i < take; i += 1) {
      items[i] = toDoc(input.runId, buf.events[startIdx + i]);
    }
    const lastSeq = items[take - 1].seq;
    if (lastSeq > buf.returnedUpTo) buf.returnedUpTo = lastSeq;
    const now = this.now();
    buf.touchedAt = now;
    this.sweep(now);

    return total > take ? { items, nextOffset: items[take - 1].offset } : { items };
  }

  async delete(input: {
    readonly filter: LocalAgentRunEventFilter;
  }): Promise<void> {
    const ids = input.filter.runIds;
    if (ids && ids.length > 0) {
      for (const id of ids) this.buffers.delete(id);
    } else {
      this.buffers.clear();
    }
  }

  /** 被 JSON.stringify 时只给标识（和 FastCheckpoints 一致）：不序列化内部缓冲，也防日志 / 遥测误打爆 */
  toJSON(): { kind: "memory-run-events" } {
    return { kind: "memory-run-events" };
  }

  /** 进程级概况（遥测 / 排障用，O(run 数)） */
  getStats(): MemoryRunEventsStats {
    let retainedEvents = 0;
    let retainedChars = 0;
    for (const b of this.buffers.values()) {
      retainedEvents += b.events.length;
      retainedChars += b.chars;
    }
    return {
      runs: this.buffers.size,
      retainedEvents,
      retainedChars,
      trimmedEvents: this.trimmedTotal,
    };
  }

  /** 单个 run 的概况；没见过这个 run 返回 null */
  runStats(runId: string): MemoryRunStats | null {
    const b = this.buffers.get(runId);
    if (!b) return null;
    return { appended: b.nextSeq - 1, retained: b.events.length };
  }

  /**
   * 回收：只丢已读前缀（闲置 ≥ trimIdleMs）；幽灵 run（闲置 ≥ ghostIdleMs）整份丢。
   * run 的 buffer 本身（序号墓碑）一直留着，直到 delete——每个 run 几十字节。
   */
  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.sweepEveryMs) return;
    this.lastSweepAt = now;
    for (const b of this.buffers.values()) {
      if (b.events.length === 0) continue;
      const idle = now - b.touchedAt;
      if (idle >= this.ghostIdleMs) {
        this.dropFirst(b, b.events.length);
        b.idem = null;
      } else if (idle >= this.trimIdleMs) {
        // 只丢已读前缀（≤ returnedUpTo）：之后没被读走的一条都不动；没有已读前缀时 count ≤ 0，dropFirst 直接返回
        this.dropFirst(b, Math.min(b.events.length, b.returnedUpTo - b.baseSeq + 1));
      }
    }
  }

  private dropFirst(b: RunBuffer, count: number): void {
    if (count <= 0) return;
    const dropped = b.events.splice(0, count);
    for (const e of dropped) b.chars -= e.payloadJson.length;
    b.baseSeq += count;
    // 全丢光时：已读标记对齐到「最后一个序号」，避免之后新事件被误判成已读
    if (b.events.length === 0) b.returnedUpTo = Math.max(b.returnedUpTo, b.nextSeq - 1);
    this.trimmedTotal += count;
  }
}
