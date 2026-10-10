/**
 * MemoryRunEvents（run_events 的内存实现）：
 *   1. 单元语义（seq / offset / 分页 / 幂等 / 删除 / 隔离 / 同步生效顺序）；
 *   2. 对拍：随机操作序列同时喂给本实现和真实 `@cursor/sdk` 的 JsonlLocalAgentStore.runEvents，
 *      每一步返回值逐项比对（createdAt 除外）——「语义与 SDK 一致」靠它兜底，不靠肉眼；
 *   3. 回收规则（注入时钟）：已读前缀闲置才丢、未读不丢、序号不回退、幽灵 run 兜底；
 *   4. 规模守卫：5 万条历史后 append / list 仍是微秒级（SDK 自带实现在这个规模下是分钟级）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { MemoryRunEvents } from "@/lib/server/memory-run-events";

import { cleanupTmps, loadSdk, mkTmp, rng } from "./helpers/fast-store-helpers";

afterEach(() => {
  cleanupTmps();
});

const fakeClock = (start = 1_700_000_000_000) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

const MIN = 60_000;
const HOUR = 60 * MIN;

const ev = (runId: string, i: number, extra: Record<string, unknown> = {}) => ({
  runId,
  eventType: "run_stream_event",
  payload: { i, ...extra },
});

const seqs = (r: { items: readonly { seq: number }[] }): number[] =>
  r.items.map((x) => x.seq);

describe("MemoryRunEvents：基本语义", () => {
  it("append：seq 从 1 递增、offset = String(seq)、字段默认 null、返回调用方传入的 payload 引用", async () => {
    const clock = fakeClock();
    const mem = new MemoryRunEvents({ now: clock.now });
    const payload = { hello: "世界" };
    const a = await mem.append({ runId: "r", eventType: "t", payload });
    expect(a).toEqual({
      runId: "r",
      seq: 1,
      offset: "1",
      eventType: "t",
      payload: { hello: "世界" },
      payloadRef: null,
      idempotencyKey: null,
      createdAt: clock.now(),
    });
    expect(a.payload).toBe(payload);
    const b = await mem.append({ runId: "r", eventType: "t" });
    expect(b.seq).toBe(2);
    expect(b.payload).toBeNull();
  });

  it("各 run 的 seq 互相独立", async () => {
    const mem = new MemoryRunEvents();
    await mem.append(ev("a", 0));
    await mem.append(ev("a", 1));
    const b1 = await mem.append(ev("b", 0));
    expect(b1.seq).toBe(1);
    expect(seqs(await mem.list({ runId: "a" }))).toEqual([1, 2]);
    expect(seqs(await mem.list({ runId: "b" }))).toEqual([1]);
  });

  it("list：afterOffset 是严格大于；缺省 / null 从头；没见过的 run 返回空", async () => {
    const mem = new MemoryRunEvents();
    for (let i = 0; i < 5; i++) await mem.append(ev("r", i));
    expect(seqs(await mem.list({ runId: "r" }))).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(await mem.list({ runId: "r", afterOffset: null }))).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(await mem.list({ runId: "r", afterOffset: "2" }))).toEqual([3, 4, 5]);
    expect(seqs(await mem.list({ runId: "r", afterOffset: "5" }))).toEqual([]);
    expect(seqs(await mem.list({ runId: "r", afterOffset: "999" }))).toEqual([]);
    expect(await mem.list({ runId: "nope" })).toEqual({ items: [] });
  });

  it("list：解析不出数字的 afterOffset 什么都不返回（与 SDK 同口径）", async () => {
    const mem = new MemoryRunEvents();
    await mem.append(ev("r", 0));
    expect(await mem.list({ runId: "r", afterOffset: "abc" })).toEqual({ items: [] });
  });

  it("list 分页：缺省 100 一页，nextOffset 只在还有更多时给出，沿 nextOffset 能读全", async () => {
    const mem = new MemoryRunEvents();
    for (let i = 0; i < 250; i++) await mem.append(ev("r", i));
    const p1 = await mem.list({ runId: "r" });
    expect(p1.items).toHaveLength(100);
    expect(p1.nextOffset).toBe("100");
    const p2 = await mem.list({ runId: "r", afterOffset: p1.nextOffset });
    expect(p2.items).toHaveLength(100);
    expect(p2.nextOffset).toBe("200");
    const p3 = await mem.list({ runId: "r", afterOffset: p2.nextOffset });
    expect(p3.items).toHaveLength(50);
    expect(p3.nextOffset).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(p3, "nextOffset")).toBe(false);
  });

  it("limit：0 → 空且无 nextOffset；负数 / 小数与 Array.slice 同语义", async () => {
    const mem = new MemoryRunEvents();
    for (let i = 0; i < 4; i++) await mem.append(ev("r", i));
    expect(await mem.list({ runId: "r", limit: 0 })).toEqual({ items: [] });
    const neg = await mem.list({ runId: "r", limit: -1 });
    expect(seqs(neg)).toEqual([1, 2, 3]);
    expect(neg.nextOffset).toBe("3");
    expect(seqs(await mem.list({ runId: "r", limit: 2.9 }))).toEqual([1, 2]);
    expect(seqs(await mem.list({ runId: "r", limit: Number.NaN }))).toEqual([]);
    expect(seqs(await mem.list({ runId: "r", limit: Infinity }))).toEqual([1, 2, 3, 4]);
  });

  it("幂等键：命中返回已有记录、不追加；不同 run 的同名键互不影响", async () => {
    const mem = new MemoryRunEvents();
    const first = await mem.append({ runId: "r", eventType: "t", payload: { v: 1 }, idempotencyKey: "k" });
    const dup = await mem.append({ runId: "r", eventType: "t", payload: { v: 2 }, idempotencyKey: "k" });
    expect(dup.seq).toBe(first.seq);
    expect(dup.payload).toEqual({ v: 1 });
    expect(await mem.list({ runId: "r" })).toMatchObject({ items: [{ seq: 1 }] });
    const other = await mem.append({ runId: "r2", eventType: "t", idempotencyKey: "k" });
    expect(other.seq).toBe(1);
  });

  it("delete：只删指定 run；删后该 run 从 1 重新计数；空 runIds / 缺省 = 全删", async () => {
    const mem = new MemoryRunEvents();
    for (const r of ["a", "b", "c"]) {
      await mem.append(ev(r, 0));
      await mem.append(ev(r, 1));
    }
    await mem.delete({ filter: { runIds: ["a", "c"] } });
    expect(await mem.list({ runId: "a" })).toEqual({ items: [] });
    expect(seqs(await mem.list({ runId: "b" }))).toEqual([1, 2]);
    expect((await mem.append(ev("a", 9))).seq).toBe(1);

    await mem.delete({ filter: { runIds: [] } });
    expect(await mem.list({ runId: "b" })).toEqual({ items: [] });
    await mem.append(ev("b", 0));
    await mem.delete({ filter: {} });
    expect(await mem.list({ runId: "b" })).toEqual({ items: [] });
    expect(mem.getStats().runs).toBe(0);
  });

  it("payload 在 append 时就序列化隔离：之后改调用方的对象不影响已存内容", async () => {
    const mem = new MemoryRunEvents();
    const payload = { list: [1, 2], nested: { a: 1 } };
    await mem.append({ runId: "r", eventType: "t", payload });
    payload.list.push(3);
    payload.nested.a = 99;
    const got = await mem.list({ runId: "r" });
    expect(got.items[0].payload).toEqual({ list: [1, 2], nested: { a: 1 } });
    // list 每次返回的是新对象：调用方改它也不会污染存储
    (got.items[0].payload as { list: number[] }).list.push(7);
    expect((await mem.list({ runId: "r" })).items[0].payload).toEqual({
      list: [1, 2],
      nested: { a: 1 },
    });
  });

  it("所有方法同步生效：不 await append 也能立刻在下一个 list 里读到（等价于 SDK 的串行队列顺序）", async () => {
    const mem = new MemoryRunEvents();
    const p1 = mem.append(ev("r", 0));
    const p2 = mem.append(ev("r", 1));
    const l = mem.list({ runId: "r" });
    const d = mem.delete({ filter: { runIds: ["r"] } });
    const l2 = mem.list({ runId: "r" });
    const [a, b, listed, , listedAfterDelete] = await Promise.all([p1, p2, l, d, l2]);
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(seqs(listed)).toEqual([1, 2]);
    expect(listedAfterDelete.items).toEqual([]);
  });

  it("payload 不可序列化（BigInt）：整个 append 拒绝，不占 seq、不留半截状态", async () => {
    const mem = new MemoryRunEvents();
    await expect(
      mem.append({ runId: "r", eventType: "t", payload: { n: 1n } }),
    ).rejects.toThrow();
    expect(mem.runStats("r")).toBeNull();
    const ok = await mem.append(ev("r", 0));
    expect(ok.seq).toBe(1);
  });

  it("payload 是函数 / undefined 之类 JSON 不认的值：当 null 存，list 不会炸", async () => {
    const mem = new MemoryRunEvents();
    await mem.append({ runId: "r", eventType: "t", payload: () => 1 });
    await mem.append({ runId: "r", eventType: "t", payload: undefined });
    const got = await mem.list({ runId: "r" });
    expect(got.items.map((i) => i.payload)).toEqual([null, null]);
  });

  it("toJSON 只给标识：JSON.stringify 不会把缓冲内容带出去", async () => {
    const mem = new MemoryRunEvents();
    for (let i = 0; i < 100; i++) await mem.append(ev("r", i, { big: "x".repeat(200) }));
    expect(JSON.parse(JSON.stringify(mem))).toEqual({ kind: "memory-run-events" });
  });

  it("getStats / runStats：条数、字符数、被回收数", async () => {
    const mem = new MemoryRunEvents();
    expect(mem.runStats("r")).toBeNull();
    await mem.append({ runId: "r", eventType: "t", payload: { a: 1 } }); // {"a":1} = 7 字符
    await mem.append({ runId: "r", eventType: "t", payload: null }); // null = 4 字符
    expect(mem.runStats("r")).toEqual({ appended: 2, retained: 2 });
    expect(mem.getStats()).toEqual({
      runs: 1,
      retainedEvents: 2,
      retainedChars: 11,
      trimmedEvents: 0,
    });
  });
});

// ───────────────────────── 对拍 ─────────────────────────

describe("MemoryRunEvents：与真实 SDK JsonlLocalAgentStore.runEvents 对拍", () => {
  /** createdAt 本来就是各自取的当前时间，比对前抹平；其余字段逐项比 */
  const norm = <T>(v: T): unknown =>
    JSON.parse(JSON.stringify(v, (k, x) => (k === "createdAt" ? 0 : x)));

  const RUNS = ["run-a", "run-b", "run-c"] as const;
  const PAYLOADS: Array<() => unknown> = [
    () => undefined,
    () => null,
    () => 42,
    () => "纯字符串 payload",
    () => ({ type: "thinking", text: "思考中…".repeat(5) }),
    () => ({ nested: { list: [1, "二", { three: 3 }], flag: true }, gone: undefined }),
    () => ({ when: new Date(0), emoji: "😀\n换行\t制表\"引号\\反斜杠" }),
  ];
  const AFTER = [undefined, null, "0", "1", "3", "7", "40", "999", "abc", "-2", "2.7"] as const;
  const LIMITS = [undefined, 0, 1, 2, 3, 5, 100, -1, -2, 2.5] as const;
  const KEYS = ["k1", "k2", "k3"] as const;

  const pick = <T>(rand: () => number, xs: readonly T[]): T =>
    xs[Math.floor(rand() * xs.length)];

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "随机操作序列 seed=%i：每一步返回值与 SDK 完全一致",
    async (seed) => {
      const sdk = await loadSdk();
      const ref = new sdk.JsonlLocalAgentStore(mkTmp()).runEvents;
      const mem = new MemoryRunEvents();
      const rand = rng(seed * 7919);

      for (let step = 0; step < 320; step++) {
        const r = rand();
        if (r < 0.5) {
          const input = {
            runId: pick(rand, RUNS),
            eventType: pick(rand, ["run_stream_event", "other_type"] as const),
            payload: pick(rand, PAYLOADS)(),
            payloadRef: pick(rand, [undefined, null, "ref-1"] as const),
            idempotencyKey: rand() < 0.15 ? pick(rand, KEYS) : pick(rand, [undefined, null] as const),
          };
          expect(norm(await mem.append(input)), `step ${step} append`).toEqual(
            norm(await ref.append(input)),
          );
        } else if (r < 0.93) {
          const input = {
            runId: pick(rand, RUNS),
            afterOffset: pick(rand, AFTER),
            limit: pick(rand, LIMITS),
          };
          expect(norm(await mem.list(input)), `step ${step} list ${JSON.stringify(input)}`).toEqual(
            norm(await ref.list(input)),
          );
        } else {
          const filter = pick(rand, [
            { runIds: ["run-a"] },
            { runIds: ["run-b", "run-c"] },
            { runIds: [] },
            {},
          ] as const);
          await mem.delete({ filter });
          await ref.delete({ filter });
        }
      }

      // 收尾：每个 run 沿 nextOffset 翻页读全，逐页一致
      for (const runId of RUNS) {
        let after: string | undefined;
        for (let page = 0; page < 200; page++) {
          const a = await mem.list({ runId, afterOffset: after, limit: 7 });
          const b = await ref.list({ runId, afterOffset: after, limit: 7 });
          expect(norm(a), `${runId} page ${page}`).toEqual(norm(b));
          if (!a.nextOffset) break;
          after = a.nextOffset;
        }
      }
    },
    60_000,
  );
});

