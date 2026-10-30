/**
 * R14 Q20-02：`deps.deliver` 外包超时——挂死的投递不能永远占着这个任务的 tick。
 *
 * ## 缺陷（改前）
 * `deps.deliver` 返回一个永不 resolve 的 Promise（真实场景：`handleTaskQuestionInject` 里某一步卡死：磁盘 / SDK resume / 锁等待）时，
 * 该任务的 `tickTask` 永远停在 `await`：`tickingTasks` 永不释放，之后每一轮 tick 都在入口被挡掉——
 * 这个会话的**全部**定时从此停摆（连「错过」都不会记），同会话的投递串行链、手动「立即触发」的 inflight 标记也一并被占住，直到重启。
 *
 * ## 修后
 * `doAttemptDelivery` 里 `Promise.race([deliver, 超时])`（常量 SCHEDULE_DELIVER_TIMEOUT_MS，`deps.deliverTimeoutMs` 可注入缩短）：
 *  - 超时按「结果不明」处理（同 deliver 抛异常）：`markUnknown`，下一次重试**沿用同一个幂等键**（下游认回放，不重复投递），结果记 retry；
 *  - 仍在投递窗口内 → 之后的 tick 继续重试；窗口耗尽照旧记失败；
 *  - race 结束后 `clearTimeout`，不留悬挂 timer；被丢下的 deliver 晚到的 reject 不会变成 unhandledRejection。
 *
 * ## 用例分类（BF = 改前原样源码，SH = 修复后）
 *  - 回归（BF 必须红、SH 绿）：R1 R2 R3 R4a R4b R5a R5b R6 R6b R7 R8、C2'、C3
 *  - 对照（BF、SH 都绿）：R3b（顺序对调）、C1a-c（超时之前正常返回）、C2（无遗留 timer，四种返回方式）
 *
 * ## 稳定性（机器高负载时也要稳）
 *  - 断言只看「状态」，没有任何墙钟耗时比较。
 *  - 回归用例用真实时间 + 注入的小超时（SMALL_TIMEOUT_MS = 30ms）：deliver 的假实现只在微任务里完成，所以「正常返回」
 *    永远赢过超时 timer（微任务总是先于定时器宏任务），与负载无关；「挂死」靠超时 timer 兜底，最多只会更晚触发、不会误判。
 *  - 「tick 有没有返回」用 Promise.race([tick, 15s 上限]) 判：改前 tick 永远不返回，这里表现为断言失败而不是卡到 vitest 全局超时；
 *    修后几十毫秒就返回，上限只在改前才会走完。所有「等条件成立」都是轮询（上限 15s），不用固定 sleep。
 *  - 缺省超时（60s）的接线用 fake timers 精确推进（R8）：只假装 setTimeout / clearTimeout，落盘 I/O 不受影响，不真等。
 *
 * 写法沿用 tests/schedule-runner.test.ts 的 harness（假时钟 + 假投递 + 真落盘），但它的 setup() 不能传 deliverTimeoutMs，所以这里自带一份。
 * 同一任务里的几条定时标题必须不同（甲 / 乙）：Q20-05 之后 createSchedule 会把「完全等价」的活定时去重成一条。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-deliver-timeout-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

// 模块加载时就抓住真 setTimeout：R8 会把全局的假装掉，轮询 / 兜底仍要用真的
const realSetTimeout = globalThis.setTimeout;

vi.setConfig({ testTimeout: 60_000 });

const runnerMod = await import("../src/lib/server/schedule-runner");
const store = await import("../src/lib/server/schedule-store");
const { taskDir } = await import("../src/lib/server/task-fs-core");
const { SCHEDULE_DELIVERY_WINDOW_MS } = await import("../src/lib/schedule");

import type { ScheduleRecord } from "../src/lib/schedule";
import type { DeliverOutcome, DeliverRequest, ScheduleRunner } from "../src/lib/server/schedule-runner";

const { createScheduleRunner, defaultStoreDeps } = runnerMod;

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 18, 2, 0, 0);
/** 全文件里一次性定时的计划时刻 */
const DUE = T0 + 10 * MIN;
/** 窗口时长（分钟，取整）：窗口耗尽的原因文案里会写「超过 N 分钟」 */
const WINDOW_MINUTES = Math.round(SCHEDULE_DELIVERY_WINDOW_MS / MIN);

