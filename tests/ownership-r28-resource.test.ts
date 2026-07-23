/**
 * Ownership R28-1：ResourceJob——resource lease 贯穿真实启动链与 worktree 全生命周期
 *
 * 覆盖：
 * ① hot checkout 挂起 × finalize → checkout 不执行、调用方让位不起 agent
 * ② beforeDepClone 挂起 × finalize → 后续 dep 不 clone、本轮新建 worktree 补偿移除
 * ③ 让位不吞：ensure 让位后 advance 链不 upsertGitBranch、无 info event
 * ④ finalize join：resource job 在飞时 finalizeTask 等待 job 结束后才清目录
 * ⑤ prewarm 回归（R27-2 既有语义不回退）
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs";
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r28-"));
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
vi.mock("@/lib/server/update-pending", () => ({
  assertNoUpdatePendingRestart: async () => {},
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  clearResourceJobs,
  clearTaskStarting,
  hasResourceJobs,
  isWorkspaceQuarantined,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { clearChatGate, getChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { cleanupChatTaskState } = await import("@/lib/server/chat-pending");
const {
  advanceTask,
  finalizeTask,
  prewarmTaskWorkspace,
  TASK_OP_STALE_HTTP_MESSAGE,
} = await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  getTaskWorktreesDir,
  WorktreeLeaseLostError,
} = await import("@/lib/server/task-worktrees");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r28-resource DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
  gitToken: undefined as string | undefined,
};

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const raceExpectSettled = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
  const result = await Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`Promise 未在 ${ms}ms 内 settle`);
    }),
  ]);
  return result as T;
};

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

/** 初始化带一次 commit 的真实 git 仓（main） */
const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "r28@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r28"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const makeMeta = (id: string, repo: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r28 ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [repo],
    isolateWorktree: true,
    repoBaseBranches: { [repo]: "main" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const gitShowCurrent = (cwd: string): string =>
  execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
    encoding: "utf-8",
  }).trim();

