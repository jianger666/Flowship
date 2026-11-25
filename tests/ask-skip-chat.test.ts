/**
 * chat 模式「不答提问、直接发新消息」= 跳过（用户实测缺陷的主现场）
 *
 * task 模式原本就作废旧 ask，chat 这条链**一个字都没处理**：答题卡和顶部
 * 「AI 在等你回答」悬浮条会一直挂着（用户原话「像牛皮癣一样」）。
 *
 * 三条送达路径各钉一遍——它们是 chat 侧「消息已被受理」的全部出口：
 * 1. 活会话直接 send
 * 2. 排队（202，稍后 flush 给 agent）
 * 3. 起新会话（首条消息）
 *
 * 外加失败路径：没送出去要把登记放回，用户还能回去答。
 * 全部 mock 外部调用——不起 agent、不碰盘、不调飞书。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, TaskEvent } from "@/lib/types";
import {
  attachAskWaiter,
  openAskWait,
  resetAskWaitForTest,
} from "@/lib/server/ask-wait";

const {
  captureChatCheckpoint,
  enqueueChatMessage,
  getChatLifecycle,
  getChatQueueCount,
  getChatRunModel,
  getTask,
  hasChatSession,
  isChatRunActive,
  releaseChatRunClaim,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  setTaskRunStatus,
  settleAskCards,
  syncTaskPendingAskId,
  tryReserveChatStart,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    captureChatCheckpoint: vi.fn<AnyFn>(async () => ({
      ok: false,
      repoSnapshots: [],
      elapsedMsByRepo: {},
      warnings: [],
    })),
    enqueueChatMessage: vi.fn<AnyFn>(() => ({
      ok: true,
      itemId: "item-1",
      queuedCount: 1,
    })),
    getChatLifecycle: vi.fn<AnyFn>(() => null),
    getChatQueueCount: vi.fn<AnyFn>(() => 0),
    getChatRunModel: vi.fn<AnyFn>(() => null),
    getTask: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => true),
    isChatRunActive: vi.fn<AnyFn>(() => true),
    releaseChatRunClaim: vi.fn<AnyFn>(),
    resumeChatSession: vi.fn<AnyFn>(async () => null),
    runChatSession: vi.fn<AnyFn>(async () => undefined),
    sendChatMessage: vi.fn<AnyFn>(async () => "sent"),
    setTaskRunStatus: vi.fn<AnyFn>(),
    settleAskCards: vi.fn<AnyFn>(async () => 1),
    syncTaskPendingAskId: vi.fn<AnyFn>(async () => undefined),
    tryReserveChatStart: vi.fn<AnyFn>(() => 1),
    writeEventAndPublish: vi.fn<AnyFn>(async () => ({ id: "ev_skip" })),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "e1" })),
  };
});

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  setTaskRunStatus,
  updateTaskFields: vi.fn(async () => null),
  // chat-pending 的 meta 同步走动态 import("./task-fs")
  syncTaskPendingAskId,
}));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: vi.fn(async () => []),
}));
vi.mock("@/lib/server/chat-runner", () => ({
  cancelChatRun: vi.fn(),
  forceClearChatRun: vi.fn(),
  getChatRunDisabledMcp: vi.fn(() => null),
  getChatRunModel,
  getChatRunProvider: vi.fn(() => null),
  getChatRunRepoPaths: vi.fn(() => null),
  hasChatSession,
  isChatQueueDraining: vi.fn(() => false),
  isChatRunActive,
  // 忙线判定（sendChatMessage 会不会回 busy）：这些用例的热路径都是「会话在、空闲」→ false。与 isChatRunActive 无关
  isChatSendBusy: vi.fn(() => false),
  releaseChatRunClaim,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  waitForChatToStop: vi.fn(async () => true),
}));
vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint,
  persistCheckpointForReply: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-queue", () => ({
  beginChatQueueInFlight: vi.fn(),
  claimMessageOperation: vi.fn(),
  dequeueChatMessage: vi.fn(() => null),
  enqueueChatMessage,
  enqueueChatMessageFront: vi.fn(),
  failQueuedItems: vi.fn(() => []),
  fingerprintFromMessagePayload: vi.fn(() => "fp"),
  getChatQueueCount,
  getChatQueueGeneration: vi.fn(() => 1),
  getMessageOperation: vi.fn(() => undefined),
  isMessageOperationTerminal: vi.fn(() => false),
  markMessagePersisted: vi.fn(),
  settleMessageFailed: vi.fn(),
  settleMessageHandedOff: vi.fn(),
}));
vi.mock("@/lib/server/failpoints", () => ({ failpoint: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/chat-gate", () => ({
  getChatLifecycle,
  isChatRewindInProgress: vi.fn(() => false),
  isChatStartLeaseValid: vi.fn(() => true),
  releaseChatStart: vi.fn(),
  tryReserveChatStart,
}));
vi.mock("@/lib/server/task-stream", () => ({
  PERSIST_FAIL_RETRY_MESSAGE: "落盘失败、请重试",
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  publishTaskStreamEvent: vi.fn(),
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
}));
vi.mock("@/lib/server/update-pending", () => ({
  checkUpdatePendingRestart: vi.fn(async () => null),
}));
vi.mock("@/lib/server/feishu-bridge/ask-card-settle", () => ({
  settleAskCards,
  ASK_CARD_SKIPPED_NOTE: "（已跳过）",
  ASK_CARD_SKIPPED_HINT: "这组提问已跳过、无需再回答",
  ASK_CARD_ANSWERED_HINT: "这组提问已回答、无需再答",
}));

// chat-pending 用真的——认领 / 放回语义就是被测对象
const { __resetPendingAskStateForTest, getPendingAsk, registerPendingAsk } =
  await import("@/lib/server/chat-pending");
const { handleChatReplyInject } = await import("@/lib/server/chat-inject");
// 真实的中途标记（不 mock）：外来内容走 curl 回写时要在送达前登记。
// 注意探针用 isGroupNonOwnerTurnActive（任何作用域的活标记）：外来内容登记的是 scope=desktop，
// isNonOwnerTurnActive 只认 scope=all，拿它当探针会恒为 false（假红）。
const {
  __resetNonOwnerTurnGuardForTest,
  __setNonOwnerRunProbeForTest,
  beginForeignContentMidRun,
  endMidRunForeignContent,
  isGroupNonOwnerTurnActive,
} = await import("@/lib/server/non-owner-turn-guard");
// 第十一轮评审 P3-3 的用例要在回写函数（await 的长窗口）里让「别路沿用标记」发生：spy 真模块的导出
const askSkipModule = await import("@/lib/server/ask-skip");

const TASK_ID = "chat-1";
const ASK_ID = "ask-1";
const QUESTIONS = [{ id: "q1", question: "要不要顺手加埋点", allowText: true }];

const seedPendingAsk = (): string =>
  registerPendingAsk(TASK_ID, { askId: ASK_ID, questions: QUESTIONS }).token;

const chatTask = (token: string): Task =>
  ({
    id: TASK_ID,
    title: "重构登录",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    repoPaths: [],
    mrs: [],
    actions: [],
    events: [
      {
        id: "ev-ask",
        kind: "ask_user_request",
        text: "有问题要问",
        ts: Date.now(),
        meta: { askId: ASK_ID, token, questions: QUESTIONS },
      } as unknown as TaskEvent,
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

const BODY = {
  text: "不用加埋点、直接改吧",
  bootArgs: { apiKey: "sk-test", model: { id: "m1" } },
};

/** 落下的跳过事件（meta.supersededAskId 非空的那些） */
const skipEvents = (): Array<Record<string, unknown>> =>
  (writeEventAndPublish as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => (c[1] as { meta?: Record<string, unknown> })?.meta ?? {})
    .filter((m) => !!m.supersededAskId);

