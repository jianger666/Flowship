/**
 * 第六轮 必修 1：「立即发送」steer 在飞时会话被摘——按**关闭原因**决定条目的最终终态
 *
 * 背景（F4-01 第五轮没修全）：
 *   cancelled / error 两条收尾都是「先 failQueuedItems（清队，generation + 1）→ 后 closeChatSession（打 replaced 标）」，
 *   两步在同一个同步段、中间没有 await。在飞的 steer 随后返回 replaced，调用方 requeueAsFollowup 看到
 *   generation 变了，直接记 failed(stopped)——把「系统清的队」当成了「用户停止」。
 *   第五轮的测试（chat-steer-nonuser-close）只断言 steerChatRun 的返回值，所以绿灯但没修好；
 *   这里改成：真实 chat-runner 收尾 + 真实 chat-queue-send-now，最终断言「条目在队列 / 台账里的终态」。
 *
 * 拍板的语义（按关闭原因）：
 *   - reconnect          重排（至少送一次）——另见 chat-steer-reconnect-replaced.test.ts（真退避、端到端送达）
 *   - forceClear（restart 的强清）  重排
 *   - restart（cancelChatRun reason=restart 的取消收尾）  重排。⚠ 取消收尾自己会清队 → generation 变了，
 *     不能再靠「generation 变了 = 用户停了」推断
 *   - error              与队列里其它消息同命运：判失败，原因记 `error`（不是 stopped），
 *                        并入「本轮出错，N 条排队消息未送达」提示（含 meta.droppedTexts）
 *   - 用户停止 / 回退    仍记 stopped
 *
 * steer 形态：hang（steer 与 run.wait 都永远挂起——最坏形态，只能靠摘表信号落定）与
 * reject-on-close（关 agent 才把 steer 拒掉）都覆盖。
 * 并行隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import。
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

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-steer-reason-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const { readEvents, taskDir, withTaskLock, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const {
  clearChatQueue,
  enqueueChatMessage,
  failQueuedItems,
  findRecentSettledEntry,
  getChatQueueCount,
  isMessageHandedOff,
} = await import("@/lib/server/chat-queue");
const { sendQueuedChatMessageNow } = await import(
  "@/lib/server/chat-queue-send-now"
);
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-steer-requeue-by-reason DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

/**
 * 每个用例一个独立的任务 id（beforeEach 里换）：上一个用例的收尾链（`finalizeReconnectGaveUp` → 条件写 runStatus → 写事件）
 * 是 fire-and-forget 的，可能在用例结束后才落盘；以前所有用例共用一个 id、beforeEach / afterAll 又 `rm` 任务目录，
 * 收尾链的 `rename meta.json` 一旦撞上 `rm` 就 ENOENT → 未处理的 Promise rejection → vitest 退出码 1（机器负载高时约 15% 复现）。
 * 换 id 后上一个用例的迟到写入落在它自己的目录里、与下一个用例无关；产品代码不动——删任务走 withTaskLock，
 * 锁内不会有目录被抽走，这里的竞态只来自测试自己的 `rm`。
 */
let TASK_ID = "t_1700000011000_steer_reason_0";
const AGENT_ID = "agent_fake_steer_reason";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};
const STEER_TEXT = "插话：换个思路 STEER-R6";
const OTHER_TEXT = "排队的另一句 QUEUED-R6";

let itemSeq = 0;
let ITEM_ID = "cq_steer_reason_0";
let OTHER_ID = "cq_steer_reason_other_0";

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `steer reason ${id}`,
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

type SteerMode = "hang" | "reject-on-close";

/** 本用例起的活 run：afterEach 统一放行它们的流，别把挂着的 consume 链留给后面的用例 */
const liveRuns: Array<{ failStream: () => void }> = [];

/**
 * 在飞的一轮：流等 failStream() 后抛「不可重试」错（走 error 收尾、不进自动重连的退避）；
 * run.wait 永远挂起；steerMode=reject-on-close 时关 agent 才把 steer 拒掉。
 * 与 chat-steer-nonuser-close.test.ts 同形。
 */
