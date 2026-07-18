/**
 * Ownership R27 真实提交点矩阵（fable5-chat-polish 第二十七轮验收·收敛门槛第 4 条点名）
 *
 * 面向修复后的目标行为：7 条——rename retry×换主、ensure 进入后×finalize、
 * resume reject cleanup、同 caller 历史 action、同 caller 双 ask、
 * chat force-clear 后旧流、delete 后 append ENOENT。
 *
 * setup 对齐 ownership-r26-matrix：
 * raceExpectSettled 判赢家、断言不进条件分支、waitUntil 超时必抛、轮询 deadline 不裸 sleep。
 *
 * 接线波并行落地前，依赖未接线 failpoint / lease 的用例预期暂红——文末「行为假设」对照。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r27-"));
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
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  claimTaskOp,
  clearTaskStarting,
  getTaskOpGeneration,
  pendingStopRequests,
  runningChecks,
  runningTasks,
  subscribeTaskStream,
  writeEventAndPublish,
  writeOwnedEventAndPublish,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const chatPending = await import("@/lib/server/chat-pending");
const {
  cleanupChatTaskState,
  getExpectedCallerToken,
  getPendingAsk,
  runTaskAction,
} = chatPending;
const { dispatchAskUserForTest } = await import("@/lib/server/chat-mcp");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { deliverTaskQuestion, finalizeTask } = await import(
  "@/lib/server/task-runner"
);
const {
  deleteTask,
  getTask,
  listTasks,
  patchActionIfOwner,
  setTaskSessionAgentId,
} = await import("@/lib/server/task-fs");
const {
  forceClearChatRun,
  hasChatSession,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");
const { ensureTaskWorktrees, getTaskWorktreesDir } = await import(
  "@/lib/server/task-worktrees"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r27-matrix DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
  fallbackModel: { id: "m", params: [] as never[] },
  gitToken: "pat-r27",
};

const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
let SUBMIT_REPO = "";

beforeAll(() => {
  SUBMIT_REPO = mkdtempSync(path.join(os.tmpdir(), "ownership-r27-submit-"));
  execFileSync("git", ["init"], { cwd: SUBMIT_REPO });
  execFileSync("git", ["remote", "add", "origin", REMOTE_URL], {
    cwd: SUBMIT_REPO,
  });
});

afterAll(() => {
  if (SUBMIT_REPO) {
    rmSync(SUBMIT_REPO, { recursive: true, force: true });
  }
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r27 ${id}`,
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

const seedRunningAction = async (
  id: string,
  extras?: Partial<TaskMetaV06>,
): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus = "running";
  meta.currentActionId = "act_shared";
  meta.sessionAgentId = "agent_persisted";
  meta.actions = [
    {
      id: "act_shared",
      n: 1,
      type: "plan",
      status: "running",
      userInstruction: "",
      artifactPath: "actions/1-plan.md",
      startedAt: Date.now(),
      endedAt: null,
    },
  ] as TaskMetaV06["actions"];
  Object.assign(meta, extras);
  await writeMeta(meta);
};

/** 同 caller 历史 action：旧 ship A 已结束、当前 B running */
const seedHistoryShipAndCurrentBuild = async (id: string): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus = "running";
  meta.currentActionId = "act_b";
  meta.sessionAgentId = "agent_r27_4";
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
      id: "act_a",
      n: 1,
      type: "ship",
      status: "completed",
      userInstruction: "",
      artifactPath: "actions/1-ship.md",
      startedAt: Date.now() - 2000,
      endedAt: Date.now() - 1000,
    },
    {
      id: "act_b",
      n: 2,
      type: "build",
      status: "running",
      userInstruction: "",
      artifactPath: "actions/2-build.md",
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

/** settle 算 op 赢；timeout 胜出必须 fail（防假绿） */
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

const installOnceHangingFailpoint = (name: string) => {
  let hit = false;
  let used = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    if (used) return;
    used = true;
    hit = true;
    await gate;
  });
  return {
    wasHit: () => hit,
    release: () => release(),
    waitHit: () => waitUntil(() => hit),
  };
};

const makeSessionAgent = (agentId: string) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const wait = vi.fn().mockResolvedValue({ status: "finished" as const });
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      /* 空 */
    },
    wait,
    cancel,
  });
  return { agentId, close, send, wait, cancel };
};

