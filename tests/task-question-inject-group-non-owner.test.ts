/**
 * `groupNonOwner`：非属主并入属主同一个活会话（逐条各跑一轮）—— 注入链这一层的语义。
 *
 * 钉死的硬边界（与 restrictToQuestion 那条「绝不碰活会话」正好相反的另一条路，所以每一条都要有对照）：
 * 1. 只送活会话：内存里没有会话 / 送达时会话没了 → 409，**绝不** resume 唤醒休眠会话、绝不起一次性 agent、
 *    绝不起只读旁路（降级旁路是入向 group-route 在「没有活会话」时自己选的路，不在这里）
 * 2. 不传 creds 给 deliverTaskQuestion（传了它会把休眠会话复活成全权限会话）
 * 3. 不带 ackContext：不 snapshot 产物、不把 awaiting_ack 的 action 打回 running 重交卷
 * 4. 提示词开关现读：guard=true 才在送达的消息里追加「只答疑」约束段 + 本轮系统工具硬拒（这里只验传给 deliver 的标记）
 * 5. 忙时入 task 待送达队列（source=group_other，独立上限 5 + 每人 2 条），队满给人话
 *
 * 全部 mock 外部调用——不起 agent、不碰盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

const {
  agentSessions,
  deliverTaskQuestion,
  getChatLifecycle,
  getTask,
  getTaskMeta,
  getTaskWithTailEvents,
  getPendingAsk,
  isGroupNonOwnerGuardEnabled,
  isTaskOpStale,
  patchActionAndRunStatusIfOpFresh,
  publishTaskStreamEvent,
  resumeCurrentActionWithMessage,
  runningTasks,
  saveImageAttachments,
  setTaskRunStatusIfRunOwner,
  snapshotActionArtifact,
  startOneShotQuestion,
  startRestrictedGroupQuestion,
  supersedePendingAsks,
  waitForTaskToStop,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  const getTask = vi.fn<AnyFn>();
  const getTaskMeta = vi.fn<AnyFn>((...args: never[]) => getTask(...args));
  const getTaskWithTailEvents = vi.fn<AnyFn>(
    async (...args: never[]) => getTask(...args),
  );
  return {
    agentSessions: new Map<string, unknown>(),
    runningTasks: new Map<string, unknown>(),
    deliverTaskQuestion: vi.fn<AnyFn>(async () => "sent"),
    getChatLifecycle: vi.fn<AnyFn>(() => null),
    getTask,
    getTaskMeta,
    getTaskWithTailEvents,
    getPendingAsk: vi.fn<AnyFn>(() => null),
    isGroupNonOwnerGuardEnabled: vi.fn<AnyFn>(async () => true),
    isTaskOpStale: vi.fn<AnyFn>(() => false),
    patchActionAndRunStatusIfOpFresh: vi.fn<AnyFn>(async () => null),
    publishTaskStreamEvent: vi.fn<AnyFn>(),
    resumeCurrentActionWithMessage: vi.fn<AnyFn>(async () => undefined),
    saveImageAttachments: vi.fn<AnyFn>(async () => []),
    setTaskRunStatusIfRunOwner: vi.fn<AnyFn>(),
    snapshotActionArtifact: vi.fn<AnyFn>(async () => undefined),
    startOneShotQuestion: vi.fn<AnyFn>(),
    startRestrictedGroupQuestion: vi.fn<AnyFn>(),
    supersedePendingAsks: vi.fn<AnyFn>(async () => []),
    waitForTaskToStop: vi.fn<AnyFn>(async () => true),
    writeEventAndPublish: vi.fn<AnyFn>(async () => undefined),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "e1" })),
  };
});

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  getTaskMeta,
  getTaskWithTailEvents,
  patchActionAndRunStatusIfOpFresh,
  setTaskRunStatusIfRunOwner,
}));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments,
  snapshotActionArtifact,
}));
vi.mock("@/lib/server/chat-pending", () => ({
  clearPendingAsk: vi.fn(),
  getPendingAsk,
  takePendingAskIf: vi.fn(() => null),
  restorePendingAskIf: vi.fn(),
  wasAskTakenRecently: vi.fn(() => false),
}));
vi.mock("@/lib/server/task-runner", () => ({
  deliverTaskQuestion,
  isTaskOpStale,
  resumeCurrentActionWithMessage,
  startOneShotQuestion,
  supersedePendingAsks,
  TASK_OP_STALE_HTTP_MESSAGE: "任务状态刚变化、请重新发送",
}));
vi.mock("@/lib/server/restricted-question", () => ({
  startRestrictedGroupQuestion,
}));
vi.mock("@/lib/server/group-non-owner-guard-config", () => ({
  isGroupNonOwnerGuardEnabled,
}));
vi.mock("@/lib/server/task-stream", () => ({
  agentSessions,
  runningTasks,
  getTaskOpGeneration: () => 1,
  PERSIST_FAIL_RETRY_MESSAGE: "落盘失败、请重试",
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  publishTaskStreamEvent,
  waitForTaskToStop,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
}));
vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle }));

const { handleTaskQuestionInject, NON_OWNER_NO_SESSION_MESSAGE } = await import(
  "@/lib/server/task-question-inject"
);
const { __resetTaskTalkQueueForTest, listTalkQueue } = await import(
  "@/lib/server/task-talk-queue"
);

const TASK_ID = "task-1";

const ackTask = (): Task =>
  ({
    id: TASK_ID,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: "act-9",
    repoPaths: ["/tmp/repo"],
    mrs: [],
    actions: [
      {
        id: "act-9",
        n: 3,
        type: "review",
        status: "awaiting_ack",
        userInstruction: "",
        artifactPath: "actions/3-review.md",
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    events: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

const runningTask = (): Task => {
  const t = ackTask() as unknown as {
    runStatus: string;
    actions: Array<{ status: string }>;
  };
  t.runStatus = "running";
  t.actions[0]!.status = "running";
  return t as unknown as Task;
};

const bootArgs = { apiKey: "sk-test", model: { id: "m1" } };
const body = {
  text: "[群消息·来自 李四（非任务所有者）]\n这个接口返回啥？",
  bootArgs,
};
const META = {
  source: "feishu_group",
  groupChatId: "oc_x",
  groupSender: "李四",
  groupSenderOpenId: "ou_li",
  feishuMessageId: "om_1",
  groupNonOwnerTurn: true,
};
const nonOwnerOpts = (extra: Record<string, unknown> = {}) => ({
  restrictToQuestion: false,
  groupNonOwner: { name: "李四" },
  userReplyMetaExtra: META,
  ...extra,
});

const deliverArgs = (): unknown[] =>
  (deliverTaskQuestion as unknown as { mock: { calls: unknown[][] } }).mock
    .calls[0] ?? [];

const noWriteSideEffects = (): void => {
  expect(startOneShotQuestion).not.toHaveBeenCalled();
  expect(startRestrictedGroupQuestion).not.toHaveBeenCalled();
  expect(resumeCurrentActionWithMessage).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  agentSessions.clear();
  runningTasks.clear();
  __resetTaskTalkQueueForTest();
  getTask.mockImplementation(async () => ackTask());
  getChatLifecycle.mockReturnValue(null);
  isTaskOpStale.mockReturnValue(false);
  getPendingAsk.mockReturnValue(null);
  isGroupNonOwnerGuardEnabled.mockResolvedValue(true);
  deliverTaskQuestion.mockResolvedValue("sent");
  writeUserEventAndPublishStrict.mockResolvedValue({ id: "e1" });
  setTaskRunStatusIfRunOwner.mockImplementation(async () => ackTask());
});

afterEach(() => {
  agentSessions.clear();
  runningTasks.clear();
  __resetTaskTalkQueueForTest();
});

describe("活会话在场（awaiting_ack）：只送会话、不动审阅态", () => {
  it("送进活会话：不传 creds、不带 ackContext、不 snapshot / 不打回 running；不起任何别的 agent", async () => {
    agentSessions.set(TASK_ID, {});

    const resp = await handleTaskQuestionInject(TASK_ID, body, nonOwnerOpts());

    expect(resp.status).toBe(200);
    expect(deliverTaskQuestion).toHaveBeenCalledTimes(1);
    const a = deliverArgs();
    expect(a[3]).toBeUndefined(); // creds：不传 → 无内存会话时 deliver 直接 no_session、不 resume
    expect(a[4]).toBeUndefined(); // ackContext
    expect(snapshotActionArtifact).not.toHaveBeenCalled();
    expect(patchActionAndRunStatusIfOpFresh).not.toHaveBeenCalled();
    noWriteSideEffects();
    // 用户原文落盘带标记（出向据此现建登记、UI 据此识别）
    const ev = (writeUserEventAndPublishStrict as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]?.[1] as { kind: string; meta: Record<string, unknown> };
    expect(ev.kind).toBe("user_reply");
    expect(ev.meta).toMatchObject({
      groupNonOwnerTurn: true,
      groupSenderOpenId: "ou_li",
      feishuMessageId: "om_1",
    });
  });

  it("提示词开关开（默认）：标记 guard=true（追加只答疑约束段 + 本轮系统工具硬拒）", async () => {
    agentSessions.set(TASK_ID, {});
    isGroupNonOwnerGuardEnabled.mockResolvedValue(true);
    await handleTaskQuestionInject(TASK_ID, body, nonOwnerOpts());
    expect(deliverArgs()[9]).toEqual({ name: "李四", guard: true });
  });

  it("提示词开关关：guard=false（与属主同权，只剩身份抬头）", async () => {
    agentSessions.set(TASK_ID, {});
    isGroupNonOwnerGuardEnabled.mockResolvedValue(false);
    await handleTaskQuestionInject(TASK_ID, body, nonOwnerOpts());
    expect(deliverArgs()[9]).toEqual({ name: "李四", guard: false });
  });

  it("发言人是机器人：始终 guard=true（不看提示词开关），带 isBot 标记；开关关也一样", async () => {
    agentSessions.set(TASK_ID, {});
    isGroupNonOwnerGuardEnabled.mockResolvedValue(false);
    await handleTaskQuestionInject(
      TASK_ID,
      body,
      nonOwnerOpts({ groupNonOwner: { name: "别家机器人", isBot: true } }),
    );
    expect(deliverArgs()[9]).toEqual({ name: "别家机器人", guard: true, isBot: true });
    // 机器人不需要去读那个开关（读了也不改变结果）——不为它多读一次盘
    expect(isGroupNonOwnerGuardEnabled).not.toHaveBeenCalled();
  });

  it("没传发言人名：兜底「群成员」", async () => {
    agentSessions.set(TASK_ID, {});
    await handleTaskQuestionInject(
      TASK_ID,
      body,
      nonOwnerOpts({ groupNonOwner: { name: "  " } }),
    );
    expect(deliverArgs()[9]).toEqual({ name: "群成员", guard: true });
  });

  it("对照（属主）：不带 groupNonOwner 时照常带 ackContext + snapshot + 打回 running，deliver 末参为空", async () => {
    agentSessions.set(TASK_ID, {});
    const resp = await handleTaskQuestionInject(TASK_ID, body, {});
    expect(resp.status).toBe(200);
    expect(deliverArgs()[4]).toMatchObject({ actionId: "act-9" });
    expect(deliverArgs()[9]).toBeUndefined();
    expect(snapshotActionArtifact).toHaveBeenCalledTimes(1);
  });
});

describe("没有活会话：409，绝不唤醒 / 新起任何 agent", () => {
  it("内存里没有会话：409 人话提示，不 deliver、不 resume、不起一次性 / 旁路", async () => {
    const resp = await handleTaskQuestionInject(TASK_ID, body, nonOwnerOpts());
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toBe(
      NON_OWNER_NO_SESSION_MESSAGE,
    );
    expect(deliverTaskQuestion).not.toHaveBeenCalled();
    noWriteSideEffects();
    expect(setTaskRunStatusIfRunOwner).not.toHaveBeenCalled();
  });

  it("送达那一刻会话没了（deliver 回 no_session）：409，同样不唤醒 / 新起", async () => {
    agentSessions.set(TASK_ID, {});
    deliverTaskQuestion.mockResolvedValue("no_session");
    const resp = await handleTaskQuestionInject(TASK_ID, body, nonOwnerOpts());
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toBe(
      NON_OWNER_NO_SESSION_MESSAGE,
    );
    noWriteSideEffects();
  });

  it("对照（属主）：会话没了仍可唤醒当前 action（属主路径没被动）", async () => {
    deliverTaskQuestion.mockResolvedValue("no_session");
    const resp = await handleTaskQuestionInject(TASK_ID, body, {});
    expect(resp.status).toBe(200);
    expect(resumeCurrentActionWithMessage).toHaveBeenCalledTimes(1);
  });
});

describe("主链在跑：入 task 待送达队列（group_other）", () => {
  const arrangeRunning = () => {
    getTask.mockImplementation(async () => runningTask());
    agentSessions.set(TASK_ID, {});
    runningTasks.set(TASK_ID, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });
  };
  const send = (n: number, openId: string) =>
    handleTaskQuestionInject(
      TASK_ID,
      { ...body, text: `问题${n}` },
      nonOwnerOpts({
        queueIfBusy: {
          source: "group_other",
          senderName: openId,
          senderKey: openId,
          clientItemId: `om_${openId}_${n}`,
        },
      }),
    );

  it("忙时 202 入队、来源 group_other；不 deliver（不抢属主这一轮）", async () => {
    arrangeRunning();
    const resp = await send(1, "ou_a");
    expect(resp.status).toBe(202);
    expect(await resp.json()).toMatchObject({ ok: true, queued: true });
    expect(listTalkQueue(TASK_ID)).toHaveLength(1);
    expect(listTalkQueue(TASK_ID)[0]?.source).toBe("group_other");
    expect(deliverTaskQuestion).not.toHaveBeenCalled();
    noWriteSideEffects();
  });

  it("同一人第 3 条：409「你前面已经有 2 条在排队了」", async () => {
    arrangeRunning();
    expect((await send(1, "ou_a")).status).toBe(202);
    expect((await send(2, "ou_a")).status).toBe(202);
    const r = await send(3, "ou_a");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain(
      "你前面已经有 2 条在排队了",
    );
  });

  it("总共排满 5 条：409「排队的人太多了」", async () => {
    arrangeRunning();
    for (const [n, who] of [
      [1, "ou_a"],
      [2, "ou_a"],
      [3, "ou_b"],
      [4, "ou_b"],
      [5, "ou_c"],
    ] as const) {
      expect((await send(n, who)).status).toBe(202);
    }
    const r = await send(6, "ou_d");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain(
      "排队的人太多了",
    );
    expect(listTalkQueue(TASK_ID)).toHaveLength(5);
  });

  it("忙时没有活会话：先判会话 → 409（不入队，免得排了也送不出去）", async () => {
    getTask.mockImplementation(async () => runningTask());
    runningTasks.set(TASK_ID, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });
    const r = await send(1, "ou_a");
    expect(r.status).toBe(409);
    expect(listTalkQueue(TASK_ID)).toHaveLength(0);
  });
});

// ---------- 第 20 轮评审 T 系列：状态机级恒定拦点（突变 M4 / M4f 存活，补断言） ----------

const chatPending = await import("@/lib/server/chat-pending");
const { ASK_SKIP_AGENT_HINT } = await import("@/lib/server/ask-skip");

describe("恒定拦点：待答提问不被非属主的话作废（不认领 askSkip）", () => {
  const withPendingAsk = (): Task => {
    const t = ackTask() as unknown as { runStatus: string; events: unknown[] };
    t.runStatus = "awaiting_user";
    t.events = [
      {
        id: "ask-ev-1",
        seq: 1,
        ts: Date.now(),
        kind: "ask_user_request",
        actionId: "act-9",
        text: "要不要放开权限？",
        meta: {
          askId: "ask-1",
          token: "tok-ask-1",
          questions: [{ id: "q1", question: "要不要放开权限？" }],
        },
      },
    ];
    return t as unknown as Task;
  };
  const registered = { askId: "ask-1", token: "tok-ask-1" };

  it("非属主一句话：不摘待答登记、不放回、消息里不带「上一组提问已跳过」提示", async () => {
    getTask.mockImplementation(async () => withPendingAsk());
    agentSessions.set(TASK_ID, {});
    (chatPending.getPendingAsk as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(registered);

    const resp = await handleTaskQuestionInject(TASK_ID, body, nonOwnerOpts());

    expect(resp.status).toBe(200);
    expect(chatPending.takePendingAskIf).not.toHaveBeenCalled();
    expect(chatPending.restorePendingAskIf).not.toHaveBeenCalled();
    expect(deliverTaskQuestion).toHaveBeenCalledTimes(1);
    expect(String(deliverArgs()[1])).not.toContain(ASK_SKIP_AGENT_HINT);
    // 提问仍挂着：没写任何「跳过」收口事件
    const skipWrites = (writeEventAndPublish as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => JSON.stringify(c[1] ?? "").includes("ask_skip"),
    );
    expect(skipWrites).toHaveLength(0);
  });

  it("对照（属主）：同样的状态，属主说话 = 隐式跳过，会去摘待答登记（拦的是 groupNonOwner，不是别的）", async () => {
    getTask.mockImplementation(async () => withPendingAsk());
    agentSessions.set(TASK_ID, {});
    (chatPending.getPendingAsk as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(registered);
    (chatPending.takePendingAskIf as unknown as { mockReturnValueOnce: (v: unknown) => void }).mockReturnValueOnce(
      registered,
    );

    await handleTaskQuestionInject(TASK_ID, body, {});

    expect(chatPending.takePendingAskIf).toHaveBeenCalledTimes(1);
  });
});

describe("恒定拦点：非属主不等排空、不强清假死 run", () => {
  /** run 还占着 runningTasks，但当前 action 已 awaiting_ack（属主的收尾旁白还在流）= waitingForDrain */
  const drainingTask = (): Task => {
    const t = runningTask() as unknown as { actions: Array<{ status: string }> };
    t.actions[0]!.status = "awaiting_ack";
    return t as unknown as Task;
  };
  const arrangeDraining = () => {
    getTask.mockImplementation(async () => drainingTask());
    agentSessions.set(TASK_ID, {});
    runningTasks.set(TASK_ID, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });
  };

  it("非属主：不调 waitForTaskToStop（不等排空）、不 deliver，直接入 group_other 队列", async () => {
    arrangeDraining();
    const resp = await handleTaskQuestionInject(
      TASK_ID,
      body,
      nonOwnerOpts({
        queueIfBusy: {
          source: "group_other",
          senderName: "李四",
          senderKey: "ou_li",
          clientItemId: "om_drain_1",
        },
      }),
    );
    expect(resp.status).toBe(202);
    expect(waitForTaskToStop).not.toHaveBeenCalled();
    expect(deliverTaskQuestion).not.toHaveBeenCalled();
    expect(listTalkQueue(TASK_ID)).toHaveLength(1);
  });

  it("对照（属主）：同样的状态会先等排空（拦的是 groupNonOwner，不是这个状态本身）", async () => {
    arrangeDraining();
    await handleTaskQuestionInject(TASK_ID, body, {});
    expect(waitForTaskToStop).toHaveBeenCalled();
  });
});
