/**
 * task-warmup（src/lib/server/task-warmup.ts）单测——依赖全部注入，不碰真实 store / 网络
 *
 * 钉死的语义：
 * - 只做「幂等、只读、可丢弃」的事；有 run 在跑 / 正在停止或删除 / 不存在的任务一律不预热
 * - 会话已在内存（恢复路径是热的）不预读 store；没有持久会话也不预读
 * - 同一 task 20s 节流、全局并发 ≤2、名额一定归还（含异常路径）
 * - 任何故障都折成结果、永不 reject；任一半（MCP / store）失败不拖累另一半
 * - 节流 / 忙碌这类高频无信息量的跳过不落盘（免刷屏），其余都记一行
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetWarmupStateForTests,
  warmupTask,
  type WarmTask,
  type WarmupDeps,
} from "@/lib/server/task-warmup";

const MCP = { total: 2, refreshed: 1, skippedFresh: 1, waitMs: 120 };
const STORE = { blobs: 3, bytes: 4096 };

let clock = 10_000_000;
let records: Array<{ file: string; rec: Record<string, unknown> }>;
let warmedNotes: Array<{ taskId: string; at: number }>;

const baseTask: WarmTask = { id: "t1", mode: "chat", sessionAgentId: "agent-1" };

const mkDeps = (over: Partial<WarmupDeps> = {}): WarmupDeps => ({
  now: () => clock,
  getTask: async (id) => (id === "missing" ? null : { ...baseTask, id }),
  lifecycle: () => null,
  hasLiveSession: () => false,
  isRunActive: () => false,
  warmMcp: vi.fn(async () => MCP),
  prefetchStore: vi.fn(async () => STORE),
  record: (file, rec) => {
    records.push({ file, rec });
  },
  noteWarmed: (taskId, at) => {
    warmedNotes.push({ taskId, at });
  },
  ...over,
});

beforeEach(() => {
  __resetWarmupStateForTests();
  clock = 10_000_000;
  records = [];
  warmedNotes = [];
});

describe("正常预热", () => {
  it("会话冷 + 有持久会话：MCP 与 store 都预热；记一行 warmup.jsonl；标记预热时刻", async () => {
    const deps = mkDeps();
    const out = await warmupTask("t1", deps);
    expect(out).toMatchObject({ taskId: "t1", status: "warmed", sessionHot: false, mcp: MCP, store: STORE });
    expect(deps.warmMcp).toHaveBeenCalledTimes(1);
    expect(deps.prefetchStore).toHaveBeenCalledWith("agent-1");
    expect(records).toHaveLength(1);
    expect(records[0].file).toBe("warmup.jsonl");
    expect(records[0].rec).toMatchObject({ taskId: "t1", status: "warmed" });
    expect(warmedNotes).toEqual([{ taskId: "t1", at: clock }]);
  });

  it("会话已在内存（恢复路径是热的）：只预热 MCP，不预读 store", async () => {
    const deps = mkDeps({ hasLiveSession: () => true });
    const out = await warmupTask("t1", deps);
    expect(out.sessionHot).toBe(true);
    expect(deps.prefetchStore).not.toHaveBeenCalled();
    expect(out.store).toBeUndefined();
    expect(deps.warmMcp).toHaveBeenCalledTimes(1);
  });

  it("没有持久会话（全新任务）：不预读 store", async () => {
    const deps = mkDeps({ getTask: async (id) => ({ id, mode: "chat" }) });
    await warmupTask("t1", deps);
    expect(deps.prefetchStore).not.toHaveBeenCalled();
  });

  it("没有可探的 MCP（warmMcp 返回 null）：结果不带 mcp 字段，其余照常", async () => {
    const deps = mkDeps({ warmMcp: vi.fn(async () => null) });
    const out = await warmupTask("t1", deps);
    expect(out.status).toBe("warmed");
    expect("mcp" in out).toBe(false);
  });

  it("记录里没有任何内容类字段（只有 id / 状态 / 统计）", async () => {
    await warmupTask("t1", mkDeps());
    expect(Object.keys(records[0].rec).sort()).toEqual(
      ["mcp", "sessionHot", "status", "store", "taskId", "totalMs"].sort(),
    );
  });
});

describe("不该预热的情形", () => {
  it("任务不存在 → skipped/not_found，不调用任何预热动作", async () => {
    const deps = mkDeps();
    const out = await warmupTask("missing", deps);
    expect(out).toMatchObject({ status: "skipped", reason: "not_found" });
    expect(deps.warmMcp).not.toHaveBeenCalled();
    expect(deps.prefetchStore).not.toHaveBeenCalled();
    expect(warmedNotes).toEqual([]);
  });

  it("有 run 在跑 → skipped/run_active（别和真实运行争资源，MCP 刚探过）", async () => {
    const deps = mkDeps({ isRunActive: () => true });
    const out = await warmupTask("t1", deps);
    expect(out).toMatchObject({ status: "skipped", reason: "run_active" });
    expect(deps.warmMcp).not.toHaveBeenCalled();
  });

  it("正在停止 / 删除 → skipped/lifecycle", async () => {
    const deps = mkDeps({ lifecycle: () => "stopping" });
    const out = await warmupTask("t1", deps);
    expect(out).toMatchObject({ status: "skipped", reason: "lifecycle" });
    expect(deps.warmMcp).not.toHaveBeenCalled();
  });

  it("被挡的（不存在 / run 在跑）不占节流窗口：随后条件满足立刻能预热", async () => {
    let active = true;
    const deps = mkDeps({ isRunActive: () => active });
    expect((await warmupTask("t1", deps)).reason).toBe("run_active");
    active = false;
    expect((await warmupTask("t1", deps)).status).toBe("warmed");
  });
});

describe("节流与并发上限", () => {
  it("同一 task 20s 内第二次 → throttled 且不落盘；过了窗口再次预热", async () => {
    const deps = mkDeps();
    expect((await warmupTask("t1", deps)).status).toBe("warmed");
    clock += 19_999;
    const second = await warmupTask("t1", deps);
    expect(second).toMatchObject({ status: "skipped", reason: "throttled" });
    expect(deps.warmMcp).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1); // 节流跳过不落盘

    clock += 1;
    expect((await warmupTask("t1", deps)).status).toBe("warmed");
    expect(deps.warmMcp).toHaveBeenCalledTimes(2);
  });

  it("不同 task 互不节流", async () => {
    const deps = mkDeps();
    await warmupTask("t1", deps);
    expect((await warmupTask("t2", deps)).status).toBe("warmed");
  });

  it("全局并发上限 2：第 3 个 → busy 且不落盘；有名额归还后可再预热", async () => {
    const gates: Array<() => void> = [];
    const hang = () =>
      new Promise<typeof MCP>((resolve) => {
        gates.push(() => resolve(MCP));
      });
    const deps = mkDeps({ warmMcp: vi.fn(hang) });

    const p1 = warmupTask("a", deps);
    const p2 = warmupTask("b", deps);
    await vi.waitFor(() => expect(gates).toHaveLength(2)); // 两个都已进入、占满名额
    const third = await warmupTask("c", deps);
    expect(third).toMatchObject({ status: "skipped", reason: "busy" });
    expect(records).toHaveLength(0); // 前两个还没结束、busy 不落盘

    gates.forEach((g) => g());
    await Promise.all([p1, p2]);

    // 名额已归还、c 没被记成「刚预热过」→ 现在能预热
    const deps2 = mkDeps();
    expect((await warmupTask("c", deps2)).status).toBe("warmed");
  });

  it("异常路径名额也归还：getTask 抛错后并发计数不泄漏（之后两个并发预热仍都能进）", async () => {
    const bad = mkDeps({
      getTask: async () => {
        throw new Error("disk gone");
      },
    });
    for (let i = 0; i < 5; i++) await warmupTask(`bad${i}`, bad);

    const gates: Array<() => void> = [];
    const deps = mkDeps({
      warmMcp: vi.fn(
        () =>
          new Promise<typeof MCP>((resolve) => {
            gates.push(() => resolve(MCP));
          }),
      ),
    });
    const p1 = warmupTask("x", deps);
    const p2 = warmupTask("y", deps);
    await vi.waitFor(() => expect(gates).toHaveLength(2)); // 没被泄漏的计数挡住
    gates.forEach((g) => g());
    expect((await Promise.all([p1, p2])).map((o) => o.status)).toEqual(["warmed", "warmed"]);
  });
});

describe("故障：永不 reject，一半失败不拖累另一半", () => {
  it("getTask 抛错 → status=error（带截断的错误文本），记一行，不抛", async () => {
    const deps = mkDeps({
      getTask: async () => {
        throw new Error("x".repeat(500));
      },
    });
    const out = await warmupTask("t1", deps);
    expect(out.status).toBe("error");
    expect(out.error!.length).toBeLessThanOrEqual(160);
    expect(records).toHaveLength(1);
  });

  it("MCP 预热抛错：store 仍预读，整体仍算 warmed（mcp 缺省）", async () => {
    const deps = mkDeps({
      warmMcp: vi.fn(async () => {
        throw new Error("probe boom");
      }),
    });
    const out = await warmupTask("t1", deps);
    expect(out.status).toBe("warmed");
    expect("mcp" in out).toBe(false);
    expect(out.store).toEqual(STORE);
  });

  it("store 预读抛错：MCP 结果仍保留", async () => {
    const deps = mkDeps({
      prefetchStore: vi.fn(async () => {
        throw new Error("io boom");
      }),
    });
    const out = await warmupTask("t1", deps);
    expect(out.status).toBe("warmed");
    expect(out.mcp).toEqual(MCP);
    expect("store" in out).toBe(false);
  });

  it("store 没开（prefetchStore 返回 null）：不带 store 字段", async () => {
    const deps = mkDeps({ prefetchStore: vi.fn(async () => null) });
    const out = await warmupTask("t1", deps);
    expect(out.status).toBe("warmed");
    expect("store" in out).toBe(false);
  });
});
