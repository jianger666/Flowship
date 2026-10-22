/**
 * 新建 agent 路径（advanceTask / resumeCurrentAction → internalStartAgent）也要有 GitLab Token 回落
 *
 * 缺口：2026-10-08 事故只修了「恢复会话」（resumeTaskSession 里 resolveSessionGitToken：
 * 入口带的优先、缺了回落服务端 config.json）。但「新建 agent」这条路——
 * internalStartAgent 构造 submit_mr 桥时直接用入口带来的 gitToken，入口没带就是 undefined。
 * 飞书群里推进（group-route → deps.advanceTask，bootArgs 里根本没有 gitToken）起的 agent，
 * 之后 submit_mr（ship / dev / custom 共用）全报「当前会话里没有 GitLab Token」。
 * ship 的准入闸（checkActionPrerequisites）同样只看入口 token——群里推进「提测」会在
 * 准入就被「ship 需要配 GitLab PAT」拦下，尽管设置页明明配了。
 *
 * 修法：新建路径与恢复路径同口径——桥快照 / 提示词判定 / ship 准入都走 resolveSessionGitToken；
 * process.env 同步仍只喂入口原值（读失败 ≠ 确定没有，见 syncSessionGitTokenEnv 的三态说明）。
 *
 * 只用假 token；断言 token 不进 agent argv（Agent.create 入参 / send 内容）、不进事件流。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fe-start-agent-git-token-"));
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

const mockCreateMR = vi.fn();
const mockGetMRMergeStatus = vi.fn();
const mockCloseOpenMR = vi.fn();
vi.mock("@/lib/server/gitlab-client", () => ({
  createMR: (...args: unknown[]) => mockCreateMR(...args),
  getMRMergeStatus: (...args: unknown[]) => mockGetMRMergeStatus(...args),
  closeOpenMR: (...args: unknown[]) => mockCloseOpenMR(...args),
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

const { writeMeta, taskDir, readEvents } = await import(
  "@/lib/server/task-fs-core"
);
const { agentSessions, runningTasks, clearTaskStarting } = await import(
  "@/lib/server/task-stream"
);
const { cleanupChatTaskState, runTaskAction } = await import(
  "@/lib/server/chat-pending"
);
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { advanceTask } = await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `start-agent-git-token-fallback DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}
await listTasks();

// ---- 假数据：只用假 token ----
const SERVER_TOKEN = "glpat-FAKE-SERVER-TOKEN-NEWAGENT";
const ENTRY_TOKEN = "glpat-FAKE-ENTRY-TOKEN-NEWAGENT";
const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const CREDS = { apiKey: "fake-api-key", model: { id: "m", params: [] as never[] } };

/** 写 / 删临时数据目录里的 config.json（null = 删除） */
const writeServerConfig = (cfg: Record<string, unknown> | null): void => {
  if (cfg === null) {
    fs.rmSync(CONFIG_FILE, { force: true });
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg), "utf-8");
};

let ORIGIN_REPO = "";
const ORIGINAL_ENV_TOKEN = process.env.FLOWSHIP_GITLAB_TOKEN;

beforeAll(() => {
  ORIGIN_REPO = fs.mkdtempSync(path.join(os.tmpdir(), "start-agent-token-origin-"));
  execFileSync("git", ["init"], { cwd: ORIGIN_REPO });
  execFileSync("git", ["remote", "add", "origin", REMOTE_URL], {
    cwd: ORIGIN_REPO,
  });
});

