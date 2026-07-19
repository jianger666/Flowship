/**
 * R38 / R37-3 + R37-6 退出矩阵：离线完整物理删除终态 + 503 持续重连
 *
 * ① 已 hydrate watcher → 断 SSE → 真实 DELETE（taskDir+journal 清）→ 重连 404
 *    恰好一次进入 task_deleted terminal，详情/侧栏 sticky 移除
 * ② journal/tombstone EIO（503）→ 不 commit deleted
 * ③ fake timers：连续 7 次 503 后 200/SSE 成功恢复；期间不 deleted、单 loop
 * ④ 410 仍立即 sticky 终止
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
import { ApiRequestError } from "@/lib/task-store";
import {
  __resetTaskTerminalForTests,
  classifyWatchHttpStatus,
  commitTaskDeleted,
  isTaskTerminalDeleted,
  resolveWatchReconnectPolicy,
  WATCH_CLEAN_RECONNECT_DELAY_MS,
  WATCH_MAX_TRANSIENT_FAILURES,
  WATCH_UNAVAILABLE_BACKOFF_CAP_MS,
} from "@/lib/task-terminal";
import {
  canCommitTaskListRefresh,
  filterTaskListAfterRefresh,
} from "@/lib/task-list-refresh";
import type { TaskSummary } from "@/lib/types";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-ownership-r38-offline-"),
);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: vi.fn(),
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
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));
vi.mock("@/lib/server/update-pending", () => ({
  assertNoUpdatePendingRestart: async () => {},
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
  fetchProjects: async () => [{ key: "proj", name: "P" }],
  fetchMyUserKey: async () => "user_key_test",
  fetchUserSchedule: async () => [
    {
      id: "9876543210",
      name: "r38",
      url: "",
      start: Date.now(),
      end: Date.now() + 86400000,
    },
  ],
  meegleAuthStatus: async () => ({ host: "example.feishu.cn" }),
  fetchProjectSimpleNames: async () => new Map([["proj", "simple"]]),
  MeegleError: class MeegleError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  getDeletionJournalPath,
  getTask,
  listTasks,
  readDeletionJournal,
  setDeletionEvidenceReadInjectorForTest,
} = await import("@/lib/server/task-fs");
const { DELETE, GET: GET_DETAIL } = await import(
  "@/app/api/tasks/[id]/route"
);
const { GET: GET_WATCH } = await import(
  "@/app/api/tasks/[id]/watch-task/route"
);
const { checkpointRefName, writeRewindPoints } = await import(
  "@/lib/server/chat-checkpoint"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r38-offline DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
};
const resetBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  delete g[RECOVERY_FLAG];
};

await listTasks();
skipBootRecovery();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

afterEach(() => {
  __resetTaskTerminalForTests();
  setDeletionEvidenceReadInjectorForTest(null);
  vi.useRealTimers();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "r38@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r38"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const treeOidOfHead = (cwd: string): string =>
  git(cwd, "rev-parse", "HEAD^{tree}");

const makeMeta = (id: string, repo?: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r38 ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: repo ? [repo] : [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const dirExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

/** 真实 ref + 空 rewind，保证 DELETE happy path 能清干净 journal */
const seedDeletableTask = async (
  id: string,
): Promise<{ repo: string }> => {
  const repo = mkdtempSync(path.join(TMP_ROOT, "r38-repo-"));
  initGitRepo(repo);
  const treeA = treeOidOfHead(repo);
  const refA = checkpointRefName(id, treeA);
  git(repo, "update-ref", refA, treeA);
  await writeMeta(makeMeta(id, repo));
  await fs.mkdir(path.join(taskDir(id), "checkpoints"), { recursive: true });
  await writeRewindPoints(id, []);
  return { repo };
};

const ids: string[] = [];
const alloc = (): string => {
  const id = `r38_${Date.now().toString(36)}_${ids.length}`;
  ids.push(id);
  return id;
};

beforeEach(() => {
  resetBootRecovery();
  skipBootRecovery();
});

/**
 * 镜像 useTaskWatch catch 分支（无 React）：分类 + retry policy + 恰好一次 deleted。
 * 返回是否终止 loop、下次 delay、以及更新后的失败计数状态。
 */
