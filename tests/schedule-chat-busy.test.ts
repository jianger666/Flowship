/**
 * 定时触发遇到「在忙的 chat 会话」：回 409 `task_busy`，不占用户的排队名额（R14 Q20-03，方案 A）
 *
 * 背景：定时消息到点时，如果会话正在跑 / 队列里已有东西，chat-inject 原来照常入队并回 202，
 * runner 把 202 记成「已送达」。后果：
 *  - 周期定时能把 5 格排队队列占满，用户自己再发得到「排队已满」；回合结束后这些同一段内容的消息还逐条各起一轮 agent；
 *  - 一次性定时被记成已送达，其实只是进了用户的队列，用户点停止时随队列被清（schedule-queue-loss 只是事后提示）。
 * 修后：`scheduledTrigger` 遇忙 → 409 + `code: "task_busy"`，runner 按「忙 → 下个 tick 重试 + 待投递合并 + 10 分钟窗口」处理
 * （与 task 路径同口径）。用户自己发的消息（没有 `scheduledTrigger`）一律不变。
 *
 * 骨架抄 chat-inject-session-rebuilt.test.ts（同一张依赖图）；区别：chat-queue 用**真实**的（纯内存），
 * 这样「队列有没有被占」断言的是真实队列长度，而不是 mock 调用次数。
 *
 * 分类：回归 = 改前会红的用例；对照 = 改前改后都绿，防止改过头。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";
import { TOKEN_WATERMARK_ENV } from "@/lib/server/session-rotate";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-chat-busy-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const h = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  const state = {
    sessionAlive: true,
    sendResult: "sent" as "sent" | "busy",
    lifecycle: null as "stopping" | "deleting" | null,
    rewind: false,
  };
  return {
    state,
    getTask: vi.fn<AnyFn>(),
    sendChatMessage: vi.fn<AnyFn>(),
    runChatSession: vi.fn<AnyFn>(),
    writeEventAndPublish: vi.fn<AnyFn>(),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(),
  };
});

vi.mock("@/lib/server/session-rebuilt-notice", () => ({
  announceSessionRebuilt: vi.fn(async () => true),
}));
vi.mock("@/lib/server/task-fs", () => ({
  getTask: h.getTask,
  setTaskRunStatus: vi.fn(async (id: string) => ({ id })),
  updateTaskFields: vi.fn(async () => null),
  syncTaskPendingAskId: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/settings-fs", () => ({
  readSettingsFile: vi.fn(async () => ({ status: "missing" })),
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
  hasChatSession: vi.fn(() => h.state.sessionAlive),
  isChatQueueDraining: vi.fn(() => false),
  isChatRunActive: vi.fn(() => h.state.sessionAlive),
  releaseChatRunClaim: vi.fn(),
  resumeChatSession: vi.fn(async () => null),
  runChatSession: h.runChatSession,
  sendChatMessage: h.sendChatMessage,
  waitForChatToStop: vi.fn(async () => true),
}));
vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint: vi.fn(async () => ({
    ok: false,
    repoSnapshots: [],
    elapsedMsByRepo: {},
    warnings: [],
  })),
  persistCheckpointForReply: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-gate", () => ({
  getChatLifecycle: vi.fn(() => h.state.lifecycle),
  isChatRewindInProgress: vi.fn(() => h.state.rewind),
  isChatStartLeaseValid: vi.fn(() => true),
  releaseChatStart: vi.fn(),
  tryReserveChatStart: vi.fn(() => 1),
}));
vi.mock("@/lib/server/task-stream", () => ({
  PERSIST_FAIL_RETRY_MESSAGE: "落盘失败、请重试",
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  // 真实 chat-queue 入队 / 终态时会 publish 队列帧——吞掉即可
  publish: vi.fn(),
  publishTaskStreamEvent: vi.fn(),
  writeEventAndPublish: h.writeEventAndPublish,
  writeUserEventAndPublishStrict: h.writeUserEventAndPublishStrict,
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
const { CHAT_QUEUE_MAX, cleanupChatQueueState, enqueueChatMessage, getChatQueueCount, listChatQueueItemIds } =
  await import("@/lib/server/chat-queue");
const { classifyInjectResponse } = await import("@/lib/server/schedule-runner");

const SCHEDULED = { scheduledTrigger: true } as const;

let seq = 0;
const usedIds: string[] = [];
const newId = (): string => {
  seq += 1;
  const id = `t_chat_busy_${seq}`;
  usedIds.push(id);
  return id;
};

const makeTask = (id: string): Task =>
  ({
    id,
    title: "忙 chat",
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
  }) as unknown as Task;

/** 与真实 `deliverScheduleFire` 送进来的 body 同形：带 bootArgs 和幂等键 clientItemId */
const bodyOf = (clientItemId?: string, text = "[SCHEDULE_FIRED id=sch_x] 到点了：去看一眼 CI") => ({
  text,
  bootArgs: { apiKey: "k", model: { id: "grok-4.6" } },
  ...(clientItemId ? { clientItemId } : {}),
});

