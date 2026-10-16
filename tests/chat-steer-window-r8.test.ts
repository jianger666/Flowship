/**
 * 第八轮 L5-01 / L5-03：「立即发送」steer 的 take → steerChatRun 空窗、以及 cancelled 兜底站点
 *
 * L5-01 缺陷（第七轮遗留）：
 *   steerQueuedMessage 里 take 之后还要 await 冲半截回复 / 落 user_reply / 检查点，steerChatRun 的 inflightSteers 登记
 *   要等这些都做完才发生。这段空窗里系统关闭会话时：
 *     - error 收尾（清队）：这条既不在队里、也不在 inflightSteers → 被记 failed(stopped)、不进「N 条未送达」提示；
 *     - restart 取消收尾（清队）→ failed(stopped)；
 *     - forceClear / 重连摘表（不清队）→ steer 起手读到「没有会话」降成 followup → failed(no_session)；
 *   与第六轮终态表（摘表时 steer 在飞：重排 / failed(error)）不一致。
 *   修法：① take 之后立刻提前登记 inflightSteers（registerInflightSteer）；② 系统关闭标记带每 task 的单调序号 seq，
 *   take 时记下当时的序号，之后序号变大 = take 之后发生过系统关闭，按「系统换掉了会话」处理。
 *
 * L5-03：finalizeChatRunSafely 的 cancelled + restart 兜底站点是否传「清队前的 generation」——
 *   之前没有任何用例走到这个站点的传参（漏传会把该重排的消息记成 stopped）。
 *
 * 测试方式：真 chat-runner + 真 chat-queue-send-now + 假 SDK；空窗用「可控闸门的 persistReply」撑开
 * （其余 steer 依赖全是真函数）。并行隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { SendNowDeps } from "@/lib/server/chat-queue-send-now";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-steer-window-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

/** 开关：为 true 时 setTaskRunStatusIfRunOwner 一律抛 EIO（模拟收尾落盘故障，走 finalizeChatRunSafely 兜底） */
const failure = { statusWrite: false };
vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    setTaskRunStatusIfRunOwner: (
      ...args: Parameters<typeof actual.setTaskRunStatusIfRunOwner>
    ) => {
      if (failure.statusWrite) return Promise.reject(new Error("EIO: disk gone"));
      return actual.setTaskRunStatusIfRunOwner(...args);
    },
  };
});

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const rn = await import("@/lib/server/chat-runner");
const q = await import("@/lib/server/chat-queue");
const { sendQueuedChatMessageNow } = await import(
  "@/lib/server/chat-queue-send-now"
);
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-steer-window-r8 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000012000_steer_window";
const AGENT_ID = "agent_fake_steer_window";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};
const STEER_TEXT = "插话：换个思路 STEER-R8";

