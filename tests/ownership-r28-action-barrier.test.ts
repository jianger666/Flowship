/**
 * Ownership R28-4：ActionSideEffectCoordinator——同 action 并发屏障 + MR 双投影单事务
 *
 * ① createMR pending × submit_work → check 等待、submit_mr 完成后才启动
 * ② beforeLocalCommit 挂起 × action 切换 → 两份投影都不落（无半状态）
 * ③ post-check 在飞 × submit_mr 入场 → 拒绝且不 abort check
 * ④ 正常路径：两份投影原子可见、mrVersion 一致
 *
 * 屏障语义选择：submit_work **等待** 在飞 submit_mr（~120s deadline、超时 warn 后按现状启 check）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r28-barrier-"));
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

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
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));

const mockRunActionCheck = vi.fn(async () => ({
  passed: true,
  details: "ok",
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: () => mockRunActionCheck(),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  allocTaskRunInstanceId,
  runningChecks,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  cleanupChatTaskState,
  runTaskAction,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { buildSessionBridges } = await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const {
  clearActionSideEffects,
  hasActionSideEffect,
} = await import("@/lib/server/action-side-effects");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r28-action-barrier DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
let SUBMIT_REPO = "";

beforeAll(() => {
  SUBMIT_REPO = mkdtempSync(path.join(os.tmpdir(), "ownership-r28-submit-"));
  execFileSync("git", ["init"], { cwd: SUBMIT_REPO });
  execFileSync("git", ["remote", "add", "origin", REMOTE_URL], {
    cwd: SUBMIT_REPO,
  });
});

afterAll(() => {
  if (SUBMIT_REPO) {
    rmSync(SUBMIT_REPO, { recursive: true, force: true });
  }
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r28-barrier ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

/** ship + running：submit_mr / submit_work 真链用 */
const seedShipRunning = async (id: string): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus = "running";
  meta.currentActionId = "act_ship";
  meta.repoPaths = [SUBMIT_REPO];
  meta.gitBranches = [
    {
      repoPath: SUBMIT_REPO,
      name: "feature/me/123-x",
      baseBranch: "master",
    },
  ] as TaskMetaV06["gitBranches"];
  meta.repoTestBranches = {
    [SUBMIT_REPO]: "test",
  } as TaskMetaV06["repoTestBranches"];
  meta.actions = [
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
  ] as TaskMetaV06["actions"];
  await writeMeta(meta);
};

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

const raceExpectSettled = async (
  operation: Promise<unknown>,
  ms: number,
): Promise<void> => {
  const winner = await Promise.race([
    operation.then(
      () => "op" as const,
      () => "op" as const,
    ),
    sleep(ms).then(() => "timeout" as const),
  ]);
  expect(winner).toBe("op");
};

const installHangingFailpoint = (name: string) => {
  let hit = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    hit = true;
    await gate;
  });
  return {
    wasHit: () => hit,
    release: () => release(),
    waitHit: () => waitUntil(() => hit),
  };
};

const registerBridgesForTest = (
  task: Task,
  opts: { callerToken: string; gitToken?: string },
) => {
  const bridges = buildSessionBridges(task, opts);
  setChatTaskActionHandler(
    task.id,
    bridges.taskActionHandler,
    opts.callerToken,
  );
  setChatAwaitingNotifier(
    task.id,
    bridges.awaitingNotifier,
    opts.callerToken,
  );
  return bridges;
};

const submitMrArgs = () =>
  ({
    kind: "submit_mr" as const,
    actionId: "act_ship",
    repoPath: SUBMIT_REPO,
    projectPath: PROJECT_PATH,
    sourceBranch: "feature/me/123-x",
    targetBranch: "test",
    title: "R28-4 MR",
    description: "",
    lastCommitHash: "hash_r28_4",
  });