/** 回归用例注入的小超时（真实时间）；deliver 的假实现只在微任务里完成，所以不会被它误伤 */
const SMALL_TIMEOUT_MS = 30;
/** C2 用的独特超时值：只认 runner 为 deliver 起的那个 timer，不会和别处的 timer 混 */
const MARK_MS = 54_321;
/** 「tick / fireNow 有没有返回」的上限：只有改前（挂死）才会等满，修后几十毫秒就返回，所以给足余量 */
const HANG_CAP_MS = 15_000;

/** SCHEDULE_DELIVER_TIMEOUT_MS 是 Q20-02 新增的导出：动态取，改前（BF）是 undefined，让断言失败而不是整个文件加载崩溃 */
const deliverTimeoutConst = (): unknown =>
  (runnerMod as unknown as Record<string, unknown>).SCHEDULE_DELIVER_TIMEOUT_MS;

let seq = 0;
const freshTask = async (): Promise<string> => {
  seq += 1;
  const id = `t_dto_${seq}`;
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

type DeliverImpl = (req: DeliverRequest) => Promise<DeliverOutcome>;

interface Harness {
  taskId: string;
  clock: { now: number };
  deliveries: DeliverRequest[];
  notices: Array<{ text: string; meta: Record<string, unknown> }>;
  /** 换掉 deliver 的行为：被调用时先把请求记入 deliveries，再交给它 */
  setDeliver: (fn: DeliverImpl) => void;
  runner: ScheduleRunner;
}

/** `timeoutMs` 缺省 = 注入小超时；传 "default" = 不注入（走 runner 自己的缺省值） */
const setup = async (opts: { timeoutMs?: number | "default" } = {}): Promise<Harness> => {
  const taskId = await freshTask();
  const clock = { now: T0 };
  const deliveries: DeliverRequest[] = [];
  const notices: Harness["notices"] = [];
  let impl: DeliverImpl = async () => ({ kind: "delivered" });
  const timeoutMs = opts.timeoutMs ?? SMALL_TIMEOUT_MS;
  const runner = createScheduleRunner({
    ...defaultStoreDeps(),
    liveTaskIds: () => [taskId], // 只扫本用例的任务，免得别的用例留下的记录串进来
    now: () => clock.now,
    deliver: async (req) => {
      deliveries.push(req);
      return impl(req);
    },
    notify: async (_t, text, meta) => {
      notices.push({ text, meta });
    },
    ...(timeoutMs === "default" ? {} : { deliverTimeoutMs: timeoutMs }),
  });
  return {
    taskId,
    clock,
    deliveries,
    notices,
    setDeliver: (fn) => {
      impl = fn;
    },
    runner,
  };
};

const create = async (
  h: Harness,
  over: Partial<Parameters<typeof store.createSchedule>[1]> = {},
): Promise<ScheduleRecord> => {
  const r = await store.createSchedule(
    h.taskId,
    {
      kind: "once",
      title: "看 CI",
      message: "去看 CI 结果",
      firstFireAt: DUE,
      ...over,
    } as Parameters<typeof store.createSchedule>[1],
    T0,
  );
  if (!r.ok) throw new Error(r.error);
  // 去重命中 = 没新建（拿到的是已有那条）：说明用例里两条定时「完全等价」了，后面的断言会悄悄失去意义
  if (r.deduped) throw new Error(`定时「${over.title ?? "看 CI"}」被去重了：同一任务里的定时标题必须不同`);
  return r.record;
};

const only = async (h: Harness): Promise<ScheduleRecord> => {
  const list = await store.readSchedules(h.taskId);
  expect(list).toHaveLength(1);
  return list[0]!;
};

/** 读盘上的最新记录，按标题取 */
const records = async (h: Harness): Promise<(title: string) => ScheduleRecord> => {
  const list = await store.readSchedules(h.taskId);
  return (title) => {
    const r = list.find((x) => x.title === title);
    if (!r) throw new Error(`盘上没有标题为「${title}」的定时`);
    return r;
  };
};

const callsOf = (fn: unknown): unknown[][] => (fn as { mock: { calls: unknown[][] } }).mock.calls;

/** runner 的 `[schedule] ...` 日志行（console.log 被 spy 吞掉，不刷屏） */
const logLines = (): string[] =>
  callsOf(console.log)
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("[schedule] "));

