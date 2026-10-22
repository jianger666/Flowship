/**
 * 第五轮 F4-01 / F4-02：「立即发送」steer 在飞时会话被「非用户意图」摘表 / steer 迟迟不落定
 *
 * F4-01（replacedByReconnect 只在重连一处置位）：
 *   在飞的 steer 靠 `rec.replacedByReconnect` 区分「实例被系统换掉、消息没送达」与「用户停止」。
 *   旧实现只有自动重连那一处打标；以下三条同样不是用户意图的摘表路径都漏了：
 *     ① run 以不可重试错误结束的 error 收尾（closeChatSession reason=error）；
 *     ② 懒重启 / 立即发送打断重发时旧会话没按期退出的强清（forceClearChatRun, reason=restart）；
 *     ③ 收尾自身抛错（落盘 EIO）的 finalizeChatRunSafely 兜底（reason=error）。
 *   这三条下 steer 落成 `cancelled`，调用方记成 failed(stopped)——用户根本没点停止。
 *   修法：closeChatSession 在「reconnect / error / restart」三种非用户原因摘表时统一打标并唤醒在飞的 steer，
 *   steer 返回 replaced，走既有的「至少一次」重排机制。用户停止（reason=user / 缺省）与回退（rewind）不打标。
 *
 * F4-02（steer 没有总期限）：
 *   steer 要等「这一轮真正收下」才 resolve；主 AI 卡在长工具里、run 又一直不结束时，既不 resolve 也不 reject，
 *   `endedFirst` 也等不到 run 结束——「立即发送」永远悬在「已落盘未送达」。现在给一个命名常量的总期限，
 *   到期按失败处理（返回 cancelled → 调用方记 failed）并在事件流里如实说明。
 *
 * 用真实 chat-runner + 假 SDK run。流用「不可重试错误」结束（走 error 收尾、不进自动重连的 2s 退避）。
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
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-steer-nonuser-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

/** 开关：为 true 时 setTaskRunStatusIfRunOwner 一律抛 EIO（模拟收尾落盘故障，走 finalize 抛错兜底） */
const failure = { statusWrite: false, taskId: "" };
vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    setTaskRunStatusIfRunOwner: (
      ...args: Parameters<typeof actual.setTaskRunStatusIfRunOwner>
    ) => {
      // 只让「本用例自己的任务」抛 EIO：每个用例独立任务 id 后，上一个用例迟到的收尾链不再被同 id 的新会话挡掉，
      // 开关若不看 taskId 就会误伤它（变成未处理拒绝、vitest 退出码 1）
      if (failure.statusWrite && args[0] === failure.taskId) {
        return Promise.reject(new Error("EIO: disk gone"));
      }
      return actual.setTaskRunStatusIfRunOwner(...args);
    },
  };
});

const { readEvents, taskDir, withTaskLock, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  STEER_TOTAL_TIMEOUT_MS,
  cancelChatRun,
  closeChatSessionUnconditional,
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
  steerChatRun,
} = await import("@/lib/server/chat-runner");
const {
  clearChatQueue,
  enqueueChatMessage,
  findRecentSettledEntry,
  getChatQueueCount,
} = await import("@/lib/server/chat-queue");
const { sendQueuedChatMessageNow } = await import(
  "@/lib/server/chat-queue-send-now"
);
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-steer-nonuser-close DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

let TASK_ID = "t_1700000009000_steer_nonuser";
const AGENT_ID = "agent_fake_steer_nonuser";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};
const STEER_TEXT = "插话：换个思路";

let itemSeq = 0;
let ITEM_ID = "cq_steer_nonuser_0";

/** 本文件用过的全部任务 id（afterAll 要把每一个的收尾写盘都等完再 rm 临时根） */
const usedTaskIds = new Set<string>();

/**
 * 给迟到的收尾写盘留出落地时间：**固定** 5 轮「排空该任务的 per-task 锁 + 让出 40ms」，不判断「有没有新活」——
 * 是时间裕量、不是同步点。用例之间不靠它：每个用例有独立任务 id / 目录，迟到写入落在自己的目录里
 * （以前共用一个 id + beforeEach 里 `fs.rm(taskDir)`，上一个用例 `failStream()` 触发的 error 收尾
 * `finalizeReconnectGaveUp → setTaskRunStatusIfRunOwner` 还在「读 meta → 写 tmp → rename」，目录被删 → rename ENOENT →
 * 未处理的 rejection → vitest 退出码 1；与 chat-steer-requeue-by-reason / chat-background-subagents 同族）。
 * 产品代码没改：删任务走 withTaskLock，锁内不会有目录被抽走，这条竞态只存在于测试的清理方式。
 */
