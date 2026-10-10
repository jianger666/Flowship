/**
 * chat 续聊（followup）的启动进度：回车后冷会话不再只有一个干等的气泡。
 *
 * - 冷路径（内存没会话、有落盘锚点 → resume）：恢复前报「正在恢复对话…」，
 *   恢复完、发送前报「正在发送…」——顺序相对 resume / send 本身要对
 * - 热路径（内存里有会话）：0.3–0.7s 就受理，没有阶段可说，一条都不报
 * - resume 没当上 owner（失败 / 让位）：只报恢复；没恢复成，不能再说「正在发送…」
 * - 冷路径的发送前快照与 resume 并行（快照只看 task.repoPaths、与会话无关）：
 *   快照在 resume 完成前就开跑，但 agent.send 仍必须等快照完成；永不留 unhandled rejection
 *
 * mock 骨架抄 session-rotate-chat.test.ts（chat-inject 同一张依赖图）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

let sessionAlive = false;

const {
  getTask,
  hasChatSession,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  publishTaskStreamEvent,
  captureChatCheckpoint,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    // 默认：没拍到快照（ok:false）——不影响发送、只是不带 checkpointed
    captureChatCheckpoint: vi.fn<AnyFn>(async () => ({
      ok: false,
      repoSnapshots: [],
      elapsedMsByRepo: {},
      warnings: [],
    })),
    getTask: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => sessionAlive),
    // 默认：恢复成功并当上 owner（instanceId=7）
    resumeChatSession: vi.fn<AnyFn>(async () => {
      sessionAlive = true;
      return 7;
    }),
    runChatSession: vi.fn<AnyFn>(async () => {
      sessionAlive = true;
    }),
    sendChatMessage: vi.fn<AnyFn>(async () => "sent"),
    publishTaskStreamEvent: vi.fn<AnyFn>(),
  };
});

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  setTaskRunStatus: vi.fn(async (id: string) => ({ id })),
  updateTaskFields: vi.fn(async () => null),
  syncTaskPendingAskId: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: vi.fn(async () => []),
}));
vi.mock("@/lib/server/chat-runner", () => ({
  cancelChatRun: vi.fn(),
  forceClearChatRun: vi.fn(),
  getChatRunDisabledMcp: vi.fn(() => null),
  getChatRunModel: vi.fn(() => ({ id: "grok-4.6" })),
  getChatRunProvider: vi.fn(() => null),
  getChatRunRepoPaths: vi.fn(() => null),
  hasChatSession,
  isChatQueueDraining: vi.fn(() => false),
  isChatRunActive: vi.fn(() => false),
  releaseChatRunClaim: vi.fn(),
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  waitForChatToStop: vi.fn(async () => true),
}));
vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint,
  persistCheckpointForReply: vi.fn(async () => undefined),
  persistReplyAndCheckpoint: vi.fn(async () => ({ id: "ev_user" })),
}));
vi.mock("@/lib/server/chat-queue", () => ({
  beginChatQueueInFlight: vi.fn(),
  claimMessageOperation: vi.fn(),
  dequeueChatMessage: vi.fn(() => null),
  enqueueChatMessage: vi.fn(() => ({ ok: true, itemId: "item-1", queuedCount: 1 })),
  enqueueChatMessageFront: vi.fn(),
  failQueuedItems: vi.fn(() => []),
  fingerprintFromMessagePayload: vi.fn(() => "fp"),
  getChatQueueCount: vi.fn(() => 0),
  getChatQueueGeneration: vi.fn(() => 1),
  getMessageOperation: vi.fn(() => undefined),
  isMessageOperationTerminal: vi.fn(() => false),
  markMessagePersisted: vi.fn(),
  settleMessageFailed: vi.fn(),
  settleMessageHandedOff: vi.fn(),
}));
vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-gate", () => ({
  getChatLifecycle: vi.fn(() => null),
  isChatRewindInProgress: vi.fn(() => false),
  isChatStartLeaseValid: vi.fn(() => true),
  releaseChatStart: vi.fn(),
  tryReserveChatStart: vi.fn(() => 1),
}));
vi.mock("@/lib/server/task-stream", () => ({
  PERSIST_FAIL_RETRY_MESSAGE: "落盘失败、请重试",
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  publishTaskStreamEvent,
  writeEventAndPublish: vi.fn(async () => ({ id: "ev_info" })),
  writeUserEventAndPublishStrict: vi.fn(async () => ({ id: "e1" })),
}));
vi.mock("@/lib/server/update-pending", () => ({
  checkUpdatePendingRestart: vi.fn(async () => null),
}));
vi.mock("@/lib/server/feishu-bridge/ask-card-settle", () => ({
  settleAskCards: vi.fn(async () => 1),
  ASK_CARD_SKIPPED_NOTE: "（已跳过）",
  ASK_CARD_SKIPPED_HINT: "这组提问已跳过、无需再回答",
  ASK_CARD_ANSWERED_HINT: "这组提问已回答、无需再答",
}));

const { handleChatReplyInject } = await import("@/lib/server/chat-inject");

const baseTask = {
  id: "t_boot_1",
  title: "续聊进度验收",
  mode: "chat",
  repoStatus: "developing",
  runStatus: "idle",
  currentActionId: null,
  actions: [],
  mrs: [],
  repoPaths: [],
  provider: "cursor",
  model: { id: "grok-4.6" },
  pendingAskId: null,
  createdAt: 1,
  updatedAt: 2,
  events: [],
} as unknown as Task;

/** 有落盘锚点（上次会话的 agentId）→ 内存没会话时会走 resume */
const coldTask: Task = { ...baseTask, sessionAgentId: "agent_cold_1" };

