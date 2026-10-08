/**
 * task-op ↔ task-stream 共享 globalThis state 的初始化顺序契约
 *
 * 背景（19a914f）：ownership 抽进无环叶子模块 task-op 后，task-op 的 opGlobals() 在共享 key
 * 不存在时会先建一个只带 ownership 字段的空壳。task-stream 若随后才加载，旧版 getRunnerState
 * 见「壳已存在」就跳过完整初始化——模块顶层缓存的 runningTasks / agentSessions 等全是 undefined，
 * 之后任何 .get / .set 直接 TypeError。
 *
 * 契约：
 * 1. 无论谁先触达共享 state，task-stream 加载后所有字段齐全；
 * 2. 「只补缺失、永不替换」——两边都缓存了 Map 引用，替换即分叉（task-op 头部铁律）；
 * 3. 补齐后 task-op 与 task-stream 看到的是同一份状态（isTaskRunning / revoke 联动）。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.FLOWSHIP_DATA_DIR = path.join(
  mkdtempSync(path.join(os.tmpdir(), "fe-runner-state-init-")),
  "data",
);

const KEY = "__flowshipTaskRunnerStateV12__";
type Shared = Record<string, unknown>;
const globals = () =>
  globalThis as unknown as Record<string, Shared | undefined>;

beforeEach(() => {
  vi.resetModules();
  delete globals()[KEY];
});
afterEach(() => {
  delete globals()[KEY];
});

describe("task-runner 共享 state 初始化顺序", () => {
  it("task-op 先触达（建出残缺空壳）→ task-stream 后加载：所有字段补齐，且模块缓存与共享 state 不分叉", async () => {
    const op = await import("@/lib/server/task-op");
    // 只读也会建壳——复现 19a914f 引入的加载顺序
    op.getTaskOpGeneration("t1");
    // 前置：确实是残缺壳（否则本用例没在测它该测的东西）
    expect(Object.keys(globals()[KEY] ?? {})).not.toContain("runningTasks");

    const ts = await import("@/lib/server/task-stream");
    const s = globals()[KEY]!;

    expect(ts.runningTasks).toBeInstanceOf(Map);
    expect(ts.agentSessions).toBeInstanceOf(Map);
    expect(ts.forkPendingTasks).toBeInstanceOf(Set);
    expect(ts.runningChecks).toBeInstanceOf(Map);
    expect(ts.pendingStopRequests).toBeInstanceOf(Set);
    expect(s.subscribers).toBeInstanceOf(Map);
    expect(s.startingTasks).toBeInstanceOf(Map);
    expect(s.taskOwnership).toBeInstanceOf(Map);

    // 模块顶层缓存的引用 === 共享 state 上的引用（否则两边各写各的）
    expect(ts.runningTasks).toBe(s.runningTasks);
    expect(ts.agentSessions).toBe(s.agentSessions);
  });

  it("补齐只补缺失、不替换 task-op 已建的 ownership Map（身份不变、已写入的 claim 不丢）", async () => {
    const op = await import("@/lib/server/task-op");
    const handle = op.claimTaskOp("t1", op.getTaskOpGeneration("t1"))!;
    expect(handle).not.toBeNull();
    const ownershipBefore = globals()[KEY]!.taskOwnership;

    const ts = await import("@/lib/server/task-stream");

    expect(globals()[KEY]!.taskOwnership).toBe(ownershipBefore);
    expect(op.isTaskOpCurrent(handle)).toBe(true);
    // task-stream 的 revoke 与 task-op 的判定读的是同一份
    ts.revokeTaskOps("t1");
    expect(op.isTaskOpCurrent(handle)).toBe(false);
  });

  it("补齐后 task-op 与 task-stream 看到同一份 runningTasks / agentSessions", async () => {
    const op = await import("@/lib/server/task-op");
    op.getTaskOpGeneration("t1");
    const ts = await import("@/lib/server/task-stream");

    expect(op.isTaskRunning("t1")).toBe(false);
    ts.runningTasks.set("t1", {} as never);
    expect(op.isTaskRunning("t1")).toBe(true);

    expect(op.hasTaskAgentSession("t1")).toBe(false);
    ts.agentSessions.set("t1", {} as never);
    expect(op.hasTaskAgentSession("t1")).toBe(true);
  });

  it("正常顺序（task-stream 先加载）行为不变", async () => {
    const ts = await import("@/lib/server/task-stream");
    const op = await import("@/lib/server/task-op");

    expect(ts.runningTasks).toBeInstanceOf(Map);
    ts.runningTasks.set("t1", {} as never);
    expect(op.isTaskRunning("t1")).toBe(true);

    const h = op.snapshotTaskOp("t1");
    expect(op.isTaskOpCurrent(h)).toBe(true);
    ts.revokeTaskOps("t1");
    expect(op.isTaskOpCurrent(h)).toBe(false);
  });

  it("hot-reload 残留半残 state（字段缺失 / 类型不对）也补齐，且不动已有的合法 Map", async () => {
    const keep = new Map([["keep", 1]]);
    globals()[KEY] = {
      runningTasks: keep,
      agentSessions: "garbage",
      subscribers: undefined,
    } as Shared;

    const ts = await import("@/lib/server/task-stream");

    expect(ts.runningTasks).toBe(keep); // 合法的不替换
    expect(ts.agentSessions).toBeInstanceOf(Map); // 非法的补成 Map
    expect(globals()[KEY]!.subscribers).toBeInstanceOf(Map);
  });
});
