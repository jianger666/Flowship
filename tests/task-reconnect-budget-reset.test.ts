/**
 * task 自动重连预算：「重连真的恢复了」之后必须归零（S1b-04）
 *
 * 缺口：tryAutoReconnect 把已用次数 attempt 放进 opts.reconnectAttempt 递归带进新 run 的 consume，
 * 新 run 收到一堆正文、跑了很久，之后全新的一次断线（VPN 抖 / 合盖唤醒）仍接着旧计数写「第 4/5 次」，
 * 第 6 次直接放弃标 error；sdk-error 里 `attempt <= 1` 的「瞬时鉴权放行一次」也被旧计数污染。
 *
 * 修法：新 run 收到首条「真有产出」的 SDK 消息（assistant 正文 / thinking / tool_call / usage）才归零；
 * 受理成功、system init、status 这类「还没证明模型那头通了」的不算——否则「resume ok、send ok、立刻又断」
 * 会无限重连。再加一条单链总次数硬上限兜底。
 *
 * 退避用真计时器（第 1 轮 2s、第 2 轮 4s），与 task-reconnect-send-fail-closes-session 同口径。
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
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-reconnect-budget-"));
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
    `task-reconnect-budget DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
const PERSISTED_AGENT_ID = "agent_t6_persisted";

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `task-reconnect-budget ${id}`,
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

const assistantMsg = (text: string) => ({
  type: "assistant" as const,
  message: { content: [{ type: "text", text }] },
});

/** 先吐 prelude、再以网络错抛断的 run（stream 中途断线） */
const droppingRun = (prelude: unknown[]) => ({
  stream: async function* (): AsyncGenerator<unknown> {
    for (const m of prelude) yield m;
    throw new Error("fetch failed");
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

const isReconnecting = (e: TaskEvent): boolean =>
  e.kind === "info" && e.meta?.kind === "reconnecting";
const reconnectAttempts = (events: TaskEvent[]): number[] =>
  events.filter(isReconnecting).map((e) => Number(e.meta?.attempt));
const isRunError = (e: TaskEvent): boolean =>
  e.kind === "error" && !e.text.includes("[boot-recovery]");

describe("task 自动重连预算：恢复后归零（S1b-04）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_t6_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

  /** 装初始坏会话 S0：send 受理后 stream 吐一句正文再抛网络错 → consume 进自动重连 */
  const installBrokenSession = (id: string): void => {
    const agent = {
      agentId: "agent_t6_a",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(droppingRun([assistantMsg("断线前的话")])),
    };
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: agent as never,
      agentId: agent.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: `t6 ${id}` },
      repoPaths: [],
    });
  };

  const deliver = async (id: string) =>
    deliverAskReply(
      (await getTask(id))!,
      "触发这一轮",
      undefined,
      "act_shared",
      { apiKey: CREDS.apiKey, model: CREDS.model },
    );

  it(
    "重连后的新 run 收到正文才又断线 → 新一次断线重新从「第 1/5 次」起算（修复前是第 2 次）",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      installBrokenSession(id);

      // 第 1 轮重连：恢复了、吐了真正的正文，然后又断一次（全新的一次断线）
      const agentR1 = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi
          .fn()
          .mockResolvedValue(droppingRun([assistantMsg("重连后的第一句")])),
      };
      // 第 2 轮重连：send 以不可重试错失败 → 放弃（让测试收口、不再退避）
      const agentR2 = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockRejectedValue(new Error("invalid api key")),
      };
      mockResume
        .mockResolvedValueOnce(agentR1)
        .mockResolvedValueOnce(agentR2);

      void (await deliver(id));

      await waitUntil(async () => {
        const evs = await readEvents(id);
        return agentR2.send.mock.calls.length >= 1 && evs.some(isRunError);
      }, 15_000);

      const attempts = reconnectAttempts(await readEvents(id));
      // 修复前 [1, 2]：旧 run 的已用次数带进了恢复后的新 run
      expect(attempts).toEqual([1, 1]);
    },
    30_000,
  );

  it(
    "重连后只来了 system / status 这类「还没证明通了」的消息就又断 → 预算不归零（防「resume ok、send ok、立刻又断」无限环）",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      installBrokenSession(id);

      const agentR1 = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(
          droppingRun([
            { type: "system", subtype: "init", agent_id: "a", run_id: "r" },
            { type: "status", status: "RUNNING", agent_id: "a", run_id: "r" },
          ]),
        ),
      };
      const agentR2 = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockRejectedValue(new Error("invalid api key")),
      };
      mockResume
        .mockResolvedValueOnce(agentR1)
        .mockResolvedValueOnce(agentR2);

      void (await deliver(id));

      await waitUntil(async () => {
        const evs = await readEvents(id);
        return agentR2.send.mock.calls.length >= 1 && evs.some(isRunError);
      }, 20_000);

      const attempts = reconnectAttempts(await readEvents(id));
      expect(attempts).toEqual([1, 2]);
    },
    40_000,
  );
});