const body = {
  text: "继续",
  bootArgs: { apiKey: "k", model: { id: "grok-4.6" } },
};

/** 本测试关心的 boot 进度推送：[文案, stage, 调用序号] */
const bootPushes = (): Array<{ text: string; stage: string; order: number }> =>
  publishTaskStreamEvent.mock.calls.flatMap((call, i) => {
    const ev = (call as unknown[])[1] as
      | { kind?: string; event?: { text?: string; meta?: { stage?: string; bootStage?: boolean } } }
      | undefined;
    if (ev?.kind !== "event" || ev.event?.meta?.bootStage !== true) return [];
    return [
      {
        text: String(ev.event.text),
        stage: String(ev.event.meta.stage),
        order: publishTaskStreamEvent.mock.invocationCallOrder[i]!,
      },
    ];
  });

describe("chat 续聊启动进度（回车 → AI 开口之间）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionAlive = false;
  });

  it("冷会话：先报「正在恢复对话…」再 resume；恢复完、发送前报「正在发送…」", async () => {
    getTask.mockResolvedValue(coldTask);
    const resp = await handleChatReplyInject(coldTask.id, body);
    expect([200, 202]).toContain(resp.status);

    const pushes = bootPushes();
    expect(pushes.map((p) => [p.stage, p.text])).toEqual([
      ["resume", "正在恢复对话…"],
      ["send", "正在发送…"],
    ]);
    expect(resumeChatSession).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);

    // 顺序：报 resume → 真 resume → 报 send → 真 send
    const resumeAt = resumeChatSession.mock.invocationCallOrder[0]!;
    const sendAt = sendChatMessage.mock.invocationCallOrder[0]!;
    expect(pushes[0]!.order).toBeLessThan(resumeAt);
    expect(pushes[1]!.order).toBeGreaterThan(resumeAt);
    expect(pushes[1]!.order).toBeLessThan(sendAt);
  });

  it("热会话（内存里有）：没有阶段可说，一条 boot 进度都不推，也不 resume", async () => {
    sessionAlive = true;
    getTask.mockResolvedValue(coldTask);
    const resp = await handleChatReplyInject(coldTask.id, body);
    expect([200, 202]).toContain(resp.status);
    expect(bootPushes()).toEqual([]);
    expect(resumeChatSession).not.toHaveBeenCalled();
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("resume 没当上 owner（失败 / 让位）：只报恢复，不报「正在发送…」（没恢复成就不是在发送）", async () => {
    resumeChatSession.mockImplementationOnce(async () => null);
    getTask.mockResolvedValue(coldTask);
    // 起新会话的后续流程（落首条 user_reply 等）不是本用例关注点，这里的 mock 也没铺全——
    // 只验证 boot 推送，不看响应状态码
    await handleChatReplyInject(coldTask.id, body);
    expect(bootPushes().map((p) => p.stage)).toEqual(["resume"]);
    // 恢复失败 → 落到起新会话；新会话自己的 mcp / create / send 进度在 chat-runner 里报
    expect(runChatSession).toHaveBeenCalled();
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  it("没有落盘锚点（全新 chat 首条消息）：不走 resume，不报「正在恢复对话…」", async () => {
    getTask.mockResolvedValue(baseTask);
    await handleChatReplyInject(baseTask.id, body);
    expect(resumeChatSession).not.toHaveBeenCalled();
    expect(bootPushes()).toEqual([]);
  });
});

/** 绑了 workdir（repoPaths 非空）才会打发送前快照 */
const coldRepoTask: Task = { ...coldTask, repoPaths: ["/tmp/ckpt-parallel-repo"] };
const emptyCapture = { ok: false, repoSnapshots: [], elapsedMsByRepo: {}, warnings: [] };

/** 手动控制完成时机的 promise */
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("冷路径：发送前快照与 resume 并行（原先串行、冷发送白等 ~0.4s）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionAlive = false;
  });

  it("快照在 resume 完成前就开跑；resume 先好也不能先 send，agent.send 必须等快照完成", async () => {
    getTask.mockResolvedValue(coldRepoTask);
    const resume = deferred<number>();
    const capture = deferred<typeof emptyCapture>();
    resumeChatSession.mockImplementationOnce(async () => {
      const instanceId = await resume.promise;
      sessionAlive = true;
      return instanceId;
    });
    captureChatCheckpoint.mockImplementationOnce(() => capture.promise);

    const pending = handleChatReplyInject(coldRepoTask.id, body);

    // resume 还卡着、快照已经开跑了——这就是并行
    await vi.waitFor(() => expect(captureChatCheckpoint).toHaveBeenCalledTimes(1));
    expect(resumeChatSession).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).not.toHaveBeenCalled();

    // resume 先完成、快照还没好：仍不能 send（快照必须在 agent.send 之前，send 后 consume 就可能改文件）
    resume.resolve(7);
    await new Promise((r) => setTimeout(r, 30));
    expect(sendChatMessage).not.toHaveBeenCalled();

    // 快照完成 → 才 send
    capture.resolve(emptyCapture);
    const resp = await pending;
    expect([200, 202]).toContain(resp.status);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    // 整个冷发送只打了一次快照：unchanged 分支复用并行那份，不重打
    expect(captureChatCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("快照先好、resume 后好：send 仍排在 resume 之后", async () => {
    getTask.mockResolvedValue(coldRepoTask);
    const resume = deferred<number>();
    resumeChatSession.mockImplementationOnce(async () => {
      const instanceId = await resume.promise;
      sessionAlive = true;
      return instanceId;
    });

    const pending = handleChatReplyInject(coldRepoTask.id, body);
    await vi.waitFor(() => expect(captureChatCheckpoint).toHaveBeenCalledTimes(1));
    // 快照已秒完成（默认实现）；resume 还卡着
    await new Promise((r) => setTimeout(r, 30));
    expect(sendChatMessage).not.toHaveBeenCalled();

    resume.resolve(7);
    await pending;
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(captureChatCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("热会话：不提前打快照——send 前现打一次、且不 resume", async () => {
    sessionAlive = true;
    getTask.mockResolvedValue(coldRepoTask);
    await handleChatReplyInject(coldRepoTask.id, body);
    expect(resumeChatSession).not.toHaveBeenCalled();
    expect(captureChatCheckpoint).toHaveBeenCalledTimes(1);
    expect(captureChatCheckpoint.mock.invocationCallOrder[0]!).toBeLessThan(
      sendChatMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("并行快照失败（git 炸了）：不挡发消息，降级为不带 checkpointed", async () => {
    getTask.mockResolvedValue(coldRepoTask);
    captureChatCheckpoint.mockImplementationOnce(async () => {
      throw new Error("git exploded");
    });
    const resp = await handleChatReplyInject(coldRepoTask.id, body);
    expect([200, 202]).toContain(resp.status);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("resume 没当上 owner + 并行快照 reject：不留 unhandled rejection（vitest 会把它判失败），照常落到起新会话", async () => {
    getTask.mockResolvedValue(coldRepoTask);
    resumeChatSession.mockImplementationOnce(async () => null);
    // 第一次调用（并行那份）reject；起新会话路径自己的快照走默认实现
    captureChatCheckpoint.mockImplementationOnce(async () => {
      throw new Error("git exploded");
    });
    await handleChatReplyInject(coldRepoTask.id, body);
    // 给并行那份的 rejection 一个落地的机会：没吞的话这里之后会冒 unhandled
    await new Promise((r) => setTimeout(r, 30));
    expect(runChatSession).toHaveBeenCalled();
    expect(sendChatMessage).not.toHaveBeenCalled();
  });
});
