/**
 * 后台子代理结果投递：drain 的两个「静默卡住 / 静默丢」缝（真实 chat-runner + 假 SDK）
 *
 * 为什么单独一份：chat-background-reconnect-window / result-settle 覆盖的是「重连窗口」与「落定边角」，
 * 这里补的是 drainBackgroundResults 在两个外部条件下的出路——
 *   1. rewind 门闩占着时结果到达 / 收尾 drain 撞门闩：回退最终被拒（门闩释放、会话仍在、空闲）后，
 *      结果不能一直攒着等「下一条用户消息的 run 收尾」才送（同 flushChatQueue 的 scheduleQueueDrainAfterGate 口径）；
 *   2. 空闲唤醒前的 getTask 抛错（meta 半写 / EIO）：结果已 splice 出队，不能既没送、也没一句「未送达」。
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
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-bg-audit-"));
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
  closeChatSessionUnconditional,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { endChatRewind, tryBeginChatRewind } = await import(
  "@/lib/server/chat-gate"
);
const { clearChatQueue } = await import("@/lib/server/chat-queue");
const { emitBackgroundSubagentSettled } = await import(
  "@/lib/server/subagent-background"
);
const { clearFailpoints, setFailpoint } = await import(
  "@/lib/server/failpoints"
);
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-background-audit DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000010000_bg_audit";
const PARENT_ID = "agent_fake_bg_audit";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `bg audit ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: PARENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;
const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

/** 一轮：流里等 finish() 后自然结束；之后再被 send 复用也立即结束 */
const makeFinishableRun = () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const run = {
    stream: async function* (): AsyncGenerator<never> {
      await gate;
    },
    wait: async () => {
      await gate;
      return { status: "finished" as const };
    },
    cancel: vi.fn().mockImplementation(async () => finish()),
  };
  return { run, finish };
};

const makeQuickRun = () => ({
  stream: async function* (): AsyncGenerator<never> {},
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** 起一个空闲的父会话：首轮已自然结束、会话保留 */
const startIdleParent = async () => {
  const fin = makeFinishableRun();
  const send = vi
    .fn()
    .mockResolvedValueOnce(fin.run)
    // 之后每次 send（唤醒送结果）都给立刻结束的 run
    .mockImplementation(async () => makeQuickRun());
  const parentAgent = { agentId: PARENT_ID, close: vi.fn(), send };
  mockResume.mockResolvedValueOnce(parentAgent);
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, "先干这个")).toBe("sent");
  fin.finish();
  await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
    timeout: 5_000,
    interval: 30,
  });
  expect(hasChatSession(TASK_ID)).toBe(true);
  return { parentAgent, send };
};

const emitDone = (jobId: string, text: string): void =>
  emitBackgroundSubagentSettled(TASK_ID, {
    jobId,
    parentAgentId: PARENT_ID,
    description: `审计-${jobId}`,
    status: "done",
    text,
    durationMs: 10,
    detached: false,
  });

const infoTexts = async (): Promise<string[]> =>
  (await readEvents(TASK_ID))
    .filter((e: TaskEvent) => e.kind === "info")
    .map((e) => (e.kind === "info" ? e.text : ""));

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  mockResume.mockReset();
  clearFailpoints();
  endChatRewind(TASK_ID);
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await settle();
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 惰性触发：在任务还是 idle 时先触发一次
  await getTask(TASK_ID);
});

