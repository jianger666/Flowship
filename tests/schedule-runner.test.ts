/**
 * 定时任务调度核心（`schedule-runner`）：假时钟 + 假投递 + 真落盘，把语义钉死。
 *
 * 用户拍板的口径（2026-10-18）：
 *  - 应用没开 / 睡眠醒来：到期的不触发（只记错过），和 Codex 一致
 *  - 会话忙：窗口内重试，窗口耗尽记失败（一次性 → missed，可手动拉回）
 *  - 「立即触发」是额外多发一次，不改原计划
 *
 * DATA_DIR 须在动态 import 前钉死。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-runner-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const runnerMod = await import("../src/lib/server/schedule-runner");
const store = await import("../src/lib/server/schedule-store");
const { taskDir } = await import("../src/lib/server/task-fs-core");
const {
  SCHEDULE_DELIVERY_WINDOW_MS,
  SCHEDULE_MISSED_TOLERANCE_MS,
  SCHEDULE_SOURCE,
  SCHEDULE_SUBKIND,
} = await import("../src/lib/schedule");

import type { DeliverOutcome, DeliverRequest, ScheduleRunnerDeps } from "../src/lib/server/schedule-runner";

const { createScheduleRunner, classifyInjectResponse, defaultStoreDeps, MISSED_NOTE } = runnerMod;

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 18, 2, 0, 0);

let seq = 0;
const freshTask = async (): Promise<string> => {
  seq += 1;
  const id = `t_run_${seq}`;
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

interface Harness {
  taskId: string;
  clock: { now: number };
  deliveries: DeliverRequest[];
  notices: Array<{ text: string; meta: Record<string, unknown> }>;
  setOutcome: (o: DeliverOutcome | (() => Promise<DeliverOutcome>)) => void;
  runner: ReturnType<typeof createScheduleRunner>;
}

const setup = async (): Promise<Harness> => {
  const taskId = await freshTask();
  const clock = { now: T0 };
  const deliveries: DeliverRequest[] = [];
  const notices: Harness["notices"] = [];
  let outcome: DeliverOutcome | (() => Promise<DeliverOutcome>) = { kind: "delivered" };
  const runner = createScheduleRunner({
    ...defaultStoreDeps(),
    liveTaskIds: () => [taskId], // 只扫本用例的任务，免得别的用例留下的记录串进来
    now: () => clock.now,
    deliver: async (req) => {
      deliveries.push(req);
      return typeof outcome === "function" ? outcome() : outcome;
    },
    notify: async (_t, text, meta) => {
      notices.push({ text, meta });
    },
  });
  return {
    taskId,
    clock,
    deliveries,
    notices,
    setOutcome: (o) => {
      outcome = o;
    },
    runner,
  };
};

const create = async (
  h: Harness,
  over: Partial<Parameters<typeof store.createSchedule>[1]> = {},
) => {
  const r = await store.createSchedule(
    h.taskId,
    {
      kind: "once",
      title: "看 CI",
      message: "去看 CI 结果",
      firstFireAt: T0 + 10 * MIN,
      ...over,
    } as Parameters<typeof store.createSchedule>[1],
    T0,
  );
  if (!r.ok) throw new Error(r.error);
  return r.record;
};

const only = async (h: Harness) => {
  const list = await store.readSchedules(h.taskId);
  expect(list).toHaveLength(1);
  return list[0]!;
};

beforeEach(() => {
  runnerMod.__resetScheduleRunnerStateForTest();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const logLines = (): string[] =>
  (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("[schedule] "));

describe("tick：到点 / 没到点", () => {
  it("没到点 → 什么都不发", async () => {
    const h = await setup();
    await create(h);
    h.clock.now = T0 + 10 * MIN - 1;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(0);
    expect((await only(h)).status).toBe("active");
  });

  it("到点 → 投递一次；一次性送达后 done；投递内容带 source=schedule 与 fire 前缀", async () => {
    const h = await setup();
    const rec = await create(h);
    h.clock.now = T0 + 10 * MIN + 3_000;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(1);
    const d = h.deliveries[0]!;
    expect(d.taskId).toBe(h.taskId);
    expect(d.text.startsWith(`[SCHEDULE_FIRED id=${rec.id}]`)).toBe(true);
    expect(d.meta).toMatchObject({ source: SCHEDULE_SOURCE, scheduleId: rec.id, scheduleSeq: 1 });
    expect(d.clientItemId).toBe(`${rec.id}.1.1`);
    const saved = await only(h);
    expect(saved).toMatchObject({ status: "done", fireCount: 1 });
    expect(saved.pending).toBeUndefined();
    // 之后再 tick 不会重复发
    h.clock.now += MIN;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(1);
  });

  it("迟到刚好在容忍值内仍触发（调度器 5s 一跳的抖动不能判成错过）", async () => {
    const h = await setup();
    await create(h);
    h.clock.now = T0 + 10 * MIN + SCHEDULE_MISSED_TOLERANCE_MS;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(1);
  });
});

describe("睡眠 / 应用没开：错过不补", () => {
  it("一次性晚了超过容忍值 → missed，不投递；写一条提示并告诉用户可以去「立即触发」", async () => {
    const h = await setup();
    await create(h);
    h.clock.now = T0 + 8 * 60 * MIN; // 睡了 8 小时
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(0);
    const saved = await only(h);
    expect(saved).toMatchObject({ status: "missed", missedCount: 1, fireCount: 0, endNote: MISSED_NOTE });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.text).toContain("立即触发");
    expect(h.notices[0]!.meta).toMatchObject({ subkind: SCHEDULE_SUBKIND, scheduleId: saved.id });
  });

  it("周期：错过的几个节拍如实记账，不补发；下一次仍落在原节奏上，之后照常触发", async () => {
    const h = await setup();
    await create(h, { kind: "every", intervalMs: 10 * MIN, firstFireAt: T0 + 10 * MIN });
    h.clock.now = T0 + 47 * MIN; // 错过 10/20/30/40
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(0);
    let saved = await only(h);
    expect(saved).toMatchObject({ status: "active", missedCount: 4, nextFireAt: T0 + 50 * MIN });
    expect(h.notices[0]!.text).toContain("错过了 4 次");
    expect(h.notices[0]!.text).toContain("继续");

    h.clock.now = T0 + 50 * MIN + 2_000;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(1);
    saved = await only(h);
    expect(saved).toMatchObject({ status: "active", fireCount: 1, nextFireAt: T0 + 60 * MIN });
  });
});

describe("会话忙：窗口内重试，耗尽记失败", () => {
  it("retry → 保留待投递、不记已触发；下个 tick 再试，用新的幂等键；送达后结算", async () => {
    const h = await setup();
    const rec = await create(h);
    h.setOutcome({ kind: "retry", reason: "会话正忙" });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    let saved = await only(h);
    expect(saved.pending).toMatchObject({ seq: 1 });
    expect(saved).toMatchObject({ status: "active", fireCount: 0 });

    h.clock.now += 5_000;
    await h.runner.tick();
    expect(h.deliveries.map((d) => d.clientItemId)).toEqual([`${rec.id}.1.1`, `${rec.id}.1.2`]);

    h.setOutcome({ kind: "delivered" });
    h.clock.now += 5_000;
    await h.runner.tick();
    saved = await only(h);
    expect(saved).toMatchObject({ status: "done", fireCount: 1 });
    expect(saved.pending).toBeUndefined();
    expect(h.deliveries).toHaveLength(3);
  });

  it("投递抛异常按「暂时送不进」处理，不吞掉定时也不把调度器带崩", async () => {
    const h = await setup();
    await create(h);
    h.setOutcome(async () => {
      throw new Error("boom");
    });
    h.clock.now = T0 + 10 * MIN;
    await expect(h.runner.tick()).resolves.toBeUndefined();
    expect((await only(h)).pending).toBeDefined();
  });

  it("窗口耗尽仍送不进：一次性 → missed 并提示；不再继续投递", async () => {
    const h = await setup();
    await create(h);
    h.setOutcome({ kind: "retry", reason: "忙" });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    h.clock.now += SCHEDULE_DELIVERY_WINDOW_MS + 1_000;
    const before = h.deliveries.length;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(before); // 窗口外不再投
    const saved = await only(h);
    expect(saved.status).toBe("missed");
    expect(saved.pending).toBeUndefined();
    expect(h.notices.at(-1)!.text).toContain("没能送进会话");
    expect(h.notices.at(-1)!.meta).toMatchObject({ scheduleId: saved.id });
  });

  it("永久失败（会话没了 / 缺凭据）→ 立刻记失败并提示，不重试", async () => {
    const h = await setup();
    await create(h);
    h.setOutcome({ kind: "failed", reason: "会话已归档" });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(1);
    expect((await only(h)).status).toBe("missed");
    expect(h.notices[0]!.text).toContain("会话已归档");
    h.clock.now += 5_000;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(1);
  });

  it("周期的这一次失败不影响下一次", async () => {
    const h = await setup();
    await create(h, { kind: "every", intervalMs: 10 * MIN, firstFireAt: T0 + 10 * MIN });
    h.setOutcome({ kind: "failed", reason: "暂时不可用" });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    const saved = await only(h);
    expect(saved).toMatchObject({ status: "active", missedCount: 1, nextFireAt: T0 + 20 * MIN });
    h.setOutcome({ kind: "delivered" });
    h.clock.now = T0 + 20 * MIN;
    await h.runner.tick();
    expect((await only(h)).fireCount).toBe(1);
  });
});

describe("周期：按节奏连续触发，max_runs 用完结束", () => {
  it("每 10 分钟，共 3 次：三次之后 done，不再触发", async () => {
    const h = await setup();
    await create(h, { kind: "every", intervalMs: 10 * MIN, firstFireAt: T0 + 10 * MIN, maxRuns: 3 });
    for (const m of [10, 20, 30]) {
      h.clock.now = T0 + m * MIN + 1_000;
      await h.runner.tick();
    }
    expect(h.deliveries).toHaveLength(3);
    expect(h.deliveries.map((d) => d.meta.scheduleSeq)).toEqual([1, 2, 3]);
    expect(await only(h)).toMatchObject({ status: "done", fireCount: 3 });
    h.clock.now = T0 + 40 * MIN;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(3);
  });
});

describe("并发：同一条不会被两个步进同时处理", () => {
  it("两个 tick 同时跑 + 投递很慢 → 只投一次", async () => {
    const h = await setup();
    await create(h);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.setOutcome(async () => {
      await gate;
      return { kind: "delivered" };
    });
    h.clock.now = T0 + 10 * MIN;
    const a = h.runner.tick();
    const b = h.runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    release();
    await Promise.all([a, b]);
    expect(h.deliveries).toHaveLength(1);
    expect((await only(h)).fireCount).toBe(1);
  });

  it("两个调度器实例（模拟 dev 下重复加载的模块）共享同一份 inflight：仍只投一次", async () => {
    const h = await setup();
    await create(h);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.setOutcome(async () => {
      await gate;
      return { kind: "delivered" };
    });
    const second = createScheduleRunner({
      ...defaultStoreDeps(),
      liveTaskIds: () => [h.taskId],
      now: () => h.clock.now,
      deliver: async (req) => {
        h.deliveries.push(req);
        return { kind: "delivered" };
      },
      notify: async () => {},
    });
    h.clock.now = T0 + 10 * MIN;
    const a = h.runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    const b = second.tick();
    await new Promise((r) => setTimeout(r, 30));
    release();
    await Promise.all([a, b]);
    expect(h.deliveries).toHaveLength(1);
  });
});

describe("fireNow：立即触发（额外多发一次）", () => {
  it("进行中的一次性：现在就送，送达后 done", async () => {
    const h = await setup();
    const rec = await create(h);
    h.clock.now = T0 + MIN;
    const r = await h.runner.fireNow(h.taskId, rec.id);
    expect(r).toMatchObject({ ok: true, outcome: "delivered" });
    expect(h.deliveries[0]!.pending.manual).toBe(true);
    expect(h.deliveries[0]!.text).toContain("立即触发");
    expect(await only(h)).toMatchObject({ status: "done", fireCount: 1 });
  });

  it("周期的：不改原计划，下一次照旧", async () => {
    const h = await setup();
    const rec = await create(h, { kind: "every", intervalMs: 10 * MIN, firstFireAt: T0 + 10 * MIN });
    h.clock.now = T0 + 3 * MIN;
    await h.runner.fireNow(h.taskId, rec.id);
    expect(await only(h)).toMatchObject({ status: "active", fireCount: 1, nextFireAt: T0 + 10 * MIN });
  });

  it("已错过的一次性：拉回来再送，送达后是 done 而不是又 missed", async () => {
    const h = await setup();
    const rec = await create(h);
    h.clock.now = T0 + 8 * 60 * MIN;
    await h.runner.tick();
    expect((await only(h)).status).toBe("missed");
    const r = await h.runner.fireNow(h.taskId, rec.id);
    expect(r).toMatchObject({ ok: true, outcome: "delivered" });
    expect(await only(h)).toMatchObject({ status: "done", fireCount: 1, missedCount: 1 });
  });

  it("已结束 / 不存在 / 任务没了 → 对应错误码", async () => {
    const h = await setup();
    const rec = await create(h);
    await store.cancelSchedule(h.taskId, rec.id, "x", T0);
    expect(await h.runner.fireNow(h.taskId, rec.id)).toMatchObject({ ok: false, code: "bad_state" });
    expect(await h.runner.fireNow(h.taskId, "sch_nope")).toMatchObject({ ok: false, code: "not_found" });
    expect(await h.runner.fireNow("t_run_gone", "sch_x")).toMatchObject({ ok: false, code: "task_gone" });
    expect(h.deliveries).toHaveLength(0);
  });

  it("会话忙：返回 retry，待投递留着，由后台 tick 接着送（不丢）", async () => {
    const h = await setup();
    const rec = await create(h);
    h.setOutcome({ kind: "retry", reason: "忙" });
    h.clock.now = T0 + MIN;
    const r = await h.runner.fireNow(h.taskId, rec.id);
    expect(r).toMatchObject({ ok: true, outcome: "retry" });
    expect((await only(h)).pending).toBeDefined();
    h.setOutcome({ kind: "delivered" });
    h.clock.now += 5_000;
    await h.runner.tick();
    expect(await only(h)).toMatchObject({ status: "done", fireCount: 1 });
  });

  it("这条正在送达时再点 → busy，不会双发", async () => {
    const h = await setup();
    const rec = await create(h);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.setOutcome(async () => {
      await gate;
      return { kind: "delivered" };
    });
    h.clock.now = T0 + MIN;
    const first = h.runner.fireNow(h.taskId, rec.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(await h.runner.fireNow(h.taskId, rec.id)).toMatchObject({ ok: false, code: "busy" });
    release();
    await first;
    expect(h.deliveries).toHaveLength(1);
  });
});

describe("暂停 / 取消的不会被调度", () => {
  it("暂停中的到点也不发；取消后同理", async () => {
    const h = await setup();
    const a = await create(h);
    const b = await create(h, { title: "另一条" });
    await store.pauseSchedule(h.taskId, a.id, T0);
    await store.cancelSchedule(h.taskId, b.id, "x", T0);
    h.clock.now = T0 + 10 * MIN + 1_000;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(0);
  });
});

describe("classifyInjectResponse：下游 HTTP 响应 → 三类结果", () => {
  const cases: Array<[number, unknown, DeliverOutcome["kind"]]> = [
    [200, {}, "delivered"],
    [202, { queued: true }, "delivered"], // 排进会话队列，下游保证稍后送出
    [200, { settled: true, outcome: "delivered" }, "delivered"],
    [200, { settled: true, outcome: "busy" }, "retry"], // 幂等回放了一次「已失败」结算
    [409, { error: "会话正忙" }, "retry"],
    [500, {}, "retry"],
    [503, {}, "retry"],
    [404, {}, "failed"],
    [400, { error: "缺少模型" }, "failed"],
    [401, {}, "failed"],
    [422, null, "failed"],
  ];
  for (const [status, body, kind] of cases) {
    it(`HTTP ${status} ${JSON.stringify(body)} → ${kind}`, () => {
      expect(classifyInjectResponse(status, body).kind).toBe(kind);
    });
  }

  it("把下游的话带出去；没有就给兜底文案", () => {
    expect(classifyInjectResponse(400, { error: "缺少模型" })).toEqual({ kind: "failed", reason: "缺少模型" });
    // 404 = 会话没了：再等多久也送不进去 → permanent（周期定时据此直接取消）
    expect(classifyInjectResponse(404, {})).toEqual({
      kind: "failed",
      reason: "会话已不存在",
      permanent: true,
    });
    const r = classifyInjectResponse(409, {});
    expect(r.kind === "retry" && r.reason).toContain("409");
  });
});

/** 在 setup 的基础上换掉个别依赖（拿来数 mutate 调用 / 注入读写故障） */
const runnerWith = (h: Harness, over: Partial<ScheduleRunnerDeps>) =>
  createScheduleRunner({
    ...defaultStoreDeps(),
    liveTaskIds: () => [h.taskId],
    now: () => h.clock.now,
    deliver: async (req) => {
      h.deliveries.push(req);
      return { kind: "delivered" };
    },
    notify: async (_t, text, meta) => {
      h.notices.push({ text, meta });
    },
    ...over,
  });

