/**
 * R14 Q20-01：同一轮 tick 里每一条定时共用「这一轮的起点时刻 tickNow」判到点 / 晚点 / 认领。
 *
 * ## 缺陷（改前）
 * `tickTask` 先用 tick 起点的 `now` 筛出「到点的」，但逐条进 `step → stepOne` 时每条又各自现取一次 `deps.now()`
 * 去做 `classifyDue` / `claimFire`。同一任务里同刻到点的甲、乙两条：甲的投递很慢（会话要先恢复，70 秒才返回），
 * 轮到乙时现取的时刻已比计划晚了 70 秒，超过容忍值（SCHEDULE_MISSED_TOLERANCE_MS = 60 秒）——
 * 乙被误判成「应用当时没开或电脑睡眠」而 missed：应用一直开着，是甲的慢拖累了乙。
 *
 * ## 修后
 * 整轮共用起点时刻 `tickNow`：「晚点」度量的是调度器发现它到点的时刻，不含前面兄弟占用的时间。
 * 睡眠唤醒后 tick 起点本身就晚了，仍会被正确判成错过（对照 C1）；手动「立即触发」`fireNow` 不变（对照 C3）。
 *
 * ## 用例分类（BF = 改前原样源码，SH = 修复后）
 *  - 回归（BF 必须红、SH 绿）：R1 / R1b / R2 / R3
 *  - 对照（BF、SH 都绿，证明没改过头）：C1 / C2a / C2b / C3a-c / C4a-b
 *
 * ## 写法
 * 沿用 tests/schedule-runner.test.ts 的 harness：假时钟 + 假投递 + 真落盘（数据目录在 import 前钉死）。
 * 「甲的投递很慢」= 甲的 deliver 里把假时钟往后拨一截再返回：不真等、不依赖机器负载，没有任何墙钟耗时断言。
 * 同一任务里的几条定时标题必须不同（甲 / 乙 / 丙）：Q20-05 之后 createSchedule 会把「完全等价」的活定时去重成一条。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-tick-now-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const runnerMod = await import("../src/lib/server/schedule-runner");
const store = await import("../src/lib/server/schedule-store");
const { taskDir } = await import("../src/lib/server/task-fs-core");
const { SCHEDULE_MISSED_TOLERANCE_MS, SCHEDULE_TICK_MS } = await import("../src/lib/schedule");

import type { ScheduleRecord } from "../src/lib/schedule";
import type { DeliverRequest, ScheduleRunner } from "../src/lib/server/schedule-runner";

const { createScheduleRunner, defaultStoreDeps, MISSED_NOTE } = runnerMod;

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 18, 2, 0, 0);
/** 全文件里「同刻到点」的计划时刻 */
const DUE = T0 + 10 * MIN;
/** 「甲的投递耗时」：比容忍值（60s）略长 = 70s——现取时刻的旧实现据此把乙判成晚点 */
const SLOW_MS = SCHEDULE_MISSED_TOLERANCE_MS + 10_000;

let seq = 0;
const freshTask = async (): Promise<string> => {
  seq += 1;
  const id = `t_tnow_${seq}`;
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

interface Harness {
  taskId: string;
  clock: { now: number };
  deliveries: DeliverRequest[];
  notices: Array<{ text: string; meta: Record<string, unknown> }>;
  /** 标题 → 这一条的投递「耗时」：deliver 里把假时钟往后拨这么多毫秒再返回 delivered */
  slow: Map<string, number>;
  runner: ScheduleRunner;
}

const setup = async (): Promise<Harness> => {
  const taskId = await freshTask();
  const clock = { now: T0 };
  const deliveries: DeliverRequest[] = [];
  const notices: Harness["notices"] = [];
  const slow = new Map<string, number>();
  const runner = createScheduleRunner({
    ...defaultStoreDeps(),
    liveTaskIds: () => [taskId], // 只扫本用例的任务，免得别的用例留下的记录串进来
    now: () => clock.now,
    deliver: async (req) => {
      deliveries.push(req);
      clock.now += slow.get(req.record.title) ?? 0; // 模拟这一条投递慢：时间在 deliver 里过去了
      return { kind: "delivered" };
    },
    notify: async (_t, text, meta) => {
      notices.push({ text, meta });
    },
  });
  return { taskId, clock, deliveries, notices, slow, runner };
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

/** 「错过」类提示：info 事件 meta.phase=missed（或正文带「没开 / 睡眠」的错过说明） */
const missedNotices = (h: Harness) =>
  h.notices.filter((n) => n.meta.phase === "missed" || n.text.includes(MISSED_NOTE));

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
  }
});

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* 清不掉就留给系统清 tmp，别让清理失败拖红测试 */
  }
});