const listTmpMetaFiles = async (id: string): Promise<string[]> => {
  try {
    const names = await fs.readdir(taskDir(id));
    return names.filter((n) => n.includes(".tmp."));
  } catch {
    return [];
  }
};

const dirExists = async (dir: string): Promise<boolean> => {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
};

describe("ownership R27 真实提交点矩阵", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r27_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockCreateMR.mockReset();
    mockGetMRMergeStatus.mockReset();
    mockCloseOpenMR.mockReset();
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
    clearFailpoints();
  });

  afterEach(async () => {
    clearFailpoints();
    vi.restoreAllMocks();
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      runningChecks.delete(id);
      agentSessions.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
      cleanupChatTaskState(id);
      forceClearChatRun(id);
    }
    await sleep(30);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
      await fs
        .rm(getTaskWorktreesDir(id), { recursive: true, force: true })
        .catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────
  // 1) R27-1：rename 首次失败后的 retry × 换主
  // ─────────────────────────────────────────────────────────────
  it(
    "R27-1 rename retry：首次 EPERM × 退避中失主 → 不提交旧 meta、helper 返 null、tmp 清理（R27-1）",
    async () => {
      // 旧实现：commit(finalGuard) 只在 renameWithRetry 前验一次；Windows EPERM
      // 退避重试循环内不再验 owner——A 失主后后续 retry 仍把旧 meta rename 上盘。
      // R27-1：rename.beforeAttempt + beforeAttempt(guard) 每次 fs.rename 前复查；
      // 失主清 tmp、commit 返 false。
      // 依赖插桩：mock fs.rename 首次 EPERM；failpoint rename.beforeAttempt（第 2 次挂起）
      // race 判赢家：pPatch settle；断言不进条件分支：盘上 status 仍 running
      const id = alloc();
      await seedRunningAction(id);
      let owner = true;
      let renameCount = 0;
      const realRename = fs.rename.bind(fs);
      const renameSpy = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (from, to) => {
          renameCount += 1;
          if (renameCount === 1) {
            throw Object.assign(new Error("EPERM: r27-1 mock"), {
              code: "EPERM",
            });
          }
          return realRename(from, to);
        });

      let attemptFp = 0;
      let secondHit = false;
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((r) => {
        releaseSecond = r;
      });
      setFailpoint("rename.beforeAttempt", async () => {
        attemptFp += 1;
        if (attemptFp >= 2) {
          secondHit = true;
          await secondGate;
        }
      });

      try {
        const pPatch = patchActionIfOwner(
          id,
          "act_shared",
          { status: "awaiting_ack" },
          () => owner,
          { currentActionId: "act_shared", actionStatus: "running" },
        );

        // 轮询 deadline：等第 2 次 beforeAttempt（退避后、rename 前）再失主
        await waitUntil(() => secondHit, 5000);
        owner = false;
        releaseSecond();

        await raceExpectSettled(pPatch, 8000);
        const result = await pPatch;
        expect(result).toBeNull();
        // 第二次真实 rename 不得发起
        expect(renameCount).toBe(1);

        const disk = await readMetaV06(id);
        expect(disk?.actions.find((a) => a.id === "act_shared")?.status).toBe(
          "running",
        );
        expect(disk?.runStatus).toBe("running");
        expect(await listTmpMetaFiles(id)).toHaveLength(0);
      } finally {
        renameSpy.mockRestore();
      }
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 2) R27-2：ensure 已进入后 × finalize（降级直测 lease）
  // ─────────────────────────────────────────────────────────────
  it(
    "R27-2 ensure 进入后：假 lease 翻 false → 让位/补偿、无新建 worktree（R27-2·降级）",
    async () => {
      // 旧实现：prewarm 只在 ensure 前后 stillPrewarm；函数内部 fetch/add 无 lease。
      // R27-2：resource lease 传入 ensure；失主让位或补偿移除。
      // 降级理由：完整 git fetch/worktree add mock 面过大——直测
      // ensureTaskWorktrees(task, lease) + ensure.beforeWorktreeAdd。
      // 依赖插桩：ensure.beforeWorktreeAdd（未接线 → waitHit 超时红）
      // race 判赢家：pEnsure settle；断言不进条件分支：createdRepos 空
      const id = alloc();
      const meta = makeMeta(id);
      meta.isolateWorktree = true;
      meta.repoPaths = [SUBMIT_REPO];
      meta.repoBaseBranches = { [SUBMIT_REPO]: "master" };
      await writeMeta(meta);
      const task = (await getTask(id))!;

      let leaseOk = true;
      const hang = installHangingFailpoint("ensure.beforeWorktreeAdd");

      type EnsureWithLease = (
        t: Task,
        lease?: () => boolean,
      ) => Promise<{
        infos: unknown[];
        createdRepos: string[];
        clonedDeps: unknown[];
      }>;
      const ensure = ensureTaskWorktrees as EnsureWithLease;
      const pEnsure = ensure(task, () => leaseOk).catch((err: unknown) => err);

      try {
        // 2s 内未命中 = 修复代理尚未插入 ensure.beforeWorktreeAdd → 明确红
        const hit = await Promise.race([
          hang.waitHit().then(() => true as const),
          sleep(2000).then(() => false as const),
        ]);
        if (!hit) {
          expect.fail(
            "ensure.beforeWorktreeAdd 未接线（R27-2 依赖修复代理在 ensureTaskWorktrees 内插桩）",
          );
        }
        await finalizeTask(id, "abandoned");
        leaseOk = false;
        hang.release();
        await raceExpectSettled(pEnsure, 15_000);
        const ensured = await pEnsure;
        expect(ensured).not.toBeInstanceOf(Error);
        const result = ensured as {
          createdRepos: string[];
        };
        expect(result.createdRepos ?? []).toHaveLength(0);
        const wtRoot = getTaskWorktreesDir(id);
        if (await dirExists(wtRoot)) {
          expect(await fs.readdir(wtRoot)).toHaveLength(0);
        }
        expect((await readMetaV06(id))?.gitBranches ?? []).toHaveLength(0);
      } finally {
        hang.release();
        leaseOk = false;
        await pEnsure;
      }
    },
    25_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 3) R27-3：resume reject cleanup × B 已落盘锚点
  // ─────────────────────────────────────────────────────────────
  it(
    "R27-3 resume reject：A reject 挂起 × B 落盘 sessionAgentId → A 不清空 B 锚点（R27-3）",
    async () => {
      // 旧实现：Agent.resume 确定性失败 catch 无条件 setTaskSessionAgentId(undefined)；
      // A pending reject 期间 B 已落盘 B，A 的 clear 排在后面抹掉锚点。
      // R27-3：conditional clear——有后继 / 原 lease 失效则不清盘。
      // 依赖插桩：mockResume 可控 reject（chat resumeChatSession 真路径）
      // race 判赢家：pResume settle；断言不进条件分支：盘上仍是 B
      const id = alloc();
      await seedRunningAction(id, {
        mode: "chat" as TaskMetaV06["mode"],
        runStatus: "idle",
        currentActionId: null,
        sessionAgentId: "agent_r27_3_a",
        actions: [] as TaskMetaV06["actions"],
      });

      let rejectA!: (err: Error) => void;
      mockResume.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectA = reject;
          }),
      );

      const task = (await getTask(id))!;
      const pResume = resumeChatSession(task, {
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      });

      await waitUntil(() => mockResume.mock.calls.length > 0, 8000);

      // B 已抢先落盘后继锚点（模拟 B install/persist 完成）
      await setTaskSessionAgentId(id, "agent_r27_3_b");
      expect((await readMetaV06(id))?.sessionAgentId).toBe("agent_r27_3_b");

      rejectA(new Error("AgentNotFoundError: r27-3 deterministic reject"));
      await raceExpectSettled(pResume, 8000);
      await sleep(120);

      const disk = await readMetaV06(id);
      expect(disk?.sessionAgentId).toBe("agent_r27_3_b");
      // A 的失败 resume 不得留下错配会话冒充 B
      if (hasChatSession(id)) {
        // 若有会话，不得是 A 的死 agent
        expect(disk?.sessionAgentId).not.toBe("agent_r27_3_a");
      }
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 4) R27-4：同 caller 历史 action submit_mr / set_feishu_testers
  // ─────────────────────────────────────────────────────────────
  it(
    "R27-4 同 caller 历史 action：A 已结束 × B current → submit_mr/set_feishu 拒、无 MR（R27-4）",
    async () => {
      // 旧实现：submit_mr 只验 session caller + action 存在/类型，不验 current+running；
      // set_feishu 未强制 ship。同 session 复用 caller → 历史 A 仍可 createMR。
      // R27-4：action lease（current+running+类型）进外部副作用前复查。
      // 依赖插桩：spy setChatTaskActionHandler 补 callerToken（生产 register 未传时）；
      // mockResume 装真 handler；mockCreateMR 断言不被调
      // race 判赢家：pMr settle；断言不进条件分支：createMR 0 次、mrs 空
      const id = alloc();
      await seedHistoryShipAndCurrentBuild(id);
      const token = String(allocTaskRunInstanceId());

      // 生产 registerSessionBridges 未传 callerToken 时，补上测试 token 以便 runTaskAction 过身份闸
      const actualSetHandler = chatPending.setChatTaskActionHandler;
      const actualSetNotifier = chatPending.setChatAwaitingNotifier;
      vi.spyOn(chatPending, "setChatTaskActionHandler").mockImplementation(
        (taskId, handler, callerToken?) => {
          actualSetHandler(taskId, handler, callerToken ?? token);
        },
      );
      vi.spyOn(chatPending, "setChatAwaitingNotifier").mockImplementation(
        (taskId, notifier, callerToken?) => {
          actualSetNotifier(taskId, notifier, callerToken ?? token);
        },
      );

      mockResume.mockResolvedValue(makeSessionAgent("agent_r27_4"));
      const task = (await getTask(id))!;
      const pDeliver = deliverTaskQuestion(
        task,
        "R27-4 装 bridge",
        undefined,
        CREDS,
      );
      await raceExpectSettled(pDeliver, 12_000);

      // handler 应已注册（resume → registerSessionBridges）
      expect(getExpectedCallerToken(id)).toBe(token);

      const pMr = runTaskAction(
        id,
        {
          kind: "submit_mr",
          actionId: "act_a",
          repoPath: SUBMIT_REPO,
          projectPath: PROJECT_PATH,
          sourceBranch: "feature/me/123-x",
          targetBranch: "test",
          title: "R27-4 历史 action MR",
          description: "",
          lastCommitHash: "hash_r27_4",
        },
        token,
      );
      await raceExpectSettled(pMr, 8000);
      const mrResult = await pMr;
      expect(mrResult).toMatchObject({ ok: false });
      expect(String((mrResult as { error?: string }).error ?? "")).toMatch(
        /action 已结束|不是当前|current|已结束|不允许/,
      );
      expect(mockCreateMR).not.toHaveBeenCalled();
      expect((await readMetaV06(id))?.mrs ?? []).toHaveLength(0);

      const pFeishuHist = runTaskAction(
        id,
        {
          kind: "set_feishu_testers",
          actionId: "act_a",
          userKeys: ["uk_hist"],
        },
        token,
      );
      await raceExpectSettled(pFeishuHist, 8000);
      expect(await pFeishuHist).toMatchObject({ ok: false });

      const pFeishuType = runTaskAction(
        id,
        {
          kind: "set_feishu_testers",
          actionId: "act_b",
          userKeys: ["uk_build"],
        },
        token,
      );
      await raceExpectSettled(pFeishuType, 8000);
      const feishuType = await pFeishuType;
      expect(feishuType).toMatchObject({ ok: false });
      expect(String((feishuType as { error?: string }).error ?? "")).toMatch(
        /ship|不允许|类型/,
      );
      expect((await readMetaV06(id))?.feishuTesterUserKeys).toBeUndefined();
    },
    25_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 5) R27-5：同 caller 双 ask（B 顶 A）——走 chat notifier（含 afterSupersede）
  // ─────────────────────────────────────────────────────────────
  it(
    "R27-5 同 caller 双 ask：A afterSupersede 挂起 × B 完成 → A 事件不落、pending 仍 B（R27-5）",
    async () => {
      // 旧实现：askLease 只有 callerToken；同 caller 的 A 在 supersede 挂起期间
      // B 登记并完成事件后，A 恢复仍写 ask A，UI 与 pending map 分裂。
      // R27-5：askLease 含 getPendingAsk()?.askId/token === signal。
      // 依赖插桩：mcp.askUser.afterSupersede（仅首次挂起 A）；chat resume 装 notifier
      // race 判赢家：pAskA/pAskB settle；断言不进条件分支：无 askIdA 事件
      const id = alloc();
      await seedRunningAction(id, {
        mode: "chat" as TaskMetaV06["mode"],
        runStatus: "idle",
        currentActionId: null,
        actions: [] as TaskMetaV06["actions"],
      });

      mockResume.mockResolvedValue(makeSessionAgent("agent_r27_5"));
      const task = (await getTask(id))!;
      const instanceId = await resumeChatSession(task, {
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      });
      expect(instanceId).not.toBeNull();
      const token = getExpectedCallerToken(id);
      expect(token).toBeTruthy();

      const hang = installOnceHangingFailpoint("mcp.askUser.afterSupersede");
      const pAskA = dispatchAskUserForTest({
        taskId: id,
        callerToken: token!,
        questions: [
          { id: "q1", question: "R27-5 A 的提问？", allowText: true },
        ],
      });
      await hang.waitHit();

      const askA = getPendingAsk(id);
      expect(askA).not.toBeNull();
      const askIdA = askA!.askId;
      const tokenA = askA!.token;

      const pAskB = dispatchAskUserForTest({
        taskId: id,
        callerToken: token!,
        questions: [
          { id: "q1", question: "R27-5 B 的提问？", allowText: true },
        ],
      });
      await raceExpectSettled(pAskB, 8000);
      const askBResult = await pAskB;
      expect(askBResult).toMatchObject({ ok: true });
      const askIdB = (askBResult as { askId: string }).askId;
      expect(askIdB).not.toBe(askIdA);

      await waitUntil(async () => {
        const events = await readEvents(id);
        return events.some(
          (e) =>
            e.kind === "ask_user_request" &&
            (e.meta as { askId?: string } | undefined)?.askId === askIdB,
        );
      }, 5000);

      hang.release();
      await raceExpectSettled(pAskA, 8000);
      await sleep(40);

      const events = await readEvents(id);
      const askEvents = events.filter((e) => e.kind === "ask_user_request");
      expect(
        askEvents.filter(
          (e) =>
            (e.meta as { askId?: string } | undefined)?.askId === askIdA ||
            (e.meta as { token?: string } | undefined)?.token === tokenA,
        ),
      ).toHaveLength(0);
      expect(
        askEvents.filter(
          (e) =>
            (e.meta as { askId?: string } | undefined)?.askId === askIdB,
        ).length,
      ).toBeGreaterThanOrEqual(1);
      expect(getPendingAsk(id)?.askId).toBe(askIdB);
      expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 6) R27-6：force-clear 后旧流（降级：writeOwnedEventAndPublish 假 lease）
  // ─────────────────────────────────────────────────────────────
  it(
    "R27-6 force-clear 后旧流：owned lease 失效 × 迟到主消息 → 不落盘不 publish（R27-6·降级）",
    async () => {
      // 旧实现：chat buffer flush / handleSdkMessage 不传 instanceId lease——
      // forceClear+B 后 A 仍 append/publish 主消息污染历史。
      // R27-6：owned sink lease 必填；失主不写不发。
      // 降级理由：完整 chat-runner 流 mock 面大——等价直测
      // writeOwnedEventAndPublish + event.inQueue + forceClearChatRun。
      // 依赖插桩：event.inQueue
      // race 判赢家：pThink/pFlush settle；断言不进条件分支：无目标文本
      const id = alloc();
      await seedRunningAction(id, { mode: "chat" as TaskMetaV06["mode"] });

      const handleA = claimTaskOp(id, getTaskOpGeneration(id));
      expect(handleA).not.toBeNull();
      let leaseOk = true;
      const leaseA = (): boolean => leaseOk;

      const published: string[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "event" && typeof ev.event.text === "string") {
          published.push(ev.event.text);
        }
      });

      const hang = installHangingFailpoint("event.inQueue");
      const pThink = writeOwnedEventAndPublish(id, leaseA, {
        kind: "thinking",
        text: "r27-6-late-thinking-from-A",
      });
      await hang.waitHit();

      // 模拟 forceClear + B：翻 lease
      leaseOk = false;
      claimTaskOp(id, getTaskOpGeneration(id));
      forceClearChatRun(id);

      hang.release();
      await raceExpectSettled(pThink, 8000);
      expect(await pThink).toBeNull();

      const pFlush = writeOwnedEventAndPublish(id, leaseA, {
        kind: "assistant_message",
        text: "r27-6-late-assistant-from-A",
      });
      await raceExpectSettled(pFlush, 5000);
      expect(await pFlush).toBeNull();
      unsub();

      const events = await readEvents(id);
      expect(
        events.some((e) => e.text === "r27-6-late-thinking-from-A"),
      ).toBe(false);
      expect(
        events.some((e) => e.text === "r27-6-late-assistant-from-A"),
      ).toBe(false);
      expect(published.includes("r27-6-late-thinking-from-A")).toBe(false);
      expect(published.includes("r27-6-late-assistant-from-A")).toBe(false);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 7) R27-7：delete 后 append ENOENT → 无 publish、目录不复活
  // ─────────────────────────────────────────────────────────────
  it(
    "R27-7 delete×append：meta 通过后入队 × 删目录 → 返 null、无 SSE、目录不复活（R27-7）",
    async () => {
      // 旧实现：appendEventLineUnlocked ENOENT 静默 return，上层仍返 true/event，
      // writeEventAndPublish 推送磁盘从未存在的幽灵事件。
      // R27-7：ENOENT → false/null 透传；不 publish；不 mkdir 复活。
      // 依赖插桩：event.inQueue
      // race 判赢家：pAppend settle；断言不进条件分支：published 无目标 event
      const id = alloc();
      await seedRunningAction(id);

      const published: unknown[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        published.push(ev);
      });

      const hang = installHangingFailpoint("event.inQueue");
      const pAppend = writeEventAndPublish(id, {
        kind: "info",
        text: "r27-7-ghost-should-not-publish",
      });
      await hang.waitHit();

      const deleted = await deleteTask(id);
      expect(deleted).toBe(true);
      expect(await dirExists(taskDir(id))).toBe(false);

      hang.release();
      await raceExpectSettled(pAppend, 8000);
      const wrote = await pAppend;
      expect(wrote).toBeNull();
      await sleep(40);
      unsub();

      expect(
        published.filter(
          (ev) =>
            typeof ev === "object" &&
            ev !== null &&
            "kind" in ev &&
            (ev as { kind: string }).kind === "event" &&
            (ev as { event?: { text?: string } }).event?.text ===
              "r27-7-ghost-should-not-publish",
        ),
      ).toHaveLength(0);
      expect(await dirExists(taskDir(id))).toBe(false);
    },
    15_000,
  );
});

