/**
 * 队列 flush 撞上 rewind 门闩不能被「吞掉」（第三轮审查 N5 核实）
 *
 * flushChatQueue 入口见 rewind 门闩会直接 return（不 dequeue，与 rewind 的「锁内复查」交叉闭合）。
 * 但门闩占着时队列若非空，rewind 的锁内复查必因「仍有排队中的消息」拒绝——门闩释放后
 * 没有任何人再触发 flush，就剩「会话空闲 + 队列非空 + 无人 drain」：已 202 的排队消息永远不发
 *（chat-reply 在这种状态下也只会继续入队；要等 12 分钟空闲回收关会话才有出路）。
 *
 * 触发点（都不是臆想的）：
 *   - run 自然收尾的链式 flush 恰好撞上用户点「回退」的几毫秒（门闩占着、尚未做到锁内复查）；
 *   - 「立即发送」steer 落定为 followup（run 刚好结束）后的主动补 flush，同样撞门闩。
 *
 * 用真实 chat-runner + 假 SDK run 驱动，不 mock 被测模块。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-flush-gate-"));
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
  flushChatQueue,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { endChatRewind, tryBeginChatRewind } = await import(
  "@/lib/server/chat-gate"
);
const {
  clearChatQueue,
  enqueueChatMessage,
  getChatQueueCount,
  isMessageHandedOff,
} = await import("@/lib/server/chat-queue");
const { sendQueuedChatMessageNow } = await import(
  "@/lib/server/chat-queue-send-now"
);
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-flush-rewind-gate DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000005000_flush_gate";
const AGENT_ID = "agent_fake_flush_gate";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `flush gate ${id}`,
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

type SteerOutcome = "complete_delivered" | "revert_to_followup";

/** 在流里挂着的假 run：release() 放行流（自然结束）；之后再被 send 复用也立即结束 */
const makeRun = (opts: { steer?: (text: string) => Promise<SteerOutcome> }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const run: Record<string, unknown> = {
    stream: async function* () {
      await gate;
    },
    wait: async () => {
      await gate;
      return { status: "finished" as const };
    },
    cancel: vi.fn().mockImplementation(async () => {
      release();
    }),
  };
  if (opts.steer) run.steer = vi.fn(opts.steer);
  return { run, release };
};

const startRun = async (run: Record<string, unknown>) => {
  const send = vi.fn().mockResolvedValue(run);
  mockResume.mockResolvedValue({ agentId: AGENT_ID, close: vi.fn(), send });
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, "先干这个")).toBe("sent");
  expect(isChatRunActive(TASK_ID)).toBe(true);
  return { send };
};

const waitRunIdle = () =>
  vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
    timeout: 5_000,
    interval: 30,
  });

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  clearChatQueue(TASK_ID);
  endChatRewind(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 惰性触发：在任务还是 idle 时先触发一次，避免它落在用例中间
  await getTask(TASK_ID);
});

