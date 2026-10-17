/**
 * POST /api/tasks/[id]/wait/skip：状态行「跳过等待」按钮的后端。
 * 真调 handler + 真的 session-wait 注册表（只 mock 掉磁盘读 task），断言：
 * - 睡着的 wait 被叫醒、reason=skip，模型那边拿到的是 [WAIT_SKIPPED]（不是停止、不是超时）
 * - 只叫醒这个任务的 wait，别的任务的不受影响
 * - 没有在睡的 wait = 成功（woken=0，幂等）；task 不存在 = 404
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getTask = vi.fn();
vi.mock("@/lib/server/task-fs", () => ({
  getTask: (...a: unknown[]) => getTask(...a),
}));

import { POST } from "../src/app/api/tasks/[id]/wait/skip/route";
import {
  activeWaitCount,
  formatWaitResult,
  interruptWaits,
  runWait,
} from "../src/lib/server/session-wait";

const call = (id: string) =>
  POST(new Request(`http://x/api/tasks/${id}/wait/skip`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  getTask.mockReset();
  getTask.mockResolvedValue({ id: "t_1" });
});

afterEach(() => {
  // 防测试失败时遗留睡着的 wait 拖住进程
  interruptWaits("t_1", "cancel");
  interruptWaits("t_2", "cancel");
});

describe("POST /api/tasks/[id]/wait/skip", () => {
  it("叫醒在睡的 wait：reason=skip，模型收到 [WAIT_SKIPPED]；响应 woken=1", async () => {
    const waiting = runWait({ key: "t_1", plannedMs: 60 * 60 * 1000 });
    expect(activeWaitCount("t_1")).toBe(1);

    const res = await call("t_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, woken: 1 });

    const outcome = await waiting;
    expect(outcome.status).toBe("skip");
    expect(formatWaitResult(outcome)).toContain("[WAIT_SKIPPED]");
    // 唤醒后注册表清干净，不留尾巴
    expect(activeWaitCount("t_1")).toBe(0);
  });

  it("同一任务里多个 wait（并行工具调用）一起叫醒", async () => {
    const a = runWait({ key: "t_1", plannedMs: 60 * 60 * 1000 });
    const b = runWait({ key: "t_1", plannedMs: 60 * 60 * 1000 });
    const res = await call("t_1");
    expect((await res.json()).woken).toBe(2);
    expect((await a).status).toBe("skip");
    expect((await b).status).toBe("skip");
  });

  it("只叫醒本任务的 wait，别的任务不受影响", async () => {
    const mine = runWait({ key: "t_1", plannedMs: 60 * 60 * 1000 });
    const other = runWait({ key: "t_2", plannedMs: 60 * 60 * 1000 });
    await call("t_1");
    expect((await mine).status).toBe("skip");
    expect(activeWaitCount("t_2")).toBe(1);
    interruptWaits("t_2", "cancel");
    expect((await other).status).toBe("cancel");
  });

  it("当前没有在睡的 wait：成功（幂等），woken=0——比如点的瞬间它刚好到点自己醒了", async () => {
    const res = await call("t_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, woken: 0 });
  });

  it("task 不存在 → 404，且不会去叫醒任何东西", async () => {
    getTask.mockResolvedValue(null);
    const waiting = runWait({ key: "t_1", plannedMs: 60 * 60 * 1000 });
    const res = await call("t_1");
    expect(res.status).toBe(404);
    expect(activeWaitCount("t_1")).toBe(1);
    interruptWaits("t_1", "cancel");
    await waiting;
  });
});
