/**
 * Ownership R31 退出矩阵第 1、5 条：R30-1 claim 唯一 token + R30-5 ask/无 action outcome
 *
 * ① 已有 postcheck 重交卷 → 换 token；旧 check dropSelf（旧 claimId）不删新 claim；期间 submit_mr 拒
 * ② stop clear → 同 action resume → B claim mr → A 迟到 finally release（旧 handle）→ B 完好
 * ③ 任意时刻同 action 至多一类副作用（随机交错小压测）
 * ④ ask notifier 在 mcp.askUser.afterSupersede 注入失主 → stale、pending 已取消、非 ASK_SUBMITTED
 * ⑤ 无 action submit_work 的 mismatch → 非成功文案（非 NO_WAIT_NEEDED）
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

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-ownership-r31-claim-token-"),
);
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
  loadSkillsForTask: async () => [],
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
  CALLER_MISMATCH_ERROR,
  cleanupChatTaskState,
  getPendingAsk,
  runTaskAction,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { buildSessionBridges } = await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const {
  clearActionSideEffects,
  getActionSideEffectClaimId,
  getActionSideEffectKind,
  hasActionSideEffect,
  releaseSideEffect,
  tryClaimSideEffect,
  waitAndClaimPostCheck,
} = await import("@/lib/server/action-side-effects");
type ClaimHandle = import("@/lib/server/action-side-effects").ClaimHandle;
const {
  dispatchAskUserForTest,
  dispatchSubmitWorkForTest,
} = await import("@/lib/server/chat-mcp");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r31-claim-token DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
let SUBMIT_REPO = "";

beforeAll(() => {
  SUBMIT_REPO = mkdtempSync(path.join(os.tmpdir(), "ownership-r31-submit-"));
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
    title: `ownership-r31-claim-token ${id}`,
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
    title: "R31 claim MR",
    description: "",
    lastCommitHash: "hash_r31",
  });

describe("ownership R31 claim token + ask outcome", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r31c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  // ① 重交卷换 token + 旧 dropSelf 不误放 + MR 拒
  // ─────────────────────────────────────────────────────────────
  it(
    "R31-①：已有 postcheck 重交卷换 token、旧 dropSelf 不删新 claim、期间 submit_mr 拒",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      const { awaitingNotifier } = registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r31-1",
      });

      // 挂起首轮 check 本体，制造「旧 P 在飞」
      let releaseCheckP!: () => void;
      const checkGateP = new Promise<void>((r) => {
        releaseCheckP = r;
      });
      let checkPEntered = false;
      mockRunActionCheck.mockImplementation(async () => {
        checkPEntered = true;
        await checkGateP;
        return { passed: true, details: "ok-p" };
      });

      const pWork1 = Promise.resolve(
        awaitingNotifier(
          {
            kind: "awaiting_start",
            actionId: "act_ship",
            artifactPath: "actions/1-ship.md",
          },
          { callerStillValid: () => true },
        ),
      );
      await waitUntil(() => checkPEntered, 5000);
      await raceExpectSettled(pWork1, 12_000);
      expect(await pWork1).toBe("accepted");
      const claimIdP = getActionSideEffectClaimId(id, "act_ship");
      expect(claimIdP).toBeTypeOf("number");
      expect(getActionSideEffectKind(id, "act_ship")).toBe("postcheck");

      // 重交卷：停在换 token 之后、启新 check 之前
      const hang = installHangingFailpoint("mcp.submitWork.beforeAbortCheck");
      const pWork2 = Promise.resolve(
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

      const claimIdW = getActionSideEffectClaimId(id, "act_ship");
      expect(claimIdW).toBeTypeOf("number");
      expect(claimIdW).not.toBe(claimIdP);
      expect(getActionSideEffectKind(id, "act_ship")).toBe("postcheck");
      // 换 token 同步段已 abort 旧 check 并摘表
      expect(runningChecks.get(id)).toBeUndefined();

      // 期间 submit_mr 必须被拒
      const mrResult = await runTaskAction(id, submitMrArgs(), token);
      expect(mrResult).toMatchObject({ ok: false });
      expect(String((mrResult as { error?: string }).error ?? "")).toMatch(
        /正有其它副作用进行|稍后重试/,
      );
      expect(mockCreateMR).not.toHaveBeenCalled();

      // 放行旧 check 收尾（若仍有挂起）——旧 claimId release 不得删新 token
      releaseCheckP();
      await sleep(80);
      expect(getActionSideEffectClaimId(id, "act_ship")).toBe(claimIdW);
      expect(getActionSideEffectKind(id, "act_ship")).toBe("postcheck");

      // 再试 MR 仍拒
      const mrResult2 = await runTaskAction(id, submitMrArgs(), token);
      expect(mrResult2).toMatchObject({ ok: false });
      expect(mockCreateMR).not.toHaveBeenCalled();

      // 放行 W 启新 check
      let releaseCheckW!: () => void;
      const checkGateW = new Promise<void>((r) => {
        releaseCheckW = r;
      });
      mockRunActionCheck.mockImplementation(async () => {
        await checkGateW;
        return { passed: true, details: "ok-w" };
      });
      hang.release();
      await raceExpectSettled(pWork2, 12_000);
      expect(await pWork2).toBe("accepted");
      await waitUntil(() => runningChecks.get(id)?.actionId === "act_ship", 5000);
      expect(getActionSideEffectClaimId(id, "act_ship")).toBe(claimIdW);

      releaseCheckW();
      await waitUntil(() => !runningChecks.has(id), 5000);
      expect(hasActionSideEffect(id, "act_ship")).toBe(false);
    },
    30_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ② stop clear → resume → B claim → A 旧 finally 不误放
  // ─────────────────────────────────────────────────────────────
  it(
    "R31-②：clear 后 B 重新 claim mr、A 迟到 finally（旧 handle）删不掉 B",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r31-2",
      });

      // A：真实 submit_mr 路径 claim 后挂在 createMR 前
      const hangA = installHangingFailpoint("mcp.submitMr.beforeCreateMR");
      const pA = runTaskAction(id, submitMrArgs(), token);
      await hangA.waitHit();
      expect(getActionSideEffectKind(id, "act_ship")).toBe("mr");
      const claimIdA = getActionSideEffectClaimId(id, "act_ship");
      expect(claimIdA).toBeTypeOf("number");

      // stop clear（终态 owner）——同 action 可 resume 再 claim
      clearActionSideEffects(id);
      expect(hasActionSideEffect(id, "act_ship")).toBe(false);

      // B：resume 后重新 claim（新 token）
      const handleB = tryClaimSideEffect(id, "act_ship", "mr");
      expect(handleB).not.toBeNull();
      const claimIdB = handleB!.claimId;
      expect(claimIdB).not.toBe(claimIdA);

      // A 继续：createMR 失败也无所谓，关键是 finally release 旧 handle
      mockCreateMR.mockResolvedValueOnce({
        ok: false,
        error: "r31-a-after-clear",
      });
      hangA.release();
      await raceExpectSettled(pA, 12_000);

      // A 的旧 handle finally 不得删 B
      expect(getActionSideEffectClaimId(id, "act_ship")).toBe(claimIdB);
      expect(getActionSideEffectKind(id, "act_ship")).toBe("mr");

      // 第三路 postcheck 不得穿透屏障
      const claimPc = await waitAndClaimPostCheck(id, "act_ship", {
        stillValid: () => true,
        deadlineMs: 80,
        pollMs: 20,
      });
      expect(claimPc.result).toBe("timeout");
      expect(getActionSideEffectClaimId(id, "act_ship")).toBe(claimIdB);

      releaseSideEffect(handleB!);
    },
    25_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③ 不变量：同 action 至多一类副作用
  // ─────────────────────────────────────────────────────────────
  it(
    "R31-③：随机交错 claim/release —— 任意时刻同 action 至多一类副作用",
    async () => {
      const id = alloc();
      const actionId = "act_ship";
      const handles: ClaimHandle[] = [];

      for (let i = 0; i < 80; i++) {
        const roll = (i * 7 + 3) % 5;
        if (roll <= 1) {
          const h = tryClaimSideEffect(id, actionId, "mr");
          if (h) handles.push(h);
        } else if (roll === 2) {
          const r = await waitAndClaimPostCheck(id, actionId, {
            stillValid: () => true,
            deadlineMs: 40,
            pollMs: 5,
          });
          if (r.result === "claimed") handles.push(r.handle);
        } else if (roll === 3 && handles.length > 0) {
          const old = handles[Math.floor(Math.random() * handles.length)]!;
          releaseSideEffect(old);
        } else {
          clearActionSideEffects(id, actionId);
        }

        // 不变量：有 claim 时 kind 唯一；旧 handle release 不得造出双 kind
        const kind = getActionSideEffectKind(id, actionId);
        if (kind === undefined) {
          expect(hasActionSideEffect(id, actionId)).toBe(false);
        } else {
          expect(["mr", "postcheck"]).toContain(kind);
          expect(hasActionSideEffect(id, actionId)).toBe(true);
        }
      }
      clearActionSideEffects(id, actionId);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ④ ask stale → 非 ASK_SUBMITTED
  // ─────────────────────────────────────────────────────────────
  it(
    "R31-④：ask afterSupersede 失主 → stale、pending 取消、工具不返 ASK_SUBMITTED",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const tokenA = String(allocTaskRunInstanceId());
      const tokenB = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: tokenA,
        gitToken: "pat-r31-4",
      });

      const hang = installHangingFailpoint("mcp.askUser.afterSupersede");
      const pAsk = dispatchAskUserForTest({
        taskId: id,
        callerToken: tokenA,
        actionId: "act_ship",
        questions: [
          { id: "q1", question: "R31-4 失主提问？", allowText: true },
        ],
      });
      await hang.waitHit();
      expect(getPendingAsk(id)).not.toBeNull();

      // 注入失主：B 接管 bridge
      registerBridgesForTest(task, {
        callerToken: tokenB,
        gitToken: "pat-r31-4b",
      });

      hang.release();
      const askResult = await pAsk;
      expect(askResult.ok).toBe(false);
      if (!askResult.ok) {
        expect(askResult.error).not.toContain("ASK_SUBMITTED");
        expect(askResult.error).toBe("任务已被接管/通知失败、请重试");
      }
      expect(getPendingAsk(id)).toBeNull();

      const disk = await readMetaV06(id);
      expect(disk?.runStatus).not.toBe("awaiting_user");
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ⑤ 无 action submit_work mismatch
  // ─────────────────────────────────────────────────────────────
  it(
    "R31-⑤：无 action submit_work mismatch → 非 idle 成功文案",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const tokenA = String(allocTaskRunInstanceId());
      const tokenB = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: tokenA,
        gitToken: "pat-r31-5",
      });

      const result = await dispatchSubmitWorkForTest({
        taskId: id,
        callerToken: tokenB,
      });
      expect(result.text).toBe(CALLER_MISMATCH_ERROR);
      expect(result.text).not.toMatch(/NO_WAIT_NEEDED/);
      expect(result.text).not.toMatch(/\[SUBMITTED\]/);
    },
    10_000,
  );
});
