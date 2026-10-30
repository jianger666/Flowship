/**
 * R14 B3-1（Q7a-02 / Q7a-03）：归档（archiveTaskWithReport）与 finalize「同一套收口」。
 *
 * 背景：「要清隔离工作区」的归档（task.mode !== "chat" && isWorktreeTask(task)）旧实现不占 lifecycle、不 revoke、
 * 不 join 资源 job，而且归档空闲隔离任务后会把 cancelTaskRun 写的 pendingStopRequests 残留下来。修复后：
 *   - 先 beginChatLifecycle(id, "finalizing")；占不到（stop / DELETE / finalize / reopen / 另一次归档在飞）→
 *     抛 TaskCleanupInProgressError（PATCH 路由映射 409），且此时定时没取消、任务没标 archived；
 *     finally 里只在「自己占了」时才 endChatLifecycle，不得误释放别人的相位；
 *   - revokeTaskOps：归档前入场的推进 / 预热 / 依赖克隆之后 claim 一律失败；
 *   - joinTerminalOpResources：revokeResourceJobs + 等 starting / resourceJobs 归零，超时 quarantine 且**不删目录**；
 *   - 启动链已退场（!isTaskStarting）才清 pendingStopRequests，还在飞则留给它自裁（Q7a-02）。
 * chat / 非 worktree 的归档只翻标记、取消归档（archived=false）路径不变——用「对照」用例钉住。
 *
 * 用例标题前缀：
 *   【回归】改前（BF）会红，钉住 bug；
 *   【对照】改前改后都绿，钉住「不该变」的行为。
 *
 * 写法约定（机器可能高负载）：不靠固定短 sleep 等异步结果，一律 waitUntil 轮询（上限 30s）；单用例超时 90s；
 * 不做墙钟耗时比值断言。唯一的固定 sleep 是「负向窗口」（断言某事在窗口内**没**发生），机器越慢越不会误红。
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

import type { ScheduleCreateInput } from "@/lib/schedule";
import type { ResourceJobHandle } from "@/lib/server/task-stream";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { ActionRecord } from "@/lib/types";

// 数据目录必须在 import 任何 server 模块之前改好（task-fs-core 在模块加载时钉死 DATA_DIR）
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-archive-quiesce-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: vi.fn(),
  },
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));

const { readEvents, taskDir, withTaskLock, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  beginResourceJob,
  beginTaskStarting,
  clearResourceJobs,
  clearTaskStarting,
  endResourceJob,
  endTaskStarting,
  hasResourceJobs,
  isTaskStarting,
  isWorkspaceQuarantined,
  pendingStopRequests,
  registerJobAbort,
  setResourceJoinTimeoutMsForTest,
} = await import("@/lib/server/task-stream");
const { claimTaskOp, getTaskOpGeneration, isTaskOpCurrent, snapshotTaskOp } =
  await import("@/lib/server/task-op");
const { clearFailpoints, setFailpoint } = await import(
  "@/lib/server/failpoints"
);
const {
  beginChatLifecycle,
  clearChatGate,
  endChatLifecycle,
  getChatLifecycle,
} = await import("@/lib/server/chat-gate");
const { createSchedule, readSchedules } = await import(
  "@/lib/server/schedule-store"
);
const taskFs = await import("@/lib/server/task-fs");
const { getTask, getTaskMeta, listTasks } = taskFs;
const previewManager = await import("@/lib/server/preview-manager");
const taskWorktrees = await import("@/lib/server/task-worktrees");
const {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  getTaskWorktreesDir,
  isWorktreeTask,
} = taskWorktrees;
const {
  archiveTaskWithReport,
  prewarmTaskWorkspace,
  TaskCleanupInProgressError,
} = await import("@/lib/server/task-runner");
const { PATCH } = await import("@/app/api/tasks/[id]/route");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `archive-quiesce DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

// 跳过 boot 恢复：先让它在空目录上跑完一次，之后别让它扫到别的用例留下的任务（与 ownership-r34 同写法）
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
await listTasks();
(globalThis as unknown as Record<string, Promise<void> | undefined>)[
  RECOVERY_FLAG
] = Promise.resolve();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

// ───────────────────────────── 工具 ─────────────────────────────

/** 单用例超时：真 git 仓 + worktree 的用例在高负载机器上可能很慢 */
const CASE_TIMEOUT = 90_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询直到条件成立（上限 timeoutMs）；超时返回 false，由调用方带说明地断言 */
const waitUntil = async (
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
};