const applyHydratedWatchCatch = (
  taskId: string,
  err: unknown,
  state: {
    unavailableAttempts: number;
    transientFailures: number;
    unavailableNotified: boolean;
  },
  handlers: {
    onTaskDeleted: (id: string) => void;
    onWatchException: (e: Error) => void;
  },
): {
  stop: boolean;
  delayMs: number | null;
  nextUnavailableAttempts: number;
  nextTransientFailures: number;
  nextUnavailableNotified: boolean;
} => {
  const status =
    err instanceof ApiRequestError
      ? err.status
      : (err as { status?: number }).status;
  const kind =
    typeof status === "number"
      ? classifyWatchHttpStatus(status, { hydratedWatcher: true })
      : "retryable";
  const decision = resolveWatchReconnectPolicy({
    kind,
    unavailableAttempts: state.unavailableAttempts,
    transientFailures: state.transientFailures,
    unavailableNotified: state.unavailableNotified,
  });

  if (decision.action === "terminate_deleted") {
    // 与 hook 一致：已 sticky 则不再回调，保证恰好一次
    if (!isTaskTerminalDeleted(taskId)) {
      handlers.onTaskDeleted(taskId);
    }
    return {
      stop: true,
      delayMs: null,
      nextUnavailableAttempts: state.unavailableAttempts,
      nextTransientFailures: state.transientFailures,
      nextUnavailableNotified: state.unavailableNotified,
    };
  }
  if (decision.action === "terminate_exhausted") {
    handlers.onWatchException(err as Error);
    return {
      stop: true,
      delayMs: null,
      // terminate 时 transient 已在 decision 前 +1 语义上耗尽；镜像旧 helper 的 +1
      nextUnavailableAttempts: state.unavailableAttempts,
      nextTransientFailures: state.transientFailures + 1,
      nextUnavailableNotified: state.unavailableNotified,
    };
  }
  if (decision.notifyException) {
    handlers.onWatchException(err as Error);
  }
  return {
    stop: false,
    delayMs: decision.delayMs,
    nextUnavailableAttempts: decision.nextUnavailableAttempts,
    nextTransientFailures: decision.nextTransientFailures,
    nextUnavailableNotified: decision.nextUnavailableNotified,
  };
};

