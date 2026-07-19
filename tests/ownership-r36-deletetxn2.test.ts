/**
 * R36 / R35-3+4 退出矩阵：DeleteTxn durable descriptor + journal/tombstone 三态读
 *
 * ① 真实 ref + rewind/meta 均不可读 → DELETE 后多次重启保留恢复源/journal；
 *    补全 repoPaths 后才删 ref/taskDir/journal
 * ② manifestPending + 空 repoPaths + taskDir missing → 永不 ok-empty（Codex 反例 2）
 * ③ committed 后对 sync/async journal 与 tombstone 注入 EACCES/EIO →
 *    detail/list 隐藏、DELETE 只 recoveryPending、phase 不倒退
 * ④ 仅明确 ENOENT → absent
 * ⑤ 正常路径回归（happy path 不受三态化影响）
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
  path.join(os.tmpdir(), "fe-ownership-r36-deletetxn2-"),
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
      name: "r36",
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
  recoverDeletedTaskArtifacts,
  setDeletionEvidenceReadInjectorForTest,
  writeDeletionJournal,
} = await import("@/lib/server/task-fs");
const { clearFailpoints } = await import("@/lib/server/failpoints");
const {
  checkpointRefName,
  getRewindPointsPath,
  resolveCheckpointRefManifestForDelete,
  writeRewindPoints,
} = await import("@/lib/server/chat-checkpoint");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { DELETE, GET: GET_DETAIL } = await import(
  "@/app/api/tasks/[id]/route"
);
const { GET: GET_LIST } = await import("@/app/api/tasks/route");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r36-deletetxn2 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "r36@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r36"]);
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
    title: `ownership-r36 ${id}`,
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

const seedTwoCheckpointRefs = async (
  id: string,
): Promise<{ repo: string; refA: string; refB: string }> => {
  const repo = mkdtempSync(path.join(TMP_ROOT, "r36-repo-"));
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
  const id = `t_r36_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
};

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

beforeEach(() => {
  clearFailpoints();
  setDeletionEvidenceReadInjectorForTest(null);
  skipBootRecovery();
});

afterEach(async () => {
  clearFailpoints();
  setDeletionEvidenceReadInjectorForTest(null);
  for (const id of ids.splice(0)) {
    clearChatGate(id);
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

describe("R36 DeleteTxn durable descriptor + 三态读", () => {
  it(
    "① 真实 ref + rewind/meta 读失败 → DELETE 后多次重启保留恢复源；补全 repoPaths 后才清",
    async () => {
      const id = alloc();
      const { repo, refA, refB } = await seedTwoCheckpointRefs(id);

      // rewind 不可读（EISDIR）+ meta 损坏 → prepare 拿不到 repoPaths
      const rewindPath = getRewindPointsPath(id);
      await fs.unlink(rewindPath);
      await fs.mkdir(rewindPath);
      await fs.writeFile(
        path.join(taskDir(id), "meta.json"),
        "{not-json",
        "utf-8",
      );

      const res = await DELETE(new Request("http://local/api/tasks/" + id), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { recoveryPending?: boolean };
      expect(body.recoveryPending).toBe(true);
      expect(assertTaskReadable(id)).toBe(false);

      // R35-3：不得 rm 最后恢复源
      expect(await dirExists(taskDir(id))).toBe(true);
      expect(await dirExists(rewindPath)).toBe(true);
      const j1 = await readDeletionJournal(id);
      expect(j1.kind).toBe("present");
      if (j1.kind !== "present") throw new Error("expected present");
      expect(j1.value.phase).toBe("committed");
      expect(j1.value.manifestPending).toBe(true);
      expect(j1.value.repoPaths?.length ?? 0).toBe(0);
      expect(refExists(repo, refA)).toBe(true);
      expect(refExists(repo, refB)).toBe(true);

      // 多次重启仍 pending、不误清
      for (let i = 0; i < 2; i++) {
        resetBootRecovery();
        await listTasks();
        skipBootRecovery();
        expect(await dirExists(taskDir(id))).toBe(true);
        expect(await dirExists(getDeletionJournalPath(id))).toBe(true);
        expect(refExists(repo, refA)).toBe(true);
        const still = await readDeletionJournal(id);
        expect(still.kind).toBe("present");
        if (still.kind !== "present") throw new Error("expected present");
        expect(still.value.manifestPending).toBe(true);
        expect(still.value.phase).toBe("committed");
      }

      // 补全 durable descriptor 后再恢复
      await writeDeletionJournal(id, {
        ...j1.value,
        phase: "committed",
        manifestPending: true,
        repoPaths: [repo],
      });
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();

      expect(refExists(repo, refA)).toBe(false);
      expect(refExists(repo, refB)).toBe(false);
      expect(await dirExists(taskDir(id))).toBe(false);
      expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
      expect(await getTask(id)).toBeNull();
    },
    60_000,
  );

  it("② manifestPending + 空 repoPaths + taskDir missing → 永不 ok-empty", async () => {
    const id = alloc();
    // 无 taskDir：直接调 resolver，复刻 Codex 反例 2（期望反转）
    expect(await dirExists(taskDir(id))).toBe(false);
    const rebuilt = await resolveCheckpointRefManifestForDelete(id, []);
    expect(rebuilt.ok).toBe(false);
    if (rebuilt.ok) throw new Error("must not return ok-empty");
    // R36-6：meta absent + 空 rewind → 不得 confirmedEmpty（文案含 R36-6 / empty rewind）
    expect(rebuilt.error).toMatch(
      /R35-3|R36-6|empty repoPaths|taskDir missing|empty rewind/i,
    );

    // recover 路径：journal committed+manifestPending+空 repoPaths、无 taskDir
    await writeDeletionJournal(id, {
      deletedAt: Date.now(),
      checkpointRefs: [],
      phase: "committed",
      manifestPending: true,
      repoPaths: [],
    });
    await recoverDeletedTaskArtifacts(id);
    const still = await readDeletionJournal(id);
    expect(still.kind).toBe("present");
    if (still.kind !== "present") throw new Error("expected present");
    expect(still.value.manifestPending).toBe(true);
    expect(still.value.phase).toBe("committed");
  });

  it(
    "③ committed 后 journal/tombstone 注入 EACCES/EIO → 隐藏 + recoveryPending + phase 不倒退",
    async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      await writeDeletionJournal(id, {
        deletedAt: Date.now(),
        checkpointRefs: [],
        phase: "committed",
        confirmedEmpty: true,
        repoPaths: [],
      });
      // 保留 taskDir（不写 tombstone），模拟 fast path committed 后证据读失败
      expect(assertTaskReadable(id)).toBe(false);

      // R36-7：同步 journal EACCES → unavailable → detail 503（非 410 sticky deleted）
      setDeletionEvidenceReadInjectorForTest((op) => {
        if (op === "journalSync") throw errno("EACCES");
      });
      expect(assertTaskReadable(id)).toBe(false);
      const detail = await GET_DETAIL(
        new Request(`http://local/api/tasks/${id}`),
        { params: Promise.resolve({ id }) },
      );
      expect(detail.status).toBe(503);
      const listRes = await GET_LIST();
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { tasks: { id: string }[] };
      expect(listBody.tasks.some((t) => t.id === id)).toBe(false);

      // R36-7：入场 journal EIO → 503、不进删除、phase 不倒退
      setDeletionEvidenceReadInjectorForTest((op) => {
        if (op === "journalAsync") throw errno("EIO");
      });
      const del1 = await DELETE(new Request("http://local/api/tasks/" + id), {
        params: Promise.resolve({ id }),
      });
      expect(del1.status).toBe(503);

      // 关闭注入后 phase 仍为 committed（未倒退到 prepared / 未删 journal）
      setDeletionEvidenceReadInjectorForTest(null);
      const jAfter = await readDeletionJournal(id);
      expect(jAfter.kind).toBe("present");
      if (jAfter.kind !== "present") throw new Error("expected present");
      expect(jAfter.value.phase).toBe("committed");

      // tombstone access → EACCES：同步闸隐藏；DELETE 入场 503
      await fs.writeFile(
        path.join(taskDir(id), ".deleted-tombstone"),
        JSON.stringify({ deletedAt: Date.now() }),
        "utf-8",
      );
      setDeletionEvidenceReadInjectorForTest((op) => {
        if (op === "tombstoneSync" || op === "tombstoneAsync") {
          throw errno("EACCES");
        }
      });
      expect(assertTaskReadable(id)).toBe(false);
      const del2 = await DELETE(new Request("http://local/api/tasks/" + id), {
        params: Promise.resolve({ id }),
      });
      expect(del2.status).toBe(503);
      setDeletionEvidenceReadInjectorForTest(null);
      const jFinal = await readDeletionJournal(id);
      expect(jFinal.kind).toBe("present");
      if (jFinal.kind !== "present") throw new Error("expected present");
      expect(jFinal.value.phase).toBe("committed");
    },
    40_000,
  );

  it("④ 只有明确 ENOENT 才是 absent；损坏/注入非 ENOENT → unknown", async () => {
    const missing = await readDeletionJournal("never_existed_r36");
    expect(missing.kind).toBe("absent");

    const id = alloc();
    await writeMeta(makeMeta(id));
    await fs.mkdir(path.dirname(getDeletionJournalPath(id)), {
      recursive: true,
    });
    await fs.writeFile(getDeletionJournalPath(id), "{bad", "utf-8");
    const corrupt = await readDeletionJournal(id);
    expect(corrupt.kind).toBe("unknown");
    expect(assertTaskReadable(id)).toBe(false);

    await writeDeletionJournal(id, {
      deletedAt: Date.now(),
      checkpointRefs: [],
      phase: "committed",
      confirmedEmpty: true,
    });
    setDeletionEvidenceReadInjectorForTest((op) => {
      if (op === "journalAsync") throw errno("EBUSY");
    });
    const busy = await readDeletionJournal(id);
    expect(busy.kind).toBe("unknown");
  });

  it(
    "⑤ happy path：有完整描述的正常删除不受三态化影响",
    async () => {
      const id = alloc();
      const { repo, refA, refB } = await seedTwoCheckpointRefs(id);
      expect(refExists(repo, refA)).toBe(true);

      const res = await DELETE(new Request("http://local/api/tasks/" + id), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok?: boolean;
        recoveryPending?: boolean;
      };
      expect(body.ok).toBe(true);
      expect(body.recoveryPending).toBeUndefined();
      // 完整删除后 journal/tombstone 皆 absent——读闸无证据；靠 taskDir/meta 消失隐藏
      expect(await getTask(id)).toBeNull();
      expect(refExists(repo, refA)).toBe(false);
      expect(refExists(repo, refB)).toBe(false);
      expect(await dirExists(taskDir(id))).toBe(false);
      expect((await readDeletionJournal(id)).kind).toBe("absent");

      const listRes = await GET_LIST();
      const listBody = (await listRes.json()) as { tasks: { id: string }[] };
      expect(listBody.tasks.some((t) => t.id === id)).toBe(false);
    },
    40_000,
  );
});