beforeEach(() => {
  vi.clearAllMocks();
  __resetPendingAskStateForTest();
  resetAskWaitForTest();
  getChatLifecycle.mockReturnValue(null);
  hasChatSession.mockReturnValue(true);
  getChatRunModel.mockReturnValue(null);
  getChatQueueCount.mockReturnValue(0);
  sendChatMessage.mockResolvedValue("sent");
  isChatRunActive.mockReturnValue(true);
  resumeChatSession.mockResolvedValue(null);
  tryReserveChatStart.mockReturnValue(1);
  writeEventAndPublish.mockResolvedValue({ id: "ev_skip" });
  writeUserEventAndPublishStrict.mockResolvedValue({ id: "e1" });
});

describe("chat 模式发新消息 = 跳过提问", () => {
  it("活会话直接 send → agent 文本带跳过上下文、落跳过事件、pending 清空", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(200);

    const agentText = String(
      (sendChatMessage as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[1] ?? "",
    );
    expect(agentText).toContain("已跳过");
    expect(agentText).toContain("重新问一次");
    expect(agentText.indexOf("已跳过")).toBeLessThan(
      agentText.indexOf("不用加埋点"),
    );

    expect(skipEvents()[0]?.askSkipped).toBe(true);
    expect(getPendingAsk(TASK_ID)).toBeNull();
    expect(settleAskCards).toHaveBeenCalledTimes(1);
  });

  it("气泡只存用户原文——跳过上下文不进事件流", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    await handleChatReplyInject(TASK_ID, BODY);

    const bubble = (
      writeUserEventAndPublishStrict as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls[0]?.[1] as { text?: string };
    expect(bubble?.text).toBe(BODY.text);
    expect(bubble?.text).not.toContain("已跳过");
  });

  it("同一轮 curl 挂着时输入条回车写进 stdout、不 send 不入队", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    sendChatMessage.mockResolvedValue("busy");
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token });
    const chunks: string[] = [];
    attachAskWaiter(TASK_ID, token, {
      write: (c) => chunks.push(c),
      close: () => undefined,
    });

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(200);
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(enqueueChatMessage).not.toHaveBeenCalled();
    expect(chunks.join("")).toContain("[ASK_USER_REPLY]");
    expect(chunks.join("")).toContain("已跳过");
    expect(chunks.join("")).toContain("不用加埋点");
    expect(skipEvents()[0]?.askSkipped).toBe(true);
    expect(getPendingAsk(TASK_ID)).toBeNull();
  });

  it("S12-01：冷恢复成 owner 后走 curl 回写 → 返回前必须释放 claim（不留假 busy 的 idle 会话）", async () => {
    const token = seedPendingAsk();
    // 内存无会话 + 有落盘锚点 → 先 resume 认领（claimRun），resume 返回 claim 实例号 7
    getTask.mockImplementation(
      async () => ({ ...chatTask(token), sessionAgentId: "agent_x" }) as unknown as Task,
    );
    hasChatSession.mockReturnValue(false);
    resumeChatSession.mockResolvedValue(7);
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token });
    attachAskWaiter(TASK_ID, token, {
      write: () => undefined,
      close: () => undefined,
    });

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(200);
    // 回写 stdout 这条路不会再 sendChatMessage，认领不释放 runActive 就永远 true
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(releaseChatRunClaim).toHaveBeenCalledWith(TASK_ID, 7);
  });

  it("排队（202）也算受理 → 排的那条带跳过上下文、跳过标记落地", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    // run 在跑 → send 返回 busy → 入队
    sendChatMessage.mockResolvedValue("busy");

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(202);
    const queued = (
      enqueueChatMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0]?.[1] as { agentText?: string; displayText?: string };
    expect(queued?.agentText).toContain("已跳过");
    // 排队气泡同样只显示原文
    expect(queued?.displayText).toBe(BODY.text);
    expect(skipEvents()[0]?.askSkipped).toBe(true);
  });

  it("起新会话（首条消息）→ 同样落跳过标记", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    hasChatSession.mockReturnValue(false);
    setTaskRunStatus.mockResolvedValue(chatTask(token));

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(202);
    const firstMessage = (
      runChatSession as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0]?.[0] as { firstMessage?: { text?: string } };
    expect(firstMessage?.firstMessage?.text).toContain("已跳过");
    expect(skipEvents()[0]?.askSkipped).toBe(true);
  });

  it("消息没送出去（会话被停）→ 登记放回、不写跳过事件", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    sendChatMessage.mockResolvedValue("cancelled");

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(409);
    expect(skipEvents()).toHaveLength(0);
    // 还能回去答那组问题
    expect(getPendingAsk(TASK_ID)?.askId).toBe(ASK_ID);
    expect(getPendingAsk(TASK_ID)?.token).toBe(token);
  });

  it("没有待答提问 → 文本零变化、不落任何跳过事件（老行为）", async () => {
    getTask.mockImplementation(
      async () => ({ ...chatTask("tok"), events: [] }) as unknown as Task,
    );
    await handleChatReplyInject(TASK_ID, BODY);
    const agentText = String(
      (sendChatMessage as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[1] ?? "",
    );
    expect(agentText).toBe(BODY.text);
    expect(skipEvents()).toHaveLength(0);
    expect(settleAskCards).not.toHaveBeenCalled();
  });
});