afterAll(() => {
  for (const dir of [ORIGIN_REPO, TMP_ROOT]) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  // 会话启动会把 token 同步进 process.env（进程级）；还原、别漏给同 worker 的其它用例
  if (ORIGINAL_ENV_TOKEN === undefined) delete process.env.FLOWSHIP_GITLAB_TOKEN;
  else process.env.FLOWSHIP_GITLAB_TOKEN = ORIGINAL_ENV_TOKEN;
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `start-agent-git-token ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [ORIGIN_REPO],
    gitBranches: [
      { repoPath: ORIGIN_REPO, name: "feature/me/123-x", baseBranch: "master" },
    ],
    repoTestBranches: { [ORIGIN_REPO]: "test" },
    // dev（联调）准入要求至少一仓配了 dev 分支；dev 不过 ship 的 Token 准入闸，
    // 又和 ship 共用 submit_mr 通道——拿它隔离验证 internalStartAgent 的桥快照
    repoDevBranches: { [ORIGIN_REPO]: "dev" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

/**
 * 新建出来的假 agent：send 受理后 wait 永不 resolve——会话和 run 一直挂在表里，
 * 测试才能拿 callerToken 去打 submit_mr 桥（瞬间 finished 会追问耗尽后关会话）。
 */
const makeHangingAgent = (agentId: string) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      /* 空 */
    },
    wait: () => new Promise(() => {}),
    cancel,
  });
  return { agentId, close, send, cancel };
};

/** submit_mr 成功后会查合并状态；统一给默认值（resume-session-git-token 同口径） */
const resetGitlabMocks = (): void => {
  mockCreateMR.mockReset();
  mockGetMRMergeStatus.mockReset();
  mockCloseOpenMR.mockReset();
  mockGetMRMergeStatus.mockResolvedValue({
    ok: true,
    hasConflicts: false,
    detailedStatus: "mergeable",
    undetermined: false,
  });
  mockCloseOpenMR.mockResolvedValue({ ok: true, closed: true });
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitUntil = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil 超时 ${ms}ms`);
};

describe("新建 agent 的 submit_mr 桥 Token 回落（internalStartAgent）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_sagt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  /** 按给定入口 token 推进一个 action，等新 agent 的会话登记，返回桥身份 + action id */
  const advanceAndGetBridge = async (
    actionType: "dev" | "ship",
    entryGitToken: string | undefined,
  ): Promise<{ id: string; actionId: string; callerToken: string }> => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const agent = makeHangingAgent(`agent_new_${id}`);
    mockCreate.mockResolvedValue(agent);

    const { action } = await advanceTask({
      task: (await getTask(id))!,
      actionType,
      userInstruction: "新建 agent 路径 token 回落",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
      ...(entryGitToken !== undefined ? { gitToken: entryGitToken } : {}),
    });
    // internalStartAgent 的 create→install 在 fire-and-forget IIFE 里：等会话落表
    await waitUntil(() => agentSessions.get(id)?.agentId === agent.agentId);
    return {
      id,
      actionId: action.id,
      callerToken: agentSessions.get(id)!.callerToken as string,
    };
  };

  const submitMr = (actionId: string) =>
    ({
      kind: "submit_mr" as const,
      actionId,
      repoPath: ORIGIN_REPO,
      projectPath: PROJECT_PATH,
      sourceBranch: "feature/me/123-x__conflict",
      targetBranch: "dev",
      title: "new agent git token MR",
      description: "",
      lastCommitHash: "abc",
    }) as const;

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    resetGitlabMocks();
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/1",
      iid: 1,
    });
  });

  afterEach(async () => {
    writeServerConfig(null);
    for (const id of ids) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      endChatLifecycle(id);
      cleanupChatTaskState(id);
    }
    await sleep(60);
    for (const id of ids) {
      try {
        fs.rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    ids.length = 0;
  });

  it("事故形态（飞书群推进）：入口没带 gitToken、服务端 config.json 有 → 桥用服务端的提 MR", async () => {
    writeServerConfig({ gitToken: SERVER_TOKEN });
    // dev 不过 ship 准入，纯验证 internalStartAgent 的桥快照
    const { id, actionId, callerToken } = await advanceAndGetBridge("dev", undefined);

    // 提 MR 要求 action 是当前 running 的 ship / dev / custom action；dev 满足
    const result = await runTaskAction(id, submitMr(actionId), callerToken);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(mockCreateMR).toHaveBeenCalledTimes(1);
    expect(mockCreateMR.mock.calls[0]![0]).toMatchObject({
      config: { host: "git.corp.com", token: SERVER_TOKEN },
      projectPath: PROJECT_PATH,
    });
  });

  it("入口带了 gitToken → 以入口的为准（不被服务端覆盖）", async () => {
    writeServerConfig({ gitToken: SERVER_TOKEN });
    const { id, actionId, callerToken } = await advanceAndGetBridge(
      "dev",
      `  ${ENTRY_TOKEN}\n`,
    );

    const result = await runTaskAction(id, submitMr(actionId), callerToken);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(mockCreateMR.mock.calls[0]![0]).toMatchObject({
      config: { host: "git.corp.com", token: ENTRY_TOKEN },
    });
  });

  it("入口 / 服务端都没有 → 仍报「没有 GitLab Token」，不调 createMR（不凭空造 token）", async () => {
    writeServerConfig({ apiKey: "k" }); // 有 config 但没 gitToken
    const { id, actionId, callerToken } = await advanceAndGetBridge("dev", undefined);

    const result = await runTaskAction(id, submitMr(actionId), callerToken);

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("GitLab Token");
    expect(mockCreateMR).not.toHaveBeenCalled();
  });

  it("token 绝不进 agent argv / 提示词 / 事件流：Agent.create 入参、send 内容、events.jsonl 都不含它", async () => {
    writeServerConfig({ gitToken: SERVER_TOKEN });
    const { id, actionId, callerToken } = await advanceAndGetBridge("dev", undefined);
    // 把 submit_mr 也走一遍（成功 / 失败路径都会写事件）
    await runTaskAction(id, submitMr(actionId), callerToken);

    const createCalls = JSON.stringify(mockCreate.mock.calls);
    expect(createCalls).not.toContain(SERVER_TOKEN);
    const agent = (await mockCreate.mock.results[0]!.value) as ReturnType<
      typeof makeHangingAgent
    >;
    const sentPrompts = JSON.stringify(agent.send.mock.calls);
    expect(sentPrompts).not.toContain(SERVER_TOKEN);
    // 回落后「GitLab 访问」段照常注入（只写环境变量名、不含值）：入口没带 ≠ settings 没配
    expect(sentPrompts).toContain("FLOWSHIP_GITLAB_TOKEN");
    const events = await readEvents(id);
    expect(JSON.stringify(events)).not.toContain(SERVER_TOKEN);
  });

  it("两头都没有 token → 提示词不注入「GitLab 访问」段（判定口径不变）", async () => {
    writeServerConfig({ apiKey: "k" });
    await advanceAndGetBridge("dev", undefined);

    const agent = (await mockCreate.mock.results[0]!.value) as ReturnType<
      typeof makeHangingAgent
    >;
    expect(agent.send).toHaveBeenCalled();
    expect(JSON.stringify(agent.send.mock.calls)).not.toContain(
      "FLOWSHIP_GITLAB_TOKEN",
    );
  });
});