const jsonOf = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

/** 往真实队列里塞 n 条「用户自己排的」消息 */
const fillUserQueue = (id: string, n: number): void => {
  for (let i = 0; i < n; i += 1) {
    const r = enqueueChatMessage(id, {
      itemId: `u_${id}_${i}`,
      agentText: `用户消息 ${i}`,
      displayText: `用户消息 ${i}`,
      enqueuedAt: Date.now(),
    });
    expect(r.ok, `预置第 ${i} 条用户排队消息应成功`).toBe(true);
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(TOKEN_WATERMARK_ENV, "");
  h.state.sessionAlive = true;
  h.state.sendResult = "sent";
  h.state.lifecycle = null;
  h.state.rewind = false;
  h.getTask.mockImplementation(async (id: string) => makeTask(id));
  h.sendChatMessage.mockImplementation(async () => h.state.sendResult);
  h.runChatSession.mockImplementation(async () => {
    h.state.sessionAlive = true;
  });
  h.writeEventAndPublish.mockImplementation(async () => ({ id: "ev_info" }));
  h.writeUserEventAndPublishStrict.mockImplementation(async () => ({ id: "ev_user" }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const id of usedIds) cleanupChatQueueState(id);
  usedIds.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("回归：定时触发遇到忙的 chat → 409 task_busy，不占用户的排队名额", () => {
  it(
    "会话在跑（send 回 busy）→ 409 + code=task_busy；队列没被占；没有落「已发送」的 user_reply",
    async () => {
      const id = newId();
      h.state.sendResult = "busy";

      const res = await handleChatReplyInject(id, bodyOf("sch_a.1.1"), SCHEDULED);

      expect(res.status, "改前这里是 202 入队").toBe(409);
      const body = await jsonOf(res);
      expect(body.code).toBe("task_busy");
      expect(String(body.error)).toContain("稍后再送");
      expect(getChatQueueCount(id), "定时消息不得占用户的队列名额").toBe(0);
      expect(h.writeUserEventAndPublishStrict, "没送进会话就不能写已发送的气泡").not.toHaveBeenCalled();
    },
    30_000,
  );

  it(
    "用户已经排了一条（队列非空）→ 定时不插队、也不追加：409 task_busy，队列仍只有原来那条，send 没被调用",
    async () => {
      const id = newId();
      fillUserQueue(id, 1);

      const res = await handleChatReplyInject(id, bodyOf("sch_a.1.1"), SCHEDULED);

      expect(res.status, "改前这里是 202（追加成第 2 格）").toBe(409);
      expect((await jsonOf(res)).code).toBe("task_busy");
      expect(listChatQueueItemIds(id)).toEqual([`u_${id}_0`]);
      expect(h.sendChatMessage, "队列非空时不得越过用户的排队消息直接 send").not.toHaveBeenCalled();
    },
    30_000,
  );

  it(
    "用户 5 格队列已满 → 定时仍回 409 task_busy（不是「排队已满」），用户的 5 条原样保留",
    async () => {
      const id = newId();
      fillUserQueue(id, CHAT_QUEUE_MAX);

      const res = await handleChatReplyInject(id, bodyOf("sch_a.1.1"), SCHEDULED);

      expect(res.status).toBe(409);
      const body = await jsonOf(res);
      expect(body.code, "改前是「排队已满」的 409（没有 code），runner 分不清是忙还是满").toBe("task_busy");
      expect(String(body.error)).not.toContain("排队已满");
      expect(getChatQueueCount(id)).toBe(CHAT_QUEUE_MAX);
    },
    30_000,
  );

  it(
    "没有存活会话、队列里有滞留消息（队列优先启动路径）→ 定时回 409 task_busy；不用它起会话、也不动那条滞留消息",
    async () => {
      const id = newId();
      h.state.sessionAlive = false;
      fillUserQueue(id, 1);

      const res = await handleChatReplyInject(id, bodyOf("sch_a.1.1"), SCHEDULED);

      expect(res.status, "改前：入队 202，并把队首当 firstMessage 起会话").toBe(409);
      expect((await jsonOf(res)).code).toBe("task_busy");
      expect(h.runChatSession, "不该因为一条定时消息去起会话 / 消费用户的滞留消息").not.toHaveBeenCalled();
      expect(listChatQueueItemIds(id)).toEqual([`u_${id}_0`]);
    },
    30_000,
  );

  it(
    "忙 409 不留痕：同一个 clientItemId 等会话空闲后可以立刻重试并真正送达（200 delivered），不会被判成「已受理」",
    async () => {
      const id = newId();
      const key = "sch_a.1.1";

      h.state.sendResult = "busy";
      const first = await handleChatReplyInject(id, bodyOf(key), SCHEDULED);
      expect(first.status).toBe(409);

      h.state.sendResult = "sent";
      const second = await handleChatReplyInject(id, bodyOf(key), SCHEDULED);

      expect(second.status, "改前：第一次入了队，第二次命中 active → 202 alreadyAccepted").toBe(200);
      const body = await jsonOf(second);
      expect(body).toMatchObject({ ok: true, settled: true, outcome: "delivered", itemId: key });
      expect(body.alreadyAccepted).toBeUndefined();
      expect(h.sendChatMessage, "两次都真的走了 send（第一次 busy、第二次 sent）").toHaveBeenCalledTimes(2);
      expect(getChatQueueCount(id)).toBe(0);
    },
    30_000,
  );

  it(
    "端到端分类：忙 409 经真实 classifyInjectResponse 得到 retry（交给调度器重试），而不是被记成已送达",
    async () => {
      const id = newId();
      h.state.sendResult = "busy";

      const res = await handleChatReplyInject(id, bodyOf("sch_a.1.1"), SCHEDULED);
      const outcome = classifyInjectResponse(res.status, await jsonOf(res));

      expect(outcome.kind, "改前：202 → delivered，没送达也算送达").toBe("retry");
    },
    30_000,
  );
});

describe("对照：不该变的路径（改前改后都绿）", () => {
  it(
    "会话空闲 → 定时照常送达（200 delivered），send 调用一次，不入队",
    async () => {
      const id = newId();

      const res = await handleChatReplyInject(id, bodyOf("sch_a.1.1"), SCHEDULED);

      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toMatchObject({ ok: true, outcome: "delivered" });
      expect(h.sendChatMessage).toHaveBeenCalledTimes(1);
      expect(getChatQueueCount(id)).toBe(0);
    },
    30_000,
  );

  it(
    "用户自己发的消息（没有 scheduledTrigger）在会话忙时仍入队 202——排队体验不变",
    async () => {
      const id = newId();
      h.state.sendResult = "busy";

      const res = await handleChatReplyInject(id, bodyOf(undefined, "用户随手补一句"));

      expect(res.status).toBe(202);
      expect(await jsonOf(res)).toMatchObject({ ok: true, queued: true });
      expect(getChatQueueCount(id)).toBe(1);
    },
    30_000,
  );

  it(
    "用户自己发的消息遇到 5 格已满 → 仍是「排队已满」409，且没有 task_busy 标记",
    async () => {
      const id = newId();
      fillUserQueue(id, CHAT_QUEUE_MAX);

      const res = await handleChatReplyInject(id, bodyOf(undefined, "第六条"));

      expect(res.status).toBe(409);
      const body = await jsonOf(res);
      expect(String(body.error)).toContain("排队已满");
      expect(body.code).toBeUndefined();
      expect(getChatQueueCount(id)).toBe(CHAT_QUEUE_MAX);
    },
    30_000,
  );

  it.each([
    ["正在停止", "stopping"],
    ["任务正在删除", "deleting"],
  ] as const)(
    "入口拦截优先于「忙」：%s 时定时仍回原来的 409 文案，且不带 task_busy 标记",
    async (snippet, lifecycle) => {
      const id = newId();
      h.state.lifecycle = lifecycle;
      h.state.sendResult = "busy";

      const res = await handleChatReplyInject(id, bodyOf("sch_a.1.1"), SCHEDULED);

      expect(res.status).toBe(409);
      const body = await jsonOf(res);
      expect(String(body.error)).toContain(snippet);
      expect(body.code).toBeUndefined();
      expect(h.sendChatMessage).not.toHaveBeenCalled();
    },
    30_000,
  );

  it(
    "回退到检查点期间：定时仍回原来的 409 文案，且不带 task_busy 标记",
    async () => {
      const id = newId();
      h.state.rewind = true;
      h.state.sendResult = "busy";

      const res = await handleChatReplyInject(id, bodyOf("sch_a.1.1"), SCHEDULED);

      expect(res.status).toBe(409);
      const body = await jsonOf(res);
      expect(String(body.error)).toContain("回退");
      expect(body.code).toBeUndefined();
    },
    30_000,
  );

  it(
    "send 进行中途用户点了停止（send 回 busy 时 lifecycle 已是 stopping）→ 入队前的二次检查先拦：409「正在停止」，不带 task_busy 标记",
    async () => {
      const id = newId();
      h.sendChatMessage.mockImplementationOnce(async () => {
        h.state.lifecycle = "stopping";
        return "busy";
      });

      const res = await handleChatReplyInject(id, bodyOf("sch_a.1.1"), SCHEDULED);

      expect(res.status).toBe(409);
      const body = await jsonOf(res);
      expect(String(body.error)).toContain("正在停止");
      expect(body.code).toBeUndefined();
      expect(getChatQueueCount(id)).toBe(0);
    },
    30_000,
  );
});
