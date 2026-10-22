/**
 * 第四轮 Q3-02 / Q3-03 / Q3-04 / Q3-05 / Q3-09：WIP 快照守卫的剩余旁路——真 git 临时仓 + 真 removeTaskWorktrees。
 *
 *  - Q3-05：`status.showUntrackedFiles=no` 让 status 看不见未跟踪文件 → 「只新增文件」的 worktree 被判干净直接删；
 *  - Q3-04：嵌套 git 仓深度 ≥2（`a/b/inner`）：默认 status 折成 `? a/`，守卫只探 `a/.git` → 漏过；
 *  - Q3-02：status v2 -uall 输出变大，旧 4MiB 上限下数万文件改动 → failed 且原因为空；
 *  - Q3-03：子模块指针移动 + 本地提交（`SC..`）→ 提交只在子模块 gitdir，删目录后三处不可达；
 *  - Q3-09：同毫秒并发快照撞临时 index 名 → 误报「git add -A 失败：Unable to create …lock」。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";
import { buildStaleForceDescription } from "@/lib/worktree-report";

const TMP_ROOT = path.join(os.tmpdir(), `fe-wip-guard-r4-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import {
  cleanupStaleTaskWorktrees,
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  getTaskWorktreesDir,
  removeTaskWorktrees,
  wipSnapshotRefName,
} from "@/lib/server/task-worktrees";

const DATA_DIR = process.env.FLOWSHIP_DATA_DIR!;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 1 << 30 }).trim();
const gitFile = (cwd: string, ...args: string[]): string =>
  git(cwd, "-c", "protocol.file.allow=always", ...args);
const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);

const initRepo = async (name: string): Promise<string> => {
  const repo = path.join(TMP_ROOT, name);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, "f.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  return repo;
};

let seq = 0;
const makeTask = (repo: string, tag: string): Task => {
  seq += 1;
  return {
    id: `t_1700000019${String(seq).padStart(3, "0")}_${tag}`,
    mode: "task",
    title: "守卫 r4",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [repo],
    isolateWorktree: true,
    repoBaseBranches: { [repo]: "main" },
    feishuStoryUrl: `https://project.feishu.cn/x/story/detail/${810000 + seq}`,
    actions: [],
    mrs: [],
  } as unknown as Task;
};

const setupTask = async (tag: string, prepare?: (repo: string) => Promise<void> | void) => {
  const repo = await initRepo(`${tag}-main`);
  await prepare?.(repo);
  const t = makeTask(repo, tag);
  await fs.mkdir(path.join(DATA_DIR, "tasks", t.id), { recursive: true });
  await ensureTaskWorktrees(t, () => true);
  const wd = getTaskWorkRepoPaths(t)[0];
  return { repo, t, wd };
};

const wipRef = (repo: string, t: Task, wd: string): string =>
  git(repo, "for-each-ref", "--format=%(refname)", wipSnapshotRefName(t.id, path.basename(wd)));

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("Q3-05：status.showUntrackedFiles=no 不能让守卫失明", () => {
  it("仓里配了 showUntrackedFiles=no、worktree 只新增了文件 → 仍落快照（有 WIP ref、新文件内容在里面）再删", async () => {
    const { repo, t, wd } = await setupTask("uf-no", (r) => {
      git(r, "config", "status.showUntrackedFiles", "no");
    });
    await fs.writeFile(path.join(wd, "only-new.ts"), "export const precious = 1;\n");
    // 前提：用户配置下普通 status 确实什么都看不到（旧实现据此判 clean）
    expect(git(wd, "status", "--porcelain")).toBe("");
    expect(git(wd, "status", "--porcelain=v2", "-z", "--ignore-submodules=none")).toBe("");

    const removed = await removeTaskWorktrees(t);

    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(removed.snapshotRepos).toEqual([repo]);
    expect(removed.removedAny).toBe(true);
    const ref = removed.snapshots![0].ref;
    expect(wipRef(repo, t, wd)).toBe(ref);
    expect(git(repo, "show", `${ref}:only-new.ts`)).toBe("export const precious = 1;");
    expect(await exists(wd)).toBe(false);
  }, 60_000);

  it("对照（旧树能用的情形）：没配 showUntrackedFiles 时同样落快照；真干净的 worktree 不产生快照", async () => {
    const a = await setupTask("uf-default");
    await fs.writeFile(path.join(a.wd, "only-new.ts"), "x\n");
    const ra = await removeTaskWorktrees(a.t);
    expect(ra.snapshotRepos).toEqual([a.repo]);

    const b = await setupTask("uf-clean", (r) => {
      git(r, "config", "status.showUntrackedFiles", "no");
    });
    const rb = await removeTaskWorktrees(b.t);
    expect(rb.snapshotRepos).toEqual([]);
    expect(rb.snapshotFailedRepos).toEqual([]);
    expect(rb.removedAny).toBe(true);
    expect(wipRef(b.repo, b.t, b.wd)).toBe("");
  }, 60_000);
});

describe("Q3-04：嵌套 git 仓深度 ≥2 也要拦", () => {
  const makeNested = async (wd: string, rel: string) => {
    const inner = path.join(wd, rel);
    await fs.mkdir(inner, { recursive: true });
    git(inner, "init", "-b", "main");
    await fs.writeFile(path.join(inner, "secret.md"), "只在嵌套仓里\n");
    git(inner, "add", "-A");
    git(inner, "-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-m", "inner");
    await fs.writeFile(path.join(inner, "wip.md"), "嵌套仓里未提交的\n");
  };

  it.each([
    ["深度 2", "refs/inner"],
    ["深度 3", "a/b/c/inner"],
  ])("%s（%s，父目录整棵都是未跟踪）：快照失败、目录保留、原因点名该嵌套仓", async (_label, rel) => {
    const { repo, t, wd } = await setupTask(`nest-${rel.replace(/\//g, "-")}`);
    await makeNested(wd, rel);
    // 前提：默认 status 把它折成顶层目录条目（`? refs/`）、该条目自己下面没有 .git——这就是旧守卫探不到的原因
    const top = rel.split("/")[0];
    expect(git(wd, "status", "--porcelain")).toBe(`?? ${top}/`);

    const removed = await removeTaskWorktrees(t);

    expect(removed.removedAny).toBe(false);
    expect(removed.snapshotFailedRepos).toEqual([repo]);
    expect(removed.snapshotFailures![0].reason).toContain("嵌套");
    expect(removed.snapshotFailures![0].reason).toContain(rel);
    expect(await fs.readFile(path.join(wd, rel, "wip.md"), "utf8")).toBe("嵌套仓里未提交的\n");
    expect(wipRef(repo, t, wd)).toBe("");
  }, 60_000);

  it("showUntrackedFiles=no + 嵌套仓：两个旁路叠加也拦得住", async () => {
    const { repo, t, wd } = await setupTask("nest-uf-no", (r) => {
      git(r, "config", "status.showUntrackedFiles", "no");
    });
    await makeNested(wd, "vendor/inner");
    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotFailedRepos).toEqual([repo]);
    expect(removed.snapshotFailures![0].reason).toContain("vendor/inner");
  }, 60_000);

  it("对照：深层的普通未跟踪目录（里面没有 .git）照常快照后清理，不被误拦", async () => {
    const { repo, t, wd } = await setupTask("nest-plain");
    await fs.mkdir(path.join(wd, "a/b/c"), { recursive: true });
    await fs.writeFile(path.join(wd, "a/b/c/deep.ts"), "deep\n");
    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(removed.snapshotRepos).toEqual([repo]);
    expect(git(repo, "show", `${removed.snapshots![0].ref}:a/b/c/deep.ts`)).toBe("deep");
  }, 60_000);
});

describe("Q3-02：大改动（status 输出 > 旧 4MiB 上限）不再卡在「保留」", () => {
  it("1 万个已跟踪的长路径文件全被改：快照成功、有 WIP ref、目录删掉（旧树：failed 且原因为空）", async () => {
    const N = 10_000;
    const longName = (i: number) => `${"n".repeat(180)}${String(i).padStart(5, "0")}.ts`;
    const dirName = "d".repeat(200);
    const { repo, t, wd } = await setupTask("bigstatus", async (r) => {
      await fs.mkdir(path.join(r, dirName), { recursive: true });
      for (let i = 0; i < N; i++) {
        await fs.writeFile(path.join(r, dirName, longName(i)), "export {};\n");
      }
      git(r, "add", "-A");
      git(r, "commit", "-qm", "big");
    });
    for (let i = 0; i < N; i++) {
      await fs.appendFile(path.join(wd, dirName, longName(i)), "// codemod\n");
    }
    // 前提：v2 输出确实超过旧上限 4MiB
    const v2 = execFileSync(
      "git",
      ["status", "--porcelain=v2", "-z", "--ignore-submodules=none", "--untracked-files=all"],
      { cwd: wd, maxBuffer: 1 << 30 },
    );
    expect(v2.length).toBeGreaterThan(4 * 1024 * 1024);

    const removed = await removeTaskWorktrees(t);

    expect(removed.snapshotFailures ?? []).toEqual([]);
    expect(removed.snapshotRepos).toEqual([repo]);
    expect(wipRef(repo, t, wd)).not.toBe("");
    expect(await exists(wd)).toBe(false);
  }, 240_000);
});

describe("Q3-03：子模块指针移动 + 本地提交（SC..）不得被判 clean", () => {
  /** 主仓带子模块 vendor/sub，worktree 里把子模块拉起来 */
  const setupSub = async (tag: string) => {
    const sub = await initRepo(`${tag}-sub`);
    const { repo, t, wd } = await setupTask(tag, async (r) => {
      gitFile(r, "submodule", "add", sub, "vendor/sub");
      git(r, "commit", "-m", "add submodule");
    });
    gitFile(wd, "submodule", "update", "--init");
    return { sub, repo, t, wd, subDir: path.join(wd, "vendor", "sub") };
  };
  const commitIn = (dir: string, msg: string): string => {
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "--allow-empty", "-m", msg);
    return git(dir, "rev-parse", "HEAD");
  };

  it("S3：在子模块里提交了、没推送 → 快照失败、目录保留、原因点名子模块、本地提交还在", async () => {
    const { repo, t, wd, subDir } = await setupSub("sm-local");
    const lost = commitIn(subDir, "只在本地的提交");
    // 前提：父仓 v2 里是 `SC..`（指针变了、里面不脏）——旧守卫只认 m / u、把它当 clean
    expect(git(wd, "status", "--porcelain=v2", "--ignore-submodules=none")).toMatch(/ SC\.\. .*vendor\/sub/);

    const removed = await removeTaskWorktrees(t);

    expect(removed.removedAny).toBe(false);
    expect(removed.snapshotFailedRepos).toEqual([repo]);
    expect(removed.snapshotRepos).toEqual([]);
    const reason = removed.snapshotFailures![0].reason;
    expect(reason).toContain("子模块");
    expect(reason).toContain("vendor/sub");
    expect(reason).toContain(lost.slice(0, 8));
    expect(git(subDir, "cat-file", "-t", lost)).toBe("commit");
    expect(await exists(wd)).toBe(true);
  }, 90_000);

  it("S3b：提交已推送到远端（有远端跟踪 ref 包含它）→ 放行：落快照并删除", async () => {
    const { repo, t, subDir } = await setupSub("sm-pushed");
    const pushed = commitIn(subDir, "已推送的提交");
    gitFile(subDir, "push", "origin", "HEAD:refs/heads/feature-x");
    expect(git(subDir, "for-each-ref", "--contains", pushed, "refs/remotes")).toContain("origin/feature-x");

    const removed = await removeTaskWorktrees(t);

    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(removed.snapshotRepos).toEqual([repo]);
    expect(removed.removedAny).toBe(true);
    expect(git(repo, "ls-tree", removed.snapshots![0].ref, "vendor/sub")).toContain(pushed);
  }, 90_000);

  it("指针移到远端已有的提交（fetch 后 checkout）→ 放行", async () => {
    const { sub, repo, t, wd, subDir } = await setupSub("sm-fetched");
    const upstream = commitIn(sub, "上游新提交");
    gitFile(subDir, "fetch", "origin");
    git(subDir, "checkout", "-q", "--detach", upstream);
    expect(git(wd, "status", "--porcelain=v2", "--ignore-submodules=none")).toMatch(/ SC\.\. /);

    const removed = await removeTaskWorktrees(t);

    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(removed.snapshotRepos).toEqual([repo]);
  }, 90_000);

  it("子模块指针没动（S...）：照常清理、不产生快照（不误伤）", async () => {
    const { t, repo, wd } = await setupSub("sm-clean");
    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(removed.snapshotRepos).toEqual([]);
    expect(removed.removedAny).toBe(true);
    expect(wipRef(repo, t, wd)).toBe("");
  }, 90_000);

  it("残留目录清理（存储页入口）同一道守卫：本地提交 → kept", async () => {
    const { t, wd, subDir } = await setupSub("sm-stale");
    commitIn(subDir, "只在本地");
    await fs.rm(path.join(DATA_DIR, "tasks", t.id), { recursive: true, force: true });

    const res = await cleanupStaleTaskWorktrees(t.id);

    expect(res.removedDirs).toEqual([]);
    expect(res.kept).toHaveLength(1);
    expect(res.kept[0].reason).toContain("vendor/sub");
    expect(await exists(wd)).toBe(true);
    expect(await exists(getTaskWorktreesDir(t.id))).toBe(true);
  }, 90_000);
});

