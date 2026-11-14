/**
 * submit_mr × 「复用已有 MR 时更新标题 / 描述」的接线（审查 R22-01 / R22-02）
 *
 * gitlab-client-update-on-reuse.test.ts 只测 createMR 本身；这里补它上面的两层——
 *   ① shouldUpdateExistingMrOnReuse（纯函数）：只有「task.mrs 里已有同仓 + 同目标 + 同源分支的记录」才覆盖（R22-02）；
 *   ② submit_mr 处理器（真 runTaskAction → buildSessionBridges，createMR 用 mock 替身）：
 *      - 传给 createMR 的 updateExistingOnReuse 就是 ①的结果（删掉这一行 / 写回无条件 true，这里会红）（R22-01）；
 *      - createMR 回的 updated / updateError 原样变成回给 AI 的 mr_updated / mr_update_error（R22-01）。
 *
 * R21-02 的根因就是「底层能力没人接线」，所以接线这两处必须有测试守着。
 *
 * setup 对齐 ownership-r26-matrix（临时数据目录 + 真 git 仓做 origin 对账 + registerBridges 等价物）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-submit-mr-reuse-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
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
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({ servers, dropped: [] }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({ reapTaskOrphans: vi.fn() }));
vi.mock("@/lib/server/meegle-cli", () => ({ resolveUserIdentityForPrompt: async () => "" }));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

const { shouldUpdateExistingMrOnReuse } = await import("@/lib/server/submit-mr-guard");
const { readMetaV06, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { allocTaskRunInstanceId, revokeTaskOps } = await import("@/lib/server/task-stream");
const {
  cleanupChatTaskState,
  runTaskAction,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { clearChatGate, endChatLifecycle } = await import("@/lib/server/chat-gate");
const { buildSessionBridges } = await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`submit-mr-update-on-reuse-wiring DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

// 先跑空目录 boot recovery——否则首条 seed 的 running 会被 recovery 标成 error
await listTasks();

const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
const FEATURE = "feature/me/123-x";
let REPO = "";

beforeAll(() => {
  REPO = mkdtempSync(path.join(os.tmpdir(), "submit-mr-reuse-repo-"));
  execFileSync("git", ["init"], { cwd: REPO });
  execFileSync("git", ["remote", "add", "origin", REMOTE_URL], { cwd: REPO });
});

afterAll(async () => {
  if (REPO) rmSync(REPO, { recursive: true, force: true });
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

type MrRecord = NonNullable<TaskMetaV06["mrs"]>[number];

const mrRecord = (over: Partial<MrRecord> = {}): MrRecord =>
  ({
    repoPath: REPO,
    targetBranch: "test",
    version: 1,
    url: "https://git.corp.com/group/proj/-/merge_requests/9",
    title: "旧 MR",
    branch: FEATURE,
    status: "open",
    createdAt: Date.now(),
    lastCommitHash: "oldhash1",
    ...over,
  }) as MrRecord;

/** 一个跑着 ship action 的 task；mrs 由调用方决定（有 / 没有 Flowship 自己的记录） */
const seedShip = async (id: string, mrs: MrRecord[]): Promise<void> => {
  const meta = {
    id,
    title: `submit-mr-reuse ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
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
    mrs,
    repoPaths: [REPO],
    gitBranches: [{ repoPath: REPO, name: FEATURE, baseBranch: "master" }],
    repoTestBranches: { [REPO]: "test" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06;
  await writeMeta(meta);
};

const submit = async (
  id: string,
  over: { sourceBranch?: string; targetBranch?: string } = {},
) => {
  const task = (await getTask(id))!;
  const callerToken = String(allocTaskRunInstanceId());
  const bridges = buildSessionBridges(task as Task, { callerToken, gitToken: "pat-reuse" });
  setChatTaskActionHandler(id, bridges.taskActionHandler, callerToken);
  setChatAwaitingNotifier(id, bridges.awaitingNotifier, callerToken);
  return runTaskAction(
    id,
    {
      kind: "submit_mr",
      actionId: "act_ship",
      repoPath: REPO,
      projectPath: PROJECT_PATH,
      sourceBranch: over.sourceBranch ?? FEATURE,
      targetBranch: over.targetBranch ?? "test",
      title: "[前端] 需求 v2",
      description: "旧描述\n\n## v2 更新",
      lastCommitHash: "newhash2",
    },
    callerToken,
  );
};

const lastCreateMrArg = (): Record<string, unknown> => {
  expect(mockCreateMR).toHaveBeenCalledTimes(1);
  return mockCreateMR.mock.calls[0]![0] as Record<string, unknown>;
};

describe("shouldUpdateExistingMrOnReuse（R22-02：只在 Flowship 自己已有这条 MR 的记录时才覆盖）", () => {
  const task = (mrs: MrRecord[] | undefined, repoTestBranches?: Record<string, string>) =>
    ({ mrs, repoTestBranches }) as Pick<Task, "mrs" | "repoTestBranches">;
  // 必须在用例里现算：REPO 在 beforeAll 里才赋值，describe 收集阶段还是空串
  const args = (over: Partial<{ sourceBranch: string; targetBranch: string }> = {}) => ({
    repoPath: REPO,
    sourceBranch: FEATURE,
    targetBranch: "test",
    ...over,
  });

  it("同仓 + 同目标 + 同源分支有记录 → true（真正的再次提测）", () => {
    expect(shouldUpdateExistingMrOnReuse(task([mrRecord()], { [REPO]: "test" }), args())).toBe(true);
  });

  it("没有任何记录（首次提交 / 人手建的 MR）→ false；mrs 缺省也是 false", () => {
    expect(shouldUpdateExistingMrOnReuse(task([]), args())).toBe(false);
    expect(shouldUpdateExistingMrOnReuse(task(undefined), args())).toBe(false);
  });

  it("源分支不同（如解冲突换成 __conflict 分支）→ false：不能把别条 MR 的记录当成这条的所有权", () => {
    expect(shouldUpdateExistingMrOnReuse(task([mrRecord({ branch: `${FEATURE}__conflict` })]), args())).toBe(false);
  });

  it("目标分支不同（记录是联调 →dev、这次提测 →test）→ false：同仓的提测 / 联调 MR 各记各的", () => {
    expect(shouldUpdateExistingMrOnReuse(task([mrRecord({ targetBranch: "dev" })]), args())).toBe(false);
  });

  it("别的仓的记录不算", () => {
    expect(shouldUpdateExistingMrOnReuse(task([mrRecord({ repoPath: "/other/repo" })]), args())).toBe(false);
  });

  it("记录里没写 targetBranch → 回退该仓测试分支配置，再回退 test（与 mrTargetBranchOf 一致）", () => {
    const rec = mrRecord({ targetBranch: undefined });
    expect(shouldUpdateExistingMrOnReuse(task([rec], { [REPO]: "qa" }), args({ targetBranch: "qa" }))).toBe(true);
    expect(shouldUpdateExistingMrOnReuse(task([rec], { [REPO]: "qa" }), args())).toBe(false);
    expect(shouldUpdateExistingMrOnReuse(task([rec]), args())).toBe(true);
  });
});

describe("submit_mr 处理器接线（R22-01）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_reuse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
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
  });

  afterEach(async () => {
    for (const id of ids) {
      clearChatGate(id);
      endChatLifecycle(id);
      revokeTaskOps(id);
      cleanupChatTaskState(id);
    }
    await new Promise((r) => setTimeout(r, 30));
    for (const id of ids) await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    ids.length = 0;
  });

  it("task.mrs 已有同仓 + 同目标 + 同源记录（再次提测）：createMR 收到 updateExistingOnReuse:true；更新成功 → 回给 AI mr_updated:true、没有 mr_update_error", async () => {
    const id = alloc();
    await seedShip(id, [mrRecord()]);
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/9",
      iid: 9,
      updated: true,
    });

    const r = await submit(id);

    expect(lastCreateMrArg().updateExistingOnReuse).toBe(true);
    expect(r).toMatchObject({ ok: true, data: { mr_updated: true } });
    expect((r as { data: Record<string, unknown> }).data).not.toHaveProperty("mr_update_error");
    // 本地记录照常升版（接线没破坏原有落盘）
    const disk = await readMetaV06(id);
    expect(disk?.mrs?.[0]?.version).toBe(2);
  });

  it("更新失败（createMR 回 updateError）：ship 不失败，原因原样变成 mr_update_error 回给 AI，mr_updated:false", async () => {
    const id = alloc();
    await seedShip(id, [mrRecord()]);
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/9",
      iid: 9,
      updated: false,
      updateError: "403 Forbidden",
    });

    const r = await submit(id);

    expect(r).toMatchObject({
      ok: true,
      data: { mr_updated: false, mr_update_error: "403 Forbidden" },
    });
  });

  it("没有 Flowship 自己的记录（首次提交撞上别人手建的 MR）：updateExistingOnReuse:false；createMR 没回 updated → 返回里没有 mr_updated / mr_update_error", async () => {
    const id = alloc();
    await seedShip(id, []);
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/5",
      iid: 5,
    });

    const r = await submit(id);

    expect(lastCreateMrArg().updateExistingOnReuse).toBe(false);
    expect(r).toMatchObject({ ok: true });
    const data = (r as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("mr_updated");
    expect(data).not.toHaveProperty("mr_update_error");
  });

  it("记录的源分支与这次不同（解冲突换 __conflict 分支）：updateExistingOnReuse:false", async () => {
    const id = alloc();
    await seedShip(id, [mrRecord()]);
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/10",
      iid: 10,
    });

    await submit(id, { sourceBranch: `${FEATURE}__conflict` });

    expect(lastCreateMrArg().updateExistingOnReuse).toBe(false);
  });
});