describe("ship 准入闸的 Token 回落（group-route → advanceTask 不带 gitToken）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_sagt_ship_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    resetGitlabMocks();
  });

  afterEach(async () => {
    writeServerConfig(null);
    for (const id of ids) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      endChatLifecycle(id);
      cleanupChatTaskState(id);
    }
    await sleep(60);
    for (const id of ids) {
      try {
        fs.rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    ids.length = 0;
  });

  it("入口没带 gitToken、服务端 config.json 有 → ship 过准入、新 agent 起得来，桥里是服务端 token", async () => {
    writeServerConfig({ gitToken: SERVER_TOKEN });
    const id = alloc();
    await writeMeta(makeMeta(id));
    const agent = makeHangingAgent(`agent_ship_${id}`);
    mockCreate.mockResolvedValue(agent);
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/2",
      iid: 2,
    });

    // 修复前：准入就抛「准入条件不满足：ship 需要配 GitLab Personal Access Token…」
    const { action } = await advanceTask({
      task: (await getTask(id))!,
      actionType: "ship",
      userInstruction: "群里推进提测",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    });
    await waitUntil(() => agentSessions.get(id)?.agentId === agent.agentId);

    const result = await runTaskAction(
      id,
      {
        kind: "submit_mr",
        actionId: action.id,
        repoPath: ORIGIN_REPO,
        projectPath: PROJECT_PATH,
        sourceBranch: "feature/me/123-x__conflict",
        targetBranch: "test",
        title: "ship from group",
        description: "",
        lastCommitHash: "abc",
      },
      agentSessions.get(id)!.callerToken as string,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(mockCreateMR.mock.calls[0]![0]).toMatchObject({
      config: { host: "git.corp.com", token: SERVER_TOKEN },
    });
  });

  it("入口 / 服务端都没有 token → ship 仍被准入拒（文案不变、不起 agent）", async () => {
    writeServerConfig({ apiKey: "k" });
    const id = alloc();
    await writeMeta(makeMeta(id));
    mockCreate.mockResolvedValue(makeHangingAgent(`agent_ship_${id}`));

    await expect(
      advanceTask({
        task: (await getTask(id))!,
        actionType: "ship",
        userInstruction: "没配 PAT",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }),
    ).rejects.toThrow(/ship 需要配 GitLab Personal Access Token/);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