describe("外来内容走「顶掉提问」的 curl 回写（第五轮评审：askSkip 分支先于 registerForeignMark 就送达了，外来内容无标记）", () => {
  /** 挂着等答案的那一轮 curl：把 write 那一刻「中途标记在不在」记下来 */
  const attachProbe = (token: string): boolean[] => {
    const atWrite: boolean[] = [];
    attachAskWaiter(TASK_ID, token, {
      write: () => {
        atWrite.push(isGroupNonOwnerTurnActive(TASK_ID));
      },
      close: () => undefined,
    });
    return atWrite;
  };

  it("foreignContentTurn + 同一轮 curl 挂着：写进 stdout 的那一刻标记已就位，回写成功后留给 run 收尾清", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token });
    const atWrite = attachProbe(token);
    try {
      const resp = await handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true });
      expect(resp.status).toBe(200);
      // 走的确实是 curl 回写这条路，不是 send / 入队
      expect(sendChatMessage).not.toHaveBeenCalled();
      expect(enqueueChatMessage).not.toHaveBeenCalled();
      expect(atWrite.length, "应该写过 stdout").toBeGreaterThan(0);
      expect(atWrite.every(Boolean), `每一次写进 stdout 的那一刻，标记都已经就位（登记紧贴送达）；实际逐次：${JSON.stringify(atWrite)}`).toBe(true);
      expect(isGroupNonOwnerTurnActive(TASK_ID), "送出去了：标记留给 run 收尾清").toBe(true);
    } finally {
      endMidRunForeignContent(TASK_ID);
    }
  });

  // 第十二轮评审 P3-3（既有问题，不是前几轮引入）：回写已经写进 curl（= 送达，内容进了属主此刻那一轮、那一轮只靠这个标记限制 desktop_* 等）之后，
  // 收尾的 await（commit / 取最新任务）若抛错（读盘失败），请求以 500 结束、handleChatReplyInject 的 accepted 为 false，外层 finally 就会按 foreignRef.token
  // 回滚——把已经送达的内容的保护清了。送达之后标记交给 run 收尾按名清，外层不得再按 token 回滚。
  it("回写成功（已送达）之后收尾读盘抛错：请求以错误结束，标记仍在——送出去的留给 run 收尾清，外层 finally 不得按 token 回滚（第十二轮评审 P3-3）", async () => {
    const token = seedPendingAsk();
    let written = false;
    getTask.mockImplementation(async () => {
      if (written) throw new Error("读盘失败（测试注入）");
      return chatTask(token);
    });
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token });
    attachAskWaiter(TASK_ID, token, {
      write: () => {
        written = true;
      },
      close: () => undefined,
    });
    try {
      await expect(handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true })).rejects.toThrow("读盘失败");
      expect(written, "前置：内容已经写进 curl（送达）").toBe(true);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "已送达的内容失去了保护：外层 finally 因为请求抛错（accepted=false）按 token 把标记回滚了，那一轮后半程的 desktop_* / 写所有者备注 / 建定时不再被拒",
      ).toBe(true);
    } finally {
      endMidRunForeignContent(TASK_ID);
    }
    expect(isGroupNonOwnerTurnActive(TASK_ID), "run 收尾按名清后才没").toBe(false);
  });

  it("对照：不带 foreignContentTurn（所有者自己的话）→ 回写时没有任何标记，回写后也没有", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token });
    const atWrite = attachProbe(token);
    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(200);
    expect(atWrite.length).toBeGreaterThan(0);
    expect(atWrite.some(Boolean), "属主自己的话不该被登记成外来内容").toBe(false);
    expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
  });

  it("登记后没送达（没有挂着的 curl 槽 → 往下走 owner send → 被停 409）→ 标记按 token 回滚，不留孤儿", async () => {
    // 登记点前移到了回写之前：回写没成功、后面的 send 也没送出去时，这一次登记的标记必须收回，
    // 否则这个 task 之后的每一轮都会被当成「外来内容轮」拒掉电脑操作，直到 TTL。
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    sendChatMessage.mockResolvedValue("cancelled");
    try {
      const resp = await handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true });
      expect(resp.status).toBe(409);
      expect(isGroupNonOwnerTurnActive(TASK_ID), "没送达 → 回滚").toBe(false);
    } finally {
      endMidRunForeignContent(TASK_ID);
    }
  });

  // 第十一轮评审 P3-3：登记之后要跨过 fulfillAskSkipViaWait 的长 await（槽上没有 curl 时最长 ASK_WAIT_ATTACH_MS = 15 秒），
  // 窗口里别路的外来内容可能沿用这个标记。这一处的收回不能再交给 handleChatReplyInject 的 finally（紧贴 send 的 endNonOwnerTurn，按 token 一清就把
  // 沿用者正靠着的标记清了），而是回写没成功时当场走 rollbackForeignContentMidRun（沿用过且此刻还有 run 在跑就让位）。
  describe("登记之后窗口里别路沿用了标记（第十一轮评审 P3-3）", () => {
    const PROBE = "ask-skip-chat-probe";
    // 只还原本组自己挂的 spy（外层 beforeEach 用的是 clearAllMocks，不会替我们还原；别的 vi.fn 的实现不能动）
    let writeBackSpy: { mockRestore: () => void } | undefined;
    afterEach(() => {
      writeBackSpy?.mockRestore();
      writeBackSpy = undefined;
      __setNonOwnerRunProbeForTest(PROBE, null);
      __resetNonOwnerTurnGuardForTest();
    });

    /** 回写函数（await 的长窗口）被调用时，别路的外来内容沿用了此刻的活标记（beginForeignContentMidRun 返回 undefined、置 shared） */
    const sharerJoinsDuringWriteBack = (): void => {
      writeBackSpy = vi.spyOn(askSkipModule, "fulfillAskSkipViaWait").mockImplementation(async () => {
        expect(beginForeignContentMidRun(TASK_ID), "前置：窗口里标记已就位，别路沿用它（没有自己的 token）").toBeUndefined();
        return false; // 窗口到点：curl 没挂上，没写进去
      });
    };

    it("沿用者那一轮在跑：回写没成功、往下走的 owner send 也没送达（409）——标记留给沿用者那一轮收尾，不被登记者的收回清掉", async () => {
      const token = seedPendingAsk();
      getTask.mockImplementation(async () => chatTask(token));
      sendChatMessage.mockResolvedValue("cancelled");
      __setNonOwnerRunProbeForTest(PROBE, (id) => id === TASK_ID); // 沿用者送达了：它那一轮在跑
      sharerJoinsDuringWriteBack();
      try {
        const resp = await handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true });
        expect(resp.status).toBe(409);
        expect(
          isGroupNonOwnerTurnActive(TASK_ID),
          "登记者把沿用者正靠着的标记清了：沿用者那一轮后半程的 desktop_* / 写所有者备注 / 建定时不再被拒",
        ).toBe(true);
      } finally {
        endMidRunForeignContent(TASK_ID);
      }
      expect(isGroupNonOwnerTurnActive(TASK_ID), "沿用者那一轮收尾按名清后才没").toBe(false);
    });

    it("回写抛错也一样：沿用者那一轮在跑就让位，错误照旧往外抛", async () => {
      const token = seedPendingAsk();
      getTask.mockImplementation(async () => chatTask(token));
      __setNonOwnerRunProbeForTest(PROBE, (id) => id === TASK_ID);
      writeBackSpy = vi.spyOn(askSkipModule, "fulfillAskSkipViaWait").mockImplementation(async () => {
        beginForeignContentMidRun(TASK_ID); // 别路沿用
        throw new Error("回写炸了");
      });
      try {
        await expect(handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true })).rejects.toThrow("回写炸了");
        expect(isGroupNonOwnerTurnActive(TASK_ID), "抛错回滚把沿用者正靠着的标记清了").toBe(true);
      } finally {
        endMidRunForeignContent(TASK_ID);
      }
    });

    it("沿用者没送达（此刻没有 run 在跑）：照清，不留没人收尾的孤儿（P3-1 在这一处的同口径）", async () => {
      const token = seedPendingAsk();
      getTask.mockImplementation(async () => chatTask(token));
      sendChatMessage.mockResolvedValue("cancelled");
      sharerJoinsDuringWriteBack(); // 没有登记探针：没有 run 在跑
      try {
        const resp = await handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true });
        expect(resp.status).toBe(409);
        expect(isGroupNonOwnerTurnActive(TASK_ID), "沿用者没送达、没有 run 在跑，标记成了孤儿").toBe(false);
      } finally {
        endMidRunForeignContent(TASK_ID);
      }
    });

    it("回写没成功、往下走 owner send 成功：送达前一刻重新登记（收回之后不留空窗），标记留给 run 收尾清", async () => {
      // 收回之后后面的 registerForeignMark 要在 sendChatMessage 之前一刻重新登记——不能因为这一处改成「收回就不再登记」而无标记送达
      const token = seedPendingAsk();
      getTask.mockImplementation(async () => chatTask(token));
      const atSend: boolean[] = [];
      sendChatMessage.mockImplementation(async () => {
        atSend.push(isGroupNonOwnerTurnActive(TASK_ID));
        return "sent";
      });
      try {
        const resp = await handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true });
        expect(resp.status).toBe(200);
        expect(atSend, "owner send 那一刻标记已就位").toEqual([true]);
        expect(isGroupNonOwnerTurnActive(TASK_ID), "送出去了：标记留给 run 收尾清").toBe(true);
      } finally {
        endMidRunForeignContent(TASK_ID);
      }
    });
  });
});