/** promise 超时即抛（带说明），避免卡死的用例一直占着 worker 到整体超时 */
const withTimeout = async <T,>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} 未在 ${ms}ms 内完成`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const pathExists = async (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** promise 的拒绝原因（resolve 则返回 null）——用来断言「抛了什么」而不是只断言「抛了」 */
const rejectionOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

const initGitRepo = (dir: string): void => {
  const git = (...args: string[]) =>
    execFileSync("git", args, { stdio: "pipe" });
  git("init", "-b", "main", dir);
  git("-C", dir, "config", "user.email", "archive-quiesce@test");
  git("-C", dir, "config", "user.name", "archive-quiesce");
  writeFileSync(path.join(dir, "a.txt"), "hi");
  git("-C", dir, "add", ".");
  git("-C", dir, "commit", "-m", "init");
};

type TaskKind = "worktree" | "chat" | "plain";

const makeMeta = (
  id: string,
  repo: string,
  kind: TaskKind,
  over: Partial<TaskMetaV06> = {},
): TaskMetaV06 =>
  ({
    id,
    title: `archive-quiesce ${id}`,
    mode: kind === "chat" ? "chat" : "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [repo],
    // worktree：隔离；plain：task 模式但不隔离（无飞书链接的日常轻量态）；chat：不适用
    isolateWorktree:
      kind === "worktree" ? true : kind === "plain" ? false : undefined,
    repoBaseBranches: { [repo]: "main" },
    ...(kind === "worktree"
      ? {
          gitBranches: [
            { repoPath: repo, name: `feat/${id}`, baseBranch: "main" },
          ],
        }
      : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }) as unknown as TaskMetaV06;

const makeAction = (
  status: ActionRecord["status"],
  over: Partial<ActionRecord> = {},
): ActionRecord => ({
  id: "act_1",
  n: 1,
  type: "build",
  status,
  userInstruction: "",
  artifactPath: null,
  startedAt: 1,
  endedAt: status === "running" ? null : 2,
  ...over,
});

const ids: string[] = [];
/** 本用例装的「挂起」failpoint 的放行函数——afterEach 统一放行，防止失败用例留下永久挂起的链 */
const hangs: Array<() => void> = [];
let seq = 0;
const alloc = (): string => {
  const id = `t_aq_${Date.now()}_${seq++}`;
  ids.push(id);
  return id;
};

interface SetupOpts {
  /** 任务形状：worktree = 会真走「停机 + 清隔离工作区」分支（默认）；chat / plain = 只翻标记 */
  kind?: TaskKind;
  /** kind=worktree 时是否先建**真** worktree（默认 false：只测内存态 / 互斥的用例不必付 git worktree 的代价） */
  worktree?: boolean;
  /** 覆盖 meta 字段（actions / runStatus 等） */
  meta?: Partial<TaskMetaV06>;
}

/** 每个用例独立 taskId + 独立临时 git 仓；返回 worktree 路径（仅 kind=worktree） */
const setupTask = async (
  opts: SetupOpts = {},
): Promise<{ id: string; repo: string; wd: string | null }> => {
  const kind = opts.kind ?? "worktree";
  const id = alloc();
  const repo = mkdtempSync(path.join(TMP_ROOT, "repo-"));
  initGitRepo(repo);
  await writeMeta(makeMeta(id, repo, kind, opts.meta));
  await fs.mkdir(taskDir(id), { recursive: true });
  const task = (await getTask(id))!;
  // 前置：任务形状与 kind 一致——worktree 任务才会走清理分支，别让用例悄悄测到了另一条路径
  expect(isWorktreeTask(task)).toBe(kind === "worktree");
  let wd: string | null = null;
  if (kind === "worktree") {
    wd = getTaskWorkRepoPaths(task)[0] ?? null;
    if (opts.worktree) {
      await ensureTaskWorktrees(task, () => true);
      expect(await pathExists(wd!), "前置：worktree 应已建好").toBe(true);
    }
  }
  return { id, repo, wd };
};

/** 给任务建一条周期定时（归档应取消它、取消归档应还原它） */
const addSchedule = async (id: string): Promise<void> => {
  const input: ScheduleCreateInput = {
    kind: "every",
    title: "盯 CI",
    message: "看进度",
    firstFireAt: Date.now() + 60 * 60_000,
    intervalMs: 10 * 60_000,
  };
  const r = await createSchedule(id, input);
  if (!r.ok) throw new Error(r.error);
};

/** 发起一次归档并追踪它是否已收尾（不 await，供「卡在 join 上」的用例观察中间态） */
const startArchive = (id: string) => {
  const state = { settled: false };
  const promise = archiveTaskWithReport(id, true);
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return { promise, state };
};

/**
 * 登记一个资源 job（模拟依赖克隆 / 预热里长跑的子进程）。归档走到 revokeResourceJobs 时会同步调用它的 abort：
 * probe.aborted 即「归档已走到 join」的精确信号；onAbort 决定 job 之后是否退出（默认：收到 abort 也不退 = 卡死的子进程）。
 */
const installStuckJob = (
  id: string,
  onAbort: (job: ResourceJobHandle) => void = () => {},
): { job: ResourceJobHandle; probe: { aborted: boolean } } => {
  const job = beginResourceJob(id);
  const probe = { aborted: false };
  registerJobAbort(id, job.jobId, () => {
    probe.aborted = true;
    onAbort(job);
  });
  return { job, probe };
};

/** 与 ownership-r34 同款：命中后挂起，直到 release */
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
  hangs.push(() => release());
  return { waitHit: () => hit, release: () => release() };
};

const eventTexts = async (id: string): Promise<string[]> =>
  (await readEvents(id)).map((e) => e.text ?? "");

beforeEach(() => {
  clearFailpoints();
  setResourceJoinTimeoutMsForTest(null);
  // join 超时 / 清理失败等预期路径会打 warn / error，别刷屏
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearFailpoints();
  for (const release of hangs.splice(0)) release();
  setResourceJoinTimeoutMsForTest(null);
  for (const id of ids.splice(0)) {
    clearResourceJobs(id);
    clearChatGate(id);
    clearTaskStarting(id);
    pendingStopRequests.delete(id);
    // 等任务锁里排队的写盘收完再删目录：别让 fire-and-forget 的 meta 写入在目录没了之后报 ENOENT
    await withTaskLock(id, async () => {}).catch(() => {});
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
}, 30_000);

// ───────────────────────── Q7a-02：pendingStopRequests ─────────────────────────

describe("Q7a-02：归档后不残留 pendingStopRequests（取消归档后第一次答疑 / 问一问会被它当「启动期停止」静默取消）", () => {
  it(
    "【回归】空闲隔离任务归档（真 worktree）后 pendingStopRequests 不含该任务——改前 cancelTaskRun 写的标记一直残留",
    async () => {
      const { id, wd } = await setupTask({ worktree: true });
      expect(pendingStopRequests.has(id)).toBe(false);

      const res = await archiveTaskWithReport(id, true);

      // 前置（BF 里同样成立，红的只会是最后一条）：确实走了「停机 + 清隔离工作区」分支
      expect(res?.task.archived).toBe(true);
      expect(res?.report.worktree?.removed).toBe(true);
      expect(await pathExists(wd!)).toBe(false);
      // 要点：启动链早已退场，标记不该留给后来的答疑 / 问一问去撞
      expect(pendingStopRequests.has(id)).toBe(false);
    },
    CASE_TIMEOUT,
  );

  it(
    "【对照】启动链仍在飞（isTaskStarting）且 join 超时时归档，标记保留——留给迟到的启动链自裁（清掉它会让迟到的 create 注册成功又不自裁）",
    async () => {
      const { id } = await setupTask();
      setResourceJoinTimeoutMsForTest(200);
      beginTaskStarting(id);
      try {
        const res = await archiveTaskWithReport(id, true);
        expect(res?.task.archived).toBe(true);
        // 启动链没退场（join 只是超时放行），所以标记必须还在
        expect(isTaskStarting(id)).toBe(true);
        expect(pendingStopRequests.has(id)).toBe(true);
      } finally {
        // 清理 starting 与测试状态
        endTaskStarting(id);
        pendingStopRequests.delete(id);
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "【回归】启动链在 join 窗口内退场：归档等它退场后才收尾（不抢跑），退场后标记被清——改前不 join、也不清",
    async () => {
      const { id } = await setupTask();
      // 不靠超时放行：必须是「启动链退场」才放行
      setResourceJoinTimeoutMsForTest(60_000);
      beginTaskStarting(id);
      const { promise, state } = startArchive(id);

      // cancelTaskRun 在 join 之前同步写标记——看到它，说明归档已走到 revoke / join 附近
      await waitUntil(() => pendingStopRequests.has(id) || state.settled);
      // 负向窗口：让 join 轮询多转几圈，启动链还在飞，归档就不得收尾（机器越慢越不会误红）
      await sleep(300);
      expect(
        state.settled,
        "启动链（isTaskStarting）还在飞，归档不该已经收尾",
      ).toBe(false);
      expect(pendingStopRequests.has(id)).toBe(true);

      endTaskStarting(id); // 启动链退场
      const res = await withTimeout(promise, 30_000, "归档");
      expect(res?.task.archived).toBe(true);
      expect(pendingStopRequests.has(id)).toBe(false);
    },
    CASE_TIMEOUT,
  );
});

// ───────────────────── Q7a-03：lifecycle 占用 / 释放 / 互斥 ─────────────────────

describe("Q7a-03：归档占 finalizing lifecycle（与 finalize 同一套互斥）", () => {
  it(
    "【回归】归档卡在 join 上期间占着 finalizing；放行后释放——改前整个归档不占 lifecycle",
    async () => {
      const { id } = await setupTask();
      setResourceJoinTimeoutMsForTest(60_000); // 不让它自己超时：必须靠 endResourceJob 放行
      let lifecycleAtAbort = "未触发" as string | null;
      const { job, probe } = installStuckJob(id, () => {
        // abort 由归档的 revokeResourceJobs 同步调用——此刻归档正在 join 里
        lifecycleAtAbort = getChatLifecycle(id);
      });

      const { promise, state } = startArchive(id);
      // BF 的归档不 revoke、直接收尾：state.settled 先成立，下面的断言以「断言失败」收场而不是白等
      await waitUntil(() => probe.aborted || state.settled);
      expect(
        probe.aborted,
        "归档应先 revoke 资源 job（调用已登记的 abort）",
      ).toBe(true);
      // 负向窗口：让 join 轮询多转几圈——归档仍该卡在 join 上、仍占着 finalizing（机器越慢越不会误红）
      await sleep(200);
      expect(lifecycleAtAbort).toBe("finalizing");
      expect(getChatLifecycle(id)).toBe("finalizing");
      expect(state.settled, "job 没退出前归档不得收尾").toBe(false);

      endResourceJob(job); // 放行
      const res = await withTimeout(promise, 30_000, "归档");
      expect(res?.task.archived).toBe(true);
      expect(getChatLifecycle(id)).toBeNull();
    },
    CASE_TIMEOUT,
  );

  it(
    "【回归】归档在飞时再来一次归档（双击 / 另一个标签页）→ 409 语义；被拒的那次不得把在飞那次的 finalizing 释放掉",
    async () => {
      const { id } = await setupTask();
      setResourceJoinTimeoutMsForTest(60_000);
      const { job, probe } = installStuckJob(id);
      const first = startArchive(id);
      await waitUntil(() => probe.aborted || first.state.settled);
      expect(probe.aborted, "第一次归档应已走到 join").toBe(true);
      expect(getChatLifecycle(id)).toBe("finalizing");

      // 同相位重入：beginChatLifecycle 返回 false → 占不到
      const err = await rejectionOf(archiveTaskWithReport(id, true));
      expect(err).toBeInstanceOf(TaskCleanupInProgressError);
      // 被拒的那次没占过，finally 不该替它 end——第一次还卡在 join 上、理应继续占着
      expect(getChatLifecycle(id)).toBe("finalizing");
      expect(first.state.settled).toBe(false);

      endResourceJob(job);
      const res = await withTimeout(first.promise, 30_000, "第一次归档");
      expect(res?.task.archived).toBe(true);
      expect(getChatLifecycle(id)).toBeNull();
    },
    CASE_TIMEOUT,
  );

  it(
    "【回归】归档卡在 join 时 DELETE 到达（finalizing 升级为 deleting）：归档收尾只放自己的 finalizing，不得把 DELETE 的 deleting 释放掉",
    async () => {
      const { id } = await setupTask();
      setResourceJoinTimeoutMsForTest(60_000);
      const { job, probe } = installStuckJob(id);
      const { promise, state } = startArchive(id);
      await waitUntil(() => probe.aborted || state.settled);
      expect(probe.aborted, "归档应已走到 join").toBe(true);
      expect(getChatLifecycle(id)).toBe("finalizing");

      // DELETE 在收尾窗口到达：finalizing → deleting 的升级是 chat-gate 既有语义
      expect(beginChatLifecycle(id, "deleting")).toBe(true);
      expect(getChatLifecycle(id)).toBe("deleting");

      endResourceJob(job);
      await withTimeout(promise, 30_000, "归档");
      // 改前归档不占 lifecycle、自然无此保护；若修复里的 end 不带相位（或无条件释放），这里会变成 null，
      // DELETE 的互斥窗口就被归档收尾悄悄打开了
      expect(getChatLifecycle(id)).toBe("deleting");
      endChatLifecycle(id, "deleting"); // 模拟 DELETE 收尾
    },
    CASE_TIMEOUT,
  );

  it(
    "【回归】清理段内（removeTaskWorktrees 被调用时）占的是 finalizing；清理抛错只记日志、归档仍成功，lifecycle 照常释放",
    async () => {
      const { id } = await setupTask();
      let lifecycleAtRemove = "未调用" as string | null;
      const removeSpy = vi
        .spyOn(taskWorktrees, "removeTaskWorktrees")
        .mockImplementation(async () => {
          lifecycleAtRemove = getChatLifecycle(id);
          throw new Error("boom: 模拟 git worktree remove 失败");
        });

      const res = await archiveTaskWithReport(id, true);

      expect(removeSpy).toHaveBeenCalledTimes(1);
      // 改前：清理发生时没人占 lifecycle（null），推进 / 预热可以在这个窗口里拿到合法 claim
      expect(lifecycleAtRemove).toBe("finalizing");
      // 清理是 best-effort：失败不挡归档主流程（目录没删成 → report 如实说 removed=false）
      expect(res?.task.archived).toBe(true);
      expect(res?.report.worktree?.removed).toBe(false);
      expect(getChatLifecycle(id)).toBeNull();
    },
    CASE_TIMEOUT,
  );

  it(
    "【回归】归档中途抛错（落 archived 标记失败）→ 抛出原错误，finally 仍释放 lifecycle——改前根本没占",
    async () => {
      const { id } = await setupTask();
      let lifecycleAtThrow = "未调用" as string | null;
      vi.spyOn(taskFs, "setTaskPinArchive").mockImplementationOnce(async () => {
        lifecycleAtThrow = getChatLifecycle(id);
        throw new Error("boom: 写 meta 失败");
      });

      await expect(archiveTaskWithReport(id, true)).rejects.toThrow(
        "boom: 写 meta 失败",
      );

      expect(lifecycleAtThrow).toBe("finalizing");
      expect(getChatLifecycle(id)).toBeNull();
      // 释放干净：别的收尾（stop / finalize / DELETE）随后能正常占到
      expect(beginChatLifecycle(id, "stopping")).toBe(true);
      endChatLifecycle(id, "stopping");
    },
    CASE_TIMEOUT,
  );
});

describe("Q7a-03：stop / DELETE / finalize / reopen 在飞时归档被拒（409 语义）", () => {
  const busyPhases = ["stopping", "finalizing", "reopening"] as const;

  it.each(busyPhases)(
    "【回归】%s 在飞 → 抛 TaskCleanupInProgressError；整个归档不发生（定时未取消、未标 archived），别人的相位不被误释放；释放后再归档成功",
    async (phase) => {
      const { id } = await setupTask();
      await addSchedule(id);
      expect(beginChatLifecycle(id, phase)).toBe(true); // 模拟那个收尾正在飞

      const err = await rejectionOf(archiveTaskWithReport(id, true));

      expect(
        err,
        "占不到 lifecycle 应抛 TaskCleanupInProgressError",
      ).toBeInstanceOf(TaskCleanupInProgressError);
      expect((err as Error).message).toMatch(/停止.*请稍后再试/);
      // 「占不到就整个归档不发生」——不留「定时已取消、任务没归档」的半截状态
      expect((await getTaskMeta(id))?.archived).toBeFalsy();
      const [sched] = await readSchedules(id);
      expect(sched?.status).toBe("active");
      expect(sched?.archiveCancelled).toBeUndefined();
      expect(
        (await eventTexts(id)).some((t) => t.includes("会话已归档")),
        "不该写「会话已归档…定时一并取消」",
      ).toBe(false);
      // 抛错发生在 try 之前：finally 的 end 不能替别人释放
      expect(getChatLifecycle(id)).toBe(phase);

      endChatLifecycle(id, phase);
      const res = await archiveTaskWithReport(id, true);
      expect(res?.task.archived).toBe(true);
      expect(res?.report.cancelledSchedules).toBe(1);
      expect(getChatLifecycle(id)).toBeNull();
    },
    CASE_TIMEOUT,
  );

  it(
    "【回归】deleting 在飞 → 文案是「任务正在删除、请稍后再试」（不是笼统的停止 / 终结）；任务未被归档",
    async () => {
      const { id } = await setupTask();
      expect(beginChatLifecycle(id, "deleting")).toBe(true);

      const err = await rejectionOf(archiveTaskWithReport(id, true));

      expect(err).toBeInstanceOf(TaskCleanupInProgressError);
      const message = (err as Error).message;
      expect(message).toContain("删除");
      expect(message).toContain("请稍后再试");
      expect(message).not.toContain("停止");
      expect((await getTaskMeta(id))?.archived).toBeFalsy();
      expect(getChatLifecycle(id)).toBe("deleting");
    },
    CASE_TIMEOUT,
  );
});

// ───────────────────────── Q7a-03：revoke 在途启动意图 ─────────────────────────

describe("Q7a-03：归档 revoke 在途启动意图（归档前入场的推进 / 预热 / 依赖克隆之后 claim 一律失败）", () => {
  it(
    "【回归】归档后：归档前 claim 的 owner 失主、归档前的观察者快照失效、旧 admission gen 再 claim 得 null；新入场仍可 claim",
    async () => {
      const { id } = await setupTask();
      const staleGen = getTaskOpGeneration(id); // 归档前入场的推进 / 预热 / 依赖克隆拿的就是它
      const owner = claimTaskOp(id, staleGen)!; // 模拟归档前已入场并 claim 的推进
      const observer = snapshotTaskOp(id); // 模拟归档前入场的 one-shot / ask-consume 观察者
      expect(owner).not.toBeNull();
      expect(isTaskOpCurrent(owner)).toBe(true);
      expect(isTaskOpCurrent(observer)).toBe(true);

      await archiveTaskWithReport(id, true);

      // 改前：归档不 revoke，下面几条全反（旧入场仍合法，会和 removeTaskWorktrees 并行写同一批目录）
      expect(getTaskOpGeneration(id)).not.toBe(staleGen);
      expect(isTaskOpCurrent(owner)).toBe(false);
      expect(isTaskOpCurrent(observer)).toBe(false);
      expect(claimTaskOp(id, staleGen)).toBeNull();
      // 对照：revoke 只作废旧入场，不把任务永久锁死（取消归档后下一次推进要能 claim）
      expect(claimTaskOp(id, getTaskOpGeneration(id))).not.toBeNull();
    },
    CASE_TIMEOUT,
  );

  it(
    "【回归】端到端：归档时预热卡在 worktree add 之前，归档完成后才放行预热——迟到的预热不得把刚清掉的 worktree 又建出来",
    async () => {
      // 隔离任务 + 还没有 worktree：预热会（以 detached 方式）新建。预热全程登记 starting，所以归档的 join 会等它——
      // 这里把 join 超时压到 300ms，让归档先收尾，再放行预热，复现「归档之后预热才醒」的竞态。
      const { id } = await setupTask();
      const worktreesDir = getTaskWorktreesDir(id);
      const hang = installHangingFailpoint("prewarm.beforeWorktreeAdd");
      prewarmTaskWorkspace(id);
      await withTimeout(
        hang.waitHit(),
        30_000,
        "预热走到 prewarm.beforeWorktreeAdd",
      );
      expect(isTaskStarting(id)).toBe(true);
      setResourceJoinTimeoutMsForTest(300);

      const res = await withTimeout(
        archiveTaskWithReport(id, true),
        60_000,
        "归档",
      );
      expect(res?.task.archived).toBe(true);
      expect(await pathExists(worktreesDir)).toBe(false);

      hang.release(); // 预热在归档之后才醒
      expect(
        await waitUntil(() => !isTaskStarting(id)),
        "预热应在放行后退场",
      ).toBe(true);
      // 改前：预热的 lease（opGen 未变、lifecycle 已空）仍合法，worktree 被它重新建出来，还写一条「已后台预热」info
      expect(
        await pathExists(worktreesDir),
        "归档后迟到的预热把 worktree 又建出来了",
      ).toBe(false);
      expect(
        (await eventTexts(id)).some((t) => t.includes("后台预热")),
      ).toBe(false);
    },
    CASE_TIMEOUT,
  );
});

// ─────────────────── Q7a-03：join 资源 job + quarantine ───────────────────

describe("Q7a-03：归档先 revoke + join 资源 job，等满仍没退 → quarantine、不删目录", () => {
  it(
    "【回归】资源 job 收到 abort 后在期限内退出 → 正常清理：清理发生在 job 退出之后、占着 finalizing；worktree 被删、归档成功",
    async () => {
      const { id, wd } = await setupTask({ worktree: true });
      setResourceJoinTimeoutMsForTest(20_000); // 宽限期远大于 job 的退出时间
      // 模拟依赖克隆 job：收到 abort（子进程被杀）后很快退出
      const { probe } = installStuckJob(id, (job) => {
        setTimeout(() => endResourceJob(job), 50);
      });
      const realRemove = taskWorktrees.removeTaskWorktrees;
      const removeCalls: Array<{ jobsAlive: boolean; lifecycle: string | null }> =
        [];
      vi.spyOn(taskWorktrees, "removeTaskWorktrees").mockImplementation(
        async (t) => {
          removeCalls.push({
            jobsAlive: hasResourceJobs(id),
            lifecycle: getChatLifecycle(id),
          });
          return realRemove(t);
        },
      );

      const res = await withTimeout(
        archiveTaskWithReport(id, true),
        60_000,
        "归档",
      );

      // 改前：清理在 job 还活着时就发生（jobsAlive:true），而且没人占 lifecycle（null）
      expect(removeCalls).toEqual([{ jobsAlive: false, lifecycle: "finalizing" }]);
      expect(probe.aborted, "revokeResourceJobs 应触发 job 的 abort").toBe(true);
      expect(isWorkspaceQuarantined(id)).toBe(false);
      expect(res?.task.archived).toBe(true);
      expect(res?.report.worktree?.removed).toBe(true);
      expect(await pathExists(wd!)).toBe(false);
      const texts = await eventTexts(id);
      expect(texts.some((t) => t.includes("已归档并清理任务隔离工作区"))).toBe(
        true,
      );
      expect(texts.some((t) => t.includes("本次没清理隔离工作区"))).toBe(false);
      expect(getChatLifecycle(id)).toBeNull();
    },
    CASE_TIMEOUT,
  );

  it(
    "【回归】资源 job 不退出 + join 超时 → quarantine、removeTaskWorktrees 不被调用、目录原样保留，归档仍成功并写 info；job 退出后 quarantine 自动解除、再归档一次即可清理",
    async () => {
      const { id, wd } = await setupTask({ worktree: true });
      const marker = path.join(wd!, "keep-me.txt");
      await fs.writeFile(marker, "owned");
      setResourceJoinTimeoutMsForTest(200);
      const { job, probe } = installStuckJob(id); // 收到 abort 也不退出 = 卡死的子进程
      const removeSpy = vi.spyOn(taskWorktrees, "removeTaskWorktrees");

      const res = await withTimeout(
        archiveTaskWithReport(id, true),
        60_000,
        "归档",
      );

      expect(probe.aborted, "revokeResourceJobs 应触发 job 的 abort").toBe(true);
      expect(isWorkspaceQuarantined(id)).toBe(true);
      // 改前：不 join、不 quarantine，旧事务还可能写盘时就把目录删了
      expect(removeSpy).not.toHaveBeenCalled();
      expect(await pathExists(wd!)).toBe(true);
      expect(await fs.readFile(marker, "utf8")).toBe("owned");
      // 归档本身仍成功（best-effort 清理不挡主流程），并如实回报「没清」
      expect(res?.task.archived).toBe(true);
      expect(res?.report.worktree).toEqual({
        removed: false,
        kept: [],
        snapshotCount: 0,
      });
      const texts = await eventTexts(id);
      expect(
        texts.some((t) => t.includes("本次没清理隔离工作区")),
        "应写一条 info 告诉用户这次没清",
      ).toBe(true);
      expect(texts.some((t) => t.includes("已归档并清理任务隔离工作区"))).toBe(
        false,
      );
      // join 超时的路径 lifecycle 同样要释放（finally）
      expect(getChatLifecycle(id)).toBeNull();
      expect(hasResourceJobs(id)).toBe(true);

      // job 终于退出：quarantine 随之自动解除（归档不留永久隔离，否则取消归档后推进会被永远拒绝）
      endResourceJob(job);
      expect(isWorkspaceQuarantined(id)).toBe(false);
      // 「取消归档后再归档一次清理」（真实用户流程，也不依赖「对已归档任务重复归档」这种实现细节）：
      // 这次没有在飞的 job，正常删除
      const unarchived = await archiveTaskWithReport(id, false);
      expect(unarchived?.task.archived).toBeFalsy();
      const again = await withTimeout(
        archiveTaskWithReport(id, true),
        60_000,
        "再次归档",
      );
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(again?.report.worktree?.removed).toBe(true);
      expect(await pathExists(wd!)).toBe(false);
    },
    CASE_TIMEOUT,
  );
});

// ───────────────────── 对照：不该变的行为 ─────────────────────

describe("对照：只翻标记的归档 / 取消归档 / action 收尾口径不变", () => {
  const flagOnlyKinds = ["chat", "plain"] as const;

  it.each(flagOnlyKinds)(
    "【对照】%s 任务归档只翻标记：成功、没有 worktree 回报、定时照旧被取消（带还原标记）、全程不占 lifecycle",
    async (kind) => {
      const { id } = await setupTask({ kind });
      await addSchedule(id);

      const res = await archiveTaskWithReport(id, true);

      expect(res?.task.archived).toBe(true);
      expect(res?.report.worktree).toBeUndefined();
      expect(res?.report.cancelledSchedules).toBe(1);
      const [sched] = await readSchedules(id);
      expect(sched?.status).toBe("cancelled");
      expect(sched?.archiveCancelled).toBeDefined();
      expect(getChatLifecycle(id)).toBeNull();
    },
    CASE_TIMEOUT,
  );

  it.each(flagOnlyKinds)(
    "【对照】%s 任务归档不占 lifecycle：别的收尾占着时照常成功（只有要清工作区的归档才互斥），且不动别人的相位",
    async (kind) => {
      const { id } = await setupTask({ kind });
      expect(beginChatLifecycle(id, "stopping")).toBe(true);

      const res = await archiveTaskWithReport(id, true);

      expect(res?.task.archived).toBe(true);
      expect(getChatLifecycle(id)).toBe("stopping");
    },
    CASE_TIMEOUT,
  );

  it(
    "【对照】取消归档（archived=false）：只翻标记并还原定时，不碰 lifecycle（别的收尾占着也照常）",
    async () => {
      const { id } = await setupTask();
      await addSchedule(id);
      const archived = await archiveTaskWithReport(id, true);
      expect(archived?.task.archived).toBe(true);
      expect(archived?.report.cancelledSchedules).toBe(1);
      expect(beginChatLifecycle(id, "stopping")).toBe(true);

      const res = await archiveTaskWithReport(id, false);

      expect(res?.task.archived).toBeFalsy();
      expect(res?.report.restoredSchedules).toBe(1);
      expect(res?.report.worktree).toBeUndefined();
      const [sched] = await readSchedules(id);
      expect(sched?.status).toBe("active");
      expect(getChatLifecycle(id)).toBe("stopping");
    },
    CASE_TIMEOUT,
  );

  it(
    "【对照】归档停预览是 best-effort 且先于删 worktree：停预览抛错只记日志，归档与清理照常完成",
    async () => {
      const { id, wd } = await setupTask({ worktree: true });
      const order: string[] = [];
      vi.spyOn(previewManager, "stopPreviewsForTask").mockImplementation(
        async () => {
          order.push("stopPreviews");
          throw new Error("boom: 停预览失败");
        },
      );
      const realRemove = taskWorktrees.removeTaskWorktrees;
      vi.spyOn(taskWorktrees, "removeTaskWorktrees").mockImplementation(
        async (t) => {
          order.push("removeWorktrees");
          return realRemove(t);
        },
      );

      const res = await archiveTaskWithReport(id, true);

      // 先停预览（释放对 worktree 目录的占用）再删目录
      expect(order).toEqual(["stopPreviews", "removeWorktrees"]);
      expect(res?.task.archived).toBe(true);
      expect(res?.report.worktree?.removed).toBe(true);
      expect(await pathExists(wd!)).toBe(false);
    },
    CASE_TIMEOUT,
  );

  it(
    "【对照】awaiting_ack 的 action 在归档时保留（恢复后仍可 ack），runStatus 收回 idle",
    async () => {
      const { id } = await setupTask({
        meta: {
          actions: [makeAction("awaiting_ack")],
          currentActionId: "act_1",
          runStatus: "awaiting_user",
        },
      });

      const res = await archiveTaskWithReport(id, true);

      expect(res?.task.archived).toBe(true);
      const meta = await getTaskMeta(id);
      expect(meta?.actions.map((a) => a.status)).toEqual(["awaiting_ack"]);
      expect(meta?.runStatus).toBe("idle");
    },
    CASE_TIMEOUT,
  );

  it(
    "【对照】running 的 action 在归档时收成 cancelled（落 endedAt）、runStatus 回 idle——「只收 running」的口径不变",
    async () => {
      const { id } = await setupTask({
        meta: {
          actions: [makeAction("running")],
          currentActionId: "act_1",
          runStatus: "running",
        },
      });

      const res = await archiveTaskWithReport(id, true);

      expect(res?.task.archived).toBe(true);
      const meta = await getTaskMeta(id);
      expect(meta?.actions.map((a) => a.status)).toEqual(["cancelled"]);
      expect(typeof meta?.actions[0]?.endedAt).toBe("number");
      expect(meta?.runStatus).toBe("idle");
    },
    CASE_TIMEOUT,
  );
});

// ───────────────────── route：PATCH /api/tasks/[id] ─────────────────────

const patchArchived = async (id: string, archived: boolean) => {
  const res = await PATCH(
    new Request(`http://localhost/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return {
    status: res.status,
    body: (await res.json()) as { error?: string; task?: { archived?: boolean } },
  };
};

