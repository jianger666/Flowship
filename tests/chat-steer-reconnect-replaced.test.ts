/**
 * 「立即发送」steer 在飞时遇到自动重连（第四轮审查 M4-01）
 *
 * 问题：steer 落定时实例已被自动重连摘表，旧实现把 `!stillCurrent` 一律当 cancelled，
 * 调用方记成 failed(stopped)——用户没点停止，消息既没送达也没重排，被静默丢掉。
 *
 * 拍板的语义是「至少一次」：重连替换导致 steer 未确认送达 → 重排队为 followup
 * （skipPersistEvent，气泡不重复），重连成功后在新实例上走普通 flush 发出；
 * 用户点停止导致的 cancelled 仍是 failed(stopped)、不重排。
 *
 * 真实 SDK 在流断时 steer 是拒绝还是挂起没验证过，所以这里三种形态都覆盖：
 *   - hang：steer 与 run.wait 都永远挂起（最坏形态，只能靠「实例被重连替换」的信号落定）；
 *   - reject-on-close：重连关旧 agent 时 steer 才被拒绝；
 *   - reject-on-break：流一断 steer 就被拒绝（实例此时还在退避窗口里、走既有 followup 路径）。
 *
 * 用真实 chat-runner + 真实 chat-queue-send-now + 假 SDK run。重连退避用真计时器（首次 2s），
 * 不用 fake timers——同 chat-runner-reconnect-giveup.test.ts。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-steer-replaced-"));
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
  canSteerChatRun,
  cancelChatRun,
  closeChatSessionUnconditional,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
  steerChatRun,
} = await import("@/lib/server/chat-runner");
const {
  enqueueChatMessage,
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
    `chat-steer-reconnect-replaced DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000007000_steer_replaced";
const AGENT_ID = "agent_fake_steer_replaced";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};
// 每个用例一个新 itemId：同 id 的 operation 已终态时队列会拒收（幂等账本跨用例残留）
let itemSeq = 0;
let ITEM_ID = "cq_steer_replaced_0";
const STEER_TEXT = "插话：换个思路";

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `steer replaced ${id}`,
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

const hasReconnectingEvent = (events: TaskEvent[], attempt: number): boolean =>
  events.some(
    (e) =>
      e.kind === "info" &&
      e.meta?.kind === "reconnecting" &&
      e.meta?.attempt === attempt,
  );

type SteerMode = "hang" | "reject-on-close" | "reject-on-break";

/**
 * 会断流的旧实例 A：stream 等 breakStream() 后抛网络错（进自动重连）。
 * run.wait 永远挂起——断流后真实 SDK 的 wait 怎样没验证过，取最坏形态。
 */
const makeBreakableRun = (steerMode: SteerMode) => {
  let breakStream!: () => void;
  const gate = new Promise<void>((r) => {
    breakStream = r;
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
      if (steerMode === "reject-on-break") rejectSteer(new Error("stream closed"));
      throw new Error("fetch failed");
    },
    wait: () => new Promise<never>(() => {}),
    cancel: vi.fn().mockResolvedValue(undefined),
    steer,
  };
  const close = vi.fn(() => {
    if (steerMode === "reject-on-close") rejectSteer(new Error("agent closed"));
  });
  return { run, steer, close, breakStream };
};

/** 立刻自然结束的 run（重连 run / 后续 flush 的 run） */
const makeQuickRun = () => ({
  stream: async function* (): AsyncGenerator<never> {},
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** 重连接回的新实例 R：第 1 次 send = 重连提示、第 2 次 send = 重排消息的 flush */
const makeReconnectAgent = () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce(makeQuickRun())
    .mockResolvedValueOnce(makeQuickRun());
  return { agent: { agentId: AGENT_ID, close: vi.fn(), send }, send };
};

/** 在 run 在飞时排一条消息（模拟用户又发了一句、进了排队条） */
const enqueueSteerItem = (): void => {
  expect(
    enqueueChatMessage(TASK_ID, {
      itemId: ITEM_ID,
      agentText: STEER_TEXT,
      displayText: STEER_TEXT,
      enqueuedAt: Date.now(),
    }),
  ).toMatchObject({ ok: true });
};

/** 起旧实例 A 的一轮 run；重连 resume 出的新实例 R 一并备好 */
const startRun = async (a: ReturnType<typeof makeBreakableRun>) => {
  const sendA = vi.fn().mockResolvedValue(a.run);
  const r = makeReconnectAgent();
  mockResume
    .mockResolvedValueOnce({ agentId: AGENT_ID, close: a.close, send: sendA })
    .mockResolvedValueOnce(r.agent);
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, "先干这个")).toBe("sent");
  expect(isChatRunActive(TASK_ID)).toBe(true);
  return { reconnect: r };
};

const userRepliesOf = async (text: string): Promise<TaskEvent[]> =>
  (await readEvents(TASK_ID)).filter(
    (e) => e.kind === "user_reply" && e.text === text,
  );

