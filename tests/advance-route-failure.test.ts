/**
 * POST /api/tasks/[id]/advance 失败路径的 route handler 行为测试。
 *
 * 真调 handler、mock 掉 runner / 存储：
 *  - ensureTaskWorktrees 类失败（advanceTask 抛带多行原因的错）→ 响应体带完整原因 + 稳定 code，
 *    并往事件流补写一条 error 事件（runner 不写，之前事件流里查不到）
 *  - 让位 / 准入拒绝 / runner 已写过 / 任务在跑 → 不补写
 *  - 补写本身失败不能盖住真正的错误响应
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const STALE = "正在停止/任务已变更、请重发";
const advanceTask = vi.fn();
const getTaskMeta = vi.fn();
const getTaskWithTailEvents = vi.fn();
const writeOwnedEventAndPublish = vi.fn();
const isTaskOpStale = vi.fn(() => false);

vi.mock("@/lib/server/task-runner", () => ({
  advanceTask: (...a: unknown[]) => advanceTask(...a),
  isTaskOpStale: (...a: unknown[]) => isTaskOpStale(...(a as [])),
  TASK_OP_STALE_HTTP_MESSAGE: "正在停止/任务已变更、请重发",
}));
vi.mock("@/lib/server/task-fs", () => ({
  getTaskMeta: (...a: unknown[]) => getTaskMeta(...a),
  getTaskWithTailEvents: (...a: unknown[]) => getTaskWithTailEvents(...a),
  setTaskRemoveSourceBranchOnMerge: vi.fn(),
}));
vi.mock("@/lib/server/task-stream", () => ({
  getTaskOpGeneration: () => 7,
  writeOwnedEventAndPublish: (...a: unknown[]) => writeOwnedEventAndPublish(...a),
}));
vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle: () => null }));
vi.mock("@/lib/server/custom-action-fs", () => ({ getCustomAction: vi.fn() }));
vi.mock("@/lib/server/task-artifacts", () => ({ saveImageAttachments: vi.fn() }));

import { POST } from "../src/app/api/tasks/[id]/advance/route";

const WORKTREE_MSG =
  "仓库 /repo/a 创建隔离工作区失败（分支 flow/x）：fatal: not a git repository\n下一步：检查主仓是否可达后重试";

const call = () =>
  POST(
    new Request("http://x/api/tasks/t_1/advance", {
      method: "POST",
      body: JSON.stringify({
        actionType: "build",
        userInstruction: "改一下登录页",
        apiKey: "k",
        model: { id: "m" },
      }),
    }),
    { params: Promise.resolve({ id: "t_1" }) },
  );

const idleTail = (events: unknown[] = []) => ({
  id: "t_1",
  runStatus: "idle",
  repoStatus: "developing",
  events,
});

beforeEach(() => {
  vi.clearAllMocks();
  isTaskOpStale.mockReturnValue(false);
  getTaskMeta.mockResolvedValue({
    id: "t_1",
    mode: "task",
    runStatus: "idle",
    repoStatus: "developing",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("advance route：失败路径", () => {
  it("ensureTaskWorktrees 类失败：400 + 完整多行原因 + 稳定 code，并补写 error 事件", async () => {
    advanceTask.mockRejectedValue(new Error(WORKTREE_MSG));
    getTaskWithTailEvents.mockResolvedValue(
      idleTail([{ kind: "info", text: "正在准备工作区…", ts: Date.now() }]),
    );

    const res = await call();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    // 完整原因原样回给客户端（不截首行）
    expect(body.error).toBe(WORKTREE_MSG);
    expect(body.code).toBe("advance_failed");

    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(1);
    const [taskId, lease, ev] = writeOwnedEventAndPublish.mock.calls[0] as [
      string,
      () => boolean,
      { kind: string; text: string; meta?: Record<string, unknown> },
    ];
    expect(taskId).toBe("t_1");
    expect(ev.kind).toBe("error");
    expect(ev.text).toBe(WORKTREE_MSG);
    expect(ev.meta).toEqual({ subkind: "advance_failed", actionType: "build" });
    // lease：任务未变更时放行；stop / 变更在飞（stale）时拒写
    expect(lease()).toBe(true);
    isTaskOpStale.mockReturnValue(true);
    expect(lease()).toBe(false);
  });

  it("让位（stop / 任务已变更）：只回错误、不写事件", async () => {
    advanceTask.mockRejectedValue(new Error(STALE));
    getTaskWithTailEvents.mockResolvedValue(idleTail());
    const res = await call();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(STALE);
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });

  it("准入条件不满足：只回错误、不写事件", async () => {
    advanceTask.mockRejectedValue(new Error("准入条件不满足：build 前必须先有 plan"));
    getTaskWithTailEvents.mockResolvedValue(idleTail());
    const res = await call();
    expect(res.status).toBe(400);
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });

  it("runner 已写过同文案 error（wk 门禁 / 测试任务切分支）：不重复写", async () => {
    advanceTask.mockRejectedValue(new Error(WORKTREE_MSG));
    getTaskWithTailEvents.mockResolvedValue(
      idleTail([{ kind: "error", text: WORKTREE_MSG, ts: Date.now() + 5_000 }]),
    );
    await call();
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });

  it("任务此刻正在 running（并发撞车）：不往事件流塞失败", async () => {
    advanceTask.mockRejectedValue(new Error(WORKTREE_MSG));
    getTaskWithTailEvents.mockResolvedValue({ ...idleTail(), runStatus: "running" });
    await call();
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });

  it("补写事件本身抛错 / 读尾部事件抛错：仍然返回真正的错误响应", async () => {
    advanceTask.mockRejectedValue(new Error(WORKTREE_MSG));
    getTaskWithTailEvents.mockResolvedValue(idleTail());
    writeOwnedEventAndPublish.mockRejectedValue(new Error("磁盘满"));
    let res = await call();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(WORKTREE_MSG);

    getTaskWithTailEvents.mockRejectedValue(new Error("读盘失败"));
    res = await call();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(WORKTREE_MSG);
  });

  it("成功路径不受影响：200、不写失败事件", async () => {
    advanceTask.mockResolvedValue({ action: { id: "act_1" } });
    getTaskWithTailEvents.mockResolvedValue(idleTail());
    const res = await call();
    expect(res.status).toBe(200);
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });
});
