/**
 * chat 型任务里「别人的内容在驱动」的一轮：handleChatReplyInject({ foreignContentTurn: true })（第三轮评审 P1-1）
 *
 * 背景：所有者在需求群里空 @ 了机器人、而被 @ 的那条消息是别人说的——AI 读到的全部内容都出自那个人。task 型任务靠
 * send 起点登记标记，chat 型以前完全没有这个机制：陌生人的一句话经所有者的空 @ 就能让 chat 里的 AI 调 desktop_*（操作所有者的电脑）。
 * 修后 chat-inject 在送达前补登一个 scope=desktop 的中途标记，并且：
 *  - 没送出去（任何非 2xx / 抛错）→ 回滚，不残留；送出去的 → 保留给 run 收尾（consumeChatRun / runChatSession 的 finally）清；
 *  - **忙时照常排队**（第五轮评审 N1：第四轮曾回 409「请稍后再 @ 我一次」，所有者一句话只因 agent 正忙就丢了）：队列项带着
 *    foreignContentTurn，入队时**不登记**标记（那会去限制属主此刻正在跑的那一轮、还会被这一轮的收尾按名清掉），出队送达那一刻才登记——
 *    这一半（flush / 队列优先启动 / send-now 的真链路）见 chat-runner-foreign-marker-cleanup.test.ts 的「排队的外来内容」一组；
 *    直送路径预登记的标记在 send 回 busy 改入队时回滚（本文件「忙时排队」一组）；
 *  - 此刻已有活标记 → 不新建、不降级、回滚时也不误清它；
 *  - 登记点紧贴送达（sendChatMessage / runChatSession 之前同步登记），不在入口登记：入口到送达之间有发送前快照
 *    （扫仓库、大仓 1–10 秒），上一轮 run 若在这期间收尾，会按名把早登记的标记清掉（第四轮评审「标记竞态」，见「标记竞态」一组）。
 *
 * 骨架抄 schedule-chat-busy.test.ts（同一张依赖图）；区别：non-owner-turn-guard 用**真实**的，
 * sendChatMessage 的 mock 在被调用那一刻记录标记状态（= agent 拿到内容那一刻标记是否已就位）。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";
import { TOKEN_WATERMARK_ENV } from "@/lib/server/session-rotate";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-inject-foreign-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const h = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  const state = {
    sessionAlive: true,
    sendBusy: false,
    sendResult: "sent" as "sent" | "busy" | "send_failed",
    lifecycle: null as "stopping" | "deleting" | null,
  };
  return {
    state,
    getTask: vi.fn<AnyFn>(),
    sendChatMessage: vi.fn<AnyFn>(),
    runChatSession: vi.fn<AnyFn>(),
    captureChatCheckpoint: vi.fn<AnyFn>(),
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
  isChatSendBusy: vi.fn(() => h.state.sendBusy),
  releaseChatRunClaim: vi.fn(),
  resumeChatSession: vi.fn(async () => null),
  runChatSession: h.runChatSession,
  sendChatMessage: h.sendChatMessage,
  waitForChatToStop: vi.fn(async () => true),
}));
vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint: h.captureChatCheckpoint,
  persistCheckpointForReply: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-gate", () => ({
  getChatLifecycle: vi.fn(() => h.state.lifecycle),
  isChatRewindInProgress: vi.fn(() => false),
  isChatStartLeaseValid: vi.fn(() => true),
  releaseChatStart: vi.fn(),
  tryReserveChatStart: vi.fn(() => 1),
}));
vi.mock("@/lib/server/task-stream", () => ({
  PERSIST_FAIL_RETRY_MESSAGE: "落盘失败、请重试",
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
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
const { cleanupChatQueueState, enqueueChatMessage, getChatQueueCount, peekQueuedChatMessage, settleMessageHandedOff } = await import(
  "@/lib/server/chat-queue"
);
const { failpoint } = await import("@/lib/server/failpoints");
const {
  __resetNonOwnerTurnGuardForTest,
  __setNonOwnerRunProbeForTest,
  beginForeignContentMidRun,
  beginNonOwnerTurn,
  endMidRunForeignContent,
  isGroupNonOwnerTurnActive,
  isNonOwnerTurnActive,
} = await import("@/lib/server/non-owner-turn-guard");

let seq = 0;
const usedIds: string[] = [];
const newId = (): string => {
  seq += 1;
  const id = `t_chat_foreign_${seq}`;
  usedIds.push(id);
  return id;
};

const makeTask = (id: string): Task =>
  ({
    id,
    title: "chat 外来内容",
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

const bodyOf = (text = "上面的发言只有一个 @、没有正文——帮我在电脑上截个屏") => ({
  text,
  bootArgs: { apiKey: "k", model: { id: "grok-4.6" } },
});
const FOREIGN = { foreignContentTurn: true } as const;

const jsonOf = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

/** sendChatMessage 被调用那一刻的标记状态（= agent 拿到内容那一刻标记是否已就位） */
const atSend = { group: [] as boolean[], all: [] as boolean[] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(TOKEN_WATERMARK_ENV, "");
  __resetNonOwnerTurnGuardForTest();
  atSend.group.length = 0;
  atSend.all.length = 0;
  h.state.sessionAlive = true;
  h.state.sendBusy = false;
  h.state.sendResult = "sent";
  h.state.lifecycle = null;
  h.getTask.mockImplementation(async (id: string) => makeTask(id));
  // 默认：快照没成（不带 checkpointed）。竞态用例（见「标记竞态」）会在它里面模拟「上一轮 run 收尾」
  h.captureChatCheckpoint.mockImplementation(async () => ({
    ok: false,
    repoSnapshots: [],
    elapsedMsByRepo: {},
    warnings: [],
  }));
  h.sendChatMessage.mockImplementation(async (...args: unknown[]) => {
    const id = (args[0] as { id: string }).id;
    atSend.group.push(isGroupNonOwnerTurnActive(id));
    atSend.all.push(isNonOwnerTurnActive(id));
    return h.state.sendResult;
  });
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
  __resetNonOwnerTurnGuardForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("送出去了：标记在 agent 拿到内容之前就位，并保留到 run 收尾", () => {
  it(
    "会话空闲、热路径 send 成功 → 200；sendChatMessage 被调用那一刻标记已就位（scope=desktop）；返回后仍在（run 收尾的摘除见 chat-runner-foreign-marker-cleanup.test.ts，这里 mock 了 run）",
    async () => {
      const id = newId();

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(200);
      expect(h.sendChatMessage).toHaveBeenCalledTimes(1);
      expect(atSend.group, "agent 拿到内容那一刻标记还没就位——这一轮就是无标记轮").toEqual([true]);
      // scope=desktop：只拦电脑操作 / 写所有者备注等，系统工具整体硬拒（scope=all）那种不是它
      expect(atSend.all).toEqual([false]);
      expect(isGroupNonOwnerTurnActive(id), "送出去的标记应留给 run 收尾清，这里不能提前摘").toBe(true);
    },
    30_000,
  );

  it(
    "没有存活会话（新会话路径）→ 202 autoStarted；runChatSession 被调用那一刻标记已就位；返回后仍在",
    async () => {
      const id = newId();
      h.state.sessionAlive = false;
      const atStart: boolean[] = [];
      h.runChatSession.mockImplementation(async () => {
        atStart.push(isGroupNonOwnerTurnActive(id));
        h.state.sessionAlive = true;
      });

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(202);
      expect(await jsonOf(res)).toMatchObject({ ok: true, autoStarted: true });
      expect(h.runChatSession).toHaveBeenCalledTimes(1);
      expect(atStart, "起新会话时 agent 一拿到首条消息就可能调工具，标记必须先就位").toEqual([true]);
      // 真实的 runChatSession 会在自己的 finally 里清（见 chat-runner-foreign-marker-cleanup.test.ts）；这里它被 mock 掉了
      expect(isGroupNonOwnerTurnActive(id)).toBe(true);
    },
    30_000,
  );
});

describe("没送出去：标记回滚不残留；忙时排队（第五轮评审 N1：队列项带 foreignContentTurn、入队不登记标记）", () => {
  it(
    "会话在跑（send 回 busy）→ 202 入队；队列项带 foreignContentTurn；没落已发送的 user_reply；直送路径预登记的标记已回滚",
    async () => {
      const id = newId();
      h.state.sendResult = "busy";

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status, "忙时应照常排队：不能因 agent 正忙就把所有者的话丢了（第四轮的 409 就是这个回归）").toBe(202);
      const body = await jsonOf(res);
      expect(body).toMatchObject({ ok: true, queued: true });
      expect(body.code, "不再是 task_busy 的 409").toBeUndefined();
      expect(getChatQueueCount(id)).toBe(1);
      expect(
        peekQueuedChatMessage(id, String(body.itemId))?.foreignContentTurn,
        "队列项必须带着外来内容的标志——出队送达时靠它登记标记，丢了就是无标记送达",
      ).toBe(true);
      expect(h.writeUserEventAndPublishStrict, "入队不写 user_reply（flush 出队时才写）").not.toHaveBeenCalled();
      // 直送路径先在 sendChatMessage 之前登记过（那一刻在）；send 回 busy 改入队后必须回滚，否则标记会去限制属主此刻正在跑的这一轮
      expect(atSend.group, "直送路径应在 send 之前登记过（才有回滚可言）").toEqual([true]);
      expect(isGroupNonOwnerTurnActive(id), "入队后预登记的标记残留（会拒属主这一轮自己的电脑操作）").toBe(false);
    },
    30_000,
  );

  it(
    "run 正在跑（isChatSendBusy 为真、不经 send 直接走入队分支）→ 同样 202 入队、带标志；send 没被调用；标记从未登记",
    async () => {
      const id = newId();
      h.state.sendBusy = true;

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(202);
      const body = await jsonOf(res);
      expect(body).toMatchObject({ ok: true, queued: true });
      expect(h.sendChatMessage).not.toHaveBeenCalled();
      expect(getChatQueueCount(id)).toBe(1);
      expect(peekQueuedChatMessage(id, String(body.itemId))?.foreignContentTurn).toBe(true);
      expect(isGroupNonOwnerTurnActive(id), "入队时不登记标记：它会去限制属主此刻正在跑的这一轮").toBe(false);
    },
    30_000,
  );

  it(
    "send 抛错 → 异常原样冒出去，标记已回滚",
    async () => {
      const id = newId();
      h.sendChatMessage.mockImplementation(async () => {
        throw new Error("boom（测试注入）");
      });

      await expect(handleChatReplyInject(id, bodyOf(), FOREIGN)).rejects.toThrow("boom");

      expect(isGroupNonOwnerTurnActive(id), "抛错后标记残留").toBe(false);
    },
    30_000,
  );

  it.each([
    ["正在停止", "stopping"],
    ["任务正在删除", "deleting"],
  ] as const)(
    "入口拦截（%s，409）→ 标记已回滚",
    async (snippet, lifecycle) => {
      const id = newId();
      h.state.lifecycle = lifecycle;

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(409);
      expect(String((await jsonOf(res)).error)).toContain(snippet);
      expect(h.sendChatMessage).not.toHaveBeenCalled();
      expect(isGroupNonOwnerTurnActive(id)).toBe(false);
    },
    30_000,
  );

  it(
    "请求体非法（空文本，400）→ 标记已回滚",
    async () => {
      const id = newId();

      const res = await handleChatReplyInject(id, { text: "   ", bootArgs: bodyOf().bootArgs }, FOREIGN);

      expect(res.ok).toBe(false);
      expect(h.sendChatMessage).not.toHaveBeenCalled();
      expect(isGroupNonOwnerTurnActive(id)).toBe(false);
    },
    30_000,
  );
});