const quiesceTask = async (taskId: string): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await withTaskLock(taskId, async () => undefined);
    await new Promise((r) => setTimeout(r, 40));
  }
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `steer nonuser ${id}`,
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
 * 在飞的一轮：流等 failStream() 后抛「不可重试」错（走 error 收尾）；
 * run.wait 永远挂起（最坏形态——steer 与 wait 都不会自己落定）；
 * steerMode=reject-on-close 时关 agent 才把 steer 拒掉（真实 SDK「会话摘表后 steer 失败」的形态）。
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

/** 悬空判据：到点还没落定就当「永远悬着」，让红灯是断言失败而不是用例超时 */
const settleOrHang = <T,>(p: Promise<T>, ms = 2_000): Promise<T | "HUNG"> =>
  Promise.race([
    p,
    new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), ms)),
  ]);

beforeEach(async () => {
  failure.statusWrite = false;
  itemSeq += 1;
  ITEM_ID = `cq_steer_nonuser_${itemSeq}`;
  TASK_ID = `t_1700000009000_steer_nonuser_${itemSeq}`;
  usedTaskIds.add(TASK_ID);
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
  failure.statusWrite = false;
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

describe("F4-01：非用户意图的摘表下，在飞的 steer 是 replaced（不是 cancelled / 不悬空）", () => {
  it.each<SteerMode>(["hang", "reject-on-close"])(
    "① error 收尾（steer 形态=%s）：会话被摘、steer 落成 replaced",
    async (mode) => {
      const live = await startLive(mode);
      const pending = steerChatRun(TASK_ID, STEER_TEXT, { settleGraceMs: 60_000 });
      expect(live.steer).toHaveBeenCalledTimes(1);

      live.failStream();

      expect(await settleOrHang(pending)).toBe("replaced");
      // 对照：error 收尾确实把会话摘掉了（不是别的路径把 steer 唤醒的）
      expect(hasChatSession(TASK_ID)).toBe(false);
    },
  );

  it.each<SteerMode>(["hang", "reject-on-close"])(
    "② 懒重启强清 forceClearChatRun（steer 形态=%s）：steer 落成 replaced",
    async (mode) => {
      await startLive(mode);
      const pending = steerChatRun(TASK_ID, STEER_TEXT, { settleGraceMs: 60_000 });

      forceClearChatRun(TASK_ID);

      expect(await settleOrHang(pending)).toBe("replaced");
      expect(hasChatSession(TASK_ID)).toBe(false);
    },
  );

  it.each<SteerMode>(["hang", "reject-on-close"])(
    "③ 收尾自身抛 EIO 的兜底摘表（steer 形态=%s）：steer 落成 replaced",
    async (mode) => {
      const live = await startLive(mode);
      const pending = steerChatRun(TASK_ID, STEER_TEXT, { settleGraceMs: 60_000 });

      // 从此刻起收尾写状态一律抛 EIO：error 收尾自己抛错 → finalizeChatRunSafely 兜底摘表
      failure.statusWrite = true;
      failure.taskId = TASK_ID;
      live.failStream();

      expect(await settleOrHang(pending)).toBe("replaced");
      expect(hasChatSession(TASK_ID)).toBe(false);
    },
  );

  it.each<SteerMode>(["hang", "reject-on-close"])(
    "④ 懒重启主路径 cancelChatRun(reason=restart)（steer 形态=%s）：run 取消收尾摘会话，steer 落成 replaced",
    async (mode) => {
      const live = await startLive(mode);
      // run 被取消后流随之结束（真实 SDK 的形态）；cancelled 标记使收尾走 cancelled 分支
      live.run.cancel.mockImplementation(async () => live.failStream());
      const pending = steerChatRun(TASK_ID, STEER_TEXT, { settleGraceMs: 60_000 });

      expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);

      expect(await settleOrHang(pending)).toBe("replaced");
      expect(hasChatSession(TASK_ID)).toBe(false);
    },
  );

  it("对照：用户停止 cancelChatRun()（不带 reason）：在飞的 steer 仍是 cancelled（不被误当成系统换实例）", async () => {
    const live = await startLive("reject-on-close");
    live.run.cancel.mockImplementation(async () => live.failStream());
    const pending = steerChatRun(TASK_ID, STEER_TEXT, { settleGraceMs: 60_000 });

    expect(cancelChatRun(TASK_ID)).toBe(true);

    expect(await settleOrHang(pending)).toBe("cancelled");
    expect(hasChatSession(TASK_ID)).toBe(false);
  });

  it("对照：懒重启取消登记后、收尾前用户又点了停止：用户意图优先，steer 是 cancelled", async () => {
    const live = await startLive("reject-on-close");
    live.run.cancel.mockImplementation(async () => live.failStream());
    const pending = steerChatRun(TASK_ID, STEER_TEXT, { settleGraceMs: 60_000 });

    expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);
    expect(cancelChatRun(TASK_ID)).toBe(true);

    expect(await settleOrHang(pending)).toBe("cancelled");
  });

  it("懒重启强清 + 立即发送的 steer 在飞：消息被重排回队首（至少一次），不被记成 failed(stopped)", async () => {
    await startLive("reject-on-close");
    expect(
      enqueueChatMessage(TASK_ID, {
        itemId: ITEM_ID,
        agentText: STEER_TEXT,
        displayText: STEER_TEXT,
        enqueuedAt: Date.now(),
      }),
    ).toMatchObject({ ok: true });

    const res = await sendQueuedChatMessageNow(TASK_ID, ITEM_ID, BOOT);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { steered?: boolean }).steered).toBe(true);
    expect(getChatQueueCount(TASK_ID)).toBe(0);

    forceClearChatRun(TASK_ID);

    // 重排：回到队首等新会话的收尾 flush 发出——没有会话时不主动 flush（flush 见无会话会清整队）
    await vi.waitFor(() => expect(getChatQueueCount(TASK_ID)).toBe(1), {
      timeout: 5_000,
      interval: 30,
    });
    expect(findRecentSettledEntry(TASK_ID, ITEM_ID)).toBeUndefined();
  }, 15_000);
});