describe("Q3-09：并发快照同一目录不撞临时 index 名", () => {
  it("Date.now 被钉死（等价于同毫秒）时，多路并发快照也不会误报 index.lock 失败", async () => {
    const { t, wd } = await setupTask("conc");
    await fs.writeFile(path.join(wd, "a.ts"), "a\n");
    await fs.appendFile(path.join(wd, "f.txt"), "more\n");
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    // 记下每路快照拷出来的临时 index 路径（确定性断言：同毫秒 + 同 pid 下也必须各不相同）
    const origCopy = fs.copyFile.bind(fs);
    const tmpIndexes: string[] = [];
    vi.spyOn(fs, "copyFile").mockImplementation(async (src, dst, mode) => {
      if (String(dst).includes(".flowship-wip-")) tmpIndexes.push(String(dst));
      return origCopy(src, dst, mode);
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => cleanupStaleTaskWorktrees(t.id)),
    );

    expect(tmpIndexes.length).toBeGreaterThanOrEqual(2); // 至少两路真的并发进了快照
    expect(new Set(tmpIndexes).size).toBe(tmpIndexes.length);
    const reasons = results.flatMap((r) => r.kept.map((k) => k.reason));
    expect(reasons.filter((r) => /index\.lock|Unable to create|git add -A 失败/.test(r))).toEqual([]);
  }, 90_000);
});