// 第十三轮评审 P3-1：送达之后（直送路径的 sent、新会话路径的 transfer）还有 askSkip.commit() / 取最新任务（读盘）两个 await 在 outer finally 之前，
// 任何一个抛错都让请求以错误结束、handleChatReplyInject 的 accepted 为 false，外层 finally 就会按 foreignRef.token 回滚——
// 把已经送达的内容那一轮的保护清了（与第十二轮 P3-3 的「回写分支」同一类，那次只补了回写分支，这两条路径漏了）。
// 修法：送达成立的那一刻把 token 交出去（foreignRef.token = undefined），标记归 run 收尾按名清。
// 说明：真实的 commit() 整段吞异常（commitAskSkip 的两个 try/catch），读盘（getTask）才是现实里的抛错点；commit 抛错用 spy 注入，是对「别人以后改了 commit」的防回归。
describe("送达之后各出口抛错：已送达的标记不得被外层 finally 回滚（第十三轮评审 P3-1）", () => {
  let beginSpy: { mockRestore: () => void } | undefined;
  afterEach(() => {
    beginSpy?.mockRestore();
    beginSpy = undefined;
    endMidRunForeignContent(TASK_ID);
    __resetNonOwnerTurnGuardForTest();
  });

  /**
   * 让 askSkip.commit() 抛错（其余行为沿用真实现：认领 / 回滚照常）。
   * 先走真 commit 再抛：真 commit 第一步就把句柄置 settled，之后外层 finally 里的 rollback() 是 no-op——
   * 只抛、不置 settled 会让 finally 的 rollback() 把「已送达」的跳过认领放回，那是测试假象、不是生产行为
   * （第十四轮评审 P3-5 ⑧）。被测的只有「标记别被外层 finally 回滚」这一件事。
   */
  const commitThrows = (): void => {
    const real = askSkipModule.beginAskSkip;
    beginSpy = vi.spyOn(askSkipModule, "beginAskSkip").mockImplementation((t) => {
      const h = real(t);
      return h.claimed
        ? {
            ...h,
            commit: async () => {
              await h.commit();
              throw new Error("commit 炸了（测试注入）");
            },
          }
        : h;
    });
  };

  /** 送达（pred 为真）之后读盘抛错 */
  const getTaskThrowsAfter = (token: string, delivered: () => boolean): void => {
    getTask.mockImplementation(async () => {
      if (delivered()) throw new Error("读盘失败（测试注入）");
      return chatTask(token);
    });
  };

  const sendCalls = (): number =>
    (sendChatMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
  const startCalls = (): number =>
    (runChatSession as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;

  /** 新会话路径的前置：内存里没有会话、没有落盘锚点 → 走「确定会起新会话」 */
  const newSessionSetup = (token: string): void => {
    hasChatSession.mockReturnValue(false);
    setTaskRunStatus.mockResolvedValue(chatTask(token));
  };

  it("直送路径：send 成功后 askSkip.commit() 抛错 → 请求以错误结束，标记仍在（留给 run 收尾清）〔防回归：真 commit 吞异常，现实触发点是下一条的读盘〕", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    commitThrows();
    await expect(handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true })).rejects.toThrow("commit 炸了");
    expect(sendCalls(), "前置：消息已经 send 出去（送达）").toBe(1);
    expect(
      isGroupNonOwnerTurnActive(TASK_ID),
      "已送达的内容失去了保护：外层 finally 因为请求抛错（accepted=false）按 token 把标记回滚了",
    ).toBe(true);
    endMidRunForeignContent(TASK_ID);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "run 收尾按名清后才没").toBe(false);
  });

  it("直送路径：send 成功、commit 也成功，收尾取最新任务（读盘）抛错 → 标记仍在", async () => {
    const token = seedPendingAsk();
    getTaskThrowsAfter(token, () => sendCalls() > 0);
    await expect(handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true })).rejects.toThrow("读盘失败");
    expect(sendCalls(), "前置：消息已经 send 出去（送达）").toBe(1);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "读盘一失败，已送达的内容就失去了保护").toBe(true);
  });

  it("新会话路径：会话带着消息起来后 askSkip.commit() 抛错 → 请求以错误结束，标记仍在〔防回归：真 commit 吞异常，现实触发点是下一条的读盘〕", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    newSessionSetup(token);
    commitThrows();
    await expect(handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true })).rejects.toThrow("commit 炸了");
    expect(startCalls(), "前置：新会话已带着这条消息起来").toBe(1);
    expect(
      isGroupNonOwnerTurnActive(TASK_ID),
      "新会话已带着别人的内容跑起来，标记却被外层 finally 回滚了",
    ).toBe(true);
  });

  it("新会话路径：会话起来后收尾取最新任务（读盘）抛错 → 标记仍在", async () => {
    const token = seedPendingAsk();
    getTaskThrowsAfter(token, () => startCalls() > 0);
    newSessionSetup(token);
    await expect(handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true })).rejects.toThrow("读盘失败");
    expect(startCalls(), "前置：新会话已带着这条消息起来").toBe(1);
    expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(true);
  });

  it("对照：送达之前就抛错（send 本身抛）→ 照旧按 token 回滚，不留孤儿（交出 token 只发生在送达成立之后）", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    // 记下 send 那一刻标记是否已登记（第十四轮评审 P3-5 ⑧）：没有这条前置，「最后没留标记」可能只是因为从来没登记过，对照就空转了
    const atSend: boolean[] = [];
    sendChatMessage.mockImplementationOnce(async () => {
      atSend.push(isGroupNonOwnerTurnActive(TASK_ID));
      throw new Error("send 炸了");
    });
    await expect(handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true })).rejects.toThrow("send 炸了");
    expect(atSend, "前置：send 那一刻标记已登记（是回滚清掉的，不是从没登记）").toEqual([true]);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "没送达的标记必须回滚").toBe(false);
  });

  it("对照：新会话没起来（占位没挂上 → 租约中止）→ 照旧按 token 回滚", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    newSessionSetup(token);
    isChatRunActive.mockReturnValue(false); // 同步前奏之后占位没挂上：leaseAbortedResponse
    // 记下起会话那一刻标记是否已登记（同上，防对照空转）
    const atStart: boolean[] = [];
    runChatSession.mockImplementationOnce(async () => {
      atStart.push(isGroupNonOwnerTurnActive(TASK_ID));
      return undefined;
    });
    const resp = await handleChatReplyInject(TASK_ID, BODY, { foreignContentTurn: true });
    expect(resp.ok).toBe(false);
    expect(atStart, "前置：起会话那一刻标记已登记（是回滚清掉的，不是从没登记）").toEqual([true]);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "没起来的会话不该留标记").toBe(false);
  });
});