/** 永不 resolve 的投递（模拟下游某一步卡死） */
const hang = (): Promise<DeliverOutcome> => new Promise<DeliverOutcome>(() => {});

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** 让出几轮宏任务：给 Node 机会派发 unhandledRejection、让没人 await 的后续逻辑跑完 */
const flush = async (turns = 3): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
};

/** 轮询直到条件成立（上限 capMs）；不用固定 sleep */
const pollUntil = async (
  cond: () => boolean | Promise<boolean>,
  what: string,
  capMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + capMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`等待超时（${capMs}ms）：${what}`);
    await new Promise<void>((r) => realSetTimeout(r, 5));
  }
};

const HUNG = Symbol("hung");
/**
 * 等 `p` 落定，但最多等 HANG_CAP_MS。不能直接 await：改前 deliver 挂死会让 tick / fireNow 永远不返回，
 * vitest 只会卡到全局超时；这里把「挂住」变成一个可断言的哨兵值。
 */
const settleWithin = async <T>(p: Promise<T>): Promise<T | typeof HUNG> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<typeof HUNG>((resolve) => {
    timer = realSetTimeout(() => resolve(HUNG), HANG_CAP_MS);
  });
  try {
    return await Promise.race([p, cap]);
  } finally {
    clearTimeout(timer);
  }
};
const tickReturned = async (h: Harness): Promise<boolean> => (await settleWithin(h.runner.tick())) !== HUNG;

/** 监视 runner 为 deliver 起的超时 timer（按独特的超时值 MARK_MS 认）：起了几个、有没有被 clearTimeout */
const watchTimers = () => {
  const setSpy = vi.spyOn(globalThis, "setTimeout");
  const clearSpy = vi.spyOn(globalThis, "clearTimeout");
  const setCalls = (): Array<{ delay: unknown; handle: unknown }> => {
    const calls = setSpy.mock.calls as unknown as unknown[][];
    const results = setSpy.mock.results as unknown as Array<{ value: unknown }>;
    return calls.map((c, i) => ({ delay: c[1], handle: results[i]?.value }));
  };
  return {
    created: (): unknown[] => setCalls().filter((x) => x.delay === MARK_MS).map((x) => x.handle),
    cleared: (handle: unknown): boolean =>
      (clearSpy.mock.calls as unknown as unknown[][]).some((c) => c[0] === handle),
  };
};

beforeEach(() => {
  runnerMod.__resetScheduleRunnerStateForTest();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  try {
    // 调度器内部抛错会被 warn("调度出错") 吞掉：用例若悄悄踩到它，「没投递」之类的负向断言就会空转通过——统一在这里兜住
    const schedulerErrors = callsOf(console.warn)
      .map((c) => String(c[0]))
      .filter((l) => l.includes("调度出错"));
    expect(schedulerErrors).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers(); // R8 装过 fake timers：无论用例怎么结束都还原
  }
});

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* 清不掉就留给系统清 tmp，别让清理失败拖红测试 */
  }
});

