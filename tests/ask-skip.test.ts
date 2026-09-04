/**
 * 「不答提问、直接发新消息」＝ 隐式跳过（ask-skip 协议 + task 模式 / ask-reply 接线）
 *
 * 用户实测的产品缺陷：agent 调 ask_user 之后用户往往已经自己有答案了、直接在输入框说话，
 * 而那张待答卡片会一直挂在事件流里（顶部「AI 在等你回答」悬浮条 + 推进按钮被按住），
 * 用户原话「像牛皮癣一样」。
 *
 * 本文件钉四件事：
 * 1. **跳过后 pending 判定为假**：写的是同一套作废语义（`meta.supersededAskId`）、
 *    额外带 `askSkipped` 供 UI 收成一行「已跳过」
 * 2. **agent 收到的消息带跳过上下文**：不带的话 AI 大概率换个说法把同一组问题再问一遍
 * 3. **并发答 / 跳只有一个赢**：仲裁者只有 pendingAsks 一张表、认领 = 同步原子摘走
 * 4. **没送出去要能回去答**：失败路径把登记原样放回
 *
 * chat 模式那条链在 `tests/ask-skip-chat.test.ts`；卡片置态在 `tests/ask-card-settle.test.ts`。
 * 全部 mock 外部调用——不起 agent、不碰盘、不调飞书。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, TaskEvent } from "@/lib/types";
import {
  attachAskWaiter,
  openAskWait,
  resetAskWaitForTest,
} from "@/lib/server/ask-wait";

const {
  agentSessions,
  deliverAskReply,
  deliverChatAskReply,
  deliverTaskQuestion,
  getChatLifecycle,
  getTask,
  getTaskMeta,
  getTaskWithTailEvents,
  hasChatSession,
  isTaskOpStale,
  patchActionAndRunStatusIfOpFresh,
  publishTaskStreamEvent,
  resumeCurrentActionWithMessage,
  runningTasks,
  saveImageAttachments,
  settleAskCards,
  setTaskRunStatusIfRunOwner,
  snapshotActionArtifact,
  startOneShotQuestion,
  startRestrictedGroupQuestion,
  supersedePendingAsks,
  syncTaskPendingAskId,
  waitForTaskToStop,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  // B1：getTaskMeta 只是“不读 events 的 getTask”——与 getTask 同实现，跟着各用例的
  // mockImplementation 走；tail 读 mock 直接返同一 fixture（生产代码只读它的 .events）。
  const getTask = vi.fn<AnyFn>();
  const getTaskMeta = vi.fn<AnyFn>((...args: never[]) =>
    getTask(...args),
  );
  const getTaskWithTailEvents = vi.fn<AnyFn>(
    async (...args: never[]) => getTask(...args),
  );
  return {
    agentSessions: new Map<string, unknown>(),
    runningTasks: new Map<string, unknown>(),
    deliverAskReply: vi.fn<AnyFn>(async () => "sent"),
    deliverChatAskReply: vi.fn<AnyFn>(async () => true),
    deliverTaskQuestion: vi.fn<AnyFn>(async () => "sent"),
    getChatLifecycle: vi.fn<AnyFn>(() => null),
    getTask,
    getTaskMeta,
    getTaskWithTailEvents,
    hasChatSession: vi.fn<AnyFn>(() => true),
    isTaskOpStale: vi.fn<AnyFn>(() => false),
    patchActionAndRunStatusIfOpFresh: vi.fn<AnyFn>(async () => null),
    publishTaskStreamEvent: vi.fn<AnyFn>(),
    resumeCurrentActionWithMessage: vi.fn<AnyFn>(async () => undefined),
    saveImageAttachments: vi.fn<AnyFn>(async () => []),
    settleAskCards: vi.fn<AnyFn>(async () => 1),
    setTaskRunStatusIfRunOwner: vi.fn<AnyFn>(async () => null),
    snapshotActionArtifact: vi.fn<AnyFn>(async () => undefined),
    startOneShotQuestion: vi.fn<AnyFn>(),
    startRestrictedGroupQuestion: vi.fn<AnyFn>(),
    supersedePendingAsks: vi.fn<AnyFn>(async () => []),
    syncTaskPendingAskId: vi.fn<AnyFn>(async () => undefined),
    waitForTaskToStop: vi.fn<AnyFn>(async () => true),
    writeEventAndPublish: vi.fn<AnyFn>(async () => ({ id: "ev_skip" })),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "e1" })),
  };
});

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  getTaskMeta,
  getTaskWithTailEvents,
  patchActionAndRunStatusIfOpFresh,
  setTaskRunStatusIfRunOwner,
  // chat-pending 的 meta 同步走动态 import("./task-fs")——不 mock 会变成未捕获拒绝
  syncTaskPendingAskId,
}));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments,
  snapshotActionArtifact,
}));
vi.mock("@/lib/server/task-runner", () => ({
  deliverAskReply,
  deliverTaskQuestion,
  isTaskOpStale,
  resumeCurrentActionWithMessage,
  startOneShotQuestion,
  supersedePendingAsks,
  TASK_OP_STALE_HTTP_MESSAGE: "任务状态刚变化、请重新发送",
}));
vi.mock("@/lib/server/chat-runner", () => ({
  deliverChatAskReply,
  hasChatSession,
}));
vi.mock("@/lib/server/restricted-question", () => ({
  startRestrictedGroupQuestion,
}));
vi.mock("@/lib/server/task-stream", () => ({
  agentSessions,
  runningTasks,
  getTaskOpGeneration: () => 1,
  isTaskOpCurrent: () => true,
  snapshotTaskOp: () => ({}),
  PERSIST_FAIL_RETRY_MESSAGE: "落盘失败、请重试",
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  publishTaskStreamEvent,
  waitForTaskToStop,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
}));
vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle }));
// 卡片置态另有专门文件覆盖；这里只关心「跳过 / 答完有没有去置」
vi.mock("@/lib/server/feishu-bridge/ask-card-settle", () => ({
  settleAskCards,
  ASK_CARD_SKIPPED_NOTE: "（已跳过）",
  ASK_CARD_SKIPPED_HINT: "这组提问已跳过、无需再回答",
  ASK_CARD_ANSWERED_HINT: "这组提问已回答、无需再答",
}));

// chat-pending 用真的——测的就是它的「原子摘走 / 条件放回」语义
const {
  __resetPendingAskStateForTest,
  clearPendingAsk,
  getPendingAsk,
  registerPendingAsk,
  restorePendingAskIf,
  takePendingAskIf,
  wasAskTakenRecently,
} = await import("@/lib/server/chat-pending");
const { ASK_SKIP_AGENT_HINT, beginAskSkip, buildAskWaitSkipReply } = await import(
  "@/lib/server/ask-skip"
);
const { findPendingAskEvent, isAskSkipped } = await import("@/lib/ask-pending");
const { handleTaskQuestionInject } = await import(
  "@/lib/server/task-question-inject"
);
const { POST: askReplyPost } = await import(
  "@/app/api/tasks/[id]/ask-reply/route"
);

const TASK_ID = "task-1";
const ASK_ID = "ask-1";
const QUESTIONS = [{ id: "q1", question: "用哪个方案", allowText: true }];

/** 登记一组待答 ask，返回 runner 分配的 token（事件 meta 要带同一个） */
const seedPendingAsk = (): string =>
  registerPendingAsk(TASK_ID, {
    askId: ASK_ID,
    questions: QUESTIONS,
    actionId: "act-1",
  }).token;

