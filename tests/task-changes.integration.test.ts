/**
 * task 代码改动预览：真 git 端到端（临时目录里真建主仓 + 隔离 worktree）
 *
 * 复现 task 模式的真实形态：主仓在 main，任务在带空格的 worktree 目录里、跑在 feature 分支上；
 * 里面同时有「已提交 / 暂存 / 未暂存 / 重命名 / 删除 / 二进制 / 未跟踪 / 被 ignore / 中文文件名」。
 *
 * 断言我们自己算出来的结构（路径 / 状态 / 行数 / 基线），不依赖任何 git 报错文案。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "@/lib/tool-display";
import {
  parseNameStatusZ,
  parseNumstatZ,
  readTaskChangeFileDiff,
  readTaskChanges,
  resolveChangeRepoTargets,
  sanitizeRepoRelPath,
  type TaskChangesTaskLike,
} from "@/lib/server/task-changes";

// 在 git hook 里跑测试时这些变量会指向「外层仓」，让测试里的 git 命令全跑偏
const LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

// macOS 的 tmpdir 在 /var → /private/var 的软链下，git 吐的是真实路径，统一取 realpath
const TMP = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "flowship-changes-it-")),
);
const REPO = path.join(TMP, "main-repo");
/** 路径带空格：任务隔离工作区就在 `Application Support` 下，必须覆盖 */
const WT = path.join(TMP, "wt a", "feature-x");
const OUTSIDE = path.join(TMP, "outside-secret.txt");
const PLAIN_DIR = path.join(TMP, "plain-dir");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const write = (dir: string, rel: string, content: string | Buffer) => {
  const abs = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

const sha1File = (p: string) =>
  createHash("sha1").update(fs.readFileSync(p)).digest("hex");

/** 任务形状：隔离 worktree 任务（workCwd = WT） */
const isolatedTask = (over?: Partial<TaskChangesTaskLike>): TaskChangesTaskLike => ({
  mode: "task",
  repoPaths: [REPO],
  workCwd: WT,
  isolateWorktree: true,
  repoBaseBranches: { [REPO]: "main" },
  ...over,
});

let baseShortSha = "";

beforeAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q");
  git(REPO, "symbolic-ref", "HEAD", "refs/heads/main");
  git(REPO, "config", "user.email", "t@example.com");
  git(REPO, "config", "user.name", "tester");

  write(REPO, ".gitignore", "ignored.env\n");
  write(REPO, "keep.txt", "a\nb\nc\n");
  write(REPO, "rename-me.txt", "old\nold2\nold3\n");
  write(REPO, "del.txt", "x\n");
  write(REPO, "bin.dat", Buffer.from([0, 1, 2]));
  write(REPO, "中文 空格.txt", "hi\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", "base");
  baseShortSha = git(REPO, "rev-parse", "HEAD").slice(0, 7);

  // 任务 worktree：feature/x，路径带空格
  fs.mkdirSync(path.dirname(WT), { recursive: true });
  git(REPO, "worktree", "add", "-q", "-b", "feature/x", WT, "main");

  // 1) 已提交的改动（也算「本任务的改动」）
  write(WT, "keep.txt", "a\nB\nc\nd\n");
  git(WT, "add", "keep.txt");
  git(WT, "commit", "-q", "-m", "task commit");

  // 2) 暂存的重命名 + 改动
  git(WT, "mv", "rename-me.txt", "renamed.txt");
  write(WT, "renamed.txt", "old\nold2\nold3\nnew\n");
  // 3) 未暂存：删除 / 二进制修改 / 中文文件名修改
  fs.rmSync(path.join(WT, "del.txt"));
  write(WT, "bin.dat", Buffer.from([0, 9]));
  write(WT, "中文 空格.txt", "hi2\n");
  // 4) 未跟踪：普通 / 深目录 / 二进制 / 空文件 / 无结尾换行 / 被 ignore
  write(WT, "new-file.txt", "n1\nn2\nn3\n");
  write(WT, "sub/dir/deep.txt", "deep\n");
  write(WT, "blob.bin", Buffer.from([0, 0, 1, 2]));
  write(WT, "empty.txt", "");
  write(WT, "no-newline.txt", "tail");
  write(WT, "ignored.env", "SECRET=hunter2\n");

  // 仓外的敏感文件 + 指向它的未跟踪符号链接
  fs.writeFileSync(OUTSIDE, "TOP-SECRET-OUTSIDE\n");
  if (process.platform !== "win32") fs.symlinkSync(OUTSIDE, path.join(WT, "link-out"));

  fs.mkdirSync(PLAIN_DIR, { recursive: true });
}, 60_000);

afterAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("纯函数：解析 git -z 输出", () => {
  it("parseNameStatusZ：增删改 + 重命名（两个路径）", () => {
    const out = ["M", "a.txt", "D", "b.txt", "A", "c.txt", "R077", "old.txt", "new.txt", "T", "t.txt", ""].join("\0");
    expect(parseNameStatusZ(out)).toEqual([
      { status: "modified", path: "a.txt" },
      { status: "deleted", path: "b.txt" },
      { status: "added", path: "c.txt" },
      { status: "renamed", path: "new.txt", oldPath: "old.txt" },
      { status: "modified", path: "t.txt" },
    ]);
  });

  it("parseNameStatusZ：残缺输入不抛、不造假条目", () => {
    expect(parseNameStatusZ("")).toEqual([]);
    expect(parseNameStatusZ(["R100", "only-old", ""].join("\0"))).toEqual([]);
  });

  it("parseNumstatZ：普通 / 二进制 / 重命名（路径段为空）/ 路径含空格和中文", () => {
    const out = [
      "2\t1\ta.txt",
      "-\t-\tbin.dat",
      "1\t0\t",
      "old.txt",
      "new.txt",
      "1\t1\t中文 空格.txt",
      "",
    ].join("\0");
    const m = parseNumstatZ(out);
    expect(m.get("a.txt")).toEqual({ added: 2, removed: 1, binary: false });
    expect(m.get("bin.dat")).toEqual({ added: null, removed: null, binary: true });
    expect(m.get("new.txt")).toEqual({ added: 1, removed: 0, binary: false });
    expect(m.has("old.txt")).toBe(false);
    expect(m.get("中文 空格.txt")).toEqual({ added: 1, removed: 1, binary: false });
  });

  it("sanitizeRepoRelPath：只放行仓内相对路径", () => {
    expect(sanitizeRepoRelPath("src/a.ts")).toBe("src/a.ts");
    expect(sanitizeRepoRelPath("中文 空格.txt")).toBe("中文 空格.txt");
    for (const bad of ["", "../x", "a/../../x", "/etc/passwd", "C:\\x", "C:/x", "a\\..\\x", "./a", "a//b", "a\0b"]) {
      expect(sanitizeRepoRelPath(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(sanitizeRepoRelPath(null)).toBeNull();
  });
});

describe("resolveChangeRepoTargets", () => {
  it("隔离 task：workDir = worktree、isolated = true", () => {
    expect(resolveChangeRepoTargets(isolatedTask())).toEqual([
      { repoPath: REPO, shortName: "main-repo", workDir: WT, isolated: true },
    ]);
  });

  it("chat 也能看（直接看用户选的工作目录、永远不算隔离）；未启动（无 workCwd）/ 无仓：没有可看的仓", () => {
    // chat 不会有隔离 worktree：即使数据里残留 isolateWorktree，也按「就在原目录里改」处理
    expect(resolveChangeRepoTargets(isolatedTask({ mode: "chat" }))).toEqual([
      { repoPath: REPO, shortName: "main-repo", workDir: WT, isolated: false },
    ]);
    expect(resolveChangeRepoTargets(isolatedTask({ mode: "chat", workCwd: undefined }))).toEqual([]);
    expect(resolveChangeRepoTargets(isolatedTask({ mode: "chat", repoPaths: [] }))).toEqual([]);
    expect(resolveChangeRepoTargets(isolatedTask({ workCwd: undefined }))).toEqual([]);
    expect(resolveChangeRepoTargets(isolatedTask({ repoPaths: [] }))).toEqual([]);
  });

  it("非 git / 只读仓被剔掉", () => {
    expect(resolveChangeRepoTargets(isolatedTask({ nonGitRepoPaths: [REPO] }))).toEqual([]);
    expect(resolveChangeRepoTargets(isolatedTask({ readonlyRepoPaths: [REPO] }))).toEqual([]);
  });
});

describe("readTaskChanges：隔离 worktree 任务", () => {
  it("基线 = 与线上分支的分叉点；分支名、仓信息正确", async () => {
    const { repos } = await readTaskChanges(isolatedTask());
    expect(repos).toHaveLength(1);
    const repo = repos[0];
    expect(repo.unavailable).toBeUndefined();
    expect(repo.branch).toBe("feature/x");
    expect(repo.isolated).toBe(true);
    expect(repo.base).toEqual({ kind: "merge-base", label: "main", shortSha: baseShortSha });
  });

  it("清单覆盖已提交 / 暂存 / 未暂存 / 重命名 / 删除 / 二进制 / 未跟踪，且排除被 ignore 的文件", async () => {
    const { repos } = await readTaskChanges(isolatedTask());
    const byPath = new Map(repos[0].files.map((f) => [f.path, f]));

    // 已提交的改动：basline 之后的提交也算（keep.txt：b→B、新增 d）
    expect(byPath.get("keep.txt")).toMatchObject({
      status: "modified", added: 2, removed: 1, binary: false, untracked: false,
    });
    // 重命名：新路径为主、带 oldPath
    expect(byPath.get("renamed.txt")).toMatchObject({
      status: "renamed", oldPath: "rename-me.txt", added: 1, removed: 0,
    });
    expect(byPath.has("rename-me.txt")).toBe(false);
    expect(byPath.get("del.txt")).toMatchObject({ status: "deleted", added: 0, removed: 1 });
    expect(byPath.get("bin.dat")).toMatchObject({ status: "modified", binary: true, added: null });
    // 中文 + 空格文件名没被 git 转义成 "\344\270..."
    expect(byPath.get("中文 空格.txt")).toMatchObject({ status: "modified", added: 1, removed: 1 });

    // 未跟踪：补进清单、按新增算、行数是我们数出来的
    expect(byPath.get("new-file.txt")).toMatchObject({
      status: "added", untracked: true, added: 3, removed: 0,
    });
    expect(byPath.get("sub/dir/deep.txt")).toMatchObject({ untracked: true, added: 1 });
    expect(byPath.get("blob.bin")).toMatchObject({ untracked: true, binary: true, added: null });
    expect(byPath.get("empty.txt")).toMatchObject({ untracked: true, added: 0 });
    expect(byPath.get("no-newline.txt")).toMatchObject({ untracked: true, added: 1 });

    // 被 ignore 的文件绝不出现
    expect(byPath.has("ignored.env")).toBe(false);
    // 文件绝对路径是 worktree 内的真实路径
    expect(byPath.get("keep.txt")!.absolutePath).toBe(path.join(WT, "keep.txt"));
  });

  it("清单按路径排序；totals 与逐文件之和一致", async () => {
    const { repos, totals } = await readTaskChanges(isolatedTask());
    const files = repos[0].files;
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(repos[0].totals.files).toBe(files.length);
    expect(repos[0].totals.added).toBe(files.reduce((n, f) => n + (f.added ?? 0), 0));
    expect(repos[0].totals.removed).toBe(files.reduce((n, f) => n + (f.removed ?? 0), 0));
    expect(totals).toEqual(repos[0].totals);
  });

  it("只读：读清单 / 读 diff 之后 worktree 的 index 文件字节不变（不 git add -N、不刷新 index）", async () => {
    const indexPath = path.resolve(WT, git(WT, "rev-parse", "--git-path", "index"));
    const before = sha1File(indexPath);
    await readTaskChanges(isolatedTask());
    await readTaskChangeFileDiff(isolatedTask(), REPO, "new-file.txt");
    await readTaskChangeFileDiff(isolatedTask(), REPO, "keep.txt");
    expect(sha1File(indexPath)).toBe(before);
  });
});

describe("readTaskChanges：降级 / 异常形态", () => {
  it("找不到线上分支 → 基线降级成 HEAD（只含未提交改动），非隔离标记 isolated=false", async () => {
    // 直接在主仓上做（模拟「日常轻量任务」：无隔离、无线上分支配置）
    write(REPO, "keep.txt", "a\nb\nc\nlocal\n");
    try {
      const { repos } = await readTaskChanges({
        mode: "task",
        repoPaths: [REPO],
        workCwd: REPO,
        isolateWorktree: false,
      });
      const repo = repos[0];
      expect(repo.isolated).toBe(false);
      expect(repo.base?.kind).toBe("head");
      expect(repo.base?.label).toBe("HEAD");
      expect(repo.files.map((f) => f.path)).toEqual(["keep.txt"]);
      expect(repo.files[0]).toMatchObject({ status: "modified", added: 1, removed: 0 });
    } finally {
      git(REPO, "checkout", "--", "keep.txt");
    }
  });

  it("task.gitBranches 里记录的 baseBranch 优先于设置页快照", async () => {
    // 设置页快照故意写成不存在的分支；gitBranches 记录的 main 应当胜出
    const { repos } = await readTaskChanges(
      isolatedTask({
        repoBaseBranches: { [REPO]: "no-such-branch" },
        gitBranches: [{ repoPath: REPO, baseBranch: "main" }],
      }),
    );
    expect(repos[0].base).toMatchObject({ kind: "merge-base", label: "main" });
  });

  it("非法的线上分支名（`-` 开头 / 含 ..）被忽略、不会被当 git 选项", async () => {
    const { repos } = await readTaskChanges(
      isolatedTask({ repoBaseBranches: { [REPO]: "--output=/tmp/pwned" } }),
    );
    expect(repos[0].base?.kind).toBe("head");
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
  });

  it("工作目录不存在 → dir_missing（任务未启动 / 已清理）", async () => {
    const { repos } = await readTaskChanges(
      isolatedTask({ workCwd: path.join(TMP, "gone", "nope") }),
    );
    expect(repos[0].unavailable).toBe("dir_missing");
    expect(repos[0].files).toEqual([]);
    expect(repos[0].totals).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it("目录存在但不是 git 仓 → not_git", async () => {
    const { repos } = await readTaskChanges(isolatedTask({ workCwd: PLAIN_DIR }));
    expect(repos[0].unavailable).toBe("not_git");
  });
});

/** 非隔离任务：直接在这个原仓里干活（路径带空格）、当前在哪个分支就展示哪个 */
const DIRECT = path.join(TMP, "direct repo");

const directTask = (over?: Partial<TaskChangesTaskLike>): TaskChangesTaskLike => ({
  mode: "task",
  repoPaths: [DIRECT],
  workCwd: DIRECT,
  isolateWorktree: false,
  repoBaseBranches: { [DIRECT]: "main" },
  ...over,
});

describe("readTaskChanges：非隔离任务（直接在原仓、按当前分支展示）", () => {
  let mainShortSha = "";

  beforeAll(() => {
    fs.mkdirSync(DIRECT, { recursive: true });
    git(DIRECT, "init", "-q");
    git(DIRECT, "symbolic-ref", "HEAD", "refs/heads/main");
    git(DIRECT, "config", "user.email", "t@example.com");
    git(DIRECT, "config", "user.name", "tester");
    write(DIRECT, "base.txt", "1\n2\n3\n");
    write(DIRECT, "shared.txt", "s\n");
    git(DIRECT, "add", "-A");
    git(DIRECT, "commit", "-q", "-m", "base");
    mainShortSha = git(DIRECT, "rev-parse", "HEAD").slice(0, 7);

    // feat/a：任务开始前这个分支上就已经有的提交
    git(DIRECT, "checkout", "-q", "-b", "feat/a");
    write(DIRECT, "a-pre.txt", "pre\n");
    write(DIRECT, "base.txt", "1\n2\n3\n4\n");
    git(DIRECT, "add", "-A");
    git(DIRECT, "commit", "-q", "-m", "pre-existing on feat/a");

    // feat/b：另一个分支，只有自己的提交
    git(DIRECT, "checkout", "-q", "-b", "feat/b", "main");
    write(DIRECT, "b-only.txt", "b\n");
    git(DIRECT, "add", "-A");
    git(DIRECT, "commit", "-q", "-m", "only on feat/b");

    git(DIRECT, "checkout", "-q", "feat/a");
  }, 60_000);

  const pathsOf = (r: { files: Array<{ path: string }> }) => r.files.map((f) => f.path);

  it("展示当前分支的整体改动：分支上已有的提交 + 未提交 + 未跟踪，基线是与线上分支的分叉点", async () => {
    write(DIRECT, "base.txt", "1\n2\n3\n4\n5\n"); // 在已提交的「4」之上又加一行、未提交
    write(DIRECT, "untracked.txt", "u\n");
    try {
      const { repos } = await readTaskChanges(directTask());
      const repo = repos[0];
      expect(repo.unavailable).toBeUndefined();
      expect(repo.isolated).toBe(false);
      expect(repo.branch).toBe("feat/a");
      expect(repo.base).toEqual({ kind: "merge-base", label: "main", shortSha: mainShortSha });
      expect(repo.onBaseBranch).toBeUndefined();

      expect(pathsOf(repo)).toEqual(["a-pre.txt", "base.txt", "untracked.txt"]);
      const byPath = new Map(repo.files.map((f) => [f.path, f]));
      // 任务开始前就已提交的文件也在（这就是「分支整体改动」的含义）
      expect(byPath.get("a-pre.txt")).toMatchObject({ status: "added", added: 1, untracked: false });
      // 已提交的「4」+ 未提交的「5」合并成一个净改动
      expect(byPath.get("base.txt")).toMatchObject({ status: "modified", added: 2, removed: 0 });
      expect(byPath.get("untracked.txt")).toMatchObject({ status: "added", untracked: true, added: 1 });
    } finally {
      git(DIRECT, "reset", "-q", "--hard");
      git(DIRECT, "clean", "-fdq");
    }
  });

  it("任务中途切分支：同一个 task 再读，清单跟着当前分支走（不依赖任何快照）", async () => {
    const task = directTask();
    try {
      const onA = (await readTaskChanges(task)).repos[0];
      expect(onA.branch).toBe("feat/a");
      expect(pathsOf(onA)).toEqual(["a-pre.txt", "base.txt"]);

      git(DIRECT, "checkout", "-q", "feat/b");
      const onB = (await readTaskChanges(task)).repos[0];
      expect(onB.branch).toBe("feat/b");
      expect(onB.base).toMatchObject({ kind: "merge-base", label: "main", shortSha: mainShortSha });
      // feat/a 上的提交一个都不能串过来
      expect(pathsOf(onB)).toEqual(["b-only.txt"]);

      // 单文件 diff 也读当前分支
      const diff = await readTaskChangeFileDiff(task, DIRECT, "b-only.txt");
      expect(diff.ok).toBe(true);
      if (diff.ok) expect(diff.data.diff).toContain("+b");
      const stale = await readTaskChangeFileDiff(task, DIRECT, "a-pre.txt");
      expect(stale.ok && stale.data.diff).toBe("");
    } finally {
      git(DIRECT, "checkout", "-q", "feat/a");
    }
  });

  it("当前就在线上分支本身：只显示未提交改动，并标 onBaseBranch", async () => {
    git(DIRECT, "checkout", "-q", "main");
    write(DIRECT, "shared.txt", "s\nlocal\n");
    try {
      const repo = (await readTaskChanges(directTask())).repos[0];
      expect(repo.branch).toBe("main");
      expect(repo.onBaseBranch).toBe(true);
      expect(repo.base).toMatchObject({ kind: "merge-base", label: "main" });
      // feat/a / feat/b 的提交都不在 main 上，只剩这一处未提交
      expect(pathsOf(repo)).toEqual(["shared.txt"]);
      expect(repo.files[0]).toMatchObject({ status: "modified", added: 1, removed: 0 });
    } finally {
      git(DIRECT, "reset", "-q", "--hard");
      git(DIRECT, "checkout", "-q", "feat/a");
    }
  });

  it("新切出、还没有提交的分支不算「在线上分支上」：按名字判断、不按 sha", async () => {
    git(DIRECT, "checkout", "-q", "-b", "feat/fresh", "main");
    try {
      const repo = (await readTaskChanges(directTask())).repos[0];
      expect(repo.branch).toBe("feat/fresh");
      expect(repo.onBaseBranch).toBeUndefined();
      expect(repo.base?.kind).toBe("merge-base");
      expect(repo.files).toEqual([]);
    } finally {
      git(DIRECT, "checkout", "-q", "feat/a");
      git(DIRECT, "branch", "-q", "-D", "feat/fresh");
    }
  });

  it("游离 HEAD：branch = null，仍按与线上分支的分叉点算", async () => {
    git(DIRECT, "checkout", "-q", "--detach", "feat/a");
    try {
      const repo = (await readTaskChanges(directTask())).repos[0];
      expect(repo.unavailable).toBeUndefined();
      expect(repo.branch).toBeNull();
      expect(repo.base).toMatchObject({ kind: "merge-base", label: "main", shortSha: mainShortSha });
      expect(repo.onBaseBranch).toBeUndefined();
      expect(pathsOf(repo)).toEqual(["a-pre.txt", "base.txt"]);
    } finally {
      git(DIRECT, "checkout", "-q", "feat/a");
    }
  });
});

describe("readTaskChangeFileDiff", () => {
  const diffOf = async (file: string, oldPath?: string) => {
    const r = await readTaskChangeFileDiff(isolatedTask(), REPO, file, oldPath);
    if (!r.ok) throw new Error(`期望成功，实际 ${r.status}：${r.error}`);
    return r.data;
  };

  it("已跟踪文件：相对基线的净 diff（含已提交的部分）", async () => {
    const d = await diffOf("keep.txt");
    expect(d.binary).toBe(false);
    const lines = parseUnifiedDiff(d.diff);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["B", "d"]);
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["b"]);
  });

  it("重命名：传 oldPath 才能看到「改名 + 改内容」的真实 diff", async () => {
    const d = await diffOf("renamed.txt", "rename-me.txt");
    const adds = parseUnifiedDiff(d.diff).filter((l) => l.kind === "add");
    expect(adds.map((l) => l.text)).toEqual(["new"]);
  });

  it("已删除文件：diff 全是删除行", async () => {
    const d = await diffOf("del.txt");
    const lines = parseUnifiedDiff(d.diff);
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["x"]);
    expect(lines.some((l) => l.kind === "add")).toBe(false);
  });

  it("中文 + 空格文件名可读", async () => {
    const d = await diffOf("中文 空格.txt");
    const lines = parseUnifiedDiff(d.diff);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["hi2"]);
  });

  it("未跟踪文件：合成全新增 diff，行号从 1 起，解析层吃得下", async () => {
    const d = await diffOf("new-file.txt");
    expect(d.diff).toContain("+++ b/new-file.txt");
    expect(d.diff).toContain("@@ -0,0 +1,3 @@");
    const lines = parseUnifiedDiff(d.diff).filter((l) => l.kind === "add");
    expect(lines.map((l) => l.text)).toEqual(["n1", "n2", "n3"]);
    expect(lines.map((l) => l.newLine)).toEqual([1, 2, 3]);
  });

  it("未跟踪文件：无结尾换行有标注、空文件没有 hunk、深目录可读", async () => {
    expect((await diffOf("no-newline.txt")).diff).toContain("\\ No newline at end of file");
    const empty = await diffOf("empty.txt");
    expect(empty.diff).not.toContain("@@");
    expect(empty.binary).toBe(false);
    expect(parseUnifiedDiff((await diffOf("sub/dir/deep.txt")).diff).filter((l) => l.kind === "add")).toHaveLength(1);
  });

  it("二进制（已跟踪 / 未跟踪）：只给 binary 标志、不给内容", async () => {
    expect(await diffOf("bin.dat")).toMatchObject({ binary: true, diff: "" });
    expect(await diffOf("blob.bin")).toMatchObject({ binary: true, diff: "" });
  });

  it("被 ignore 的文件读不出内容（不能借接口读 .env）", async () => {
    const r = await readTaskChangeFileDiff(isolatedTask(), REPO, "ignored.env");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.diff).toBe("");
      expect(JSON.stringify(r.data)).not.toContain("hunter2");
    }
  });

  it.skipIf(process.platform === "win32")(
    "未跟踪的符号链接：只展示链接目标本身，不跟随读仓外文件",
    async () => {
      const d = await diffOf("link-out");
      expect(d.diff).toContain(OUTSIDE);
      expect(d.diff).not.toContain("TOP-SECRET-OUTSIDE");
    },
  );

  it("路径逃逸 / 绝对路径 → 400；不在任务范围的仓 → 404", async () => {
    for (const bad of ["../outside-secret.txt", "a/../../x", OUTSIDE, "/etc/passwd"]) {
      const r = await readTaskChangeFileDiff(isolatedTask(), REPO, bad);
      expect(r, bad).toMatchObject({ ok: false, status: 400 });
    }
    const badOld = await readTaskChangeFileDiff(isolatedTask(), REPO, "keep.txt", "../x");
    expect(badOld).toMatchObject({ ok: false, status: 400 });
    const otherRepo = await readTaskChangeFileDiff(isolatedTask(), PLAIN_DIR, "keep.txt");
    expect(otherRepo).toMatchObject({ ok: false, status: 404 });
  });

  it("pathspec 魔法按字面处理（文件名以 ':' 开头不会被当成 pathspec 语法）", async () => {
    const r = await readTaskChangeFileDiff(isolatedTask(), REPO, ":(glob)**/*.txt");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.data.diff).toBe("");
  });

  it("文件 diff 超过字节上限：按行截断并标记 truncated", async () => {
    const big = Array.from({ length: 30_000 }, (_, i) => `line-${i}-${"x".repeat(20)}`).join("\n") + "\n";
    write(WT, "huge-untracked.txt", big);
    try {
      const d = await diffOf("huge-untracked.txt");
      expect(d.truncated).toBe(true);
      expect(Buffer.byteLength(d.diff, "utf8")).toBeLessThanOrEqual(400 * 1024 + 4096);
      // 没有切半行：每个 + 行都是完整的 line-N-xxxx
      const adds = parseUnifiedDiff(d.diff).filter((l) => l.kind === "add");
      expect(adds.length).toBeGreaterThan(1000);
      expect(adds.every((l) => /^line-\d+-x{20}$/.test(l.text))).toBe(true);
    } finally {
      fs.rmSync(path.join(WT, "huge-untracked.txt"));
    }
  });
});