// ───────────────────────── 回收 ─────────────────────────

describe("MemoryRunEvents：内存回收", () => {
  const mk = (opts: ConstructorParameters<typeof MemoryRunEvents>[0] = {}) => {
    const clock = fakeClock();
    const mem = new MemoryRunEvents({ now: clock.now, ...opts });
    return { clock, mem };
  };
  /** 用另一个 run 的 append 触发一次清扫（被追加的 run 自己刚活动过，不会被当闲置） */
  const poke = (mem: MemoryRunEvents, i = 0) => mem.append(ev("poke", i));

  it("闲置 ≥ 5 分钟：丢掉已读前缀，保留未读；序号不回退", async () => {
    const { clock, mem } = mk();
    for (let i = 0; i < 10; i++) await mem.append(ev("r", i));
    const first = await mem.list({ runId: "r", limit: 6 });
    expect(first.nextOffset).toBe("6");

    clock.advance(5 * MIN + 31_000);
    await poke(mem);

    expect(mem.runStats("r")).toEqual({ appended: 10, retained: 4 });
    expect(mem.getStats().trimmedEvents).toBe(6);
    expect(seqs(await mem.list({ runId: "r", afterOffset: "6" }))).toEqual([7, 8, 9, 10]);
  });

  it("未闲置够 5 分钟不动", async () => {
    const { clock, mem } = mk();
    for (let i = 0; i < 4; i++) await mem.append(ev("r", i));
    await mem.list({ runId: "r" });
    clock.advance(4 * MIN + 50_000);
    await poke(mem);
    expect(mem.runStats("r")).toEqual({ appended: 4, retained: 4 });
  });

  it("从来没被读走的事件不会因闲置被丢（6 小时幽灵兜底之前）", async () => {
    const { clock, mem } = mk();
    for (let i = 0; i < 5; i++) await mem.append(ev("r", i));
    clock.advance(HOUR);
    await poke(mem);
    expect(mem.runStats("r")).toEqual({ appended: 5, retained: 5 });
    expect(seqs(await mem.list({ runId: "r" }))).toEqual([1, 2, 3, 4, 5]);
  });

  it("已读前缀被丢光后同一个 run 继续追加：序号接着排，手里 afterOffset 依然有效（长时间等用户回答后续写）", async () => {
    const { clock, mem } = mk();
    for (let i = 0; i < 5; i++) await mem.append(ev("r", i));
    const seen = await mem.list({ runId: "r" });
    expect(seqs(seen)).toEqual([1, 2, 3, 4, 5]);

    clock.advance(10 * MIN);
    await poke(mem);
    expect(mem.runStats("r")).toEqual({ appended: 5, retained: 0 });

    const next = await mem.append(ev("r", 5));
    expect(next.seq).toBe(6);
    // 新事件还没被读走：再闲置一轮也不能丢（没被误判成「已读」）
    clock.advance(10 * MIN);
    await poke(mem, 1);
    expect(mem.runStats("r")).toEqual({ appended: 6, retained: 1 });
    // 读走之后手里的 afterOffset 依然有效，再闲置一轮才会被回收
    expect(seqs(await mem.list({ runId: "r", afterOffset: "5" }))).toEqual([6]);
    clock.advance(10 * MIN);
    await poke(mem, 2);
    expect(mem.runStats("r")).toEqual({ appended: 6, retained: 0 });
  });

  it("幽灵 run：6 小时没有任何追加 / 读取，未读事件也丢；序号照样接着排", async () => {
    const { clock, mem } = mk();
    for (let i = 0; i < 5; i++) await mem.append(ev("ghost", i));
    clock.advance(6 * HOUR + MIN);
    await poke(mem);
    expect(mem.runStats("ghost")).toEqual({ appended: 5, retained: 0 });
    expect((await mem.append(ev("ghost", 5))).seq).toBe(6);
    expect(seqs(await mem.list({ runId: "ghost", afterOffset: "5" }))).toEqual([6]);
  });

  it("空轮询不刷新活动时间；读到事件才刷新", async () => {
    const { clock, mem } = mk();
    for (let i = 0; i < 3; i++) await mem.append(ev("r", i));
    await mem.list({ runId: "r" });

    clock.advance(4 * MIN);
    expect((await mem.list({ runId: "r", afterOffset: "3" })).items).toEqual([]); // 空轮询
    clock.advance(MIN + 40_000);
    await poke(mem);
    expect(mem.runStats("r")?.retained).toBe(0); // 空轮询没续命 → 已读前缀被丢

    // 对照：中途读到了新事件 → 续命
    const { clock: c2, mem: m2 } = mk();
    for (let i = 0; i < 3; i++) await m2.append(ev("r", i));
    await m2.list({ runId: "r" });
    c2.advance(4 * MIN);
    await m2.append(ev("r", 3));
    expect(seqs(await m2.list({ runId: "r", afterOffset: "3" }))).toEqual([4]);
    c2.advance(MIN + 40_000);
    await poke(m2);
    expect(m2.runStats("r")?.retained).toBe(4);
  });

  it("清扫按 sweepEveryMs 节流：没到间隔不扫", async () => {
    const { clock, mem } = mk({ sweepEveryMs: 10 * MIN });
    for (let i = 0; i < 3; i++) await mem.append(ev("r", i));
    await mem.list({ runId: "r" });

    clock.advance(6 * MIN);
    await poke(mem);
    expect(mem.runStats("r")?.retained).toBe(3); // 距上次清扫（构造时）才 6 分钟 → 不扫

    clock.advance(5 * MIN);
    await poke(mem, 1);
    expect(mem.runStats("r")?.retained).toBe(0);
  });

  it("活跃 run 持续追加时，已读事件也不会被丢（回收只看闲置，不看数量）", async () => {
    const { clock, mem } = mk();
    for (let round = 0; round < 40; round++) {
      await mem.append(ev("busy", round));
      await mem.list({ runId: "busy", afterOffset: String(round) });
      clock.advance(30_000);
    }
    expect(mem.runStats("busy")).toEqual({ appended: 40, retained: 40 });
  });

  it("delete 连序号墓碑一起清：同一个 run id 重新从 1 开始", async () => {
    const { clock, mem } = mk();
    await mem.append(ev("r", 0));
    await mem.list({ runId: "r" });
    clock.advance(10 * MIN);
    await poke(mem);
    expect(mem.runStats("r")).toEqual({ appended: 1, retained: 0 });
    await mem.delete({ filter: { runIds: ["r"] } });
    expect(mem.runStats("r")).toBeNull();
    expect((await mem.append(ev("r", 1))).seq).toBe(1);
  });
});