afterEach(async () => {
  endChatRewind(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  clearChatQueue(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("flushChatQueue 撞 rewind 门闩：门闩释放后必须补 drain", () => {
  it("run 自然收尾的链式 flush 撞上门闩 → 回退被拒、门闩释放后，排队消息仍被发出", async () => {
    const { run, release } = makeRun({});
    const { send } = await startRun(run);

    // run 在跑时用户又排了一条（已 202）
    expect(
      enqueueChatMessage(TASK_ID, {
        itemId: "cq_gate_b",
        agentText: "queued-B",
        displayText: "queued-B",
        enqueuedAt: Date.now(),
        skipPersistEvent: true,
      }).ok,
    ).toBe(true);

    // 用户恰好点了「回退」：门闩占着（还没走到锁内复查）
    expect(tryBeginChatRewind(TASK_ID)).toBe(true);
    release(); // run 自然收尾 → finalize 的链式 flush 撞门闩
    await waitRunIdle();
    // 门闩占着：flush 绝不 dequeue，队列原样保留（这一段是正确行为）
    expect(getChatQueueCount(TASK_ID)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);

    // 回退因「仍有排队中的消息」被拒、门闩释放——不会有任何别的东西再触发 flush
    endChatRewind(TASK_ID);

    await vi.waitFor(
      () => {
        expect(send).toHaveBeenCalledTimes(2);
        expect(getChatQueueCount(TASK_ID)).toBe(0);
      },
      { timeout: 3_000, interval: 50 },
    );
    expect(String(send.mock.calls[1]?.[0])).toContain("queued-B");
  });

  it("「立即发送」steer 落定 followup（run 刚好结束）时门闩占着 → 释放后这条消息仍被发出、不重复落气泡", async () => {
    let settleSteer!: (v: SteerOutcome) => void;
    const steerPending = new Promise<SteerOutcome>((r) => {
      settleSteer = r;
    });
    const { run, release } = makeRun({ steer: () => steerPending });
    const { send } = await startRun(run);

    enqueueChatMessage(TASK_ID, {
      itemId: "cq_steer_target",
      agentText: "插话内容",
      displayText: "插话内容",
      enqueuedAt: Date.now(),
    });

    // 真实入口：能 steer → 先落 user_reply、202 立刻返回，steer 在后台挂着
    const res = await sendQueuedChatMessageNow(
      TASK_ID,
      "cq_steer_target",
      BOOT,
    );
    expect(res.status).toBe(202);
    expect(((await res.json()) as { steered?: boolean }).steered).toBe(true);

    // run 自然结束（steer 还没落定），随后用户点了「回退」占住门闩
    release();
    await waitRunIdle();
    expect(tryBeginChatRewind(TASK_ID)).toBe(true);

    // SDK 回「这一轮没收下、按后续消息发」→ 排回队首 → 补 flush（撞门闩被吞）
    settleSteer("revert_to_followup");
    await vi.waitFor(() => expect(getChatQueueCount(TASK_ID)).toBe(1), {
      timeout: 3_000,
      interval: 30,
    });
    expect(send).toHaveBeenCalledTimes(1);

    endChatRewind(TASK_ID);

    await vi.waitFor(
      () => {
        expect(send).toHaveBeenCalledTimes(2);
        expect(getChatQueueCount(TASK_ID)).toBe(0);
      },
      { timeout: 3_000, interval: 50 },
    );
    expect(String(send.mock.calls[1]?.[0])).toContain("插话内容");
    await vi.waitFor(() =>
      expect(isMessageHandedOff(TASK_ID, "cq_steer_target")).toBe(true),
    );
    // steer 路径已落过 user_reply（气泡）——followup 重排带 skipPersistEvent，绝不再落一条
    const bubbles = (await readEvents(TASK_ID)).filter(
      (e) => e.kind === "user_reply" && e.text === "插话内容",
    );
    expect(bubbles).toHaveLength(1);
  });

  it("护栏：会话已不在时不补 drain（队列归启动状态机，绝不能被误清）", async () => {
    // 无会话（模拟「新 owner 正在 startup reservation」）+ 队列里有 202 过的消息
    expect(hasChatSession(TASK_ID)).toBe(false);
    enqueueChatMessage(TASK_ID, {
      itemId: "cq_gate_orphan",
      agentText: "queued-for-new-owner",
      displayText: "queued-for-new-owner",
      enqueuedAt: Date.now(),
      skipPersistEvent: true,
    });

    expect(tryBeginChatRewind(TASK_ID)).toBe(true);
    await flushChatQueue(TASK_ID); // 撞门闩
    endChatRewind(TASK_ID);

    // 若误补 drain：flush 会因无会话清队（failQueuedItems no_session）——队列原样保留即证明没发生
    await new Promise((r) => setTimeout(r, 600));
    expect(getChatQueueCount(TASK_ID)).toBe(1);
  });
});