describe("外来标志透传给 runChatSession（第五轮评审 N1）：出队起会话 / 新会话路径都带着，runner 才能在首包前登记", () => {
  type RunInput = { firstMessage?: { text: string }; foreignContentTurn?: boolean };
  const runInputOf = (i = 0): RunInput =>
    (h.runChatSession.mock.calls[i]?.[0] ?? {}) as unknown as RunInput;
  /** 更早排进来、一直滞留的一条（会话起不来 / 刚被停的窗口里入的队）；skipPersistEvent：气泡已落过 */
  const stallItem = (id: string, foreign: boolean): void => {
    const queued = enqueueChatMessage(id, {
      agentText: foreign ? "别人写的内容" : "普通的话",
      displayText: foreign ? "别人写的内容" : "普通的话",
      imageAbsPaths: [],
      enqueuedAt: Date.now(),
      skipPersistEvent: true,
      ...(foreign ? { foreignContentTurn: true } : {}),
    });
    expect(queued.ok, "前置：滞留项应已入队").toBe(true);
  };

  it(
    "没有存活会话、队列里滞留着一条外来内容 → 队列优先启动：runChatSession 入参带 foreignContentTurn（队首那条的，不是当前这条的）",
    async () => {
      const id = newId();
      h.state.sessionAlive = false;
      stallItem(id, true);

      // 当前这条是属主自己的话（不带 foreignContentTurn）：入队保序后队首是那条外来内容
      const res = await handleChatReplyInject(id, bodyOf("属主自己的话"));

      expect(res.status).toBe(202);
      expect(h.runChatSession).toHaveBeenCalledTimes(1);
      expect(runInputOf().firstMessage?.text, "起会话的首条应是队首（滞留的那条）").toBe("别人写的内容");
      expect(runInputOf().foreignContentTurn, "队首是外来内容、起会话的首包却没带标志——无标记送达").toBe(true);
    },
    30_000,
  );

  it(
    "对照：队首是普通消息、当前这条是外来内容 → 首包不带标志；当前这条仍在队里、带着标志等出队",
    async () => {
      const id = newId();
      h.state.sessionAlive = false;
      stallItem(id, false);

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(202);
      expect(h.runChatSession).toHaveBeenCalledTimes(1);
      expect(runInputOf().firstMessage?.text).toBe("普通的话");
      expect(runInputOf(), "队首是普通消息：首包不能被后面那条外来内容连累").not.toHaveProperty("foreignContentTurn");
      // 当前这条外来内容还在队里（带标志）：等队首那一轮收尾后 flush 出队，那时才登记标记
      expect(getChatQueueCount(id)).toBe(1);
      const body = await jsonOf(res);
      expect(peekQueuedChatMessage(id, String(body.itemId))?.foreignContentTurn).toBe(true);
    },
    30_000,
  );

  it(
    "没有存活会话、队列空、当前这条就是外来内容 → 新会话路径：runChatSession 入参带 foreignContentTurn（并发首条撞上已在跑的会话时，runner 据此带标志入队）",
    async () => {
      const id = newId();
      h.state.sessionAlive = false;

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(202);
      expect(h.runChatSession).toHaveBeenCalledTimes(1);
      expect(runInputOf().foreignContentTurn).toBe(true);
    },
    30_000,
  );

  it(
    "对照：所有者自己的话起新会话 → runChatSession 入参没有 foreignContentTurn",
    async () => {
      const id = newId();
      h.state.sessionAlive = false;

      const res = await handleChatReplyInject(id, bodyOf("属主自己的话"));

      expect(res.status).toBe(202);
      expect(h.runChatSession).toHaveBeenCalledTimes(1);
      expect(runInputOf()).not.toHaveProperty("foreignContentTurn");
    },
    30_000,
  );
});

