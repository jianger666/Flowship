/**
 * 第八轮 L5-02：自动重连每开始一次尝试就给「暂存的后台结果」续期
 *
 * 缺陷（第七轮遗留）：暂存的时效是固定 10 分钟、从首次暂存起算。重连链最坏要 5 次尝试，退避合计 59 秒，
 * 每次尝试里 Agent.resume 最长 180 秒（SDK_CREATE_RESUME_TIMEOUT_MS）——5 次 resume 都挂到超时时整条链约 16 分钟，
 * 链还在走时 TTL 先到点：写「暂存超时」并删暂存，之后重连成功反而找不到暂存。
 *
 * 做法：真 chat-runner 的重连链 + 假 SDK（每次重连的 Agent.resume 都永远挂起 → 走 withSdkDeadline 的 180 秒超时），
 * fake timers 推进（setTimeout / clearTimeout / Date；真实 fs 落盘夹在中间，所以分小步推进、每步让出真实时间）。
 * 并行隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-stash-renew-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  STASHED_BACKGROUND_RESULTS_TTL_MS,
  __stashBackgroundResultsForTest,
  __stashedBackgroundResultsSnapshotForTest,
  closeChatSessionUnconditional,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-reconnect-stash-renew-r8 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000013000_stash_renew";
const AGENT_ID = "agent_fake_stash_renew";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `stash renew ${id}`,
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

/** 推进 fake 时钟 totalMs，分 stepMs 一步、每步让出真实时间（让夹在中间的真实 fs 落盘完成） */
const advanceInSteps = async (totalMs: number, stepMs = 5_000): Promise<void> => {
  for (let done = 0; done < totalMs; done += stepMs) {
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, totalMs - done));
    await realSleep(4);
  }
};

const infoTexts = async (): Promise<string[]> =>
  (await readEvents(TASK_ID))
    .filter((e) => e.kind === "info")
    .map((e) => (e.kind === "info" ? e.text : ""));

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await realSleep(30);
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 惰性触发：在任务还是 idle 时先触发一次
  await getTask(TASK_ID);
  // 自动重连读服务端凭据（readServerChatCreds）：钉一份假 config.json
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
  vi.useRealTimers();
  closeChatSessionUnconditional(TASK_ID);
  await realSleep(30);
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await realSleep(50);
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("L5-02：重连链走得比一份固定 TTL 还久时，暂存不能先到点", () => {
  it("5 次 resume 都挂到 180 秒超时（整条链约 16 分钟）：越过首次暂存起算的 10 分钟后暂存仍在，链放弃时才清并提示", async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((r) => {
      releaseStream = r;
    });
    const failingRun = {
      stream: async function* (): AsyncGenerator<never> {
        await streamGate;
        throw new Error("fetch failed"); // 网络类错 → 进自动重连
      },
      wait: async () => ({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    mockResume
      .mockResolvedValueOnce({
        agentId: AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(failingRun),
      })
      // 之后每次重连的 Agent.resume 都永远挂起 → 由 withSdkDeadline 的 180 秒超时落成「网络类失败」
      .mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "触发网络失败的消息")).toBe("sent");

    // 暂存一份后台结果（等价于重连摘实例时暂存）：TTL 计时从此刻起
    __stashBackgroundResultsForTest(TASK_ID, AGENT_ID, ["结果A"]);
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toBeDefined();

    releaseStream(); // run 失败 → 自动重连链开始

    // 越过「首次暂存起算的 10 分钟」再多推 50 秒：链此时应还在走（第 4 次尝试里），暂存必须还在
    await advanceInSteps(STASHED_BACKGROUND_RESULTS_TTL_MS + 50_000);
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toEqual({
      agentId: AGENT_ID,
      results: ["结果A"],
    });
    // 没有写「暂存超时」
    expect((await infoTexts()).some((t) => t.includes("暂存超时"))).toBe(false);
    // 确认链确实还在走、而不是早就结束了（至少已发起过多次 resume）
    expect(mockResume.mock.calls.length).toBeGreaterThanOrEqual(4);

    // 链走完（5 次 resume 全超时）→ 放弃：清暂存并如实提示；从头到尾都不是「暂存超时」
    await advanceInSteps(8 * 60_000);
    // 手写轮询（vi.waitFor 在 fake timers 下会自己推进假时钟，干扰这里的时间线）
    for (let i = 0; i < 100; i += 1) {
      if (!__stashedBackgroundResultsSnapshotForTest(TASK_ID)) break;
      await realSleep(20);
    }
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toBeUndefined();
    const texts = await infoTexts();
    expect(texts.some((t) => t.includes("暂存超时"))).toBe(false);
    expect(
      texts.some((t) => t.includes("1 条后台子代理的结果未送达主 AI")),
    ).toBe(true);
  }, 120_000);
});