const makeLiveRun = (steerMode: SteerMode) => {
  let failStream!: () => void;
  const gate = new Promise<void>((r) => {
    failStream = r;
  });
  let rejectSteer: (e: Error) => void = () => {};
  const steer = vi.fn(
    () =>
      new Promise<never>((_, reject) => {
        rejectSteer = reject;
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
  const close = vi.fn(() => {
    if (steerMode === "reject-on-close") rejectSteer(new Error("agent closed"));
  });
  liveRuns.push({ failStream });
  return { run, steer, close, failStream };
};

const startLive = async (steerMode: SteerMode) => {
  const live = makeLiveRun(steerMode);
  mockResume.mockResolvedValueOnce({
    agentId: AGENT_ID,
    close: live.close,
    send: vi.fn().mockResolvedValue(live.run),
  });
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, "先干这个")).toBe("sent");
  expect(isChatRunActive(TASK_ID)).toBe(true);
  return live;
};

const enqueue = (itemId: string, text: string): void => {
  expect(
    enqueueChatMessage(TASK_ID, {
      itemId,
      agentText: text,
      displayText: text,
      enqueuedAt: Date.now(),
    }),
  ).toMatchObject({ ok: true });
};

/** 排一条、点「立即发送」→ steer 在飞（挂着没落定）；othersInQueue = 此前已在队里的别的消息数 */
const steerOne = async (
  live: ReturnType<typeof makeLiveRun>,
  othersInQueue = 0,
): Promise<void> => {
  enqueue(ITEM_ID, STEER_TEXT);
  const res = await sendQueuedChatMessageNow(TASK_ID, ITEM_ID, BOOT);
  expect(res.status).toBe(202);
  expect(((await res.json()) as { steered?: boolean }).steered).toBe(true);
  expect(live.steer).toHaveBeenCalledTimes(1);
  // steer 取走的只是这一条：别的排队消息原样留在队里
  expect(getChatQueueCount(TASK_ID)).toBe(othersInQueue);
};

/**
 * 等「会话已摘 + steer 条目有了去处」：要么落了台账终态、要么回到了队列。
 * 到点还没有去处就按「悬空」返回——让红灯是断言失败而不是用例超时。
 */
const settledState = async (
  itemId: string,
): Promise<{ outcome: string | undefined; queued: number }> => {
  await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), {
    timeout: 5_000,
    interval: 20,
  });
  const deadline = Date.now() + 3_000;
  for (;;) {
    const outcome = findRecentSettledEntry(TASK_ID, itemId)?.outcome;
    const queued = getChatQueueCount(TASK_ID);
    if (outcome !== undefined || queued > 0 || Date.now() > deadline) {
      // 再让出几个 tick：避免恰好卡在「刚入队、台账还没写」的中间态
      await new Promise((r) => setTimeout(r, 60));
      return {
        outcome: findRecentSettledEntry(TASK_ID, itemId)?.outcome,
        queued: getChatQueueCount(TASK_ID),
      };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};

const infoEvents = async (): Promise<TaskEvent[]> =>
  (await readEvents(TASK_ID)).filter((e) => e.kind === "info");

/** 本文件用过的全部任务 id（afterAll 要把每一个的收尾写盘都等完再 rm 临时根） */
const usedTaskIds = new Set<string>();

/**
 * 给迟到的收尾写盘留出落地时间：**固定** 5 轮「排空该任务的 per-task 锁 + 让出 40ms」（总共约 200ms），不判断「有没有新活」。
 * 链上每一步（finalizeOpenToolCalls → 条件写 runStatus → 写事件 / 发布）都在 per-task 锁里、步间只有零星 await，
 * 所以多轮排空 + 间隔能覆盖到它；但这是时间裕量、不是同步点——裕量没有标定到失败点（锁内的延迟，比如 rename 前注入的，
 * 会被「进锁」这道屏障吸收，量不到「进锁之前」的迟到，所以那类注入不构成裕量证据）。用例之间不靠它：每个用例有独立任务 id / 目录，迟到写入落在自己的目录里。
 */
const quiesceTask = async (taskId: string): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await withTaskLock(taskId, async () => undefined);
    await new Promise((r) => setTimeout(r, 40));
  }
};

