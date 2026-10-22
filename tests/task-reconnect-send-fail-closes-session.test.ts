/**
 * task 自动重连：「resume 成功但 reconnect prompt send 失败」必须摘掉刚装的新会话
 *
 * 缺口：tryAutoReconnect 第 1 轮 resumeTaskSession 成功 → 新会话（instance S1）已装进 agentSessions，
 * 随后 send 因网络仍没恢复而失败，catch 里直接递归下一轮、既不关 S1、递归参数里的
 * reconnectSessionInstanceId 还是**旧坏会话 S0**：
 *   - 下一轮 closeTaskSession(expected=S0) 对表内的 S1 门控 no-op（关不掉）；
 *   - resumeTaskSession(closedSessionInstanceId=S0) 看到表里是 S1 ≠ S0，判成「别的实例已登记」→
 *     CAS 让位返回 null——后面 3~4 轮全部让位空转，白白退避 4+8+15+30 秒后放弃，S1 这条死会话还留在表里。
 * 离线 / VPN 重连 / 刚唤醒笔记本时最容易撞上（resume 靠本地存储能成功、send 要联网）。
 * chat 版（runReconnectAttempt 的 catch → closeChatSession(rec.instanceId)）早就摘了。
 *
 * 修法：对齐 chat 版——send 失败、继续重试前按 instanceId 摘掉自己刚装的会话（保留落盘锚点），
 * 并把递归的 stale 实例号换成它，下一轮能重新 resume。
 *
 * 退避用真计时器（首次 2s、第二次 4s）——和 chat 版重连测试同口径，不用 fake timers
 * 以免与落盘 / SDK deadline 的 setTimeout 互相干扰。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-reconnect-sendfail-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

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
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));
vi.mock("@/lib/server/chat-pending", () => ({
  cleanupChatTaskState: vi.fn(),
  invalidateCallerToken: vi.fn(),
  buildAgentMessage: (opts: { text: string }) => opts.text,
  cancelPending: vi.fn(),
  getPendingAsk: vi.fn(),
  setChatAwaitingNotifier: vi.fn(),
  setChatTaskActionHandler: vi.fn(),
  unsetChatAwaitingNotifierIf: vi.fn(),
  unsetChatTaskActionHandlerIf: vi.fn(),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  pendingStopRequests,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { deliverAskReply } = await import("@/lib/server/task-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `task-reconnect-send-fail DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
const PERSISTED_AGENT_ID = "agent_t5_persisted";

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `task-reconnect-sendfail ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act_shared",
    actions: [
      {
        id: "act_shared",
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    // 持久化会话锚点：重连靠它 Agent.resume
    sessionAgentId: PERSISTED_AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitUntil = async (
  pred: () => boolean | Promise<boolean>,
  ms = 5000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil 超时 ${ms}ms`);
};

/** 重连读服务端凭据（readServerCreds） */
const writeServerCreds = async (): Promise<void> => {
  const dataDir = process.env.FLOWSHIP_DATA_DIR!;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apiKey: CREDS.apiKey, defaultModel: CREDS.model }),
  );
};

/** 受理成功、流立即结束、wait 即 finished 的 run */
const goodRun = () => ({
  stream: async function* () {
    /* 空 */
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

describe("task 自动重连：resume 成功但 send 失败 → 摘掉新装会话", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_t5_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
  });

  afterEach(async () => {
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "第 1 轮 resume 成功、reconnect send 失败 → 退避窗口里死会话已摘表并 close；第 2 轮能重新 resume 并发出 reconnect prompt",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));

      // 旧坏会话 S0：send 能受理，但 run.wait 抛网络错 → consume 进自动重连
      const closeA = vi.fn();
      const agentA = {
        agentId: "agent_t5_a",
        close: closeA,
        send: vi.fn().mockResolvedValue({
          stream: async function* () {
            /* 空 */
          },
          wait: vi.fn().mockRejectedValue(new Error("fetch failed")),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      };
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: agentA as never,
        agentId: agentA.agentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: `t5 ${id}` },
        repoPaths: [],
      });

      // 第 1 轮 resume 出的 R1：send 因网络没恢复而失败（可重试错）
      const closeR1 = vi.fn();
      const agentR1 = {
        agentId: PERSISTED_AGENT_ID,
        close: closeR1,
        send: vi.fn().mockRejectedValue(new Error("fetch failed")),
      };
      // 第 2 轮 resume 出的 R2：网络恢复、send 受理
      const agentR2 = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockImplementation(async () => goodRun()),
      };
      mockResume
        .mockResolvedValueOnce(agentR1)
        .mockResolvedValueOnce(agentR2);

      const pSend = deliverAskReply(
        (await getTask(id))!,
        "触发重连",
        undefined,
        "act_shared",
        { apiKey: CREDS.apiKey, model: CREDS.model },
      );

      // 第 1 轮：退避 2s → resume 成功（R1）→ send 失败
      await waitUntil(() => agentR1.send.mock.calls.length >= 1, 8000);
      // 等第 2 轮的「重连中 2/5」落盘 = 已走过 send 失败的 catch、正处在第 2 轮的退避窗口里
      await waitUntil(async () => {
        const evs = await readEvents(id);
        return evs.some(
          (e) =>
            e.kind === "info" &&
            e.meta?.kind === "reconnecting" &&
            e.meta?.attempt === 2,
        );
      }, 8000);

      // 修复前：R1 的会话还挂在表里（门控 expected=S0 关不掉它），R1.close 没被调
      expect(
        agentSessions.get(id),
        "send 失败后新装的会话必须已摘表、不能留死会话占位",
      ).toBeUndefined();
      expect(closeR1).toHaveBeenCalled();
      // 落盘锚点保留（keepPersisted）：下一轮还要靠它 resume
      expect((await getTask(id))?.sessionAgentId).toBe(PERSISTED_AGENT_ID);

      // 第 2 轮（退避 4s 后）：重新 resume 出 R2、真的发出 reconnect prompt，不再因 CAS 让位空转
      await waitUntil(() => agentR2.send.mock.calls.length >= 1, 12_000);
      expect(String(agentR2.send.mock.calls[0]![0])).toContain("网络连接中断");
      expect(mockResume).toHaveBeenCalledTimes(2);
      const events = await readEvents(id);
      expect(
        events.some(
          (e) =>
            e.kind === "info" &&
            e.meta?.kind === "reconnected" &&
            e.meta?.attempt === 2,
        ),
      ).toBe(true);

      await pSend.catch(() => {});
    },
    40_000,
  );
});