// ───────────────────────── 规模守卫 ─────────────────────────

describe("MemoryRunEvents：规模", () => {
  it("5 万条历史后 append / 尾部 list 仍是微秒级（SDK 自带实现在这个规模下每次 243ms+）", async () => {
    const mem = new MemoryRunEvents();
    const payload = { type: "thinking", text: "思".repeat(300) };

    const t0 = performance.now();
    for (let i = 0; i < 50_000; i++) {
      await mem.append({ runId: "big", eventType: "run_stream_event", payload });
    }
    const appendMs = performance.now() - t0;

    // 消费者模式：永远只读尾部新增的几条
    const t1 = performance.now();
    for (let i = 0; i < 2000; i++) {
      const r = await mem.list({ runId: "big", afterOffset: String(50_000 - 3) });
      expect(r.items).toHaveLength(3);
    }
    const tailMs = performance.now() - t1;

    // 门槛非常宽松（正常机器上分别是几十毫秒量级）：只防「退化成 O(历史)」——
    // 退化的话 5 万次 append 要 1e9 量级的操作，远超这个门槛。
    expect(appendMs).toBeLessThan(8000);
    expect(tailMs).toBeLessThan(3000);
    expect(mem.runStats("big")).toEqual({ appended: 50_000, retained: 50_000 });
  }, 30_000);

  it("从头翻页读 5 万条：每页 100 条，共 500 页，总量一致", async () => {
    const mem = new MemoryRunEvents();
    for (let i = 0; i < 50_000; i++) await mem.append({ runId: "big", eventType: "t", payload: i });
    let after: string | undefined;
    let total = 0;
    let pages = 0;
    for (;;) {
      const r = await mem.list({ runId: "big", afterOffset: after });
      total += r.items.length;
      pages += 1;
      if (!r.nextOffset) break;
      after = r.nextOffset;
    }
    expect(total).toBe(50_000);
    expect(pages).toBe(500);
  }, 30_000);
});
