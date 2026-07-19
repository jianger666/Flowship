/**
 * R34 / R33-4+5+6 退出矩阵：DeleteJournal 状态机 + 统一 read commit guard
 *
 * ① prepared journal + tombstone rename 失败 → DELETE 非 2xx、重启后任务仍在
 * ② fast journal + deleteTask 抛错 → 同上
 * ③ committed journal → boot 完成删除
 * ④ refs 首个/中间/全部失败 → journal 保留失败项、taskDir 已删、二次 boot 成功后才删 journal
 * ⑤ 双任务 list：A push 后挂 B → tombstone A → 放行 → 结果不含 A
 * ⑥ tail / events / watch bootstrap 挂起后删除 → 404 / 不发 stale
 * ⑦ DELETE 后既有 watcher 收到 task_deleted / 流关闭
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
  path.join(os.tmpdir(), "fe-ownership-r34-journal-"),
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
}));

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  assertTaskReadable,
  commitDeletionJournal,
  getDeletionJournalPath,
  getTask,
  getTaskEventsBefore,
  getTaskWithTailEvents,
  listTasks,
  readDeletionJournal,
  recoverDeletedTaskArtifacts,
  writeDeleteTombstone,
  writeDeletionJournal,
} = await import("@/lib/server/task-fs");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  checkpointRefName,
  writeRewindPoints,
} = await import("@/lib/server/chat-checkpoint");
const {
  beginResourceJob,
  clearResourceJobs,
  registerJobAbort,
  setResourceJoinTimeoutMsForTest,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { DELETE } = await import("@/app/api/tasks/[id]/route");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r34-journal-read DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "r34@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r34"]);
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

const makeMeta = (id: string, repo?: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r34 ${id}`,
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

const ids: string[] = [];
const alloc = (): string => {
  const id = `t_r34_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

describe("R34 DeleteJournal + read commit guard", () => {
  it("① prepared + tombstone rename 失败 → 非 2xx、重启任务仍在", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await fs.mkdir(path.join(taskDir(id), "workspace"), { recursive: true });
    writeFileSync(path.join(taskDir(id), "workspace", "keep.txt"), "x");

    // quarantine 路径走 writeDeleteTombstone
    const job = beginResourceJob(id);
    registerJobAbort(id, job.jobId, () => {});
    setResourceJoinTimeoutMsForTest(50);

    setFailpoint("deleteTombstone.beforeRename", async () => {
      throw new Error("R33-5 probe: tombstone rename fail");
    });

    const res = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await readDeletionJournal(id)).kind).toBe("absent");
    expect(assertTaskReadable(id)).toBe(true);

    clearResourceJobs(id);
    clearChatGate(id);

    resetBootRecovery();
    const list = await listTasks();
    skipBootRecovery();
    expect(list.some((t) => t.id === id)).toBe(true);
    expect(await dirExists(taskDir(id))).toBe(true);
    expect(
      await dirExists(path.join(taskDir(id), "workspace", "keep.txt")),
    ).toBe(true);
  });

  it("② fast journal committed 后 deleteTask 抛错 → recoveryPending、任务不可读、boot 前滚完成", async () => {
    // R34-1：commit 后只前滚——不再期望 4xx + 任务复活（旧语义已废）
    const id = alloc();
    await writeMeta(makeMeta(id));
    await fs.mkdir(path.join(taskDir(id), "workspace"), { recursive: true });
    writeFileSync(path.join(taskDir(id), "workspace", "keep.txt"), "y");

    setFailpoint("deleteTask.beforeRm", async () => {
      throw new Error("R34-1 probe: deleteTask beforeRm after commit");
    });

    const res = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });
    expect([200, 202]).toContain(res.status);
    const body = (await res.json()) as { recoveryPending?: boolean };
    expect(body.recoveryPending).toBe(true);
    expect(assertTaskReadable(id)).toBe(false);
    const journal = await readDeletionJournal(id);
    expect(journal.kind).toBe("present");
    if (journal.kind !== "present") throw new Error("expected present");
    expect(journal.value.phase).toBe("committed");

    resetBootRecovery();
    const list = await listTasks();
    skipBootRecovery();
    expect(list.some((t) => t.id === id)).toBe(false);
    expect(await dirExists(taskDir(id))).toBe(false);
    expect((await readDeletionJournal(id)).kind).toBe("absent");
  });

  it("③ committed journal → boot 完成删除", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await writeDeletionJournal(id, {
      deletedAt: Date.now(),
      checkpointRefs: [],
      phase: "committed",
    });

    resetBootRecovery();
    await listTasks();
    skipBootRecovery();

    expect(await dirExists(taskDir(id))).toBe(false);
    expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
  });

  it(
    "④ refs 全部失败 → journal 保留、taskDir 已删；二次 boot 成功后删 journal；共享 ref 保留",
    async () => {
      const id = alloc();
      const idOther = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r34-refs-"));
      initGitRepo(repo);
      const treeOid = treeOidOfHead(repo);
      const refA = checkpointRefName(id, treeOid);
      const refOther = checkpointRefName(idOther, treeOid);
      git(repo, "update-ref", refA, treeOid);
      git(repo, "update-ref", refOther, treeOid);

      await writeMeta(makeMeta(id, repo));
      await fs.mkdir(path.join(taskDir(id), "checkpoints"), {
        recursive: true,
      });
      await writeRewindPoints(id, [
        {
          eventId: "e1",
          createdAt: Date.now(),
          repoSnapshots: [{ repoPath: repo, treeOid }],
          kind: "checkpoint",
        },
      ]);

      await writeDeleteTombstone(id);
      // 藏起 .git → for-each-ref / update-ref 全失败
      const gitDir = path.join(repo, ".git");
      const gitHide = path.join(repo, ".git.hide");
      await fs.rename(gitDir, gitHide);

      await recoverDeletedTaskArtifacts(id);
      expect(await dirExists(taskDir(id))).toBe(false);
      const journalAfter = await readDeletionJournal(id);
      expect(journalAfter.kind).toBe("present");
      if (journalAfter.kind !== "present") throw new Error("expected present");
      expect(journalAfter.value.phase).toBe("committed");
      expect(journalAfter.value.refsPending?.length).toBeGreaterThan(0);

      // 恢复 git，二次 boot 重试
      await fs.rename(gitHide, gitDir);
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();

      expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
      expect(refExists(repo, refA)).toBe(false);
      expect(refExists(repo, refOther)).toBe(true);

      try {
        git(repo, "update-ref", "-d", refOther);
      } catch {
        /* noop */
      }
    },
    40_000,
  );

  it(
    "④b refs 部分仓失败（首个/中间）→ 只保留失败仓 pending",
    async () => {
      const id = alloc();
      const repoOk = mkdtempSync(path.join(TMP_ROOT, "r34-ok-"));
      const repoBad = mkdtempSync(path.join(TMP_ROOT, "r34-bad-"));
      initGitRepo(repoOk);
      initGitRepo(repoBad);
      const treeOk = treeOidOfHead(repoOk);
      const treeBad = treeOidOfHead(repoBad);
      const refOk = checkpointRefName(id, treeOk);
      const refBad = checkpointRefName(id, treeBad);
      git(repoOk, "update-ref", refOk, treeOk);
      git(repoBad, "update-ref", refBad, treeBad);

      await writeMeta(makeMeta(id, repoOk));
      await writeDeletionJournal(id, {
        deletedAt: Date.now(),
        phase: "committed",
        checkpointRefs: [
          { repoPath: repoBad, refs: [refBad] },
          { repoPath: repoOk, refs: [refOk] },
        ],
      });

      await fs.rename(
        path.join(repoBad, ".git"),
        path.join(repoBad, ".git.hide"),
      );

      await recoverDeletedTaskArtifacts(id);
      expect(await dirExists(taskDir(id))).toBe(false);
      const j = await readDeletionJournal(id);
      expect(j.kind).toBe("present");
      if (j.kind !== "present") throw new Error("expected present");
      expect(j.value.refsPending?.length).toBe(1);
      expect(j.value.refsPending?.[0]?.repoPath).toBe(repoBad);
      expect(refExists(repoOk, refOk)).toBe(false);

      await fs.rename(
        path.join(repoBad, ".git.hide"),
        path.join(repoBad, ".git"),
      );
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();
      expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
      expect(refExists(repoBad, refBad)).toBe(false);
    },
    40_000,
  );

  it("⑤ 双任务 list：A push 后挂 B → tombstone A → 结果不含 A", async () => {
    // 固定字典序：A 先于 B，保证「A 已 push → 挂在 B 的 afterReadMeta」
    const idA = `t_r34_a_${Date.now()}`;
    const idB = `t_r34_b_${Date.now()}`;
    ids.push(idA, idB);
    await writeMeta(makeMeta(idA));
    await writeMeta(makeMeta(idB));

    let passCount = 0;
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => {
      releaseB = r;
    });
    let hitResolve!: () => void;
    const hit = new Promise<void>((r) => {
      hitResolve = r;
    });
    setFailpoint("listTasks.afterReadMeta", async () => {
      passCount += 1;
      // 第 1 次（A）放行并 push；第 2 次（B）挂起
      if (passCount < 2) return;
      hitResolve();
      await gateB;
    });

    const listP = listTasks();
    await hit;
    await writeDeleteTombstone(idA);
    releaseB();
    const list = await listP;
    expect(list.some((t) => t.id === idA)).toBe(false);
    expect(list.some((t) => t.id === idB)).toBe(true);
  });

  it("⑥ tail hydrate 挂起后删除 → 返 null", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const hang = installHangingFailpoint("getTaskWithTailEvents.afterHydrate");
    const p = getTaskWithTailEvents(id, 10);
    await hang.waitHit();
    await writeDeleteTombstone(id);
    hang.release();
    expect(await p).toBeNull();
  });

  it("⑥b events 分页挂起后删除 → 返 null", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    // 需要一条锚点事件
    const { appendEvent } = await import("@/lib/server/task-fs");
    const ev = await appendEvent(id, { kind: "info", text: "anchor" });
    expect(ev).not.toBeNull();

    const hang = installHangingFailpoint("getTaskEventsBefore.afterRead");
    const p = getTaskEventsBefore(id, ev!.id, 10);
    await hang.waitHit();
    await writeDeleteTombstone(id);
    hang.release();
    expect(await p).toBeNull();
  });

  it("⑥c watch bootstrap 挂起后删除 → 404", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const hang = installHangingFailpoint("getTaskWithTailEvents.afterHydrate");

    const { GET } = await import("@/app/api/tasks/[id]/watch-task/route");
    const req = new Request(
      `http://local/api/tasks/${id}/watch-task?tail=10`,
    );
    const p = GET(req, { params: Promise.resolve({ id }) });
    await hang.waitHit();
    await writeDeleteTombstone(id);
    hang.release();
    const res = await p;
    expect(res.status).toBe(404);
  });

  it("⑦ DELETE 后既有 watcher 收到 task_deleted 并关流", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));

    const frames: unknown[] = [];
    let closed = false;
    const unsub = subscribeTaskStream(id, (ev) => {
      frames.push(ev);
      if (ev.kind === "task_deleted") closed = true;
    });

    const res = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    // 等 publish 落到 listener
    await sleep(50);
    unsub();

    expect(
      frames.some(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as { kind?: string }).kind === "task_deleted",
      ),
    ).toBe(true);
    expect(closed).toBe(true);
    expect(await getTask(id)).toBeNull();
  });

  it("R33-5：prepared journal 单独存在时 boot 丢弃、任务保留", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await writeDeletionJournal(id, {
      deletedAt: Date.now(),
      checkpointRefs: [],
      phase: "prepared",
    });
    // 未 commit
    expect(assertTaskReadable(id)).toBe(true);

    resetBootRecovery();
    const list = await listTasks();
    skipBootRecovery();
    expect(list.some((t) => t.id === id)).toBe(true);
    expect((await readDeletionJournal(id)).kind).toBe("absent");
  });

  it("R33-5：commitDeletionJournal 后 assertTaskReadable=false", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    await writeDeletionJournal(id, {
      deletedAt: Date.now(),
      checkpointRefs: [],
      phase: "prepared",
    });
    expect(assertTaskReadable(id)).toBe(true);
    await commitDeletionJournal(id);
    expect(assertTaskReadable(id)).toBe(false);
  });
});
