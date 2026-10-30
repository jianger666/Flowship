/**
 * 共享库主克隆的陈旧 git 锁自愈（R14 B7-1 · Q13-02）
 *
 * 症状：sync / 上传中途被杀（退出 App、断电、崩溃）会在 `.git/` 留下 `index.lock` 等锁文件。
 * `ensureRepoAt` 的探活（rev-parse）不需要锁、仍判「健康仓」，随后 `reset --hard` 写 index 报 File exists，
 * 此后每次 sync 都失败、界面没有任何修复入口。
 *
 * 钉五件事：
 *   ① 陈旧锁（根下的 index.lock、refs 下的 ref 锁）在 fetch 之前被清，sync 自愈、拿到最新远端提交；
 *   ② 较新的锁（可能是用户在终端里的 git 正在用）一律不动：不清锁、不删仓，错误里点明锁文件，等下一轮；
 *   ③ 清锁后 reset 仍失败（索引损坏）→ 与半残 .git 同口径整仓重 clone；而 fetch 失败仍然不删仓（网络抖动别误清缓存），
 *      reset 因权限 / 文件被占用 / 磁盘空间这类环境问题失败也不删仓（缓存没坏，重 clone 删不干净反而把缓存毁掉一半）；
 *   ④ clearStaleGitLocks 的范围与阈值：只动 `.git/` 根和 `.git/refs/**` 下名字以 `.lock` 结尾的普通文件，
 *      不碰 objects / gc.pid / 目录 / 符号链接；60 秒阈值（`now` 可注入、不真等）；
 *   ⑤ isEnvironmentalGitError 的判据：8 条环境类文案（对应正则的 8 个分支）→ true、6 条别的失败文案 → false（纯函数，表驱动）。
 *
 * 除 ⑤ 外全部真跑 git：本地 bare 当远端（路径当 URL，免 token、不碰网络）。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  clearStaleGitLocks,
  ensureRepoAt,
  isEnvironmentalGitError,
  STALE_GIT_LOCK_MIN_AGE_MS,
} from "@/lib/server/team-library";

const execFileAsync = promisify(execFile);

const TMP = path.join(os.tmpdir(), `fe-tl-stale-lock-${Date.now()}`);
const bareDir = path.join(TMP, "bare.git");
const pusherDir = path.join(TMP, "pusher");
const MINUTE = 60_000;
let seq = 0;

const git = async (args: string[], cwd: string): Promise<string> =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

/** 向 bare 远端再推一个提交（让 fetch / reset 真有活干） */
const pushCommit = async (file: string, content: string): Promise<void> => {
  await fs.writeFile(path.join(pusherDir, file), content, "utf-8");
  await git(["add", "."], pusherDir);
  await git(["commit", "-m", `add ${file}`], pusherDir);
  await git(["push", "origin", "main"], pusherDir);
};

/** 每个用例一个全新的健康克隆 */
const cloneWork = async (): Promise<string> => {
  const work = path.join(TMP, `work-${++seq}`);
  await execFileAsync("git", ["clone", "--branch", "main", bareDir, work]);
  return work;
};

/** 在 `.git/<rel>` 造一个空锁文件，mtime 调成 ageMs 之前 */
const makeLock = async (
  work: string,
  rel: string,
  ageMs: number,
): Promise<string> => {
  const abs = path.join(work, ".git", rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "", "utf-8");
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(abs, t, t);
  return abs;
};

const exists = async (p: string): Promise<boolean> =>
  !!(await fs.lstat(p).catch(() => null));

