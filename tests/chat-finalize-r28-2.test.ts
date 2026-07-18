/**
 * R28-2：chat run 收尾唯一入口 finalizeChatRunIfCurrent
 *
 * ① forceClear 空窗（map 空）× A natural finished → 不写 awaiting_user、不 publish done
 * ② A cancelled 收尾 × B 已注册 → no-op
 * ③ A reject 的 handleChatRunFailure × B 已注册 → 不写 error/idle
 * ④ reconnect preamble × B 已注册 → 不写「正在重连」
 * ⑤ 正常路径回归（A 是当前 instance → 收尾正常执行）
 *
 * Mock 手法对齐 chat-runner-start-lease / reconnect-race（挂起 run + forceClear + failpoint）。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-finalize-r28-2-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FE_AI_FLOW_DATA_DIR = DATA_DIR;

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
  renderSkillsForPrompt: () => "",
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  runChatSession,
} = await import("@/lib/server/chat-runner");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { subscribeTaskStream } = await import("@/lib/server/task-stream");
const { enqueueChatMessage, getChatQueueCount } = await import(
  "@/lib/server/chat-queue"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-finalize-r28-2 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001200_finalize_r28_2";
const AGENT_A = "agent_fake_finalize_A";
const AGENT_B = "agent_fake_finalize_B";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, extra?: Partial<TaskMetaV06>): TaskMetaV06 =>
  ({
    id,
    title: `finalize r28-2 ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

/** 挂起的 wait：测试在 failpoint 注入后再放行 finished/cancelled */
const makeControllableRun = (status: "finished" | "cancelled") => {
  let resolveWait!: (v: { status: "finished" | "cancelled" }) => void;
  const waitGate = new Promise<{ status: "finished" | "cancelled" }>(
    (resolve) => {
      resolveWait = resolve;
    },
  );
  return {
    stream: async function* (): AsyncGenerator<never> {
      /* 空流 */
    },
    wait: () => waitGate,
    cancel: vi.fn().mockResolvedValue(undefined),
    resolveFinished: () => resolveWait({ status: "finished" }),
    resolveCancelled: () => resolveWait({ status: "cancelled" }),
    status,
  };
};

/** failpoint 挂起：命中后等 release */
const installHangingFailpoint = (name: string) => {
  let hitResolve!: () => void;
  const hit = new Promise<void>((r) => {
    hitResolve = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    hitResolve();
    await gate;
  });
  return { waitHit: () => hit, release: () => release() };
};