describe("新会话路径撞上已在跑的会话（第十四轮评审 P3-2）：首条改入队，预登记的标记不挂在别人的 run 上", () => {
  // 背景：新会话路径在 runChatSession 之前同步预登记标记；并发首条里别路的会话先占了位时，runChatSession 把首条改入队（队列项带 foreignContentTurn、
  // 出队送达时再登记）并同步返回 "already_running"。以前 chat-inject 照常把 token 交出去、标记留在别人（常是属主自己）的 run 上，
  // 要等那一轮收尾才按名清——那一轮的 desktop_* / 写所有者备注 / 建定时被白白限制（fail-safe，但既有的「判受理」之上又叠了一层）。
  // 现在 already_running 时 chat-inject 把预登记的标记回滚掉（与直送路径 send 回 busy 改入队处同一做法）。

  it("runChatSession 回 already_running（首条改入队）→ 照旧 202；起会话前标记已就位（真起得来时 agent 一拿到首条就可能调工具），返回后已回滚，不挂在别人的 run 上", async () => {
    const id = newId();
    h.state.sessionAlive = false;
    const atStart: boolean[] = [];
    h.runChatSession.mockImplementation(async () => {
      atStart.push(isGroupNonOwnerTurnActive(id));
      h.state.sessionAlive = true; // 别路的会话已占位
      return "already_running";
    });

    const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

    expect(res.status, "受理语义不变（首条在队里、出队才送达）").toBe(202);
    expect(await jsonOf(res)).toMatchObject({ ok: true, autoStarted: true });
    expect(atStart, "起会话前标记应已登记（才有回滚可言）").toEqual([true]);
    expect(
      isGroupNonOwnerTurnActive(id),
      "首条没送达、改入队了，预登记的标记却留在别人的 run 上（属主那一轮的 desktop_* / 写所有者备注 / 建定时被白白限制，要等那一轮收尾）",
    ).toBe(false);
  }, 30_000);

  it("对照：runChatSession 真起了会话（回 started）→ 标记交给 run 收尾按名清，返回后仍在（不能因为这条改动把真送达的保护清了）", async () => {
    const id = newId();
    h.state.sessionAlive = false;
    h.runChatSession.mockImplementation(async () => {
      h.state.sessionAlive = true;
      return "started";
    });

    const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

    expect(res.status).toBe(202);
    expect(isGroupNonOwnerTurnActive(id), "真起了会话：标记归 run 收尾清，这里不能提前摘").toBe(true);
  }, 30_000);

  it("already_running 时已有别路的活标记（预登记沿用它、没有自己的 token）→ 那个标记原样还在，不被误清、不被降级", async () => {
    const id = newId();
    h.state.sessionAlive = false;
    beginNonOwnerTurn(id, Date.now(), "all");
    h.runChatSession.mockImplementation(async () => {
      h.state.sessionAlive = true;
      return "already_running";
    });

    const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

    expect(res.status).toBe(202);
    expect(isNonOwnerTurnActive(id), "别路登记的 scope=all 标记归它自己的登记者，已占位那一路的回滚不能清它").toBe(true);
  }, 30_000);

  it("对照：所有者自己的话撞上已在跑的会话（没有外来标志）→ 从头到尾没有标记", async () => {
    const id = newId();
    h.state.sessionAlive = false;
    h.runChatSession.mockImplementation(async () => {
      h.state.sessionAlive = true;
      return "already_running";
    });

    const res = await handleChatReplyInject(id, bodyOf("属主自己的话"));

    expect(res.status).toBe(202);
    expect(isGroupNonOwnerTurnActive(id)).toBe(false);
  }, 30_000);
});

