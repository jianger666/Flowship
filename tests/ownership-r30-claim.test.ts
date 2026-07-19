/**
 * Ownership R30：R29-1 单一 action claim 状态机 + R29-5 notifier 结构化返回
 *
 * ① submit_work 停在 barrier 返回后（beforeAbortCheck）× submit_mr 抢入
 *    → 任何时刻最多一类副作用；submit_mr 被 claim 拒
 * ② 同 caller 旧 actionId 重试 submit_work → 工具 stale 文案、非 submitted
 * ③ busy（MR 在飞超时）→ 重试文案
 * ④ 正常链：MR 完成后 submit_work claim 成功启 check、check 结束 release
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r30-claim-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

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
const { allocTaskRunInstanceId, runningChecks } = await import(
  "@/lib/server/task-stream"
);
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  cleanupChatTaskState,
  runTaskAction,
  safeNotifyAwaiting,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { buildSessionBridges } = await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const {
  clearActionSideEffects,
  getActionSideEffectKind,
  hasActionSideEffect,
  releaseSideEffect,
  tryClaimSideEffect,
} = await import("@/lib/server/action-side-effects");
const { mapSubmitWorkNotifyToToolText } = await import(
  "@/lib/server/chat-mcp"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r30-claim DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
let SUBMIT_REPO = "";

beforeAll(() => {
  SUBMIT_REPO = mkdtempSync(path.join(os.tmpdir(), "ownership-r30-submit-"));
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
    title: `ownership-r30-claim ${id}`,
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
    title: "R30 claim MR",
    description: "",
    lastCommitHash: "hash_r30",
  });

describe("ownership R30 claim + notifier outcome", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r30c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    const g = globalThis as unknown as {
      __flowshipActionSideEffectWaitMs?: number;
    };
    delete g.__flowshipActionSideEffectWaitMs;
    for (const id of ids) {
      clearActionSideEffects(id);
      runningChecks.delete(id);
      cleanupChatTaskState(id);
      clearChatGate(id);
    }
    ids.length = 0;
  });

  // ─────────────────────────────────────────────────────────────
  // ① barrier 返回后 × submit_mr 抢入
  // ─────────────────────────────────────────────────────────────
  it(
    "R30-①：submit_work claim 后（beforeAbortCheck）× submit_mr 抢入 → 拒、最多一类副作用",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      const { awaitingNotifier } = registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r30-1",
      });

      // 停在 claim 之后、runActionPostCheck 之前——旧空窗位置
      const hang = installHangingFailpoint("mcp.submitWork.beforeAbortCheck");
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
      await hang.waitHit();

      // 已持 postcheck claim；runningChecks 尚未挂（check 未启）
      expect(getActionSideEffectKind(id, "act_ship")).toBe("postcheck");
      expect(runningChecks.get(id)).toBeUndefined();

      // 并发 submit_mr 必须被 claim 拒
      const mrResult = await runTaskAction(id, submitMrArgs(), token);
      expect(mrResult).toMatchObject({ ok: false });
      expect(String((mrResult as { error?: string }).error ?? "")).toMatch(
        /正有其它副作用进行|稍后重试/,
      );
      expect(mockCreateMR).not.toHaveBeenCalled();
      // 仍只有 postcheck，没有 mr
      expect(getActionSideEffectKind(id, "act_ship")).toBe("postcheck");

      hang.release();
      await raceExpectSettled(pWork, 12_000);
      expect(await pWork).toBe("accepted");
      await waitUntil(() => runningChecks.get(id)?.actionId === "act_ship", 5000);
      await waitUntil(() => mockRunActionCheck.mock.calls.length > 0, 5000);
      await waitUntil(() => !runningChecks.has(id), 5000);
      expect(hasActionSideEffect(id, "act_ship")).toBe(false);

      // 未遗留错误 awaiting_ack（check 正常落盘是 awaiting_ack——此处断言无外部 MR 孤儿）
      const disk = await readMetaV06(id);
      expect(disk?.mrs ?? []).toHaveLength(0);
      const ship = disk?.actions.find((a) => a.id === "act_ship");
      expect(ship?.sideEffects?.mrs ?? []).toHaveLength(0);
    },
    25_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ② 旧 actionId → stale 文案
  // ─────────────────────────────────────────────────────────────
  it(
    "R30-②：同 caller 旧 actionId 重试 submit_work → stale 文案、非 submitted",
    async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_b";
      meta.repoPaths = [SUBMIT_REPO];
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "ship",
          status: "completed",
          userInstruction: "",
          artifactPath: "actions/1-ship.md",
          startedAt: Date.now() - 1000,
          endedAt: Date.now() - 500,
        },
        {
          id: "act_b",
          n: 2,
          type: "ship",
          status: "running",
          userInstruction: "",
          artifactPath: "actions/2-ship.md",
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);

      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r30-2",
      });

      const notifyResult = await safeNotifyAwaiting(id, {
        actionId: "act_a",
        artifactPath: "actions/1-ship.md",
        callerToken: token,
      });
      expect(notifyResult.status).toBe("stale");
      const toolText = mapSubmitWorkNotifyToToolText(notifyResult, "act_a");
      expect(toolText).toMatch(/已结束|已被后续操作取代/);
      expect(toolText).not.toMatch(/\[SUBMITTED\]/);
      expect(runningChecks.get(id)).toBeUndefined();
      expect(mockRunActionCheck).not.toHaveBeenCalled();
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③ busy 超时 → 重试文案
  // ─────────────────────────────────────────────────────────────
  it(
    "R30-③：MR claim 在飞超时 → busy 重试文案、非 submitted",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r30-3",
      });

      const mrHandle = tryClaimSideEffect(id, "act_ship", "mr");
      expect(mrHandle).not.toBeNull();
      const g = globalThis as unknown as {
        __flowshipActionSideEffectWaitMs?: number;
      };
      g.__flowshipActionSideEffectWaitMs = 80;

      const notifyResult = await safeNotifyAwaiting(id, {
        actionId: "act_ship",
        artifactPath: "actions/1-ship.md",
        callerToken: token,
      });
      expect(notifyResult.status).toBe("busy");
      if (notifyResult.status !== "busy") throw new Error("expected busy");
      const toolText = mapSubmitWorkNotifyToToolText(notifyResult, "act_ship");
      expect(toolText).toMatch(/稍后重试 submit_work|交卷未受理/);
      expect(toolText).not.toMatch(/\[SUBMITTED\]/);
      expect(runningChecks.get(id)).toBeUndefined();
      expect(mockRunActionCheck).not.toHaveBeenCalled();

      releaseSideEffect(mrHandle!);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ④ 正常链回归
  // ─────────────────────────────────────────────────────────────
  it(
    "R30-④：MR 完成后 submit_work claim 成功启 check、check 结束 release",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      const { awaitingNotifier } = registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r30-4",
      });

      // 挂起 check 本体，便于观察 postcheck claim 生命周期
      let releaseCheck!: () => void;
      const checkGate = new Promise<void>((r) => {
        releaseCheck = r;
      });
      mockRunActionCheck.mockImplementation(async () => {
        await checkGate;
        return { passed: true, details: "ok" };
      });

      const hangCreate = installHangingFailpoint("mcp.submitMr.beforeCreateMR");
      const pMr = runTaskAction(id, submitMrArgs(), token);
      await hangCreate.waitHit();
      expect(getActionSideEffectKind(id, "act_ship")).toBe("mr");

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
      // 等 submit_work 进入 wait（mr 仍在）
      await sleep(80);
      expect(runningChecks.get(id)).toBeUndefined();

      hangCreate.release();
      await raceExpectSettled(pMr, 12_000);
      expect(await pMr).toMatchObject({ ok: true });

      await raceExpectSettled(pWork, 12_000);
      expect(await pWork).toBe("accepted");
      await waitUntil(() => runningChecks.get(id)?.actionId === "act_ship", 5000);
      // getTask await 后才进 runActionCheck——等 mock 真正挂上再断言 claim
      await waitUntil(() => mockRunActionCheck.mock.calls.length > 0, 5000);
      expect(getActionSideEffectKind(id, "act_ship")).toBe("postcheck");

      releaseCheck();
      await waitUntil(() => !runningChecks.has(id), 5000);
      // check 结束 dropSelf → release postcheck
      expect(hasActionSideEffect(id, "act_ship")).toBe(false);

      const disk = await readMetaV06(id);
      expect(disk?.mrs ?? []).toHaveLength(1);
      const ship = disk?.actions.find((a) => a.id === "act_ship");
      expect(ship?.status).toBe("awaiting_ack");
      expect(ship?.sideEffects?.mrs ?? []).toHaveLength(1);
    },
    25_000,
  );
});
