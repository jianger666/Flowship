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
const setTaskLastRewind = vi.fn();
const executeChatRewind = vi.fn();
const executeChatEditRewind = vi.fn();

vi.mock("@/lib/server/task-stream", () => ({
  writeEventAndPublish: (...a: unknown[]) => writeEventAndPublish(...a),
  publishTaskStreamEvent: (...a: unknown[]) => publishTaskStreamEvent(...a),
}));
vi.mock("@/lib/server/task-fs", () => ({
  getTask: vi.fn(),
  setTaskLastRewind: (...a: unknown[]) => setTaskLastRewind(...a),
}));
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
      ts: 1, // = 标记事件的 ts（D9-04 的 lastRewind.ts）
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
      ts: expect.any(Number), // 没有标记事件可借时间 → 路由取当前时刻
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

describe("rewind route · lastRewind 落 meta、随 task 快照下发（D9-04）", () => {
  it("回退成功后把 { fromEventId, keptCount, markerEventId, ts } 写进 meta；响应 task 与 SSE 快照都带它", async () => {
    fakeRewindThatWritesMarker();
    writeEventAndPublish.mockResolvedValue({ id: "ev_marker", ts: 4242, kind: "info", text: "x" });

    const res = await call({ eventId: "ev_target" });
    const json = await res.json();
    const expected = {
      fromEventId: "ev_target",
      keptCount: 3,
      markerEventId: "ev_marker",
      ts: 4242,
    };
    expect(setTaskLastRewind).toHaveBeenCalledTimes(1);
    expect(setTaskLastRewind).toHaveBeenCalledWith("t_1", expected);
    // 响应体的 task 是回退过程中读的、早于落盘——路由要把 lastRewind 补进去
    expect(json.task.lastRewind).toEqual(expected);
    expect(json.rewound.ts).toBe(4242);
    const published = publishTaskStreamEvent.mock.calls[0]![1] as { kind: string; task: { lastRewind: unknown } };
    expect(published.kind).toBe("task");
    expect(published.task.lastRewind).toEqual(expected);
  });

  it("标记事件没写成：lastRewind 仍落盘（markerEventId=null），靠 fromEventId / keptCount 对齐", async () => {
    fakeRewindThatWritesMarker();
    writeEventAndPublish.mockResolvedValue(null);
    await call({ eventId: "ev_target" });
    expect(setTaskLastRewind).toHaveBeenCalledWith(
      "t_1",
      expect.objectContaining({ fromEventId: "ev_target", keptCount: 3, markerEventId: null, ts: expect.any(Number) }),
    );
  });

  it("落盘失败只告警：回退已提交，仍 200，响应带 rewound（不让已成功的回退报错）", async () => {
    fakeRewindThatWritesMarker();
    writeEventAndPublish.mockResolvedValue({ id: "ev_marker", ts: 1, kind: "info", text: "x" });
    setTaskLastRewind.mockRejectedValueOnce(new Error("EIO"));
    const res = await call({ eventId: "ev_target" });
    expect(res.status).toBe(200);
    expect((await res.json()).rewound.fromEventId).toBe("ev_target");
  });

  it("回退失败（409 等）时不写 lastRewind", async () => {
    const { RewindError } = await import("../src/lib/server/chat-checkpoint");
    executeChatRewind.mockRejectedValueOnce(new RewindError("run_active", "agent 正在跑", 409));
    const res = await call({ eventId: "ev_target" });
    expect(res.status).toBe(409);
    expect(setTaskLastRewind).not.toHaveBeenCalled();
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
      ts: 1,
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

describe("rewind route · 失败响应带稳定 code（V7-06）", () => {
  // 前端按 code 选提示、不再匹配中文报错文案；`reason` 是细分 409 用的，没有就退回 RewindError.code
  // 动态 import 拿到上面 mock 里透传的真实 RewindError
  const makeErr = async (
    ...args: ConstructorParameters<
      typeof import("../src/lib/server/chat-checkpoint").RewindError
    >
  ) => {
    const { RewindError } = await import("../src/lib/server/chat-checkpoint");
    return new RewindError(...args);
  };

  it("409 + reason：响应体 code = reason，error 文案原样保留（老前端仍能读 error）", async () => {
    const cases: Array<[string, string]> = [
      ["task_closing", "任务正在停止/删除、无法回退"],
      ["queue_draining", "正在发送排队消息、请稍后回退"],
      ["session_starting", "正在启动新会话、请稍后回退"],
      ["queue_pending", "仍有排队中的消息、请先停止或等待发送完成再回退"],
      ["rewind_in_progress", "已有回退在进行中"],
    ];
    for (const [reason, message] of cases) {
      executeChatRewind.mockRejectedValueOnce(
        await makeErr(
          "run_active",
          message,
          409,
          reason as ConstructorParameters<
            typeof import("../src/lib/server/chat-checkpoint").RewindError
          >[3],
        ),
      );
      const res = await call({ eventId: "ev_1" });
      expect(res.status, reason).toBe(409);
      const json = await res.json();
      expect(json.code, reason).toBe(reason);
      expect(json.error, reason).toBe(message);
    }
  });

  it("409 没有 reason（agent 正在跑）：code 退回 RewindError.code = run_active", async () => {
    executeChatRewind.mockRejectedValueOnce(
      await makeErr("run_active", "agent 正在跑、请先停止再回退", 409),
    );
    const res = await call({ eventId: "ev_1" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("run_active");
  });

  it("非 409 的 RewindError 也带 code（not_found / no_checkpoint / restore_failed）", async () => {
    for (const [code, status] of [
      ["no_checkpoint", 404],
      ["restore_failed", 500],
      ["not_chat", 409],
    ] as const) {
      executeChatRewind.mockRejectedValueOnce(await makeErr(code, "x", status));
      const res = await call({ eventId: "ev_1" });
      expect(res.status, code).toBe(status);
      expect((await res.json()).code, code).toBe(code);
    }
  });

  it("编辑回退（mode=edit）的 409 同样带 code", async () => {
    executeChatEditRewind.mockRejectedValueOnce(
      await makeErr("run_active", "已有回退在进行中", 409, "rewind_in_progress"),
    );
    const res = await call({ eventId: "ev_1", mode: "edit" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("rewind_in_progress");
  });

  it("未知异常仍是 500、不编造 code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    executeChatRewind.mockRejectedValueOnce(new Error("kaboom"));
    const res = await call({ eventId: "ev_1" });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBeUndefined();
  });
});