const ensure = (dir: string, cleanUrl = bareDir) =>
  ensureRepoAt({ dir, cleanUrl, branch: "main", token: "" });

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "-b", "main", bareDir]);
  await fs.mkdir(pusherDir, { recursive: true });
  await git(["init", "-b", "main"], pusherDir);
  await git(["remote", "add", "origin", bareDir], pusherDir);
  await fs.writeFile(path.join(pusherDir, "README.md"), "seed\n", "utf-8");
  await git(["add", "."], pusherDir);
  await git(["commit", "-m", "seed"], pusherDir);
  await git(["push", "origin", "main"], pusherDir);
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("ensureRepoAt：残留锁自愈", () => {
  it("陈旧 index.lock + 陈旧 ref 锁 → fetch 前清掉，sync 成功并拿到最新提交", async () => {
    const work = await cloneWork();
    await pushCommit("v2.txt", "v2\n");
    const indexLock = await makeLock(work, "index.lock", 5 * MINUTE);
    const refLock = await makeLock(
      work,
      "refs/remotes/origin/main.lock",
      5 * MINUTE,
    );
    // 前置：这把锁确实会让 reset --hard 失败（否则下面的「自愈」什么都证明不了）
    await expect(
      execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: work }),
    ).rejects.toThrow();

    const r = await ensure(work);

    expect(r).toEqual({ ok: true });
    expect(await exists(indexLock)).toBe(false);
    expect(await exists(refLock)).toBe(false);
    expect(await fs.readFile(path.join(work, "v2.txt"), "utf-8")).toBe("v2\n");
    expect(await git(["rev-parse", "HEAD"], work)).toBe(
      await git(["rev-parse", "main"], bareDir),
    );
  });

  it("config.lock 也清（remote set-url 要写 config，它的失败原来没人看）", async () => {
    const work = await cloneWork();
    const configLock = await makeLock(work, "config.lock", 5 * MINUTE);

    const r = await ensure(work);

    expect(r).toEqual({ ok: true });
    expect(await exists(configLock)).toBe(false);
  });

  it("较新的 index.lock（可能有 git 正在用）→ 不清锁、不删仓，错误里点明锁文件，下一轮再试", async () => {
    const work = await cloneWork();
    // 未跟踪文件当哨兵：整仓重 clone 会把它清掉，没重 clone 它才在
    await fs.writeFile(path.join(work, "KEEP.txt"), "keep\n", "utf-8");
    const lock = await makeLock(work, "index.lock", 1_000);

    const r = await ensure(work);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("reset 失败");
      expect(r.error).toContain("index.lock");
    }
    expect(await exists(lock)).toBe(true);
    expect(await fs.readFile(path.join(work, "KEEP.txt"), "utf-8")).toBe(
      "keep\n",
    );

    // 锁变陈旧（模拟持锁的 git 早已退出）→ 下一轮走清锁自愈
    const t = new Date(Date.now() - 5 * MINUTE);
    await fs.utimes(lock, t, t);
    const again = await ensure(work);
    expect(again).toEqual({ ok: true });
    expect(await exists(lock)).toBe(false);
  });

  it("清锁后 reset 仍失败（index.lock 的位置被一个目录占着、清不掉）→ 整仓重 clone 自愈", async () => {
    const work = await cloneWork();
    await pushCommit("v3.txt", "v3\n");
    // 名字叫 index.lock 的目录：不是普通文件、不归清锁管，却照样挡住 git 写索引
    await fs.mkdir(path.join(work, ".git", "index.lock"));
    await fs.writeFile(path.join(work, "STALE.txt"), "stale\n", "utf-8");
    // 前置：reset --hard 确实会失败
    await expect(
      execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: work }),
    ).rejects.toThrow();

    const r = await ensure(work);

    expect(r).toEqual({ ok: true });
    // 整仓重建：残留的未跟踪文件没了、占位目录没了、最新提交在、索引健康
    expect(await exists(path.join(work, "STALE.txt"))).toBe(false);
    expect(await exists(path.join(work, ".git", "index.lock"))).toBe(false);
    expect(await fs.readFile(path.join(work, "v3.txt"), "utf-8")).toBe("v3\n");
    await expect(git(["status", "--porcelain"], work)).resolves.toBe("");
  });

  it("索引损坏：连 fetch 都失败，但本地自检不过 → 整仓重 clone 自愈", async () => {
    const work = await cloneWork();
    await pushCommit("v4.txt", "v4\n");
    await fs.writeFile(
      path.join(work, ".git", "index"),
      "garbage-not-an-index\n",
      "utf-8",
    );
    await fs.writeFile(path.join(work, "STALE.txt"), "stale\n", "utf-8");
    // 前置：损坏的索引让 fetch 本身就失败（所以光靠「reset 失败才重 clone」救不了它）
    await expect(
      execFileAsync("git", ["fetch", "origin", "main"], { cwd: work }),
    ).rejects.toThrow();

    const r = await ensure(work);

    expect(r).toEqual({ ok: true });
    expect(await exists(path.join(work, "STALE.txt"))).toBe(false);
    expect(await fs.readFile(path.join(work, "v4.txt"), "utf-8")).toBe("v4\n");
    await expect(git(["status", "--porcelain"], work)).resolves.toBe("");
  });

  it("索引损坏、但还有较新的锁（可能有 git 正在用）→ 不删仓，错误里点明锁文件", async () => {
    const work = await cloneWork();
    await fs.writeFile(
      path.join(work, ".git", "index"),
      "garbage-not-an-index\n",
      "utf-8",
    );
    await fs.writeFile(path.join(work, "KEEP.txt"), "keep\n", "utf-8");
    const lock = await makeLock(work, "refs/heads/main.lock", 1_000);

    const r = await ensure(work);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("fetch 失败");
      expect(r.error).toContain("refs/heads/main.lock");
    }
    expect(await exists(lock)).toBe(true);
    expect(await fs.readFile(path.join(work, "KEEP.txt"), "utf-8")).toBe(
      "keep\n",
    );
  });

  it("fetch 失败仍然不删仓（网络抖动别误清缓存）", async () => {
    const work = await cloneWork();
    await fs.writeFile(path.join(work, "KEEP.txt"), "keep\n", "utf-8");

    const r = await ensure(work, path.join(TMP, "no-such.git"));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("fetch 失败");
    expect(await fs.readFile(path.join(work, "KEEP.txt"), "utf-8")).toBe(
      "keep\n",
    );
    await expect(git(["rev-parse", "--git-dir"], work)).resolves.toBe(".git");
  });

  it("清了锁会留一行 console.warn（界面上看不到自愈，至少日志里查得到是哪几把）", async () => {
    const work = await cloneWork();
    await makeLock(work, "index.lock", 5 * MINUTE);
    await makeLock(work, "refs/remotes/origin/main.lock", 5 * MINUTE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await ensure(work)).toEqual({ ok: true });
      const lines = warn.mock.calls.map((c) => c.join(" "));
      const hit = lines.filter((l) => l.includes("清除陈旧 git 锁文件"));
      expect(hit).toHaveLength(1);
      expect(hit[0]).toContain("index.lock");
      expect(hit[0]).toContain("refs/remotes/origin/main.lock");
    } finally {
      warn.mockRestore();
    }
  });

  it("warn 的触发条件：清了 1 把锁也留一行；没有残留锁时不留（健康 sync 不该每轮刷一行日志）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lockLines = (): string[] =>
      warn.mock.calls
        .map((c) => c.join(" "))
        .filter((l) => l.includes("清除陈旧 git 锁文件"));
    try {
      const withLock = await cloneWork();
      await makeLock(withLock, "index.lock", 5 * MINUTE);
      expect(await ensure(withLock)).toEqual({ ok: true });
      expect(lockLines()).toHaveLength(1);

      warn.mockClear();
      const healthy = await cloneWork();
      expect(await ensure(healthy)).toEqual({ ok: true });
      expect(lockLines()).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  // reset 因权限 / 文件被占用 / 磁盘空间这类「非损坏」原因失败：重新 clone 解决不了——旧目录删不干净会半删，
  // 新 clone 又因目标目录非空失败，缓存反而被毁（R14 B7-1 终审 R1）。保留缓存、如实报错，条件解除后下一轮自愈。
  // （只读目录的构造在 root / Windows 上不起作用，跳过）
  const canChmodDirs = process.platform !== "win32" && process.getuid?.() !== 0;
  (canChmodDirs ? it : it.skip)(
    "reset 因权限失败（缓存没坏）→ 不整仓重 clone：缓存原样保留、错误如实，权限恢复后下一轮自愈",
    async () => {
      await fs.mkdir(path.join(pusherDir, "perm"), { recursive: true });
      await pushCommit("perm/a.txt", "v1\n");
      const work = await cloneWork();
      await pushCommit("perm/a.txt", "v2\n"); // 远端改它 → reset 必须改写 work/perm/a.txt
      await fs.writeFile(path.join(work, "SENTINEL.txt"), "x\n", "utf-8"); // 未跟踪哨兵：整仓重 clone 会把它清掉
      const permDir = path.join(work, "perm");
      await fs.chmod(permDir, 0o555); // 目录只读：git 无法 unlink / 重写里面的文件
      try {
        // 前置：reset --hard 确实会因权限失败，而索引 / HEAD 完全健康（不是缓存损坏）
        await git(["fetch", "origin", "main"], work);
        await expect(
          execFileAsync("git", ["reset", "--hard", "FETCH_HEAD"], {
            cwd: work,
          }),
        ).rejects.toThrow(/Permission denied/);

        const r = await ensure(work);

        expect(r.ok).toBe(false);
        if (r.ok) throw new Error("unreachable");
        expect(r.error).toContain("Permission denied");
        expect(r.error).not.toContain("整仓重新 clone 也失败");
        expect(await exists(path.join(work, ".git"))).toBe(true);
        expect(await exists(path.join(work, "README.md"))).toBe(true);
        expect(await exists(path.join(work, "SENTINEL.txt"))).toBe(true);
      } finally {
        await fs.chmod(permDir, 0o755);
      }
      // 条件解除后：下一轮自愈
      expect(await ensure(work)).toEqual({ ok: true });
      expect(await fs.readFile(path.join(work, "perm/a.txt"), "utf-8")).toBe(
        "v2\n",
      );
    },
  );

  /**
   * HEAD 解析不了、但索引还读得出来、`rev-parse --git-dir` 也正常：
   * 探活判「健康仓」，fetch 失败后只有「本地自检看 HEAD」才发现缓存已坏。
   * 远端换成一个不存在的路径：fetch 必败，重 clone 也必败——这样两条失败原因都能在错误里看到。
   */
  const brokenHeadWork = async (): Promise<string> => {
    const work = await cloneWork();
    await git(["symbolic-ref", "HEAD", "refs/heads/no-such-branch"], work);
    await expect(
      git(["rev-parse", "--verify", "-q", "HEAD"], work),
    ).rejects.toThrow();
    await expect(git(["rev-parse", "--git-dir"], work)).resolves.toBe(".git");
    await expect(
      git(["ls-files", "--", ".flowship-probe-no-such-path"], work),
    ).resolves.toBe("");
    return work;
  };

  it("HEAD 解析不了（索引还读得出来）且 fetch 失败 → 本地自检判缓存已坏、整仓重 clone；重 clone 也失败就如实报，旧目录已被清掉", async () => {
    const work = await brokenHeadWork();
    await fs.writeFile(path.join(work, "STALE.txt"), "stale\n", "utf-8");

    const r = await ensure(work, path.join(TMP, "no-such.git"));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("整仓重新 clone 也失败");
    expect(await exists(path.join(work, "STALE.txt"))).toBe(false);
    expect(await exists(path.join(work, ".git"))).toBe(false);
  });

  it("重 clone 也失败时，错误里同时有原来的 fetch 失败原因与重 clone 的失败原因（不只留后一个）", async () => {
    const work = await brokenHeadWork();

    const r = await ensure(work, path.join(TMP, "no-such.git"));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("fetch 失败：");
      expect(r.error).toContain("整仓重新 clone 也失败：clone 失败：");
    }
  });
});