describe("Q20-02 deliver 挂死：tick 在超时后返回，不再永久占着这个任务", () => {
  it("【回归 R1】deliver 永不 resolve：tick 在超时后返回；记录仍是 pending、status 仍 active（还在窗口内）、没有 done", async () => {
    const h = await setup();
    await create(h);
    h.setDeliver(hang);
    h.clock.now = DUE + 1_000;

    // 改前：tick 永远不返回（tickingTasks 不释放）→ 这里读到 false
    expect(await tickReturned(h), "tick 应在超时后返回（改前：永久挂住）").toBe(true);

    expect(h.deliveries).toHaveLength(1);
    const saved = await only(h);
    expect(saved.pending).toMatchObject({ seq: 1 });
    expect(saved).toMatchObject({ status: "active", fireCount: 0, missedCount: 0 });
    expect(saved.history.filter((e) => e.outcome === "fired")).toEqual([]);
  });

  it("【回归 R2】超时后下一轮重试：沿用同一个 clientItemId（不递增 attempt）；送达后只落一次 done", async () => {
    const h = await setup();
    const rec = await create(h);
    h.setDeliver(hang);
    h.clock.now = DUE + 1_000;
    expect(await tickReturned(h), "第 1 轮 tick 应在超时后返回（改前：永久挂住）").toBe(true);

    h.setDeliver(async () => ({ kind: "delivered" }));
    h.clock.now += 5_000;
    expect(await tickReturned(h), "第 2 轮 tick 应正常返回").toBe(true);

    // 超时 = 结果不明（下游可能已受理）：必须沿用同一个键，让下游认成回放；换新键（…1.2）就是重复投递
    expect(h.deliveries.map((d) => d.clientItemId)).toEqual([`${rec.id}.1.1`, `${rec.id}.1.1`]);
    const saved = await only(h);
    expect(saved).toMatchObject({ status: "done", fireCount: 1 });
    expect(saved.pending).toBeUndefined();
    expect(saved.history.filter((e) => e.outcome === "fired")).toHaveLength(1);

    // 结算过了：之后不会再发
    h.clock.now += 5_000;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(2);
  });

  it(
    "【回归 R3】同任务两条（甲挂死、乙正常，甲排前面）：一轮 tick 里甲超时留 pending，乙在同一轮送达 done；" +
      "下一轮甲用同一个键重试送达、乙不重发",
    async () => {
      const h = await setup();
      const a = await create(h, { title: "甲" });
      const b = await create(h, { title: "乙" });
      h.setDeliver(async (req) => (req.record.title === "甲" ? hang() : { kind: "delivered" }));
      h.clock.now = DUE + 1_000;

      expect(await tickReturned(h), "tick 应在甲超时后继续处理乙并返回（改前：永久挂在甲身上）").toBe(true);
      expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲", "乙"]);
      let get = await records(h);
      expect(get("甲").pending).toMatchObject({ seq: 1 });
      expect(get("甲")).toMatchObject({ status: "active", fireCount: 0 });
      expect(get("乙")).toMatchObject({ status: "done", fireCount: 1 });

      // 下一轮：下游恢复正常。甲用同一个键重试（结果不明）；乙已经 done，不会被再投
      h.setDeliver(async () => ({ kind: "delivered" }));
      h.clock.now += 5_000;
      expect(await tickReturned(h), "第 2 轮 tick 应正常返回").toBe(true);
      expect(h.deliveries.map((d) => `${d.record.title}:${d.clientItemId}`)).toEqual([
        `甲:${a.id}.1.1`,
        `乙:${b.id}.1.1`,
        `甲:${a.id}.1.1`,
      ]);
      get = await records(h);
      expect(get("甲")).toMatchObject({ status: "done", fireCount: 1 });
      expect(get("乙")).toMatchObject({ status: "done", fireCount: 1 });
    },
  );

  it("【对照 R3b】顺序对调（乙先、甲后）：乙在甲挂死之前就已送完 done，甲留 pending——两种顺序结论一致", async () => {
    const h = await setup();
    await create(h, { title: "乙" }); // 先建 = 先处理（tick 按列表顺序逐条串行）
    await create(h, { title: "甲" });
    const stuck = deferred<DeliverOutcome>();
    h.setDeliver(async (req) => (req.record.title === "甲" ? stuck.promise : { kind: "delivered" }));
    h.clock.now = DUE + 1_000;
    const tick = h.runner.tick();
    try {
      // 甲的 deliver 被调用时，乙早已送完并落盘。这里不要求 tick 已返回——改前它会一直挂在甲身上，
      // 所以这条是「对照」：只验「乙不受排在后面的甲影响」，改前改后都成立
      await pollUntil(() => h.deliveries.length === 2, "甲的 deliver 被调用");
      expect(h.deliveries.map((d) => d.record.title)).toEqual(["乙", "甲"]);
      const get = await records(h);
      expect(get("乙")).toMatchObject({ status: "done", fireCount: 1 });
      expect(get("甲").pending).toMatchObject({ seq: 1 });
      expect(get("甲")).toMatchObject({ status: "active", fireCount: 0 });
    } finally {
      // 放开挂住的投递，让改前（会挂死）的 tick 也能收尾；修后它早已因超时返回，这里只是晚到的 resolve
      stuck.resolve({ kind: "retry", reason: "收尾：放开挂住的投递" });
      await tick;
    }
  });

  it("【回归 R4a】一次性：超时后窗口耗尽（deliver 仍挂死）→ missed，带窗口耗尽的原因并提示用户；窗口外不再调 deliver", async () => {
    const h = await setup();
    await create(h);
    h.setDeliver(hang);
    h.clock.now = DUE;
    expect(await tickReturned(h), "第 1 轮 tick 应在超时后返回（改前：永久挂住）").toBe(true);
    expect((await only(h)).pending).toBeDefined();

    h.clock.now = DUE + SCHEDULE_DELIVERY_WINDOW_MS + 1_000; // 投递窗口从认领起算
    expect(await tickReturned(h), "窗口耗尽那一轮 tick 应正常返回").toBe(true);

    expect(h.deliveries).toHaveLength(1); // 窗口耗尽在调 deliver 之前就判了，不再投
    const saved = await only(h);
    expect(saved).toMatchObject({ status: "missed", missedCount: 1, fireCount: 0 });
    expect(saved.pending).toBeUndefined();
    expect(saved.endNote).toContain(`${WINDOW_MINUTES} 分钟`);
    expect(saved.history.at(-1)).toMatchObject({ outcome: "failed" });
    expect(h.notices.at(-1)!.meta).toMatchObject({ phase: "failed", scheduleId: saved.id });
    expect(h.notices.at(-1)!.text).toContain("没能送进会话");
  });

  it("【回归 R4b】周期（间隔 60 分钟）：超时后窗口耗尽 → 记一次失败、计划保持 active；下一个节拍照常触发", async () => {
    const h = await setup();
    const rec = await create(h, { kind: "every", intervalMs: 60 * MIN });
    h.setDeliver(hang);
    h.clock.now = DUE;
    expect(await tickReturned(h), "第 1 轮 tick 应在超时后返回（改前：永久挂住）").toBe(true);

    h.clock.now = DUE + SCHEDULE_DELIVERY_WINDOW_MS + 1_000;
    expect(await tickReturned(h), "窗口耗尽那一轮 tick 应正常返回").toBe(true);
    expect(h.deliveries).toHaveLength(1);
    const saved = await only(h);
    expect(saved).toMatchObject({ status: "active", missedCount: 1, fireCount: 0, nextFireAt: DUE + 60 * MIN });
    expect(saved.pending).toBeUndefined();
    expect(saved.history.at(-1)).toMatchObject({ outcome: "failed" });
    expect(saved.endNote).toBeUndefined(); // 周期定时没有「结束」

    // 之后的节拍不受这次挂死影响：照常触发，这是第 2 次认领（seq 2）、用新记账的第 1 个键
    h.setDeliver(async () => ({ kind: "delivered" }));
    h.clock.now = DUE + 60 * MIN;
    expect(await tickReturned(h), "下一个节拍的 tick 应正常返回").toBe(true);
    expect(h.deliveries.at(-1)!.clientItemId).toBe(`${rec.id}.2.1`);
    expect(await only(h)).toMatchObject({ status: "active", fireCount: 1 });
  });

  it("【回归 R5a】超时之后 deliver 才 reject：不产生 unhandledRejection，状态照常推进", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = await setup();
      await create(h);
      const late = deferred<DeliverOutcome>();
      h.setDeliver(() => late.promise);
      h.clock.now = DUE + 1_000;
      expect(await tickReturned(h), "tick 应在超时后返回（改前：永久挂住）").toBe(true);

      late.reject(new Error("晚到的失败：超时之后下游才报错"));
      await flush(); // 让 Node 有机会派发 unhandledRejection

      // 之后再轮询几个 tick：下游恢复，同一条定时照常送达
      h.setDeliver(async () => ({ kind: "delivered" }));
      for (let i = 0; i < 3; i++) {
        h.clock.now += 5_000;
        await h.runner.tick();
        await flush();
      }
      expect(unhandled).toEqual([]);
      expect(await only(h)).toMatchObject({ status: "done", fireCount: 1 });
      expect(h.deliveries).toHaveLength(2); // 超时那次 + 送达那次；done 之后的 tick 不再发
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("【回归 R5b】超时之后 deliver 才 resolve「已送达」：不改写记录（pending 原样）；之后同键重试仍只结算一次", async () => {
    const h = await setup();
    const rec = await create(h);
    const late = deferred<DeliverOutcome>();
    h.setDeliver(() => late.promise);
    h.clock.now = DUE + 1_000;
    expect(await tickReturned(h), "tick 应在超时后返回（改前：永久挂住）").toBe(true);
    const before = await only(h);
    expect(before.pending).toBeDefined();

    late.resolve({ kind: "delivered" }); // 被丢下的那次投递晚到的「成功」
    await flush();
    expect(await only(h)).toEqual(before); // 没人拿它去结算：记录一字未动（pending 没被覆盖成别的）

    h.setDeliver(async () => ({ kind: "delivered" }));
    h.clock.now += 5_000;
    await h.runner.tick();
    expect(h.deliveries.map((d) => d.clientItemId)).toEqual([`${rec.id}.1.1`, `${rec.id}.1.1`]);
    expect(await only(h)).toMatchObject({ status: "done", fireCount: 1 });
  });

  it("【回归 R6】超时的原因会记进日志：retry 行带 id / seq 和「没返回 / 超时」一类的关键词（不钉整句）", async () => {
    const h = await setup();
    const rec = await create(h);
    h.setDeliver(hang);
    h.clock.now = DUE + 1_000;
    expect(await tickReturned(h), "tick 应在超时后返回（改前：永久挂住）").toBe(true);

    // retry 分支不改记录，原因只写进 `[schedule] retry …` 这一行日志
    const retryLines = logLines().filter((l) => l.startsWith("[schedule] retry"));
    expect(retryLines).toHaveLength(1);
    expect(retryLines[0]).toContain(`id=${rec.id}`);
    expect(retryLines[0]).toContain("seq=1");
    expect(retryLines[0]).toMatch(/没返回|超时/);
  });

  it("【回归 R6b】日志里的秒数是换算过的：注入 54321ms 的超时 → 日志写「54 秒」，不是「54321 秒」（fake timers，不真等）", async () => {
    const h = await setup({ timeoutMs: MARK_MS });
    await create(h);
    h.setDeliver(hang);
    h.clock.now = DUE + 1_000;

    // 同 R8：只假装 setTimeout / clearTimeout；看到 deliver 被调用时超时 timer 一定已经建好
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let returned = false;
    const tick = h.runner.tick().then(() => {
      returned = true;
    });
    await pollUntil(() => h.deliveries.length === 1, "deliver 被调用");
    await vi.advanceTimersByTimeAsync(MARK_MS);
    // 改前 deliver 挂死会让 tick 永不返回：这里用有上限的轮询（真实 timer），失败时是明确的断言信息而不是卡到全局超时
    await pollUntil(() => returned, "tick 应在超时后返回（改前：永久挂住）", HANG_CAP_MS);
    await tick;

    const retryLines = logLines().filter((l) => l.startsWith("[schedule] retry"));
    expect(retryLines).toHaveLength(1);
    expect(retryLines[0]).toContain(`${Math.round(MARK_MS / 1000)} 秒`);
    expect(retryLines[0]).not.toContain(`${MARK_MS} 秒`);
  });

  it("【回归 R7】手动「立即触发」同样受超时保护：deliver 挂死时 fireNow 在超时后返回 retry、待投递留着；inflight 已释放（再点不是 busy）", async () => {
    const h = await setup();
    const rec = await create(h);
    h.setDeliver(hang);
    h.clock.now = T0 + MIN;

    const first = await settleWithin(h.runner.fireNow(h.taskId, rec.id));
    expect(first === HUNG, "fireNow 应在超时后返回（改前：请求永不返回，inflight 永久占着）").toBe(false);
    expect(first).toMatchObject({ ok: true, outcome: "retry" });
    expect((await only(h)).pending).toMatchObject({ seq: 1, manual: true });

    // inflight 释放了：再点一次不是 busy，而是正常送达
    h.setDeliver(async () => ({ kind: "delivered" }));
    const second = await settleWithin(h.runner.fireNow(h.taskId, rec.id));
    expect(second).toMatchObject({ ok: true, outcome: "delivered" });
    expect(await only(h)).toMatchObject({ status: "done", fireCount: 1 });
  });

  it("【回归 R8】缺省（不注入 deliverTimeoutMs）的超时就是导出的 SCHEDULE_DELIVER_TIMEOUT_MS：差 1ms 还在等、到点才返回（fake timers，不真等）", async () => {
    const raw = deliverTimeoutConst();
    expect(raw, "runner 应导出 SCHEDULE_DELIVER_TIMEOUT_MS（改前没有）").toBeTypeOf("number");
    const ms = raw as number;

    const h = await setup({ timeoutMs: "default" });
    await create(h);
    h.setDeliver(hang);
    h.clock.now = DUE + 1_000;

    // 只假装 setTimeout / clearTimeout：落盘用的 fs 不受影响，runner 为 deliver 起的超时 timer 由这里精确推进
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let returned = false;
    const tick = h.runner.tick().then(() => {
      returned = true;
    });
    // deliver 被调用与超时 timer 的创建在同一段同步代码里：看到 deliver 被调用时，timer 一定已经建好
    await pollUntil(() => h.deliveries.length === 1, "deliver 被调用");
    await vi.advanceTimersByTimeAsync(ms - 1);
    await flush();
    expect(returned, "差 1ms 不该超时").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await tick;
    expect(returned).toBe(true);
    expect((await only(h)).pending).toMatchObject({ seq: 1 });
  });
});

describe("Q20-02 对照：deliver 在超时之前正常返回——行为与以前完全一致（缺省超时，不注入）", () => {
  it("【对照 C1a】返回 delivered：done、只投一次、没有提示", async () => {
    const h = await setup({ timeoutMs: "default" });
    const rec = await create(h);
    h.clock.now = DUE + 3_000;
    await h.runner.tick();

    expect(h.deliveries.map((d) => d.clientItemId)).toEqual([`${rec.id}.1.1`]);
    const saved = await only(h);
    expect(saved).toMatchObject({ status: "done", fireCount: 1 });
    expect(saved.pending).toBeUndefined();
    expect(h.notices).toEqual([]);
    expect(logLines().some((l) => l.startsWith("[schedule] delivered") && l.includes(`id=${rec.id}`))).toBe(true);
  });

  it("【对照 C1b】返回 retry：保留待投递、不记已触发；明确没送达 → 下一次换新键（与超时的「沿用同键」相反）", async () => {
    const h = await setup({ timeoutMs: "default" });
    const rec = await create(h);
    h.setDeliver(async () => ({ kind: "retry", reason: "会话正忙" }));
    h.clock.now = DUE;
    await h.runner.tick();

    const saved = await only(h);
    expect(saved.pending).toMatchObject({ seq: 1 });
    expect(saved).toMatchObject({ status: "active", fireCount: 0 });
    expect(logLines().some((l) => l.startsWith("[schedule] retry") && l.includes("会话正忙"))).toBe(true);

    h.clock.now += 5_000;
    await h.runner.tick();
    expect(h.deliveries.map((d) => d.clientItemId)).toEqual([`${rec.id}.1.1`, `${rec.id}.1.2`]);
  });

  it("【对照 C1c】返回 failed：一次性记 missed 并带原因提示；不再重试", async () => {
    const h = await setup({ timeoutMs: "default" });
    await create(h);
    h.setDeliver(async () => ({ kind: "failed", reason: "会话已归档" }));
    h.clock.now = DUE;
    await h.runner.tick();

    expect(h.deliveries).toHaveLength(1);
    const saved = await only(h);
    expect(saved).toMatchObject({ status: "missed", missedCount: 1 });
    expect(saved.pending).toBeUndefined();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.text).toContain("会话已归档");

    h.clock.now += 5_000;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(1);
  });
});

