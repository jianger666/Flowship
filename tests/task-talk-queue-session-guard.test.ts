/**
 * G5-02：托办回执（group_reply）重放时必须复查「活会话在场」。
 *
 * 入队时 group-route 只在 `agentSessions.has(taskId)` 才把回执当「数据喂回会话」
 * （会话不在不自动唤醒、不拉起全权限 agent，见 group-route 文件头）。但回执是在 agent
 * 正在跑时入的队、重放发生在 task 空闲之后——这中间会话可能已经没了
 * （最典型：用户点停止 → cancelTaskRun 关会话、action 标 cancelled；群来源按文档保留）。
 * 重放时 task-question-inject 看到「会话不在 + 当前 action cancelled」会走唤醒分支，
 * 等于外部机器人的回执数据把一个刚被停止的全权限 agent 重新叫醒——违背入队时的承诺。
 *
 * 走真实 drain（tick），只 mock 注入链本身（它是被保护的下游）。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-talk-q-guard-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockInject = vi.fn();
vi.mock("@/lib/server/task-question-inject", () => ({
  handleTaskQuestionInject: (...args: unknown[]) => mockInject(...args),
}));
vi.mock("@/lib/server/chat-gate", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/server/chat-gate")>();
  return { ...orig, getChatLifecycle: vi.fn(() => null) };
});

const { taskDir, writeMeta, readEvents } = await import(
  "@/lib/server/task-fs-core"
);
const { agentSessions, runningTasks } = await import(
  "@/lib/server/task-stream"
);
const {
  __resetTaskTalkQueueForTest,
  __tickTalkQueueDrainForTest,
  enqueueTalkMessage,
  listTalkQueue,
} = await import("@/lib/server/task-talk-queue");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`task-talk-queue-session-guard DATA_DIR 未隔离：${taskDir("probe")}`);
}

/** 停止后的典型状态：idle + 当前 action 已 cancelled（task-question-inject 据此会走唤醒分支） */
const mkStoppedTask = async (id: string): Promise<void> => {
  const meta = {
    id,
    title: "t",
    mode: "task",
    runStatus: "idle",
    repoStatus: "developing",
    repoPaths: [],
    actions: [
      {
        id: "act_1",
        type: "build",
        status: "cancelled",
        n: 1,
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
    ],
    currentActionId: "act_1",
    mrs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06;
  await writeMeta(meta);
};

const okResp = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

let seq = 0;
const alloc = (): string => `tq-guard-${Date.now()}-${seq++}`;

describe("G5-02：group_reply 重放复查活会话", () => {
  beforeEach(() => {
    mockInject.mockReset();
    mockInject.mockResolvedValue(okResp());
    agentSessions.clear();
    runningTasks.clear();
  });
  afterEach(() => {
    __resetTaskTalkQueueForTest();
    agentSessions.clear();
    runningTasks.clear();
  });

  it("会话已不在：托办回执不重放（不唤醒 agent）、条目出队、写 info 说明、不静默", async () => {
    const taskId = alloc();
    await mkStoppedTask(taskId);
    // 入队时会话在场（所以 group-route 才会走 feed 通道）；之后被停止关掉 = agentSessions 里没了
    enqueueTalkMessage(taskId, {
      source: "group_reply",
      rawBody: { text: "后端回执：学号 EAA5E7" },
      options: { correlatedAnswer: true },
      preview: "后端回执：学号 EAA5E7",
    });
    expect(agentSessions.has(taskId)).toBe(false);

    await __tickTalkQueueDrainForTest(taskId);

    expect(mockInject).not.toHaveBeenCalled();
    expect(listTalkQueue(taskId)).toHaveLength(0);
    const events = await readEvents(taskId);
    const info = events.find(
      (e) => e.kind === "info" && e.text?.includes("没送出去"),
    );
    expect(info).toBeTruthy();
    expect(info?.text).toContain("会话");
  });

  it("会话仍在：托办回执照常重放（保护只针对会话已丢的情形）", async () => {
    const taskId = alloc();
    await mkStoppedTask(taskId);
    agentSessions.set(taskId, {} as never);
    enqueueTalkMessage(taskId, {
      source: "group_reply",
      rawBody: { text: "后端回执" },
      options: { correlatedAnswer: true },
    });
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).toHaveBeenCalledTimes(1);
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });

  it("不波及其它来源：属主自己的群消息 / app 输入条在会话不在时仍照常重放（文档设计：停止只清 app）", async () => {
    const taskId = alloc();
    await mkStoppedTask(taskId);
    enqueueTalkMessage(taskId, {
      source: "group_owner",
      rawBody: { text: "属主在群里说的" },
      options: {},
    });
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).toHaveBeenCalledTimes(1);

    mockInject.mockClear();
    enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "输入条" },
      options: {},
    });
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).toHaveBeenCalledTimes(1);
  });

  it("队首是会话已丢的回执、后面还有别的条目：回执被丢弃后，后面的不被连带吞掉（下一轮 tick 照送）", async () => {
    const taskId = alloc();
    await mkStoppedTask(taskId);
    enqueueTalkMessage(taskId, {
      source: "group_reply",
      rawBody: { text: "回执" },
      options: { correlatedAnswer: true },
    });
    enqueueTalkMessage(taskId, {
      source: "group_owner",
      rawBody: { text: "属主追问" },
      options: {},
    });
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).not.toHaveBeenCalled();
    expect(listTalkQueue(taskId).map((e) => e.preview)).toEqual(["属主追问"]);
    await __tickTalkQueueDrainForTest(taskId);
    expect(mockInject).toHaveBeenCalledTimes(1);
  });
});
