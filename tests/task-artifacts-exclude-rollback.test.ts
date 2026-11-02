/**
 * 划除 / 恢复 artifact 与 revision 快照：「先动文件、后写 meta」中间失败必须能回到一致状态。
 *
 * 旧行为：
 * - setActionArtifactExcluded：先 `rename` 把 artifact 挪进 `.excluded/`、再 `writeMeta`；writeMeta 失败（磁盘满 / 被占用）
 *   没有回滚——meta 仍指向老路径、文件却在 `.excluded/` 里，UI 显示「产出不存在」；另外存在性预探用 `exists()`（吞所有错误），
 *   EACCES / EIO 时当成「文件不在」→ 只翻 meta、文件留在原处，同样错位。
 * - snapshotActionArtifact：超过上限时先 unlink 最老的 revision 文件、最后才 writeMeta；writeMeta 失败后 meta 仍记着已删的文件
 *   （修订列表里点开 404），最老的历史版本也永久丢了。
 * 现在：writeMeta 失败 → rename 回滚（回滚也失败则抛带位置的明确错误）；revision 先写新的、meta 成功后才删旧的。
 *
 * DATA_DIR 在 task-fs-core 模块加载时冻结：先钉 FLOWSHIP_DATA_DIR 再动态 import。只写临时目录。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRecord, ArtifactRevision } from "@/lib/types";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-artifact-exclude-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const { MAX_REVISIONS_PER_ACTION, readMetaRaw, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { ArtifactMoveRollbackError, setActionArtifactExcluded, snapshotActionArtifact } = await import(
  "@/lib/server/task-artifacts"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`artifact-exclude DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const TASK_ID = "t_excl_rb_1";
const ACTION_ID = "act_1";
const NORMAL_REL = "actions/1-plan.md";
const EXCLUDED_REL = "actions/.excluded/1-plan.md";
const BODY = "# 方案正文\n";

const action = (patch: Partial<ActionRecord> = {}): ActionRecord => ({
  id: ACTION_ID,
  n: 1,
  type: "plan",
  status: "awaiting_ack",
  userInstruction: "写方案",
  artifactPath: NORMAL_REL,
  startedAt: 1_000,
  endedAt: null,
  ...patch,
});

const meta = (a: ActionRecord): TaskMetaV06 => ({
  id: TASK_ID,
  title: "划除回滚单测",
  repoStatus: "developing",
  runStatus: "idle",
  currentActionId: null,
  actions: [a],
  mrs: [],
  repoPaths: ["/tmp/fake-repo"],
  createdAt: 1_000,
  updatedAt: 1_000,
});

const abs = (rel: string): string => path.join(taskDir(TASK_ID), rel);
const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

/** 落盘：artifact 放在 artifactRel；meta 的 artifactPath 与之一致 */
const seed = async (artifactRel: string, patch: Partial<ActionRecord> = {}): Promise<void> => {
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true });
  await fs.mkdir(path.dirname(abs(artifactRel)), { recursive: true });
  await fs.writeFile(abs(artifactRel), BODY, "utf-8");
  await writeMeta(meta(action({ artifactPath: artifactRel, ...patch })));
};

const metaAction = async (): Promise<ActionRecord> => {
  const raw = (await readMetaRaw(TASK_ID)) as TaskMetaV06;
  return raw.actions[0]!;
};

