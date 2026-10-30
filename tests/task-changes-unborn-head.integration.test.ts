/**
 * R14 B6-4 / Q4-03 + Q4-02：改动面板对「还没有任何提交的新仓」和「agent 对文件 git add / commit」的真 git 验证。
 *
 * - Q4-03：HEAD 还不存在（刚 `git init`）时，以前整仓报「仓库还没有任何提交」、清单空白、单文件 diff 404
 *   （典型场景：chat 里让 AI 新建目录、`git init`、搭项目）。现在拿空树当基线，已写入的文件
 *   （git add 过的、add 之后又改的、未跟踪的）全部列出，单文件 diff 可看。
 * - Q4-02：agent 对同一个文件 `git add` / `git commit` 前后，它从「未跟踪的合成项」变成「已跟踪的 diff 项」，
 *   内容没变——「已查看」签名不能变，否则用户看过的文件会整体变黄。
 *
 * 全部用真 git 在临时目录里端到端验证（不 mock git）；断言我们自己算出来的结构（路径 / 状态 / 行数 / 基线 / 指纹），
 * 不依赖任何 git 报错文案。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fileSignature, viewedSignature } from "@/lib/changes/entries";
import {
  readTaskChangeCommits,
  readTaskChangeFileDiff,
  readTaskChanges,
  type ReadChangesOptions,
  type ReadFileDiffOptions,
  type TaskChangesTaskLike,
} from "@/lib/server/task-changes";
import type { TaskChangeFile, TaskRepoChanges } from "@/lib/types";

// 在 git hook 里跑测试时这些变量会指向「外层仓」，让测试里的 git 命令全跑偏；
// 用户全局 git 配置（autocrlf / noprefix 之类）也会让结果因人而异——一并隔离
const LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;
const savedEnv: Record<string, string | undefined> = {};

// macOS 的 tmpdir 在 /var → /private/var 的软链下，git 吐的是真实路径，统一取 realpath
const TMP = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "flowship-unborn-head-")),
);
const GLOBAL_CFG = path.join(TMP, "global-gitconfig");

beforeAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fs.writeFileSync(GLOBAL_CFG, "");
  process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------- 夹具

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const write = (dir: string, rel: string, content: string) => {
  const abs = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
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
const chatTask = (dir: string): TaskChangesTaskLike => ({
  mode: "chat",
  repoPaths: [dir],
  workCwd: dir,
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

const need = (f: TaskChangeFile | undefined, label: string): TaskChangeFile => {
  if (!f) throw new Error(`清单里没有 ${label}`);
  return f;
};

const diffOf = async (
  task: TaskChangesTaskLike,
  repo: string,
  rel: string,
  opts: ReadFileDiffOptions = {},
) => {
  const res = await readTaskChangeFileDiff(task, repo, rel, null, opts);
  if (!res.ok) throw new Error(`${rel}：${res.status} ${res.error}`);
  return res.data;
};

// ---------------------------------------------------------------------- Q4-03

describe("空仓（还没有任何提交）：拿空树当基线，已写入的文件全部列出", { timeout: 30_000 }, () => {
  const REPO = path.join(TMP, "unborn");

  beforeAll(() => {
    initRepo(REPO);
    write(REPO, "a.txt", "a1\na2\n"); // 未跟踪
    write(REPO, "sub/deep.txt", "d1\n"); // 未跟踪、在子目录里
    write(REPO, "b.txt", "b1\n"); // git add 过
    write(REPO, "c.txt", "c1\nc2\nc3\n");
    write(REPO, ".gitignore", "ignored.log\n"); // git add 过
    write(REPO, "ignored.log", "secret\n"); // 被 ignore
    git(REPO, "add", "b.txt", "c.txt", ".gitignore");
    write(REPO, "c.txt", "c1\nc2\nc3\nc4\n"); // add 之后又改：工作区比暂存区多一行
  });

  it("前提自检：这个仓确实还没有任何提交（不然下面的用例全是空转）", () => {
    expect(() => git(REPO, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")).toThrow();
  });

  it("整条分支范围：暂存的、暂存后又改的、未跟踪的（含子目录里的）都列出，被 ignore 的不出现；不再整仓「不可用」", async () => {
    const r = await readOne(chatTask(REPO));
    expect(r.unavailable).toBeUndefined();
    expect(r.base).toEqual({ kind: "empty-tree", label: "空仓库", shortSha: "4b825dc" });
    // HEAD 还不指向任何提交，读不出分支名——前端据此不说「游离 HEAD」
    expect(r.branch).toBeNull();
    expect(pathsOf(r)).toEqual([".gitignore", "a.txt", "b.txt", "c.txt", "sub/deep.txt"]);

    const m = byPath(r);
    expect(m.get("a.txt")).toMatchObject({ status: "added", added: 2, removed: 0, untracked: true });
    expect(m.get("sub/deep.txt")).toMatchObject({ status: "added", added: 1, removed: 0, untracked: true });
    expect(m.get("b.txt")).toMatchObject({ status: "added", added: 1, removed: 0, untracked: false });
    // add 之后又改：看的是工作区里现在的内容（4 行），不是暂存的那一版
    expect(m.get("c.txt")).toMatchObject({ status: "added", added: 4, removed: 0, untracked: false });
    expect(r.totals).toEqual({ files: 5, added: 2 + 1 + 1 + 4 + 1, removed: 0 });
    // 没有提交，自然没有领先 / 落后 / 在线上分支上这些说法
    expect(r.aheadOfBase).toBeUndefined();
    expect(r.behindBase).toBeUndefined();
    expect(r.onBaseBranch).toBeUndefined();
  });

  it("文件级指纹：旧侧没有（写 `-`），新侧 = 工作区里现在内容的 git blob oid——暂存的、暂存后又改的、未跟踪的口径一致", async () => {
    const m = byPath(await readOne(chatTask(REPO)));
    for (const p of ["a.txt", "b.txt", "c.txt", "sub/deep.txt"]) {
      const oid = git(REPO, "hash-object", p);
      expect(need(m.get(p), p).fingerprint, p).toBe(`-..${oid.slice(0, 12)}`);
    }
  });

  it("「只看未提交」范围：同样列出，基线仍是空树（不会被说成「相对 HEAD」）", async () => {
    const all = await readOne(chatTask(REPO));
    const u = await readOne(chatTask(REPO), { scope: { kind: "uncommitted" } });
    expect(u.unavailable).toBeUndefined();
    expect(u.scope).toBe("uncommitted");
    expect(u.base).toEqual({ kind: "empty-tree", label: "空仓库", shortSha: "4b825dc" });
    expect(pathsOf(u)).toEqual(pathsOf(all));
  });

  it("task 模式（没有任何线上分支配置）同样成立", async () => {
    const r = await readOne(bareTask(REPO));
    expect(r.unavailable).toBeUndefined();
    expect(r.base?.kind).toBe("empty-tree");
    expect(pathsOf(r)).toEqual([".gitignore", "a.txt", "b.txt", "c.txt", "sub/deep.txt"]);
  });

  it("手动选的对比基线在空仓里不适用：不报「基线不可用」", async () => {
    const r = await readOne(chatTask(REPO), { baseRef: "release/9" });
    expect(r.base?.kind).toBe("empty-tree");
    expect(r.baseOverride).toBeUndefined();
  });

  it("单文件 diff：暂存的、暂存后又改的、未跟踪的都能看（以前整仓 404）；被 ignore 的读不到内容", async () => {
    const t = chatTask(REPO);
    const b = await diffOf(t, REPO, "b.txt");
    expect(b.diff).toContain("+++ b/b.txt");
    expect(b.diff).toContain("+b1");
    // 工作区里最新的内容（第 4 行是 add 之后才写的）
    expect((await diffOf(t, REPO, "c.txt")).diff).toContain("+c4");
    expect((await diffOf(t, REPO, "a.txt")).diff).toContain("+a1");
    expect((await diffOf(t, REPO, "ignored.log")).diff).not.toContain("secret");
  });

  it("「单个提交」范围：空仓里没有提交可选 → scope_invalid（以前是 no_head），文件 diff 同样拒绝", async () => {
    const sha = "deadbeef".repeat(5);
    const r = await readOne(chatTask(REPO), { scope: { kind: "commit", sha } });
    expect(r.unavailable).toBe("scope_invalid");
    expect(r.files).toEqual([]);
    const res = await readTaskChangeFileDiff(chatTask(REPO), REPO, "b.txt", null, {
      scope: { kind: "commit", sha },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("提交列表：空仓没有提交可列，提示与「读不到 HEAD」同一句（no_head），基线为空", async () => {
    const { repos } = await readTaskChangeCommits(chatTask(REPO));
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ unavailable: "no_head", commits: [], base: null });
  });

  it("什么都还没写的空仓：不是「不可用」，只是没有改动", async () => {
    const dir = path.join(TMP, "unborn-empty");
    initRepo(dir);
    const r = await readOne(chatTask(dir));
    expect(r.unavailable).toBeUndefined();
    expect(r.base?.kind).toBe("empty-tree");
    expect(r.files).toEqual([]);
    expect(r.totals).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it("第一次提交之后：回到常规基线（不再是空树），工作区干净就没有改动", async () => {
    const dir = path.join(TMP, "unborn-then-commit");
    initRepo(dir);
    write(dir, "a.txt", "a1\n");
    const before = await readOne(chatTask(dir));
    expect(before.base?.kind).toBe("empty-tree");
    expect(pathsOf(before)).toEqual(["a.txt"]);

    commitAll(dir, "init");
    const after = await readOne(chatTask(dir));
    expect(after.unavailable).toBeUndefined();
    expect(after.base?.kind).not.toBe("empty-tree");
    expect(after.branch).toBe("main");
    expect(after.files).toEqual([]);
  });

  it("空仓里同样：未跟踪的文件被 git add 之后，「已查看」签名不变（Q4-02 串联）", async () => {
    const dir = path.join(TMP, "unborn-viewed");
    initRepo(dir);
    write(dir, "n.txt", "n1\n");
    const before = need(byPath(await readOne(chatTask(dir))).get("n.txt"), "n.txt");
    git(dir, "add", "n.txt");
    const after = need(byPath(await readOne(chatTask(dir))).get("n.txt"), "n.txt");
    // 防空转：确实经历了「未跟踪 → 已跟踪」
    expect([before.untracked, after.untracked]).toEqual([true, false]);
    expect(viewedSignature(after)).toBe(viewedSignature(before));
    expect(fileSignature(dir, after)).toBe(fileSignature(dir, before));
  });
});

// ---------------------------------------------------------------------- Q4-02

describe("已查看签名：文件被 git add / commit 之后内容没变，就不能算「改过」", { timeout: 30_000 }, () => {
  const REPO = path.join(TMP, "viewed");

  beforeAll(() => {
    initRepo(REPO);
    write(REPO, "base.txt", "base\n");
    commitAll(REPO, "base");
    git(REPO, "checkout", "-q", "-b", "feat/x");
  });

  it("未跟踪 → git add → git commit：清单里的状态变了，签名（已查看 / diff 缓存键）始终相同；内容真改了才变", async () => {
    const t = chatTask(REPO);
    write(REPO, "u.txt", "u1\nu2\n");
    const f1 = need(byPath(await readOne(t)).get("u.txt"), "u.txt（未跟踪）");
    git(REPO, "add", "u.txt");
    const f2 = need(byPath(await readOne(t)).get("u.txt"), "u.txt（已暂存）");
    commitAll(REPO, "add u");
    const f3 = need(byPath(await readOne(t)).get("u.txt"), "u.txt（已提交）");

    // 防空转：确实经历了「未跟踪 → 已跟踪」，且别的字段都没变
    expect([f1.untracked, f2.untracked, f3.untracked]).toEqual([true, false, false]);
    for (const f of [f1, f2, f3]) expect(f).toMatchObject({ status: "added", added: 2, removed: 0 });
    expect(f2.fingerprint).toBe(f1.fingerprint);
    expect(f3.fingerprint).toBe(f1.fingerprint);

    expect(viewedSignature(f2)).toBe(viewedSignature(f1));
    expect(viewedSignature(f3)).toBe(viewedSignature(f1));
    // diff 缓存键同理：add 之后不会重拉 diff、展开状态保留
    expect(fileSignature(REPO, f2)).toBe(fileSignature(REPO, f1));
    expect(fileSignature(REPO, f3)).toBe(fileSignature(REPO, f1));

    // 对照：内容真的改了（行数不变）签名必须变，否则「已查看」就失去意义
    write(REPO, "u.txt", "u1\nXX\n");
    const f4 = need(byPath(await readOne(t)).get("u.txt"), "u.txt（又改了）");
    expect(f4.untracked).toBe(false);
    expect(viewedSignature(f4)).not.toBe(viewedSignature(f3));
  });
});
