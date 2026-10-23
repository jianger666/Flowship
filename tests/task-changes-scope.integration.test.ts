/**
 * 代码改动面板升级：chat 放开 + 范围（scope）+ 忽略空白 + 展开上下文 + 手动基线 + ahead/behind
 * ——全部用真 git 在临时目录里端到端验证（不 mock git）。
 *
 * 主场景 WORK（路径带空格，模拟 chat 直接在用户仓里干活）：
 *   origin/main(base) ← feature/chat：c1 改 a.txt、c2 改 b.txt + 新增 c.txt
 *   再叠加未提交：a.txt 第二处、暂存的纯缩进改动 ws.txt、缩进 + 实质改动 mixed.txt、big.txt、
 *   未跟踪 u.txt / 符号链接 link-out、被 ignore 的 ignored.env
 *
 * 断言我们自己算出来的结构（路径 / 状态 / 行数 / 基线 / 范围），不依赖任何 git 报错文案。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendChangesQuery,
  formatChangeScope,
  normalizeBaseRefParam,
  parseChangeScope,
  parseChangesQuery,
  sameChangeScope,
} from "@/lib/changes/scope";
import {
  MAX_COMMITS,
  parseCommitLog,
  parseLeftRightCount,
  readRepoChanges,
  readTaskChangeCommits,
  readTaskChangeFileDiff,
  readTaskChanges,
  resolveChangeRepoTargets,
  type ReadChangesOptions,
  type TaskChangesTaskLike,
} from "@/lib/server/task-changes";
import type { TaskChangeFile, TaskRepoChanges } from "@/lib/types";

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
  fs.mkdtempSync(path.join(os.tmpdir(), "flowship-changes-scope-")),
);
const ORIGIN = path.join(TMP, "origin.git");
const SEED = path.join(TMP, "seed");
/** 路径带空格：用户的工作目录完全可能这样 */
const WORK = path.join(TMP, "work space");
const LOCAL_ONLY = path.join(TMP, "local-only");
const SWITCH = path.join(TMP, "switch-repo");
const BEHIND = path.join(TMP, "behind-repo");
const PLAIN_DIR = path.join(TMP, "plain-dir");
const OUTSIDE = path.join(TMP, "outside-secret.txt");

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

const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n") + "\n";

const replaceLine = (dir: string, rel: string, n: number, text: string) => {
  const abs = path.join(dir, ...rel.split("/"));
  const ls = fs.readFileSync(abs, "utf8").split("\n");
  ls[n - 1] = text;
  fs.writeFileSync(abs, ls.join("\n"));
};

const initRepo = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "tester");
};

const commitAll = (dir: string, msg: string): string => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
};

/** chat 会话形状：没有任何线上分支配置，只有用户选的工作目录 */
const chatTask = (
  dir: string = WORK,
  over?: Partial<TaskChangesTaskLike>,
): TaskChangesTaskLike => ({
  mode: "chat",
  repoPaths: [dir],
  workCwd: dir,
  ...over,
});

/** 同一个目录当 task 用（非隔离、也没有任何线上分支配置） */
const bareTask = (dir: string): TaskChangesTaskLike => ({
  mode: "task",
  repoPaths: [dir],
  workCwd: dir,
});

const readOne = async (
  task: TaskChangesTaskLike,
  opts: ReadChangesOptions = {},
): Promise<TaskRepoChanges> => {
  const { repos } = await readTaskChanges(task, opts);
  expect(repos).toHaveLength(1);
  return repos[0];
};

const byPath = (r: TaskRepoChanges): Map<string, TaskChangeFile> =>
  new Map(r.files.map((f) => [f.path, f]));

const pathsOf = (r: TaskRepoChanges): string[] => r.files.map((f) => f.path).sort();

const HAS_SYMLINK = process.platform !== "win32";

let baseSha = "";
let c1 = "";
let c2 = "";
/** 不在当前分支上的悬空提交（对象库里有、但不是 HEAD 的祖先） */
let strayCommit = "";

beforeAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  // ---- 远端 + 种子仓 + 工作仓（clone 得到 origin/HEAD → origin/main）----
  fs.mkdirSync(ORIGIN, { recursive: true });
  git(ORIGIN, "init", "--bare", "-q");
  git(ORIGIN, "symbolic-ref", "HEAD", "refs/heads/main");

  initRepo(SEED);
  write(SEED, ".gitignore", "ignored.env\n");
  write(SEED, "a.txt", lines("a", 20));
  write(SEED, "b.txt", "b1\nb2\nb3\n");
  write(SEED, "keep.txt", "k\n");
  write(SEED, "ws.txt", "function f() {\n  return 1;\n}\n");
  write(SEED, "mixed.txt", "x = 1\n  y = 2\nz = 3\n");
  write(SEED, "big.txt", lines("line", 100));
  baseSha = commitAll(SEED, "base");
  git(SEED, "remote", "add", "origin", ORIGIN);
  git(SEED, "push", "-q", "origin", "main");

  git(TMP, "clone", "-q", ORIGIN, WORK);
  git(WORK, "config", "user.email", "t@example.com");
  git(WORK, "config", "user.name", "tester");
  git(WORK, "checkout", "-q", "-b", "feature/chat");

  // 已提交的两个提交
  replaceLine(WORK, "a.txt", 5, "A5");
  c1 = commitAll(WORK, "feat: tweak a");
  write(WORK, "b.txt", "b1\nb2\nb3\nb4\n");
  write(WORK, "c.txt", "c1\n");
  c2 = commitAll(WORK, "feat: add c and extend b");

  // 悬空提交：以分叉点的 tree 造一个不在任何分支上的提交
  const tree = git(WORK, "rev-parse", `${baseSha}^{tree}`);
  strayCommit = git(WORK, "commit-tree", tree, "-p", baseSha, "-m", "stray");

  // 未提交：未暂存 / 暂存 / 未跟踪 / ignore / 仓外符号链接
  replaceLine(WORK, "a.txt", 15, "A15");
  write(WORK, "ws.txt", "function f() {\n    return 1;\n}\n");
  git(WORK, "add", "ws.txt");
  write(WORK, "mixed.txt", "x = 1\n      y = 22\nz = 3\n");
  replaceLine(WORK, "big.txt", 50, "LINE50");
  write(WORK, "u.txt", "u1\nu2\n");
  write(WORK, "ignored.env", "SECRET=hunter2\n");
  fs.writeFileSync(OUTSIDE, "TOP-SECRET-OUTSIDE\n");
  if (HAS_SYMLINK) fs.symlinkSync(OUTSIDE, path.join(WORK, "link-out"));

  // ---- 只有本地 main 的仓（没有任何远端）：测 chat 兜底探测 / task 降级 ----
  initRepo(LOCAL_ONLY);
  write(LOCAL_ONLY, "f.txt", "f\n");
  commitAll(LOCAL_ONLY, "init");
  git(LOCAL_ONLY, "checkout", "-q", "-b", "feat/x");
  write(LOCAL_ONLY, "g.txt", "g\n");
  commitAll(LOCAL_ONLY, "feat: g");

  // ---- 切分支跟随 ----
  initRepo(SWITCH);
  write(SWITCH, "root.txt", "r\n");
  commitAll(SWITCH, "init");

  // ---- main 领先 feat：测 behind ----
  initRepo(BEHIND);
  write(BEHIND, "root.txt", "r\n");
  commitAll(BEHIND, "init");
  git(BEHIND, "checkout", "-q", "-b", "feat/y");
  write(BEHIND, "y1.txt", "1\n");
  commitAll(BEHIND, "y1");
  write(BEHIND, "y2.txt", "2\n");
  commitAll(BEHIND, "y2");
  git(BEHIND, "checkout", "-q", "main");
  write(BEHIND, "m1.txt", "m\n");
  commitAll(BEHIND, "main moves on");
  git(BEHIND, "checkout", "-q", "feat/y");

  fs.mkdirSync(PLAIN_DIR, { recursive: true });
}, 60_000);

afterAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ======================================================================
// chat：以「当前分支」为准
// ======================================================================