describe("别路沿用了这个标记时，各处回滚都让位（外层 finally / 入队 / already_running，第十六轮 C2 补了 already_settled）；自己重复登记不算被沿用（第十五轮评审 P3-3 F1）", () => {
  // 背景：chat-inject 有三处「没送达」的回滚——外层 finally（!accepted）、enqueueOrReject（直送 busy 改入队）、新会话首条被别路占位（already_running）。
  // 它们此前都是 endNonOwnerTurn 按 token 硬清：登记之后别路 B 的外来内容沿用了这个标记（没有自己的 token）并占住会话时，A 一回滚，B 那一轮就没有保护了。
  // 更糟的一路：直送 send_failed 之后落到新会话路径，registerForeignMark 又 begin 一次，见到自己的活标记把它置 shared——自己沿用自己，
  // 让位版回滚分不清「别人在靠它」和「只是自己重复登记」。现在：回滚改让位版；自己的 token 还活着就不二次登记。
  // 本组用真实 guard + 一个「别路的 run 此刻在跑」的探针（chat-runner 被 mock 了，没有真探针）。
  const OTHER_RUN = "test-other-run";
  let otherRunAlive = false;

  beforeEach(() => {
    otherRunAlive = false;
    __setNonOwnerRunProbeForTest(OTHER_RUN, () => otherRunAlive);
  });
  afterEach(() => {
    __setNonOwnerRunProbeForTest(OTHER_RUN, null);
  });

  /** 直送：send 被调用那一刻记录状态、然后让会话「没了」并回 send_failed（真实链路里 send 抛错已 close）→ 调用方落到新会话路径 */
  const directSendFails = (id: string, during?: () => void): void => {
    h.sendChatMessage.mockImplementation(async () => {
      atSend.group.push(isGroupNonOwnerTurnActive(id));
      atSend.all.push(isNonOwnerTurnActive(id));
      during?.();
      h.state.sessionAlive = false;
      return "send_failed";
    });
  };

  it("直送 send_failed → 新会话路径；别路 B 沿用了标记并占住会话（runChatSession 回 already_running）：A 的回滚让位，B 那一轮仍受限，B 收尾后才清", async () => {
    const id = newId();
    directSendFails(id);
    const atStart: boolean[] = [];
    h.runChatSession.mockImplementation(async () => {
      atStart.push(isGroupNonOwnerTurnActive(id));
      // 别路 B 的外来内容到了：见到活标记、沿用它（没有自己的 token）、并占住会话
      expect(beginForeignContentMidRun(id), "B 沿用 A 的标记，不新建").toBeUndefined();
      otherRunAlive = true;
      h.state.sessionAlive = true;
      return "already_running";
    });

    const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

    expect(res.status, "A 的首条改入队，受理语义不变").toBe(202);
    expect(atSend.group, "前置：A 直送路径在 send 之前登记过").toEqual([true]);
    expect(atStart, "前置：A 落到新会话路径时标记仍在（不是被清了又重登）").toEqual([true]);
    expect(
      isGroupNonOwnerTurnActive(id),
      "A 按 token 硬清把 B 沿用的标记清了——B 那一轮的 desktop_* / 写所有者备注 / 建定时失去保护",
    ).toBe(true);

    // B 那一轮收尾（run 收尾按名清）之后才清掉
    otherRunAlive = false;
    endMidRunForeignContent(id);
    expect(isGroupNonOwnerTurnActive(id)).toBe(false);
  }, 30_000);

  it("对照：同一路径、没有别路沿用，只是别人的 run 此刻在跑（常是属主自己那一轮）→ A 自己的标记照清；自己重复登记不算被沿用，否则会白白挂到别人那一轮收尾", async () => {
    const id = newId();
    directSendFails(id);
    h.runChatSession.mockImplementation(async () => {
      otherRunAlive = true; // 别路的会话占了位（没人沿用 A 的标记）
      h.state.sessionAlive = true;
      return "already_running";
    });

    const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

    expect(res.status).toBe(202);
    expect(atSend.group, "前置：直送路径登记过").toEqual([true]);
    // 修复前：新会话路径的第二次 registerForeignMark 把 A 自己的标记置成 shared（自己沿用自己）→ 让位版也会让位、标记挂到别人那一轮
    expect(
      isGroupNonOwnerTurnActive(id),
      "A 自己重复登记被当成「被沿用」：没人靠这个标记，却挂到别人（常是属主自己）的那一轮收尾才清，白白限制它",
    ).toBe(false);
  }, 30_000);

  it("直送 busy → 改入队：别路 B 在 send 期间沿用了标记、此刻有 run 在跑 → 入队处的回滚让位；没有别路沿用则照清（原有行为）", async () => {
    const id = newId();
    h.state.sendResult = "busy";
    h.sendChatMessage.mockImplementation(async () => {
      atSend.group.push(isGroupNonOwnerTurnActive(id));
      expect(beginForeignContentMidRun(id), "B 沿用 A 的标记").toBeUndefined();
      otherRunAlive = true; // 会话在跑（所以 busy）
      return "busy";
    });

    const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

    expect(res.status).toBe(202);
    expect(await jsonOf(res)).toMatchObject({ ok: true, queued: true });
    expect(atSend.group).toEqual([true]);
    expect(isGroupNonOwnerTurnActive(id), "入队处按 token 硬清、把 B 沿用的标记清了").toBe(true);

    otherRunAlive = false;
    endMidRunForeignContent(id);
    expect(isGroupNonOwnerTurnActive(id)).toBe(false);
  }, 30_000);

  it("外层 finally（没送出去）：别路 B 在 send 期间沿用了标记、此刻有 run 在跑，随后 send 抛错 → 回滚让位，异常原样冒出去", async () => {
    const id = newId();
    h.sendChatMessage.mockImplementation(async () => {
      atSend.group.push(isGroupNonOwnerTurnActive(id));
      expect(beginForeignContentMidRun(id), "B 沿用 A 的标记").toBeUndefined();
      otherRunAlive = true;
      throw new Error("boom（测试注入）");
    });

    await expect(handleChatReplyInject(id, bodyOf(), FOREIGN)).rejects.toThrow("boom");

    expect(atSend.group).toEqual([true]);
    expect(isGroupNonOwnerTurnActive(id), "外层 finally 按 token 硬清、把 B 沿用的标记清了").toBe(true);

    otherRunAlive = false;
    endMidRunForeignContent(id);
    expect(isGroupNonOwnerTurnActive(id)).toBe(false);
  }, 30_000);

  it("对照：外层 finally 没有别路沿用时照常清（send 抛错 / 入口 409 的回滚语义不变）", async () => {
    const id = newId();
    otherRunAlive = true; // 有 run 在跑，但没人沿用 A 的标记
    h.sendChatMessage.mockImplementation(async () => {
      throw new Error("boom（测试注入）");
    });

    await expect(handleChatReplyInject(id, bodyOf(), FOREIGN)).rejects.toThrow("boom");

    expect(isGroupNonOwnerTurnActive(id), "没人沿用：回滚应照清，不能因为「别的 run 在跑」就一律让位").toBe(false);
  }, 30_000);

  it("自己的标记被清掉后（上一轮收尾按名清了）新会话路径会重新登记——不二次登记只在自己的 token 还活着时", async () => {
    const id = newId();
    directSendFails(id, () => endMidRunForeignContent(id)); // send 期间标记被「上一轮收尾」清了
    const atStart: boolean[] = [];
    h.runChatSession.mockImplementation(async () => {
      atStart.push(isGroupNonOwnerTurnActive(id));
      h.state.sessionAlive = true;
      return "started";
    });

    const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

    expect(res.status).toBe(202);
    expect(atSend.group, "前置：直送路径登记过").toEqual([true]);
    expect(atStart, "自己的标记被清了：起新会话前必须重新登记（登记点紧贴送达的目的）").toEqual([true]);
    expect(isGroupNonOwnerTurnActive(id), "真起了会话：标记归 run 收尾清").toBe(true);
  }, 30_000);

  // 第十六轮评审 P3-C2：enqueueOrReject 里 `already_settled`（同 id 已被别处结算）的早返回是 200，发生在入队处的回滚之前、且 200 让外层 finally 以为已受理（accepted=true）——
  // 直送路径预登记的标记没人回滚。入口的 claim 已经会拦住已结算的 id，所以只剩「claim 之后、入队之前」被别处（stop / 清队）结算的竞态窗口，基本不可达；补上是为了让回滚的清单完整（至少四处，见 chat-inject.ts 里 registerForeignMark 的注释；第十七轮评审 N3 订正此前「三处」的数法）。
  /** 在 claim 之后的插桩点里把这条 id 结算掉，模拟「claim 之后、入队之前」别处先结算了它（claim 自己会拦住已结算的 id） */
  const settleAfterClaim = (id: string, itemId: string): void => {
    vi.mocked(failpoint).mockImplementation(async (name: string) => {
      if (name === "chatReply.afterClaim") settleMessageHandedOff(id, itemId);
    });
  };
  afterEach(() => {
    vi.mocked(failpoint).mockImplementation(async () => undefined);
  });

  it("直送 busy → 改入队时同 id 已被别处结算（already_settled）：照旧 200 终态 JSON，但预登记的标记要回滚，不能挂到属主此刻那一轮上（第十六轮评审 P3-C2）", async () => {
    const id = newId();
    const itemId = "c2-settled-1";
    h.state.sendResult = "busy";
    settleAfterClaim(id, itemId);

    const res = await handleChatReplyInject(id, { ...bodyOf(), clientItemId: itemId }, FOREIGN);

    expect(res.status, "already_settled 仍是 200 终态 JSON（受理语义不变）").toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, settled: true, itemId });
    expect(h.sendChatMessage, "前置：走的是直送 → busy → 改入队这条路（才有预登记的标记）").toHaveBeenCalledTimes(1);
    expect(atSend.group, "前置：直送路径在 send 之前登记过标记").toEqual([true]);
    expect(getChatQueueCount(id), "前置：already_settled 不 append 入队").toBe(0);
    expect(
      isGroupNonOwnerTurnActive(id),
      "200 的早返回绕过了入队处的回滚：这条消息没送达（也没入队），预登记的标记却留着，去限制属主此刻那一轮的 desktop_* / 写所有者备注 / 建定时",
    ).toBe(false);
  }, 30_000);

  // 第十七轮评审 N4：这条只防「把让位版改回按 token / 按名硬清」（变异 C2-b 红）。删掉 already_settled 那一行回滚它**不会**红——
  // 沿用者在跑时回滚本来就是 no-op（rollbackForeignContentMidRun：shared 且 run 活着就 return），标记照样留着；「有没有回滚这一行」由上一条（没人沿用 → 预登记的标记被回滚，变异 C2-a 红）钉着。
  // （实测：只删那一行，上一条红、这一条仍绿。）
  it("同一出口：别路 B 在 send 期间沿用了标记、此刻有 run 在跑 → already_settled 的回滚同样让位（只钉「让位版而不是硬清」；有没有回滚这一行由上一条钉）", async () => {
    const id = newId();
    const itemId = "c2-settled-2";
    h.state.sendResult = "busy";
    h.sendChatMessage.mockImplementation(async () => {
      atSend.group.push(isGroupNonOwnerTurnActive(id));
      expect(beginForeignContentMidRun(id), "B 沿用 A 的标记").toBeUndefined();
      otherRunAlive = true;
      return "busy";
    });
    settleAfterClaim(id, itemId);

    const res = await handleChatReplyInject(id, { ...bodyOf(), clientItemId: itemId }, FOREIGN);

    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, settled: true, itemId });
    expect(atSend.group).toEqual([true]);
    expect(isGroupNonOwnerTurnActive(id), "already_settled 的回滚按 token 硬清、把 B 沿用的标记清了").toBe(true);

    otherRunAlive = false;
    endMidRunForeignContent(id);
    expect(isGroupNonOwnerTurnActive(id)).toBe(false);
  }, 30_000);
});