describe("clearStaleGitLocks：范围与阈值", () => {
  it("阈值常量钉在 60 秒", () => {
    expect(STALE_GIT_LOCK_MIN_AGE_MS).toBe(60_000);
  });

  it("只清 .git 根与 refs/** 下名字以 .lock 结尾的普通文件；objects / gc.pid / 目录 / 符号链接 / 其它名字一概不动", async () => {
    const work = await cloneWork();
    const gitDir = path.join(work, ".git");
    await makeLock(work, "index.lock", 5 * MINUTE);
    await makeLock(work, "refs/heads/feature/x.lock", 5 * MINUTE);

    const keepers: string[] = [];
    // objects 下的 *.lock：对象库有自己的临时文件命名，不归这里管
    keepers.push(await makeLock(work, "objects/pack/tmp_pack.lock", 5 * MINUTE));
    // 非 .lock 结尾
    keepers.push(await makeLock(work, "gc.pid", 5 * MINUTE));
    keepers.push(await makeLock(work, "foo.lock.bak", 5 * MINUTE));
    // 名字以 lock 结尾但不是 .lock：一个叫 unlock 的分支引用文件、根下的 xlock——绝不能当锁删
    keepers.push(await makeLock(work, "refs/heads/unlock", 5 * MINUTE));
    keepers.push(await makeLock(work, "xlock", 5 * MINUTE));
    // 名字像锁的目录（连同目录里的文件）
    const dirLock = path.join(gitDir, "dir.lock");
    await fs.mkdir(dirLock);
    keepers.push(dirLock);
    const inner = path.join(dirLock, "inner.lock");
    await fs.writeFile(inner, "", "utf-8");
    keepers.push(inner);
    // 符号链接：lstat 不是普通文件
    const linkTarget = path.join(TMP, `link-target-${seq}`);
    await fs.writeFile(linkTarget, "target\n", "utf-8");
    const link = path.join(gitDir, "HEAD.lock");
    await fs.symlink(linkTarget, link);
    keepers.push(link);

    const res = await clearStaleGitLocks(work);

    expect(res.removed).toEqual(["index.lock", "refs/heads/feature/x.lock"]);
    expect(res.skippedFresh).toEqual([]);
    for (const k of keepers) expect(await exists(k)).toBe(true);
    expect(await exists(path.join(gitDir, "index.lock"))).toBe(false);
    expect(await exists(path.join(gitDir, "refs/heads/feature/x.lock"))).toBe(
      false,
    );
  });

  it("阈值：默认 60 秒——61 秒的清、59 秒的留并报给调用方（now 注入，不受测试耗时影响）", async () => {
    const work = await cloneWork();
    const now = Date.now();
    const old = await makeLock(work, "index.lock", 0);
    const fresh = await makeLock(work, "refs/heads/y.lock", 0);
    await fs.utimes(old, new Date(now - 61_000), new Date(now - 61_000));
    await fs.utimes(fresh, new Date(now - 59_000), new Date(now - 59_000));

    const res = await clearStaleGitLocks(work, { now });

    expect(res.removed).toEqual(["index.lock"]);
    expect(res.skippedFresh).toEqual(["refs/heads/y.lock"]);
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it("minAgeMs 可调：10 分钟阈值下 9 分钟的锁留、11 分钟的清", async () => {
    const work = await cloneWork();
    await makeLock(work, "index.lock", 11 * MINUTE);
    await makeLock(work, "HEAD.lock", 9 * MINUTE);

    const res = await clearStaleGitLocks(work, { minAgeMs: 10 * MINUTE });

    expect(res.removed).toEqual(["index.lock"]);
    expect(res.skippedFresh).toEqual(["HEAD.lock"]);
  });

  it(".git 不存在 → 什么都不做、不抛", async () => {
    await expect(
      clearStaleGitLocks(path.join(TMP, "no-such-dir")),
    ).resolves.toEqual({ removed: [], skippedFresh: [] });
  });

  it("阈值边界：年龄恰好 60 秒的锁算陈旧（≥ 才清）；差 1 毫秒的还算较新", async () => {
    const work = await cloneWork();
    // 整秒时间戳：utimes / mtimeMs 的浮点往返没有误差，边界才稳定
    const now = Math.floor(Date.now() / 1000) * 1000;
    const exact = await makeLock(work, "index.lock", 0);
    const almost = await makeLock(work, "HEAD.lock", 0);
    await fs.utimes(exact, new Date(now - 60_000), new Date(now - 60_000));
    await fs.utimes(almost, new Date(now - 59_999), new Date(now - 59_999));

    const res = await clearStaleGitLocks(work, { now });

    expect(res.removed).toEqual(["index.lock"]);
    expect(res.skippedFresh).toEqual(["HEAD.lock"]);
  });

  it("refs 下只扫到 8 层子目录：第 8 层里的锁清、第 9 层里的不动", async () => {
    const work = await cloneWork();
    const dirs = Array.from({ length: 9 }, (_, i) => `d${i + 1}`);
    const rel8 = `refs/${dirs.slice(0, 8).join("/")}/ok.lock`;
    const rel9 = `refs/${dirs.join("/")}/too-deep.lock`;
    const abs8 = await makeLock(work, rel8, 5 * MINUTE);
    const abs9 = await makeLock(work, rel9, 5 * MINUTE);

    const res = await clearStaleGitLocks(work);

    expect(res.removed).toEqual([rel8]);
    expect(res.skippedFresh).toEqual([]);
    expect(await exists(abs8)).toBe(false);
    expect(await exists(abs9)).toBe(true);
  });

  it("返回的路径已排序（根下的锁先于 refs 被处理，不排序就是处理顺序）：removed 与 skippedFresh 都是", async () => {
    const work = await cloneWork();
    await makeLock(work, "zz.lock", 5 * MINUTE);
    await makeLock(work, "refs/heads/aa.lock", 5 * MINUTE);
    await makeLock(work, "yy.lock", 1_000);
    await makeLock(work, "refs/heads/bb.lock", 1_000);

    const res = await clearStaleGitLocks(work);

    expect(res.removed).toEqual(["refs/heads/aa.lock", "zz.lock"]);
    expect(res.skippedFresh).toEqual(["refs/heads/bb.lock", "yy.lock"]);
  });

  // 删不掉的构造：把 .git 目录改成不可写（root / Windows 上权限不起作用，跳过）
  const canMakeUnwritable =
    process.platform !== "win32" && process.getuid?.() !== 0;
  (canMakeUnwritable ? it : it.skip)(
    "删不掉（.git 目录不可写）→ 不抛、不记进 removed、锁原样留着（交给后面的 git 命令报真实错误）",
    async () => {
      const work = await cloneWork();
      const gitDir = path.join(work, ".git");
      const lock = await makeLock(work, "index.lock", 5 * MINUTE);
      await fs.chmod(gitDir, 0o555);
      try {
        // 前置：确实删不掉（否则下面什么都证明不了）
        await expect(fs.rm(lock, { force: true })).rejects.toThrow();

        const res = await clearStaleGitLocks(work);

        expect(res).toEqual({ removed: [], skippedFresh: [] });
        expect(await exists(lock)).toBe(true);
      } finally {
        await fs.chmod(gitDir, 0o755);
      }
    },
  );
});

describe("isEnvironmentalGitError：哪些 git 失败「重新 clone 解决不了」", () => {
  it.each([
    "error: unable to unlink old 'skills/a/SKILL.md': Permission denied",
    "error: unable to create file x: Operation not permitted",
    "error: unable to unlink old 'x': Device or resource busy",
    "error: unable to unlink old 'x': Invalid argument",
    "error: unable to write file x: No space left on device",
    "error: unable to create file x: Read-only file system",
    "error: unable to write file x: Disk quota exceeded",
    "error: unable to unlink old 'x': The process cannot access the file because it is being used by another process.",
  ])("环境类（保留缓存）：%s", (msg) => {
    expect(isEnvironmentalGitError(msg)).toBe(true);
  });

  it.each([
    "fatal: Unable to create '/r/.git/index.lock': File exists.",
    "error: index file smaller than expected",
    "error: bad signature 0x00000000\nfatal: index file corrupt",
    "error: unable to read sha1 file of x (abc123): loose object abc123 is corrupt",
    "fatal: couldn't find remote ref refs/heads/nope",
    "",
  ])("不是环境类（重 clone 有机会修好）：%s", (msg) => {
    expect(isEnvironmentalGitError(msg)).toBe(false);
  });
});