beforeEach(async () => {
  mockCreate.mockReset();
  mockResume.mockReset();
  clearFailpoints();
  closeChatSessionUnconditional(TASK_ID);
  clearChatGate(TASK_ID);
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
  // 等 fire-and-forget 的 setTaskSessionAgentId 落盘竞态收束
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("R28-2 finalizeChatRunIfCurrent", () => {
  it(
    "① forceClear 空窗 × A natural finished → 不写 awaiting_user、不 publish done、B 启动完好",
    async () => {
      const runA = makeControllableRun("finished");
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(runA),
      });

      const doneEvents: Array<{ kind: string; ok?: boolean }> = [];
      const unsub = subscribeTaskStream(TASK_ID, (ev) => {
        if (ev.kind === "done") doneEvents.push({ kind: "done", ok: ev.ok });
      });

      const hang = installHangingFailpoint("chat.beforeFinalize");
      const task = asTask(makeMeta(TASK_ID));
      const startA = runChatSession({
        task,
        ...BOOT,
        firstMessage: { text: "A 首包" },
      });

      // 等到 A 进入 consume（send 已 resolve、stream 空、卡在 wait）
      for (let i = 0; i < 80 && !isChatRunActive(TASK_ID); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(hasChatSession(TASK_ID)).toBe(true);

      // 放行 wait → finished，A 进入 finalize、卡在 failpoint（CAS 前）
      runA.resolveFinished();
      await hang.waitHit();

      // 模拟懒重启 forceClear 空窗（map 空、B 尚未注册）
      forceClearChatRun(TASK_ID);
      expect(hasChatSession(TASK_ID)).toBe(false);

      // 放行 CAS：map 空 → no-op
      hang.release();
      await startA;

      const metaAfterA = await readMetaV06(TASK_ID);
      expect(metaAfterA?.runStatus).not.toBe("awaiting_user");
      expect(doneEvents.some((e) => e.kind === "done" && e.ok === true)).toBe(
        false,
      );

      // B 后续启动状态完好
      const runB = {
        stream: async function* (): AsyncGenerator<never> {},
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn(),
      };
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_B,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(runB),
      });
      await runChatSession({
        task: asTask((await readMetaV06(TASK_ID)) ?? makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "B 首包" },
      });
      // B 自然收尾应成功
      for (let i = 0; i < 50; i++) {
        const m = await readMetaV06(TASK_ID);
        if (m?.runStatus === "awaiting_user") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const metaB = await readMetaV06(TASK_ID);
      expect(metaB?.runStatus).toBe("awaiting_user");
      expect(metaB?.sessionAgentId).toBe(AGENT_B);
      expect(hasChatSession(TASK_ID)).toBe(true);
      unsub();
    },
    20_000,
  );

  it(
    "② A cancelled 收尾 × B 已注册 → no-op（不写 idle、不清 B 队列、不 publish done）",
    async () => {
      const runA = makeControllableRun("cancelled");
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(runA),
      });

      const doneEvents: Array<{ kind: string }> = [];
      const unsub = subscribeTaskStream(TASK_ID, (ev) => {
        if (ev.kind === "done") doneEvents.push({ kind: "done" });
      });

      const hang = installHangingFailpoint("chat.beforeFinalize");
      const startA = runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "A" },
      });

      for (let i = 0; i < 80 && !isChatRunActive(TASK_ID); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      runA.resolveCancelled();
      await hang.waitHit();

      // failpoint 窗口：forceClear + 注册 B（含队列消息）
      forceClearChatRun(TASK_ID);
      const runB = makeControllableRun("finished");
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_B,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(runB),
      });
      const startB = runChatSession({
        task: asTask((await readMetaV06(TASK_ID)) ?? makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "B" },
      });
      for (let i = 0; i < 80 && !isChatRunActive(TASK_ID); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(hasChatSession(TASK_ID)).toBe(true);
      enqueueChatMessage(TASK_ID, {
        agentText: "queued-for-B",
        displayText: "queued-for-B",
        enqueuedAt: Date.now(),
        skipPersistEvent: true,
      });
      expect(getChatQueueCount(TASK_ID)).toBeGreaterThanOrEqual(1);
      const queueBefore = getChatQueueCount(TASK_ID);

      // 清掉本轮 done 计数后放行 A 的 cancelled finalize（应对 B 启动过程的 done）
      doneEvents.length = 0;
      hang.release();
      await startA;

      // A no-op：B 仍在、队列保留、A 未再发 done
      expect(hasChatSession(TASK_ID)).toBe(true);
      expect(isChatRunActive(TASK_ID)).toBe(true);
      expect(getChatQueueCount(TASK_ID)).toBe(queueBefore);
      expect(doneEvents.length).toBe(0);
      const meta = await readMetaV06(TASK_ID);
      // R29-3：forceClear 改条件清锚点——不得抹 B 刚落盘的 sessionAgentId（原注释假阴性已补）
      expect(meta?.runStatus).toBe("running");
      for (let i = 0; i < 40; i++) {
        const m = await readMetaV06(TASK_ID);
        if (m?.sessionAgentId === AGENT_B) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBe(AGENT_B);

      // 收尾 B
      clearFailpoints();
      runB.resolveFinished();
      await startB;
      unsub();
    },
    20_000,
  );

  it(
    "③ A reject → handleChatRunFailure × B 已注册 → 不写 error、不 publish error/done",
    async () => {
      // stream 抛非可重试错（避免 wait() reject 的 unhandled rejection 竞态）
      let throwStream!: () => void;
      const streamGate = new Promise<void>((r) => {
        throwStream = r;
      });
      const runA = {
        stream: async function* (): AsyncGenerator<never> {
          await streamGate;
          throw new Error("permission denied: not retryable xyz");
        },
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn(),
      };
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(runA),
      });

      const published: Array<{ kind: string; message?: string }> = [];
      const unsub = subscribeTaskStream(TASK_ID, (ev) => {
        if (ev.kind === "done" || ev.kind === "error") {
          published.push({
            kind: ev.kind,
            message: ev.kind === "error" ? ev.message : undefined,
          });
        }
      });

      const hang = installHangingFailpoint("chat.beforeFinalize");
      const startA = runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "A" },
      });

      for (let i = 0; i < 80 && !isChatRunActive(TASK_ID); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      throwStream();
      await hang.waitHit();

      forceClearChatRun(TASK_ID);
      const runB = makeControllableRun("finished");
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_B,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(runB),
      });
      const startB = runChatSession({
        task: asTask((await readMetaV06(TASK_ID)) ?? makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "B" },
      });
      for (let i = 0; i < 80 && !isChatRunActive(TASK_ID); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(isChatRunActive(TASK_ID)).toBe(true);

      published.length = 0;
      hang.release();
      await startA;

      expect(published.some((p) => p.kind === "error")).toBe(false);
      expect(published.some((p) => p.kind === "done")).toBe(false);
      const meta = await readMetaV06(TASK_ID);
      expect(meta?.runStatus).toBe("running");
      expect(hasChatSession(TASK_ID)).toBe(true);
      const events = await readEvents(TASK_ID);
      expect(
        events.some(
          (e) =>
            e.kind === "error" &&
            typeof e.text === "string" &&
            e.text.includes("permission denied"),
        ),
      ).toBe(false);

      clearFailpoints();
      runB.resolveFinished();
      await startB;
      unsub();
    },
    20_000,
  );

  it(
    "④ reconnect preamble × B 已注册 → 不写「正在重连」",
    async () => {
      let throwStream!: () => void;
      const streamGate = new Promise<void>((r) => {
        throwStream = r;
      });
      const gatedFailRun = {
        stream: async function* (): AsyncGenerator<never> {
          await streamGate;
          throw new Error("fetch failed");
        },
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn(),
      };
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(gatedFailRun),
      });

      const startA = runChatSession({
        task: asTask(makeMeta(TASK_ID, { sessionAgentId: AGENT_A })),
        ...BOOT,
        firstMessage: { text: "A" },
      });

      for (let i = 0; i < 80 && !isChatRunActive(TASK_ID); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(hasChatSession(TASK_ID)).toBe(true);

      // B 顶替 A 后再让 stream 抛错 → preamble 见 B 让位
      forceClearChatRun(TASK_ID);
      // 等 forceClear 异步清锚点完成，再写 B 的锚点
      await new Promise((r) => setTimeout(r, 40));
      await writeMeta(
        makeMeta(TASK_ID, {
          sessionAgentId: AGENT_B,
          runStatus: "running",
        }),
      );
      const runB = makeControllableRun("finished");
      mockResume.mockResolvedValue({
        agentId: AGENT_B,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(runB),
      });
      const instB = await resumeChatSession(
        asTask((await readMetaV06(TASK_ID))!),
        BOOT,
        { claimRun: true },
      );
      expect(instB).not.toBeNull();
      expect(hasChatSession(TASK_ID)).toBe(true);

      throwStream();
      await startA;

      const events = await readEvents(TASK_ID);
      expect(
        events.some(
          (e) => e.kind === "info" && e.meta?.kind === "reconnecting",
        ),
      ).toBe(false);

      forceClearChatRun(TASK_ID);
    },
    20_000,
  );

  it(
    "⑤ 正常路径：A 是当前 instance → finished 收尾写 awaiting_user + publish done",
    async () => {
      const runA = {
        stream: async function* (): AsyncGenerator<never> {},
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn(),
      };
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(runA),
      });

      const doneEvents: Array<{ ok?: boolean }> = [];
      const unsub = subscribeTaskStream(TASK_ID, (ev) => {
        if (ev.kind === "done") doneEvents.push({ ok: ev.ok });
      });

      await runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "正常收尾" },
      });

      for (let i = 0; i < 50; i++) {
        const m = await readMetaV06(TASK_ID);
        if (m?.runStatus === "awaiting_user") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const meta = await readMetaV06(TASK_ID);
      expect(meta?.runStatus).toBe("awaiting_user");
      expect(hasChatSession(TASK_ID)).toBe(true);
      expect(doneEvents.some((e) => e.ok === true)).toBe(true);
      unsub();
    },
    15_000,
  );
});
