/**
 * chat 收尾自身抛错时 runActive 闩锁必须释放（S12-01）
 *
 * consumeChatRun 的收尾（finalizeChatRunIfCurrent）要写 runStatus；落盘 EIO / ENOSPC 时它会抛错。
 * 旧实现里 finished / error 两条收尾都不兜底：抛错后 rec.runActive 仍为 true、会话仍在表里 →
 * 永远假 busy（新消息只入队无人 drain、空闲回收 sweeper 也跳过 runActive 会话）。
 * 修复：finalizeChatRunSafely 兜底——本实例仍是当前主时清队 + 摘会话 + 发 done。
 *
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-finalize-throw-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

/** 开关：为 true 时 setTaskRunStatusIfRunOwner 一律抛 EIO（模拟收尾落盘故障） */
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
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { enqueueChatMessage, getChatQueueCount } = await import(
  "@/lib/server/chat-queue"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-finalize-throw-latch DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000003000_finalize_throw";
const AGENT_ID = "agent_fake_finalize_throw";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `finalize throw ${id}`,
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

beforeEach(async () => {
  failure.statusWrite = false;
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
});

afterEach(async () => {
  failure.statusWrite = false;
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("收尾落盘抛错 → 会话闩锁仍释放（S12-01）", () => {
  it("自然 finished 的收尾写状态抛 EIO：会话摘表、runActive 不残留、排队消息有终态", async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((r) => {
      releaseStream = r;
    });
    const run = {
      stream: async function* (): AsyncGenerator<never> {
        await streamGate;
      },
      wait: async () => ({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const agentClose = vi.fn();
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: agentClose,
      send: vi.fn().mockResolvedValue(run),
    });

    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "正常消息")).toBe("sent");
    expect(isChatRunActive(TASK_ID)).toBe(true);
    // run 在飞时排一条，收尾抛错后它不能悬空
    const enq = enqueueChatMessage(TASK_ID, {
      itemId: "item_latch_q1",
      agentText: "排队",
      displayText: "排队",
      enqueuedAt: Date.now(),
    });
    expect(enq).toMatchObject({ ok: true });

    // 从此刻起收尾写状态一律抛 EIO，再放行流 → 自然 finished 收尾
    failure.statusWrite = true;
    releaseStream();

    await vi.waitFor(
      () => {
        expect(hasChatSession(TASK_ID)).toBe(false);
      },
      { timeout: 5_000, interval: 30 },
    );
    expect(isChatRunActive(TASK_ID)).toBe(false);
    expect(agentClose).toHaveBeenCalled();
    expect(getChatQueueCount(TASK_ID)).toBe(0);
  });
});

/**
 * R2-07：上面的用例走的是「自然 finished + 收尾抛错」。finished 分支本来就保留会话（只置
 * runActive=false），不是闩锁最容易残留的分支。真正会残留 runActive=true + 会话在表的是
 * error / cancelled 两条「必须摘表」的收尾——它们自己抛错、或根本没走到摘表时，
 * 闩锁就永久假 busy。下面逐条钉死：每条结束后 isChatRunActive=false 且会话已摘表。
 */
describe("会残留闩锁的收尾分支（error / cancelled / 收尾抛错）→ 一律释放（R2-07）", () => {
  /** 起一个活 run：流在 gate 上挂着，cancel() 会放行 gate（模拟 SDK 取消后流结束） */
  const startRun = async (
    streamBody: (gate: Promise<void>) => AsyncGenerator<never>,
  ): Promise<{ release: () => void; close: ReturnType<typeof vi.fn> }> => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = {
      stream: () => streamBody(gate),
      wait: async () => ({ status: "finished" as const }),
      cancel: vi.fn().mockImplementation(async () => {
        release();
      }),
    };
    const close = vi.fn();
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close,
      send: vi.fn().mockResolvedValue(run),
    });
    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "消息")).toBe("sent");
    expect(isChatRunActive(TASK_ID)).toBe(true);
    return { release, close };
  };

  const enqueueQ = (itemId: string, text: string): void => {
    expect(
      enqueueChatMessage(TASK_ID, {
        itemId,
        agentText: text,
        displayText: text,
        enqueuedAt: Date.now(),
      }),
    ).toMatchObject({ ok: true });
  };

  const expectLatchReleased = async (): Promise<void> => {
    await vi.waitFor(
      () => {
        expect(hasChatSession(TASK_ID)).toBe(false);
      },
      { timeout: 5_000, interval: 30 },
    );
    expect(isChatRunActive(TASK_ID)).toBe(false);
    expect(getChatQueueCount(TASK_ID)).toBe(0);
  };

  it("run 以不可重试错误结束（error 收尾正常）：会话摘表、闩锁释放", async () => {
    const { release } = await startRun(async function* (gate) {
      await gate;
      throw new Error("invalid api key");
    });
    enqueueQ("item_err_ok", "排队");
    release();
    await expectLatchReleased();
  });

  it("用户 stop（cancelled 收尾正常）：会话摘表、闩锁释放、排队消息清空", async () => {
    await startRun(async function* (gate) {
      await gate;
    });
    enqueueQ("item_cancel_ok", "排队");
    expect(cancelChatRun(TASK_ID)).toBe(true);
    await expectLatchReleased();
  });

  it("error 收尾自己落盘抛 EIO：兜底摘表 + 释放闩锁 + 清队并留「未送达」提示", async () => {
    const { release } = await startRun(async function* (gate) {
      await gate;
      throw new Error("invalid api key");
    });
    enqueueQ("item_err_eio", "EIO 时排队的话");
    failure.statusWrite = true;
    release();
    await expectLatchReleased();
    await vi.waitFor(
      async () => {
        const evs = await readEvents(TASK_ID);
        expect(
          evs.some(
            (e) =>
              e.kind === "info" &&
              e.text.includes("1 条排队消息未送达") &&
              e.text.includes("EIO 时排队的话"),
          ),
        ).toBe(true);
      },
      { timeout: 5_000, interval: 30 },
    );
  });

  it("cancelled 收尾自己落盘抛 EIO：兜底摘表 + 释放闩锁 + 清队", async () => {
    await startRun(async function* (gate) {
      await gate;
    });
    enqueueQ("item_cancel_eio", "排队");
    failure.statusWrite = true;
    expect(cancelChatRun(TASK_ID)).toBe(true);
    await expectLatchReleased();
  });
});