afterEach(async () => {
  clearFailpoints();
  endChatRewind(TASK_ID);
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await settle();
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await settle(50);
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("drain 撞 rewind 门闩：回退被拒后结果仍要送出", () => {
  it("空闲会话 + 门闩占着时结果到达 → 门闩释放（回退被拒、会话仍在）后，结果被送进主 AI，不用等下一条用户消息", async () => {
    const { send } = await startIdleParent();
    expect(send).toHaveBeenCalledTimes(1);

    // 用户恰好点了「回退」：门闩占着（还没走到锁内复查 / 最终会被拒）
    expect(tryBeginChatRewind(TASK_ID)).toBe(true);
    emitDone("bg_gate", "门闩期间到达的结果：GATE-001");

    // 到达提示落了、drain 撞门闩只能原样攒着（这一段是对的：会话可能马上被回退关掉）
    await vi.waitFor(
      async () => {
        expect(
          (await infoTexts()).some((t) => t.includes("后台子代理「审计-bg_gate」已完成")),
        ).toBe(true);
      },
      { timeout: 3_000, interval: 30 },
    );
    await settle(100);
    expect(send).toHaveBeenCalledTimes(1);

    // 回退被拒（比如找不到检查点）、门闩释放，会话仍在且空闲——不会再有任何别的东西触发 drain
    endChatRewind(TASK_ID);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
      interval: 50,
    });
    expect(String(send.mock.calls[1]?.[0])).toContain("GATE-001");
    // 只送一次
    await settle(300);
    expect(send).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("门闩恰好在唤醒前 getTask 的 await 里占上（sendChatMessage 回 busy）→ 回退被拒、门闩释放后结果仍被送出", async () => {
    const { send } = await startIdleParent();

    // drain 空闲分支入口的门闩检查已过、getTask 的 await 期间用户点了「回退」
    let gateTaken = false;
    setFailpoint("taskread.beforeHydrate", () => {
      if (gateTaken) return;
      gateTaken = true;
      expect(tryBeginChatRewind(TASK_ID)).toBe(true);
    });
    emitDone("bg_gate_late", "getTask 期间门闩占上：GATE-004");
    await vi.waitFor(() => expect(gateTaken).toBe(true), {
      timeout: 3_000,
      interval: 20,
    });
    // send 被门闩挡成 busy、结果放回；此刻不送
    await settle(150);
    expect(send).toHaveBeenCalledTimes(1);

    endChatRewind(TASK_ID);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
      interval: 50,
    });
    expect(String(send.mock.calls[1]?.[0])).toContain("GATE-004");
    await settle(300);
    expect(send).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("护栏：门闩占着、回退真的成功（会话被关）→ 结果作废并写「未送达」，绝不补送", async () => {
    const { send } = await startIdleParent();
    expect(tryBeginChatRewind(TASK_ID)).toBe(true);
    emitDone("bg_gate_ok", "回退成功前到达：GATE-002");
    await vi.waitFor(
      async () => {
        expect(
          (await infoTexts()).some((t) => t.includes("后台子代理「审计-bg_gate_ok」已完成")),
        ).toBe(true);
      },
      { timeout: 3_000, interval: 30 },
    );

    // 回退成功：关会话 + 释放门闩
    closeChatSessionUnconditional(TASK_ID);
    endChatRewind(TASK_ID);

    await vi.waitFor(
      async () => {
        expect(
          (await infoTexts()).some((t) => t.includes("1 条后台子代理的结果未送达主 AI")),
        ).toBe(true);
      },
      { timeout: 3_000, interval: 30 },
    );
    await settle(400);
    expect(send).toHaveBeenCalledTimes(1);
    expect(hasChatSession(TASK_ID)).toBe(false);
  }, 20_000);
});

describe("空闲唤醒前 getTask 抛错：已出队的结果不能静默没了", () => {
  it("getTask 抛错（meta 半写 / EIO）→ 事件流有「未送达」，而不是只有「将转交」", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { send } = await startIdleParent();

      // 只让紧接着的这一次 getTask 抛（drain 空闲分支在 splice 出队后第一件事就是 getTask）
      let thrown = 0;
      setFailpoint("taskread.beforeHydrate", () => {
        if (thrown > 0) return;
        thrown += 1;
        throw new Error("EIO: meta read failed");
      });
      emitDone("bg_io", "读盘失败时的结果：IO-003");

      await vi.waitFor(() => expect(thrown).toBe(1), {
        timeout: 3_000,
        interval: 20,
      });
      await settle(300);

      // 没送出去（getTask 抛了）→ 必须有一句真话；不能只有到达时的「将转交」
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        (await infoTexts()).some((t) => t.includes("条后台子代理的结果未送达主 AI")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  }, 20_000);
});