beforeEach(async () => {
  itemSeq += 1;
  ITEM_ID = `cq_steer_replaced_${itemSeq}`;
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 惰性触发：在任务还是 idle 时先触发一次
  await getTask(TASK_ID);
  // 自动重连读服务端凭据（readServerChatCreds）：钉一份 config.json
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
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("steer 在飞时自动重连摘实例 → 重排队、新实例上投递（至少一次）", () => {
  it.each<SteerMode>(["hang", "reject-on-close", "reject-on-break"])(
    "steer 形态=%s：消息被重排、在重连接回的新实例上被投递一次、气泡不重复",
    async (mode) => {
      const a = makeBreakableRun(mode);
      const { reconnect } = await startRun(a);
      enqueueSteerItem();

      const res = await sendQueuedChatMessageNow(TASK_ID, ITEM_ID, BOOT);
      expect(res.status).toBe(202);
      expect(((await res.json()) as { steered?: boolean }).steered).toBe(true);
      expect(a.steer).toHaveBeenCalledTimes(1);
      // steer 路径先落气泡再交给 run
      expect(await userRepliesOf(STEER_TEXT)).toHaveLength(1);

      // 流一断 → 自动重连（退避 2s 后摘旧实例、resume 新实例、发重连提示、新 run 收尾后 flush）
      a.breakStream();
      await vi.waitFor(
        async () => {
          expect(isMessageHandedOff(TASK_ID, ITEM_ID)).toBe(true);
        },
        { timeout: 15_000, interval: 50 },
      );

      // 新实例上：第 1 次 send 是重连提示，第 2 次才是被重排的那条用户消息（原文、一次）
      expect(mockResume).toHaveBeenCalledTimes(2);
      expect(reconnect.send).toHaveBeenCalledTimes(2);
      expect(String(reconnect.send.mock.calls[0]?.[0])).toContain("网络连接中断");
      expect(reconnect.send.mock.calls[1]?.[0]).toBe(STEER_TEXT);
      // 旧实例上的 steer 只发过一次、没有被再次 steer
      expect(a.steer).toHaveBeenCalledTimes(1);
      // 气泡只有 steer 路径落的那一条——重排条带 skipPersistEvent，flush 不再落 user_reply
      expect(await userRepliesOf(STEER_TEXT)).toHaveLength(1);
      expect(getChatQueueCount(TASK_ID)).toBe(0);
      expect(findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome).toBe("delivered");

      const events = await readEvents(TASK_ID);
      expect(hasReconnectingEvent(events, 1)).toBe(true);
      expect(events.some((e) => e.kind === "error")).toBe(false);
    },
    30_000,
  );

  it("steerChatRun 直接返回 replaced：steer 与 wait 都挂死时也立刻落定（不等 5s 宽限）", async () => {
    const a = makeBreakableRun("hang");
    const { reconnect } = await startRun(a);

    // 宽限设得很长：要是落定靠的是宽限计时器，这里会超时
    const pending = steerChatRun(TASK_ID, "插话", { settleGraceMs: 60_000 });
    a.breakStream();

    expect(await pending).toBe("replaced");

    // 收尾：等重连接回的新实例跑完，别把后台重连链留给下个用例
    await vi.waitFor(
      () => {
        expect(reconnect.send).toHaveBeenCalledTimes(1);
        expect(hasChatSession(TASK_ID)).toBe(true);
        expect(isChatRunActive(TASK_ID)).toBe(false);
      },
      { timeout: 15_000, interval: 50 },
    );
  }, 30_000);
});

describe("用户点停止时在飞的 steer 仍是 stopped、不重排", () => {
  it("stop → 会话被摘（非重连）：记 failed(stopped)，队里没有这条、不发生重连 / 重发", async () => {
    // 停止型 run：cancel 放行流并让 wait 报 cancelled；关 agent 时 steer 被拒绝（会话摘表）
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let stopped = false;
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
      },
      wait: async () => {
        await gate;
        return { status: stopped ? ("cancelled" as const) : ("finished" as const) };
      },
      cancel: vi.fn().mockImplementation(async () => {
        stopped = true;
        release();
      }),
      steer,
    };
    const close = vi.fn(() => rejectSteer(new Error("agent closed")));
    const sendA = vi.fn().mockResolvedValue(run);
    mockResume.mockResolvedValueOnce({ agentId: AGENT_ID, close, send: sendA });

    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "先干这个")).toBe("sent");
    enqueueSteerItem();

    const res = await sendQueuedChatMessageNow(TASK_ID, ITEM_ID, BOOT);
    expect(res.status).toBe(202);
    expect(steer).toHaveBeenCalledTimes(1);

    expect(cancelChatRun(TASK_ID)).toBe(true);
    await vi.waitFor(
      () => {
        expect(hasChatSession(TASK_ID)).toBe(false);
        expect(findRecentSettledEntry(TASK_ID, ITEM_ID)?.outcome).toBe("stopped");
      },
      { timeout: 10_000, interval: 30 },
    );

    // 没有重排、没有重连、没有往任何实例再发一遍
    expect(getChatQueueCount(TASK_ID)).toBe(0);
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(canSteerChatRun(TASK_ID)).toBe(false);
    expect(await userRepliesOf(STEER_TEXT)).toHaveLength(1);
  }, 20_000);
});
