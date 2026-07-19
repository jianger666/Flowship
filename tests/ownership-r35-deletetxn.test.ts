/**
 * R35 / R34-1+2+3+7 退出矩阵：DeleteTxn 只前滚 + Guard 在 HTTP 提交点
 *
 * ① 双真实 checkpoint ref：首个/中间删后注错 → 任务不可读、committed journal 保留、
 *    重启幂等完成；绝无「4xx + task 可见 + ref 已少」
 * ② prepared journal 写失败 / tombstone rename 失败 → 非 2xx + 任务完整可见；
 *    tombstone 成功后 committed journal 写失败 → 对外 accepted、重启完成、禁止「4xx 但已删」
 * ③ manifest 读损坏 + 真实 ref 在 → 不当零 ref 完成；恢复后可删、journal 最后删
 * ④ 直调生产 route：committed journal 落在 helper final guard 后、route continuation 前
 *    → detail/list/events/board 都不返回删除项
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

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-ownership-r35-deletetxn-"),
);
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

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
      name: "r35",
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
  assertTaskReadable,
  getDeletionJournalPath,
  getTask,
  listTasks,
  readDeletionJournal,
  writeDeletionJournal,
  writeDeleteTombstone,
} = await import("@/lib/server/task-fs");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  checkpointRefName,
  getRewindPointsPath,
  writeRewindPoints,
} = await import("@/lib/server/chat-checkpoint");
const {
  beginResourceJob,
  clearResourceJobs,
  registerJobAbort,
  setResourceJoinTimeoutMsForTest,
} = await import("@/lib/server/task-stream");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { DELETE, GET: GET_DETAIL } = await import(
  "@/app/api/tasks/[id]/route"
);
const { GET: GET_LIST } = await import("@/app/api/tasks/route");
const { GET: GET_EVENTS } = await import("@/app/api/tasks/[id]/events/route");
const { GET: GET_BOARD } = await import("@/app/api/feishu/board/route");
const { appendEvent } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r35-deletetxn DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const RECOVERY_FLAG = "__feAiFlowBootRecoveryPromiseV2__";

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

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "r35@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r35"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const refExists = (cwd: string, ref: string): boolean => {
  try {
    git(cwd, "show-ref", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};

const treeOidOfHead = (cwd: string): string =>
  git(cwd, "rev-parse", "HEAD^{tree}");

const makeMeta = (id: string, repo?: string, feishuStoryUrl?: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r35 ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: repo ? [repo] : [],
    feishuStoryUrl,
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

/** 造两个真实 checkpoint ref + rewind_points */
const seedTwoCheckpointRefs = async (
  id: string,
): Promise<{ repo: string; refA: string; refB: string }> => {
  const repo = mkdtempSync(path.join(TMP_ROOT, "r35-repo-"));
  initGitRepo(repo);
  const treeA = treeOidOfHead(repo);
  writeFileSync(path.join(repo, "a.txt"), "v2");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "v2");
  const treeB = treeOidOfHead(repo);
  const refA = checkpointRefName(id, treeA);
  const refB = checkpointRefName(id, treeB);
  git(repo, "update-ref", refA, treeA);
  git(repo, "update-ref", refB, treeB);

  await writeMeta(makeMeta(id, repo));
  await fs.mkdir(path.join(taskDir(id), "checkpoints"), { recursive: true });
  await writeRewindPoints(id, [
    {
      eventId: "e1",
      createdAt: Date.now(),
      repoSnapshots: [{ repoPath: repo, treeOid: treeA }],
      kind: "checkpoint",
    },
    {
      eventId: "e2",
      createdAt: Date.now() + 1,
      repoSnapshots: [{ repoPath: repo, treeOid: treeB }],
      kind: "checkpoint",
    },
  ]);
  return { repo, refA, refB };
};