const warnCount = (needle: string): number =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) =>
    String(c[0]).includes(needle),
  ).length;

describe("周期定时送不进去：永久失败自取消 / 连续失败自暂停（review 🔴2）", () => {
  it("永久失败（会话已归档 / 任务已终结）→ 周期定时直接取消，并告诉用户；之后不再每个周期失败一次", async () => {
    const h = await setup();
    await create(h, { kind: "every", intervalMs: 10 * MIN, firstFireAt: T0 + 10 * MIN });
    h.setOutcome({ kind: "failed", reason: "会话已归档", permanent: true });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    const saved = await only(h);
    expect(saved).toMatchObject({ status: "cancelled", nextFireAt: null });
    expect(saved.endNote).toContain("自动取消");
    expect(h.notices.at(-1)!.text).toContain("已自动取消");
    h.clock.now = T0 + 60 * MIN;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(1);
  });

  it("永久失败的一次性仍是 missed（保留记录、可手动拉回），不是 cancelled", async () => {
    const h = await setup();
    await create(h);
    h.setOutcome({ kind: "failed", reason: "会话已归档", permanent: true });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    expect((await only(h)).status).toBe("missed");
  });

  it("非永久失败连续 3 次 → 自动暂停并提示；暂停后不再投递，恢复后按新节奏继续", async () => {
    const h = await setup();
    await create(h, { kind: "every", intervalMs: 10 * MIN, firstFireAt: T0 + 10 * MIN });
    h.setOutcome({ kind: "failed", reason: "缺 API Key" });
    for (const m of [10, 20]) {
      h.clock.now = T0 + m * MIN;
      await h.runner.tick();
      expect((await only(h)).status).toBe("active");
    }
    h.clock.now = T0 + 30 * MIN;
    await h.runner.tick();
    const saved = await only(h);
    expect(saved.status).toBe("paused");
    expect(h.notices.at(-1)!.text).toContain("已自动暂停");
    expect(h.notices.at(-1)!.text).toContain("缺 API Key");
    const n = h.deliveries.length;
    h.clock.now = T0 + 90 * MIN;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(n);

    await store.resumeSchedule(h.taskId, saved.id, h.clock.now);
    h.setOutcome({ kind: "delivered" });
    h.clock.now += 10 * MIN;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(n + 1);
    expect(await only(h)).toMatchObject({ status: "active", fireCount: 1 });
  });

  it("窗口耗尽的失败也计入连续失败（一直忙 / 一直有未答提问的周期定时同样会自停）", async () => {
    const h = await setup();
    // 间隔取 60 分钟（> 投递窗口 10 分钟）：窗口耗尽发生在下一个节拍之前，场景才干净
    await create(h, { kind: "every", intervalMs: 60 * MIN, firstFireAt: T0 + 60 * MIN });
    h.setOutcome({ kind: "retry", reason: "忙" });
    let t = T0 + 60 * MIN;
    for (let i = 0; i < 3; i++) {
      h.clock.now = t;
      await h.runner.tick(); // 认领 + 第一次 retry
      h.clock.now = t + SCHEDULE_DELIVERY_WINDOW_MS + 1_000;
      await h.runner.tick(); // 窗口耗尽 → failed
      t += 60 * MIN;
    }
    expect((await only(h)).status).toBe("paused");
  });
});