describe("chat：以当前分支相对线上分支的变更为准", () => {
  it("目标目录 = 用户选的工作目录、永远不算隔离", () => {
    expect(resolveChangeRepoTargets(chatTask())).toEqual([
      { repoPath: WORK, shortName: "work space", workDir: WORK, isolated: false },
    ]);
  });

  it("基线 = origin/HEAD 指向的线上分支（远端引用优先）；带 ahead / behind、范围回显", async () => {
    const r = await readOne(chatTask());
    expect(r.unavailable).toBeUndefined();
    expect(r.branch).toBe("feature/chat");
    expect(r.isolated).toBe(false);
    expect(r.scope).toBe("branch");
    expect(r.base).toEqual({
      kind: "merge-base",
      label: "origin/main",
      shortSha: baseSha.slice(0, 7),
    });
    expect(r.aheadOfBase).toBe(2);
    expect(r.behindBase).toBe(0);
    expect(r.baseOverride).toBeUndefined();
    expect(r.onBaseBranch).toBeUndefined();
  });

  it("整条分支 = 已提交 + 暂存 + 未暂存 + 未跟踪；被 ignore 的不出现", async () => {
    const r = await readOne(chatTask());
    const m = byPath(r);
    const expected = ["a.txt", "b.txt", "big.txt", "c.txt", "mixed.txt", "u.txt", "ws.txt"];
    if (HAS_SYMLINK) expected.push("link-out");
    expect(pathsOf(r)).toEqual(expected.sort());

    // a.txt：c1 改了第 5 行、工作区又改了第 15 行 → 相对分叉点共 2 增 2 删
    expect(m.get("a.txt")).toMatchObject({ status: "modified", added: 2, removed: 2, untracked: false });
    expect(m.get("b.txt")).toMatchObject({ status: "modified", added: 1, removed: 0 });
    expect(m.get("c.txt")).toMatchObject({ status: "added", added: 1, removed: 0 });
    expect(m.get("u.txt")).toMatchObject({ status: "added", added: 2, removed: 0, untracked: true });
    expect(m.has("ignored.env")).toBe(false);
    expect(m.get("ws.txt")?.whitespaceOnly).toBeUndefined();
  });

  it("没有远端、也没有任何线上分支配置：chat 兜底探测本地的 main", async () => {
    const r = await readOne(chatTask(LOCAL_ONLY));
    expect(r.unavailable).toBeUndefined();
    expect(r.branch).toBe("feat/x");
    expect(r.base).toMatchObject({ kind: "merge-base", label: "main" });
    expect(pathsOf(r)).toEqual(["g.txt"]);
    expect(r.aheadOfBase).toBe(1);
    expect(r.behindBase).toBe(0);
  });

  it("task 模式同一个仓：保持已发布行为——找不到线上分支就降级成 HEAD（不做 chat 兜底探测）", async () => {
    const r = await readOne(bareTask(LOCAL_ONLY));
    expect(r.base?.kind).toBe("head");
    expect(r.aheadOfBase).toBeUndefined();
    // 降级后看的是「相对 HEAD 的未提交」：工作区干净 → 没有改动
    expect(r.files).toEqual([]);
  });

  it("切分支后每次读取实时跟随（不缓存 HEAD）", async () => {
    git(SWITCH, "checkout", "-q", "-b", "feat/one");
    write(SWITCH, "one.txt", "1\n");
    commitAll(SWITCH, "one");
    const one = await readOne(chatTask(SWITCH));
    expect(one.branch).toBe("feat/one");
    expect(pathsOf(one)).toEqual(["one.txt"]);

    git(SWITCH, "checkout", "-q", "main");
    git(SWITCH, "checkout", "-q", "-b", "feat/two");
    write(SWITCH, "two.txt", "2\n");
    commitAll(SWITCH, "two");
    const two = await readOne(chatTask(SWITCH));
    expect(two.branch).toBe("feat/two");
    expect(pathsOf(two)).toEqual(["two.txt"]);

    // 回到线上分支本身：没有「分支上的提交」、标记 onBaseBranch
    git(SWITCH, "checkout", "-q", "main");
    const onMain = await readOne(chatTask(SWITCH));
    expect(onMain.branch).toBe("main");
    expect(onMain.onBaseBranch).toBe(true);
    expect(onMain.files).toEqual([]);
  });

  it("main 比当前分支多的提交算 behind，当前分支独有的算 ahead", async () => {
    const r = await readOne(chatTask(BEHIND));
    expect(r.branch).toBe("feat/y");
    expect(r.base).toMatchObject({ kind: "merge-base", label: "main" });
    expect(r.aheadOfBase).toBe(2);
    expect(r.behindBase).toBe(1);
    // 只看本分支自己的改动：不含 main 后来的 m1.txt
    expect(pathsOf(r)).toEqual(["y1.txt", "y2.txt"]);
  });

  it("没有绑定工作目录 / 没有仓：不读任何东西（不会误读 Flowship 自己的目录）", async () => {
    expect((await readTaskChanges(chatTask(WORK, { workCwd: undefined }))).repos).toEqual([]);
    expect((await readTaskChanges(chatTask(WORK, { repoPaths: [] }))).repos).toEqual([]);
  });

  it("非 git 目录：该仓标 not_git；目录不存在：dir_missing", async () => {
    expect((await readOne(chatTask(PLAIN_DIR))).unavailable).toBe("not_git");
    expect((await readOne(chatTask(path.join(TMP, "nope")))).unavailable).toBe("dir_missing");
  });
});

// ======================================================================
// 范围（scope）
// ======================================================================