const ids: string[] = [];
const alloc = (): string => {
  const id = `t_r35_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
};

beforeEach(() => {
  clearFailpoints();
  setResourceJoinTimeoutMsForTest(null);
  skipBootRecovery();
});

afterEach(async () => {
  clearFailpoints();
  setResourceJoinTimeoutMsForTest(null);
  for (const id of ids.splice(0)) {
    clearChatGate(id);
    clearResourceJobs(id);
    try {
      await fs.rm(taskDir(id), { recursive: true, force: true });
    } catch {
      /* noop */
    }
    try {
      await fs.unlink(getDeletionJournalPath(id));
    } catch {
      /* noop */
    }
  }
});

describe("R35 DeleteTxn 只前滚 + HTTP Guard", () => {
  it(
    "① 双 ref：首个删除后注错 → 202/不可读/journal 保留/重启完成，绝无 4xx+可见+ref 少",
    async () => {
      const id = alloc();
      const { repo, refA, refB } = await seedTwoCheckpointRefs(id);
      expect(refExists(repo, refA)).toBe(true);
      expect(refExists(repo, refB)).toBe(true);

      setFailpoint("checkpointRefs.afterFirstDelete", async () => {
        throw new Error("R34-1 probe: afterFirstDelete");
      });

      const res = await DELETE(new Request("http://local/api/tasks/" + id), {
        params: Promise.resolve({ id }),
      });
      // R34-1：committed 后异常 → accepted/recoveryPending，禁止 4xx 鼓励重试
      expect(res.status).toBeLessThan(400);
      const body = (await res.json()) as {
        ok?: boolean;
        recoveryPending?: boolean;
      };
      expect(body.ok).toBe(true);
      expect(assertTaskReadable(id)).toBe(false);
      expect(await getTask(id)).toBeNull();

      const journal = await readDeletionJournal(id);
      expect(journal.kind).toBe("present");
      if (journal.kind !== "present") throw new Error("expected present");
      expect(journal.value.phase).toBe("committed");
      // 关键：绝无「4xx + 任务可见 + ref 已少」——此处已是非 4xx 且不可读
      expect(refExists(repo, refA) && refExists(repo, refB)).toBe(false);

      clearFailpoints();
      // 等 catch 里 fire-and-forget recovery 告一段落
      await new Promise<void>((r) => setTimeout(r, 100));
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();

      expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
      expect(refExists(repo, refA)).toBe(false);
      expect(refExists(repo, refB)).toBe(false);
      expect(await getTask(id)).toBeNull();
    },
    40_000,
  );

  it(
    "①b 中间 ref 删除后注错（第二次 afterFirst 等价：已删 1 个后抛）→ 同不变量",
    async () => {
      const id = alloc();
      const { repo, refA, refB } = await seedTwoCheckpointRefs(id);

      let deletes = 0;
      setFailpoint("checkpointRefs.afterFirstDelete", async () => {
        deletes += 1;
        // cleanup 只在「首个成功删」后调一次 failpoint——再挂第二次需改生产；
        // 这里用「删完首个后抛」覆盖「不可逆副作用后异常」窗口（与 ① 同族）
        throw new Error("R34-1 probe: mid-cleanup");
      });

      const res = await DELETE(new Request("http://local/api/tasks/" + id), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBeLessThan(400);
      expect(assertTaskReadable(id)).toBe(false);
      expect(deletes).toBe(1);
      // 绝无「4xx + 可见 + ref 少」
      expect(res.status).not.toBeGreaterThanOrEqual(400);
      const goneCount = [refA, refB].filter((r) => !refExists(repo, r)).length;
      expect(goneCount).toBeGreaterThanOrEqual(1);
      expect((await readDeletionJournal(id)).kind).toBe("present");

      clearFailpoints();
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();
      expect(refExists(repo, refA)).toBe(false);
      expect(refExists(repo, refB)).toBe(false);
    },
    40_000,
  );

  it("②a prepared journal 写失败 → 非 2xx + 任务完整可见", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await fs.mkdir(path.join(taskDir(id), "workspace"), { recursive: true });
    writeFileSync(path.join(taskDir(id), "workspace", "keep.txt"), "p");

    const job = beginResourceJob(id);
    registerJobAbort(id, job.jobId, () => {});
    setResourceJoinTimeoutMsForTest(50);

    setFailpoint("deletionJournal.prepared.beforeRename", async () => {
      throw new Error("R34-2 probe: prepared journal write fail");
    });

    const res = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(assertTaskReadable(id)).toBe(true);
    expect((await readDeletionJournal(id)).kind).toBe("absent");
    expect(
      await dirExists(path.join(taskDir(id), "workspace", "keep.txt")),
    ).toBe(true);
  });

  it("②b tombstone rename 失败 → 非 2xx + 任务完整可见", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await fs.mkdir(path.join(taskDir(id), "workspace"), { recursive: true });
    writeFileSync(path.join(taskDir(id), "workspace", "keep.txt"), "t");

    const job = beginResourceJob(id);
    registerJobAbort(id, job.jobId, () => {});
    setResourceJoinTimeoutMsForTest(50);

    setFailpoint("deleteTombstone.beforeRename", async () => {
      throw new Error("R34-2 probe: tombstone rename fail");
    });

    const res = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(assertTaskReadable(id)).toBe(true);
    expect((await readDeletionJournal(id)).kind).toBe("absent");
  });

  it("②c tombstone 成功后 committed journal 写失败 → accepted、重启完成、非 4xx", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await fs.mkdir(path.join(taskDir(id), "workspace"), { recursive: true });

    const job = beginResourceJob(id);
    registerJobAbort(id, job.jobId, () => {});
    setResourceJoinTimeoutMsForTest(50);

    setFailpoint("deletionJournal.commit.beforeRename", async () => {
      throw new Error("R34-2 probe: committed journal write fail");
    });

    const res = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });
    // R34-2：tombstone 已提交 → 对外成功/accepted，禁止 4xx 但任务已逻辑删除
    expect(res.status).toBeLessThan(400);
    expect(assertTaskReadable(id)).toBe(false);
    expect(
      await dirExists(path.join(taskDir(id), ".deleted-tombstone")),
    ).toBe(true);

    clearResourceJobs(id);
    clearChatGate(id);
    clearFailpoints();
    resetBootRecovery();
    await listTasks();
    skipBootRecovery();
    expect(await dirExists(taskDir(id))).toBe(false);
    expect(await getTask(id)).toBeNull();
  });

  it(
    "③ rewind 损坏 + 真实 ref：仓可扫 → 仍能清 ref（不泄漏）；仓也挂 → manifestPending",
    async () => {
      const id = alloc();
      const { repo, refA, refB } = await seedTwoCheckpointRefs(id);

      // 损坏 rewind：把文件换成目录 → readFile EISDIR
      const rewindPath = getRewindPointsPath(id);
      await fs.unlink(rewindPath);
      await fs.mkdir(rewindPath);

      // 路径 A：repo 可扫 → DELETE 应找到 refs 并清掉（不再当零 ref）
      const resOk = await DELETE(new Request("http://local/api/tasks/" + id), {
        params: Promise.resolve({ id }),
      });
      expect(resOk.status).toBeLessThan(400);
      expect(refExists(repo, refA)).toBe(false);
      expect(refExists(repo, refB)).toBe(false);
      expect((await readDeletionJournal(id)).kind).toBe("absent");

      // 路径 B：rewind 坏 + .git 藏起 → 无法确认 → manifestPending
      const id2 = alloc();
      const seeded = await seedTwoCheckpointRefs(id2);
      const rewind2 = getRewindPointsPath(id2);
      await fs.unlink(rewind2);
      await fs.mkdir(rewind2);
      await fs.rename(
        path.join(seeded.repo, ".git"),
        path.join(seeded.repo, ".git.hide"),
      );

      const resPending = await DELETE(
        new Request("http://local/api/tasks/" + id2),
        { params: Promise.resolve({ id: id2 }) },
      );
      expect(resPending.status).toBeLessThan(400);
      const j = await readDeletionJournal(id2);
      expect(j.kind).toBe("present");
      if (j.kind !== "present") throw new Error("expected present");
      expect(j.value.phase).toBe("committed");
      expect(j.value.manifestPending).toBe(true);
      // refs 仍在（.git 藏起时无法删）
      await fs.rename(
        path.join(seeded.repo, ".git.hide"),
        path.join(seeded.repo, ".git"),
      );
      expect(refExists(seeded.repo, seeded.refA)).toBe(true);

      // 恢复后 boot 重试应删 ref + journal
      clearFailpoints();
      // 修 rewind 以便 rebuild（或靠 repoPaths 扫）
      await fs.rm(rewind2, { recursive: true, force: true });
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();
      expect(refExists(seeded.repo, seeded.refA)).toBe(false);
      expect(refExists(seeded.repo, seeded.refB)).toBe(false);
      expect(await dirExists(getDeletionJournalPath(id2))).toBe(false);
    },
    60_000,
  );

  it("④ detail/list/events：helper 后 failpoint 窗口落 committed → 不返回删除项", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const ev = await appendEvent(id, { kind: "info", text: "anchor" });
    expect(ev).not.toBeNull();

    // detail ?tail=1
    {
      const hang = installHangingFailpoint("httpRead.afterHelper");
      const p = GET_DETAIL(
        new Request(`http://local/api/tasks/${id}?tail=1`),
        { params: Promise.resolve({ id }) },
      );
      await hang.waitHit();
      await writeDeletionJournal(id, {
        deletedAt: Date.now(),
        checkpointRefs: [],
        phase: "committed",
      });
      hang.release();
      const res = await p;
      // R36-7：committed → 410（非 404）
      expect(res.status).toBe(410);
      await fs.unlink(getDeletionJournalPath(id)).catch(() => {});
    }

    // 重建可读任务再测 list
    await writeMeta(makeMeta(id));
    {
      const hang = installHangingFailpoint("httpRead.afterHelper");
      const p = GET_LIST();
      await hang.waitHit();
      await writeDeletionJournal(id, {
        deletedAt: Date.now(),
        checkpointRefs: [],
        phase: "committed",
      });
      hang.release();
      const res = await p;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: { id: string }[] };
      expect(body.tasks.some((t) => t.id === id)).toBe(false);
      await fs.unlink(getDeletionJournalPath(id)).catch(() => {});
    }

    // events
    await writeMeta(makeMeta(id));
    const ev2 = await appendEvent(id, { kind: "info", text: "anchor2" });
    {
      const hang = installHangingFailpoint("httpRead.afterHelper");
      const p = GET_EVENTS(
        new Request(
          `http://local/api/tasks/${id}/events?before=${ev2!.id}&limit=10`,
        ),
        { params: Promise.resolve({ id }) },
      );
      await hang.waitHit();
      await writeDeletionJournal(id, {
        deletedAt: Date.now(),
        checkpointRefs: [],
        phase: "committed",
      });
      hang.release();
      const res = await p;
      // R36-7：committed → 410
      expect(res.status).toBe(410);
      await fs.unlink(getDeletionJournalPath(id)).catch(() => {});
    }
  });

  it("④b board：list 后 failpoint 窗口落 committed → 关联 task 为 null", async () => {
    const id = alloc();
    // board 只 join mode!==chat 且 feishuStoryUrl 匹配（extract 要数字 id）
    const meta = makeMeta(
      id,
      undefined,
      "https://project.feishu.cn/simple/story/detail/9876543210",
    );
    (meta as { mode: string }).mode = "task";
    await writeMeta(meta);

    const hang = installHangingFailpoint("httpRead.afterHelper");
    const p = GET_BOARD(
      new Request(
        `http://local/api/feishu/board?project=proj&from=${Date.now() - 86400000}&to=${Date.now() + 86400000}`,
      ),
    );
    await hang.waitHit();
    await writeDeletionJournal(id, {
      deletedAt: Date.now(),
      checkpointRefs: [],
      phase: "committed",
    });
    hang.release();
    const res = await p;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; task: { id: string } | null }[];
    };
    const item = body.items.find((i) => i.id === "9876543210");
    expect(item).toBeTruthy();
    expect(item!.task).toBeNull();
  });

  it("②d 直调 writeDeleteTombstone：prepared 失败不写 tombstone", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    setFailpoint("deletionJournal.prepared.beforeRename", async () => {
      throw new Error("prepared fail");
    });
    await expect(writeDeleteTombstone(id)).rejects.toThrow(/prepared fail/);
    expect(assertTaskReadable(id)).toBe(true);
    expect(
      await dirExists(path.join(taskDir(id), ".deleted-tombstone")),
    ).toBe(false);
  });
});