beforeEach(async () => {
  itemSeq += 1;
  TASK_ID = `t_1700000011000_steer_reason_${itemSeq}`;
  usedTaskIds.add(TASK_ID);
  ITEM_ID = `cq_steer_reason_${itemSeq}`;
  OTHER_ID = `cq_steer_reason_other_${itemSeq}`;
  mockResume.mockReset();
  // 新 id：没有残留的队列 / 会话 / 目录，不需要（也不该）再 rm 任何东西
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
  for (const l of liveRuns.splice(0)) l.failStream();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 60));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  // 每个用例的任务各等一遍（并行等：总耗时仍约 200ms），再删临时根
  await Promise.all([...usedTaskIds].map((id) => quiesceTask(id)));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("在飞的 steer × 会话被摘：条目的最终终态取决于关闭原因", () => {
  it.each<SteerMode>(["hang", "reject-on-close"])(
    "restart（cancelChatRun reason=restart，取消收尾自己清队）[%s]：条目重排回队首、不记 failed(stopped)",
    async (mode) => {
      const live = await startLive(mode);
      // 取消后流随之结束（真实 SDK 的形态）；cancelled 标记使收尾走 cancelled 分支（failQueuedItems → closeChatSession）
      live.run.cancel.mockImplementation(async () => live.failStream());
      await steerOne(live);

      expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);

      const s = await settledState(ITEM_ID);
      // 至少送一次：回到队首等新会话的收尾 flush；绝不能被记成「用户停止」
      expect(s.outcome).toBeUndefined();
      expect(s.queued).toBe(1);
    },
    15_000,
  );

  it.each<SteerMode>(["hang", "reject-on-close"])(
    "forceClear（懒重启强清）[%s]：条目重排回队首（回归守卫，原本就对）",
    async (mode) => {
      const live = await startLive(mode);
      await steerOne(live);

      forceClearChatRun(TASK_ID);

      const s = await settledState(ITEM_ID);
      expect(s.outcome).toBeUndefined();
      expect(s.queued).toBe(1);
    },
    15_000,
  );

  it.each<SteerMode>(["hang", "reject-on-close"])(
    "error 收尾 [%s]：与队里其它消息同命运——失败原因记 error（不是 stopped），队里不留",
    async (mode) => {
      const live = await startLive(mode);
      enqueue(OTHER_ID, OTHER_TEXT); // 队里还有一句普通排队消息，对照「同命运」
      await steerOne(live, 1);

      live.failStream(); // 不可重试错 → error 收尾

      const s = await settledState(ITEM_ID);
      expect(s.outcome).toBe("error");
      expect(s.queued).toBe(0);
      // 对照：队里那句也是 error（同一个终态）
      expect(findRecentSettledEntry(TASK_ID, OTHER_ID)?.outcome).toBe("error");
    },
    15_000,
  );

  it("error 收尾：steer 在飞的那条也算进「本轮出错，N 条排队消息未送达」提示（含 meta.droppedTexts）", async () => {
    const live = await startLive("hang");
    enqueue(OTHER_ID, OTHER_TEXT);
    await steerOne(live, 1);

    live.failStream();
    await settledState(ITEM_ID);

    await vi.waitFor(
      async () => {
        const notice = (await infoEvents()).find(
          (e) => e.kind === "info" && e.text.includes("条排队消息未送达"),
        );
        expect(notice).toBeTruthy();
      },
      { timeout: 5_000, interval: 30 },
    );
    const notice = (await infoEvents()).find(
      (e) => e.kind === "info" && e.text.includes("条排队消息未送达"),
    )!;
    if (notice.kind !== "info") throw new Error("unreachable");
    // 2 条：队里的那句 + steer 在飞、没被收下的那句
    expect(notice.text).toContain("本轮出错，2 条排队消息未送达");
    expect(notice.text).toContain("STEER-R6");
    expect(notice.text).toContain("QUEUED-R6");
    const dropped = (notice.meta as { droppedTexts?: string[] } | undefined)
      ?.droppedTexts;
    expect(dropped).toEqual(
      expect.arrayContaining([
        expect.stringContaining("STEER-R6"),
        expect.stringContaining("QUEUED-R6"),
      ]),
    );
    // 只有一条提示（不因 steer 那条再多写一条）
    const notices = (await infoEvents()).filter(
      (e) => e.kind === "info" && e.text.includes("条排队消息未送达"),
    );
    expect(notices).toHaveLength(1);
  }, 15_000);

  it("error 收尾：同时有两条 steer 在飞，两条都并入——各记 failed(error)，提示里算 2 条", async () => {
    const live = await startLive("hang");
    const SECOND_ID = `${ITEM_ID}_b`;
    const SECOND_TEXT = "第二条插话 STEER-R7B";
    enqueue(ITEM_ID, STEER_TEXT);
    enqueue(SECOND_ID, SECOND_TEXT);
    for (const id of [ITEM_ID, SECOND_ID]) {
      const res = await sendQueuedChatMessageNow(TASK_ID, id, BOOT);
      expect(res.status).toBe(202);
    }
    expect(live.steer).toHaveBeenCalledTimes(2);
    expect(getChatQueueCount(TASK_ID)).toBe(0);

    live.failStream(); // 不可重试错 → error 收尾

    const s = await settledState(ITEM_ID);
    expect(s.outcome).toBe("error");
    expect(s.queued).toBe(0);
    expect(findRecentSettledEntry(TASK_ID, SECOND_ID)?.outcome).toBe("error");

    await vi.waitFor(
      async () => {
        expect(
          (await infoEvents()).some(
            (e) => e.kind === "info" && e.text.includes("条排队消息未送达"),
          ),
        ).toBe(true);
      },
      { timeout: 5_000, interval: 30 },
    );
    const notices = (await infoEvents()).filter(
      (e) => e.kind === "info" && e.text.includes("条排队消息未送达"),
    );
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    if (notice.kind !== "info") throw new Error("unreachable");
    expect(notice.text).toContain("本轮出错，2 条排队消息未送达");
    expect(notice.text).toContain("STEER-R6");
    expect(notice.text).toContain("STEER-R7B");
  }, 15_000);

  it("用户停止（cancelChatRun 不带 reason）：仍记 failed(stopped)，不重排（回归守卫）", async () => {
    const live = await startLive("reject-on-close");
    live.run.cancel.mockImplementation(async () => live.failStream());
    await steerOne(live);

    expect(cancelChatRun(TASK_ID)).toBe(true);

    const s = await settledState(ITEM_ID);
    expect(s.outcome).toBe("stopped");
    expect(s.queued).toBe(0);
  }, 15_000);

  it("回退（closeChatSessionUnconditional）：仍记 failed(stopped)，不重排（回归守卫）", async () => {
    const live = await startLive("reject-on-close");
    await steerOne(live);

    closeChatSessionUnconditional(TASK_ID);

    const s = await settledState(ITEM_ID);
    expect(s.outcome).toBe("stopped");
    expect(s.queued).toBe(0);
  }, 15_000);
});