describe("范围：只看未提交 / 只看某一个提交", () => {
  it("uncommitted：相对 HEAD、含未跟踪；已提交的不出现；基线标 HEAD", async () => {
    const r = await readOne(chatTask(), { scope: { kind: "uncommitted" } });
    expect(r.scope).toBe("uncommitted");
    expect(r.base).toEqual({ kind: "head", label: "HEAD", shortSha: c2.slice(0, 7) });
    const expected = ["a.txt", "big.txt", "mixed.txt", "u.txt", "ws.txt"];
    if (HAS_SYMLINK) expected.push("link-out");
    expect(pathsOf(r)).toEqual(expected.sort());
    // 只剩工作区那一处：a.txt 第 15 行
    expect(byPath(r).get("a.txt")).toMatchObject({ added: 1, removed: 1 });
    // ahead / behind 仍然回传（基于线上分支、与范围无关）
    expect(r.aheadOfBase).toBe(2);
  });

  it("commit：只看这个提交自己的改动（相对第一父）、不含未跟踪", async () => {
    const r1 = await readOne(chatTask(), { scope: { kind: "commit", sha: c1 } });
    expect(r1.scope).toBe("commit");
    expect(r1.unavailable).toBeUndefined();
    expect(r1.base).toEqual({
      kind: "commit-parent",
      label: `${c1.slice(0, 7)}^`,
      shortSha: baseSha.slice(0, 7),
    });
    expect(pathsOf(r1)).toEqual(["a.txt"]);
    expect(byPath(r1).get("a.txt")).toMatchObject({ added: 1, removed: 1 });
    expect(r1.untrackedSkipped).toBeUndefined();

    const r2 = await readOne(chatTask(), { scope: { kind: "commit", sha: c2 } });
    expect(pathsOf(r2)).toEqual(["b.txt", "c.txt"]);
    expect(r2.base?.shortSha).toBe(c1.slice(0, 7));
  });

  it("commit：接受 7 位短 sha", async () => {
    const r = await readOne(chatTask(), { scope: { kind: "commit", sha: c1.slice(0, 7) } });
    expect(r.unavailable).toBeUndefined();
    expect(pathsOf(r)).toEqual(["a.txt"]);
  });

  it("commit 校验：分叉点本身 / 悬空提交 / 不存在 / 长得像参数 → scope_invalid、不泄露任何文件", async () => {
    const bad = [
      baseSha,
      strayCommit,
      "deadbeef".repeat(5),
      "--output=/tmp/should-never-exist",
      "-n1",
      "HEAD",
      "main",
      "",
    ];
    for (const sha of bad) {
      const r = await readOne(chatTask(), { scope: { kind: "commit", sha } });
      expect(r.unavailable, JSON.stringify(sha)).toBe("scope_invalid");
      expect(r.files).toEqual([]);
      expect(r.scope).toBe("commit");
    }
    expect(fs.existsSync("/tmp/should-never-exist")).toBe(false);
  });

  it("commit：没有线上分支可比（task 降级成 HEAD）时无从谈起 → scope_invalid", async () => {
    const head = git(LOCAL_ONLY, "rev-parse", "HEAD");
    const r = await readOne(bareTask(LOCAL_ONLY), { scope: { kind: "commit", sha: head } });
    expect(r.unavailable).toBe("scope_invalid");
  });

  it("提交列表：基线之后的提交、新到旧、字段齐全", async () => {
    const { repos } = await readTaskChangeCommits(chatTask());
    expect(repos).toHaveLength(1);
    const r = repos[0];
    expect(r.unavailable).toBeUndefined();
    expect(r.base).toEqual({ kind: "merge-base", label: "origin/main", shortSha: baseSha.slice(0, 7) });
    expect(r.truncated).toBeUndefined();
    expect(r.commits.map((c) => c.sha)).toEqual([c2, c1]);
    // 作者以 git 自己读到的为准（测试环境可能用 GIT_AUTHOR_NAME 覆盖仓里的 user.name）
    expect(r.commits[0]).toMatchObject({
      shortSha: c2.slice(0, 7),
      subject: "feat: add c and extend b",
      author: git(WORK, "log", "-1", "--format=%an", c2),
    });
    expect(r.commits[0].author).not.toBe("");
    expect(r.commits[0].ts).toBeGreaterThan(1_600_000_000);
  });

  it("提交列表：没有线上分支可比 → no_base；非 git → not_git；目录不存在 → dir_missing", async () => {
    const noBase = (await readTaskChangeCommits(bareTask(LOCAL_ONLY))).repos[0];
    expect(noBase.unavailable).toBe("no_base");
    expect(noBase.commits).toEqual([]);
    expect((await readTaskChangeCommits(chatTask(PLAIN_DIR))).repos[0].unavailable).toBe("not_git");
    expect((await readTaskChangeCommits(chatTask(path.join(TMP, "nope")))).repos[0].unavailable).toBe(
      "dir_missing",
    );
  });

  it("提交列表：上限 MAX_COMMITS，超出标 truncated", async () => {
    const repo = path.join(TMP, "many-commits");
    initRepo(repo);
    write(repo, "r.txt", "r\n");
    commitAll(repo, "init");
    git(repo, "checkout", "-q", "-b", "feat/many");
    // fast-import 一次造出一堆提交，比逐个 git commit 快得多。
    // 每个提交显式写 from（第一个接在 init 上、之后接上一个 mark），主题固定 4 字节（c001…）、内容 1 字节
    const total = MAX_COMMITS + 5;
    const initSha = git(repo, "rev-parse", "HEAD");
    const stream: string[] = [];
    for (let i = 1; i <= total; i++) {
      stream.push(
        "commit refs/heads/feat/many",
        `mark :${i}`,
        `committer t <t@example.com> ${1_700_000_000 + i} +0000`,
        "data 4",
        `c${String(i).padStart(3, "0")}`,
        `from ${i === 1 ? initSha : `:${i - 1}`}`,
        `M 100644 inline f${i}.txt`,
        "data 1",
        "x",
        "",
      );
    }
    execFileSync("git", ["fast-import", "--quiet"], {
      cwd: repo,
      input: `${stream.join("\n")}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
    git(repo, "reset", "-q", "--hard", "feat/many");
    const r = (await readTaskChangeCommits(chatTask(repo))).repos[0];
    expect(r.unavailable).toBeUndefined();
    expect(r.commits).toHaveLength(MAX_COMMITS);
    expect(r.truncated).toBe(true);
    // 新到旧：第一条是最后造的那个
    expect(r.commits[0].subject).toBe(`c${String(total).padStart(3, "0")}`);
  });
});

// ======================================================================
// 忽略空白（-w）
// ======================================================================

describe("忽略空白", () => {
  it("清单：只改了空白的文件标 whitespaceOnly（行数记 0），有实质改动的文件照常统计", async () => {
    const plain = byPath(await readOne(chatTask()));
    expect(plain.get("ws.txt")).toMatchObject({ added: 1, removed: 1 });
    expect(plain.get("ws.txt")?.whitespaceOnly).toBeUndefined();

    const r = await readOne(chatTask(), { ignoreWs: true });
    const m = byPath(r);
    expect(m.get("ws.txt")).toMatchObject({
      status: "modified",
      added: 0,
      removed: 0,
      binary: false,
      whitespaceOnly: true,
    });
    // 缩进 + 实质改动：y = 2 → y = 22，忽略空白后仍是 1 增 1 删
    expect(m.get("mixed.txt")).toMatchObject({ added: 1, removed: 1 });
    expect(m.get("mixed.txt")?.whitespaceOnly).toBeUndefined();
    // 其余文件不受影响；总数不变（纯空白文件仍在清单里、不会凭空消失）
    expect(m.get("a.txt")).toMatchObject({ added: 2, removed: 2 });
    expect(r.files).toHaveLength(plain.size);
  });

  it("单文件 diff：纯空白文件为空、混合文件只剩实质行", async () => {
    const task = chatTask();
    const ws = await readTaskChangeFileDiff(task, WORK, "ws.txt", null, { ignoreWs: true });
    expect(ws.ok && ws.data.diff).toBe("");
    const wsPlain = await readTaskChangeFileDiff(task, WORK, "ws.txt", null);
    expect(wsPlain.ok && wsPlain.data.diff).toContain("@@");

    const mixed = await readTaskChangeFileDiff(task, WORK, "mixed.txt", null, { ignoreWs: true });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.data.diff).toContain("y = 22");
      // 没改的 x / z 只作为上下文出现
      expect(mixed.data.diff).not.toMatch(/^[+-]x = 1$/m);
      expect(mixed.data.diff).not.toMatch(/^[+-]z = 3$/m);
    }
  });
});

// ======================================================================
// 单文件 diff：范围 / 展开上下文 / 安全
// ======================================================================

describe("单文件 diff", () => {
  it("branch：已提交 + 未提交的改动都在；uncommitted：只剩没提交的；commit：只有那个提交", async () => {
    const task = chatTask();
    const branch = await readTaskChangeFileDiff(task, WORK, "a.txt");
    expect(branch.ok).toBe(true);
    if (branch.ok) {
      for (const s of ["-a5", "+A5", "-a15", "+A15"]) expect(branch.data.diff).toContain(`\n${s}\n`);
    }

    const unc = await readTaskChangeFileDiff(task, WORK, "a.txt", null, { scope: { kind: "uncommitted" } });
    expect(unc.ok).toBe(true);
    if (unc.ok) {
      expect(unc.data.diff).toContain("\n+A15\n");
      // c1 已经提交了：只看未提交时不该再出现它那处改动
      expect(unc.data.diff).not.toContain("+A5\n");
    }

    const one = await readTaskChangeFileDiff(task, WORK, "a.txt", null, { scope: { kind: "commit", sha: c1 } });
    expect(one.ok).toBe(true);
    if (one.ok) {
      expect(one.data.diff).toContain("\n+A5\n");
      expect(one.data.diff).not.toContain("A15");
    }
  });

  it("commit 范围里请求未跟踪文件：不合成、不读盘，返回空 diff", async () => {
    const r = await readTaskChangeFileDiff(chatTask(), WORK, "u.txt", null, { scope: { kind: "commit", sha: c2 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.diff).toBe("");
      expect(r.data.fullContext).toBeUndefined();
    }
  });

  it("commit 范围不合法：409，且不会借此读任意历史", async () => {
    for (const sha of [baseSha, strayCommit, "deadbeef".repeat(5), "--output=/tmp/should-never-exist-2"]) {
      const r = await readTaskChangeFileDiff(chatTask(), WORK, "a.txt", null, { scope: { kind: "commit", sha } });
      expect(r.ok, JSON.stringify(sha)).toBe(false);
      if (!r.ok) expect(r.status).toBe(409);
    }
    expect(fs.existsSync("/tmp/should-never-exist-2")).toBe(false);
  });

  it("展开上下文：默认只有 3 行上下文；full 返回整文件并标 fullContext", async () => {
    const task = chatTask();
    const normal = await readTaskChangeFileDiff(task, WORK, "big.txt");
    expect(normal.ok).toBe(true);
    if (normal.ok) {
      expect(normal.data.fullContext).toBeUndefined();
      expect(normal.data.diff).toContain("@@ -47,7 +47,7 @@");
      expect(normal.data.diff).not.toContain(" line1\n");
    }

    const full = await readTaskChangeFileDiff(task, WORK, "big.txt", null, { fullContext: true });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.data.fullContext).toBe(true);
      expect(full.data.diff).toContain("@@ -1,100 +1,100 @@");
      // 上下文行以空格开头；首尾各取一个、改动点两侧各取一个
      for (const ln of ["line1", "line49", "line51", "line100"]) {
        expect(full.data.diff).toContain(`\n ${ln}\n`);
      }
      expect(full.data.diff).toContain("\n-line50\n+LINE50\n");
    }
  });

  it("未跟踪的新文件：合成的 diff 本来就是整文件，标 fullContext", async () => {
    const r = await readTaskChangeFileDiff(chatTask(), WORK, "u.txt");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.fullContext).toBe(true);
      expect(r.data.diff).toContain("\n+u1\n+u2");
    }
  });

  it("被 ignore 的文件读不到内容；仓外符号链接只给出链接目标、不跟随", async () => {
    const ign = await readTaskChangeFileDiff(chatTask(), WORK, "ignored.env");
    expect(ign.ok && ign.data.diff).toBe("");
    expect(JSON.stringify(ign)).not.toContain("hunter2");

    if (HAS_SYMLINK) {
      const link = await readTaskChangeFileDiff(chatTask(), WORK, "link-out");
      expect(link.ok).toBe(true);
      expect(JSON.stringify(link)).not.toContain("TOP-SECRET");
      if (link.ok) expect(link.data.diff).toContain(OUTSIDE);
    }
  });

  it("路径逃逸 / 仓不在会话范围内：400 / 404（chat 同样）", async () => {
    const bad = await readTaskChangeFileDiff(chatTask(), WORK, "../outside-secret.txt");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(400);
    const other = await readTaskChangeFileDiff(chatTask(), LOCAL_ONLY, "f.txt");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.status).toBe(404);
  });
});

// ======================================================================
// 手动基线
// ======================================================================

describe("手动指定对比基线", () => {
  it("本地分支作基线：改动随之收窄、回显 applied=true", async () => {
    git(WORK, "branch", "develop", c1);
    try {
      const r = await readOne(chatTask(), { baseRef: "develop" });
      expect(r.base).toEqual({ kind: "merge-base", label: "develop", shortSha: c1.slice(0, 7) });
      expect(r.baseOverride).toEqual({ requested: "develop", applied: true });
      // 以 c1 为基线：c1 自己的 A5 不再算改动，a.txt 只剩第 15 行
      expect(byPath(r).get("a.txt")).toMatchObject({ added: 1, removed: 1 });
      expect(r.aheadOfBase).toBe(1);

      // 以 c1 为基线时，c1 就是分叉点本身 → 不能再当「分支上的提交」；c2 可以
      const asBase = await readOne(chatTask(), { baseRef: "develop", scope: { kind: "commit", sha: c1 } });
      expect(asBase.unavailable).toBe("scope_invalid");
      const after = await readOne(chatTask(), { baseRef: "develop", scope: { kind: "commit", sha: c2 } });
      expect(after.unavailable).toBeUndefined();

      const { repos } = await readTaskChangeCommits(chatTask(), { baseRef: "develop" });
      expect(repos[0].commits.map((c) => c.sha)).toEqual([c2]);
    } finally {
      git(WORK, "branch", "-D", "develop");
    }
  });

  it("找不到 / 写法不合法的基线：回落自动探测，applied=false；空串不算覆盖", async () => {
    for (const requested of ["no-such-branch", "--evil", "a..b", "x y", "a".repeat(300)]) {
      const r = await readOne(chatTask(), { baseRef: requested });
      expect(r.base?.label, requested).toBe("origin/main");
      expect(r.baseOverride, requested).toEqual({ requested, applied: false });
    }
    const empty = await readOne(chatTask(), { baseRef: "  " });
    expect(empty.baseOverride).toBeUndefined();
    expect(empty.base?.label).toBe("origin/main");
  });

  it("恶意 / 古怪的基线名：不执行任何命令、三个入口都不抛、不会被当成有效基线、回落自动探测", async () => {
    // 哨兵文件：真被 shell / git 选项执行了才会出现。我们走 execFile（无 shell）、名字过白名单，这些都不该发生
    const pwn = (n: number) => path.join(TMP, `pwn-${n}`);
    const hostile = [
      `--output=${pwn(1)}`, // 被当成 git diff 选项会写出文件
      `-c core.pager=touch ${pwn(2)}`,
      `$(touch ${pwn(3)})`,
      `main;touch ${pwn(4)}`,
      `main\ntouch ${pwn(5)}`,
      `\`touch ${pwn(6)}\``,
      `--upload-pack=touch ${pwn(7)}`,
      "--all",
      "../../../etc/passwd",
      "origin/../main",
      // 在 git 的 revision 语法里都有特殊含义，而我们只收「一个分支名」。
      // HEAD 的三种大小写：夹具是 clone 出来的、有 refs/remotes/origin/HEAD（指向 main），放过它就会被当成
      // 「远端默认分支」；大小写不敏感的文件系统（macOS）上 head / Head 也命中得到——所以必须不分大小写拒绝
      "HEAD",
      "head",
      "Head",
      "@{-1}",
      "main^{}",
      "main~1",
      ":/init",
      "分支 with space",
      "main\u0000evil", // NUL：传给 execFile 会直接抛
      "x".repeat(199), // 形态合法、只是不存在
      "x".repeat(201), // 超长
    ];
    for (const requested of hostile) {
      const label = JSON.stringify(requested).slice(0, 48);
      const listed = await readOne(chatTask(), { baseRef: requested });
      expect(listed.baseOverride, label).toEqual({ requested, applied: false });
      expect(listed.base?.label, label).toBe("origin/main");
      expect(listed.unavailable, label).toBeUndefined();

      // 单文件 diff / 提交列表：不抛、而且回落到自动基线后照常工作（不是整个功能被打挂）
      const file = await readTaskChangeFileDiff(chatTask(), WORK, "a.txt", null, { baseRef: requested });
      expect(file.ok, label).toBe(true);
      const commits = await readTaskChangeCommits(chatTask(), { baseRef: requested });
      expect(commits.repos[0].unavailable, label).toBeUndefined();
      expect(commits.repos[0].commits.length, label).toBeGreaterThan(0);
    }
    for (let i = 1; i <= 7; i += 1) expect(fs.existsSync(pwn(i)), `哨兵 pwn-${i} 不该出现`).toBe(false);
    // 对照（不让整条用例因为「基线功能整体坏了」而假绿）：合法的手动基线确实能生效——见上面「本地分支作基线」那条
  }, 60_000); // 21 个值 × 3 个入口 × 若干 git 子进程：本机并发下就要好几秒，CI 的 2 核机器更慢，别靠默认 5s 碰运气
});

// ======================================================================
// 纯函数
// ======================================================================

describe("纯函数：git 输出解析", () => {
  it("parseLeftRightCount：左 = 落后、右 = 领先；垃圾返回 null", () => {
    expect(parseLeftRightCount("3\t5\n")).toEqual({ behind: 3, ahead: 5 });
    expect(parseLeftRightCount("0\t0")).toEqual({ behind: 0, ahead: 0 });
    expect(parseLeftRightCount("12  7  ")).toEqual({ behind: 12, ahead: 7 });
    for (const bad of ["", "x y", "1", "1\t2\t3", "-1\t2"]) {
      expect(parseLeftRightCount(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("parseCommitLog：标准记录 / 合并提交 / 根提交 / 空主题 / 坏记录丢弃 / 超长截断", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const p1 = "1".repeat(40);
    const p2 = "2".repeat(40);
    // 字段：sha、父提交们（空格分隔）、作者、时间、主题
    const out =
      `${a}\x1f${p1}\x1falice\x1f1700000000\x1ffeat: x\x1e\n` +
      `${b}\x1f${p1} ${p2}\x1fbob\x1f1700000100\x1f\x1e\n` +
      `zz\x1f${p1}\x1fbad\x1f1\x1fnot-a-sha\x1e\n` +
      `${"c".repeat(40)}\x1f\x1f${"n".repeat(500)}\x1fNaN\x1f${"s".repeat(500)}\x1e\n`;
    const commits = parseCommitLog(out);
    expect(commits).toHaveLength(3);
    // 单父提交：不带 isMerge 键
    expect(commits[0]).toEqual({ sha: a, shortSha: "aaaaaaa", subject: "feat: x", author: "alice", ts: 1_700_000_000 });
    expect("isMerge" in commits[0]).toBe(false);
    // 两个父 = 合并提交（且空主题照常保留）
    expect(commits[1]).toEqual({ sha: b, shortSha: "bbbbbbb", subject: "", author: "bob", ts: 1_700_000_100, isMerge: true });
    // 根提交（没有父）不算合并；超长字段截断
    expect("isMerge" in commits[2]).toBe(false);
    expect(commits[2].subject).toHaveLength(300);
    expect(commits[2].author).toHaveLength(100);
    expect(commits[2].ts).toBe(0);
    expect(parseCommitLog("")).toEqual([]);
    expect(parseCommitLog("\n")).toEqual([]);
  });
});

describe("纯函数：scope / query", () => {
  it("parseChangeScope：缺省 = 整条分支；commit 的 sha 归一成小写；写错返回 null", () => {
    for (const v of [undefined, null, "", "   ", "branch"]) {
      expect(parseChangeScope(v), String(v)).toEqual({ kind: "branch" });
    }
    expect(parseChangeScope("uncommitted")).toEqual({ kind: "uncommitted" });
    expect(parseChangeScope(" uncommitted ")).toEqual({ kind: "uncommitted" });
    expect(parseChangeScope("commit:ABCDEF1")).toEqual({ kind: "commit", sha: "abcdef1" });
    expect(parseChangeScope(`commit:${"a".repeat(64)}`)).toEqual({ kind: "commit", sha: "a".repeat(64) });
    for (const bad of [
      "bogus",
      "Branch",
      "commit:",
      "commit:abc",
      "commit:zzzzzzz",
      "commit:--output=x",
      `commit:${"a".repeat(65)}`,
      "commit:abcdef1 ; rm -rf",
    ]) {
      expect(parseChangeScope(bad), bad).toBeNull();
    }
  });

  it("formatChangeScope / sameChangeScope 往返一致", () => {
    for (const s of [
      { kind: "branch" } as const,
      { kind: "uncommitted" } as const,
      { kind: "commit", sha: "abc1234" } as const,
    ]) {
      expect(parseChangeScope(formatChangeScope(s))).toEqual(s);
      expect(sameChangeScope(s, s)).toBe(true);
    }
    expect(sameChangeScope({ kind: "branch" }, { kind: "uncommitted" })).toBe(false);
    expect(sameChangeScope({ kind: "commit", sha: "abc1234" }, { kind: "commit", sha: "abc1235" })).toBe(false);
    expect(sameChangeScope({ kind: "commit", sha: "abc1234" }, { kind: "branch" })).toBe(false);
  });

  it("query：默认值不写进 URL；写进去的能原样读回", () => {
    const empty = new URLSearchParams();
    appendChangesQuery(empty, { scope: { kind: "branch" }, baseRef: null, ignoreWs: false });
    expect(empty.toString()).toBe("");
    expect(parseChangesQuery(empty)).toEqual({ scope: { kind: "branch" }, baseRef: null, ignoreWs: false });

    const sp = new URLSearchParams();
    appendChangesQuery(sp, { scope: { kind: "commit", sha: "abc1234" }, baseRef: "release/1.0", ignoreWs: true });
    expect(parseChangesQuery(new URLSearchParams(sp.toString()))).toEqual({
      scope: { kind: "commit", sha: "abc1234" },
      baseRef: "release/1.0",
      ignoreWs: true,
    });
    expect(parseChangesQuery(new URLSearchParams("scope=bogus"))).toBeNull();
    expect(parseChangesQuery(new URLSearchParams("ws=0"))?.ignoreWs).toBe(false);
  });

  it("normalizeBaseRefParam：去空白、空 / 超长 → null", () => {
    expect(normalizeBaseRefParam(" develop ")).toBe("develop");
    for (const v of [undefined, null, "", "   ", "a".repeat(201)]) {
      expect(normalizeBaseRefParam(v), String(v)).toBeNull();
    }
  });
});

describe("readRepoChanges 直接调用的边界", () => {
  it("不传 opts 与显式 branch scope 结果一致（向后兼容）", async () => {
    const target = resolveChangeRepoTargets(chatTask())[0];
    const a = await readRepoChanges(target, chatTask());
    const b = await readRepoChanges(target, chatTask(), { scope: { kind: "branch" } });
    expect(b).toEqual(a);
  });
});
