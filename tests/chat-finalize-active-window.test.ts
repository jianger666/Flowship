/**
 * chat 收尾「runActive 空窗」：自然结束的 finalize 不得在 await 状态写入期间就把 runActive 放掉。
 *
 * 背景：finalizeChatRunIfCurrent 的 finished 分支原先先 `rec.runActive=false`、再 await 写 awaiting_user、
 * 最后才 publish(done)。会话实例（instanceId）是同一个——run 与 run 之间 instanceId 不变，所以
 * 收尾里的 isCurrent() 只能挡「换会话」，挡不住「同一会话里的新一轮」。窗口内进来的 send 见 runActive=false
 * 直接 agent.send 出去、占位 runActive=true，随后旧 run 的 done 才发出：前端把这条 done 当成新一轮结束，
 * 提前清掉流式气泡 / 解锁输入框；旧 run 的 awaiting_user 写入还可能盖掉新一轮刚写的 running。
 *
 * 修法：runActive 保持 true 直到「写盘完成 + 复查 lease」之后、与 publish(done) 同步相邻地放掉；
 * 窗口内到的 send 因此拿到 busy、走入队，由收尾后的 flushChatQueue 顺序送出。
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

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-chat-finalize-active-window-"),
);
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockCreate = vi.fn();
const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({
    servers,
    dropped: [],
  }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  runChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { clearChatQueue, enqueueChatMessage } = await import("@/lib/server/chat-queue");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { subscribeTaskStream } = await import("@/lib/server/task-stream");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-finalize-active-window DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001300_finalize_window";
const AGENT_A = "agent_fake_finalize_window_A";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `finalize window ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

beforeEach(async () => {
  mockCreate.mockReset();
  mockResume.mockReset();
  clearFailpoints();
  closeChatSessionUnconditional(TASK_ID);
  clearChatGate(TASK_ID);
  clearChatQueue(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
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
  clearFailpoints();
  forceClearChatRun(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  clearChatGate(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("finalize finished 的 runActive 空窗", () => {
  it(
    "写 awaiting_user 的 await 期间进来的 send 必须拿到 busy（不得抢发、不得让旧 run 的 done 落到新一轮上）",
    async () => {
      let resolveWait!: (v: { status: "finished" }) => void;
      const waitGate = new Promise<{ status: "finished" }>((r) => {
        resolveWait = r;
      });
      const runA = {
        stream: async function* (): AsyncGenerator<never> {
          /* 空流 */
        },
        wait: () => waitGate,
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      const runNew = {
        stream: async function* (): AsyncGenerator<never> {},
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn(),
      };
      const agentSend = vi
        .fn()
        .mockResolvedValueOnce(runA)
        .mockResolvedValue(runNew);
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn().mockResolvedValue(undefined),
        send: agentSend,
      });

      const doneEvents: Array<{ ok?: boolean }> = [];
      const unsub = subscribeTaskStream(TASK_ID, (ev) => {
        if (ev.kind === "done") doneEvents.push({ ok: ev.ok });
      });

      // 卡在「状态写入之前」（old 代码里此刻 runActive 已被放成 false）
      let hitResolve!: () => void;
      const hit = new Promise<void>((r) => {
        hitResolve = r;
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      setFailpoint("chat.finalize.beforeStatusWrite", async () => {
        hitResolve();
        await gate;
      });

      const startA = runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "A 首包" },
      });
      for (let i = 0; i < 80 && !isChatRunActive(TASK_ID); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(hasChatSession(TASK_ID)).toBe(true);

      resolveWait({ status: "finished" });
      await hit;

      // 窗口内：旧 run 的收尾还没发 done，这时进来一条新消息
      const result = await sendChatMessage(
        asTask(makeMeta(TASK_ID)),
        "窗口内的新消息",
      );
      expect(
        result,
        "旧 run 收尾未完成（done 未发）时新 send 必须 busy，否则旧 done 会被前端当成新一轮的结束",
      ).toBe("busy");
      expect(agentSend, "没有抢发第二次 agent.send").toHaveBeenCalledTimes(1);

      // busy 的语义是「调用方负责入队」（chat-inject 的 enqueueOrReject 就是这么做的）：这里照做
      const queued = enqueueChatMessage(TASK_ID, {
        itemId: "c_window_msg_1",
        agentText: "窗口内的新消息",
        displayText: "窗口内的新消息",
        enqueuedAt: Date.now(),
      });
      expect(queued.ok).toBe(true);

      release();
      await startA;

      // 收尾完成后 flushChatQueue 把排队的那条按顺序送出去：第二次 agent.send 恰好带这条消息（不丢、不重复）
      for (let i = 0; i < 100 && agentSend.mock.calls.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(agentSend, "排队的消息在旧 run 收尾后被送出").toHaveBeenCalledTimes(2);
      const secondPayload = agentSend.mock.calls[1]?.[0];
      expect(
        typeof secondPayload === "string" ? secondPayload : JSON.stringify(secondPayload),
      ).toContain("窗口内的新消息");

      // 新一轮（runNew）也自然结束后：两轮各一条 done(ok)，旧 run 的 done 先于新一轮；状态归位 awaiting_user
      for (let i = 0; i < 100 && doneEvents.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(doneEvents).toEqual([{ ok: true }, { ok: true }]);
      for (let i = 0; i < 100 && isChatRunActive(TASK_ID); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await readMetaV06(TASK_ID))?.runStatus).toBe("awaiting_user");
      expect(isChatRunActive(TASK_ID)).toBe(false);
      unsub();
    },
    20_000,
  );
});
