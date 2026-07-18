/**
 * 启动窗口「停止」竞态：pendingStopRequests 置 / 清逻辑。
 * 不 mock 整个 Agent SDK——只验 cancelTaskRun / stopTaskAgent 与 Set 的契约。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    // stopTaskAgent / closeTaskSession 会碰盘——相关 IO 全桩掉
    appendEvent: vi.fn(async () => null),
    getTask: vi.fn(async () => null),
    patchAction: vi.fn(async () => null),
    setTaskRunStatus: vi.fn(async () => null),
    setTaskSessionAgentId: vi.fn(async () => null),
  };
});

vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));

vi.mock("@/lib/server/chat-pending", () => ({
  cleanupChatTaskState: vi.fn(),
  invalidateCallerToken: vi.fn(),
}));

vi.mock("@/lib/server/chat-runner", () => ({
  cancelChatRun: vi.fn(() => false),
}));

import { cancelTaskRun } from "@/lib/server/task-runner";
import { stopTaskAgent } from "@/lib/server/stop-task";
import {
  forceClearStaleRunnerState,
  pendingStopRequests,
  runningTasks,
  type RunningTaskRecord,
} from "@/lib/server/task-stream";
import type { Task } from "@/lib/types";

const makeRec = (cancel: () => void): RunningTaskRecord => ({
  instanceId: 1,
  agentId: "agent-test",
  startedAt: Date.now(),
  startSnapshot: { title: "" },
  cancel,
});

/** 最小 Task 桩：只供 stopTaskAgent 走过 cancel + 清 pending 路径 */
const makeIdleTask = (id: string): Task =>
  ({
    id,
    title: "pending-stop-test",
    mode: "task",
    repoPaths: [],
    actions: [],
    events: [],
    runStatus: "idle",
    repoStatus: "active",
    currentActionId: null,
    mrs: [],
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as Task;

describe("pendingStopRequests（启动窗口停止）", () => {
  const ids: string[] = [];

  afterEach(() => {
    for (const id of ids) {
      runningTasks.delete(id);
      pendingStopRequests.delete(id);
    }
    ids.length = 0;
  });

  const allocId = (): string => {
    const id = `pending-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  it("无 runningTasks 时 cancelTaskRun 写入 pendingStopRequests", () => {
    const id = allocId();
    expect(pendingStopRequests.has(id)).toBe(false);
    cancelTaskRun(id);
    expect(pendingStopRequests.has(id)).toBe(true);
  });

  it("有 runningTasks 时 cancelTaskRun 调 cancel、不写 pending", () => {
    const id = allocId();
    let cancelled = false;
    runningTasks.set(id, makeRec(() => {
      cancelled = true;
    }));
    cancelTaskRun(id);
    expect(cancelled).toBe(true);
    expect(pendingStopRequests.has(id)).toBe(false);
  });

  it("forceClearStaleRunnerState 清掉 pending 标记", () => {
    const id = allocId();
    pendingStopRequests.add(id);
    forceClearStaleRunnerState(id);
    expect(pendingStopRequests.has(id)).toBe(false);
  });

  it("stopTaskAgent 收尾后清除 pendingStopRequests（idle 停止不粘住）", async () => {
    const id = allocId();
    // idle 点停止：无活 run → cancelTaskRun 写入 pending（启动窗口自裁）
    cancelTaskRun(id);
    expect(pendingStopRequests.has(id)).toBe(true);

    await stopTaskAgent(makeIdleTask(id));
    // 收尾必须清掉，否则下次 oneshot 答疑会被误杀
    expect(pendingStopRequests.has(id)).toBe(false);
  });
});
