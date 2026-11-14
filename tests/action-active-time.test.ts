/**
 * Action「实际运行时长」：纯函数结算口径 + 各 status 写盘入口的落盘行为。
 *
 * 锁住的核心事实：endedAt - startedAt 里大头是「交卷后人没回来」的闲置（「再聊聊」会把 action 拉回 running），
 * 所以耗时必须只累 running 区间；所有写 status 的入口（三个 patch / stop 收尾 / 开机僵尸）都要结算，
 * 漏任何一个入口，数据就会悄悄少算。
 *
 * task-fs-core 在模块加载时钉死 DATA_DIR：每次 resetModules + 先设 env 再 import（同 boot-recovery-subkind）。
 * Date 用假的（只换 Date、不动定时器 / fs），时间轴完全可控。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { getActionActiveMs, settleActiveTime } from "@/lib/action-active-time";

describe("settleActiveTime（纯函数）", () => {
  it("running → awaiting_ack：首段从 startedAt 算起并结算，runningSince 清空", () => {
    const r = settleActiveTime(
      { status: "running", startedAt: 1_000 },
      "awaiting_ack",
      6_000,
    );
    expect(r).toEqual({ activeMs: 5_000, runningSince: undefined });
  });

  it("awaiting_ack → running（再聊聊拉回）：开新区间、已结算时长保留", () => {
    const r = settleActiveTime(
      { status: "awaiting_ack", startedAt: 1_000, activeMs: 5_000 },
      "running",
      900_000,
    );
    expect(r).toEqual({ activeMs: 5_000, runningSince: 900_000 });
  });

  it("第二段 running 结算：起点用 runningSince、在已结算基础上累加（闲置空档不进账）", () => {
    const r = settleActiveTime(
      { status: "running", startedAt: 1_000, activeMs: 5_000, runningSince: 900_000 },
      "completed",
      930_000,
    );
    expect(r).toEqual({ activeMs: 35_000, runningSince: undefined });
  });

  it("不涉及 running 边界的迁移一律返 null（不动任何字段）", () => {
    const base = { startedAt: 1_000, activeMs: 5_000 };
    expect(settleActiveTime({ ...base, status: "running" }, "running", 2_000)).toBeNull();
    expect(settleActiveTime({ ...base, status: "awaiting_ack" }, "completed", 2_000)).toBeNull();
    expect(settleActiveTime({ ...base, status: "error" }, "cancelled", 2_000)).toBeNull();
    expect(settleActiveTime({ ...base, status: "awaiting_ack" }, "error", 2_000)).toBeNull();
  });

  it("settleAt 早于区间起点（时钟回拨 / 保守下界）按 0 算、不出负数", () => {
    const r = settleActiveTime(
      { status: "running", startedAt: 10_000 },
      "error",
      99_000,
      5_000,
    );
    expect(r?.activeMs).toBe(0);
  });

  it("settleAt 单独指定时只影响结算终点（用于僵尸恢复的保守下界）", () => {
    const r = settleActiveTime(
      { status: "running", startedAt: 1_000 },
      "error",
      99_000_000,
      4_000,
    );
    expect(r?.activeMs).toBe(3_000);
  });
});

describe("R21-01：上线前就跑过的老 action 被「再聊聊」拉回运行——一直未知，不拿后一段冒充完整值", () => {
  // 老数据：升级前已交卷、没有 activeMs / runningSince
  const legacy = { status: "awaiting_ack" as const, startedAt: 1_000 };

  it("拉回 → 再交卷：结算保持未知（activeMs 仍缺省），而不是只含第二段的偏小真数", () => {
    // 拉回：开新区间（与新 action 同一路径，不特殊处理）
    const pulled = settleActiveTime(legacy, "running", 900_000);
    expect(pulled).toEqual({ activeMs: undefined, runningSince: 900_000 });

    // 3 分钟后再交卷：之前（修复前）这里会得到 activeMs=180_000
    const settled = settleActiveTime(
      { ...legacy, status: "running", ...pulled },
      "awaiting_ack",
      900_000 + 180_000,
    );
    expect(settled).toEqual({ activeMs: undefined, runningSince: undefined });

    // 读出来是「未知」，不是 180_000
    const after = { ...legacy, status: "awaiting_ack" as const, ...settled };
    expect(getActionActiveMs(after, 9e9)).toBeNull();
  });

  it("拉回后仍在运行时读：也是未知（不显示只含本段的实时值）", () => {
    const pulled = settleActiveTime(legacy, "running", 900_000)!;
    expect(
      getActionActiveMs({ ...legacy, status: "running", ...pulled }, 900_000 + 60_000),
    ).toBeNull();
  });

  it("反复拉回 / 交卷都保持未知；最终 completed 也一样", () => {
    let a: { status: "running" | "awaiting_ack" | "completed"; startedAt: number; activeMs?: number; runningSince?: number } = { ...legacy };
    const step = (next: "running" | "awaiting_ack" | "completed", at: number) => {
      const r = settleActiveTime(a, next, at);
      a = { ...a, status: next, ...(r ?? {}) };
    };
    step("running", 100_000);
    step("awaiting_ack", 200_000);
    step("running", 300_000);
    step("awaiting_ack", 400_000);
    step("completed", 500_000);
    expect(getActionActiveMs(a, 9e9)).toBeNull();
  });

  it("对照：新 action（首段有 activeMs）被拉回再交卷仍是累加的真数——判据不误伤", () => {
    const first = settleActiveTime({ status: "running", startedAt: 1_000 }, "awaiting_ack", 6_000)!;
    expect(first.activeMs).toBe(5_000);
    const mid = { status: "awaiting_ack" as const, startedAt: 1_000, ...first };
    const pulled = settleActiveTime(mid, "running", 900_000)!;
    const done = settleActiveTime(
      { ...mid, status: "running", ...pulled },
      "awaiting_ack",
      930_000,
    )!;
    expect(done.activeMs).toBe(35_000);
    expect(getActionActiveMs({ ...mid, ...done }, 9e9)).toBe(35_000);
  });
});

describe("getActionActiveMs（读取口径）", () => {
  it("运行中：已结算 + 当前区间实时增长", () => {
    expect(
      getActionActiveMs(
        { status: "running", startedAt: 1_000, activeMs: 5_000, runningSince: 900_000 },
        910_000,
      ),
    ).toBe(15_000);
    // 首段没有 runningSince → 回退 startedAt
    expect(getActionActiveMs({ status: "running", startedAt: 1_000 }, 4_000)).toBe(3_000);
  });

  it("非运行：有 activeMs 返回它；老数据（没有 activeMs）返 null，不拿起止跨度冒充", () => {
    expect(
      getActionActiveMs({ status: "completed", startedAt: 1_000, activeMs: 7_000 }, 9e9),
    ).toBe(7_000);
    expect(getActionActiveMs({ status: "completed", startedAt: 1_000 }, 9e9)).toBeNull();
    expect(getActionActiveMs({ status: "awaiting_ack", startedAt: 1_000 }, 9e9)).toBeNull();
  });
});

// ───────── 落盘：各 status 写入口 ─────────

const g = globalThis as unknown as Record<string, unknown>;
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-active-time-"));
const dataDir = path.join(root, "data");

const T0 = 1_800_000_000_000;
const MIN = 60_000;

/** 在隔离数据目录下写一份 meta（action 默认 running、从 T0 开始） */
const seed = (
  id: string,
  over: Record<string, unknown> = {},
  actionOver: Record<string, unknown> = {},
): void => {
  const dir = path.join(dataDir, "tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      id,
      title: id,
      mode: "task",
      repoStatus: "developing",
      runStatus: "running",
      currentActionId: "act_1",
      actions: [
        {
          id: "act_1",
          n: 1,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: "actions/1-build.md",
          startedAt: T0,
          endedAt: null,
          ...actionOver,
        },
      ],
      mrs: [],
      repoPaths: [],
      createdAt: T0,
      updatedAt: T0,
      ...over,
    }),
    "utf-8",
  );
};

