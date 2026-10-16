/**
 * POST /api/tasks/[id]/rewind 的 route handler 行为测试（R6-03 / R6-05）：
 * 真调 handler，mock 掉 checkpoint 执行体 / 事件写入，断言
 * - 写出的 info 事件 meta 带回退标记（被回退事件 id + 保留条数）
 * - 响应体带 rewound / markerEventWritten，标记事件写失败时回退仍算成功（不回滚、不报错）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { REWIND_KEPT_META_KEY, REWIND_META_KEY } from "../src/lib/rewind-marker";

const writeEventAndPublish = vi.fn();
const publishTaskStreamEvent = vi.fn();
const executeChatRewind = vi.fn();
const executeChatEditRewind = vi.fn();

vi.mock("@/lib/server/task-stream", () => ({
  writeEventAndPublish: (...a: unknown[]) => writeEventAndPublish(...a),
  publishTaskStreamEvent: (...a: unknown[]) => publishTaskStreamEvent(...a),
}));
vi.mock("@/lib/server/task-fs", () => ({ getTask: vi.fn() }));
vi.mock("@/lib/server/chat-runner", () => ({
  closeChatSessionUnconditional: vi.fn(),
  isChatQueueDraining: vi.fn(() => false),
  isChatRunActive: vi.fn(() => false),
}));
vi.mock("@/lib/server/chat-checkpoint", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/server/chat-checkpoint")
  >("../src/lib/server/chat-checkpoint");
  return {
    RewindError: actual.RewindError,
    executeChatRewind: (...a: unknown[]) => executeChatRewind(...a),
    executeChatEditRewind: (...a: unknown[]) => executeChatEditRewind(...a),
  };
});

import { POST } from "../src/app/api/tasks/[id]/rewind/route";

const call = (body: unknown) =>
  POST(
    new Request("http://x/api/tasks/t_1/rewind", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "t_1" }) },
  );

/** 模拟 executeChatRewind：截断成功（保留 3 条）后调 deps.appendInfoEvent，再返回结果 */
const fakeRewindThatWritesMarker = () =>
  executeChatRewind.mockImplementation(
    async (
      taskId: string,
      _eventId: string,
      deps: {
        appendInfoEvent: (
          t: string,
          text: string,
          info: { keptEventCount: number },
        ) => Promise<unknown>;
      },
    ) => {
      await deps.appendInfoEvent(taskId, "已回退", { keptEventCount: 3 });
      return {
        ok: true,
        task: { id: taskId, events: [] },
        restoredRepos: [],
        truncatedEventCount: 2,
        keptEventCount: 3,
      };
    },
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("rewind route", () => {
  it("写出的 info 事件带回退标记 meta；响应体带 rewound（含 markerEventId）", async () => {
    fakeRewindThatWritesMarker();
    writeEventAndPublish.mockResolvedValue({ id: "ev_marker", ts: 1, kind: "info", text: "x" });

    const res = await call({ eventId: "ev_target" });
    expect(res.status).toBe(200);

    expect(writeEventAndPublish).toHaveBeenCalledTimes(1);
    const [taskId, written] = writeEventAndPublish.mock.calls[0];
    expect(taskId).toBe("t_1");
    expect(written.kind).toBe("info");
    expect(written.meta).toEqual({
      [REWIND_META_KEY]: "ev_target",
      [REWIND_KEPT_META_KEY]: 3,
    });

    const json = await res.json();
    expect(json.rewound).toEqual({
      fromEventId: "ev_target",
      keptCount: 3,
      markerEventId: "ev_marker",
    });
    expect(json.markerEventWritten).toBe(true);
  });

  it("标记事件写失败（返回 null）：回退照常成功，响应体带 rewound + markerEventWritten:false", async () => {
    fakeRewindThatWritesMarker();
    writeEventAndPublish.mockResolvedValue(null);

    const res = await call({ eventId: "ev_target" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.markerEventWritten).toBe(false);
    // 客户端不依赖事件，直接据响应体截断
    expect(json.rewound).toEqual({
      fromEventId: "ev_target",
      keptCount: 3,
      markerEventId: null,
    });
  });

  it("标记事件写入抛错：同样不报错、不回滚，响应体兜底", async () => {
    fakeRewindThatWritesMarker();
    writeEventAndPublish.mockRejectedValue(new Error("EIO"));

    const res = await call({ eventId: "ev_target" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.markerEventWritten).toBe(false);
    expect(json.rewound.fromEventId).toBe("ev_target");
    expect(json.rewound.keptCount).toBe(3);
  });

  it("缺 eventId → 400 且不执行回退", async () => {
    const res = await call({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(executeChatRewind).not.toHaveBeenCalled();
    expect(executeChatEditRewind).not.toHaveBeenCalled();
  });
});

describe("rewind route · mode", () => {
  const okResult = {
    ok: true,
    task: { id: "t_1", events: [] },
    restoredRepos: [],
    truncatedEventCount: 2,
    keptEventCount: 3,
  };

  it("缺省 / mode=rewind：走严格回退（要文件检查点），不碰编辑回退", async () => {
    executeChatRewind.mockResolvedValue(okResult);
    for (const body of [
      { eventId: "ev_1" },
      { eventId: "ev_1", mode: "rewind" },
    ]) {
      const res = await call(body);
      expect(res.status).toBe(200);
    }
    expect(executeChatRewind).toHaveBeenCalledTimes(2);
    expect(executeChatEditRewind).not.toHaveBeenCalled();
  });

  it("mode=edit：走编辑回退（无检查点也能只回退对话），不碰严格回退", async () => {
    executeChatEditRewind.mockResolvedValue(okResult);
    const res = await call({ eventId: "ev_1", mode: "edit" });
    expect(res.status).toBe(200);
    expect(executeChatEditRewind).toHaveBeenCalledTimes(1);
    expect(executeChatEditRewind.mock.calls[0]![0]).toBe("t_1");
    expect(executeChatEditRewind.mock.calls[0]![1]).toBe("ev_1");
    expect(executeChatRewind).not.toHaveBeenCalled();
  });

  it("mode=edit 的回退标记同样写出（客户端据此截断本地窗口）", async () => {
    executeChatEditRewind.mockImplementation(
      async (
        taskId: string,
        _eventId: string,
        deps: {
          appendInfoEvent: (
            t: string,
            text: string,
            info: { keptEventCount: number },
          ) => Promise<unknown>;
        },
      ) => {
        await deps.appendInfoEvent(taskId, "已回退（仅对话）", {
          keptEventCount: 4,
        });
        return { ...okResult, keptEventCount: 4 };
      },
    );
    writeEventAndPublish.mockResolvedValue({ id: "ev_m", ts: 1, kind: "info", text: "x" });
    const res = await call({ eventId: "ev_9", mode: "edit" });
    const json = await res.json();
    expect(writeEventAndPublish.mock.calls[0]![1].meta).toEqual({
      [REWIND_META_KEY]: "ev_9",
      [REWIND_KEPT_META_KEY]: 4,
    });
    expect(json.rewound).toEqual({
      fromEventId: "ev_9",
      keptCount: 4,
      markerEventId: "ev_m",
    });
  });

  it("未知 mode → 400，什么都不执行", async () => {
    for (const mode of ["force", 1, null, ""]) {
      const res = await call({ eventId: "ev_1", mode });
      expect(res.status).toBe(400);
    }
    expect(executeChatRewind).not.toHaveBeenCalled();
    expect(executeChatEditRewind).not.toHaveBeenCalled();
  });
});