let itemSeq = 0;
let ITEM_ID = "cq_steer_window_0";

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `steer window ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;
const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

/** 本用例起的活 run：afterEach 统一放行它们的流 */
const liveRuns: Array<{ failStream: () => void }> = [];

/** 在飞的一轮：流等 failStream() 后抛「不可重试」错（走 error 收尾、不进自动重连）；steer 与 run.wait 都挂起 */
const makeLiveRun = () => {
  let failStream!: () => void;
  const gate = new Promise<void>((r) => {
    failStream = r;
  });
  const steer = vi.fn(
    () =>
      new Promise<string>(() => {
        /* 永不落定：只能靠摘表信号 */
      }),
  );
  const run = {
    stream: async function* (): AsyncGenerator<never> {
      await gate;
      throw new Error("invalid api key");
    },
    wait: () => new Promise<never>(() => {}),
    cancel: vi.fn().mockResolvedValue(undefined),
    steer,
  };
  liveRuns.push({ failStream });
  return { run, steer, close: vi.fn(), failStream };
};

const startLive = async () => {
  const live = makeLiveRun();
  mockResume.mockResolvedValueOnce({
    agentId: AGENT_ID,
    close: live.close,
    send: vi.fn().mockResolvedValue(live.run),
  });
  const task = asTask(makeMeta(TASK_ID));
  expect(await rn.resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await rn.sendChatMessage(task, "先干这个")).toBe("sent");
  expect(rn.isChatRunActive(TASK_ID)).toBe(true);
  return live;
};

const enqueue = (itemId: string, text: string): void => {
  expect(
    q.enqueueChatMessage(TASK_ID, {
      itemId,
      agentText: text,
      displayText: text,
      enqueuedAt: Date.now(),
    }),
  ).toMatchObject({ ok: true });
};

type PersistResult =
  | { ok: true }
  | { ok: false; reason: "persist_failed" | "task_gone" };

/**
 * 与默认依赖逐项对齐、只把 persistReply 换成可控的版本（撑开 take → steerChatRun 的空窗）：
 * canSteer / flushAssistant / registerInflight / steer / isRunActive / hasSession / flushQueue 全是真函数。
 */
const makeDeps = (persist: () => Promise<PersistResult>): SendNowDeps => ({
  take: q.takeQueuedChatMessage,
  stop: () => {
    throw new Error("stop 不应被调用：这些用例都走 steer 路径");
  },
  start: (() => {
    throw new Error("start 不应被调用：这些用例都走 steer 路径");
  }) as unknown as SendNowDeps["start"],
  getTask,
  steer: {
    canSteer: rn.canSteerChatRun,
    flushAssistant: rn.flushChatAssistantBuffer,
    persistReply: async (_task, head) => {
      const r = await persist();
      if (r.ok) q.markMessagePersisted(TASK_ID, head.itemId);
      return r;
    },
    registerInflight: rn.registerInflightSteer,
    steer: rn.steerChatRun,
    isRunActive: rn.isChatRunActive,
    hasSession: rn.hasChatSession,
    flushQueue: rn.flushChatQueue,
  },
});

/**
 * 撑开空窗：排一条消息、点「立即发送」→ 它已被 take（队里没了），但 persistReply 卡在闸门上、steerChatRun 还没起手。
 * 返回 open()：放行 persistReply；resP：整个「立即发送」调用（放行后才 resolve）。
 */
const openWindow = async (
  persist: () => Promise<PersistResult> = async () => ({ ok: true }),
) => {
  const live = await startLive();
  enqueue(ITEM_ID, STEER_TEXT);
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let entered = false;
  const deps = makeDeps(async () => {
    entered = true;
    await gate;
    return persist();
  });
  const resP = sendQueuedChatMessageNow(TASK_ID, ITEM_ID, BOOT, deps);
  await vi.waitFor(() => expect(entered).toBe(true), {
    timeout: 5_000,
    interval: 10,
  });
  // 已 take、还没有任何人握着它：不在队里
  expect(q.getChatQueueCount(TASK_ID)).toBe(0);
  // steerChatRun 还没起手：假 SDK 的 steer 没被调过
  expect(live.steer).not.toHaveBeenCalled();
  return { live, open, resP };
};

/** 等会话被摘 */
const waitSessionGone = (): Promise<void> =>
  vi.waitFor(() => expect(rn.hasChatSession(TASK_ID)).toBe(false), {
    timeout: 5_000,
    interval: 20,
  });

/** 等「这条消息有了去处」：台账终态或回到了队列；到点没有就按悬空返回（红灯是断言失败而不是用例超时） */
const settledAfter = async (): Promise<{
  outcome: string | undefined;
  queued: number;
}> => {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const outcome = q.findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome;
    const queued = q.getChatQueueCount(TASK_ID);
    if (outcome !== undefined || queued > 0 || Date.now() > deadline) {
      await new Promise((r) => setTimeout(r, 60));
      return {
        outcome: q.findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome,
        queued: q.getChatQueueCount(TASK_ID),
      };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};

const droppedNotices = async (): Promise<TaskEvent[]> =>
  (await readEvents(TASK_ID)).filter(
    (e) => e.kind === "info" && e.text.includes("条排队消息未送达"),
  );

beforeEach(async () => {
  failure.statusWrite = false;
  itemSeq += 1;
  ITEM_ID = `cq_steer_window_${itemSeq}`;
  mockResume.mockReset();
  q.clearChatQueue(TASK_ID);
  rn.closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 惰性触发：在任务还是 idle 时先触发一次
  await getTask(TASK_ID);
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({
      apiKey: "server-key",
      defaultModel: { id: "gpt-test", params: [] },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  failure.statusWrite = false;
  for (const l of liveRuns.splice(0)) l.failStream();
  q.clearChatQueue(TASK_ID);
  rn.closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 60));
});

afterAll(async () => {
  rn.closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("L5-01：take → steerChatRun 空窗里系统关闭会话", () => {
  it("forceClear（不清队）：重排回队首，不记 failed(no_session)", async () => {
    const { live, open, resP } = await openWindow();

    rn.forceClearChatRun(TASK_ID);
    open();
    expect((await resP).status).toBe(202);

    const s = await settledAfter();
    expect(s.outcome).toBeUndefined();
    expect(s.queued).toBe(1);
    // 会话早就没了，steer 从未真正递给 SDK
    expect(live.steer).not.toHaveBeenCalled();
  }, 15_000);

  it("restart（cancelChatRun reason=restart，取消收尾自己清队）：重排回队首，不记 failed(stopped)", async () => {
    const { live, open, resP } = await openWindow();
    live.run.cancel.mockImplementation(async () => live.failStream());

    expect(rn.cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);
    await waitSessionGone();
    open();
    expect((await resP).status).toBe(202);

    const s = await settledAfter();
    expect(s.outcome).toBeUndefined();
    expect(s.queued).toBe(1);
  }, 15_000);

  it("error 收尾：空窗里这条就被并入失败（failed(error)）与「N 条未送达」提示，放行后不再被重排", async () => {
    const { live, open, resP } = await openWindow();

    live.failStream(); // 不可重试错 → error 收尾（清队 + 摘表）
    await waitSessionGone();
    // 不用等 persistReply 放行：提前登记使 error 收尾当场就看得见它
    await vi.waitFor(
      () =>
        expect(q.findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome).toBe("error"),
      { timeout: 5_000, interval: 20 },
    );

    open();
    expect((await resP).status).toBe(202);

    const s = await settledAfter();
    expect(s.outcome).toBe("error");
    expect(s.queued).toBe(0);
    await vi.waitFor(
      async () => expect(await droppedNotices()).toHaveLength(1),
      { timeout: 5_000, interval: 30 },
    );
    const notice = (await droppedNotices())[0]!;
    if (notice.kind !== "info") throw new Error("unreachable");
    expect(notice.text).toContain("本轮出错，1 条排队消息未送达");
    expect(notice.text).toContain("STEER-R8");
  }, 15_000);

  it("error 收尾并入失败之后 persistReply 又失败（persist_failed）：已是终态，不再塞回队首、不再记一次终态", async () => {
    const { live, open, resP } = await openWindow(async () => ({
      ok: false,
      reason: "persist_failed",
    }));

    live.failStream();
    await waitSessionGone();
    await vi.waitFor(
      () =>
        expect(q.findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome).toBe("error"),
      { timeout: 5_000, interval: 20 },
    );

    open();
    expect((await resP).status).toBe(500);

    // 已是 failed(error)：不能又被塞回队首（那样会被 flush 再送一遍）
    expect(q.getChatQueueCount(TASK_ID)).toBe(0);
    expect(q.findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome).toBe("error");
  }, 15_000);

  it("用户停止（cancelChatRun 不带 reason）：仍记 failed(stopped)，不重排（回归守卫）", async () => {
    const { live, open, resP } = await openWindow();
    live.run.cancel.mockImplementation(async () => live.failStream());

    expect(rn.cancelChatRun(TASK_ID)).toBe(true);
    await waitSessionGone();
    open();
    expect((await resP).status).toBe(202);

    const s = await settledAfter();
    expect(s.outcome).toBe("stopped");
    expect(s.queued).toBe(0);
  }, 15_000);

  it("用户先清了队、系统随后强清会话：仍记 failed(stopped)，用户的意图不被系统关闭吸收", async () => {
    const { open, resP } = await openWindow();

    // 用户停止的清队（stop-task：failQueuedItems(stopped)，generation + 1）先到、系统强清后到
    q.failQueuedItems(TASK_ID, { reason: "stopped" });
    rn.forceClearChatRun(TASK_ID);
    open();
    expect((await resP).status).toBe(202);

    const s = await settledAfter();
    expect(s.outcome).toBe("stopped");
    expect(s.queued).toBe(0);
  }, 15_000);

  it("没有任何关闭：空窗正常走完，steer 递给 SDK（回归守卫：提前登记不影响正常路径）", async () => {
    const { live, open, resP } = await openWindow();
    // 递给 SDK 后立刻被收下
    (live.steer as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve("complete_delivered"),
    );

    open();
    expect((await resP).status).toBe(202);

    await vi.waitFor(() => expect(q.isMessageHandedOff(TASK_ID, ITEM_ID)).toBe(true), {
      timeout: 5_000,
      interval: 20,
    });
    expect(live.steer).toHaveBeenCalledTimes(1);
    expect(q.findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome).toBe("delivered");
  }, 15_000);

  // 回归守卫，不单独证明「注销」：failQueuedItems 对终态条目本就跳过，所以即使残条没注销这条也是绿的
  //（撤掉 finally 里的注销，本文件没有用例会变红——它只是卫生：残条随会话记录一起被丢弃）。
  it("已送达的消息不会被之后的 error 收尾误判失败（回归守卫）", async () => {
    const { live, open, resP } = await openWindow();
    (live.steer as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve("complete_delivered"),
    );
    open();
    expect((await resP).status).toBe(202);
    await vi.waitFor(() => expect(q.isMessageHandedOff(TASK_ID, ITEM_ID)).toBe(true), {
      timeout: 5_000,
      interval: 20,
    });

    live.failStream(); // 之后 run 出错收尾
    await waitSessionGone();
    await new Promise((r) => setTimeout(r, 150));

    expect(q.findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome).toBe("delivered");
    expect(await droppedNotices()).toHaveLength(0);
  }, 15_000);

  it("persistReply 抛错：提前登记被注销（不在会话记录上留残条），错误照常上抛", async () => {
    const { live, open, resP } = await openWindow(async () => {
      throw new Error("检查点落盘炸了");
    });
    // 先挂上拒绝处理，避免放行前的未处理拒绝告警
    const settled = resP.then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    open();
    expect(await settled).toContain("检查点落盘炸了");

    // 残条若还留着，随后的 error 收尾会把这条已经「丢了」的消息算进未送达提示
    live.failStream();
    await waitSessionGone();
    await new Promise((r) => setTimeout(r, 150));
    expect(await droppedNotices()).toHaveLength(0);
  }, 15_000);
});

describe("L5-03：finalizeChatRunSafely 的 cancelled + restart 兜底站点", () => {
  it("取消收尾写状态抛 EIO → 进入兜底：在飞的 steer 仍被重排回队首（兜底站点传了清队前的 generation）", async () => {
    const live = await startLive();
    live.run.cancel.mockImplementation(async () => live.failStream());

    enqueue(ITEM_ID, STEER_TEXT);
    const res = await sendQueuedChatMessageNow(TASK_ID, ITEM_ID, BOOT);
    expect(res.status).toBe(202);
    expect(live.steer).toHaveBeenCalledTimes(1);
    expect(q.getChatQueueCount(TASK_ID)).toBe(0);

    // 从此刻起收尾写状态一律抛 EIO：cancelled 收尾自己抛错 → finalizeChatRunSafely 兜底（清队 + 摘表）
    failure.statusWrite = true;
    expect(rn.cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);

    await waitSessionGone();
    const s = await settledAfter();
    // 兜底站点漏传清队前的 generation 时：系统自己的这次清队被误当成用户介入 → failed(stopped)、队里没有
    expect(s.outcome).toBeUndefined();
    expect(s.queued).toBe(1);
  }, 15_000);
});