describe("已有活标记：不新建、不降级，回滚时也不误清", () => {
  it(
    "已有 scope=all 的活标记 + 外来内容忙时入队（send 回 busy → 202）→ 那个标记原样还在（没被降级成 desktop、也没被入队处的回滚清掉）",
    async () => {
      const id = newId();
      beginNonOwnerTurn(id, Date.now(), "all");
      h.state.sendResult = "busy";

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(202);
      expect(getChatQueueCount(id)).toBe(1);
      expect(isNonOwnerTurnActive(id), "原有的系统工具硬拒标记不该被回滚误清 / 降级").toBe(true);
    },
    30_000,
  );

  it(
    "已有 scope=all 的活标记 + 外来内容送出去 → 标记仍是 scope=all（不被中途标记覆盖降级）",
    async () => {
      const id = newId();
      beginNonOwnerTurn(id, Date.now(), "all");

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(200);
      expect(atSend.all).toEqual([true]);
      expect(isNonOwnerTurnActive(id)).toBe(true);
      // run 收尾只清「中途补登」那种；原有的 all 标记归它自己的登记者
      endMidRunForeignContent(id);
      expect(isNonOwnerTurnActive(id)).toBe(true);
    },
    30_000,
  );
});

describe("标记竞态（第四轮评审）：预处理期间上一轮 run 收尾，不能把标记按名清掉", () => {
  // 发送前快照 / 起新会话前的快照只在 task 绑了仓库时才打（tryCaptureCheckpoint 无仓库直接返回）。
  // getChatRunRepoPaths 在这里恒返回 null（= 会话没记过路径），不会因为仓库变了触发懒重启、偏离热路径
  const useRepoTask = (): void => {
    h.getTask.mockImplementation(
      async (taskId: string) =>
        ({ ...makeTask(taskId), repoPaths: ["/tmp/fake-repo-for-race-test"] }) as unknown as Task,
    );
  };
  /**
   * 快照（要扫仓库 git 状态，大仓 1–10 秒）期间「上一轮 run 收尾」：consumeChatRun 的 finally 里
   * endMidRunForeignContent 按名清 midRun 标记、不看归属。返回数组记录每次快照那一刻标记是否已登记。
   */
  const lastRunFinishesDuringSnapshot = (id: string): boolean[] => {
    const markedDuringSnapshot: boolean[] = [];
    h.captureChatCheckpoint.mockImplementation(async () => {
      markedDuringSnapshot.push(isGroupNonOwnerTurnActive(id));
      endMidRunForeignContent(id);
      return { ok: false, repoSnapshots: [], elapsedMsByRepo: {}, warnings: [] };
    });
    return markedDuringSnapshot;
  };

  it(
    "热路径：发送前快照期间上一轮收尾把标记清了 → sendChatMessage 被调用那一刻标记仍在（登记紧贴送达）",
    async () => {
      const id = newId();
      useRepoTask();
      lastRunFinishesDuringSnapshot(id);

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(200);
      expect(h.captureChatCheckpoint, "快照没被调用——这条用例没覆盖到预处理窗口").toHaveBeenCalledTimes(1);
      expect(atSend.group, "快照期间上一轮的收尾把标记清了，这条消息就在无标记状态下送达了").toEqual([true]);
      expect(isGroupNonOwnerTurnActive(id), "送出去的标记应留给 run 收尾清").toBe(true);
    },
    30_000,
  );

  it(
    "新会话路径：起会话前快照期间上一轮收尾把标记清了 → runChatSession 被调用那一刻标记仍在",
    async () => {
      const id = newId();
      useRepoTask();
      lastRunFinishesDuringSnapshot(id);
      h.state.sessionAlive = false;
      const atStart: boolean[] = [];
      h.runChatSession.mockImplementation(async () => {
        atStart.push(isGroupNonOwnerTurnActive(id));
        h.state.sessionAlive = true;
      });

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(202);
      expect(h.captureChatCheckpoint, "快照没被调用——这条用例没覆盖到预处理窗口").toHaveBeenCalledTimes(1);
      expect(atStart, "新会话带着首条消息起来，快照期间被清的标记必须在起会话前重新就位").toEqual([true]);
      expect(isGroupNonOwnerTurnActive(id)).toBe(true);
    },
    30_000,
  );

  it(
    "预处理期间标记还没登记：快照那一刻看不到标记（入口提前登记既留下被清的窗口、又会把上一轮自己的电脑操作误拒）",
    async () => {
      const id = newId();
      useRepoTask();
      const markedDuringSnapshot = lastRunFinishesDuringSnapshot(id);

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(200);
      expect(markedDuringSnapshot).toEqual([false]);
    },
    30_000,
  );

  it(
    "快照之后、送达之前发现忙（send 回 busy → 改入队 202）：标记在送达点登记过、入队处回滚干净（不因登记点后移而残留）",
    async () => {
      const id = newId();
      useRepoTask();
      lastRunFinishesDuringSnapshot(id);
      h.state.sendResult = "busy";

      const res = await handleChatReplyInject(id, bodyOf(), FOREIGN);

      expect(res.status).toBe(202);
      expect(atSend.group, "send 被调用那一刻标记应已登记（才有回滚可言）").toEqual([true]);
      expect(isGroupNonOwnerTurnActive(id), "改入队后预登记的标记残留").toBe(false);
      expect(getChatQueueCount(id), "改入队：这条没丢，排在队里等出队再登记").toBe(1);
    },
    30_000,
  );
});

