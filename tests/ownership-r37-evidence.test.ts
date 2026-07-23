/**
 * R37 / R36-6~9 退出矩阵：DeleteEvidence 三态完备 + TaskVisibility 分离
 *
 * ① 真实 ref + 合法空 rewind × meta 损坏/EACCES/EIO → DELETE 只 recoveryPending、
 *    taskDir/journal/ref 全保留；恢复 meta 后 boot 才清 ref
 * ② 删除不存在 id → 幂等、无 journal；多次重启不新增
 * ③ 可解析但语义非法 journal → detail/list 不可读、boot 不删不回滚
 * ④ live task 注入 journal EIO → detail/events 503 非 410；恢复后正常
 * ⑤ DELETE 入场 unknown → 503、不发 task_deleted、无不可逆动作
 * ⑥ committed happy path → detail 410
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
  path.join(os.tmpdir(), "fe-ownership-r37-evidence-"),
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
  loadSkillsForTask: async () => [],
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
      name: "r37",
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

const { taskDir, writeMeta, setMetaEvidenceReadInjectorForTest } = await import(
  "@/lib/server/task-fs-core"
);
const {
  assertTaskReadable,
  getDeletionJournalPath,
  getTask,
  getTaskVisibility,
  listTasks,
  readDeletionJournal,
  setDeletionEvidenceReadInjectorForTest,
  writeDeletionJournal,
} = await import("@/lib/server/task-fs");
const { clearFailpoints } = await import("@/lib/server/failpoints");
const {
  checkpointRefName,
  getRewindPointsPath,
  writeRewindPoints,
} = await import("@/lib/server/chat-checkpoint");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const taskStream = await import("@/lib/server/task-stream");
const { DELETE, GET: GET_DETAIL } = await import(
  "@/app/api/tasks/[id]/route"
);
const { GET: GET_EVENTS } = await import(
  "@/app/api/tasks/[id]/events/route"
);
const { GET: GET_LIST } = await import("@/app/api/tasks/route");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r37-evidence DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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
  execFileSync("git", ["-C", dir, "config", "user.email", "r37@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r37"]);
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
    title: `ownership-r37 ${id}`,
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

/** 真实 ref + 合法空 rewind（Codex 反例底座）；meta 由调用方破坏/注入 */
const seedRefsWithEmptyRewind = async (
  id: string,
): Promise<{ repo: string; refA: string; refB: string }> => {
  const repo = mkdtempSync(path.join(TMP_ROOT, "r37-repo-"));
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
  // R36-6：合法空 rewind——构建成功为空，不能当「零仓」除非 meta 也 valid 空
  await writeRewindPoints(id, []);
  // 真实 ref 仍在仓里（rewind 未记录）
  return { repo, refA, refB };
};

