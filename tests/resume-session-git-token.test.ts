/**
 * 会话恢复（resumeTaskSession）不能丢 GitLab Token —— Bug #2（2026-10-08 事故）
 *
 * 事故：ship 任务会话被空闲回收（12~22 分钟）后，用户在任务页输入条再发一句话，走「恢复会话」。
 * 恢复传进来的凭据只有 `{ apiKey, model }`，submit_mr 桥又只持有一份**会话期不可变**的 Token 快照，
 * 于是这个会话里之后每次 submit_mr 都报「没拿到 GitLab Host / Token」，设置页的 Token 明明一直在。
 * 飞书群里属主发消息、飞书里答 ask 的入口根本没有 gitToken，同样中招。
 *
 * 修法：resumeTaskSession 里兜底——入口带的优先，缺了回落服务端 config.json（与自动重连同源）。
 *
 * 四层：
 *   A. resolveSessionGitToken 纯逻辑；
 *   B. readServerGitToken 读临时 config.json（只用假 token，绝不读真实配置）；
 *   C. 端到端：真走 resumeTaskSession → 注册的 submit_mr 桥 → createMR 收到的 token；
 *      以及 Host / Token 缺失时的报错必须分开、且指向真原因；
 *   D. 接线契约：输入条入口把 bootArgs 的 gitToken 往下传。
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

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fe-resume-git-token-"));
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

const { writeMeta, taskDir } = await import("@/lib/server/task-fs-core");
const { agentSessions, runningTasks, clearTaskStarting } = await import(
  "@/lib/server/task-stream"
);
const { cleanupChatTaskState, runTaskAction } = await import(
  "@/lib/server/chat-pending"
);
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { readServerGitToken, resolveSessionGitToken, resumeTaskSession } =
  await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `resume-session-git-token DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}
await listTasks();

// ---- 假数据：只用假 token ----
const SERVER_TOKEN = "glpat-FAKE-SERVER-TOKEN";
const CREDS_TOKEN = "glpat-FAKE-CREDS-TOKEN";
const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

/** 写 / 删临时数据目录里的 config.json（null = 删除；string = 原样写入，用来造坏 JSON） */
const writeServerConfig = (cfg: Record<string, unknown> | string | null): void => {
  if (cfg === null) {
    fs.rmSync(CONFIG_FILE, { force: true });
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    typeof cfg === "string" ? cfg : JSON.stringify(cfg),
    "utf-8",
  );
};

let ORIGIN_REPO = "";
let NO_ORIGIN_REPO = "";

beforeAll(() => {
  ORIGIN_REPO = fs.mkdtempSync(path.join(os.tmpdir(), "resume-git-token-origin-"));
  execFileSync("git", ["init"], { cwd: ORIGIN_REPO });
  execFileSync("git", ["remote", "add", "origin", REMOTE_URL], {
    cwd: ORIGIN_REPO,
  });
  NO_ORIGIN_REPO = fs.mkdtempSync(
    path.join(os.tmpdir(), "resume-git-token-noorigin-"),
  );
  execFileSync("git", ["init"], { cwd: NO_ORIGIN_REPO });
});