describe("Q3-06：强删（force）仍先尽力快照，存不下才越过并记录", () => {
  const killTask = (t: Task) => fs.rm(path.join(DATA_DIR, "tasks", t.id), { recursive: true, force: true });

  it("force + 本来存得下的脏目录：照样落快照（有 ref / 改动在里面）再删，forced 为空", async () => {
    const { repo, t, wd } = await setupTask("force-saveable");
    await fs.writeFile(path.join(wd, "keep-me.ts"), "export const k = 1;\n");
    await killTask(t);

    const res = await cleanupStaleTaskWorktrees(t.id, { force: true });

    expect(res.kept).toEqual([]);
    expect(res.forced).toEqual([]);
    expect(res.removedDirs).toHaveLength(1);
    expect(res.snapshots).toHaveLength(1);
    expect(git(repo, "show", `${res.snapshots[0].ref}:keep-me.ts`)).toBe("export const k = 1;");
    expect(await exists(wd)).toBe(false);
  }, 60_000);

  it("force + 真存不下（嵌套 git 仓）：越过守卫删掉，但记进 forced（原因在案）；不带 force 则 kept 且不删", async () => {
    const mk = async (tag: string) => {
      const x = await setupTask(tag);
      const inner = path.join(x.wd, "vendor", "inner");
      await fs.mkdir(inner, { recursive: true });
      git(inner, "init", "-b", "main");
      await killTask(x.t);
      return x;
    };
    const a = await mk("force-unsaveable");
    const kept = await cleanupStaleTaskWorktrees(a.t.id);
    expect(kept.kept).toHaveLength(1);
    expect(kept.removedDirs).toEqual([]);
    expect(kept.forced).toEqual([]);
    expect(await exists(a.wd)).toBe(true);

    const forced = await cleanupStaleTaskWorktrees(a.t.id, { force: true });
    expect(forced.kept).toEqual([]);
    expect(forced.removedDirs).toHaveLength(1);
    expect(forced.forced).toHaveLength(1);
    expect(forced.forced[0].reason).toContain("vendor/inner");
    expect(await exists(a.wd)).toBe(false);
  }, 60_000);
});