const ids: string[] = [];
const alloc = (): string => {
  const id = `t_r37_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
};

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

beforeEach(() => {
  clearFailpoints();
  setDeletionEvidenceReadInjectorForTest(null);
  setMetaEvidenceReadInjectorForTest(null);
  skipBootRecovery();
});

afterEach(async () => {
  clearFailpoints();
  setDeletionEvidenceReadInjectorForTest(null);
  setMetaEvidenceReadInjectorForTest(null);
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

describe("R37 DeleteEvidence 三态 + TaskVisibility", () => {
  it.each([
    {
      name: "meta JSON 损坏",
      setup: async (id: string) => {
        await fs.writeFile(
          path.join(taskDir(id), "meta.json"),
          "{not-json",
          "utf-8",
        );
      },
    },
    {
      name: "meta EACCES",
      setup: async () => {
        setMetaEvidenceReadInjectorForTest((op) => {
          if (op === "metaAsync") throw errno("EACCES");
        });
      },
    },
    {
      name: "meta EIO",
      setup: async () => {
        setMetaEvidenceReadInjectorForTest((op) => {
          if (op === "metaAsync") throw errno("EIO");
        });
      },
    },
  ])(
    "① 空 rewind + $name → recoveryPending、全保留；恢复 meta 后 boot 清 ref",
    async ({ setup }) => {
      const id = alloc();
      const { repo, refA, refB } = await seedRefsWithEmptyRewind(id);
      expect(refExists(repo, refA)).toBe(true);
      expect(refExists(repo, refB)).toBe(true);
      await setup(id);

      const res = await DELETE(new Request("http://local/api/tasks/" + id), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { recoveryPending?: boolean };
      expect(body.recoveryPending).toBe(true);

      // Codex 反例反转：不得 200 + 删 taskDir/journal 留 ref
      expect(await dirExists(taskDir(id))).toBe(true);
      expect(await dirExists(getDeletionJournalPath(id))).toBe(true);
      expect(await dirExists(getRewindPointsPath(id))).toBe(true);
      expect(refExists(repo, refA)).toBe(true);
      expect(refExists(repo, refB)).toBe(true);
      const j1 = await readDeletionJournal(id);
      expect(j1.kind).toBe("present");
      if (j1.kind !== "present") throw new Error("expected present");
      expect(j1.value.phase).toBe("committed");
      expect(j1.value.manifestPending).toBe(true);
      expect(getTaskVisibility(id)).toBe("deleted");

      setMetaEvidenceReadInjectorForTest(null);
      // 恢复 valid meta（含 repoPaths）后再 boot
      await writeMeta(makeMeta(id, repo));
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
    },
    60_000,
  );

  it("② 删除不存在 id → 幂等 200、无 journal；跨 tab / 重启不新增", async () => {
    const id = `t_r37_never_${Date.now()}`;
    ids.push(id);

    const res1 = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });
    expect(res1.status).toBe(200);
    expect((await res1.json()) as { ok?: boolean }).toEqual({ ok: true });
    expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
    expect(await dirExists(taskDir(id))).toBe(false);

    const res2 = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });
    expect(res2.status).toBe(200);
    expect(await dirExists(getDeletionJournalPath(id))).toBe(false);

    for (let i = 0; i < 2; i++) {
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();
      expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
    }
  });

  it("③ 可解析但语义非法 journal → 不可读、boot 不删不回滚", async () => {
    const cases: { label: string; body: unknown }[] = [
      {
        label: "phase typo commited",
        body: {
          deletedAt: Date.now(),
          checkpointRefs: [],
          phase: "commited",
        },
      },
      {
        label: "缺 phase",
        body: { deletedAt: Date.now(), checkpointRefs: [] },
      },
      {
        label: "checkpointRefs 元素缺 refs",
        body: {
          deletedAt: Date.now(),
          phase: "committed",
          checkpointRefs: [{ repoPath: "/tmp/x" }],
        },
      },
      {
        label: "repoPaths 非数组",
        body: {
          deletedAt: Date.now(),
          phase: "committed",
          checkpointRefs: [],
          repoPaths: "not-array",
        },
      },
      {
        label: "manifestPending 类型错",
        body: {
          deletedAt: Date.now(),
          phase: "prepared",
          checkpointRefs: [],
          manifestPending: "yes",
        },
      },
    ];

    for (const c of cases) {
      const id = alloc();
      await writeMeta(makeMeta(id));
      await fs.mkdir(path.dirname(getDeletionJournalPath(id)), {
        recursive: true,
      });
      await fs.writeFile(
        getDeletionJournalPath(id),
        JSON.stringify(c.body),
        "utf-8",
      );

      const read = await readDeletionJournal(id);
      expect(read.kind, c.label).toBe("unknown");
      expect(assertTaskReadable(id), c.label).toBe(false);
      expect(getTaskVisibility(id), c.label).toBe("unavailable");

      const detail = await GET_DETAIL(
        new Request(`http://local/api/tasks/${id}`),
        { params: Promise.resolve({ id }) },
      );
      expect(detail.status, c.label).toBe(503);

      const listRes = await GET_LIST();
      const listBody = (await listRes.json()) as { tasks: { id: string }[] };
      expect(
        listBody.tasks.some((t) => t.id === id),
        c.label,
      ).toBe(false);

      // boot 不删 journal、不回滚
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();
      expect(await dirExists(getDeletionJournalPath(id)), c.label).toBe(true);
      expect((await readDeletionJournal(id)).kind, c.label).toBe("unknown");
      expect(await dirExists(taskDir(id)), c.label).toBe(true);
    }
  });

  it("④ live task journal EIO → detail/events 503 非 410；恢复后正常", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    expect(getTaskVisibility(id)).toBe("readable");

    setDeletionEvidenceReadInjectorForTest((op) => {
      if (op === "journalSync" || op === "journalAsync") throw errno("EIO");
    });
    expect(getTaskVisibility(id)).toBe("unavailable");
    const detail = await GET_DETAIL(
      new Request(`http://local/api/tasks/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(detail.status).toBe(503);
    expect(((await detail.json()) as { error?: string }).error).toBe(
      "temporarily_unavailable",
    );

    const events = await GET_EVENTS(
      new Request(`http://local/api/tasks/${id}/events?before=ev_x&limit=10`),
      { params: Promise.resolve({ id }) },
    );
    expect(events.status).toBe(503);

    setDeletionEvidenceReadInjectorForTest(null);
    expect(getTaskVisibility(id)).toBe("readable");
    const detailOk = await GET_DETAIL(
      new Request(`http://local/api/tasks/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(detailOk.status).toBe(200);
    expect(await getTask(id)).not.toBeNull();
  });

  it("⑤ DELETE 入场 journal unknown → 503、不发 task_deleted、无不可逆动作", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const published: unknown[] = [];
    const spy = vi
      .spyOn(taskStream, "publishTaskStreamEvent")
      .mockImplementation((taskId, ev) => {
        published.push({ taskId, ev });
      });

    setDeletionEvidenceReadInjectorForTest((op) => {
      if (op === "journalAsync") throw errno("EIO");
    });
    const res = await DELETE(new Request("http://local/api/tasks/" + id), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toContain(
      "删除证据暂不可读",
    );
    expect(
      published.some(
        (p) =>
          (p as { ev?: { kind?: string } }).ev?.kind === "task_deleted",
      ),
    ).toBe(false);
    expect(await dirExists(taskDir(id))).toBe(true);
    expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
    expect(getTaskVisibility(id)).toBe("readable");

    spy.mockRestore();
    setDeletionEvidenceReadInjectorForTest(null);
  });

  it(
    "⑥ committed happy path → detail 410；完整删除收尾",
    async () => {
      const id = alloc();
      const { repo, refA, refB } = await seedRefsWithEmptyRewind(id);
      // 有仓 + valid meta：rewind 空但 meta.repoPaths 非空 → 扫到真实 ref 并清掉
      const res = await DELETE(new Request("http://local/api/tasks/" + id), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBe(200);
      expect(refExists(repo, refA)).toBe(false);
      expect(refExists(repo, refB)).toBe(false);
      expect(await getTask(id)).toBeNull();
      expect((await readDeletionJournal(id)).kind).toBe("absent");

      // 显式 committed journal → 410（非 404/503）
      const id2 = alloc();
      await writeMeta(makeMeta(id2));
      await writeDeletionJournal(id2, {
        deletedAt: Date.now(),
        checkpointRefs: [],
        phase: "committed",
        confirmedEmpty: true,
      });
      expect(getTaskVisibility(id2)).toBe("deleted");
      const detail = await GET_DETAIL(
        new Request(`http://local/api/tasks/${id2}`),
        { params: Promise.resolve({ id: id2 }) },
      );
      expect(detail.status).toBe(410);
      expect(((await detail.json()) as { error?: string }).error).toBe(
        "task_deleted",
      );
    },
    40_000,
  );
});