describe("对照：不带 foreignContentTurn 的路径一律不变", () => {
  it(
    "所有者自己的消息：send 那一刻没有任何标记；会话忙时仍入队 202（排队体验不变）",
    async () => {
      const id = newId();

      const ok = await handleChatReplyInject(id, bodyOf("自己说的话"));
      expect(ok.status).toBe(200);
      expect(atSend.group).toEqual([false]);
      expect(isGroupNonOwnerTurnActive(id)).toBe(false);

      h.state.sendResult = "busy";
      const queued = await handleChatReplyInject(id, bodyOf("再补一句"));
      expect(queued.status).toBe(202);
      expect(await jsonOf(queued)).toMatchObject({ ok: true, queued: true });
      expect(getChatQueueCount(id)).toBe(1);
      expect(isGroupNonOwnerTurnActive(id)).toBe(false);
    },
    30_000,
  );

  it(
    "foreignContentTurn 显式为 false：同样没有标记、同样可入队",
    async () => {
      const id = newId();
      h.state.sendResult = "busy";

      const res = await handleChatReplyInject(id, bodyOf(), { foreignContentTurn: false });

      expect(res.status).toBe(202);
      expect(getChatQueueCount(id)).toBe(1);
      const queuedItem = peekQueuedChatMessage(id, String((await jsonOf(res)).itemId));
      expect(queuedItem, "前置：该条应在队里").not.toBeNull();
      expect(queuedItem?.foreignContentTurn, "普通消息的队列项不该带外来标志（出队时会据此登记标记、误限制属主）").toBeUndefined();
      expect(atSend.group).toEqual([false]);
      expect(isGroupNonOwnerTurnActive(id)).toBe(false);
    },
    30_000,
  );
});
