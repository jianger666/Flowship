/**
 * G5-03 残留：入队前必须复查 opGen（不只是 lifecycle）。
 *
 * 上一轮在 enqueueTalkMessage 里补了 lifecycle 复查（tests/task-talk-queue-lifecycle-guard），
 * 但它只挡「stop / DELETE 还在收尾」的窗口。更晚的一种：stop 已经**整个跑完**——
 * revokeTaskOps 已 bump opGen、清队已执行、lifecycle 也已放开——这时才轮到在途请求入队，
 * enqueueTalkMessage 看到的 lifecycle 是干净的，照单全收（实测 202），用户刚取消的输入条复活。
 * opGen 只有注入链手里有，所以得由 task-question-inject 在 tryQueueWhenBusy 前复查。
 *
 * 另：`enqueueTalkMessage` 返回 reason=closing 时，原先和「队列已满」共用一句
 * 「排队已满（最多 10 条）」，用户被误导去等队列腾位置，实际是任务在停止 / 删除。
 *
 * 全部走真实注入链（真 opGen / 真 lifecycle / 真队列），只 mock 读盘。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tq-stale-enqueue-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { runningTasks, revokeTaskOps } = await import(
  "@/lib/server/task-stream"
);
const taskFs = await import("@/lib/server/task-fs");
const askSkip = await import("@/lib/server/ask-skip");
const talkQueue = await import("@/lib/server/task-talk-queue");
const { beginChatLifecycle, clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { handleTaskQuestionInject } = await import(
  "@/lib/server/task-question-inject"
);
const { TASK_OP_STALE_HTTP_MESSAGE } = await import(
  "@/lib/server/task-runner"
);

const { __resetTaskTalkQueueForTest, clearTalkQueue, listTalkQueue } = talkQueue;

const TASK_ID = "tq_stale_enqueue";

const runningMeta = () => ({
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
  events: [] as unknown[],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

/** agent 真在跑：runningTasks 占位（注入链据此走「忙 → 入队」分支） */
const markRunning = (): void => {
  runningTasks.set(TASK_ID, {
    instanceId: 1,
    agentId: "a",
    startedAt: Date.now(),
    startSnapshot: { title: "" },
    cancel: () => {},
  });
};

/**
 * 模拟「stop 在这条在途请求的 await 期间整个跑完」：
 * lifecycle 占位 → revoke（bump opGen）→ 清队 → lifecycle 放开。
 * 与 stop-task.ts 的真实收尾顺序一致，结束后 lifecycle 是干净的。
 */
const stopCompletesMeanwhile = (): void => {
  beginChatLifecycle(TASK_ID, "stopping");
  revokeTaskOps(TASK_ID);
  clearTalkQueue(TASK_ID, { onlySources: ["app"] });
  endChatLifecycle(TASK_ID, "stopping");
};

const body = {
  text: "用户点停止前一刻发的",
  bootArgs: { apiKey: "k", model: { id: "m" } },
};

afterEach(() => {
  clearChatGate(TASK_ID);
  runningTasks.clear();
  __resetTaskTalkQueueForTest();
  vi.restoreAllMocks();
});

describe("G5-03 残留：stop 整个跑完后晚到的在途请求不得入队（opGen 复查）", () => {
  it("入口 busy 分支：读尾部事件的 await 期间 stop 跑完 → 409 + 作废文案、队列空", async () => {
    vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningMeta() as never);
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockImplementation(async () => {
      stopCompletesMeanwhile();
      return runningMeta() as never;
    });
    markRunning();

    const res = await handleTaskQuestionInject(TASK_ID, body, {
      queueIfBusy: { source: "app", clientItemId: "c-stop-done" },
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      TASK_OP_STALE_HTTP_MESSAGE,
    );
    expect(listTalkQueue(TASK_ID)).toHaveLength(0);
  });

  it("待答提问 + busy 分支：跳过认领的 await 期间 stop 跑完 → 409、队列空", async () => {
    const askEvent = {
      id: "ev_ask",
      ts: Date.now(),
      kind: "ask_user_request",
      text: "要不要?",
      actionId: "act_run",
      meta: { askId: "ask_stale_enqueue", token: "tk" },
    };
    vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningMeta() as never);
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockResolvedValue({
      ...runningMeta(),
      events: [askEvent],
    } as never);
    // 尾部读盘 / 图片 / snapshot 之后的几处 stale 复查都已过；这条是第二处入队点之前
    // 唯一剩下的 await（等 curl 吃跳过正文），stop 就在这里跑完
    vi.spyOn(askSkip, "fulfillAskSkipViaWait").mockImplementation(async () => {
      stopCompletesMeanwhile();
      return false;
    });
    markRunning();

    const res = await handleTaskQuestionInject(TASK_ID, body, {
      queueIfBusy: { source: "app", clientItemId: "c-stop-done-2" },
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      TASK_OP_STALE_HTTP_MESSAGE,
    );
    expect(listTalkQueue(TASK_ID)).toHaveLength(0);
  });

  it("没发生 stop 时照常 202 入队（复查不误伤正常路径）", async () => {
    vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningMeta() as never);
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockResolvedValue(
      runningMeta() as never,
    );
    markRunning();

    const res = await handleTaskQuestionInject(TASK_ID, body, {
      queueIfBusy: { source: "app", clientItemId: "c-normal" },
    });

    expect(res.status).toBe(202);
    expect(listTalkQueue(TASK_ID)).toHaveLength(1);
  });
});

describe("G5-03 残留：入队被拒的文案按原因区分", () => {
  it("await 期间 lifecycle 在收尾（stopping）→ 409 文案说「正在停止」，不是「排队已满」", async () => {
    vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningMeta() as never);
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockImplementation(async () => {
      beginChatLifecycle(TASK_ID, "stopping");
      return runningMeta() as never;
    });
    markRunning();

    const res = await handleTaskQuestionInject(TASK_ID, body, {
      queueIfBusy: { source: "app" },
    });

    expect(res.status).toBe(409);
    const msg = ((await res.json()) as { error: string }).error;
    expect(msg).toContain("停止");
    expect(msg).not.toContain("排队已满");
    expect(listTalkQueue(TASK_ID)).toHaveLength(0);
  });

  it("enqueueTalkMessage 返回 reason=closing（兜底分支）→ 409 + 停止 / 关闭文案", async () => {
    vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningMeta() as never);
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockResolvedValue(
      runningMeta() as never,
    );
    // 本模块的复查都过了（lifecycle 干净、opGen 没变），只让队列自己说 closing，
    // 单独钉住 `!r.ok` 分支的文案
    vi.spyOn(talkQueue, "enqueueTalkMessage").mockReturnValue({
      ok: false,
      reason: "closing",
    });
    markRunning();

    const res = await handleTaskQuestionInject(TASK_ID, body, {
      queueIfBusy: { source: "app" },
    });

    expect(res.status).toBe(409);
    const msg = ((await res.json()) as { error: string }).error;
    expect(msg).toMatch(/停止|关闭|删除|终结/);
    expect(msg).not.toContain("排队已满");
  });

  it("reason=full 仍是「排队已满」409（对照：只改 closing）", async () => {
    vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningMeta() as never);
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockResolvedValue(
      runningMeta() as never,
    );
    vi.spyOn(talkQueue, "enqueueTalkMessage").mockReturnValue({
      ok: false,
      reason: "full",
    });
    markRunning();

    const res = await handleTaskQuestionInject(TASK_ID, body, {
      queueIfBusy: { source: "app" },
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      "排队已满",
    );
  });
});