describe("ownership R28-4 ActionSideEffectCoordinator", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r28b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockCreateMR.mockReset();
    mockGetMRMergeStatus.mockReset();
    mockCloseOpenMR.mockReset();
    mockRunActionCheck.mockReset();
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/42",
      iid: 42,
    });
    mockGetMRMergeStatus.mockResolvedValue({
      ok: true,
      hasConflicts: false,
      detailedStatus: "mergeable",
      undetermined: false,
    });
    mockCloseOpenMR.mockResolvedValue({ ok: true, closed: false });
    mockRunActionCheck.mockResolvedValue({ passed: true, details: "ok" });
    clearFailpoints();
  });

  afterEach(async () => {
    clearFailpoints();
    for (const id of ids) {
      clearActionSideEffects(id);
      runningChecks.delete(id);
      cleanupChatTaskState(id);
      clearChatGate(id);
    }
    ids.length = 0;
  });

  // ─────────────────────────────────────────────────────────────
  // ① createMR pending × submit_work → check 等待
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-4 屏障：createMR pending × submit_work → check 等待、完成后启动",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      const { awaitingNotifier } = registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r28-1",
      });

      const hangCreate = installHangingFailpoint("mcp.submitMr.beforeCreateMR");
      const pMr = runTaskAction(id, submitMrArgs(), token);
      await hangCreate.waitHit();
      // begin 已登记、createMR 未调
      expect(hasActionSideEffect(id, "act_ship")).toBe(true);
      expect(mockCreateMR).not.toHaveBeenCalled();

      const hangCheckStart = installHangingFailpoint(
        "mcp.submitWork.beforeCheckStart",
      );
      const pWork = Promise.resolve(
        awaitingNotifier(
          {
            kind: "awaiting_start",
            actionId: "act_ship",
            artifactPath: "actions/1-ship.md",
          },
          { callerStillValid: () => true },
        ),
      );
      await hangCheckStart.waitHit();
      // 屏障检查前：check 尚未启动
      expect(runningChecks.get(id)).toBeUndefined();
      expect(mockRunActionCheck).not.toHaveBeenCalled();

      // 放行屏障检查入口 → 进入 waitForActionSideEffectClear（createMR 仍挂）
      hangCheckStart.release();
      await sleep(80);
      expect(runningChecks.get(id)).toBeUndefined();
      expect(mockRunActionCheck).not.toHaveBeenCalled();
      expect(hasActionSideEffect(id, "act_ship")).toBe(true);

      // 放行 createMR → submit_mr 完成 → end → wait 退出 → check 启动
      hangCreate.release();
      await raceExpectSettled(pMr, 12_000);
      const mrResult = await pMr;
      expect(mrResult).toMatchObject({ ok: true });
      expect((mrResult as { data?: { skipped_local?: boolean } }).data?.skipped_local).toBeFalsy();

      await raceExpectSettled(pWork, 12_000);
      // runActionPostCheck 同步挂 runningChecks，runActionCheck 在 getTask await 后才调
      await waitUntil(() => runningChecks.get(id)?.actionId === "act_ship", 5000);
      await waitUntil(() => mockRunActionCheck.mock.calls.length > 0, 5000);
      expect(hasActionSideEffect(id, "act_ship")).toBe(false);

      // 双投影已落（check 读到的应有 MR）
      const disk = await readMetaV06(id);
      expect(disk?.mrs ?? []).toHaveLength(1);
      const sideMrs =
        disk?.actions.find((a) => a.id === "act_ship")?.sideEffects?.mrs ?? [];
      expect(sideMrs).toHaveLength(1);
      expect(sideMrs[0]?.mrVersion).toBe(disk?.mrs?.[0]?.version);
    },
    25_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ② beforeLocalCommit × action 切换 → 无半状态
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-4 单事务：beforeLocalCommit 挂起 × action 切换 → 两份投影都不落",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r28-2",
      });

      const hang = installHangingFailpoint("mcp.submitMr.beforeLocalCommit");
      const pMr = runTaskAction(id, submitMrArgs(), token);
      await hang.waitHit();
      // createMR 已成功、本地尚未写——挂起窗口内两份投影都无
      expect(mockCreateMR).toHaveBeenCalled();
      let disk = await readMetaV06(id);
      expect(disk?.mrs ?? []).toHaveLength(0);
      expect(
        disk?.actions.find((a) => a.id === "act_ship")?.sideEffects?.mrs ?? [],
      ).toHaveLength(0);

      // 注入 action 切换（模拟 stop/advance 把 ship 切出 running）
      const meta = (await readMetaV06(id))!;
      meta.actions = meta.actions.map((a) =>
        a.id === "act_ship"
          ? { ...a, status: "awaiting_ack" as const, endedAt: Date.now() }
          : a,
      );
      meta.updatedAt = Date.now();
      await writeMeta(meta);

      hang.release();
      await raceExpectSettled(pMr, 12_000);
      const result = await pMr;
      expect(result).toMatchObject({
        ok: true,
        data: { skipped_local: true },
      });

      disk = await readMetaV06(id);
      // 无半状态：task.mrs 与 action.sideEffects.mrs 都无
      expect(disk?.mrs ?? []).toHaveLength(0);
      expect(
        disk?.actions.find((a) => a.id === "act_ship")?.sideEffects?.mrs ?? [],
      ).toHaveLength(0);
      expect(hasActionSideEffect(id, "act_ship")).toBe(false);
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③ post-check 在飞 × submit_mr → 拒、不 abort check
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-4 反向屏障：post-check 在飞 × submit_mr → 拒绝且不 abort check",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r28-3",
      });

      const abortSpy = vi.fn();
      const controller = {
        abort: abortSpy,
        signal: { aborted: false },
      } as unknown as AbortController;
      const checkSelf = { actionId: "act_ship", controller };
      runningChecks.set(id, checkSelf);

      const result = await runTaskAction(id, submitMrArgs(), token);
      expect(result).toMatchObject({ ok: false });
      expect(String((result as { error?: string }).error ?? "")).toMatch(
        /正在收尾检查|稍后重试/,
      );
      expect(mockCreateMR).not.toHaveBeenCalled();
      expect(abortSpy).not.toHaveBeenCalled();
      expect(runningChecks.get(id)).toBe(checkSelf);
      expect(hasActionSideEffect(id, "act_ship")).toBe(false);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ④ 正常路径回归：双投影原子可见、mrVersion 一致
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-4 正常路径：submit_mr 成功后两份投影原子可见、mrVersion 一致",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r28-4",
      });

      const result = await runTaskAction(id, submitMrArgs(), token);
      expect(result).toMatchObject({
        ok: true,
        data: {
          mr_url: "https://git.corp.com/group/proj/-/merge_requests/42",
          mr_iid: 42,
          mr_version: 1,
          has_conflicts: false,
        },
      });
      expect(
        (result as { data?: { skipped_local?: boolean } }).data?.skipped_local,
      ).toBeFalsy();

      const disk = await readMetaV06(id);
      expect(disk?.mrs).toHaveLength(1);
      expect(disk?.mrs?.[0]).toMatchObject({
        repoPath: SUBMIT_REPO,
        targetBranch: "test",
        url: "https://git.corp.com/group/proj/-/merge_requests/42",
        version: 1,
        branch: "feature/me/123-x",
      });
      const sideMrs =
        disk?.actions.find((a) => a.id === "act_ship")?.sideEffects?.mrs ?? [];
      expect(sideMrs).toHaveLength(1);
      expect(sideMrs[0]).toMatchObject({
        repoPath: SUBMIT_REPO,
        targetBranch: "test",
        mrUrl: "https://git.corp.com/group/proj/-/merge_requests/42",
        mrVersion: 1,
        branch: "feature/me/123-x",
        commitHash: "hash_r28_4",
      });
      // mrVersion 与 task.mrs.version 一致（单事务同源）
      expect(sideMrs[0]?.mrVersion).toBe(disk?.mrs?.[0]?.version);
      expect(hasActionSideEffect(id, "act_ship")).toBe(false);
    },
    15_000,
  );
});
