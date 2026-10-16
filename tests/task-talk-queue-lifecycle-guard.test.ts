/**
 * G5-03：入队（enqueueTalkMessage）必须复查 lifecycle。
 *
 * handleTaskQuestionInject 在入口查过一次 lifecycle，之后到 tryQueueWhenBusy 之间还有
 * `await getTaskWithTailEvents`（读盘，机器忙时可达数百毫秒）。这段 await 里用户点
 * 停止 / 删除 / 终结，对应的清队调用（stop 清 app、finalize / DELETE 整队清）可能已经跑完，
 * 随后这条在途请求才落进队列——stop 之后复活一条用户本想取消的输入条，
 * 或给已删 / 已终结的任务留下带启动凭据（bootArgs.apiKey）的内存条目。
 *
 * 注意：opGen（stop 已彻底结束、lifecycle 已放开之后才入队）在本模块里判不了，
 * 只能由调用方 task-question-inject.ts 在 tryQueueWhenBusy 前复查（报告里单列）。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tq-lifecycle-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { runningTasks } = await import("@/lib/server/task-stream");
const taskFs = await import("@/lib/server/task-fs");
const { beginChatLifecycle, clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const {
  __resetTaskTalkQueueForTest,
  enqueueTalkMessage,
  listTalkQueue,
} = await import("@/lib/server/task-talk-queue");
const { handleTaskQuestionInject } = await import(
  "@/lib/server/task-question-inject"
);

const TASK_ID = "tq_lifecycle_guard";

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
  events: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

afterEach(() => {
  clearChatGate(TASK_ID);
  runningTasks.clear();
  __resetTaskTalkQueueForTest();
  vi.restoreAllMocks();
});

describe("G5-03：enqueueTalkMessage 复查 lifecycle", () => {
  for (const phase of ["stopping", "deleting", "finalizing"] as const) {
    it(`lifecycle=${phase}：拒入队（reason=closing），队列里不留条目`, () => {
      expect(beginChatLifecycle(TASK_ID, phase)).toBe(true);
      const r = enqueueTalkMessage(TASK_ID, {
        source: "app",
        rawBody: { text: "在途请求晚到的一句" },
        options: {},
      });
      expect(r).toEqual({ ok: false, reason: "closing" });
      expect(listTalkQueue(TASK_ID)).toHaveLength(0);
    });
  }

  it("lifecycle 干净时照常入队（防护不误伤正常路径）", () => {
    const r = enqueueTalkMessage(TASK_ID, {
      source: "app",
      rawBody: { text: "正常" },
      options: {},
    });
    expect(r).toMatchObject({ ok: true, position: 1 });
    expect(listTalkQueue(TASK_ID)).toHaveLength(1);
  });

  it("lifecycle 放开后恢复入队（只在窗口内拒）", () => {
    beginChatLifecycle(TASK_ID, "stopping");
    expect(
      enqueueTalkMessage(TASK_ID, { source: "app", rawBody: { text: "a" }, options: {} }),
    ).toMatchObject({ ok: false });
    endChatLifecycle(TASK_ID, "stopping");
    expect(
      enqueueTalkMessage(TASK_ID, { source: "app", rawBody: { text: "b" }, options: {} }),
    ).toMatchObject({ ok: true });
  });
});

describe("G5-03：真实注入链——tail 读盘 await 期间 lifecycle 起来，在途请求不得再入队", () => {
  it("handleTaskQuestionInject：await 期间进入 stopping → 409、不入队", async () => {
    vi.spyOn(taskFs, "getTaskMeta").mockResolvedValue(runningMeta() as never);
    // 入口的 lifecycle 闸已过；此后读尾部事件的 await 里，用户点了停止
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockImplementation(async () => {
      beginChatLifecycle(TASK_ID, "stopping");
      return runningMeta() as never;
    });
    runningTasks.set(TASK_ID, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });

    const res = await handleTaskQuestionInject(
      TASK_ID,
      { text: "用户点停止前一刻发的", bootArgs: { apiKey: "k", model: { id: "m" } } },
      { queueIfBusy: { source: "app", clientItemId: "c-race" } },
    );

    expect(res.status).toBe(409);
    expect(listTalkQueue(TASK_ID)).toHaveLength(0);
  });
});