describe("F4-02：steer 有总期限，到期按失败处理并如实提示", () => {
  it("期限是命名常量、有限且不会长到失去意义", () => {
    expect(Number.isFinite(STEER_TOTAL_TIMEOUT_MS)).toBe(true);
    expect(STEER_TOTAL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STEER_TOTAL_TIMEOUT_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("steer 与 run 都挂着、会话一直在：到期返回 cancelled（失败）、不重发，事件流写明原因", async () => {
    await startLive("hang");

    const pending = steerChatRun(TASK_ID, STEER_TEXT, {
      settleGraceMs: 60_000,
      totalTimeoutMs: 80,
    });

    expect(await settleOrHang(pending)).toBe("cancelled");
    // 超时不是会话出事：会话与这一轮都还在
    expect(hasChatSession(TASK_ID)).toBe(true);
    expect(isChatRunActive(TASK_ID)).toBe(true);
    await vi.waitFor(
      async () => {
        const evs = await readEvents(TASK_ID);
        expect(
          evs.some(
            (e) =>
              e.kind === "info" &&
              e.text.includes("按失败处理") &&
              e.text.includes("没有重发"),
          ),
        ).toBe(true);
      },
      { timeout: 3_000, interval: 30 },
    );
  });

  it("期限内落定（delivered）：不触发超时、不写失败提示", async () => {
    mockResume.mockResolvedValueOnce({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue({
        stream: async function* (): AsyncGenerator<never> {
          await new Promise<void>(() => {});
        },
        wait: () => new Promise<never>(() => {}),
        cancel: vi.fn().mockResolvedValue(undefined),
        steer: vi.fn(async () => "complete_delivered"),
      }),
    });
    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "先干这个")).toBe("sent");

    expect(
      await steerChatRun(TASK_ID, STEER_TEXT, { totalTimeoutMs: 150 }),
    ).toBe("delivered");
    // 越过原定期限：计时器必须已被清掉，不能事后补一条「按失败处理」
    await new Promise((r) => setTimeout(r, 300));
    const evs = await readEvents(TASK_ID);
    expect(
      evs.some((e) => e.kind === "info" && e.text.includes("按失败处理")),
    ).toBe(false);
  });
});