describe("Q3-07：快照已落但目录删不掉——不能说「找不回了」", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "目录里有只读子目录：kept 带 snapshotSaved、snapshots 有记录；确认框文案改说「已存成快照」",
    async () => {
      const { t, wd } = await setupTask("rm-fail");
      const locked = path.join(wd, "locked");
      await fs.mkdir(locked, { recursive: true });
      await fs.writeFile(path.join(locked, "x.txt"), "x\n");
      await fs.chmod(locked, 0o555);
      await fs.rm(path.join(DATA_DIR, "tasks", t.id), { recursive: true, force: true });
      try {
        const res = await cleanupStaleTaskWorktrees(t.id);

        expect(res.removedDirs).toEqual([]);
        expect(res.snapshots).toHaveLength(1);
        expect(res.kept).toHaveLength(1);
        expect(res.kept[0].snapshotSaved).toBe(true);
        expect(res.kept[0].reason).toContain("删除目录失败");
        const text = buildStaleForceDescription(res.kept);
        expect(text).not.toContain("找不回");
        expect(text).toContain("已存成快照");
      } finally {
        await fs.chmod(locked, 0o755).catch(() => {});
      }
    },
    60_000,
  );

  it("buildStaleForceDescription：没存下的仍说「找不回」（旧口径不变）；混合时按未存下的口径", () => {
    const unsaved = buildStaleForceDescription([{ dirName: "a", reason: "嵌套仓" }]);
    expect(unsaved).toContain("找不回");
    expect(unsaved).not.toContain("已存成快照");
    const mixed = buildStaleForceDescription([
      { dirName: "a", reason: "嵌套仓" },
      { dirName: "b", reason: "删除目录失败：EACCES", snapshotSaved: true },
    ]);
    expect(mixed).toContain("找不回");
    expect(mixed).toContain("· b：删除目录失败：EACCES（改动已存成快照）");
    const saved = buildStaleForceDescription([{ dirName: "b", reason: "删除目录失败", snapshotSaved: true }]);
    expect(saved).not.toContain("找不回");
  });
});

