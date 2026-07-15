/**
 * 启动窗口「停止」竞态：pendingStopRequests 置 / 清逻辑。
 * 不 mock 整个 Agent SDK——只验 cancelTaskRun 与 Set 的契约。
 */
import { afterEach, describe, expect, it } from "vitest";

import { cancelTaskRun } from "@/lib/server/task-runner";
import {
  forceClearStaleRunnerState,
  pendingStopRequests,
  runningTasks,
  type RunningTaskRecord,
} from "@/lib/server/task-stream";

const makeRec = (cancel: () => void): RunningTaskRecord => ({
  agentId: "agent-test",
  startedAt: Date.now(),
  startSnapshot: { title: "" },
  cancel,
});

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
});