/** 让「写 meta.json」的最终 rename 失败（tmp → meta.json）；其它 rename（挪 artifact / 回滚）放行，可选地让回滚也失败 */
const failMetaRename = (opts: { failRollback?: boolean } = {}) => {
  const real = fs.rename.bind(fs) as (...a: unknown[]) => Promise<void>;
  const ctl = { metaHits: 0, rollbackHits: 0 };
  vi.spyOn(fs, "rename").mockImplementation(((from: unknown, to: unknown, ...rest: unknown[]) => {
    if (String(to).endsWith(`${path.sep}meta.json`)) {
      ctl.metaHits += 1;
      return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
    }
    // 回滚 = 把文件从「新位置」挪回「老位置」：此时 from 是 .excluded 或正常目录里的 artifact
    if (opts.failRollback && ctl.metaHits > 0 && String(from).endsWith("1-plan.md")) {
      ctl.rollbackHits += 1;
      return Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    }
    return real(from, to, ...rest);
  }) as unknown as typeof fs.rename);
  return ctl;
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("setActionArtifactExcluded：writeMeta 失败要回滚 rename", () => {
  it("对照：正常划除 → 文件进 .excluded/、meta 指向新位置；再恢复 → 回到原处", async () => {
    await seed(NORMAL_REL);
    const t1 = await setActionArtifactExcluded(TASK_ID, ACTION_ID, true);
    expect(t1?.actions[0]?.excluded).toBe(true);
    expect(await exists(abs(EXCLUDED_REL))).toBe(true);
    expect(await exists(abs(NORMAL_REL))).toBe(false);
    expect((await metaAction()).artifactPath).toBe(EXCLUDED_REL);

    await setActionArtifactExcluded(TASK_ID, ACTION_ID, false);
    expect(await exists(abs(NORMAL_REL))).toBe(true);
    expect((await metaAction()).artifactPath).toBe(NORMAL_REL);
  });

  it("划除时 writeMeta 失败：文件被挪回原处、meta 不变（不再是「产出不存在」）", async () => {
    await seed(NORMAL_REL);
    const ctl = failMetaRename();

    await expect(setActionArtifactExcluded(TASK_ID, ACTION_ID, true)).rejects.toMatchObject({ code: "ENOSPC" });

    expect(ctl.metaHits).toBeGreaterThan(0);
    expect(await fs.readFile(abs(NORMAL_REL), "utf-8")).toBe(BODY);
    expect(await exists(abs(EXCLUDED_REL))).toBe(false);
    const a = await metaAction();
    expect(a.artifactPath).toBe(NORMAL_REL);
    expect(a.excluded).not.toBe(true);
  });

  it("恢复时 writeMeta 失败：文件被挪回 .excluded/、meta 仍指向 .excluded/", async () => {
    await seed(EXCLUDED_REL, { excluded: true });
    failMetaRename();

    await expect(setActionArtifactExcluded(TASK_ID, ACTION_ID, false)).rejects.toMatchObject({ code: "ENOSPC" });

    expect(await fs.readFile(abs(EXCLUDED_REL), "utf-8")).toBe(BODY);
    expect(await exists(abs(NORMAL_REL))).toBe(false);
    const a = await metaAction();
    expect(a.artifactPath).toBe(EXCLUDED_REL);
    expect(a.excluded).toBe(true);
  });

  it("writeMeta 失败且回滚也失败：抛 ArtifactMoveRollbackError，message 点明文件现在的位置", async () => {
    await seed(NORMAL_REL);
    const ctl = failMetaRename({ failRollback: true });

    const err = await setActionArtifactExcluded(TASK_ID, ACTION_ID, true).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ArtifactMoveRollbackError);
    expect(ctl.rollbackHits).toBeGreaterThan(0);
    const e = err as InstanceType<typeof ArtifactMoveRollbackError>;
    expect(e.currentPath).toBe(abs(EXCLUDED_REL));
    expect(e.expectedPath).toBe(abs(NORMAL_REL));
    expect(e.message).toContain(".excluded");
    // 文件没丢：仍在 .excluded/ 里（只是回不去）
    expect(await fs.readFile(abs(EXCLUDED_REL), "utf-8")).toBe(BODY);
  });

  it("存在性探测遇到非 ENOENT（EACCES）：不能当「文件不在」只翻 meta——操作失败、文件与 meta 都不动", async () => {
    await seed(NORMAL_REL);
    const realAccess = fs.access.bind(fs) as (...a: unknown[]) => Promise<void>;
    vi.spyOn(fs, "access").mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p) === abs(NORMAL_REL)
        ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
        : realAccess(p, ...rest)) as unknown as typeof fs.access);

    await expect(setActionArtifactExcluded(TASK_ID, ACTION_ID, true)).rejects.toMatchObject({ code: "EACCES" });

    vi.restoreAllMocks();
    expect(await fs.readFile(abs(NORMAL_REL), "utf-8")).toBe(BODY);
    const a = await metaAction();
    expect(a.artifactPath).toBe(NORMAL_REL);
    expect(a.excluded).not.toBe(true);
  });

  it("文件明确不存在（ENOENT，agent 没写成）：照旧只翻 flag + 改 artifactPath，不报错", async () => {
    await seed(NORMAL_REL);
    await fs.rm(abs(NORMAL_REL));

    const t = await setActionArtifactExcluded(TASK_ID, ACTION_ID, true);

    expect(t?.actions[0]?.excluded).toBe(true);
    expect((await metaAction()).artifactPath).toBe(EXCLUDED_REL);
  });
});

describe("snapshotActionArtifact：先写新的、meta 成功后才删旧的", () => {
  /** 已满上限的 revision（ts 1..MAX），第 1 份是最老的 */
  const seedFullRevisions = async (): Promise<ArtifactRevision[]> => {
    await seed(NORMAL_REL);
    const revs: ArtifactRevision[] = [];
    for (let i = 1; i <= MAX_REVISIONS_PER_ACTION; i++) {
      const rel = `actions/.revisions/${ACTION_ID}/${i}.md`;
      await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
      await fs.writeFile(abs(rel), `# 旧版本 ${i}\n`, "utf-8");
      revs.push({ timestamp: i, path: rel, size: Buffer.byteLength(`# 旧版本 ${i}\n`, "utf-8") });
    }
    await writeMeta(meta(action({ revisions: revs })));
    return revs;
  };

  it("对照：满额时追加新快照 → 淘汰最老的（文件与 meta 一起）", async () => {
    const revs = await seedFullRevisions();
    const rev = await snapshotActionArtifact(TASK_ID, ACTION_ID);
    expect(rev).not.toBeNull();
    const a = await metaAction();
    expect(a.revisions).toHaveLength(MAX_REVISIONS_PER_ACTION);
    expect(a.revisions?.some((r) => r.timestamp === revs[0]!.timestamp)).toBe(false);
    expect(await exists(abs(revs[0]!.path))).toBe(false);
    expect(await exists(abs(rev!.path))).toBe(true);
  });

  it("满额时 writeMeta 失败：最老的 revision 文件还在、meta 不变、新快照文件被清掉（不留幽灵）", async () => {
    const revs = await seedFullRevisions();
    failMetaRename();

    await expect(snapshotActionArtifact(TASK_ID, ACTION_ID)).rejects.toMatchObject({ code: "ENOSPC" });

    vi.restoreAllMocks();
    for (const r of revs) {
      expect(await exists(abs(r.path)), r.path).toBe(true); // 一份都没丢
    }
    const a = await metaAction();
    expect(a.revisions?.map((r) => r.timestamp)).toEqual(revs.map((r) => r.timestamp));
    const dir = path.join(taskDir(TASK_ID), "actions", ".revisions", ACTION_ID);
    expect((await fs.readdir(dir)).sort()).toEqual(revs.map((r) => `${r.timestamp}.md`).sort());
  });
});
