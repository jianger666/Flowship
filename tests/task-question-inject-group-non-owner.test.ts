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
  isGroupBotsEqualRights,
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
    isGroupBotsEqualRights: vi.fn<AnyFn>(async () => false),
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
  // 分支漂移守卫（本测试不关心分支、恒放行）
  guardTaskBranchForUserTurn: async () => undefined,
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
  isGroupBotsEqualRights,
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
const { __resetTaskTalkQueueForTest, __tickTalkQueueDrainForTest, listTalkQueue } = await import(
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
  isGroupBotsEqualRights.mockResolvedValue(false);
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

  it("发言人 open_id 原样随行到 deliver（提示词里给机器人 @ 标签的写法要用它）；没带就没有该字段", async () => {
    agentSessions.set(TASK_ID, {});
    await handleTaskQuestionInject(
      TASK_ID,
      body,
      nonOwnerOpts({ groupNonOwner: { name: "别家机器人", isBot: true, openId: "ou_otherbot" } }),
    );
    expect(deliverArgs()[9]).toEqual({
      name: "别家机器人",
      guard: true,
      isBot: true,
      openId: "ou_otherbot",
    });
  });

  it("机器人 + 「机器人与真人同权」开 + 提示词开关开：guard=true（跟随开关），带 isBot 标记", async () => {
    agentSessions.set(TASK_ID, {});
    isGroupBotsEqualRights.mockResolvedValue(true);
    isGroupNonOwnerGuardEnabled.mockResolvedValue(true);
    await handleTaskQuestionInject(
      TASK_ID,
      body,
      nonOwnerOpts({ groupNonOwner: { name: "别家机器人", isBot: true } }),
    );
    expect(deliverArgs()[9]).toEqual({ name: "别家机器人", guard: true, isBot: true });
  });

  it("机器人 + 「机器人与真人同权」开 + 提示词开关关：guard=false（同权），仍带 isBot 标记（供追加克制提示）", async () => {
    agentSessions.set(TASK_ID, {});
    isGroupBotsEqualRights.mockResolvedValue(true);
    isGroupNonOwnerGuardEnabled.mockResolvedValue(false);
    await handleTaskQuestionInject(
      TASK_ID,
      body,
      nonOwnerOpts({ groupNonOwner: { name: "别家机器人", isBot: true } }),
    );
    expect(deliverArgs()[9]).toEqual({ name: "别家机器人", guard: false, isBot: true });
  });

  it("「机器人与真人同权」开着不影响真人（真人照旧只看提示词开关），也不为真人多读它", async () => {
    agentSessions.set(TASK_ID, {});
    isGroupBotsEqualRights.mockResolvedValue(true);
    isGroupNonOwnerGuardEnabled.mockResolvedValue(false);
    await handleTaskQuestionInject(TASK_ID, body, nonOwnerOpts());
    expect(deliverArgs()[9]).toEqual({ name: "李四", guard: false });
    expect(isGroupBotsEqualRights).not.toHaveBeenCalled();
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

// ---------- 评审后补（2026-11-19）：agentContext = 属主群消息尾注的载体 ----------
// group-route 把 OWNER_GROUP_NOTE 经 `options.agentContext` 交进来；这一层以前没有直接断言——
// 一次性 agent 那个用例是手动把尾注拼进文本模拟的，没走过这里。三条出口各钉一次。

describe("agentContext（属主群消息尾注）：只给 agent 看、不进气泡，直送 / 唤醒 / 排队重放都带到", () => {
  const NOTE = "（这条是任务所有者本人在需求群里说的，同他在输入条里说的一样对待。）";
  const ownerBody = { text: "帮我看下登录页", bootArgs };
  const userEventOf = (): { text: string } =>
    (writeUserEventAndPublishStrict as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as { text: string };

  it("活会话直送：agent 文本 = 原文 + 空行 + 尾注；落盘气泡（user_reply.text）仍是原文", async () => {
    agentSessions.set(TASK_ID, {});
    const resp = await handleTaskQuestionInject(TASK_ID, ownerBody, { agentContext: NOTE });
    expect(resp.status).toBe(200);
    expect(String(deliverArgs()[1])).toContain(`帮我看下登录页\n\n${NOTE}`);
    expect(userEventOf().text).toBe("帮我看下登录页");
  });

  it("对照：不传 agentContext → agent 文本里没有尾注（没有这条选项时与改动前一致）", async () => {
    agentSessions.set(TASK_ID, {});
    const resp = await handleTaskQuestionInject(TASK_ID, ownerBody, {});
    expect(resp.status).toBe(200);
    expect(String(deliverArgs()[1])).toContain("帮我看下登录页");
    expect(String(deliverArgs()[1])).not.toContain(NOTE);
  });

  it("会话没了、属主唤醒当前 action：交给 resume 的 userMessage 同样带尾注，气泡仍是原文", async () => {
    deliverTaskQuestion.mockResolvedValue("no_session");
    const resp = await handleTaskQuestionInject(TASK_ID, ownerBody, { agentContext: NOTE });
    expect(resp.status).toBe(200);
    const arg = (resumeCurrentActionWithMessage as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]?.[0] as { userMessage: string };
    expect(arg.userMessage).toContain(`帮我看下登录页\n\n${NOTE}`);
    expect(userEventOf().text).toBe("帮我看下登录页");
  });

  it("忙时入队 → 这一轮跑完后真实 drain 重放：尾注随队列项保存、重放时仍拼在原文后（排队气泡不带尾注）", async () => {
    getTask.mockImplementation(async () => runningTask());
    agentSessions.set(TASK_ID, {});
    runningTasks.set(TASK_ID, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });
    const queued = await handleTaskQuestionInject(TASK_ID, ownerBody, {
      agentContext: NOTE,
      queueIfBusy: { source: "group_owner", senderName: "陈属主", clientItemId: "om_own_1" },
    });
    expect(queued.status).toBe(202);
    expect(deliverTaskQuestion).not.toHaveBeenCalled();
    expect(listTalkQueue(TASK_ID)[0]?.preview ?? "").not.toContain(NOTE);

    // 属主那一轮跑完：任务回到空闲，drain 重放队首
    runningTasks.clear();
    getTask.mockImplementation(async () => ackTask());
    await __tickTalkQueueDrainForTest(TASK_ID);

    expect(deliverTaskQuestion).toHaveBeenCalledTimes(1);
    expect(String(deliverArgs()[1])).toContain(`帮我看下登录页\n\n${NOTE}`);
    expect(userEventOf().text).toBe("帮我看下登录页");
  });
});

// ---------- 评审后补（2026-11-21）：foreignContentTurn = 「别人写的内容在驱动」的轮次标记 ----------
// 所有者空 @ 引用陌生人的消息 / 关联回执喂会话：以属主语义注入（不是非属主轮、提示词不改），
// 但这一轮的指令性内容出自别人，要登记「群成员触发」标记（desktop_* / 写所有者备注 / 新建定时 / 自动推进恒拒）。
// 三条送达分支（送活会话 / 唤醒 / 一次性 agent）各带一次；排队重放时原样带回；非属主轮不被它改写。

describe("foreignContentTurn（别人写的内容在驱动）：三条送达分支都带到，排队重放也原样带回", () => {
  const foreignBody = { text: "[群消息·来自 张三]\n（只 @ 了你，没写别的）", bootArgs };
  const resumeArg = (): Record<string, unknown> =>
    (resumeCurrentActionWithMessage as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as Record<string, unknown>;
  const oneShotArgs = (): unknown[] =>
    (startOneShotQuestion as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
  const completedTask = (): Task => {
    const t = ackTask() as unknown as { actions: Array<{ status: string }> };
    t.actions[0]!.status = "completed";
    return t as unknown as Task;
  };

  it("活会话直送：deliver 的 groupNonOwner 位是 markerOnly（属主语义——仍带 creds、不是非属主轮）", async () => {
    agentSessions.set(TASK_ID, {});

    const resp = await handleTaskQuestionInject(TASK_ID, foreignBody, { foreignContentTurn: true });

    expect(resp.status).toBe(200);
    const a = deliverArgs();
    expect(a[9]).toEqual({ name: "", guard: false, markerOnly: true });
    expect(a[3]).toBeDefined(); // creds：属主语义，休眠会话允许唤醒
    expect(a[4]).toMatchObject({ actionId: "act-9" }); // 属主语义：照常带 ackContext
  });

  it("对照：没有 foreignContentTurn → deliver 的 groupNonOwner 位为空", async () => {
    agentSessions.set(TASK_ID, {});
    await handleTaskQuestionInject(TASK_ID, foreignBody, {});
    expect(deliverArgs()[9]).toBeUndefined();
  });

  it("会话没了、属主唤醒当前 action：resume 入参带 foreignContentTurn；对照不带", async () => {
    deliverTaskQuestion.mockResolvedValue("no_session");
    const resp = await handleTaskQuestionInject(TASK_ID, foreignBody, { foreignContentTurn: true });
    expect(resp.status).toBe(200);
    expect(resumeArg()).toMatchObject({ foreignContentTurn: true });

    vi.clearAllMocks();
    deliverTaskQuestion.mockResolvedValue("no_session");
    await handleTaskQuestionInject(TASK_ID, foreignBody, {});
    expect(resumeArg()).not.toHaveProperty("foreignContentTurn");
  });

  it("当前 action 已完结（走一次性 agent）：startOneShotQuestion 第 8 参为 true；对照为 false", async () => {
    getTask.mockImplementation(async () => completedTask());
    deliverTaskQuestion.mockResolvedValue("no_session");
    const resp = await handleTaskQuestionInject(TASK_ID, foreignBody, { foreignContentTurn: true });
    expect(resp.status).toBe(200);
    expect(startOneShotQuestion).toHaveBeenCalledTimes(1);
    expect(oneShotArgs()[7]).toBe(true);

    vi.clearAllMocks();
    getTask.mockImplementation(async () => completedTask());
    deliverTaskQuestion.mockResolvedValue("no_session");
    await handleTaskQuestionInject(TASK_ID, foreignBody, {});
    expect(oneShotArgs()[7]).toBe(false);
  });

  it("忙时入队 → 这一轮跑完后真实 drain 重放：foreignContentTurn 随队列项保存、重放时仍是 markerOnly", async () => {
    getTask.mockImplementation(async () => runningTask());
    agentSessions.set(TASK_ID, {});
    runningTasks.set(TASK_ID, {
      instanceId: 1,
      agentId: "a",
      startedAt: Date.now(),
      startSnapshot: { title: "" },
      cancel: () => {},
    });

    const queued = await handleTaskQuestionInject(TASK_ID, foreignBody, {
      foreignContentTurn: true,
      queueIfBusy: { source: "group_owner", senderName: "陈属主", clientItemId: "om_foreign_1" },
    });
    expect(queued.status).toBe(202);
    expect(deliverTaskQuestion).not.toHaveBeenCalled();

    runningTasks.clear();
    getTask.mockImplementation(async () => ackTask());
    await __tickTalkQueueDrainForTest(TASK_ID);

    expect(deliverTaskQuestion).toHaveBeenCalledTimes(1);
    expect(deliverArgs()[9]).toEqual({ name: "", guard: false, markerOnly: true });
  });

  it("非属主轮不被它改写：同时给了 groupNonOwner 与 foreignContentTurn → 仍按非属主轮（guard 变体）送、不走 markerOnly", async () => {
    agentSessions.set(TASK_ID, {});

    const resp = await handleTaskQuestionInject(TASK_ID, body, nonOwnerOpts({ foreignContentTurn: true }));

    expect(resp.status).toBe(200);
    expect(deliverArgs()[9]).toEqual({ name: "李四", guard: true });
    expect(deliverArgs()[3]).toBeUndefined(); // 非属主依旧不传 creds
  });
});

// ---------------------------------------------------------------------------
// 关联回执（correlatedAnswer）只送活会话（第四轮评审「feed 路径唤醒全权限 agent」）：
// 回执的内容出自对方机器人 / 同事，group-route 只在「活会话在场」时才选这条路径；入口判断之后、送达之前会话刚好没了，
// 以前会落到唤醒 / 一次性 agent——带写权限的全权限 agent，却由别人写的内容驱动，只带 scope=desktop 的标记，
// 与「会话不在不自动唤醒」的约定相反。现在与非属主同口径：不传 creds、没送进去就 409。
// ---------------------------------------------------------------------------

describe("关联回执（correlatedAnswer）：只送活会话——会话没了回 409，绝不唤醒 / 新起任何 agent", () => {
  const receiptBody = { text: "[群消息·来自 对接后端的机器人]\n学号是 20240001", bootArgs };
  // group-route 对「关联回执喂会话」会同时置位这两项（correlatedAnswer + foreignContentTurn）
  const receiptOpts = (extra: Record<string, unknown> = {}) => ({
    correlatedAnswer: true,
    foreignContentTurn: true,
    ...extra,
  });
  const completedTask = (): Task => {
    const t = ackTask() as unknown as { actions: Array<{ status: string }> };
    t.actions[0]!.status = "completed";
    return t as unknown as Task;
  };

  it("内存里没有会话（入口判断之后会话过期）：409 人话提示，不 deliver、不 resume、不起一次性 / 旁路", async () => {
    const resp = await handleTaskQuestionInject(TASK_ID, receiptBody, receiptOpts());
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toBe(NON_OWNER_NO_SESSION_MESSAGE);
    expect(deliverTaskQuestion).not.toHaveBeenCalled();
    noWriteSideEffects();
    expect(setTaskRunStatusIfRunOwner).not.toHaveBeenCalled();
  });

  it("送达那一刻会话没了（deliver 回 no_session）：409，同样不唤醒 / 新起", async () => {
    agentSessions.set(TASK_ID, {});
    deliverTaskQuestion.mockResolvedValue("no_session");
    const resp = await handleTaskQuestionInject(TASK_ID, receiptBody, receiptOpts());
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toBe(NON_OWNER_NO_SESSION_MESSAGE);
    noWriteSideEffects();
  });

  it("送达时 send 失败（deliver 回 send_failed）：同样 409，不唤醒 / 新起", async () => {
    agentSessions.set(TASK_ID, {});
    deliverTaskQuestion.mockResolvedValue("send_failed");
    const resp = await handleTaskQuestionInject(TASK_ID, receiptBody, receiptOpts());
    expect(resp.status).toBe(409);
    noWriteSideEffects();
  });

  it("当前 action 已完结（以前会走一次性 agent）：同样 409，不起一次性 agent", async () => {
    getTask.mockImplementation(async () => completedTask());
    agentSessions.set(TASK_ID, {});
    deliverTaskQuestion.mockResolvedValue("no_session");
    const resp = await handleTaskQuestionInject(TASK_ID, receiptBody, receiptOpts());
    expect(resp.status).toBe(409);
    noWriteSideEffects();
  });

  it("只给 correlatedAnswer（不带 foreignContentTurn）也一样：拦的是关联回执本身", async () => {
    agentSessions.set(TASK_ID, {});
    deliverTaskQuestion.mockResolvedValue("no_session");
    const resp = await handleTaskQuestionInject(TASK_ID, receiptBody, { correlatedAnswer: true });
    expect(resp.status).toBe(409);
    noWriteSideEffects();
  });

  it("活会话在场：照常送达；不传 creds（deliver 不会把休眠会话复活成全权限），仍是 markerOnly 标记（属主语义）", async () => {
    agentSessions.set(TASK_ID, {});
    const resp = await handleTaskQuestionInject(TASK_ID, receiptBody, receiptOpts());
    expect(resp.status).toBe(200);
    expect(deliverTaskQuestion).toHaveBeenCalledTimes(1);
    expect(deliverArgs()[3]).toBeUndefined(); // creds
    expect(deliverArgs()[9]).toEqual({ name: "", guard: false, markerOnly: true });
    noWriteSideEffects();
  });

  it("对照 1（所有者本人空 @ 引用别人）：只有 foreignContentTurn、没有 correlatedAnswer → 会话没了仍可唤醒（所有者触发，没被动）", async () => {
    deliverTaskQuestion.mockResolvedValue("no_session");
    const resp = await handleTaskQuestionInject(TASK_ID, receiptBody, { foreignContentTurn: true });
    expect(resp.status).toBe(200);
    expect(resumeCurrentActionWithMessage).toHaveBeenCalledTimes(1);
  });

  it("对照 2（命中但会话本来就不在 → 只读旁路）：correlatedAnswer 与 restrictToQuestion 同时给，不被误拦成 409", async () => {
    // group-route 在 correlated 命中但 !feedIntoSession 时就是这样传的（useOwnerInject=false → restrictToQuestion:true）
    const resp = await handleTaskQuestionInject(TASK_ID, receiptBody, {
      correlatedAnswer: true,
      restrictToQuestion: true,
      userReplyMetaExtra: META,
    });
    expect(resp.status).not.toBe(409);
    expect(deliverTaskQuestion).not.toHaveBeenCalled();
    expect(resumeCurrentActionWithMessage).not.toHaveBeenCalled();
  });
});