/**
 * 第七轮 K1-01：用户先介入、系统后摘会话——用户的意图不能被「系统自己的清队」吸收。
 *
 * 缺陷（第六轮的基线是「系统摘表那一刻的 generation」）：
 *   用户停止的清队（stop-task 的 failQueuedItems(stopped)，generation + 1）若发生在系统摘表**之前**，
 *   标记取到的就是已含用户那一次的值，requeueAsFollowup 看到「标记之后 generation 没再变」，
 *   把用户已经撤销的消息又重排了回去。
 *   修法：标记同时记「系统自己清队前」的 generation，只有「清队前 == steer 开始时、当前 == 摘表时」才算用户没介入。
 */
describe("用户先介入、系统后摘会话：记 failed(stopped)，不重排", () => {
  it.each<SteerMode>(["hang", "reject-on-close"])(
    "用户停止清了队，随后系统强清会话（forceClear）[%s]",
    async (mode) => {
      const live = await startLive(mode);
      await steerOne(live);

      // 用户停止的清队（stop-task：failQueuedItems(stopped)）先到、系统的强清后到
      failQueuedItems(TASK_ID, { reason: "stopped" });
      forceClearChatRun(TASK_ID);

      const s = await settledState(ITEM_ID);
      expect(s.outcome).toBe("stopped");
      expect(s.queued).toBe(0);
    },
    15_000,
  );

  it.each<SteerMode>(["hang", "reject-on-close"])(
    "用户的清队落在 restart 取消信号之后、取消收尾自己清队之前（真实 cancelled 收尾）[%s]",
    async (mode) => {
      const live = await startLive(mode);
      live.run.cancel.mockImplementation(async () => live.failStream());
      await steerOne(live);

      // 取消信号已发（收尾是异步的，还没跑）；用户在这个空窗里清了队
      expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);
      failQueuedItems(TASK_ID, { reason: "stopped" });

      const s = await settledState(ITEM_ID);
      expect(s.outcome).toBe("stopped");
      expect(s.queued).toBe(0);
    },
    15_000,
  );

  it.each<SteerMode>(["hang", "reject-on-close"])(
    "系统先摘会话、用户的清队紧随其后（回归守卫，原本就对）[%s]",
    async (mode) => {
      const live = await startLive(mode);
      await steerOne(live);

      forceClearChatRun(TASK_ID);
      failQueuedItems(TASK_ID, { reason: "stopped" });

      const s = await settledState(ITEM_ID);
      expect(s.outcome).toBe("stopped");
      expect(s.queued).toBe(0);
    },
    15_000,
  );
});

