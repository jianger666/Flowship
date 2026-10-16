/**
 * 会话路径上的两件凭据安全事（S02-03 / S03-03 + S03-04）
 *
 * A. submit_mr 真实入口（resumeTaskSession → 注册的桥 → runTaskAction）的可信 host 校验：
 *    可信 host 已固定为 git.corp.com，但仓库 origin 被改成 evil.example（agent 可写 `.git/config`），
 *    agent 随后调 submit_mr——桥里必须在构造请求之前拒绝，createMR / fetch 零调用。
 * B. token 环境变量同步：会话恢复路径（resumeTaskSession）拿到 token 后，
 *    `process.env.FLOWSHIP_GITLAB_TOKEN` 就位（agent shell 靠它调 GitLab API）；没有 token 时清掉、不留陈旧值。
 * C. 接线契约：internalStartAgent 在 Agent.create 之前固定可信 host + 同步 env；
 *    chat-runner 的会话启动 / 恢复同步 env、pin；提示词用 resolveGitHostForPrompt。
 *    （advanceTask 全链 mock 面过大，这些点位用源码契约钉顺序；真入口只跑得动 resume 路径。）
 *
 * 只用假 token；数据目录是临时目录；env 变量在每个用例后还原。
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

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fe-session-git-trust-"));
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

// gitlab-client 包成「真实现 + spy」：spy 没被调用 = 桥自己拦住；fetch 没被调用 = 没任何请求发出
vi.mock("@/lib/server/gitlab-client", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/server/gitlab-client");
  return {
    ...actual,
    createMR: vi.fn(actual.createMR),
    getMRMergeStatus: vi.fn(actual.getMRMergeStatus),
    closeOpenMR: vi.fn(actual.closeOpenMR),
  };
});

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
const { resumeTaskSession } = await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const gitlabClient = await import("@/lib/server/gitlab-client");
const { GITLAB_TOKEN_ENV_NAME } = await import("@/lib/server/git-token-env");
const trusted = await import("@/lib/server/trusted-git-host");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`session-git-trust DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}
await listTasks();

const createMRSpy = gitlabClient.createMR as unknown as ReturnType<typeof vi.fn>;
const mergeStatusSpy = gitlabClient.getMRMergeStatus as unknown as ReturnType<typeof vi.fn>;
const closeOpenMRSpy = gitlabClient.closeOpenMR as unknown as ReturnType<typeof vi.fn>;

// ---- 假数据 ----
const SERVER_TOKEN = "glpat-FAKE-SESSION-SERVER-TOKEN";
const CREDS_TOKEN = "glpat-FAKE-SESSION-CREDS-TOKEN";
const STALE_TOKEN = "glpat-FAKE-SESSION-STALE-TOKEN";
const GOOD_HOST = "git.corp.com";
const EVIL_HOST = "evil.example";
const PROJECT_PATH = "group/proj";
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const ORIGINAL_ENV_TOKEN = process.env[GITLAB_TOKEN_ENV_NAME];

const writeServerConfig = (cfg: Record<string, unknown> | null): void => {
  if (cfg === null) {
    fs.rmSync(CONFIG_FILE, { force: true });
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg), "utf-8");
};

let GOOD_REPO = "";
let EVIL_REPO = "";

beforeAll(() => {
  const mk = (name: string, remote: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `session-trust-${name}-`));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
    return dir;
  };
  GOOD_REPO = mk("good", `git@${GOOD_HOST}:${PROJECT_PATH}.git`);
  EVIL_REPO = mk("evil", `git@${EVIL_HOST}:${PROJECT_PATH}.git`);
});

afterAll(() => {
  for (const dir of [GOOD_REPO, EVIL_REPO, TMP_ROOT]) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  if (ORIGINAL_ENV_TOKEN === undefined) delete process.env[GITLAB_TOKEN_ENV_NAME];
  else process.env[GITLAB_TOKEN_ENV_NAME] = ORIGINAL_ENV_TOKEN;
});

// ---------------------------------------------------------------------------
// 会话 harness
// ---------------------------------------------------------------------------

const makeShipMeta = (id: string, repoPath: string): TaskMetaV06 =>
  ({
    id,
    title: `session-git-trust ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
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
    gitBranches: [{ repoPath, name: "feature/me/123-x", baseBranch: "master" }],
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
    title: "session trust MR",
    description: "",
    lastCommitHash: "abc",
  }) as const;

const ids: string[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

const resumeWith = async (
  repoPath: string,
  creds: { gitToken?: string } = {},
): Promise<{ id: string; callerToken: string }> => {
  const id = `t_sgt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await writeMeta(makeShipMeta(id, repoPath));
  const task = (await getTask(id))!;
  const record = await resumeTaskSession(task, {
    apiKey: "fake-api-key",
    model: { id: "m", params: [] as never[] },
    ...creds,
  });
  expect(record, "resumeTaskSession 应当成功恢复").not.toBeNull();
  return { id, callerToken: record!.callerToken as string };
};

beforeEach(() => {
  mockCreate.mockReset();
  mockResume.mockReset();
  mockResume.mockImplementation(async () => ({
    agentId: "agent_persisted",
    close: vi.fn(),
    send: vi.fn(),
  }));
  for (const spy of [createMRSpy, mergeStatusSpy, closeOpenMRSpy]) spy.mockReset();
  fs.rmSync(trusted.trustedGitHostFilePath(), { force: true });
  writeServerConfig({ gitToken: SERVER_TOKEN });
  delete process.env[GITLAB_TOKEN_ENV_NAME];
  // 任何真实请求都让用例失败；零调用断言才可信
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("测试里不该发起任何真实网络请求"));
});

afterEach(() => {
  vi.restoreAllMocks();
  writeServerConfig(null);
  if (ORIGINAL_ENV_TOKEN === undefined) delete process.env[GITLAB_TOKEN_ENV_NAME];
  else process.env[GITLAB_TOKEN_ENV_NAME] = ORIGINAL_ENV_TOKEN;
  for (const id of ids.splice(0)) {
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
});

// ---------------------------------------------------------------------------
// A. submit_mr 真实入口
// ---------------------------------------------------------------------------

describe("A · submit_mr：origin 被改成 evil 时不外发 PAT", () => {
  it("可信 host 已固定为 git.corp.com、仓库 origin 指向 evil → 拒绝并给出可操作文案；createMR / 兜底 / fetch 全零调用", async () => {
    trusted.pinTrustedGitHostIfAbsent(GOOD_HOST, "settings");
    const { id, callerToken } = await resumeWith(EVIL_REPO);

    const result = await runTaskAction(id, submitMrAction(EVIL_REPO), callerToken);

    expect(result).toMatchObject({ ok: false });
    const error = (result as { error: string }).error;
    expect(error).toContain(GOOD_HOST); // 已固定的可信 host
    expect(error).toContain(EVIL_HOST); // 被拒的 host
    expect(error).toContain("为防止 GitLab Token 外发已拒绝");
    expect(error).toContain(trusted.trustedGitHostFilePath());
    expect(error).not.toContain(SERVER_TOKEN);
    expect(createMRSpy).not.toHaveBeenCalled();
    expect(mergeStatusSpy).not.toHaveBeenCalled();
    expect(closeOpenMRSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("origin 与固定值一致 → 放行：createMR 收到可信 host + 会话 token（证明校验没误杀）", async () => {
    trusted.pinTrustedGitHostIfAbsent(GOOD_HOST, "settings");
    createMRSpy.mockResolvedValue({
      ok: true,
      url: `https://${GOOD_HOST}/${PROJECT_PATH}/-/merge_requests/1`,
      iid: 1,
    });
    mergeStatusSpy.mockResolvedValue({
      ok: true,
      hasConflicts: false,
      detailedStatus: "mergeable",
      undetermined: false,
    });
    closeOpenMRSpy.mockResolvedValue({ ok: true, closed: true });
    const { id, callerToken } = await resumeWith(GOOD_REPO);

    const result = await runTaskAction(id, submitMrAction(GOOD_REPO), callerToken);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(createMRSpy).toHaveBeenCalledTimes(1);
    expect(createMRSpy.mock.calls[0]![0]).toMatchObject({
      config: { host: GOOD_HOST, token: SERVER_TOKEN },
    });
  });

  it("配了白名单且 origin 不在其中 → 同样拒绝、零调用", async () => {
    writeServerConfig({ gitToken: SERVER_TOKEN, gitHostAllowlist: ["other.corp.com"] });
    const { id, callerToken } = await resumeWith(GOOD_REPO);

    const result = await runTaskAction(id, submitMrAction(GOOD_REPO), callerToken);

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("gitHostAllowlist");
    expect(createMRSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("固定文件损坏 → fail-closed：拒绝、零调用", async () => {
    fs.writeFileSync(trusted.trustedGitHostFilePath(), "{ nope", "utf-8");
    const { id, callerToken } = await resumeWith(GOOD_REPO);

    const result = await runTaskAction(id, submitMrAction(GOOD_REPO), callerToken);

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("fail-closed");
    expect(createMRSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B. token 环境变量同步（会话恢复路径）
// ---------------------------------------------------------------------------

describe("B · resumeTaskSession 之后 process.env.FLOWSHIP_GITLAB_TOKEN 就位", () => {
  it("入口没带 token、服务端 config.json 有 → env 是服务端的", async () => {
    await resumeWith(GOOD_REPO, {});
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(SERVER_TOKEN);
  });

  it("入口带了 token（带首尾空白）→ env 是入口的（trim 后），不被服务端覆盖", async () => {
    await resumeWith(GOOD_REPO, { gitToken: `  ${CREDS_TOKEN}\n` });
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(CREDS_TOKEN);
  });

  it("两头都没有 token → env 被清掉（不能留着上一个会话的陈旧值）", async () => {
    writeServerConfig({ apiKey: "k" });
    process.env[GITLAB_TOKEN_ENV_NAME] = STALE_TOKEN;

    await resumeWith(GOOD_REPO, {});

    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBeUndefined();
  });

  it("纯空白的 token 视同没有（清 env、不写空串）", async () => {
    writeServerConfig({ gitToken: "   " });
    process.env[GITLAB_TOKEN_ENV_NAME] = STALE_TOKEN;

    await resumeWith(GOOD_REPO, {});

    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. 接线契约（源码顺序）
// ---------------------------------------------------------------------------

describe("C · 接线契约", () => {
  const REPO = path.resolve(import.meta.dirname, "..");
  const read = (rel: string): string =>
    fs.readFileSync(path.join(REPO, rel), "utf-8");

  /** 取 `export const <name>` / `const <name>` 到下一个顶层声明之间的源码 */
  const fnBody = (src: string, startMarker: string): string => {
    const at = src.indexOf(startMarker);
    expect(at, `找不到 ${startMarker}`).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport const ", at + 10);
    return src.slice(at, next === -1 ? undefined : next);
  };

  it("internalStartAgent：Agent.create 之前先固定可信 host、同步 token env；提示词用 resolveGitHostForPrompt", () => {
    const body = fnBody(
      read("src/lib/server/task-runner.ts"),
      "const internalStartAgent = async",
    );
    const create = body.indexOf("Agent.create(");
    const pin = body.indexOf('pinTrustedGitHostIfAbsent(effectiveGitHost, "session")');
    const sync = body.indexOf("await syncSessionGitTokenEnv(");
    expect(create).toBeGreaterThan(-1);
    expect(pin).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(create);
    expect(sync).toBeLessThan(create);
    expect(body).toContain("resolveGitHostForPrompt(effectiveGitHost)");
    expect(body).toContain("untrustedOriginHost: gitTrust.untrustedOriginHost");
  });

  it("submit_mr 桥：Token 缺失检查之后、校验任务元数据之前，先 assertTrustedGitHost(gitHost)", () => {
    const src = read("src/lib/server/task-runner.ts");
    const at = src.indexOf("assertTrustedGitHost(gitHost)");
    expect(at, "submit_mr 桥里缺 assertTrustedGitHost(gitHost)").toBeGreaterThan(-1);
    const after = src.slice(at, at + 2500);
    // 校验之后才允许走到真正提 MR
    expect(src.indexOf("createMR({", at)).toBeGreaterThan(at);
    expect(after).toContain("提测被拦截");
  });

  it("chat-runner：会话启动 / 恢复都同步 token env；GitLab 访问提示用 resolveGitHostForPrompt + 固定", () => {
    const src = read("src/lib/server/chat-runner.ts");
    const occurrences = src.split("syncGitTokenEnvFromSettingsResult(settingsResult)").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(src).toContain('pinTrustedGitHostIfAbsent(effectiveHost, "session")');
    expect(src).toContain("resolveGitHostForPrompt(effectiveHost)");
  });

  it("设置保存 route：PUT 之后同步 env + 固定可信 host（用 guarded 的盘上真值，不用 body）", () => {
    const src = read("src/app/api/settings/route.ts");
    expect(src).toContain("syncGitTokenEnv(guarded.gitToken)");
    expect(src).toContain('pinTrustedGitHostFromSettings(guarded, "settings")');
  });

  it("启动期：instrumentation 同步 env、boot-warmup 固定可信 host", () => {
    expect(read("src/instrumentation-node.ts")).toContain(
      "syncGitTokenEnvFromSettingsResult",
    );
    expect(read("src/lib/server/boot-warmup.ts")).toContain(
      'pinTrustedGitHostFromSettings(result.settings, "boot")',
    );
  });
});
