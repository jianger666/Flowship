/**
 * handleTaskQuestionInject queueIfBusy：agent 真在跑时 202 入队
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tq-inject-q-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { runningTasks } = await import("@/lib/server/task-stream");
const taskFs = await import("@/lib/server/task-fs");
const {
  __resetTaskTalkQueueForTest,
  enqueueTalkMessage,
  listTalkQueue,
  TALK_QUEUE_MAX,
} = await import("@/lib/server/task-talk-queue");
const { handleTaskQuestionInject } = await import(
  "@/lib/server/task-question-inject"
);

const TASK_ID = "inject_q1";

const runningTaskMeta = () => ({
  id: TASK_ID,
  title: "t",
  mode: "task" as const,
  runStatus: "running" as const,
  repoStatus: "developing" as const,
  repoPaths: [] as string[],
  actions: [
    {
      id: "act_run",
      type: "build" as const,
      status: "running" as const,
      n: 1,
      userInstruction: "",
      artifactPath: null,
      startedAt: Date.now(),
      endedAt: Date.now(),
    },
  ],
  currentActionId: "act_run",
  mrs: [],
  events: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

/** 把 task 摆成「agent 真在跑」：meta / 尾部事件 mock + runningTasks 占位 */
const arrangeRunning = (instanceId: number): void => {
  vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningTaskMeta() as never);
  vi.spyOn(taskFs, "getTaskWithTailEvents").mockResolvedValue({
    ...runningTaskMeta(),
    events: [],
  } as never);
  runningTasks.set(TASK_ID, {
    instanceId,
    agentId: "a",
    startedAt: Date.now(),
    startSnapshot: { title: "" },
    cancel: () => {},
  });
};

afterEach(() => {
  runningTasks.clear();
  __resetTaskTalkQueueForTest();
  vi.restoreAllMocks();
});

describe("handleTaskQuestionInject queueIfBusy", () => {
  it("running 且 queueIfBusy → 202 + 入队", async () => {
    vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningTaskMeta() as never);
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockResolvedValue({
      ...runningTaskMeta(),
      events: [],
    } as never);
    runningTasks.set(TASK_ID, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });

    const res = await handleTaskQuestionInject(
      TASK_ID,
      {
        text: "下一轮要说的话",
        bootArgs: { apiKey: "k", model: { id: "composer" } },
      },
      {
        queueIfBusy: {
          source: "group_owner",
          senderName: "我",
          clientItemId: "om_1",
        },
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      ok?: boolean;
      queued?: boolean;
      itemId?: string;
      position?: number;
    };
    expect(body).toMatchObject({ ok: true, queued: true, position: 1 });
    expect(listTalkQueue(TASK_ID)).toHaveLength(1);
    expect(listTalkQueue(TASK_ID)[0]?.source).toBe("group_owner");
  });

  it("restrictToQuestion 不走 talk 队列", async () => {
    vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningTaskMeta() as never);
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockResolvedValue({
      ...runningTaskMeta(),
      events: [],
    } as never);
    runningTasks.set(TASK_ID, {
      instanceId: 2,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });

    const res = await handleTaskQuestionInject(
      TASK_ID,
      { text: "群里同事问", bootArgs: { apiKey: "k", model: { id: "m" } } },
      {
        restrictToQuestion: true,
        queueIfBusy: { source: "app" },
      },
    );
    expect(res.status).toBe(409);
    expect(listTalkQueue(TASK_ID)).toHaveLength(0);
  });

  it("不带 queueIfBusy 仍 409、不入队（原行为不变）", async () => {
    arrangeRunning(3);
    const res = await handleTaskQuestionInject(TASK_ID, {
      text: "x",
      bootArgs: { apiKey: "k", model: { id: "m" } },
    });
    expect(res.status).toBe(409);
    expect(listTalkQueue(TASK_ID)).toHaveLength(0);
  });

  it("队列已满 → 409「排队已满」、不挤掉已排的", async () => {
    arrangeRunning(4);
    for (let i = 0; i < TALK_QUEUE_MAX; i++) {
      enqueueTalkMessage(TASK_ID, {
        source: "app",
        rawBody: { text: `m${i}` },
        options: {},
      });
    }
    const res = await handleTaskQuestionInject(
      TASK_ID,
      { text: "溢出", bootArgs: { apiKey: "k", model: { id: "m" } } },
      { queueIfBusy: { source: "app" } },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("排队已满");
    expect(listTalkQueue(TASK_ID)).toHaveLength(TALK_QUEUE_MAX);
  });

  it("clientItemId 幂等：同键重复提交只排一条（返回同一 itemId）", async () => {
    arrangeRunning(5);
    const send = () =>
      handleTaskQuestionInject(
        TASK_ID,
        { text: "同一句", bootArgs: { apiKey: "k", model: { id: "m" } } },
        { queueIfBusy: { source: "app", clientItemId: "c-1" } },
      );
    const a = (await (await send()).json()) as { itemId: string };
    const b = (await (await send()).json()) as { itemId: string };
    expect(b.itemId).toBe(a.itemId);
    expect(listTalkQueue(TASK_ID)).toHaveLength(1);
  });
});