describe("route：PATCH /api/tasks/[id] {archived} 把「清理在飞」映射成 409", () => {
  it(
    "【回归】stopping 在飞 → 409 且 error 含「请稍后再试」，任务未归档；释放后 200、archived=true——改前归档照做、返回 200",
    async () => {
      const { id } = await setupTask();
      expect(beginChatLifecycle(id, "stopping")).toBe(true);

      const blocked = await patchArchived(id, true);

      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toContain("请稍后再试");
      expect((await getTaskMeta(id))?.archived).toBeFalsy();

      endChatLifecycle(id, "stopping");
      const ok = await patchArchived(id, true);
      expect(ok.status).toBe(200);
      expect(ok.body.task?.archived).toBe(true);
      expect((await getTaskMeta(id))?.archived).toBe(true);
    },
    CASE_TIMEOUT,
  );

  it(
    "【回归】deleting 在飞 → 409，文案说「删除」",
    async () => {
      const { id } = await setupTask();
      expect(beginChatLifecycle(id, "deleting")).toBe(true);

      const blocked = await patchArchived(id, true);

      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toContain("删除");
      expect(blocked.body.error).toContain("请稍后再试");
      expect((await getTaskMeta(id))?.archived).toBeFalsy();
    },
    CASE_TIMEOUT,
  );

  it(
    "【对照】chat 任务归档不涉及清理：stopping 在飞时 PATCH 仍 200（409 只给要清工作区的归档）",
    async () => {
      const { id } = await setupTask({ kind: "chat" });
      expect(beginChatLifecycle(id, "stopping")).toBe(true);

      const res = await patchArchived(id, true);

      expect(res.status).toBe(200);
      expect(res.body.task?.archived).toBe(true);
    },
    CASE_TIMEOUT,
  );

  it(
    "【对照】归档抛出「非冲突」错误（落标记抛 boom）→ 原样往外抛到外层 catch：400 bad_request + console.error 带原错误，任务未归档；不能被吞成 404 not_found（R14 Q7a-03）",
    async () => {
      // chat 任务走早退分支（只翻标记、不占 lifecycle）：setTaskPinArchive 是这一路唯一会抛的点。
      // 路由的 catch 只认 TaskCleanupInProgressError 映射 409，别的错误必须 `throw err` 交给外层 catch——
      // 若有人删了那句 throw，outcome 没赋值 → 落到 `if (!outcome)` → 404 not_found，原错误还不进日志
      const { id } = await setupTask({ kind: "chat" });
      const boom = new Error("boom: 写 meta 失败");
      vi.spyOn(taskFs, "setTaskPinArchive").mockRejectedValueOnce(boom);
      // 外层 catch 会 console.error 整条错误：静音（afterEach 的 restoreAllMocks 会还原），同时拿来断言「原错误被记了日志」
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await patchArchived(id, true);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_request");
      expect(errSpy).toHaveBeenCalledWith("[PATCH /api/tasks/[id]] failed", boom);
      // spy 只拦了这一次、而且抛在落标记之前：任务没被标 archived
      expect((await getTaskMeta(id))?.archived).toBeFalsy();
    },
    CASE_TIMEOUT,
  );
});
