/**
 * R29：chat 侧旁路共享写门控
 *
 * ① ask notifier × stop → 不盖 awaiting_user
 * ② ask notifier × forceClear+B running → 不盖
 * ③ send 失主回滚 × B 已 running → idle 不落
 * ④ close 迟到清锚点 × B 已落新锚点 → 保留 B
 * ⑤ preamble × B checkpoint 半程（map 空）→ 不写重连事件
 * ⑥ 正常路径回归（ask 保持 running + pending、失主回滚 idle、关会话清锚点）
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
const { clearChatGate, hasChatStartReservation } = await import(
  "@/lib/server/chat-gate"
);
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { getExpectedCallerToken, getPendingAsk } = await import(
  "@/lib/server/chat-pending"
);
const { dispatchAskUser } = await import("@/lib/server/flowship-tools");

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

// 等「状态落定」的统一预算：只是失败兜底上限——条件一成立马上返回，不是固定要等这么久。
// 旧写法是手写的 40×20ms≈0.8s 轮询，全量并行 / CI 负载下不够。
// （⑥ 红过的真因不是这个上限，而是 6a 遗留的 fire-and-forget 读改写覆盖了测试的裸 writeMeta，见下面 settleTaskWrites）
const STATE_WAIT = { timeout: 10_000, interval: 20 } as const;

/**
 * 排空该任务的两条写盘链（事件追加链 + meta 锁）：此前遗留的 fire-and-forget 读改写
 * （syncTaskPendingAskId / appendEvent 里 updatedAt 的 touch / 条件清锚点 …）都排在这两条链上。
 *
 * 为什么需要：这些读改写在锁里「读 meta → 改一个字段 → 整份写回」，而测试里直接 writeMeta 播种状态是**不进锁**的——
 * 播种落在它们「读」与「写」之间，就会被它们读到的旧快照整份覆盖（锚点没了、runStatus 回到 running）。
 * 实测（高负载下 ⑥ 约 1/7 复现，meta.json 的 rename 轨迹逐条对上）：测试写 B/idle 后 1ms，appendEvent 的 touch 把旧快照写了回去；
 * 导致 resumeChatSession 拿到无锚点的任务返回 null，或迟到的 writeMeta(running) 提前触发间谍里的 cancelChatRun。
 * 交替两轮：锁里的写可能再排事件、反之亦然。
 */
const settleTaskWrites = async (): Promise<void> => {
  // 带 3s 上限：万一哪个用例失败时没放行 failpoint、把锁占住，清场不能卡死、更不能连累后面的用例（只是兜底，正常毫秒级完成；< vitest 默认 hookTimeout 10s）
  await Promise.race([
    (async () => {
      for (let round = 0; round < 2; round++) {
        await taskFsCore.withEventAppendChain(TASK_ID, async () => undefined);
        await taskFsCore.withTaskLock(TASK_ID, async () => undefined);
      }
    })(),
    new Promise<void>((r) => setTimeout(r, 3000)),
  ]);
};

/** 等 runActive / 会话就位（上限同 STATE_WAIT：只是失败兜底，条件成立即返回） */
const waitUntilActive = async (ms = 10_000): Promise<void> => {
  for (let i = 0; i < ms / 20; i++) {
    if (isChatRunActive(TASK_ID)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** 等 chat notifier + caller token 注册完（晚于占位 runActive）；上限同上 */
const waitUntilCallerToken = async (ms = 10_000): Promise<string> => {
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
  // 排空上一条用例遗留的写盘链再清目录（替换原来的 sleep(30)：时间裕量不是同步点；
  // 否则迟到的事件追加 / meta 读改写会落进刚重建的任务目录，污染下一条用例的状态）
  await settleTaskWrites();
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
  // 排空写盘链（替换原来的 sleep(50)）
  await settleTaskWrites();
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  // 排空写盘链再删整个临时根（替换原来的 sleep(50)）
  await settleTaskWrites();
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
      const pAsk = dispatchAskUser({
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
      const pAsk = dispatchAskUser({
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
    "⑥ 正常路径：ask 保持 running、失主回滚 idle、关会话清锚点",
    async () => {
      // 6a：同一轮还在跑，ask 不切 awaiting_user；输入条看 pending
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

      const askOk = await dispatchAskUser({
        taskId: TASK_ID,
        callerToken: token,
        questions: [
          { id: "q1", question: "正常提问？", allowText: true },
        ],
      });
      expect(askOk).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(getPendingAsk(TASK_ID)).toBeTruthy(), STATE_WAIT);
      expect((await readMetaV06(TASK_ID))?.runStatus).toBe("running");

      // 6b：关会话清锚点（持槽 close → 条件清匹配本 agentId）
      forceClearChatRun(TASK_ID);
      await vi.waitFor(async () => {
        expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBeUndefined();
      }, STATE_WAIT);
      // 锚点被清只是 forceClear 收尾里的一步：等内存会话与启动预约也摘干净再进 6c。
      // 否则马上 resume 会被 resumeChatSession 入口的 runningChats / 预约检查挡回 null
      // （v1.9.38 发版门禁在 Linux CI 上红过一次：下面 expect(ownerId).not.toBeNull()；本机连跑 12 次复现不了，根因没确证）。
      await vi.waitFor(() => {
        expect(hasChatSession(TASK_ID)).toBe(false);
        expect(hasChatStartReservation(TASK_ID)).toBe(false);
      }, STATE_WAIT);
      // 上面两个等待在高负载下常常是空转（锚点还没落盘、forceClear 后内存会话立刻就空）——它们不是真同步点。
      // 真同步点：把 6a / 6b 遗留的 fire-and-forget 读改写（ask 同步、updatedAt touch、条件清锚点）全部排空，
      // 再用裸 writeMeta 播种 6c 的状态；否则播种会被它们读到的旧快照整份覆盖（见 settleTaskWrites）
      await settleTaskWrites();

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
      // 播种写进 meta 锁：与其它读改写串行，不会落在别人「读 → 写」的夹缝里
      await taskFsCore.withTaskLock(TASK_ID, async () => {
        await writeMeta(
          makeMeta(TASK_ID, {
            sessionAgentId: AGENT_B,
            runStatus: "idle",
          }),
        );
      });
      const ownerId = await resumeChatSession(
        asTask((await readMetaV06(TASK_ID))!),
        BOOT,
        { claimRun: true },
      );
      // 失败时把当时的状态带进报错：这条在 Linux CI 上红过一次、本机复现不了，下次再红能直接看到是谁挡住了 resume
      const nullWhy = async (): Promise<string> => {
        const m = await readMetaV06(TASK_ID);
        return (
          `resumeChatSession 返回 null：hasChatSession=${hasChatSession(TASK_ID)} ` +
          `startReservation=${hasChatStartReservation(TASK_ID)} runActive=${isChatRunActive(TASK_ID)} ` +
          `meta.sessionAgentId=${m?.sessionAgentId ?? "无"} runStatus=${m?.runStatus ?? "无"}`
        );
      };
      expect(ownerId, ownerId === null ? await nullWhy() : undefined).not.toBeNull();

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
      await vi.waitFor(async () => {
        expect((await readMetaV06(TASK_ID))?.runStatus).toBe("idle");
      }, STATE_WAIT);
    },
    25_000,
  );
});