describe("Q20-01 tickNow：同一轮里前一条投递慢，后一条仍按本轮起点判「准点」", () => {
  it("【回归 R1】同刻到点的两条一次性：甲投递耗时 70s，乙照常投递并 done，没有任何「错过」提示（改前：乙被误判 missed）", async () => {
    const h = await setup();
    await create(h, { title: "甲" });
    await create(h, { title: "乙" });
    h.slow.set("甲", SLOW_MS);
    h.clock.now = DUE + 1_000; // 本轮起点只晚了 1 秒
    await h.runner.tick();

    // 改前：deliveries 只有甲；乙是 missed（endNote = MISSED_NOTE），会话里多一条「没能按时触发」的提示
    expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲", "乙"]);
    const get = await records(h);
    expect(get("甲")).toMatchObject({ status: "done", fireCount: 1, missedCount: 0 });
    expect(get("乙")).toMatchObject({ status: "done", fireCount: 1, missedCount: 0 });
    expect(get("乙").history.map((e) => e.outcome)).toEqual(["fired"]);
    expect(missedNotices(h)).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(logLines().filter((l) => l.startsWith("[schedule] missed"))).toEqual([]);
  });

  it("【回归 R1b】三条同刻到点、前两条都慢（累计 140s）：第三条仍按本轮起点判「准点」，全部 done（改前：乙、丙都被误判 missed）", async () => {
    const h = await setup();
    await create(h, { title: "甲" });
    await create(h, { title: "乙" });
    await create(h, { title: "丙" });
    h.slow.set("甲", SLOW_MS);
    h.slow.set("乙", SLOW_MS);
    h.clock.now = DUE + 1_000;
    await h.runner.tick();

    expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲", "乙", "丙"]);
    const get = await records(h);
    for (const title of ["甲", "乙", "丙"]) {
      expect(get(title)).toMatchObject({ status: "done", fireCount: 1, missedCount: 0 });
    }
    expect(h.notices).toEqual([]);
  });

  it("【回归 R2】乙是周期定时、同刻到点：甲慢 70s，乙照常投递，missedCount 仍是 0、没有「错过了 N 次」提示（改前：乙被记错过）", async () => {
    const h = await setup();
    await create(h, { title: "甲" });
    await create(h, { title: "乙", kind: "every", intervalMs: 10 * MIN });
    h.slow.set("甲", SLOW_MS);
    h.clock.now = DUE + 1_000;
    await h.runner.tick();

    // 改前：乙走 markMissed（missedCount +1、nextFireAt 推到下一个节拍），会话里多一条「周期定时「乙」错过了一次…」
    expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲", "乙"]);
    expect((await records(h))("乙")).toMatchObject({
      status: "active",
      fireCount: 1,
      missedCount: 0,
      nextFireAt: DUE + 10 * MIN,
    });
    expect(missedNotices(h)).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it(
    "【回归 R3】甲慢 5 分钟、跨过乙（间隔 1 分钟）的好几个节拍：乙仍按本轮起点当作「准点」投一次；" +
      "nextFireAt 以 tickNow 推、lastFiredAt 记送达完成的真实时刻（改前：乙被记 6 次错过、没投递）",
    async () => {
      // 为什么是 5 分钟而不是更久：claimFire 用 tickNow 设 pending.since，而投递窗口（10 分钟）是在 doAttemptDelivery 里
      // 拿「现取的 deps.now()」对 since 判的。甲慢过窗口（比如 25 分钟）时，乙会「刚认领就窗口耗尽」而不是「准点投递」——
      // 这个边界行为含混（且真实环境里单次 deliver 被 60s 超时封顶，到不了），所以这里不钉；5 分钟 < 10 分钟窗口，行为单义。
      const h = await setup();
      await create(h, { title: "甲" });
      await create(h, { title: "乙", kind: "every", intervalMs: MIN });
      h.slow.set("甲", 5 * MIN);
      const tickNow = DUE + 1_000;
      h.clock.now = tickNow;
      await h.runner.tick();
      const finished = h.clock.now; // 甲慢完之后的「真实当前时刻」
      expect(finished).toBe(tickNow + 5 * MIN);

      expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲", "乙"]);
      const b = (await records(h))("乙");
      expect(b).toMatchObject({ status: "active", fireCount: 1, missedCount: 0 });
      expect(b.pending).toBeUndefined();
      // 认领用 tickNow：nextFireAt = 原节奏上第一个严格晚于 tickNow 的节拍 = DUE + 1 分钟。
      // 若按送达时的真实时刻（tickNow + 5 分钟）去推，会是 DUE + 6 分钟
      expect(b.nextFireAt).toBe(DUE + MIN);
      // 结算记账（markDelivered）取的是 deps.now()，即送达完成的真实时刻；而计划时刻 dueAt 仍是原来的 DUE
      expect(b.lastFiredAt).toBe(finished);
      expect(b.history.at(-1)).toMatchObject({ outcome: "fired", at: finished, dueAt: DUE });
      expect(missedNotices(h)).toEqual([]);

      // 后果：乙原定的 DUE+1m … DUE+5m 这几个节拍，在甲占着 tick 的那 5 分钟里已经真实地过去了——
      // 下一轮 tick 按真实时刻把它们如实记成错过，不补发（晚点的判定仍按真实时刻，只是不再算到同轮兄弟头上）
      h.clock.now = finished + SCHEDULE_TICK_MS;
      await h.runner.tick();
      expect(h.deliveries).toHaveLength(2);
      const b2 = (await records(h))("乙");
      expect(b2.fireCount).toBe(1);
      expect(b2.missedCount).toBeGreaterThanOrEqual(1);
      expect(b2.nextFireAt).toBeGreaterThan(h.clock.now);
    },
  );
});

describe("Q20-01 对照：没改过头（真晚了依旧错过 / 本轮没到点的下一轮再判 / 手动触发不变 / 容忍值边界）", () => {
  it("【对照 C1】睡眠 8 小时后的第一轮 tick：两条一次性都 missed、不投递（真的晚了依旧是错过）", async () => {
    const h = await setup();
    await create(h, { title: "甲" });
    await create(h, { title: "乙" });
    h.clock.now = T0 + 8 * 60 * MIN; // tick 起点本身就晚了 7 小时多
    await h.runner.tick();

    expect(h.deliveries).toEqual([]);
    const get = await records(h);
    for (const title of ["甲", "乙"]) {
      expect(get(title)).toMatchObject({
        status: "missed",
        missedCount: 1,
        fireCount: 0,
        endNote: MISSED_NOTE,
      });
    }
    expect(h.notices.map((n) => n.meta.phase)).toEqual(["missed", "missed"]);
  });

  it("【对照 C2a】本轮起点还没到点的乙（比甲晚 30s）：本轮不发；下一轮按下一轮的时刻判——晚了 40s ≤ 容忍值，触发", async () => {
    const h = await setup();
    await create(h, { title: "甲" });
    await create(h, { title: "乙", firstFireAt: DUE + 30_000 });
    // 甲慢到让「下一轮乙晚了 容忍值 − 20s（= 40s）」
    h.slow.set("甲", 30_000 + (SCHEDULE_MISSED_TOLERANCE_MS - 20_000));
    h.clock.now = DUE;
    await h.runner.tick();

    // 第 1 轮：乙在本轮起点（DUE）还没到点 → 不在待处理名单里，哪怕甲投完时它按真实时刻已经到点了
    expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲"]);
    expect((await records(h))("乙")).toMatchObject({
      status: "active",
      fireCount: 0,
      missedCount: 0,
      nextFireAt: DUE + 30_000,
    });

    // 第 2 轮：时钟停在甲投递完的那一刻，乙晚了 40s（≤ 60s 容忍值）→ 仍触发
    expect(h.clock.now - (DUE + 30_000)).toBe(SCHEDULE_MISSED_TOLERANCE_MS - 20_000);
    await h.runner.tick();
    expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲", "乙"]);
    expect((await records(h))("乙")).toMatchObject({ status: "done", fireCount: 1 });
    expect(h.notices).toEqual([]);
  });

  it("【对照 C2b】同上，但甲更慢：下一轮乙晚了 90s > 容忍值 → missed（本轮没处理它，不等于永远算准点）", async () => {
    const h = await setup();
    await create(h, { title: "甲" });
    await create(h, { title: "乙", firstFireAt: DUE + 30_000 });
    h.slow.set("甲", 30_000 + (SCHEDULE_MISSED_TOLERANCE_MS + 30_000));
    h.clock.now = DUE;
    await h.runner.tick();
    expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲"]);
    expect((await records(h))("乙").status).toBe("active");

    expect(h.clock.now - (DUE + 30_000)).toBe(SCHEDULE_MISSED_TOLERANCE_MS + 30_000);
    await h.runner.tick();
    expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲"]); // 乙没有被投递
    expect((await records(h))("乙")).toMatchObject({
      status: "missed",
      missedCount: 1,
      fireCount: 0,
      endNote: MISSED_NOTE,
    });
    expect(h.notices.map((n) => n.meta.phase)).toEqual(["missed"]);
  });

  it("【对照 C3a】fireNow：进行中的一次性、还没到点也立即投递，送达后 done；不经过 tickNow / 晚点判定", async () => {
    const h = await setup();
    const rec = await create(h, { title: "甲" });
    h.clock.now = T0 + MIN; // 离计划时刻还远
    const r = await h.runner.fireNow(h.taskId, rec.id);

    expect(r).toMatchObject({ ok: true, outcome: "delivered" });
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]!.pending.manual).toBe(true);
    expect(h.deliveries[0]!.text).toContain("立即触发");
    expect((await records(h))("甲")).toMatchObject({ status: "done", fireCount: 1, missedCount: 0 });
  });

  it("【对照 C3b】fireNow：周期定时额外多发一次，不改原计划（下一次仍在原来的节拍上）", async () => {
    const h = await setup();
    const rec = await create(h, { title: "乙", kind: "every", intervalMs: 10 * MIN });
    h.clock.now = T0 + 3 * MIN;
    await h.runner.fireNow(h.taskId, rec.id);

    expect((await records(h))("乙")).toMatchObject({
      status: "active",
      fireCount: 1,
      missedCount: 0,
      nextFireAt: DUE,
    });
  });

  it("【对照 C3c】fireNow：进行中的一次性已过点 8 小时（tick 一直没跑）也直接送，不判晚点；之后 tick 不再重复处理它", async () => {
    const h = await setup();
    const rec = await create(h, { title: "甲" });
    h.clock.now = T0 + 8 * 60 * MIN; // 远超容忍值：走 tick 会被判 missed，但手动触发不走这条判定
    const r = await h.runner.fireNow(h.taskId, rec.id);
    expect(r).toMatchObject({ ok: true, outcome: "delivered" });
    expect((await records(h))("甲")).toMatchObject({ status: "done", fireCount: 1, missedCount: 0 });

    h.clock.now += SCHEDULE_TICK_MS;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });

  it("【对照 C4a】迟到恰好等于容忍值：并排的两条都仍触发（调度器 5s 一跳的抖动不能判成错过，多条并排时同样成立）", async () => {
    const h = await setup();
    await create(h, { title: "甲" });
    await create(h, { title: "乙" });
    h.clock.now = DUE + SCHEDULE_MISSED_TOLERANCE_MS;
    await h.runner.tick();

    expect(h.deliveries.map((d) => d.record.title)).toEqual(["甲", "乙"]);
    const get = await records(h);
    expect(get("甲")).toMatchObject({ status: "done", fireCount: 1 });
    expect(get("乙")).toMatchObject({ status: "done", fireCount: 1 });
    expect(h.notices).toEqual([]);
  });

  it("【对照 C4b】迟到比容忍值多 1ms：并排的两条都 missed（边界另一侧）", async () => {
    const h = await setup();
    await create(h, { title: "甲" });
    await create(h, { title: "乙" });
    h.clock.now = DUE + SCHEDULE_MISSED_TOLERANCE_MS + 1;
    await h.runner.tick();

    expect(h.deliveries).toEqual([]);
    const get = await records(h);
    expect(get("甲").status).toBe("missed");
    expect(get("乙").status).toBe("missed");
  });
});
