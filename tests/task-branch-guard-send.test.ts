/**
 * 分支漂移守卫 · 端到端（真 deliverTaskQuestion / deliverAskReply + 假存活会话 + 真 git）
 *
 * 用户反馈：task 在目标分支上，用户在 IDE 里切到 master，回 Flowship 让 AI 改代码，AI 直接在 master 上改。
 * 这里钉死「消息送进存活会话之前」发生了什么——不是只测守卫函数本身，而是整条 send 路径：
 *  - 隔离 worktree：agent.send 那一刻 worktree 已经被切回任务分支
 *  - in-place：不替用户切原仓，消息末尾附〈分支漂移〉提醒（在用户原文之后）
 *  - 切不回来：抛 TaskBranchGuardError、agent.send 没被调用、会话原样留着
 *  - 非属主轮 / 调用方已守过（skipBranchGuard）/ 没漂移：不加料、不切
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-branch-guard-send-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
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
vi.mock("@/lib/server/kill-orphans", () => ({ reapTaskOrphans: vi.fn() }));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));
vi.mock("@/lib/server/chat-pending", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/server/chat-pending")
  >("@/lib/server/chat-pending");
  return {
    cleanupChatTaskState: vi.fn(),
    invalidateCallerToken: vi.fn(),
    buildAgentMessage: actual.buildAgentMessage,
    cancelPending: vi.fn(),
    getPendingAsk: vi.fn(),
    setChatAwaitingNotifier: vi.fn(),
    setChatTaskActionHandler: vi.fn(),
    unsetChatAwaitingNotifierIf: vi.fn(),
    unsetChatTaskActionHandlerIf: vi.fn(),
  };
});

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  forkPendingTasks,
  pendingStopRequests,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { deliverAskReply, deliverTaskQuestion } = await import(
  "@/lib/server/task-runner"
);
const { getTask } = await import("@/lib/server/task-fs");
const { TaskBranchGuardError } = await import("@/lib/server/task-branch-guard");
const { ensureTaskWorktrees, getTaskWorkRepoPaths } = await import(
  "@/lib/server/task-worktrees"
);
const { __resetNonOwnerTurnGuardForTest } = await import(
  "@/lib/server/non-owner-turn-guard"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`task-branch-guard-send DATA_DIR 未隔离：${taskDir("probe")}`);
}
(globalThis as unknown as Record<string, Promise<void>>)[
  "__flowshipBootRecoveryPromiseV2__"
] = Promise.resolve();

const AGENT_ID = "agent_branch_guard";
const ACTION_ID = "act_branch_guard";
const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const branchOf = (dir: string): string => git(dir, "branch", "--show-current");

const initRepo = async (name: string): Promise<string> => {
  const repo = path.join(TMP_ROOT, name);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  return repo;
};

const makeMeta = (id: string, patch: Partial<TaskMetaV06> = {}): TaskMetaV06 =>
  ({
    id,
    title: "改登录",
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: ACTION_ID,
    feishuStoryUrl: "https://project.feishu.cn/x/story/detail/777777",
    actions: [
      {
        id: ACTION_ID,
        n: 1,
        type: "build",
        status: "awaiting_ack",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    sessionAgentId: AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  }) as unknown as TaskMetaV06;

const makeRun = () => ({
  id: `run_${Math.random().toString(36).slice(2, 8)}`,
  stream: async function* (): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "text", text: "好" }] } };
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

interface Probe {
  texts: string[];
  /** agent.send 被调用那一刻、各个目录所在分支（验证「先切回、后送达」的顺序） */
  branchesAtSend: Array<Record<string, string>>;
}
const installSession = (id: string, probe: Probe, watchDirs: string[] = []): void => {
  const send = vi.fn(async (text: string) => {
    probe.texts.push(text);
    probe.branchesAtSend.push(
      Object.fromEntries(watchDirs.map((d) => [d, branchOf(d)])),
    );
    return makeRun();
  });
  agentSessions.set(id, {
    instanceId: allocTaskRunInstanceId(),
    agent: { agentId: AGENT_ID, close: vi.fn(), send } as never,
    agentId: AGENT_ID,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    startSnapshot: { title: `t ${id}` },
    repoPaths: [],
  });
};
const newProbe = (): Probe => ({ texts: [], branchesAtSend: [] });