describe("ownership R28-1 ResourceJob", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r28_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    clearFailpoints();
  });

  afterEach(() => {
    clearFailpoints();
    for (const id of ids.splice(0)) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      clearTaskStarting(id);
      clearResourceJobs(id);
      clearChatGate(id);
      cleanupChatTaskState(id);
      try {
        rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });

  // ─────────────────────────────────────────────────────────────
  // ① hot checkout × finalize → checkout 不执行、不起 agent
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-1①：ensure.beforeHotCheckout 挂起 × finalize → checkout 不执行、让位",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r28-hot-"));
      initGitRepo(repo);
      // 旁支：用于把 worktree 切走，触发 hot checkout
      execFileSync("git", ["-C", repo, "branch", "other-branch"]);

      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r28-hot", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      // 先建好 worktree（任务分支）
      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0];
      expect(gitShowCurrent(workDir)).toBe("feat/r28-hot");
      // 手动切走 → 下次 ensure 必走 hot checkout
      execFileSync("git", ["-C", workDir, "checkout", "other-branch"]);
      expect(gitShowCurrent(workDir)).toBe("other-branch");

      let leaseOk = true;
      const hang = installHangingFailpoint("ensure.beforeHotCheckout");
      const p = ensureTaskWorktrees(task, () => leaseOk).catch(
        (err: unknown) => err,
      );
      await hang.waitHit();
      // 模拟 finalize revoke：lease 失效（先 release 再等 ensure，避免 join 死锁）
      leaseOk = false;
      hang.release();
      const settled = await raceExpectSettled(p, 15_000);
      expect(settled).toBeInstanceOf(WorktreeLeaseLostError);
      // checkout 未执行——仍停在 other-branch
      expect(gitShowCurrent(workDir)).toBe("other-branch");
    },
    30_000,
  );

  it(
    "R28-1①b：advance 第二段 ensure.beforeMkdir（internalStartAgent 链）× finalize → 不起 agent",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r28-isa-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      await writeMeta(meta);

      // 预热建好 worktree，advance 首段 ensure 秒过；第二段 = internalStartAgent
      await ensureTaskWorktrees((await getTask(id))!, () => true);

      let mkdirHits = 0;
      let hitResolve!: () => void;
      const hit = new Promise<void>((r) => {
        hitResolve = r;
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      setFailpoint("ensure.beforeMkdir", async () => {
        mkdirHits++;
        // 第 1 次：advance 入口 ensure；第 2 次：internalStartAgent → ensureWorkspaceReady
        if (mkdirHits < 2) return;
        hitResolve();
        await gate;
      });

      mockCreate.mockImplementation(() => {
        throw new Error("Agent.create 不应被调用（R28-1 让位）");
      });

      const pAdvance = advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "r28 isa",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }).catch((err: unknown) => err);

      await raceExpectSettled(hit, 15_000);
      // finalize 先占 finalizing + revoke，再 join；等 lifecycle 后再 release
      const pFin = finalizeTask(id, "abandoned");
      const lifeDeadline = Date.now() + 5000;
      while (Date.now() < lifeDeadline) {
        if (getChatLifecycle(id) === "finalizing") break;
        await sleep(20);
      }
      release();
      await raceExpectSettled(pFin, 20_000);
      const settled = await raceExpectSettled(pAdvance, 20_000);
      expect(settled).toBeInstanceOf(Error);
      expect((settled as Error).message).toBe(TASK_OP_STALE_HTTP_MESSAGE);
      expect(mockCreate).not.toHaveBeenCalled();
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ② beforeDepClone × finalize → 补偿移除新建 worktree
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-1②：ensure.beforeDepClone 挂起 × lease 失效 → 抛让位、补偿移除新建 worktree",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r28-dep-"));
      initGitRepo(repo);
      // 造可克隆的 dep 源，确保走进 beforeDepClone
      await fs.mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
      writeFileSync(path.join(repo, "node_modules", "pkg", "i.js"), "1");

      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r28-dep", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      let leaseOk = true;
      const hang = installHangingFailpoint("ensure.beforeDepClone");
      const p = ensureTaskWorktrees(task, () => leaseOk).catch(
        (err: unknown) => err,
      );
      await hang.waitHit();
      // add 已成功、正要 clone 第一单元——失主
      leaseOk = false;
      hang.release();
      const settled = await raceExpectSettled(p, 30_000);
      expect(settled).toBeInstanceOf(WorktreeLeaseLostError);

      const list = execFileSync("git", ["-C", repo, "worktree", "list"], {
        encoding: "utf-8",
      });
      expect(list.includes(id)).toBe(false);
      const wtRoot = getTaskWorktreesDir(id);
      if (await fs.stat(wtRoot).then(() => true, () => false)) {
        const kids = await fs.readdir(wtRoot);
        expect(kids).toHaveLength(0);
      }
    },
    45_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③ 让位不吞：advance 不 upsert、无 info
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-1③：ensure 让位后 advance 不 upsertGitBranch、无创建 info",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r28-adv-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      await writeMeta(meta);

      const hang = installHangingFailpoint("ensure.beforeWorktreeAdd");
      const pAdvance = advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "r28 yield",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }).catch((err: unknown) => err);

      await hang.waitHit();
      // finalize 先 revoke，再 release——确保 ensure 恢复后 lease 已失效
      const pFin = finalizeTask(id, "abandoned");
      const lifeDeadline = Date.now() + 5000;
      while (Date.now() < lifeDeadline) {
        if (getChatLifecycle(id) === "finalizing") break;
        await sleep(20);
      }
      hang.release();
      await raceExpectSettled(pFin, 20_000);
      const settled = await raceExpectSettled(pAdvance, 20_000);
      expect(settled).toBeInstanceOf(Error);
      expect((settled as Error).message).toBe(TASK_OP_STALE_HTTP_MESSAGE);

      // 让位后不得落 gitBranches / 创建 info
      expect((await readMetaV06(id))?.gitBranches ?? []).toHaveLength(0);
      const events = await readEvents(id);
      expect(
        events.filter(
          (e) =>
            e.kind === "info" &&
            typeof e.text === "string" &&
            e.text.includes("已创建任务隔离工作区"),
        ),
      ).toHaveLength(0);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ④ finalize join：resource job 在飞时等待（R30-2：归零后才清；超时则 quarantine 而非开闸）
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-1④：resource job 在飞时 finalizeTask join 等待（job 结束后才清目录；无 quarantine 误伤）",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r28-join-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r28-join", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      // 先建好 worktree，再走 hot checkout 挂起（job 登记已在 ensure 内）
      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0];
      execFileSync("git", ["-C", repo, "branch", "side-join"]);
      execFileSync("git", ["-C", workDir, "checkout", "side-join"]);

      const hang = installHangingFailpoint("ensure.beforeHotCheckout");
      let leaseOk = true;
      const pEnsure = ensureTaskWorktrees(task, () => leaseOk).catch(
        (err: unknown) => err,
      );
      await hang.waitHit();
      expect(hasResourceJobs(id)).toBe(true);

      // finalize 应卡住直到我们释放 ensure（resource job 归零）——
      // R30-2 加强：归零前不开闸；本用例在超时前归零，故无 quarantine
      let finalizeDone = false;
      const pFin = finalizeTask(id, "abandoned").then(() => {
        finalizeDone = true;
      });

      // 给 finalize 一点时间进入 join 轮询
      await sleep(200);
      expect(finalizeDone).toBe(false);
      // worktree 目录此时仍在（finalize 还没清）
      expect(
        await fs.stat(workDir).then(() => true, () => false),
      ).toBe(true);
      expect(isWorkspaceQuarantined(id)).toBe(false);

      leaseOk = false;
      hang.release();
      await raceExpectSettled(pEnsure, 10_000);
      await raceExpectSettled(pFin, 15_000);
      expect(finalizeDone).toBe(true);
      expect(hasResourceJobs(id)).toBe(false);
      // R30-2：快速归零路径不得残留 quarantine（加强，非弱化）
      expect(isWorkspaceQuarantined(id)).toBe(false);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ⑤ prewarm 回归
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-1⑤：prewarm.beforeWorktreeAdd × finalize → 让位、无预热 info（R27-2 不回退）",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r28-pw-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      await writeMeta(meta);

      const hang = installHangingFailpoint("prewarm.beforeWorktreeAdd");
      prewarmTaskWorkspace(id);
      await hang.waitHit();
      // R28-1：等 finalizing 再 release——stillPrewarm 必假、不调 ensure
      const pFin = finalizeTask(id, "abandoned");
      const deadlineLife = Date.now() + 5000;
      while (Date.now() < deadlineLife) {
        if (getChatLifecycle(id) === "finalizing") break;
        await sleep(20);
      }
      hang.release();
      await raceExpectSettled(pFin, 15_000);

      // fire-and-forget：轮询确认无预热 info、无 gitBranches
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const events = await readEvents(id);
        const warmInfo = events.filter(
          (e) =>
            e.kind === "info" &&
            typeof e.text === "string" &&
            e.text.includes("后台预热"),
        );
        const disk = await readMetaV06(id);
        if (
          warmInfo.length === 0 &&
          (disk?.gitBranches ?? []).length === 0 &&
          disk?.repoStatus === "abandoned"
        ) {
          break;
        }
        await sleep(50);
      }
      const events = await readEvents(id);
      expect(
        events.filter(
          (e) =>
            e.kind === "info" &&
            typeof e.text === "string" &&
            e.text.includes("后台预热"),
        ),
      ).toHaveLength(0);
      expect((await readMetaV06(id))?.gitBranches ?? []).toHaveLength(0);
    },
    25_000,
  );

  it("R28-1：WorktreeLeaseLostError 冒泡（不吞成空结果）", async () => {
    const id = alloc();
    const repo = mkdtempSync(path.join(TMP_ROOT, "r28-noswallow-"));
    initGitRepo(repo);
    const task = {
      id,
      mode: "task",
      isolateWorktree: true,
      repoPaths: [repo],
      gitBranches: [
        { repoPath: repo, name: "feat/r28-ns", baseBranch: "main" },
      ],
      repoBaseBranches: { [repo]: "main" },
      actions: [],
      mrs: [],
    } as unknown as Task;

    await expect(
      ensureTaskWorktrees(task, () => false),
    ).rejects.toBeInstanceOf(WorktreeLeaseLostError);
  });
});
