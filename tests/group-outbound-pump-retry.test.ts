/**
 * G3-01 补强：done 帧触发的 pump 撞上「run 还没摘 runningTasks」的收尾窗口，排队问题不能被饿死。
 *
 * 时序（task-runner.ts）：先 publish done（runStatus 此时已落 idle），之后才 `await finalizeOpenToolCalls`
 * 并 `runningTasks.delete`。出向 tap 在 done 帧上马上 pump，而「忙」的判据是
 * `runningTasks.has(id) || runStatus === "running"`——这个窗口里 pump 看到「还在忙」、把队首静默放回，
 * 之后没有任何帧再触发排空（要等下一条群 @ 或 30 分钟后回「超时作废」）。
 *
 * 前一版 G3-01 的测试把「忙」mock 掉了，覆盖不到这个窗口；这里用真实的 runningTasks 占位 + 真实 pump。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-outbound-pump-retry-${Date.now()}`,
  "data",
);

const {
  GROUP_PUMP_RETRY_DELAYS_MS,
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  handleGroupOutboundEvent,
} = await import("@/lib/server/feishu-bridge/group-outbound");
const { __setGroupRouteDepsForTest } = await import(
  "@/lib/server/feishu-bridge/group-route"
);
const {
  __resetGroupReplyStateForTest,
  enqueueGroupQuestion,
  groupQuestionQueueLength,
} = await import("@/lib/server/feishu-bridge/group-shared");
const { runningTasks } = await import("@/lib/server/task-stream");

const CHAT = "oc_req_group";
const TASK = "task-retry-1";

const fullTask = (): Task =>
  ({
    id: TASK,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    repoPaths: ["/tmp/repo"],
    mrs: [],
    actions: [],
    events: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    feishuStoryUrl: "https://project.feishu.cn/space/story/detail/10001",
  }) as unknown as Task;

const seedQueued = (messageId = "om_q1", text = "埋点查了吗") =>
  enqueueGroupQuestion(TASK, {
    messageId,
    chatId: CHAT,
    text,
    parsed: { text, images: [], attachments: [] } as never,
    requester: { openId: "ou_li", name: "李四" },
    boot: { apiKey: "k", model: { id: "m" } },
  });

const markRunning = (): void => {
  runningTasks.set(TASK, {
    instanceId: 1,
    agentId: "a",
    startedAt: Date.now(),
    startSnapshot: { title: "" },
    cancel: () => {},
  });
};

let handleTaskQuestionInject: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  __resetGroupReplyStateForTest();
  handleTaskQuestionInject = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  __setGroupRouteDepsForTest({
    handleTaskQuestionInject,
    sendTextToChat: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" })),
    getTask: async () => fullTask(),
    getPendingAsk: () => null,
  } as never);
  __setGroupOutboundDepsForTest({ isBridgeEnabled: async () => true });
});

afterEach(() => {
  runningTasks.delete(TASK);
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __setGroupRouteDepsForTest(null);
  __resetGroupReplyStateForTest();
  vi.useRealTimers();
});

const doneFrame = () =>
  handleGroupOutboundEvent(TASK, {
    kind: "done",
    task: fullTask(),
    ok: true,
  });

describe("G3-01 补强：done 帧撞上收尾窗口（runningTasks 还没摘）", () => {
  it("done 时 run 还占着 runningTasks → 先静默放回；run 摘掉后，延迟重试把队首放出去", async () => {
    seedQueued();
    markRunning();

    await doneFrame();
    // 此刻还忙：不注入、不丢（放回队首）
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength(TASK)).toBe(1);

    // task-runner 收尾：摘掉 runningTasks（done 之后才发生）
    runningTasks.delete(TASK);
    await vi.advanceTimersByTimeAsync(GROUP_PUMP_RETRY_DELAYS_MS[0] + 5);

    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(groupQuestionQueueLength(TASK)).toBe(0);
  });

  it("窗口比第一次重试还长 → 后续重试继续接力，直到放出", async () => {
    seedQueued();
    markRunning();
    await doneFrame();

    // 第一次重试仍忙
    await vi.advanceTimersByTimeAsync(GROUP_PUMP_RETRY_DELAYS_MS[0] + 5);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength(TASK)).toBe(1);

    runningTasks.delete(TASK);
    await vi.advanceTimersByTimeAsync(GROUP_PUMP_RETRY_DELAYS_MS[1] + 5);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(groupQuestionQueueLength(TASK)).toBe(0);
  });

  it("一直忙（新 run 接着跑）：重试有上限，耗尽后停手、不无限轮询；队首仍在队里等下一个 done", async () => {
    seedQueued();
    markRunning();
    await doneFrame();

    await vi.advanceTimersByTimeAsync(
      GROUP_PUMP_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 100,
    );
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength(TASK)).toBe(1);
    // 没有残留定时器（再走很久也不会有新的 pump）
    expect(vi.getTimerCount()).toBe(0);
  });

  it("队列为空：done 帧不挂任何定时器", async () => {
    await doneFrame();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("连着来多个 done 帧：只有一条重试链（不会成倍堆定时器）", async () => {
    seedQueued();
    markRunning();
    await doneFrame();
    await doneFrame();
    await doneFrame();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("重置（单测 / 关桥接）会清掉在途重试，不留野定时器", async () => {
    seedQueued();
    markRunning();
    await doneFrame();
    expect(vi.getTimerCount()).toBe(1);
    __resetGroupOutboundForTest();
    expect(vi.getTimerCount()).toBe(0);
  });
});