describe("Q20-02 超时 timer 的生命周期与默认值", () => {
  const OUTCOMES: Array<[string, DeliverImpl]> = [
    ["delivered", async () => ({ kind: "delivered" })],
    ["retry", async () => ({ kind: "retry", reason: "忙" })],
    ["failed", async () => ({ kind: "failed", reason: "缺 API Key" })],
    [
      "抛异常",
      async () => {
        throw new Error("boom");
      },
    ],
  ];

  it.each(OUTCOMES)(
    "【对照 C2】deliver 以「%s」结束：runner 为它起的超时 timer 没有遗留（起了的都被 clearTimeout）",
    async (_name, impl) => {
      const watch = watchTimers();
      const h = await setup({ timeoutMs: MARK_MS });
      await create(h);
      h.setDeliver(impl);
      h.clock.now = DUE + 1_000;
      await h.runner.tick();

      // 改前根本没有超时 timer（created 为空，对照自然通过）；修后起了就必须清掉，否则每次投递都留一个 54 秒后才触发的 timer
      const leaked = watch.created().filter((handle) => !watch.cleared(handle));
      expect(leaked).toEqual([]);
    },
  );

  it("【回归 C2'】runner 确实为每次投递起了一个超时 timer（时长 = 注入值），并在 deliver 返回后清掉它", async () => {
    const watch = watchTimers();
    const h = await setup({ timeoutMs: MARK_MS });
    await create(h);
    h.clock.now = DUE + 1_000;
    await h.runner.tick();

    // 防「把超时整个删了、C2 对照却一直绿」：创建与清除都要真的发生
    const created = watch.created();
    expect(created, "每次投递应起一个超时 timer（改前没有）").toHaveLength(1);
    expect(watch.cleared(created[0])).toBe(true);
  });

  it("【回归 C3】默认超时常量 SCHEDULE_DELIVER_TIMEOUT_MS 在 5s ~ 120s 之间（只钉范围、不钉具体值），且短于投递窗口", () => {
    const v = deliverTimeoutConst();
    expect(v, "runner 应导出 SCHEDULE_DELIVER_TIMEOUT_MS（改前没有）").toBeTypeOf("number");
    // 下界 5s：要比下游**正常**路径里最慢的那一步长，否则会系统性地把正常投递误杀成「结果不明」。
    //   下游本身就有 5 秒级的内部等待（chat-inject 懒重启要等旧会话退出，CHAT_RESTART_STOP_TIMEOUT_MS = 5s），
    //   再加会话 resume / 落盘，正常路径可以到十几秒。低于 5s 必然误杀。
    // 上界 120s：要远短于「永远卡住」的代价——卡住期间同会话其它定时都在排队等这一条，而且 10 分钟投递窗口里
    //   至少要留出几次重试机会（120s 的超时在窗口里最多试 5 次）。
    expect(v as number).toBeGreaterThanOrEqual(5_000);
    expect(v as number).toBeLessThanOrEqual(120_000);
    expect(v as number).toBeLessThan(SCHEDULE_DELIVERY_WINDOW_MS);
  });
});