describe("tick 预过滤 / 重入保护 / 读失败节流（review 🟡）", () => {
  it("没到点的 active 记录不抢任务锁：整轮 tick 一次 mutate 都不调", async () => {
    const h = await setup();
    await create(h, { kind: "every", intervalMs: 10 * MIN, firstFireAt: T0 + 60 * MIN });
    await create(h, { firstFireAt: T0 + 120 * MIN, title: "晚点的一次性" });
    const mutate = vi.fn(store.mutateSchedules) as unknown as ScheduleRunnerDeps["mutate"];
    const runner = runnerWith(h, { mutate });
    h.clock.now = T0 + MIN;
    await runner.tick();
    await runner.tick();
    expect(mutate).not.toHaveBeenCalled();
    expect(h.deliveries).toHaveLength(0);
  });

  it("只有真有事的那条才去 mutate：一条到点 + 一条没到点 → 只对到点的那条处理", async () => {
    const h = await setup();
    await create(h, { firstFireAt: T0 + 10 * MIN, title: "到点的" });
    await create(h, { firstFireAt: T0 + 300 * MIN, title: "没到点的" });
    const mutate = vi.fn(store.mutateSchedules) as unknown as ScheduleRunnerDeps["mutate"];
    const runner = runnerWith(h, { mutate });
    h.clock.now = T0 + 10 * MIN;
    await runner.tick();
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]!.record.title).toBe("到点的");
    // 认领 + 结算 = 2 次；没到点的那条没有参与
    expect((mutate as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it("有待投递（pending）的记录即使 classifyDue 说没到点也要处理（它在等下一次重试）", async () => {
    const h = await setup();
    await create(h);
    h.setOutcome({ kind: "retry", reason: "忙" });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    expect((await only(h)).pending).toBeDefined();
    h.clock.now += 5_000;
    await h.runner.tick();
    expect(h.deliveries).toHaveLength(2);
  });

  it("读完列表后校正索引（syncIndex 收到该任务读到的列表）", async () => {
    const h = await setup();
    await create(h);
    const syncIndex = vi.fn();
    const runner = runnerWith(h, { syncIndex });
    await runner.tick();
    expect(syncIndex).toHaveBeenCalledTimes(1);
    expect(syncIndex.mock.calls[0]![0]).toBe(h.taskId);
    expect(syncIndex.mock.calls[0]![1]).toHaveLength(1);
  });

  it("同任务的上一轮 tick 还没处理完（投递很慢）→ 下一轮直接跳过，不重入、不重复读", async () => {
    const h = await setup();
    await create(h);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = vi.fn(defaultStoreDeps().read);
    const runner = runnerWith(h, {
      read,
      deliver: async (req) => {
        h.deliveries.push(req);
        await gate;
        return { kind: "delivered" };
      },
    });
    h.clock.now = T0 + 10 * MIN;
    const a = runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    const readsBefore = read.mock.calls.length;
    await runner.tick(); // 被跳过：立刻返回
    expect(read.mock.calls.length).toBe(readsBefore);
    release();
    await a;
    expect(h.deliveries).toHaveLength(1);
    // 上一轮结束后可以正常再 tick
    await runner.tick();
    expect(read.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it("别的任务的慢投递不拖住这个任务（只按任务隔离，不是全局串行）", async () => {
    const a = await setup();
    const b = await setup();
    await create(a);
    await create(b);
    a.clock.now = b.clock.now = T0 + 10 * MIN;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    const runner = createScheduleRunner({
      ...defaultStoreDeps(),
      liveTaskIds: () => [a.taskId, b.taskId],
      now: () => a.clock.now,
      deliver: async (req) => {
        log.push(`start:${req.taskId === a.taskId ? "a" : "b"}`);
        if (req.taskId === a.taskId) await gate;
        log.push(`end:${req.taskId === a.taskId ? "a" : "b"}`);
        return { kind: "delivered" };
      },
      notify: async () => {},
    });
    const ticking = runner.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(log).toContain("end:b"); // a 还卡着，b 已经送完
    expect(log).not.toContain("end:a");
    release();
    await ticking;
    expect(log).toContain("end:a");
  });

  it("某个任务读失败：不带崩 tick，别的任务照常；告警每任务每分钟最多一条", async () => {
    const bad = await setup();
    const good = await setup();
    await create(good);
    good.clock.now = T0 + 10 * MIN;
    const real = defaultStoreDeps().read;
    const runner = createScheduleRunner({
      ...defaultStoreDeps(),
      liveTaskIds: () => [bad.taskId, good.taskId],
      read: async (id) => {
        if (id === bad.taskId) throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
        return real(id);
      },
      now: () => good.clock.now,
      deliver: async (req) => {
        good.deliveries.push(req);
        return { kind: "delivered" };
      },
      notify: async () => {},
    });
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(good.deliveries).toHaveLength(1);
    expect(warnCount("读取失败")).toBe(1);
    for (let i = 0; i < 5; i++) {
      good.clock.now += 5_000;
      await runner.tick();
    }
    expect(warnCount("读取失败")).toBe(1); // 一分钟内不重复刷
    good.clock.now += 61_000;
    await runner.tick();
    expect(warnCount("读取失败")).toBe(2);
  });
});

describe("同会话串行投递（review 🟡：同一时刻到点的多条不并行过同一道「空闲」判断）", () => {
  it("同任务两条同时到点：一条送完（含结算）才送下一条，不重叠", async () => {
    const h = await setup();
    await create(h, { title: "甲", firstFireAt: T0 + 10 * MIN });
    await create(h, { title: "乙", firstFireAt: T0 + 10 * MIN });
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const runner = runnerWith(h, {
      deliver: async (req) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${req.record.title}`);
        await new Promise((r) => setTimeout(r, 25));
        order.push(`end:${req.record.title}`);
        active -= 1;
        return { kind: "delivered" };
      },
    });
    h.clock.now = T0 + 10 * MIN;
    await runner.tick();
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start:甲", "end:甲", "start:乙", "end:乙"]);
    const list = await store.readSchedules(h.taskId);
    expect(list.every((r) => r.status === "done")).toBe(true);
  });

  it("前一条投递抛异常不阻塞后一条", async () => {
    const h = await setup();
    await create(h, { title: "甲", firstFireAt: T0 + 10 * MIN });
    await create(h, { title: "乙", firstFireAt: T0 + 10 * MIN });
    const runner = runnerWith(h, {
      deliver: async (req) => {
        if (req.record.title === "甲") throw new Error("boom");
        h.deliveries.push(req);
        return { kind: "delivered" };
      },
    });
    h.clock.now = T0 + 10 * MIN;
    await runner.tick();
    expect(h.deliveries.map((d) => d.record.title)).toEqual(["乙"]);
  });

  it("手动触发与后台 tick 对同一会话也走同一条串行链（不并行投）", async () => {
    const h = await setup();
    const a = await create(h, { title: "甲", firstFireAt: T0 + 10 * MIN });
    await create(h, { title: "乙", firstFireAt: T0 + 300 * MIN });
    let active = 0;
    let maxActive = 0;
    const runner = runnerWith(h, {
      deliver: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        return { kind: "delivered" };
      },
    });
    h.clock.now = T0 + 10 * MIN;
    const list = await store.readSchedules(h.taskId);
    const b = list.find((r) => r.title === "乙")!;
    await Promise.all([runner.tick(), runner.fireNow(h.taskId, b.id)]);
    expect(maxActive).toBe(1);
    expect(a.id).not.toBe(b.id);
  });
});

describe("幂等键：结果不明沿用同键，明确没送达换新键（review 🟡：否则就是重复投递）", () => {
  it("deliver 抛异常（下游可能已受理）→ 下一次重试沿用同一个键；明确 retry 之后才换新键", async () => {
    const h = await setup();
    const rec = await create(h);
    let step = 0;
    const runner = runnerWith(h, {
      deliver: async (req) => {
        h.deliveries.push(req);
        step += 1;
        if (step === 1) throw new Error("连接中断，不知道下游收没收到");
        if (step === 2) return { kind: "retry", reason: "忙" } as const;
        return { kind: "delivered" } as const;
      },
    });
    h.clock.now = T0 + 10 * MIN;
    await runner.tick(); // #1 抛 → 结果不明
    h.clock.now += 5_000;
    await runner.tick(); // #2 沿用同键，下游明确说忙
    h.clock.now += 5_000;
    await runner.tick(); // #3 明确没送达 → 新键
    expect(h.deliveries.map((d) => d.clientItemId)).toEqual([`${rec.id}.1.1`, `${rec.id}.1.1`, `${rec.id}.1.2`]);
    expect((await only(h)).status).toBe("done");
  });

  it("已送达但「已送达」没写成功（mutate 抛）→ 下个 tick 再投时沿用同键，下游认作回放", async () => {
    const h = await setup();
    const rec = await create(h);
    const real = defaultStoreDeps().mutate;
    let calls = 0;
    const mutate = (async (...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("磁盘 IO"), { code: "EIO" }); // 第 1 次是认领，第 2 次是结算
      return real(...args);
    }) as unknown as ScheduleRunnerDeps["mutate"];
    const runner = runnerWith(h, { mutate });
    h.clock.now = T0 + 10 * MIN;
    await runner.tick();
    expect(h.deliveries).toHaveLength(1);
    expect((await only(h)).pending).toBeDefined(); // 结算没写成
    h.clock.now += 5_000;
    await runner.tick();
    expect(h.deliveries.map((d) => d.clientItemId)).toEqual([`${rec.id}.1.1`, `${rec.id}.1.1`]);
    expect((await only(h)).status).toBe("done");
  });

  it("每一次都是明确 retry：键一路递增（原有语义不变）", async () => {
    const h = await setup();
    const rec = await create(h);
    h.setOutcome({ kind: "retry", reason: "忙" });
    h.clock.now = T0 + 10 * MIN;
    for (let i = 0; i < 3; i++) {
      await h.runner.tick();
      h.clock.now += 5_000;
    }
    expect(h.deliveries.map((d) => d.clientItemId)).toEqual([`${rec.id}.1.1`, `${rec.id}.1.2`, `${rec.id}.1.3`]);
  });
});

describe("成功路径的日志（review 🟢：排查「为什么没触发」不该只能翻 schedules.json）", () => {
  it("认领 / 送达各一行，带 task / id / seq；认领行带「晚了多久」", async () => {
    const h = await setup();
    const rec = await create(h);
    h.clock.now = T0 + 10 * MIN + 7_000;
    await h.runner.tick();
    const lines = logLines();
    expect(lines.some((l) => l.includes("claimed") && l.includes(`id=${rec.id}`) && l.includes("late=7s"))).toBe(true);
    expect(lines.some((l) => l.includes("delivered") && l.includes(`task=${h.taskId}`) && l.includes("seq=1"))).toBe(true);
  });

  it("错过：日志里有 dueAt 和 late（App Nap / 睡眠让 tick 晚到时一眼看出晚了多久）；记录历史里也留着 at / dueAt", async () => {
    const h = await setup();
    const rec = await create(h);
    h.clock.now = T0 + 10 * MIN + 125_000; // 晚了 125s
    await h.runner.tick();
    const lines = logLines();
    expect(lines.some((l) => l.includes("missed") && l.includes(`id=${rec.id}`) && l.includes("late=125s"))).toBe(true);
    const saved = await only(h);
    const entry = saved.history.at(-1)!;
    expect(entry.outcome).toBe("missed");
    expect(entry.at - (entry.dueAt ?? 0)).toBe(125_000);
  });

  it("retry / 失败也有日志，带原因", async () => {
    const h = await setup();
    await create(h);
    h.setOutcome({ kind: "retry", reason: "会话正忙" });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    expect(logLines().some((l) => l.includes("retry") && l.includes("会话正忙"))).toBe(true);
    h.setOutcome({ kind: "failed", reason: "缺 API Key" });
    h.clock.now += 5_000;
    await h.runner.tick();
    expect(logLines().some((l) => l.includes("failed") && l.includes("缺 API Key"))).toBe(true);
  });
});

describe("attempts 记账清理（review 🟢：投递中途被取消的不留残渣）", () => {
  const attemptsSize = (): number =>
    (
      (globalThis as unknown as Record<string, { attempts?: Map<string, unknown> } | undefined>)[
        "__flowshipScheduleRunnerStateV1__"
      ]?.attempts ?? new Map()
    ).size;

  it("会话忙重试中被取消 → 下一个 tick 清掉这条的记账", async () => {
    const h = await setup();
    const rec = await create(h);
    h.setOutcome({ kind: "retry", reason: "忙" });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    expect(attemptsSize()).toBe(1);
    await store.cancelSchedule(h.taskId, rec.id, "用户取消", h.clock.now);
    h.clock.now += 5_000;
    await h.runner.tick();
    expect(attemptsSize()).toBe(0);
  });

  it("还在重试的（有 pending）不动：否则「明确没送达」的下一次会错用回旧键", async () => {
    const h = await setup();
    const rec = await create(h);
    h.setOutcome({ kind: "retry", reason: "忙" });
    h.clock.now = T0 + 10 * MIN;
    await h.runner.tick();
    h.clock.now += 5_000;
    await h.runner.tick();
    expect(h.deliveries.map((d) => d.clientItemId)).toEqual([`${rec.id}.1.1`, `${rec.id}.1.2`]);
    expect(attemptsSize()).toBe(1);
  });
});