afterAll(() => {
  for (const dir of [ORIGIN_REPO, NO_ORIGIN_REPO, TMP_ROOT]) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

// ---------------------------------------------------------------------------
// A. resolveSessionGitToken 纯逻辑
// ---------------------------------------------------------------------------

describe("A · resolveSessionGitToken", () => {
  it("入口带了就用入口的（trim 后），不去读盘", async () => {
    const fallback = vi.fn(async () => SERVER_TOKEN);
    await expect(
      resolveSessionGitToken({ gitToken: `  ${CREDS_TOKEN}\n` }, fallback),
    ).resolves.toBe(CREDS_TOKEN);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("入口没带（undefined）→ 回落服务端的", async () => {
    const fallback = vi.fn(async () => SERVER_TOKEN);
    await expect(resolveSessionGitToken({}, fallback)).resolves.toBe(
      SERVER_TOKEN,
    );
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("入口带的是空串 / 纯空白 → 同样回落（空 Token 等于没有）", async () => {
    const fallback = vi.fn(async () => SERVER_TOKEN);
    await expect(
      resolveSessionGitToken({ gitToken: "" }, fallback),
    ).resolves.toBe(SERVER_TOKEN);
    await expect(
      resolveSessionGitToken({ gitToken: "   " }, fallback),
    ).resolves.toBe(SERVER_TOKEN);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("两头都没有 → undefined（不是空串，桥里 `!gitToken` 才分得出来）", async () => {
    await expect(
      resolveSessionGitToken({}, async () => undefined),
    ).resolves.toBeUndefined();
    await expect(
      resolveSessionGitToken({ gitToken: " " }, async () => "  "),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B. readServerGitToken：读临时 config.json（假 token）
// ---------------------------------------------------------------------------

describe("B · readServerGitToken", () => {
  afterEach(() => writeServerConfig(null));

  it("config.json 不存在 → undefined，不抛", async () => {
    writeServerConfig(null);
    await expect(readServerGitToken()).resolves.toBeUndefined();
  });

  it("JSON 坏了 → undefined，不抛", async () => {
    writeServerConfig("{ not json");
    await expect(readServerGitToken()).resolves.toBeUndefined();
  });

  it("gitToken 字段缺失 / 不是字符串 → undefined", async () => {
    writeServerConfig({ apiKey: "k" });
    await expect(readServerGitToken()).resolves.toBeUndefined();
    writeServerConfig({ gitToken: 12345 });
    await expect(readServerGitToken()).resolves.toBeUndefined();
    writeServerConfig({ gitToken: { nested: SERVER_TOKEN } });
    await expect(readServerGitToken()).resolves.toBeUndefined();
  });

  it("纯空白 → undefined", async () => {
    writeServerConfig({ gitToken: "   \n" });
    await expect(readServerGitToken()).resolves.toBeUndefined();
  });

  it("正常值 → trim 后返回", async () => {
    writeServerConfig({ gitToken: `  ${SERVER_TOKEN}  ` });
    await expect(readServerGitToken()).resolves.toBe(SERVER_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// C. 端到端：resumeTaskSession → submit_mr 桥 → createMR
// ---------------------------------------------------------------------------

const sleepFree = <T>(v: T): Promise<T> => Promise.resolve(v);

const makeShipMeta = (id: string, repoPath: string): TaskMetaV06 =>
  ({
    id,
    title: `resume-git-token ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    // 持久化的会话锚点：有它才会走 resume（空闲回收后正是这个状态）
    sessionAgentId: "agent_persisted",
    currentActionId: "act_ship",
    actions: [
      {
        id: "act_ship",
        n: 1,
        type: "ship",
        status: "running",
        userInstruction: "",
        artifactPath: "actions/1-ship.md",
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [repoPath],
    gitBranches: [
      { repoPath, name: "feature/me/123-x", baseBranch: "master" },
    ],
    repoTestBranches: { [repoPath]: "test" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const submitMrAction = (repoPath: string) =>
  ({
    kind: "submit_mr" as const,
    actionId: "act_ship",
    repoPath,
    projectPath: PROJECT_PATH,
    sourceBranch: "feature/me/123-x__conflict",
    targetBranch: "test",
    title: "resume git token MR",
    description: "",
    lastCommitHash: "abc",
  }) as const;

describe("C · resumeTaskSession → submit_mr 桥拿到的 Token", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_rgt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  /** 建一个带持久化会话锚点的 ship 任务，按给定凭据恢复会话，返回注册桥用的 callerToken */
  const resumeWith = async (
    repoPath: string,
    creds: { gitToken?: string },
  ): Promise<{ id: string; callerToken: string }> => {
    const id = alloc();
    await writeMeta(makeShipMeta(id, repoPath));
    const task = (await getTask(id))!;
    const record = await resumeTaskSession(task, {
      apiKey: "fake-api-key",
      model: { id: "m", params: [] as never[] },
      ...creds,
    });
    expect(record, "resumeTaskSession 应当成功恢复（否则后面的断言没有意义）").not.toBeNull();
    return { id, callerToken: record!.callerToken as string };
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockCreateMR.mockReset();
    mockGetMRMergeStatus.mockReset();
    mockCloseOpenMR.mockReset();
    mockResume.mockImplementation(() =>
      sleepFree({ agentId: "agent_persisted", close: vi.fn(), send: vi.fn() }),
    );
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/1",
      iid: 1,
    });
    mockGetMRMergeStatus.mockResolvedValue({
      ok: true,
      hasConflicts: false,
      detailedStatus: "mergeable",
      undetermined: false,
    });
    mockCloseOpenMR.mockResolvedValue({ ok: true, closed: true });
  });

  afterEach(() => {
    writeServerConfig(null);
    for (const id of ids) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      cleanupChatTaskState(id);
      try {
        fs.rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    ids.length = 0;
  });

  it("事故复现：入口没带 gitToken、服务端 config.json 有 → 桥用服务端的提 MR", async () => {
    writeServerConfig({ gitToken: SERVER_TOKEN });
    const { id, callerToken } = await resumeWith(ORIGIN_REPO, {});

    const result = await runTaskAction(id, submitMrAction(ORIGIN_REPO), callerToken);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(mockCreateMR).toHaveBeenCalledTimes(1);
    expect(mockCreateMR.mock.calls[0]![0]).toMatchObject({
      config: { host: "git.corp.com", token: SERVER_TOKEN },
      projectPath: PROJECT_PATH,
    });
  });

  it("入口带了 gitToken → 以入口的为准（不被服务端的覆盖）", async () => {
    writeServerConfig({ gitToken: SERVER_TOKEN });
    const { id, callerToken } = await resumeWith(ORIGIN_REPO, {
      gitToken: CREDS_TOKEN,
    });

    const result = await runTaskAction(id, submitMrAction(ORIGIN_REPO), callerToken);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(mockCreateMR.mock.calls[0]![0]).toMatchObject({
      config: { host: "git.corp.com", token: CREDS_TOKEN },
    });
  });

  it("两头都没有 Token → 报「没有 GitLab Token」并指路，不调 createMR，也不再说「准入应该已被拦」", async () => {
    writeServerConfig({ apiKey: "k" }); // 有 config 但没 gitToken
    const { id, callerToken } = await resumeWith(ORIGIN_REPO, {});

    const result = await runTaskAction(id, submitMrAction(ORIGIN_REPO), callerToken);

    expect(result).toMatchObject({ ok: false });
    const error = (result as { error: string }).error;
    expect(error).toContain("GitLab Token");
    expect(error).toContain("设置页");
    expect(error).toContain("推进");
    expect(error).not.toContain("准入应该已被拦");
    // 不是 Host 的问题，别把人带去查 remote
    expect(error).not.toContain("GitLab Host");
    expect(mockCreateMR).not.toHaveBeenCalled();
  });

  it("仓库没有 origin（推不出 Host）→ 报 Host 的真原因，不是 Token 的话", async () => {
    writeServerConfig({ gitToken: SERVER_TOKEN }); // Token 是齐的
    const { id, callerToken } = await resumeWith(NO_ORIGIN_REPO, {});

    const result = await runTaskAction(
      id,
      submitMrAction(NO_ORIGIN_REPO),
      callerToken,
    );

    expect(result).toMatchObject({ ok: false });
    const error = (result as { error: string }).error;
    expect(error).toContain("GitLab Host");
    expect(error).toContain("origin");
    expect(error).not.toContain("GitLab Token");
    expect(error).not.toContain("准入应该已被拦");
    expect(mockCreateMR).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D. 接线契约
// ---------------------------------------------------------------------------

describe("D · 接线契约", () => {
  const REPO = path.resolve(import.meta.dirname, "..");
  const read = (rel: string): string =>
    fs.readFileSync(path.join(REPO, rel), "utf-8");

  it("输入条入口（task-question-inject）把 bootArgs.gitToken 传进 deliverTaskQuestion 的凭据", () => {
    const src = read("src/lib/server/task-question-inject.ts");
    const at = src.indexOf("deliverTaskQuestion(");
    expect(at, "找不到 deliverTaskQuestion 调用").toBeGreaterThan(-1);
    const call = src.slice(at, at + 900);
    expect(call).toMatch(/gitToken:\s*body\.bootArgs\?\.gitToken\?\.trim\(\)\s*\|\|\s*undefined/);
  });

  it("resumeTaskSession 构造桥时用兜底后的 token，不是直接用 creds.gitToken", () => {
    const src = read("src/lib/server/task-runner.ts");
    const at = src.indexOf("export const resumeTaskSession");
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf("export const ", at + 10);
    const body = src.slice(at, end === -1 ? undefined : end);
    expect(body).toContain("await resolveSessionGitToken(creds)");
    expect(body).not.toMatch(/gitToken:\s*creds\.gitToken/);
  });
});