describe("消息送进存活会话前：分支漂移守卫（整条 send 路径）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    __resetNonOwnerTurnGuardForTest();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    __resetNonOwnerTurnGuardForTest();
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      forkPendingTasks.delete(id);
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

  /** in-place 任务：原仓直跑、记录了任务分支 feature/ip（本地已建）、原仓被用户切到了 main */
  const setupInPlace = async (name: string) => {
    const repo = await initRepo(name);
    git(repo, "branch", "feature/ip");
    const id = alloc();
    await writeMeta(
      makeMeta(id, {
        repoPaths: [repo],
        isolateWorktree: false,
        gitBranches: [{ repoPath: repo, name: "feature/ip", baseBranch: "main" }],
      }),
    );
    return { id, repo };
  };

  /** 隔离任务：worktree 已建好、检出任务分支，随后用户把它切到旁路分支 side-detour */
  const setupWorktree = async (name: string) => {
    const repo = await initRepo(name);
    const id = alloc();
    await writeMeta(
      makeMeta(id, {
        repoPaths: [repo],
        isolateWorktree: true,
        repoBaseBranches: { [repo]: "main" },
      }),
    );
    const task = (await getTask(id))!;
    const ensured = await ensureTaskWorktrees(task, () => true);
    const taskBranch = ensured.infos[0].name;
    const workDir = getTaskWorkRepoPaths(task)[0];
    git(repo, "branch", "side-detour", "main");
    git(workDir, "checkout", "side-detour");
    return { id, repo, workDir, taskBranch };
  };

  it("【核心回归】隔离 worktree 被切到别的分支 → agent.send 之前已切回任务分支，消息原样送达（不附提醒）", async () => {
    const { id, workDir, taskBranch } = await setupWorktree("wt-core");
    const probe = newProbe();
    installSession(id, probe, [workDir]);
    expect(branchOf(workDir)).toBe("side-detour");

    const r = await deliverTaskQuestion((await getTask(id))!, "把登录按钮改成蓝色", undefined, CREDS);

    expect(r).toBe("sent");
    expect(probe.branchesAtSend).toEqual([{ [workDir]: taskBranch }]);
    expect(probe.texts[0]).toContain("把登录按钮改成蓝色");
    expect(probe.texts[0]).not.toContain("〈分支漂移〉");
  });

  it("没漂移：不切、消息不加料", async () => {
    const { id, workDir, taskBranch } = await setupWorktree("wt-nodrift");
    git(workDir, "checkout", taskBranch);
    const probe = newProbe();
    installSession(id, probe, [workDir]);

    expect(await deliverTaskQuestion((await getTask(id))!, "随便聊聊", undefined, CREDS)).toBe("sent");
    expect(probe.branchesAtSend).toEqual([{ [workDir]: taskBranch }]);
    expect(probe.texts[0]).not.toContain("〈分支漂移〉");
  });

  it("in-place：不替用户切原仓；消息末尾（用户原文之后）附〈分支漂移〉提醒，带 checkout 命令", async () => {
    const { id, repo } = await setupInPlace("ip-core");
    const probe = newProbe();
    installSession(id, probe, [repo]);

    expect(await deliverTaskQuestion((await getTask(id))!, "加一个导出按钮", undefined, CREDS)).toBe("sent");

    // 没动用户的仓
    expect(probe.branchesAtSend).toEqual([{ [repo]: "main" }]);
    expect(branchOf(repo)).toBe("main");
    const text = probe.texts[0]!;
    expect(text).toContain("加一个导出按钮");
    expect(text).toContain("〈分支漂移〉");
    expect(text.indexOf("加一个导出按钮")).toBeLessThan(text.indexOf("〈分支漂移〉"));
    expect(text).toContain(`git -C '${repo}' checkout 'feature/ip'`);
    expect(text).toContain("只是提问");
  });

  it("切不回来：抛 TaskBranchGuardError、agent.send 一次都没调、会话还在（用户处理完可直接重发）", async () => {
    const { id, workDir, taskBranch } = await setupWorktree("wt-fail");
    // side-detour 改 a.txt 并提交；再在工作区留未提交改动 → 切回任务分支会覆盖、git 拒绝
    await fs.writeFile(path.join(workDir, "a.txt"), "side commit\n");
    git(workDir, "commit", "-am", "side change");
    await fs.writeFile(path.join(workDir, "a.txt"), "uncommitted\n");
    const probe = newProbe();
    installSession(id, probe, [workDir]);

    const err = await deliverTaskQuestion(
      (await getTask(id))!,
      "改一下文案",
      undefined,
      CREDS,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(TaskBranchGuardError);
    expect((err as Error).message).toContain(taskBranch);
    expect(probe.texts).toEqual([]);
    expect(agentSessions.has(id)).toBe(true);
    expect(branchOf(workDir)).toBe("side-detour");
    expect(await fs.readFile(path.join(workDir, "a.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("ask 答复（deliverAskReply）同样守：worktree 先切回、in-place 附提醒；skipBranchGuard=true（路由已守过）不重复", async () => {
    const wt = await setupWorktree("wt-ask");
    const wtProbe = newProbe();
    installSession(wt.id, wtProbe, [wt.workDir]);
    expect(
      await deliverAskReply((await getTask(wt.id))!, "选方案 A", undefined, ACTION_ID, CREDS),
    ).toBe("sent");
    expect(wtProbe.branchesAtSend).toEqual([{ [wt.workDir]: wt.taskBranch }]);

    const ip = await setupInPlace("ip-ask");
    const ipProbe = newProbe();
    installSession(ip.id, ipProbe, [ip.repo]);
    expect(
      await deliverAskReply((await getTask(ip.id))!, "选方案 B", undefined, ACTION_ID, CREDS),
    ).toBe("sent");
    expect(ipProbe.texts[0]).toContain("〈分支漂移〉");

    // 路由已守过 → deliver 不再守（否则提醒附两次）
    const ip2 = await setupInPlace("ip-ask-skip");
    const ip2Probe = newProbe();
    installSession(ip2.id, ip2Probe, [ip2.repo]);
    expect(
      await deliverAskReply(
        (await getTask(ip2.id))!,
        "选方案 C",
        undefined,
        ACTION_ID,
        CREDS,
        undefined,
        true,
      ),
    ).toBe("sent");
    expect(ip2Probe.texts[0]).not.toContain("〈分支漂移〉");
  });

  it("deliverTaskQuestion 的 skipBranchGuard=true（question 注入已在 curl 路径前守过）→ 不切、不附提醒", async () => {
    const { id, workDir } = await setupWorktree("wt-skip");
    const probe = newProbe();
    installSession(id, probe, [workDir]);

    expect(
      await deliverTaskQuestion(
        (await getTask(id))!,
        "已经守过了",
        undefined,
        CREDS,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        true,
      ),
    ).toBe("sent");
    // 守卫被跳过 → worktree 仍在旁路分支（由调用方负责在更早处守）
    expect(probe.branchesAtSend).toEqual([{ [workDir]: "side-detour" }]);
  });

  it("群里非属主的一轮：不碰属主的仓库（不切、不附提醒）——它只答疑", async () => {
    const { id, repo } = await setupInPlace("ip-nonowner");
    const probe = newProbe();
    installSession(id, probe, [repo]);

    expect(
      await deliverTaskQuestion(
        (await getTask(id))!,
        "[群消息·来自 李四（非任务所有者）]\n这个接口返回啥？",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        { name: "李四", guard: true },
      ),
    ).toBe("sent");
    expect(probe.texts[0]).not.toContain("〈分支漂移〉");
    expect(branchOf(repo)).toBe("main");
  });
});