/** 立刻自然结束的 run：新会话的首条 / 随后 flush 出的重排消息都走它 */
const makeQuickRun = () => ({
  stream: async function* (): AsyncGenerator<never> {},
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/**
 * 第七轮 K1-06：restart / forceClear 重排回队首之后，新会话真的把它送出去（至少一次、气泡不重复）。
 * 之前只断言「回到队首」，没人验证它之后真的被发出。
 */
describe("restart / forceClear 重排后在新会话上被送出", () => {
  it.each<{ name: string; restart: () => void }>([
    {
      name: "cancelChatRun(reason=restart)",
      restart: () => {
        expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);
      },
    },
    { name: "forceClear", restart: () => forceClearChatRun(TASK_ID) },
  ])("$name：被重排的那条在新会话收尾 flush 时原文送出一次", async ({ restart }) => {
    const live = await startLive("hang");
    live.run.cancel.mockImplementation(async () => live.failStream());
    await steerOne(live);

    restart();
    const s = await settledState(ITEM_ID);
    expect(s.outcome).toBeUndefined();
    expect(s.queued).toBe(1);

    // 新会话（同一持久化 agent 的 resume）：首条跑完后收尾 flush 队首
    const next = {
      agentId: AGENT_ID,
      close: vi.fn(),
      send: vi
        .fn()
        .mockResolvedValueOnce(makeQuickRun())
        .mockResolvedValueOnce(makeQuickRun()),
    };
    mockResume.mockResolvedValueOnce(next);
    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "新会话首条")).toBe("sent");

    await vi.waitFor(
      () => {
        expect(isMessageHandedOff(TASK_ID, ITEM_ID)).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(next.send).toHaveBeenCalledTimes(2);
    expect(next.send.mock.calls[1]?.[0]).toBe(STEER_TEXT);
    expect(getChatQueueCount(TASK_ID)).toBe(0);
    expect(findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome).toBe("delivered");
    // 气泡只有 steer 路径落的那一条：重排条带 skipPersistEvent、flush 不再落 user_reply
    const bubbles = (await readEvents(TASK_ID)).filter(
      (e) => e.kind === "user_reply" && e.text === STEER_TEXT,
    );
    expect(bubbles).toHaveLength(1);
  }, 20_000);
});
