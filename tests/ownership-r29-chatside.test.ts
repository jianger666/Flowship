/**
 * R29：chat 侧旁路共享写门控
 *
 * ① ask notifier × stop → 不盖 awaiting_user
 * ② ask notifier × forceClear+B running → 不盖
 * ③ send 失主回滚 × B 已 running → idle 不落
 * ④ close 迟到清锚点 × B 已落新锚点 → 保留 B
 * ⑤ preamble × B checkpoint 半程（map 空）→ 不写重连事件
 * ⑥ 正常路径回归（ask 切 awaiting、失主回滚 idle、关会话清锚点）
 *
 * Mock 手法对齐 chat-finalize-r28-2 / ownership-r27-matrix。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r29-chat-"));
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
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const { setTaskRunStatus, setTaskSessionAgentId } = await import(
  "@/lib/server/task-fs"
);
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { getExpectedCallerToken } = await import("@/lib/server/chat-pending");
const { dispatchAskUserForTest } = await import("@/lib/server/chat-mcp");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r29-chatside DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001290_r29_chat";
const AGENT_A = "agent_fake_r29_A";
const AGENT_B = "agent_fake_r29_B";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, extra?: Partial<TaskMetaV06>): TaskMetaV06 =>
  ({
    id,
    title: `r29 chat ${id}`,
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

/** 等 runActive / 会话就位 */
const waitUntilActive = async (ms = 1600): Promise<void> => {
  for (let i = 0; i < ms / 20; i++) {
    if (isChatRunActive(TASK_ID)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** 等 chat notifier + caller token 注册完（晚于占位 runActive） */
const waitUntilCallerToken = async (ms = 3000): Promise<string> => {
  for (let i = 0; i < ms / 20; i++) {
    const t = getExpectedCallerToken(TASK_ID);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitUntilCallerToken timeout task=${TASK_ID}`);
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
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("R29 chat 旁路共享写", () => {
  it(
    "① ask notifier × stop → 不盖 awaiting_user（保持 idle）",
    async () => {
      const runA = makeControllableRun("finished");
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(runA),
      });

      void runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "A" },
      });
      const token = await waitUntilCallerToken();
      expect(hasChatSession(TASK_ID)).toBe(true);

      // 挂在 supersede 后——stop 关会话后 askLease.instanceStillCurrent=false，拒写
      const hang = installHangingFailpoint("mcp.askUser.afterSupersede");
      const pAsk = dispatchAskUserForTest({
        taskId: TASK_ID,
        callerToken: token,
        questions: [
          { id: "q1", question: "R29-1 stop 窗口提问？", allowText: true },
        ],
      });
      await hang.waitHit();

      cancelChatRun(TASK_ID);
      runA.resolveCancelled();
      for (let i = 0; i < 80 && hasChatSession(TASK_ID); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(hasChatSession(TASK_ID)).toBe(false);
      // stop 收尾后盘上应为 idle；再放行迟到 ask
      await setTaskRunStatus(TASK_ID, "idle");

      hang.release();
      await pAsk;
      await new Promise((r) => setTimeout(r, 40));

      const meta = await readMetaV06(TASK_ID);
      expect(meta?.runStatus).toBe("idle");
      expect(meta?.runStatus).not.toBe("awaiting_user");
    },
    20_000,
  );

  it(
    "② ask notifier × forceClear+B running → 不盖 awaiting_user",
    async () => {
      const runA = makeControllableRun("finished");
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(runA),
      });

      void runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "A" },
      });
      const tokenA = await waitUntilCallerToken();

      // 挂在 supersede 后、status 写前——给 forceClear+B 窗口
      const hang = installHangingFailpoint("mcp.askUser.afterSupersede");
      const pAsk = dispatchAskUserForTest({
        taskId: TASK_ID,
        callerToken: tokenA,
        questions: [
          { id: "q1", question: "R29-1 B 窗口提问？", allowText: true },
        ],
      });
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
      await waitUntilActive();
      expect(hasChatSession(TASK_ID)).toBe(true);
      await setTaskRunStatus(TASK_ID, "running");

      hang.release();
      await pAsk;
      await new Promise((r) => setTimeout(r, 40));

      const meta = await readMetaV06(TASK_ID);
      expect(meta?.runStatus).toBe("running");
      expect(meta?.runStatus).not.toBe("awaiting_user");

      clearFailpoints();
      runB.resolveFinished();
      await startB;
    },
    20_000,
  );

  it(
    "③ send 失主回滚 × B 已 running → idle 不落",
    async () => {
      const fakeRun = {
        stream: vi.fn(async function* (): AsyncGenerator<never> {
          /* 空 */
        }),
        wait: vi.fn().mockResolvedValue({ status: "cancelled" as const }),
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      const send = vi.fn().mockResolvedValue(fakeRun);
      mockResume.mockResolvedValue({
        agentId: AGENT_A,
        close: vi.fn(),
        send,
      });

      const task = asTask(makeMeta(TASK_ID, { sessionAgentId: AGENT_A }));
      const ownerId = await resumeChatSession(task, BOOT, { claimRun: true });
      expect(ownerId).not.toBeNull();

      // 置 running 写盘窗口：forceClear + B 抢先写 running
      const origWriteMeta = taskFsCore.writeMeta;
      const spy = vi
        .spyOn(taskFsCore, "writeMeta")
        .mockImplementation(async (meta: TaskMetaV06) => {
          if (meta.id === TASK_ID && meta.runStatus === "running") {
            spy.mockRestore();
            forceClearChatRun(TASK_ID);
            // B 占位会话 + 盘上 running（模拟 B 启动链已写状态）
            mockResume.mockResolvedValueOnce({
              agentId: AGENT_B,
              close: vi.fn(),
              send: vi.fn(),
            });
            await writeMeta(
              makeMeta(TASK_ID, {
                sessionAgentId: AGENT_B,
                runStatus: "running",
              }),
            );
            const instB = await resumeChatSession(
              asTask((await readMetaV06(TASK_ID))!),
              BOOT,
              { claimRun: true },
            );
            expect(instB).not.toBeNull();
            expect(hasChatSession(TASK_ID)).toBe(true);
          }
          return origWriteMeta(meta);
        });

      const sent = await sendChatMessage(
        task,
        "写盘窗口内被换主",
        undefined,
        undefined,
        { ownerInstanceId: ownerId! },
      );
      expect(sent === "cancelled" || sent === "owner_invalid").toBe(true);

      // 等 A 迟到 idle 回滚（若有）settle
      await new Promise((r) => setTimeout(r, 80));
      const meta = await readMetaV06(TASK_ID);
      expect(meta?.runStatus).toBe("running");
      expect(hasChatSession(TASK_ID)).toBe(true);
    },
    20_000,
  );

  it(
    "④ close 迟到清锚点 × B 已落新锚点 → 保留 B",
    async () => {
      // 模拟：A 已关（map 空）后 fire-and-forget 清锚点迟到；B 已落盘
      await setTaskSessionAgentId(TASK_ID, AGENT_B);
      expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBe(AGENT_B);

      // forceClear / close 在 !rec 时不得裸清（R29-3）
      expect(hasChatSession(TASK_ID)).toBe(false);
      forceClearChatRun(TASK_ID);
      await new Promise((r) => setTimeout(r, 80));

      expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBe(AGENT_B);

      // 再装 A 会话后关 A——只清 A，B 若已换盘则保留
      mockResume.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn(),
        send: vi.fn(),
      });
      await writeMeta(
        makeMeta(TASK_ID, {
          sessionAgentId: AGENT_A,
          runStatus: "idle",
        }),
      );
      const instA = await resumeChatSession(
        asTask((await readMetaV06(TASK_ID))!),
        BOOT,
      );
      expect(instA).not.toBeNull();

      // B 抢先落新锚点（同 agentId 或换号）后 A close
      await setTaskSessionAgentId(TASK_ID, AGENT_B);
      forceClearChatRun(TASK_ID);
      // 在 clear 的 commit 窗口前再确认 B 锚点已在盘
      await new Promise((r) => setTimeout(r, 80));
      expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBe(AGENT_B);
    },
    15_000,
  );

  it(
    "⑤ preamble × B checkpoint 半程（map 空）→ 不写重连事件",
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
      await waitUntilActive();
      expect(hasChatSession(TASK_ID)).toBe(true);

      // B checkpoint 半程：map 已空（forceClear）、尚未 resume 注册
      forceClearChatRun(TASK_ID);
      expect(hasChatSession(TASK_ID)).toBe(false);
      await writeMeta(
        makeMeta(TASK_ID, {
          sessionAgentId: AGENT_B,
          runStatus: "running",
        }),
      );

      throwStream();
      await startA;

      const events = await readEvents(TASK_ID);
      expect(
        events.some(
          (e) => e.kind === "info" && e.meta?.kind === "reconnecting",
        ),
      ).toBe(false);
    },
    20_000,
  );

  it(
    "⑥ 正常路径：ask 切 awaiting、失主回滚 idle、关会话清锚点",
    async () => {
      // 6a：ask 正常切 awaiting_user
      const runA = makeControllableRun("finished");
      mockCreate.mockResolvedValueOnce({
        agentId: AGENT_A,
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(runA),
      });
      void runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "正常 ask" },
      });
      const token = await waitUntilCallerToken();

      const askOk = await dispatchAskUserForTest({
        taskId: TASK_ID,
        callerToken: token,
        questions: [
          { id: "q1", question: "正常提问？", allowText: true },
        ],
      });
      expect(askOk).toMatchObject({ ok: true });
      for (let i = 0; i < 40; i++) {
        const m = await readMetaV06(TASK_ID);
        if (m?.runStatus === "awaiting_user") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await readMetaV06(TASK_ID))?.runStatus).toBe("awaiting_user");

      // 6b：关会话清锚点（持槽 close → 条件清匹配本 agentId）
      forceClearChatRun(TASK_ID);
      for (let i = 0; i < 40; i++) {
        const m = await readMetaV06(TASK_ID);
        if (!m?.sessionAgentId) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBeUndefined();

      // 6c：send 失主回滚——stop 后 map 空应落 idle（对齐既有 resume-owner 口径）
      mockResume.mockResolvedValue({
        agentId: AGENT_B,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue({
          stream: async function* (): AsyncGenerator<never> {},
          wait: async () => ({ status: "cancelled" as const }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      });
      await writeMeta(
        makeMeta(TASK_ID, {
          sessionAgentId: AGENT_B,
          runStatus: "idle",
        }),
      );
      const ownerId = await resumeChatSession(
        asTask((await readMetaV06(TASK_ID))!),
        BOOT,
        { claimRun: true },
      );
      expect(ownerId).not.toBeNull();

      const origWriteMeta = taskFsCore.writeMeta;
      const spy = vi
        .spyOn(taskFsCore, "writeMeta")
        .mockImplementation(async (meta: TaskMetaV06) => {
          if (meta.id === TASK_ID && meta.runStatus === "running") {
            spy.mockRestore();
            cancelChatRun(TASK_ID);
          }
          return origWriteMeta(meta);
        });

      const sent = await sendChatMessage(
        asTask((await readMetaV06(TASK_ID))!),
        "正常回滚",
        undefined,
        undefined,
        { ownerInstanceId: ownerId! },
      );
      expect(sent).toBe("cancelled");
      for (let i = 0; i < 40; i++) {
        const m = await readMetaV06(TASK_ID);
        if (m?.runStatus === "idle") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await readMetaV06(TASK_ID))?.runStatus).toBe("idle");
    },
    25_000,
  );
});
