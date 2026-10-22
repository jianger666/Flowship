/**
 * 推进时「续用当前 agent」与仓库漂移判定（commit a6b0ce1 引入的回归）
 *
 * 背景：a6b0ce1 为「编辑任务解绑 / 加仓后不能续旧 cwd」加了 `reposDrifted`：
 *   `!sessionRepos || !sameRepoPathList(sessionRepos, task.repoPaths)`，
 * 其中 sessionRepos 取自**内存**会话记录。内存会话被空闲回收（12 分钟）/ 服务重启后根本没有记录，
 * `!sessionRepos` 恒为 true → 用户勾了「续用当前 agent」也被静默无视、恒起新 agent。
 *
 * 为什么「无内存记录」不能当漂移：仓库集合真变化时（updateTaskFields.applyRepoReplaceMeta）
 * 盘上 sessionAgentId 会同步清掉、编辑路由还会关内存会话——所以「内存没有 + 盘上锚点还在」
 * 只可能是锚点创建后仓库没变过，Agent.resume 接回是安全的。
 *
 * 判定矩阵（本文件锁定）：
 *   内存无会话 + 盘上有锚点 + 勾续用  → 续用（Agent.resume、不 create）
 *   内存会话仓库集合一致 + 勾续用     → 续用（send 到活会话）
 *   内存会话仓库集合真变化 + 勾续用   → 仍强制新 agent（a6b0ce1 的原意）
 *   内存会话没记 repoPaths（老会话）  → 仍强制新 agent（a6b0ce1 的保守口径）
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-advance-reuse-drift-"));
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

const taskFsCore = await import("@/lib/server/task-fs-core");
const { taskDir, writeMeta } = taskFsCore;
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
const { advanceTask } = await import("@/lib/server/task-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `advance-reuse-agent-repos-drift DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
};

const PERSISTED_AGENT_ID = "agent_persisted_reuse_drift";

const makeMeta = (id: string, extras?: Partial<TaskMetaV06>): TaskMetaV06 =>
  ({
    id,
    title: `reuse-drift ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    // 不绑真仓：避免 worktree / git 依赖；漂移用「会话里记的仓」与它对比
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extras,
  }) as unknown as TaskMetaV06;

/** 能让 consumeSessionRun 平稳走完的假 agent（stream 空、wait 即 finished） */
const makeFakeAgent = (agentId: string) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      /* 空 */
    },
    wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
    cancel,
  });
  return { agentId, close, send, cancel };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitUntil = async (
  pred: () => boolean,
  ms = 5000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil 超时 ${ms}ms`);
};

describe("advance 续用当前 agent × 仓库漂移判定（a6b0ce1 回归）", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_reuse_drift_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  /** 挂一条内存会话；repoPaths 传 undefined = 模拟老会话（没记 repoPaths 字段） */
  const installMemSession = (
    id: string,
    agent: ReturnType<typeof makeFakeAgent>,
    repoPaths: string[] | undefined,
    title: string,
  ): void => {
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: agent as never,
      agentId: agent.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title },
      ...(repoPaths ? { repoPaths } : {}),
    });
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
    // 后台 consume / fire-and-forget 落盘收敛后再删目录，避免 ENOENT 噪音
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("内存无会话（被回收 / 重启）+ 盘上有 sessionAgentId + 勾续用 → 走 Agent.resume 续用，不起新 agent", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, { sessionAgentId: PERSISTED_AGENT_ID }));
    const resumed = makeFakeAgent(PERSISTED_AGENT_ID);
    mockResume.mockResolvedValue(resumed);
    mockCreate.mockResolvedValue(makeFakeAgent("agent_should_not_be_created"));
    expect(agentSessions.has(id)).toBe(false);

    await advanceTask({
      task: (await getTask(id))!,
      actionType: "plan",
      userInstruction: "续用被回收的会话",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
      reuseAgent: true,
    });

    // 修复前：reposDrifted 恒 true → 强制新 agent（create 被调、resume 一次都没调）
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockResume.mock.calls[0]![0]).toBe(PERSISTED_AGENT_ID);
    expect(mockCreate).not.toHaveBeenCalled();
    // [NEXT_ACTION] 是 send 到恢复出的会话里的（续接语义），而不是新 agent 的首包 prompt
    expect(resumed.send).toHaveBeenCalled();
  });

  it("内存无会话 + 盘上有锚点 + 没勾续用 → 照旧起新 agent（默认语义不变）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, { sessionAgentId: PERSISTED_AGENT_ID }));
    const created = makeFakeAgent("agent_fresh_default");
    mockCreate.mockResolvedValue(created);

    await advanceTask({
      task: (await getTask(id))!,
      actionType: "plan",
      userInstruction: "默认起新 agent",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
      reuseAgent: false,
    });
    await waitUntil(() => mockCreate.mock.calls.length > 0);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("内存会话的仓库集合与任务一致 + 勾续用 → send 到活会话，不 create / 不 resume", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    const live = makeFakeAgent("agent_live_same_repos");
    // 任务没绑仓、会话记的也是空集合 → 一致
    installMemSession(id, live, [], task.title);

    await advanceTask({
      task,
      actionType: "plan",
      userInstruction: "续用活会话",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
      reuseAgent: true,
    });

    expect(live.send).toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
    expect(live.close).not.toHaveBeenCalled();
  });

  it("内存会话的仓库集合真变化（旧 cwd 可能已拆）+ 勾续用 → 仍强制新 agent、旧会话被关（a6b0ce1 原意）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, { sessionAgentId: "agent_live_old_repos" }));
    const task = (await getTask(id))!;
    const old = makeFakeAgent("agent_live_old_repos");
    // 会话建在 /old/repo-a 上、任务现在已解绑成空集合
    installMemSession(id, old, ["/old/repo-a"], task.title);
    const created = makeFakeAgent("agent_fresh_after_drift");
    mockCreate.mockResolvedValue(created);

    await advanceTask({
      task,
      actionType: "plan",
      userInstruction: "仓库变了不能续旧 cwd",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
      reuseAgent: true,
    });
    await waitUntil(() => mockCreate.mock.calls.length > 0);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(old.close).toHaveBeenCalled();
    expect(old.send).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("内存会话没记 repoPaths（老会话）+ 勾续用 → 保守口径仍强制新 agent", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    const legacy = makeFakeAgent("agent_live_legacy");
    installMemSession(id, legacy, undefined, task.title);
    mockCreate.mockResolvedValue(makeFakeAgent("agent_fresh_after_legacy"));

    await advanceTask({
      task,
      actionType: "plan",
      userInstruction: "老会话没记仓、不赌 cwd",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
      reuseAgent: true,
    });
    await waitUntil(() => mockCreate.mock.calls.length > 0);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(legacy.close).toHaveBeenCalled();
    expect(legacy.send).not.toHaveBeenCalled();
  });
});