describe("R38-① 完整物理删除后离线重连 → hydrated-404 收敛", () => {
  it(
    "已 hydrate → 断流 → 真实 DELETE 清干净 → 重连 404 恰好一次 terminal",
    async () => {
      const id = alloc();
      await seedDeletableTask(id);

      // 模拟已 hydrate 的详情 / 侧栏
      let detailTask: { id: string } | null = { id };
      let listEpoch = 0;
      const successfulDeleted = new Set<string>();
      let list: TaskSummary[] = [
        {
          id,
          title: "r38",
          mode: "chat",
          repoStatus: "developing",
          runStatus: "idle",
          actionCount: 0,
          createdAt: 1,
          updatedAt: 1,
        } as TaskSummary,
      ];
      let onTaskDeletedCalls = 0;

      // 模拟 watcher 已连上后断流（不持有 live SSE；只保留 hydrated 上下文）
      const del = await DELETE(new Request(`http://local/api/tasks/${id}`), {
        params: Promise.resolve({ id }),
      });
      expect(del.status).toBe(200);
      expect(await getTask(id)).toBeNull();
      expect(await dirExists(taskDir(id))).toBe(false);
      expect((await readDeletionJournal(id)).kind).toBe("absent");
      expect(await dirExists(getDeletionJournalPath(id))).toBe(false);

      // 生产 detail / watch 此时是 404（不是 410）——Codex 反例底座
      const detail = await GET_DETAIL(
        new Request(`http://local/api/tasks/${id}`),
        { params: Promise.resolve({ id }) },
      );
      expect(detail.status).toBe(404);
      const watchRes = await GET_WATCH(
        new Request(`http://local/api/tasks/${id}/watch-task`, {
          headers: { Accept: "text/event-stream" },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(watchRes.status).toBe(404);

      const err = new ApiRequestError("not_found", 404);
      const handlers = {
        onTaskDeleted: (deletedId: string) => {
          onTaskDeletedCalls += 1;
          commitTaskDeleted(deletedId);
          // 详情页 sink
          if (detailTask?.id === deletedId) detailTask = null;
          // 侧栏 list listener 语义
          listEpoch += 1;
          successfulDeleted.add(deletedId);
          list = filterTaskListAfterRefresh(
            list,
            new Set(),
            successfulDeleted,
          );
        },
        onWatchException: () => {
          throw new Error("不应在 hydrated-404 时 onWatchException");
        },
      };

      const first = applyHydratedWatchCatch(
        id,
        err,
        {
          unavailableAttempts: 0,
          transientFailures: 0,
          unavailableNotified: false,
        },
        handlers,
      );
      expect(first.stop).toBe(true);
      expect(onTaskDeletedCalls).toBe(1);
      expect(isTaskTerminalDeleted(id)).toBe(true);
      expect(detailTask).toBeNull();
      expect(list.find((t) => t.id === id)).toBeUndefined();
      expect(canCommitTaskListRefresh(0, listEpoch)).toBe(false);

      // 重复 404 不得再进 sink（恰好一次）
      const second = applyHydratedWatchCatch(
        id,
        err,
        {
          unavailableAttempts: 0,
          transientFailures: 0,
          unavailableNotified: false,
        },
        handlers,
      );
      expect(second.stop).toBe(true);
      expect(onTaskDeletedCalls).toBe(1);
    },
    40_000,
  );
});

describe("R38-② 503 证据 I/O 故障不 commit deleted", () => {
  it("classify + policy：503 → unavailable；不进 terminal", () => {
    const id = "r38_503_only";
    expect(
      classifyWatchHttpStatus(503, { hydratedWatcher: true }),
    ).toBe("unavailable");

    let deletedCalls = 0;
    const r = applyHydratedWatchCatch(
      id,
      new ApiRequestError("unavailable", 503),
      {
        unavailableAttempts: 0,
        transientFailures: 0,
        unavailableNotified: false,
      },
      {
        onTaskDeleted: () => {
          deletedCalls += 1;
        },
        onWatchException: () => {},
      },
    );
    expect(r.stop).toBe(false);
    expect(r.delayMs).toBeGreaterThan(0);
    expect(deletedCalls).toBe(0);
    expect(isTaskTerminalDeleted(id)).toBe(false);
  });

  it("真实 watch：注入 journal EIO → 503、client 不 commit", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    setDeletionEvidenceReadInjectorForTest((op) => {
      if (op === "journalSync" || op === "journalAsync") {
        const e = new Error("EIO injected") as NodeJS.ErrnoException;
        e.code = "EIO";
        throw e;
      }
    });

    const watchRes = await GET_WATCH(
      new Request(`http://local/api/tasks/${id}/watch-task`, {
        headers: { Accept: "text/event-stream" },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(watchRes.status).toBe(503);

    let deletedCalls = 0;
    applyHydratedWatchCatch(
      id,
      new ApiRequestError("temporarily_unavailable", 503),
      {
        unavailableAttempts: 2,
        transientFailures: 0,
        unavailableNotified: false,
      },
      {
        onTaskDeleted: () => {
          deletedCalls += 1;
          commitTaskDeleted(id);
        },
        onWatchException: () => {},
      },
    );
    expect(deletedCalls).toBe(0);
    expect(isTaskTerminalDeleted(id)).toBe(false);
  });
});

describe("R38-③ 503 持续重试：7 次后仍能恢复", () => {
  it("fake timers：7×503 提示一次且不终止，随后成功恢复", async () => {
    vi.useFakeTimers();
    const id = "r38_503_recover";
    let unavailableAttempts = 0;
    let transientFailures = 0;
    let unavailableNotified = false;
    let exceptionToasts = 0;
    let deletedCalls = 0;
    let loopRuns = 0; // 证明单 loop（串行），无并行重连
    let recovered = false;

    const outcomes: Array<"503" | "ok"> = [
      "503",
      "503",
      "503",
      "503",
      "503",
      "503",
      "503",
      "ok",
    ];

    const runLoop = async () => {
      loopRuns += 1;
      expect(loopRuns).toBe(1); // 只有一个 loop
      for (const outcome of outcomes) {
        if (outcome === "ok") {
          unavailableAttempts = 0;
          transientFailures = 0;
          unavailableNotified = false;
          recovered = true;
          return;
        }
        const step = applyHydratedWatchCatch(
          id,
          new ApiRequestError("unavailable", 503),
          { unavailableAttempts, transientFailures, unavailableNotified },
          {
            onTaskDeleted: () => {
              deletedCalls += 1;
            },
            onWatchException: () => {
              exceptionToasts += 1;
            },
          },
        );
        expect(step.stop).toBe(false);
        unavailableAttempts = step.nextUnavailableAttempts;
        transientFailures = step.nextTransientFailures;
        unavailableNotified = step.nextUnavailableNotified;
        // 退避后继续（同 loop，非新 loop）
        await vi.advanceTimersByTimeAsync(step.delayMs ?? 0);
      }
    };

    const p = runLoop();
    await p;

    expect(recovered).toBe(true);
    expect(deletedCalls).toBe(0);
    expect(isTaskTerminalDeleted(id)).toBe(false);
    // 达阈值提示一次，之后 503 不再刷
    expect(exceptionToasts).toBe(1);
    expect(unavailableAttempts).toBe(0);
    expect(transientFailures).toBe(0);
    // 退避 cap 在 10~15s 区间
    expect(WATCH_UNAVAILABLE_BACKOFF_CAP_MS).toBeGreaterThanOrEqual(10_000);
    expect(WATCH_UNAVAILABLE_BACKOFF_CAP_MS).toBeLessThanOrEqual(15_000);

    // 策略层：第 6 次 unavailable 仍 retry + notify；第 7 次 retry 不再 notify
    const at5 = resolveWatchReconnectPolicy({
      kind: "unavailable",
      unavailableAttempts: 5,
      transientFailures: 0,
      unavailableNotified: false,
    });
    expect(at5.action).toBe("retry");
    if (at5.action === "retry") {
      expect(at5.notifyException).toBe(true);
      expect(at5.nextUnavailableAttempts).toBe(WATCH_MAX_TRANSIENT_FAILURES);
      // R38-2：unavailable 不推进 transient
      expect(at5.nextTransientFailures).toBe(0);
    }
    const at6 = resolveWatchReconnectPolicy({
      kind: "unavailable",
      unavailableAttempts: 6,
      transientFailures: 0,
      unavailableNotified: true,
    });
    expect(at6.action).toBe("retry");
    if (at6.action === "retry") {
      expect(at6.notifyException).toBe(false);
      // nextUnavailable=7 → min(7*1500, cap)=10500；更高次数才触顶
      expect(at6.delayMs).toBe(Math.min(7 * 1500, WATCH_UNAVAILABLE_BACKOFF_CAP_MS));
    }
    const atCap = resolveWatchReconnectPolicy({
      kind: "unavailable",
      unavailableAttempts: 20,
      transientFailures: 0,
      unavailableNotified: true,
    });
    expect(atCap.action).toBe("retry");
    if (atCap.action === "retry") {
      expect(atCap.delayMs).toBe(WATCH_UNAVAILABLE_BACKOFF_CAP_MS);
    }
  });

  it("普通网络错仍保留 6 次上限终止（与 503 持续重试对照）", () => {
    let transientFailures = 0;
    let unavailableAttempts = 0;
    let notified = false;
    let stop = false;
    for (let i = 0; i < WATCH_MAX_TRANSIENT_FAILURES; i++) {
      const d = resolveWatchReconnectPolicy({
        kind: "retryable",
        unavailableAttempts,
        transientFailures,
        unavailableNotified: notified,
      });
      if (d.action === "terminate_exhausted") {
        stop = true;
        break;
      }
      if (d.action === "retry") {
        transientFailures = d.nextTransientFailures;
        unavailableAttempts = d.nextUnavailableAttempts;
        notified = d.nextUnavailableNotified;
      }
    }
    expect(stop).toBe(true);
    expect(transientFailures).toBe(WATCH_MAX_TRANSIENT_FAILURES - 1);
    expect(unavailableAttempts).toBe(0);
  });
});

describe("R38-④ 410 立即 sticky 终止", () => {
  it("410 → terminate_deleted；commit 后详情/侧栏移除", () => {
    const id = "r38_410";
    expect(
      classifyWatchHttpStatus(410, { hydratedWatcher: true }),
    ).toBe("deleted");

    let detail: { id: string } | null = { id };
    let listEpoch = 0;
    const successfulDeleted = new Set<string>();
    let list: TaskSummary[] = [
      {
        id,
        title: "x",
        mode: "chat",
        repoStatus: "developing",
        runStatus: "idle",
        actionCount: 0,
        createdAt: 1,
        updatedAt: 1,
      } as TaskSummary,
    ];

    const step = applyHydratedWatchCatch(
      id,
      new ApiRequestError("task_deleted", 410),
      {
        unavailableAttempts: 0,
        transientFailures: 3,
        unavailableNotified: false,
      },
      {
        onTaskDeleted: (deletedId) => {
          commitTaskDeleted(deletedId);
          detail = null;
          listEpoch += 1;
          successfulDeleted.add(deletedId);
          list = filterTaskListAfterRefresh(
            list,
            new Set(),
            successfulDeleted,
          );
        },
        onWatchException: () => {
          throw new Error("410 不应 onWatchException");
        },
      },
    );

    expect(step.stop).toBe(true);
    expect(step.delayMs).toBeNull();
    expect(isTaskTerminalDeleted(id)).toBe(true);
    expect(detail).toBeNull();
    expect(list).toHaveLength(0);
    expect(listEpoch).toBe(1);
    // 干净重连常量仍导出（被动断流路径）
    expect(WATCH_CLEAN_RECONNECT_DELAY_MS).toBe(1000);
  });
});