/*
 * ─────────────────────────────────────────────────────────────
 * 用例清单（主线核对）
 * ─────────────────────────────────────────────────────────────
 * R27-1  rename 首次 EPERM × beforeAttempt 失主 → 不提交、返 null、tmp 清
 *        手法：mock fs.rename 首败 + rename.beforeAttempt 第 2 次挂起
 * R27-2  ensure 进入后 × lease 翻 false → 无 createdRepos（降级）
 *        手法：ensure(task, lease) + ensure.beforeWorktreeAdd
 * R27-3  resume reject × B 落盘 → sessionAgentId 仍 B
 *        手法：resumeChatSession + mockResume 可控 reject
 * R27-4  同 caller 历史 act_a submit_mr / set_feishu → 拒、无 createMR
 *        手法：deliverTaskQuestion 装真 handler + runTaskAction；spy 补 token
 * R27-5  同 caller 双 ask：A afterSupersede 挂 × B 完成 → A 不落盘
 *        手法：resumeChatSession 装 chat notifier + mcp.askUser.afterSupersede
 * R27-6  force-clear 后旧 thinking/assistant → 不落盘不 publish（降级）
 *        手法：writeOwnedEventAndPublish + event.inQueue + forceClearChatRun
 * R27-7  meta√→delete→queued append ENOENT → null、无 SSE、目录不复活
 *        手法：event.inQueue × deleteTask
 *
 * ─────────────────────────────────────────────────────────────
 * 行为假设
 * ─────────────────────────────────────────────────────────────
 * 1. renameWithRetry 每次前 failpoint("rename.beforeAttempt") + beforeAttempt；
 *    RenameAbortedError → commit 返 false、清 tmp
 * 2. ensureTaskWorktrees(task, lease?)：内部复查；failpoint ensure.beforeWorktreeAdd
 * 3. resume 确定性失败 clear：conditional——后继锚点存在则不清
 * 4. submit_mr / set_feishu：action lease = current+running(+ship)；历史/非 ship 拒
 * 5. askLease 含 pending askId/token；同 caller B 顶 A 后 A 不写 event
 * 6. writeOwnedEventAndPublish(lease 必填)；chat 主消息须走 owned sink
 * 7. append ENOENT → false → appendEvent/write* 返 null、不 publish
 *
 * 降级直测：
 * - R27-2：git mock 面过大 → ensure(task, lease) + ensure.beforeWorktreeAdd
 * - R27-6：chat-runner 流过大 → writeOwnedEventAndPublish 假 lease
 */