const readAction = (id: string): Record<string, unknown> => {
  const meta = JSON.parse(
    fs.readFileSync(path.join(dataDir, "tasks", id, "meta.json"), "utf-8"),
  ) as { actions: Array<Record<string, unknown>> };
  return meta.actions[0]!;
};

const loadTaskFs = async () => {
  delete g[RECOVERY_FLAG];
  vi.resetModules();
  const saved = process.env.FLOWSHIP_DATA_DIR;
  process.env.FLOWSHIP_DATA_DIR = dataDir;
  try {
    return await import("@/lib/server/task-fs");
  } finally {
    process.env.FLOWSHIP_DATA_DIR = saved;
  }
};

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  delete g[RECOVERY_FLAG];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("status 写入口 → 落盘 activeMs", () => {
  it("patchAction：running → 交卷 → 一小时后再聊聊拉回 → 完成，只累 running 区间", async () => {
    seed("t_patch");
    const { patchAction } = await loadTaskFs();
    vi.useFakeTimers({ toFake: ["Date"] });

    // 跑 1 分钟后交卷
    vi.setSystemTime(T0 + 1 * MIN);
    await patchAction("t_patch", "act_1", { status: "awaiting_ack" });
    expect(readAction("t_patch")).toMatchObject({
      activeMs: 1 * MIN,
      endedAt: T0 + 1 * MIN,
    });
    expect(readAction("t_patch").runningSince).toBeUndefined();

    // 人 1 小时后才回来「再聊聊」：拉回 running
    vi.setSystemTime(T0 + 61 * MIN);
    await patchAction("t_patch", "act_1", { status: "running" });
    expect(readAction("t_patch")).toMatchObject({
      activeMs: 1 * MIN,
      endedAt: null,
      runningSince: T0 + 61 * MIN,
    });

    // 又跑 30 秒后完成
    vi.setSystemTime(T0 + 61 * MIN + 30_000);
    await patchAction("t_patch", "act_1", { status: "completed" });
    const done = readAction("t_patch");
    expect(done.activeMs).toBe(1 * MIN + 30_000);
    expect(done.runningSince).toBeUndefined();
    // 对照：起止跨度是 61.5 分钟——这正是不能拿它当耗时的原因
    expect((done.endedAt as number) - (done.startedAt as number)).toBe(61 * MIN + 30_000);
  });

  it("patchAction：不改 status 的 patch（如写 postCheck）不碰运行时长", async () => {
    seed("t_nostatus");
    const { patchAction } = await loadTaskFs();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 5 * MIN);
    await patchAction("t_nostatus", "act_1", {
      postCheck: { passed: true, details: "ok" },
    });
    const a = readAction("t_nostatus");
    expect(a.activeMs).toBeUndefined();
    expect(a.runningSince).toBeUndefined();
    expect(a.status).toBe("running");
  });

  it("patchActionIfOwner：running → completed 同样结算", async () => {
    seed("t_owner");
    const { patchActionIfOwner } = await loadTaskFs();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 2 * MIN);
    const task = await patchActionIfOwner(
      "t_owner",
      "act_1",
      { status: "completed" },
      () => true,
    );
    expect(task).not.toBeNull();
    expect(readAction("t_owner")).toMatchObject({ activeMs: 2 * MIN, endedAt: T0 + 2 * MIN });
  });

  it("patchAction 的 awaiting_ack → completed（人确认）不动 activeMs / endedAt", async () => {
    seed(
      "t_ack",
      { runStatus: "awaiting_user" },
      { status: "awaiting_ack", activeMs: 3 * MIN, endedAt: T0 + 3 * MIN },
    );
    const { patchAction } = await loadTaskFs();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 999 * MIN);
    await patchAction("t_ack", "act_1", { status: "completed" });
    expect(readAction("t_ack")).toMatchObject({
      activeMs: 3 * MIN,
      endedAt: T0 + 3 * MIN,
    });
  });

  it("patchActionAndRunStatusIfOpFresh：running → awaiting_ack（交卷主路径）结算", async () => {
    seed("t_opfresh");
    const { patchActionAndRunStatusIfOpFresh } = await loadTaskFs();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 4 * MIN);
    const task = await patchActionAndRunStatusIfOpFresh(
      "t_opfresh",
      "act_1",
      "awaiting_ack",
      "awaiting_user",
      () => true,
    );
    expect(task).not.toBeNull();
    expect(readAction("t_opfresh")).toMatchObject({
      status: "awaiting_ack",
      activeMs: 4 * MIN,
      endedAt: T0 + 4 * MIN,
    });
  });

  it("finalizeStaleAndIdleLocked（stop / 归档收尾）：running → cancelled 结算；awaiting_ack 不额外加", async () => {
    seed("t_stop");
    seed("t_stop_ack", {}, { status: "awaiting_ack", activeMs: 2 * MIN, endedAt: T0 + 2 * MIN });
    const { finalizeStaleAndIdleLocked } = await loadTaskFs();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 7 * MIN);

    await finalizeStaleAndIdleLocked("t_stop");
    expect(readAction("t_stop")).toMatchObject({ status: "cancelled", activeMs: 7 * MIN });

    await finalizeStaleAndIdleLocked("t_stop_ack");
    expect(readAction("t_stop_ack")).toMatchObject({ status: "cancelled", activeMs: 2 * MIN });
  });

  it("开机僵尸恢复：运行时长只结算到最后一次落盘，不把重启前的关机空档算进去", async () => {
    // 进程死时 meta 最后一次落盘 = T0 + 10 分钟；重启发生在两天后
    seed("t_zombie", { updatedAt: T0 + 10 * MIN });
    const { listTasks } = await loadTaskFs();
    await listTasks();

    const a = readAction("t_zombie");
    expect(a.status).toBe("error");
    expect(a.activeMs).toBe(10 * MIN);
    expect(a.runningSince).toBeUndefined();
  });
});
