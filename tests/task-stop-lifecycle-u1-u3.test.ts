/**
 * U1 / U3：task 模式 stop 与启动飞行窗口 / 同相位重入
 *
 * U1：startingTasks 有消费者时 stop 不得清 pendingStopRequests；
 *     无飞行消费者时仍清（保住 oneshot 误杀修复）。
 * U3：并发 stopTaskAgent 同 task → 同一 Promise、停止事件只写一次。
 *
 * Mock 手法对齐 chat-runner-start-lease.test.ts（重依赖全 mock、不起真 Agent）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

const mockAppendEvent = vi.fn();
const mockGetTask = vi.fn();
const mockPatchAction = vi.fn();
const mockSetTaskRunStatus = vi.fn();
// R25-1：stop 收尾改走锁内事务 helper——mock 对齐新调用点
const mockFinalizeStaleAndIdleLocked = vi.fn();

vi.mock("@/lib/server/task-fs", () => ({
  appendEvent: (...args: unknown[]) => mockAppendEvent(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  patchAction: (...args: unknown[]) => mockPatchAction(...args),
  setTaskRunStatus: (...args: unknown[]) => mockSetTaskRunStatus(...args),
  finalizeStaleAndIdleLocked: (...args: unknown[]) =>
    mockFinalizeStaleAndIdleLocked(...args),
}));

vi.mock("@/lib/server/task-runner", () => ({
  abortRunningCheck: vi.fn(),
  cancelTaskRun: vi.fn(() => false),
  supersedePendingAsks: vi.fn(async () => []),
}));

vi.mock("@/lib/server/chat-runner", () => ({
  cancelChatRun: vi.fn(() => false),
}));

vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));

vi.mock("@/lib/server/task-worktrees", () => ({
  getTaskWorkRepoPaths: vi.fn(() => []),
}));

vi.mock("@/lib/server/chat-pending", () => ({
  cleanupChatTaskState: vi.fn(),
  invalidateCallerToken: vi.fn(),
}));

vi.mock("@/lib/server/chat-queue", () => ({
  // R33-1：stop 走 failQueuedItems（不再直调 clearChatQueue）
  failQueuedItems: vi.fn(() => []),
  clearChatQueue: vi.fn(),
}));

const {
  pendingStopRequests,
  beginTaskStarting,
  endTaskStarting,
  clearTaskStarting,
  isTaskStarting,
} = await import("@/lib/server/task-stream");
const { cancelTaskRun } = await import("@/lib/server/task-runner");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { stopTaskAgent } = await import("@/lib/server/stop-task");

const makeTask = (id: string): Task =>
  ({
    id,
    title: `stop-life ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    events: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

describe("U1/U3 stop lifecycle（task 模式）", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `stop-u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockAppendEvent.mockReset();
    mockGetTask.mockReset();
    mockPatchAction.mockReset();
    mockSetTaskRunStatus.mockReset();
    mockFinalizeStaleAndIdleLocked.mockReset();
    vi.mocked(cancelTaskRun).mockReset();
    vi.mocked(cancelTaskRun).mockImplementation((taskId: string) => {
      // 对齐真实 cancelTaskRun：无 runningTasks 时写入 pending
      pendingStopRequests.add(taskId);
      return false;
    });
    mockAppendEvent.mockImplementation(async (_id: string, ev: { kind: string; text?: string }) => ({
      id: `ev_${Date.now()}`,
      ts: Date.now(),
      ...ev,
    }));
    mockSetTaskRunStatus.mockImplementation(async (id: string) => makeTask(id));
    mockFinalizeStaleAndIdleLocked.mockImplementation(async (id: string) =>
      makeTask(id),
    );
    mockGetTask.mockImplementation(async (id: string) => makeTask(id));
    mockPatchAction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      // W1：generation tombstone 有意保留、不再 clear
      clearChatGate(id);
      endChatLifecycle(id);
    }
    ids.length = 0;
  });

  it("U1：startingTasks 飞行中 stop 不清 pendingStopRequests", async () => {
    const id = alloc();
    const task = makeTask(id);

    // 模拟 internalStartAgent / sendToTaskSession 飞行窗（refcount）
    beginTaskStarting(id);
    await stopTaskAgent(task);

    expect(pendingStopRequests.has(id)).toBe(true);
    endTaskStarting(id);
  });

  it("U1：无飞行消费者时 stop 清掉 pending（oneshot 修复不回退）", async () => {
    const id = alloc();
    const task = makeTask(id);

    expect(isTaskStarting(id)).toBe(false);
    await stopTaskAgent(task);

    expect(pendingStopRequests.has(id)).toBe(false);
  });

  it("U3：并发 stop 同 task → 同一结果、停止事件只写一次", async () => {
    const id = alloc();
    const task = makeTask(id);

    // R25-1：卡住首个 stop 的 finalizeStaleAndIdleLocked，制造并发窗口
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockFinalizeStaleAndIdleLocked.mockImplementation(async (tid: string) => {
      await gate;
      return makeTask(tid);
    });

    const p1 = stopTaskAgent(task);
    const p2 = stopTaskAgent(task);
    // 同相位重入 = 同一 Promise
    expect(p2).toBe(p1);

    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(mockAppendEvent).toHaveBeenCalledTimes(1);
    const stopTexts = mockAppendEvent.mock.calls.map(
      (c) => (c[1] as { text?: string }).text ?? "",
    );
    expect(stopTexts.some((t) => t.includes("用户停止了"))).toBe(true);
  });
});