describe("Q3-10(d)：目录删不掉不能报「已清理」（removeTaskWorktrees）", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "只读子目录挡住删除：removedAny=false、记进 snapshotFailures（原因说明快照已落）；对照：删得掉时 removedAny=true、无失败",
    async () => {
      const { repo, t, wd } = await setupTask("rm-stuck");
      const locked = path.join(wd, "locked");
      await fs.mkdir(locked, { recursive: true });
      await fs.writeFile(path.join(locked, "x.txt"), "x\n");
      await fs.chmod(locked, 0o555);
      try {
        const removed = await removeTaskWorktrees(t);

        expect(await exists(wd)).toBe(true);
        expect(removed.removedAny).toBe(false);
        expect(removed.snapshotFailedRepos).toEqual([repo]);
        expect(removed.snapshotFailures![0].reason).toContain("没能删掉");
        expect(removed.snapshotFailures![0].reason).toContain("已存到 refs/flowship/wip/");
        expect(removed.snapshotRepos).toEqual([repo]); // 快照确实落了
      } finally {
        await fs.chmod(locked, 0o755).catch(() => {});
      }
    },
    60_000,
  );

  it("对照：能删掉的 worktree → removedAny=true、没有失败项", async () => {
    const { t, wd } = await setupTask("rm-ok");
    const removed = await removeTaskWorktrees(t);
    expect(removed.removedAny).toBe(true);
    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(await exists(wd)).toBe(false);
  }, 60_000);
});

describe("Q3-13②：删除失败文案不叠前缀", () => {
  it("服务端原话已带「删除失败：」→ 原样；裸原因 → 补前缀；空 → 兜底", async () => {
    const { withDeleteFailurePrefix } = await import("@/lib/worktree-report");
    expect(withDeleteFailurePrefix("删除失败：目录被占用。任务没有被删除，可以稍后重试")).toBe(
      "删除失败：目录被占用。任务没有被删除，可以稍后重试",
    );
    expect(withDeleteFailurePrefix("EACCES: permission denied")).toBe("删除失败：EACCES: permission denied");
    expect(withDeleteFailurePrefix("目录仍未能清理，请稍后重试")).toBe("删除失败：目录仍未能清理，请稍后重试");
    expect(withDeleteFailurePrefix("  ")).toBe("删除失败");
  });
});