const askEvent = (token: string): TaskEvent =>
  ({
    id: "ev-ask",
    kind: "ask_user_request",
    text: "有问题要问",
    ts: Date.now(),
    actionId: "act-1",
    meta: { askId: ASK_ID, token, questions: QUESTIONS },
  }) as unknown as TaskEvent;

const taskWithAsk = (token: string, extraEvents: TaskEvent[] = []): Task =>
  ({
    id: TASK_ID,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: "act-1",
    repoPaths: ["/tmp/repo"],
    mrs: [],
    actions: [
      {
        id: "act-1",
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    events: [askEvent(token), ...extraEvents],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

/** writeEventAndPublish 落下的那条跳过事件（没有则 undefined） */
const skipEvents = (): Array<{ text: string; meta: Record<string, unknown> }> =>
  (writeEventAndPublish as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => c[1] as { text?: string; meta?: Record<string, unknown> })
    .filter((e) => !!e?.meta?.supersededAskId)
    .map((e) => ({ text: e.text ?? "", meta: e.meta ?? {} }));

beforeEach(() => {
  vi.clearAllMocks();
  // 登记表 + 「已被摘走」打点都要清——后者不清会让「孤儿 ask」用例误判成「答题链在飞」
  __resetPendingAskStateForTest();
  resetAskWaitForTest();
  agentSessions.clear();
  agentSessions.set(TASK_ID, {});
  runningTasks.clear();
  isTaskOpStale.mockReturnValue(false);
  getChatLifecycle.mockReturnValue(null);
  deliverTaskQuestion.mockResolvedValue("sent");
  deliverAskReply.mockResolvedValue("sent");
  resumeCurrentActionWithMessage.mockResolvedValue(undefined);
  writeEventAndPublish.mockResolvedValue({ id: "ev_skip" });
  writeUserEventAndPublishStrict.mockResolvedValue({ id: "e1" });
});

// ─────────────────────────────────────────────────────────────
// 协议本身：认领 / 提交 / 回滚
// ─────────────────────────────────────────────────────────────
describe("ask-skip 协议", () => {
  it("认领 + 提交 → 落作废事件（带 askSkipped）、pending 判定转假", async () => {
    const token = seedPendingAsk();
    const task = taskWithAsk(token);

    const handle = beginAskSkip(task);
    expect(handle.claimed).toBe(true);
    expect(handle.askId).toBe(ASK_ID);
    expect(handle.hint).toBe(ASK_SKIP_AGENT_HINT);
    // 认领 = 同步摘走登记：此后答题链看到的就是「没有待答的了」
    expect(getPendingAsk(TASK_ID)).toBeNull();

    await handle.commit();
    const [ev] = skipEvents();
    expect(ev?.meta.supersededAskId).toBe(ASK_ID);
    expect(ev?.meta.askSkipped).toBe(true);
    expect(ev?.text).toContain("已跳过");

    // 事件流补上这条之后：判定「已了结」→ 答题卡 / 悬浮条 / canAdvance 全部恢复
    const after = [
      ...task.events,
      { id: "ev-skip", kind: "info", text: "", ts: Date.now(), meta: ev!.meta },
    ] as unknown as TaskEvent[];
    expect(findPendingAskEvent(after)).toBeNull();
    expect(isAskSkipped(after, ASK_ID)).toBe(true);
  });

  it("提交幂等：调两遍只落一条事件、卡片只置一次态", async () => {
    const token = seedPendingAsk();
    const handle = beginAskSkip(taskWithAsk(token));
    await handle.commit();
    await handle.commit();
    expect(skipEvents()).toHaveLength(1);
    expect(settleAskCards).toHaveBeenCalledTimes(1);
  });

  it("提交后 rollback 是空操作——不会把登记复活成「还在等你答」", async () => {
    const token = seedPendingAsk();
    const handle = beginAskSkip(taskWithAsk(token));
    await handle.commit();
    handle.rollback();
    expect(getPendingAsk(TASK_ID)).toBeNull();
  });

  it("没送出去 → rollback 把登记原样放回、用户还能回去答", () => {
    const token = seedPendingAsk();
    const handle = beginAskSkip(taskWithAsk(token));
    expect(getPendingAsk(TASK_ID)).toBeNull();
    handle.rollback();
    expect(getPendingAsk(TASK_ID)?.askId).toBe(ASK_ID);
    expect(getPendingAsk(TASK_ID)?.token).toBe(token);
  });

  it("答题链先摘走 → 认领落空、一个字都不写（并发只有一个赢）", async () => {
    const token = seedPendingAsk();
    const task = taskWithAsk(token);
    // 模拟答题链抢先一步把登记摘走（clearPendingAsk 会打上「本进程已在了结」）
    clearPendingAsk(TASK_ID);

    const handle = beginAskSkip(task);
    expect(handle.claimed).toBe(false);
    expect(handle.askId).toBeNull();
    expect(handle.hint).toBe("");
    await handle.commit();
    expect(skipEvents()).toHaveLength(0);
    expect(settleAskCards).not.toHaveBeenCalled();
  });

  it("登记已被新一组提问顶替 → 不许跳过、更不许把新的摘掉", () => {
    seedPendingAsk();
    const staleTask = taskWithAsk("tok-old");
    // 槽位现在是「另一组」提问（askId 相同但 token 换了 = force-new-agent 顶替）
    const handle = beginAskSkip(staleTask);
    expect(handle.claimed).toBe(false);
    expect(getPendingAsk(TASK_ID)?.askId).toBe(ASK_ID);
  });

  it("孤儿 ask（进程重启后内存登记已丢）照样能跳过——否则卡片永远挂着", async () => {
    const task = taskWithAsk("tok-lost");
    expect(getPendingAsk(TASK_ID)).toBeNull();

    const handle = beginAskSkip(task);
    expect(handle.claimed).toBe(true);
    await handle.commit();
    expect(skipEvents()[0]?.meta.supersededAskId).toBe(ASK_ID);
  });

  it("孤儿 ask 也只认领一次——并发第二条消息不会再写一条跳过标记", async () => {
    const task = taskWithAsk("tok-lost");
    const first = beginAskSkip(task);
    const second = beginAskSkip(task);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    await first.commit();
    await second.commit();
    expect(skipEvents()).toHaveLength(1);
  });

  it("孤儿跳过没送出去 → rollback 撤掉占位打点、下一条消息还能重新认领", () => {
    const task = taskWithAsk("tok-lost");
    const first = beginAskSkip(task);
    expect(first.claimed).toBe(true);
    // 孤儿分支没有登记可放回、只在 takenAsks 打了个占位；不撤的话接下来 10 分钟（打点 TTL）
    // 里每条新消息都被判成「已有人在了结」、跳过永远认领不上、答题卡一直挂着
    first.rollback();
    expect(beginAskSkip(task).claimed).toBe(true);
  });

  it("commit 写作废事件失败 → 撤掉占位打点、下一条消息立刻能重新收口", async () => {
    const token = seedPendingAsk();
    const handle = beginAskSkip(taskWithAsk(token));
    writeEventAndPublish.mockRejectedValueOnce(new Error("盘挂了"));
    await handle.commit();
    // 登记已被摘走 + 事件流里没有跳过标记 = 答题卡挂着且谁都收不了口；
    // commit 不能放回登记（跳过 hint 已随消息交给 agent 了），只能靠撤打点让下一条消息接手
    expect(beginAskSkip(taskWithAsk(token)).claimed).toBe(true);
  });

  it("commit 成功 → 占位打点保留（并发第二条消息不许再标一次跳过）", async () => {
    const token = seedPendingAsk();
    const handle = beginAskSkip(taskWithAsk(token));
    await handle.commit();
    expect(beginAskSkip(taskWithAsk(token)).claimed).toBe(false);
  });

  it("已了结的 ask（答过 / 作废过）不再被跳过", () => {
    seedPendingAsk();
    const replied = {
      id: "ev-reply",
      kind: "ask_user_reply",
      text: "",
      ts: Date.now(),
      meta: { askId: ASK_ID },
    } as unknown as TaskEvent;
    expect(beginAskSkip(taskWithAsk("tok", [replied])).claimed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 登记表口径：撤「在飞」打点一律按 askId 匹配，谁的打点谁撤
// ─────────────────────────────────────────────────────────────
describe("chat-pending：打点撤销按 askId 匹配", () => {
  it("迟到的 rollback 放回旧 ask → 不许顺手删掉新一组的在飞打点", () => {
    const askA = registerPendingAsk(TASK_ID, {
      askId: ASK_ID,
      questions: QUESTIONS,
    });
    expect(takePendingAskIf(TASK_ID, ASK_ID, askA.token)).not.toBeNull();
    // agent 已经登记了新一组提问、答题链随即把它摘走（正在投递、打点标的是 ask-2）
    const askB = registerPendingAsk(TASK_ID, {
      askId: "ask-2",
      questions: QUESTIONS,
    });
    expect(takePendingAskIf(TASK_ID, "ask-2", askB.token)).not.toBeNull();

    // 链 A 迟到的 rollback：槽位空着 → 旧那组被放回
    expect(restorePendingAskIf(TASK_ID, askA)).toBe(true);
    // ask-2 那条链还在飞：打点被删掉的话跳过链会把它当孤儿再收一次口（双赢）
    expect(wasAskTakenRecently(TASK_ID, "ask-2")).toBe(true);
  });

  it("放回的就是打点那组 → 打点照撤（撤销不是恒不撤）", () => {
    const ask = registerPendingAsk(TASK_ID, {
      askId: ASK_ID,
      questions: QUESTIONS,
    });
    expect(takePendingAskIf(TASK_ID, ASK_ID, ask.token)).not.toBeNull();
    expect(wasAskTakenRecently(TASK_ID, ASK_ID)).toBe(true);

    expect(restorePendingAskIf(TASK_ID, ask)).toBe(true);
    // 又在等人答了 → 跳过 / 答题都该能重新认领
    expect(wasAskTakenRecently(TASK_ID, ASK_ID)).toBe(false);
  });

  it("同一轮 curl 的跳过正文带 [ASK_USER_REPLY] 前缀", () => {
    expect(buildAskWaitSkipReply("走方案 B")).toBe(
      "[ASK_USER_REPLY]\n走方案 B\n",
    );
  });
});

// ─────────────────────────────────────────────────────────────
// task 模式：「跟 AI 说」输入条
// ─────────────────────────────────────────────────────────────
describe("task 模式发新消息 = 跳过提问", () => {
  const body = {
    text: "不用问了、我自己定了：走方案 B",
    bootArgs: { apiKey: "sk-test", model: { id: "m1" } },
  };

  it("送达成功 → agent 收到的消息带跳过上下文 + 落跳过事件", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => taskWithAsk(token));

    const resp = await handleTaskQuestionInject(TASK_ID, body);
    expect(resp.status).toBe(200);

    const agentText = String(
      (deliverTaskQuestion as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[1] ?? "",
    );
    expect(agentText).toContain("已跳过");
    expect(agentText).toContain("重新问一次");
    // 上下文在最前面：agent 先知道「上一组问题作废了」再读新消息
    expect(agentText.indexOf("已跳过")).toBeLessThan(
      agentText.indexOf("走方案 B"),
    );

    expect(skipEvents()[0]?.meta.askSkipped).toBe(true);
    expect(getPendingAsk(TASK_ID)).toBeNull();
    // 飞书那边的答题卡也置成「已跳过」终态
    expect(settleAskCards).toHaveBeenCalledTimes(1);
  });

  it("气泡只存用户原文——跳过上下文不进事件流", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => taskWithAsk(token));
    await handleTaskQuestionInject(TASK_ID, body);

    const bubble = (
      writeUserEventAndPublishStrict as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls[0]?.[1] as { text?: string };
    expect(bubble?.text).toBe(body.text);
    expect(bubble?.text).not.toContain("已跳过");
  });

  it("同一轮 curl 挂着时输入条回车写进 stdout、不 send", async () => {
    const token = seedPendingAsk();
    const running = {
      ...taskWithAsk(token),
      runStatus: "running",
    } as unknown as Task;
    getTask.mockImplementation(async () => running);
    runningTasks.set(TASK_ID, {});
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token });
    const chunks: string[] = [];
    let closed = false;
    attachAskWaiter(TASK_ID, token, {
      write: (c) => chunks.push(c),
      close: () => {
        closed = true;
      },
    });

    const resp = await handleTaskQuestionInject(TASK_ID, body);
    expect(resp.status).toBe(200);
    expect(deliverTaskQuestion).not.toHaveBeenCalled();
    expect(chunks.join("")).toContain("[ASK_USER_REPLY]");
    expect(chunks.join("")).toContain("已跳过");
    expect(chunks.join("")).toContain("走方案 B");
    expect(closed).toBe(true);
    expect(skipEvents()[0]?.meta.askSkipped).toBe(true);
    expect(getPendingAsk(TASK_ID)).toBeNull();
  });

  it("run 还在飞、curl 槽不在 → 409，不 abort，登记放回", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => ({
      ...taskWithAsk(token),
      runStatus: "running",
    }));
    runningTasks.set(TASK_ID, {});

    const resp = await handleTaskQuestionInject(TASK_ID, body);
    expect(resp.status).toBe(409);
    expect(deliverTaskQuestion).not.toHaveBeenCalled();
    expect(skipEvents()).toHaveLength(0);
    expect(getPendingAsk(TASK_ID)?.askId).toBe(ASK_ID);
  });

  it("消息没送出去（4xx）→ 登记放回、不写跳过事件", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => taskWithAsk(token));
    // 送达一半世界变了 → 409，这条消息没进 agent
    deliverTaskQuestion.mockResolvedValue("stale");

    const resp = await handleTaskQuestionInject(TASK_ID, body);
    expect(resp.status).toBe(409);
    expect(skipEvents()).toHaveLength(0);
    expect(getPendingAsk(TASK_ID)?.askId).toBe(ASK_ID);
  });

  it("群里非属主的消息不许跳过属主的提问", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => taskWithAsk(token));

    await handleTaskQuestionInject(TASK_ID, body, {
      restrictToQuestion: true,
    });
    expect(skipEvents()).toHaveLength(0);
    expect(getPendingAsk(TASK_ID)?.askId).toBe(ASK_ID);
  });

  it("没有待答提问时不加任何上下文（老行为零变化）", async () => {
    getTask.mockImplementation(
      async () =>
        ({ ...taskWithAsk("tok"), events: [] }) as unknown as Task,
    );
    await handleTaskQuestionInject(TASK_ID, body);
    const agentText = String(
      (deliverTaskQuestion as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[1] ?? "",
    );
    expect(agentText).toBe(body.text);
    expect(skipEvents()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 反向闸：跳过之后再来的答案要被挡住
// ─────────────────────────────────────────────────────────────
describe("ask-reply：这组提问已跳过", () => {
  const post = async (): Promise<Response> =>
    askReplyPost(
      new Request(`http://localhost/api/tasks/${TASK_ID}/ask-reply`, {
        method: "POST",
        body: JSON.stringify({
          askId: ASK_ID,
          answers: [{ questionId: "q1", answer: "方案 A" }],
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );

  it("已跳过 → 409、不投递（跳过赢了就别再把答案塞给 agent）", async () => {
    const skipEvent = {
      id: "ev-skip",
      kind: "info",
      text: "上一组提问已跳过（你直接发了新消息）、无需再回答。",
      ts: Date.now(),
      meta: { supersededAskId: ASK_ID, askSkipped: true },
    } as unknown as TaskEvent;
    getTask.mockImplementation(async () => taskWithAsk("tok", [skipEvent]));

    const resp = await post();
    expect(resp.status).toBe(409);
    expect(String((await resp.json()).error)).toContain("已跳过");
    expect(deliverAskReply).not.toHaveBeenCalled();
  });

  it("没跳过 → 正常投递（对照组：闸不是恒真）", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => taskWithAsk(token));

    const resp = await post();
    expect(resp.status).toBe(200);
    expect(deliverAskReply).toHaveBeenCalledTimes(1);
    // 答完也走同一个卡片收口点（HANDOFF 记的欠账：从 app 答完群里那张卡不置态）
    expect(settleAskCards).toHaveBeenCalledTimes(1);
  });

  it("答题链摘走登记之后、跳过认领必然落空（并发只有一个赢）", async () => {
    const token = seedPendingAsk();
    const task = taskWithAsk(token);
    getTask.mockImplementation(async () => task);

    await post();
    // 答案已送达 = 登记被 ask-reply 摘走；此刻用户再发消息不该把它标成「跳过」
    expect(beginAskSkip(task).claimed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 僵尸唤醒的守卫：「会话已死 + 登记为空」不一定是僵尸
// ─────────────────────────────────────────────────────────────
const WAKE_BODY = {
  askId: ASK_ID,
  answers: [{ questionId: "q1", answer: "方案 A" }],
  // 有凭据才走得到唤醒兜底（没凭据是「Agent 已断开」那条 410 老路）
  bootArgs: { apiKey: "sk-test", model: { id: "m1" } },
};

const postWithBoot = async (): Promise<Response> =>
  askReplyPost(
    new Request(`http://localhost/api/tasks/${TASK_ID}/ask-reply`, {
      method: "POST",
      body: JSON.stringify(WAKE_BODY),
    }),
    { params: Promise.resolve({ id: TASK_ID }) },
  );

/** fire-and-forget 的投递链要等一个宏任务才跑完 .then / .catch */
const flushDelivery = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
};

describe("ask-reply：跳过链在飞时不许替它了结这组提问", () => {
  it("跳过链在飞 + 会话仍存活 → 409、不写作废事件（不许替它下结论）", async () => {
    const token = seedPendingAsk();
    const task = taskWithAsk(token);
    getTask.mockImplementation(async () => task);
    // 跳过链已原子摘走登记、正在投递新消息；会话此刻还活着（agent 交卷后空闲是健康态）
    expect(beginAskSkip(task).claimed).toBe(true);

    const resp = await postWithBoot();
    expect(resp.status).toBe(409);
    // 关键：这条链**不许**替跳过链写「上一组提问已失效」——跳过链投递失败 rollback 之后，
    // 事件流里那条假作废会让答题卡直接消失、用户再也答不了；commit 成功则是同一 ask
    // 落两条 supersede 事件
    expect(skipEvents()).toHaveLength(0);
    expect(deliverAskReply).not.toHaveBeenCalled();
    // 文案中性：takenAsks 不记谁摘的，双击提交时第二个请求的用户并没发过新消息
    const err = String((await resp.json()).error);
    expect(err).toContain("正在被处理");
    expect(err).not.toContain("新消息");
  });

  it("真被新提问顶替（没有链在飞）→ 照旧写作废事件 + 409（守卫不是恒真）", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => taskWithAsk(token));
    // 新一组提问顶掉旧的（registerPendingAsk 会撤掉上一组的打点 = 没有链在飞）
    registerPendingAsk(TASK_ID, {
      askId: "ask-2",
      questions: QUESTIONS,
      actionId: "act-1",
    });

    const resp = await postWithBoot();
    expect(resp.status).toBe(409);
    expect(String((await resp.json()).error)).toContain("已失效");
    expect(skipEvents()).toHaveLength(1);
  });

  it("跳过链刚摘走登记 + 会话已死 → 409、不落已答事件、不唤醒新 agent", async () => {
    const token = seedPendingAsk();
    const task = taskWithAsk(token);
    getTask.mockImplementation(async () => task);
    // 跳过链已原子摘走这组登记、正在把新消息投给 agent（作废事件还没落盘）
    expect(beginAskSkip(task).claimed).toBe(true);
    // 此刻会话恰好死了（网断 / agent 异常退出）——盘面与「重启后的孤儿 ask」一模一样
    agentSessions.clear();
    hasChatSession.mockReturnValue(false);

    const resp = await postWithBoot();
    expect(resp.status).toBe(409);
    // 答案不许落「已答」事件、更不许唤醒新 agent（否则 agent 同时收到答案和跳过）
    expect(writeUserEventAndPublishStrict).not.toHaveBeenCalled();
    expect(resumeCurrentActionWithMessage).not.toHaveBeenCalled();
    // 收口是那条链自己的事（commit 落作废 / rollback 放回），这里不许替它下结论
    expect(skipEvents()).toHaveLength(0);
  });

  it("chat 模式同样有守卫（两种模式共用这段兜底）", async () => {
    const token = seedPendingAsk();
    const task = { ...taskWithAsk(token), mode: "chat" } as unknown as Task;
    getTask.mockImplementation(async () => task);
    expect(beginAskSkip(task).claimed).toBe(true);
    agentSessions.clear();
    hasChatSession.mockReturnValue(false);

    const resp = await postWithBoot();
    expect(resp.status).toBe(409);
    expect(deliverChatAskReply).not.toHaveBeenCalled();
  });

  it("真孤儿（重启后没有任何在飞的链）→ 唤醒照旧（守卫不是恒真）", async () => {
    // 不 seed 登记也不认领：takenAsks 空 = 进程重启后的盘面
    getTask.mockImplementation(async () => taskWithAsk("tok-lost"));
    agentSessions.clear();
    hasChatSession.mockReturnValue(false);

    const resp = await postWithBoot();
    expect(resp.status).toBe(200);
    expect(resumeCurrentActionWithMessage).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 唤醒兜底的卡片终态：必须跟着「投递成功」走
// ─────────────────────────────────────────────────────────────
describe("ask-reply 唤醒兜底：答题卡终态排在投递成功之后", () => {
  /** 某个 mock 第一次被调用的全局序号（跨 mock 可比） */
  const firstCallOrder = (fn: unknown): number =>
    (fn as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;

  /** 唤醒失败时给用户的错误事件 */
  const wakeErrorEvents = (): string[] =>
    (writeEventAndPublish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls.map((c) => c[1] as { kind?: string; text?: string })
      .filter((e) => e?.kind === "error")
      .map((e) => e.text ?? "");

  beforeEach(() => {
    // 活会话送不到 → 走唤醒兜底
    deliverAskReply.mockResolvedValue("no_session");
  });

  it("起新 agent 失败 → 不置终态（卡片不许显示「已回答」而 agent 没收到）", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => taskWithAsk(token));
    resumeCurrentActionWithMessage.mockRejectedValue(new Error("起 agent 失败"));

    expect((await postWithBoot()).status).toBe(200);
    await flushDelivery();
    expect(settleAskCards).not.toHaveBeenCalled();
    // 失败路径已有错误事件引导用户恢复
    expect(wakeErrorEvents().join()).toContain("唤醒 AI 失败");
  });

  it("起新 agent 成功 → 置终态、且排在起 agent 之后", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => taskWithAsk(token));
    resumeCurrentActionWithMessage.mockResolvedValue(undefined);

    expect((await postWithBoot()).status).toBe(200);
    await flushDelivery();
    expect(settleAskCards).toHaveBeenCalledTimes(1);
    expect(firstCallOrder(settleAskCards)).toBeGreaterThan(
      firstCallOrder(resumeCurrentActionWithMessage),
    );
  });

  it("chat 唤醒没接回会话（投递返 false）→ 同样不置终态", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(
      async () => ({ ...taskWithAsk(token), mode: "chat" }) as unknown as Task,
    );
    deliverChatAskReply.mockResolvedValue(false);

    expect((await postWithBoot()).status).toBe(200);
    await flushDelivery();
    expect(settleAskCards).not.toHaveBeenCalled();
    expect(wakeErrorEvents().join()).toContain("唤醒 AI 失败");
  });

  // 收尾回调是 fire-and-forget 链的最后一环：它自己抛出去没人接，
  // Node 默认策略下 unhandled rejection 可能直接带崩进程（整台服务，不只这一个请求）
  describe("收尾回调抛错不逃逸", () => {
    /** 本用例窗口内捕获到的 unhandled rejection */
    const withUnhandledWatch = async (
      run: () => Promise<void>,
    ): Promise<unknown[]> => {
      const caught: unknown[] = [];
      const onUnhandled = (err: unknown): void => {
        caught.push(err);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        await run();
        // 拒绝的检测发生在微任务检查点之后，多放一个宏任务再看
        await flushDelivery();
        await flushDelivery();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      return caught;
    };

    it("task：起 agent 失败 + 错误事件也写不下去 → 只 log、不产生 unhandled rejection", async () => {
      const token = seedPendingAsk();
      getTask.mockImplementation(async () => taskWithAsk(token));
      resumeCurrentActionWithMessage.mockRejectedValue(new Error("起 agent 失败"));
      writeEventAndPublish.mockRejectedValue(new Error("盘也挂了"));

      const caught = await withUnhandledWatch(async () => {
        expect((await postWithBoot()).status).toBe(200);
      });
      expect(caught).toHaveLength(0);
    });

    it("chat：会话没接回来 + 错误事件也写不下去 → 同样不逃逸", async () => {
      const token = seedPendingAsk();
      getTask.mockImplementation(
        async () => ({ ...taskWithAsk(token), mode: "chat" }) as unknown as Task,
      );
      deliverChatAskReply.mockResolvedValue(false);
      writeEventAndPublish.mockRejectedValue(new Error("盘也挂了"));

      const caught = await withUnhandledWatch(async () => {
        expect((await postWithBoot()).status).toBe(200);
      });
      expect(caught).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 停止后立刻重发：action 已 cancelled / idle，但 runningTasks 还没 drain
// ─────────────────────────────────────────────────────────────
describe("task 模式：停止后立刻重发等 drain", () => {
  const body = {
    text: "停完立刻再说一句",
    bootArgs: { apiKey: "sk-test", model: { id: "m1" } },
  };

  const cancelledIdleTask = (): Task =>
    ({
      ...taskWithAsk("tok"),
      events: [],
      runStatus: "idle",
      actions: [
        {
          id: "act-1",
          n: 1,
          type: "plan",
          status: "cancelled",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ],
    }) as unknown as Task;

  it("cancelled + idle、表里还有 runner → 等 drain 后唤醒，不立刻 409", async () => {
    const task = cancelledIdleTask();
    getTask.mockResolvedValue(task);
    runningTasks.set(TASK_ID, {});
    agentSessions.clear();
    deliverTaskQuestion.mockResolvedValue("no_session");
    waitForTaskToStop.mockImplementation(async () => {
      runningTasks.delete(TASK_ID);
      return true;
    });

    const resp = await handleTaskQuestionInject(TASK_ID, body);
    expect(resp.status).toBe(200);
    expect(waitForTaskToStop).toHaveBeenCalled();
    expect(resumeCurrentActionWithMessage).toHaveBeenCalledTimes(1);
  });

  it("真·干活中（running）→ 立刻 409、不等 drain", async () => {
    getTask.mockResolvedValue(taskWithAsk("tok"));
    runningTasks.set(TASK_ID, {});

    const resp = await handleTaskQuestionInject(TASK_ID, body);
    expect(resp.status).toBe(409);
    expect(waitForTaskToStop).not.toHaveBeenCalled();
    expect(resumeCurrentActionWithMessage).not.toHaveBeenCalled();
    const err = String((await resp.json()).error);
    expect(err).toContain("正在跑");
  });
});
