/**
 * 代码改动面板的「正确性」补强（审查 R11 跟进）：
 * 仓库根口径（chat 在 monorepo 子目录里打开）、文件级内容指纹、single-flight、
 * 完整 ref（同名 tag 不串）、合并提交标注、用户全局 git 配置不影响输出格式。
 *
 * 全部用真 git 在临时目录里端到端验证（不 mock git）；
 * 断言我们自己算出来的结构（路径 / 指纹 / 基线 / 数量），不依赖任何 git 报错文案。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  HASH_BATCH_CHARS,
  MAX_UNTRACKED_STAT_FILES,
  parseRawZ,
  readTaskChangeCommits,
  readTaskChangeFileDiff,
  readTaskChanges,
  statUntrackedBatch,
  type ReadChangesOptions,
  type TaskChangesTaskLike,
} from "@/lib/server/task-changes";
import {
  createHashCache,
  encodeUntrackedSummary,
  HASH_CACHE_MIN_AGE_MS,
  hashCacheKey,
  MAX_HASH_FILE_BYTES,
  MAX_HASH_FILES,
  MAX_HASH_TOTAL_BYTES,
  untrackedSummaryCache,
  workingHashCache,
} from "@/lib/server/working-file-hash";
import type { TaskRepoChanges } from "@/lib/types";

// 在 git hook 里跑测试时这些变量会指向「外层仓」，让测试里的 git 命令全跑偏
const LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  // 隔离用户机器上的 git 配置（autocrlf / noprefix / showSignature 之类会让结果因人而异）
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;
const savedEnv: Record<string, string | undefined> = {};

// macOS 的 tmpdir 在 /var → /private/var 的软链下，git 吐的是真实路径，统一取 realpath
const TMP = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "flowship-root-fingerprint-")),
);
const GLOBAL_CFG = path.join(TMP, "global-gitconfig");
const OUTSIDE = path.join(TMP, "outside-target.txt");
const HAS_SYMLINK = process.platform !== "win32";

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

/** main 上有基线提交，并切到 feat 分支（chat 的兜底基线 = 本地 main） */
const newRepo = (name: string, files: Record<string, string>): string => {
  const dir = path.join(TMP, name);
  initRepo(dir);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feat");
  return dir;
};

/** chat 会话形状：没有任何线上分支配置，只有用户选的工作目录 */
const chatTask = (dir: string): TaskChangesTaskLike => ({
  mode: "chat",
  repoPaths: [dir],
  workCwd: dir,
});

const readOne = async (dir: string, opts: ReadChangesOptions = {}): Promise<TaskRepoChanges> => {
  const { repos } = await readTaskChanges(chatTask(dir), opts);
  expect(repos).toHaveLength(1);
  return repos[0];
};

const pathsOf = (r: TaskRepoChanges): string[] => r.files.map((f) => f.path).sort();
const fp = (r: TaskRepoChanges, rel: string): string | undefined =>
  r.files.find((f) => f.path === rel)?.fingerprint;

/** git blob oid 前 12 位（指纹用的口径） */
const short = (oid: string): string => oid.slice(0, 12);
/** 内容按 git blob 口径的 oid（符号链接的 blob 内容 = 链接目标文本） */
const blobOid = (content: string | Buffer): string =>
  createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");

// ======================================================================
// 仓库根口径：chat 在 monorepo 子目录里打开
// ======================================================================

describe("子目录工作目录（chat 在 monorepo 子包里打开）", () => {
  const REPO = path.join(TMP, "mono repo"); // 路径带空格
  const SUB = path.join(REPO, "pkg", "sub");

  beforeAll(() => {
    initRepo(REPO);
    write(REPO, "root.txt", lines("r", 5));
    write(REPO, "pkg/sub/f.txt", lines("f", 5));
    write(REPO, "pkg/other.txt", lines("o", 5));
    commitAll(REPO, "base");
    git(REPO, "checkout", "-q", "-b", "feature");
    replaceLine(REPO, "root.txt", 2, "R2-changed");
    replaceLine(REPO, "pkg/sub/f.txt", 3, "F3-changed");
    commitAll(REPO, "feature work");
    // 未提交：子目录里一个、目录外（仓库根）一个
    write(REPO, "pkg/sub/new.txt", "n1\nn2\n");
    write(REPO, "top-new.txt", "t1\n");
  });

  it("清单口径是整条分支：含目录外的已跟踪 / 未跟踪文件，路径一律相对仓库根", async () => {
    const r = await readOne(SUB);
    expect(r.unavailable).toBeUndefined();
    expect(pathsOf(r)).toEqual(["pkg/sub/f.txt", "pkg/sub/new.txt", "root.txt", "top-new.txt"]);
    // 返回给前端的仍是用户选的目录（不是仓库根）
    expect(r.workDir).toBe(SUB);
    expect(r.files.find((f) => f.path === "top-new.txt")?.untracked).toBe(true);
    expect(r.files.find((f) => f.path === "pkg/sub/new.txt")?.untracked).toBe(true);
  });

  it("absolutePath 指向磁盘上真实存在的文件（IDE 跳转用；子目录里不再错位）", async () => {
    const r = await readOne(SUB);
    for (const f of r.files) {
      expect(fs.realpathSync.native(f.absolutePath), f.path).toBe(
        path.join(REPO, ...f.path.split("/")),
      );
    }
  });

  it("每个文件（含目录外的已跟踪 / 未跟踪）都能读到非空 diff", async () => {
    const task = chatTask(SUB);
    const r = await readOne(SUB);
    for (const f of r.files) {
      const res = await readTaskChangeFileDiff(task, SUB, f.path, f.oldPath ?? null);
      expect(res.ok, f.path).toBe(true);
      if (!res.ok) continue;
      expect(res.data.diff, f.path).toContain("@@");
    }
    const top = await readTaskChangeFileDiff(task, SUB, "top-new.txt", null);
    expect(top.ok && top.data.diff).toContain("+t1");
  });

  it("提交列表在子目录里也正常", async () => {
    const { repos } = await readTaskChangeCommits(chatTask(SUB));
    expect(repos[0].unavailable).toBeUndefined();
    expect(repos[0].commits.map((c) => c.subject)).toEqual(["feature work"]);
  });

  it("在仓库根打开与在子目录打开：清单（含指纹 / 合计）完全一致", async () => {
    const [atRoot, atSub] = [await readOne(REPO), await readOne(SUB)];
    expect(pathsOf(atRoot)).toEqual(pathsOf(atSub));
    expect(atRoot.totals).toEqual(atSub.totals);
    expect(atRoot.files.map((f) => f.fingerprint)).toEqual(atSub.files.map((f) => f.fingerprint));
  });

  it("单文件 diff 的越权防护不因换了根而放松：被 ignore 的文件、仓外路径都读不到", async () => {
    write(REPO, ".gitignore", "secret.env\n");
    write(REPO, "pkg/sub/secret.env", "TOKEN=abc\n");
    const task = chatTask(SUB);
    const ignored = await readTaskChangeFileDiff(task, SUB, "pkg/sub/secret.env", null);
    // 不在「未跟踪且未被 ignore」清单里：不会被当新文件读盘
    expect(ignored.ok && ignored.data.diff).not.toContain("TOKEN");
    for (const bad of ["../outside.txt", "/etc/passwd", "pkg/../../x"]) {
      const res = await readTaskChangeFileDiff(task, SUB, bad, null);
      expect(res.ok, bad).toBe(false);
    }
  });
});

// ======================================================================
// 文件级内容指纹
// ======================================================================

describe("文件级指纹：形状与稳定性", () => {
  it("未暂存 / 暂存 / 已提交：同一份内容指纹字符串完全相同（git add / commit 不会让「已查看」失效）", async () => {
    const dir = newRepo("fp-stages", { "a.txt": "AAA\nx2\nx3\n" });
    write(dir, "a.txt", "BBB\nx2\nx3\n");
    const unstaged = fp(await readOne(dir), "a.txt");
    git(dir, "add", "a.txt");
    const staged = fp(await readOne(dir), "a.txt");
    git(dir, "commit", "-q", "-m", "change a");
    const committed = fp(await readOne(dir), "a.txt");

    // 旧侧 = 基线里的 blob，新侧 = 工作区文件内容的 blob（git 自己算出来的，逐位对得上）
    const expected = `${short(git(dir, "rev-parse", "main:a.txt"))}..${short(git(dir, "hash-object", "a.txt"))}`;
    expect(unstaged).toBe(expected);
    expect(staged).toBe(expected);
    expect(committed).toBe(expected);
    expect(unstaged).toMatch(/^[0-9a-f]{12}\.\.[0-9a-f]{12}$/);
  });

  it("切分支：同一文件、同状态、同样 +1 −1、但内容不同——指纹不同（旧的「状态 + 行数」签名在这里会撞车）", async () => {
    const dir = newRepo("fp-branches", { "fp.txt": "AAA\nx2\nx3\n" });
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", "br-a");
    write(dir, "fp.txt", "AAA2\nx2\nx3\n");
    commitAll(dir, "a");
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", "br-b");
    write(dir, "fp.txt", "BBB2\nx2\nx3\n");
    commitAll(dir, "b");

    git(dir, "checkout", "-q", "br-a");
    const a = await readOne(dir);
    git(dir, "checkout", "-q", "br-b");
    const b = await readOne(dir);

    const fa = a.files.find((f) => f.path === "fp.txt")!;
    const fb = b.files.find((f) => f.path === "fp.txt")!;
    // 前提：除指纹外两边一模一样
    expect([fa.status, fa.added, fa.removed]).toEqual([fb.status, fb.added, fb.removed]);
    expect(fa.fingerprint).toBeTruthy();
    expect(fa.fingerprint).not.toBe(fb.fingerprint);
    // 同一分支重复读：稳定
    expect(fp(await readOne(dir), "fp.txt")).toBe(fb.fingerprint);
  });

  it("工作区等量替换（行数不变、内容变了）指纹跟着变；改回原样文件就从清单里消失", async () => {
    const dir = newRepo("fp-swap", { "k.txt": "k1\nz\n" });
    write(dir, "k.txt", "k2\nz\n");
    const f2 = fp(await readOne(dir), "k.txt");
    write(dir, "k.txt", "k3\nz\n");
    const f3 = fp(await readOne(dir), "k.txt");
    expect(f2).toBeTruthy();
    expect(f3).toBeTruthy();
    expect(f2).not.toBe(f3);
    expect(f3).toBe(`${short(git(dir, "rev-parse", "main:k.txt"))}..${short(git(dir, "hash-object", "k.txt"))}`);

    write(dir, "k.txt", "k1\nz\n");
    expect(pathsOf(await readOne(dir))).not.toContain("k.txt");
  });

  it("部分暂存（暂存的是 v2、工作区又改成 v3）：新侧是工作区的 v3", async () => {
    const dir = newRepo("fp-partial", { "p.txt": "v1\n" });
    write(dir, "p.txt", "v2\n");
    git(dir, "add", "p.txt");
    write(dir, "p.txt", "v3\n");
    const r = await readOne(dir);
    expect(fp(r, "p.txt")).toBe(
      `${short(git(dir, "rev-parse", "main:p.txt"))}..${short(blobOid("v3\n"))}`,
    );
  });

  it("重命名：纯重命名两侧是同一个 blob；删除：新侧是 -", async () => {
    const dir = newRepo("fp-rename", { "old.txt": "same\ncontent\n", "gone.txt": "bye\n" });
    git(dir, "mv", "old.txt", "new.txt");
    git(dir, "rm", "-q", "gone.txt");
    const r = await readOne(dir);

    const renamed = r.files.find((f) => f.path === "new.txt");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.oldPath).toBe("old.txt");
    const blob = short(git(dir, "rev-parse", "main:old.txt"));
    expect(renamed?.fingerprint).toBe(`${blob}..${blob}`);

    const gone = r.files.find((f) => f.path === "gone.txt");
    expect(gone?.status).toBe("deleted");
    expect(gone?.fingerprint).toBe(`${short(git(dir, "rev-parse", "main:gone.txt"))}..-`);
  });

  it("单个提交的范围：两侧都是真实 blob（父提交里的 / 这个提交里的）", async () => {
    const dir = newRepo("fp-commit", { "c.txt": "c1\n" });
    write(dir, "c.txt", "c2\n");
    const sha = commitAll(dir, "c2");
    const r = await readOne(dir, { scope: { kind: "commit", sha } });
    expect(fp(r, "c.txt")).toBe(
      `${short(git(dir, "rev-parse", `${sha}^:c.txt`))}..${short(git(dir, "rev-parse", `${sha}:c.txt`))}`,
    );
  });

  it("未跟踪文件：旧侧是 -，新侧是内容的 oid；同大小、同 mtime 改内容也会变；add / commit 前后指纹字符串不变", async () => {
    const dir = newRepo("fp-untracked", { "t.txt": "t\n" });
    const abs = path.join(dir, "u.txt");
    write(dir, "u.txt", "hello\n");
    fs.utimesSync(abs, 1_700_000_000, 1_700_000_000);
    const untracked = fp(await readOne(dir), "u.txt");
    expect(untracked).toBe(`-..${short(blobOid("hello\n"))}`);

    // 同大小、同 mtime、内容不同：「大小:时间」抓不住，内容 oid 抓得住
    write(dir, "u.txt", "HELLO\n");
    fs.utimesSync(abs, 1_700_000_000, 1_700_000_000);
    const changed = fp(await readOne(dir), "u.txt");
    expect(changed).toBe(`-..${short(blobOid("HELLO\n"))}`);
    expect(changed).not.toBe(untracked);

    // 暂存、提交之后 git 自己给 oid（旧侧全零统一写成 -）：指纹字符串一字不差，「已查看」不会因此失效
    git(dir, "add", "u.txt");
    expect(fp(await readOne(dir), "u.txt")).toBe(changed);
    commitAll(dir, "add u");
    expect(fp(await readOne(dir), "u.txt")).toBe(changed);
  });

  it("未跟踪的二进制文件也按内容 oid；超过读盘上限的大文件退回「大小:修改时间」", async () => {
    const dir = newRepo("fp-untracked-bin", { "t.txt": "t\n" });
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    write(dir, "b.bin", bin);
    const r1 = await readOne(dir);
    expect(r1.files.find((f) => f.path === "b.bin")?.binary).toBe(true);
    expect(fp(r1, "b.bin")).toBe(`-..${short(blobOid(bin))}`);

    // 1MB + 1 字节：服务端不读全文（上限 MAX_UNTRACKED_STAT_BYTES = 1MB，同值写在这里；改了上限这条会提醒）
    write(dir, "big.txt", Buffer.alloc(1024 * 1024 + 1, 97));
    expect(fp(await readOne(dir), "big.txt")).toMatch(/^-\.\.m1048577:\d+$/);
  });

  it.skipIf(!HAS_SYMLINK)(
    "符号链接：按链接目标算（与 git 自己给的 oid 逐位一致），绝不跟随到链接指向的文件",
    async () => {
      write(TMP, "outside-target.txt", "secret v1\n");
      const dir = path.join(TMP, "fp-symlink");
      initRepo(dir);
      write(dir, "a.txt", "a\n");
      write(dir, "b.txt", "b\n");
      fs.symlinkSync("a.txt", path.join(dir, "lnk"));
      commitAll(dir, "base");
      git(dir, "checkout", "-q", "-b", "feat");

      // tracked 链接改指向 b.txt（未暂存）：新侧 = 链接目标文本 "b.txt" 的 blob
      fs.unlinkSync(path.join(dir, "lnk"));
      fs.symlinkSync("b.txt", path.join(dir, "lnk"));
      const unstaged = fp(await readOne(dir), "lnk");
      expect(unstaged).toBe(`${short(git(dir, "rev-parse", "main:lnk"))}..${short(blobOid("b.txt"))}`);
      // 暂存后 git 自己给的 oid 与我们补算的字符串一致
      git(dir, "add", "lnk");
      expect(fp(await readOne(dir), "lnk")).toBe(unstaged);

      // 指向仓外文件：那个文件的内容变化，指纹不变（没有跟随）
      fs.unlinkSync(path.join(dir, "lnk"));
      fs.symlinkSync(OUTSIDE, path.join(dir, "lnk"));
      const before = fp(await readOne(dir), "lnk");
      write(TMP, "outside-target.txt", "secret v2 — changed\n");
      expect(fp(await readOne(dir), "lnk")).toBe(before);
      expect(before).toBe(`${short(git(dir, "rev-parse", "main:lnk"))}..${short(blobOid(OUTSIDE))}`);

      // 未跟踪的链接
      fs.symlinkSync("a.txt", path.join(dir, "lnk-untracked"));
      expect(fp(await readOne(dir), "lnk-untracked")).toBe(`-..${short(blobOid("a.txt"))}`);
    },
  );

  it("大批量（超过哈希个数上限、且要分多批）：前 N 个按内容算、其余退回大小:时间；多批映射不错位", async () => {
    const N = MAX_HASH_FILES + 30;
    const dirName = "d".repeat(60);
    const rels = Array.from(
      { length: N },
      (_, i) => `${dirName}/file-${String(i).padStart(3, "0")}.txt`,
    );
    // 自检：这些路径合起来一定超过一批的上限，用例才真的覆盖了「多批」
    expect(MAX_HASH_FILES * (rels[0].length + 1)).toBeGreaterThan(HASH_BATCH_CHARS);

    workingHashCache.clear();
    const dir = newRepo("fp-bulk", Object.fromEntries(rels.map((rel, i) => [rel, `base ${i}\n`])));
    rels.forEach((rel, i) => write(dir, rel, `changed ${i}\n`));
    const r = await readOne(dir);
    expect(r.files).toHaveLength(N);

    const hashed = r.files.filter((f) => /^[0-9a-f]{12}\.\.[0-9a-f]{12}$/.test(f.fingerprint ?? ""));
    const fallback = r.files.filter((f) => /\.\.m\d+:\d+$/.test(f.fingerprint ?? ""));
    expect(hashed).toHaveLength(MAX_HASH_FILES);
    expect(fallback).toHaveLength(N - MAX_HASH_FILES);

    // 被哈希的必须恰好是清单顺序里的前 N 个：并发 lstat 的完成顺序不定，裁剪要稳定；
    // 否则同一个文件在两次轮询之间会一会儿是 oid、一会儿是「大小:时间」，「已查看」就反复失效
    expect(hashed.map((f) => f.path).sort()).toEqual(rels.slice(0, MAX_HASH_FILES));
    expect(fallback.map((f) => f.path).sort()).toEqual(rels.slice(MAX_HASH_FILES));
    // 连读几次：每个文件拿到的指纹逐一不变（文件没动、分配不抖）
    for (let round = 0; round < 3; round += 1) {
      const again = await readOne(dir);
      expect(
        again.files.map((f) => [f.path, f.fingerprint]),
        `第 ${round + 2} 次读`,
      ).toEqual(r.files.map((f) => [f.path, f.fingerprint]));
    }

    // 暂存后 git 自己给每个文件的 oid：按内容算的那些必须一字不差（每个文件内容都不同——错位就会露馅）
    const before = new Map(r.files.map((f) => [f.path, f.fingerprint]));
    git(dir, "add", "-A");
    const staged = await readOne(dir);
    for (const f of staged.files) {
      const b = before.get(f.path);
      if (b === undefined || /\.\.m\d+:\d+$/.test(b)) continue;
      expect(f.fingerprint, f.path).toBe(b);
    }
  }, 60_000); // 130 个文件、分多批起 git、连读 4 次：本机并发下已超过 1s，CI 的 2 核机器更慢，别靠默认 5s 碰运气

  it("并发 lstat 即使整个倒序完成，被哈希的也仍然是清单里的前 N 个（裁剪不依赖完成顺序）", async () => {
    const N = MAX_HASH_FILES + 20;
    const rels = Array.from({ length: N }, (_, i) => `ord/file-${String(i).padStart(3, "0")}.txt`);
    workingHashCache.clear();
    const dir = newRepo("fp-order", Object.fromEntries(rels.map((rel, i) => [rel, `base ${i}\n`])));
    rels.forEach((rel, i) => write(dir, rel, `changed ${i}\n`));

    const realLstat = fs.promises.lstat.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fs.promises.lstat>
    ) => {
      const m = /file-(\d{3})\.txt$/.exec(String(args[0]));
      // 序号越小越晚完成：把完成顺序整个倒过来（真实并发下是否有序全凭运气，这里让它确定地乱）
      if (m) await new Promise((resolve) => setTimeout(resolve, (N - Number(m[1])) * 2));
      return realLstat(...args);
    }) as never);
    try {
      const r = await readOne(dir);
      expect(spy).toHaveBeenCalled();
      const hashed = r.files.filter((f) => /^[0-9a-f]{12}\.\.[0-9a-f]{12}$/.test(f.fingerprint ?? ""));
      expect(hashed.map((f) => f.path).sort()).toEqual(rels.slice(0, MAX_HASH_FILES));
    } finally {
      spy.mockRestore();
    }
  }, 60_000); // 120 个文件 + 人为错开完成顺序：本机并发下接近 1s，CI 的 2 核机器更慢，别靠默认 5s 碰运气

  it("只读：读清单 / 单文件 diff / 提交列表不会写对象库、不会碰 index、不会动 ref", async () => {
    const dir = newRepo("fp-readonly", { "r.txt": "r1\n" });
    write(dir, "r.txt", "r2\n");
    git(dir, "status", "--porcelain"); // 先把 index 的 stat 缓存刷新到位：之后任何变化都是我们造成的
    const snapshot = () => ({
      objects: git(dir, "count-objects", "-v"),
      index: createHash("sha1")
        .update(fs.readFileSync(path.join(dir, ".git", "index")))
        .digest("hex"),
      head: git(dir, "rev-parse", "HEAD"),
      refs: git(dir, "for-each-ref"),
    });
    const before = snapshot();

    for (let i = 0; i < 3; i++) {
      const r = await readOne(dir);
      // 确实走了「补算工作区哈希」这条路径
      expect(fp(r, "r.txt")).toBe(`${short(git(dir, "rev-parse", "main:r.txt"))}..${short(blobOid("r2\n"))}`);
    }
    await readTaskChangeCommits(chatTask(dir));
    await readTaskChangeFileDiff(chatTask(dir), dir, "r.txt", null);

    expect(snapshot()).toEqual(before);
  });
});

// ======================================================================
// 清单边角：嵌套 git 仓库 / 用户配了 textconv
// ======================================================================

describe("嵌套 git 仓库（未跟踪目录里自带 .git）", () => {
  it("清单里是一项带标注的目录（路径不带尾斜杠、没有行数、没有指纹），不会把它里面的文件列进来", async () => {
    const dir = newRepo("nested-repo", { "m.txt": "m\n" });
    const nested = path.join(dir, "sub", "nested");
    initRepo(nested);
    write(nested, "inner.txt", "NESTED-SECRET-MARK\n");
    commitAll(nested, "inner");
    write(dir, "sub/plain.txt", "plain\n");

    const r = await readOne(dir);
    expect(pathsOf(r)).toEqual(["sub/nested", "sub/plain.txt"]);
    const item = r.files.find((f) => f.path === "sub/nested");
    expect(item).toMatchObject({
      status: "added",
      untracked: true,
      nestedRepo: true,
      added: null,
      removed: 0,
      binary: false,
    });
    expect(item?.fingerprint).toBeUndefined();
    expect(item?.absolutePath).toBe(path.join(dir, "sub", "nested"));
    // 普通未跟踪文件不受影响
    expect(r.files.find((f) => f.path === "sub/plain.txt")).toMatchObject({
      untracked: true,
      added: 1,
    });
    expect(r.files.find((f) => f.path === "sub/plain.txt")?.nestedRepo).toBeUndefined();
    // 合计只算真有统计的：嵌套仓库不贡献行数
    expect(r.totals).toEqual({ files: 2, added: 1, removed: 0 });
  });

  it("接口层：带尾斜杠的路径仍是非法路径（400）；直接问这个目录 / 它里面的文件，也读不到嵌套仓库里的内容", async () => {
    const dir = newRepo("nested-repo-api", { "m.txt": "m\n" });
    const nested = path.join(dir, "nested");
    initRepo(nested);
    write(nested, "inner.txt", "NESTED-SECRET-MARK\n");
    commitAll(nested, "inner");
    const task = chatTask(dir);

    const withSlash = await readTaskChangeFileDiff(task, dir, "nested/", null);
    expect(withSlash).toMatchObject({ ok: false, status: 400 });

    for (const rel of ["nested", "nested/inner.txt"]) {
      const res = await readTaskChangeFileDiff(task, dir, rel, null);
      expect(JSON.stringify(res), rel).not.toContain("NESTED-SECRET-MARK");
    }
  });
});

describe("用户配了 textconv 驱动", () => {
  it.skipIf(process.platform === "win32")(
    "清单行数与单文件 diff 同口径（按原文）；单文件 diff 不会被 textconv 转成空",
    async () => {
      const dir = newRepo("textconv", { ".gitattributes": "*.dat diff=empty\n", "f.dat": "a\nb\n" });
      // textconv 命令不输出任何内容：不加 --no-textconv 的话，patch 会被转成空文本
      git(dir, "config", "diff.empty.textconv", "true");
      write(dir, "f.dat", "a\nB\nc\n");

      const f = (await readOne(dir)).files.find((x) => x.path === "f.dat");
      expect([f?.added, f?.removed]).toEqual([2, 1]);
      const res = await readTaskChangeFileDiff(chatTask(dir), dir, "f.dat", null);
      expect(res.ok && res.data.diff).toContain("+B");
      expect(res.ok && res.data.diff).toContain("+c");
    },
  );
});

// ======================================================================
// 哈希成本控制
// ======================================================================

describe("哈希成本控制：缓存", () => {
  it("磁盘状态没变就不重复读盘：刚改过的不缓存，过了新鲜窗口才缓存、之后命中；改了就不会命中旧值", async () => {
    // 只假造 Date：缓存的「新鲜窗口」按 Date.now 算，不影响定时器 / 子进程超时
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const dir = newRepo("fp-cache", { "c.txt": "c1\n" });
      write(dir, "c.txt", "c2\n");
      workingHashCache.clear();

      const first = fp(await readOne(dir), "c.txt");
      expect(first).toBe(`${short(git(dir, "rev-parse", "main:c.txt"))}..${short(blobOid("c2\n"))}`);
      expect(workingHashCache.size()).toBe(0); // 刚写入：太新，不缓存

      vi.setSystemTime(Date.now() + HASH_CACHE_MIN_AGE_MS + 5000);
      expect(fp(await readOne(dir), "c.txt")).toBe(first);
      expect(workingHashCache.size()).toBe(1); // 够老了：写入缓存

      const hitsBefore = workingHashCache.stats().hits;
      expect(fp(await readOne(dir), "c.txt")).toBe(first);
      expect(workingHashCache.stats().hits).toBe(hitsBefore + 1); // 命中

      // 同样大小、不同内容：磁盘状态（mtime / ctime）变了 → 不会命中旧值
      write(dir, "c.txt", "c9\n");
      const changed = fp(await readOne(dir), "c.txt");
      expect(changed).toBe(`${short(git(dir, "rev-parse", "main:c.txt"))}..${short(blobOid("c9\n"))}`);
      expect(changed).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("命中缓存就不读盘：往缓存里预置一个不可能的指纹，清单里原样看到它；磁盘状态一变就不再命中", async () => {
    const dir = newRepo("fp-poison", { "p.txt": "p1\n" });
    write(dir, "p.txt", "p2\n");
    workingHashCache.clear();

    // 键用「读盘前」的磁盘状态：路径 + 大小 + mtime + ctime + inode（和实现取同一份 lstat）
    const key = hashCacheKey(dir, "p.txt", fs.lstatSync(path.join(dir, "p.txt")));
    workingHashCache.set(key, "feedfacefeed", 0, 0); // 0：绕过「刚改过不缓存」

    const base = short(git(dir, "rev-parse", "main:p.txt"));
    expect(fp(await readOne(dir), "p.txt")).toBe(`${base}..feedfacefeed`);

    // 重写文件（同样 3 字节）：磁盘状态变了 → 不会再拿到预置的值，而是现算的真实指纹
    write(dir, "p.txt", "p3\n");
    expect(fp(await readOne(dir), "p.txt")).toBe(`${base}..${short(blobOid("p3\n"))}`);
  });
});

describe("哈希成本控制：未跟踪文件的读盘", () => {
  /** 恰好 bytes 字节、以换行结尾的文本；tag 不同内容就不同（错位 / 串文件一眼看出来） */
  const bigText = (tag: string, bytes: number): string => {
    const line = `${tag} ${"x".repeat(60)}\n`;
    return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes - 1) + "\n";
  };
  const lineCount = (s: string): number => s.split("\n").length - 1;
  const mkdir = (name: string): string => {
    const dir = path.join(TMP, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const KB900 = 900 * 1024;
  // 「不做 racy 保护」的缓存。minAgeMs 必须是负数而不是 0：Date.now() 只到整毫秒、文件 mtime 带小数毫秒，
  // 机器够快时「写文件 → 读 → 写缓存」在同一毫秒内跑完，now − mtime 会是 −0.4，minAge=0 也会被判成「刚改过」而拒绝缓存
  //（实测偶发，越跑越容易复现）。真正的 racy 行为由「刚改过的文件不进缓存」那条用真实窗口单独验证
  const freshCache = () => createHashCache({ max: 100, minAgeMs: -1_000 });

  it("预算：按清单顺序消耗；超出的退回「大小:修改时间」、不读也不数行；实际读盘量不超过预算", async () => {
    const dir = mkdir("ub-budget");
    const rels = ["u/f1.txt", "u/f2.txt", "u/f3.txt"];
    const contents = ["a", "b", "c"].map((t) => bigText(t, KB900));
    rels.forEach((rel, i) => write(dir, rel, contents[i]));

    const { stats, readBytes } = await statUntrackedBatch(dir, rels, {
      budgetBytes: 2 * 1024 * 1024,
      cache: freshCache(),
    });
    expect(readBytes).toBe(2 * KB900);
    for (const i of [0, 1]) {
      expect(stats.get(rels[i]), rels[i]).toEqual({
        added: lineCount(contents[i]),
        binary: false,
        fingerprint: `-..${short(blobOid(contents[i]))}`,
      });
    }
    const third = stats.get(rels[2]);
    expect(third?.added).toBeNull();
    expect(third?.binary).toBe(false);
    expect(third?.fingerprint).toMatch(new RegExp(`^-\\.\\.m${KB900}:\\d+$`));
  });

  it("预算为 0：非空文件都退回；空文件读盘零成本，照常数行（0 行）", async () => {
    const dir = mkdir("ub-zero");
    write(dir, "z/empty.txt", "");
    write(dir, "z/some.txt", "x\n");
    const { stats, readBytes } = await statUntrackedBatch(dir, ["z/empty.txt", "z/some.txt"], {
      budgetBytes: 0,
      cache: freshCache(),
    });
    expect(readBytes).toBe(0);
    expect(stats.get("z/empty.txt")).toEqual({ added: 0, binary: false, fingerprint: `-..${short(blobOid(""))}` });
    expect(stats.get("z/some.txt")?.added).toBeNull();
    expect(stats.get("z/some.txt")?.fingerprint).toMatch(/^-\.\.m2:\d+$/);
  });

  it("命中缓存的不占预算：预算耗尽了照样完整显示（行数 + 内容指纹），也不读盘", async () => {
    const dir = mkdir("ub-cache-free");
    const rels = ["u/f1.txt", "u/f2.txt", "u/f3.txt"];
    rels.forEach((rel, i) => write(dir, rel, bigText(String(i), KB900)));
    const cache = freshCache();

    const first = await statUntrackedBatch(dir, rels, { budgetBytes: 10 * 1024 * 1024, cache });
    expect(first.readBytes).toBe(3 * KB900);
    const second = await statUntrackedBatch(dir, rels, { budgetBytes: 0, cache });
    expect(second.readBytes).toBe(0);
    expect(second.stats).toEqual(first.stats);
  });

  it("多轮读取会收敛：每轮预算只够读几个，读过的靠缓存不再占预算，几轮后全部变成内容 oid，之后读盘为 0", async () => {
    const dir = mkdir("ub-converge");
    const rels = Array.from({ length: 6 }, (_, i) => `c/f-${i}.txt`);
    const contents = rels.map((_, i) => bigText(String(i), KB900));
    rels.forEach((rel, i) => write(dir, rel, contents[i]));
    const cache = freshCache();
    const budget = 2 * KB900 + 10; // 每轮恰好放得下 2 个新的

    const isOid = (fingerprint: string | undefined) => /^-\.\.[0-9a-f]{12}$/.test(fingerprint ?? "");
    const rounds: number[] = [];
    const reads: number[] = [];
    let last = await statUntrackedBatch(dir, rels, { budgetBytes: budget, cache });
    for (let i = 0; i < 6; i += 1) {
      rounds.push(rels.filter((rel) => isOid(last.stats.get(rel)?.fingerprint)).length);
      reads.push(last.readBytes);
      if (rounds[i] === rels.length) break;
      last = await statUntrackedBatch(dir, rels, { budgetBytes: budget, cache });
    }
    // 2 → 4 → 6：每轮新读 2 个（命中缓存的不占预算），第 3 轮收敛
    expect(rounds).toEqual([2, 4, 6]);
    expect(reads).toEqual([2 * KB900, 2 * KB900, 2 * KB900]);
    // 收敛之后：每个指纹都是自己内容的 oid、行数对，再读一轮读盘为 0
    rels.forEach((rel, i) => {
      expect(last.stats.get(rel), rel).toEqual({
        added: lineCount(contents[i]),
        binary: false,
        fingerprint: `-..${short(blobOid(contents[i]))}`,
      });
    });
    const steady = await statUntrackedBatch(dir, rels, { budgetBytes: budget, cache });
    expect(steady.readBytes).toBe(0);
    expect(steady.stats).toEqual(last.stats);
  });

  it("缓存确实被用：预置一个不可能的摘要原样拿到；磁盘状态一变就不再命中；格式不对的值当没命中、重新读", async () => {
    const dir = mkdir("ub-poison");
    const rel = "p/poison.txt";
    write(dir, rel, "p1\n");
    const cache = freshCache();
    const keyOf = () => hashCacheKey(dir, rel, fs.lstatSync(path.join(dir, rel)));

    cache.set(keyOf(), encodeUntrackedSummary({ added: 999, binary: false, oid: "feedfacefeed" }), 0, 0);
    const hit = await statUntrackedBatch(dir, [rel], { cache });
    expect(hit.stats.get(rel)).toEqual({ added: 999, binary: false, fingerprint: "-..feedfacefeed" });
    expect(hit.readBytes).toBe(0);

    // 重写文件（同样 3 字节）：磁盘状态变了 → 不会再拿到预置的值
    await new Promise((resolve) => setTimeout(resolve, 20));
    write(dir, rel, "p2\n");
    const miss = await statUntrackedBatch(dir, [rel], { cache });
    expect(miss.stats.get(rel)).toEqual({ added: 1, binary: false, fingerprint: `-..${short(blobOid("p2\n"))}` });
    expect(miss.readBytes).toBe(3);

    // 缓存里的值被污染 / 格式变了：不能当成有效摘要，重新读（并覆盖成合法值）
    cache.set(keyOf(), "garbage", 0, 0);
    const healed = await statUntrackedBatch(dir, [rel], { cache });
    expect(healed.stats.get(rel)?.fingerprint).toBe(`-..${short(blobOid("p2\n"))}`);
    expect(healed.readBytes).toBe(3);
    expect(cache.get(keyOf())).toMatch(/^\d+:[01]:[0-9a-f]+$/);
  });

  it("刚改过的文件不进缓存（racy 保护），过了新鲜窗口才缓存", async () => {
    const dir = mkdir("ub-racy");
    write(dir, "r/new.txt", "n1\n");
    const cache = createHashCache({ max: 100, minAgeMs: HASH_CACHE_MIN_AGE_MS });
    await statUntrackedBatch(dir, ["r/new.txt"], { cache });
    expect(cache.size()).toBe(0);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + HASH_CACHE_MIN_AGE_MS + 5000);
      await statUntrackedBatch(dir, ["r/new.txt"], { cache });
      expect(cache.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("裁剪顺序稳定：并发 lstat 整个倒序完成，被读盘的也仍是清单里的前几个；连读几次分配不抖", async () => {
    const dir = mkdir("ub-order");
    const rels = Array.from({ length: 12 }, (_, i) => `o/file-${String(i).padStart(3, "0")}.txt`);
    rels.forEach((rel, i) => write(dir, rel, bigText(String(i), KB900)));

    const realLstat = fs.promises.lstat.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fs.promises.lstat>
    ) => {
      const m = /file-(\d{3})\.txt$/.exec(String(args[0]));
      if (m) await new Promise((resolve) => setTimeout(resolve, (rels.length - Number(m[1])) * 3));
      return realLstat(...args);
    }) as never);
    try {
      const budget = 4 * KB900 + 10; // 恰好放得下 4 个
      const readSet = async () => {
        const r = await statUntrackedBatch(dir, rels, { budgetBytes: budget, cache: freshCache() });
        return rels.filter((rel) => /^-\.\.[0-9a-f]{12}$/.test(r.stats.get(rel)?.fingerprint ?? ""));
      };
      expect(spy).not.toHaveBeenCalled();
      const first = await readSet();
      expect(spy).toHaveBeenCalled();
      expect(first).toEqual(rels.slice(0, 4));
      for (let round = 0; round < 2; round += 1) expect(await readSet(), `第 ${round + 2} 次`).toEqual(first);
    } finally {
      spy.mockRestore();
    }
  });

  it("端到端：清单里未跟踪文件的读盘总量有上限（默认 64MB 预算），超出的退回、而且是清单里靠后的那些", async () => {
    const dir = newRepo("ub-e2e", { "keep.txt": "k\n" });
    const N = 80;
    const SIZE = 1_000_000; // 略小于单文件 1MB 上限
    const rels = Array.from({ length: N }, (_, i) => `big/f-${String(i).padStart(3, "0")}.txt`);
    rels.forEach((rel, i) => write(dir, rel, bigText(String(i), SIZE)));
    untrackedSummaryCache.clear();

    const r = await readOne(dir);
    const fit = Math.floor(MAX_HASH_TOTAL_BYTES / SIZE);
    expect(fit).toBeLessThan(N); // 自检：确实超过预算了
    const read = r.files.filter((f) => /^-\.\.[0-9a-f]{12}$/.test(f.fingerprint ?? ""));
    const fallback = r.files.filter((f) => /^-\.\.m\d+:\d+$/.test(f.fingerprint ?? ""));
    expect(read.map((f) => f.path).sort()).toEqual(rels.slice(0, fit));
    expect(fallback).toHaveLength(N - fit);
    expect(fallback.every((f) => f.added === null && !f.binary)).toBe(true);
    // 被读的每个文件，行数与指纹都来自它自己的内容（tag 位数不同 → 每行长度不同 → 行数也不同，串文件就会露馅）
    for (const f of read) {
      const i = Number(/f-(\d{3})\.txt$/.exec(f.path)?.[1]);
      const content = bigText(String(i), SIZE);
      expect(f.added, f.path).toBe(lineCount(content));
      expect(f.fingerprint, f.path).toBe(`-..${short(blobOid(content))}`);
    }
  });

  it(
    "端到端：已跟踪文件的哈希先占用总预算，剩下的才轮到未跟踪（两边共用同一份 64MB）",
    async () => {
      const TRACKED = 3;
      const TRACKED_SIZE = 19 * 1024 * 1024; // 在单文件 20MB 上限内、都能被哈希；3 个合计 57MB
      const UN = 9;
      const SIZE = 1_000_000;
      expect(TRACKED_SIZE).toBeLessThanOrEqual(MAX_HASH_FILE_BYTES); // 自检

      const trackedRels = Array.from({ length: TRACKED }, (_, i) => `t/tracked-${i}.txt`);
      // HEAD 里是小文件、工作区改写成大文件：旧侧 oid 来自 git、不用读 HEAD 的内容，夹具便宜
      const dir = newRepo("ub-shared", Object.fromEntries(trackedRels.map((rel) => [rel, "old\n"])));
      trackedRels.forEach((rel, i) => write(dir, rel, bigText(`t${i}`, TRACKED_SIZE)));
      const unRels = Array.from({ length: UN }, (_, i) => `u/f-${String(i).padStart(3, "0")}.txt`);
      unRels.forEach((rel, i) => write(dir, rel, bigText(`u${i}`, SIZE)));
      workingHashCache.clear();
      untrackedSummaryCache.clear();

      const r = await readOne(dir);

      // 已跟踪的先用预算：3 个都在预算内，指纹是「旧..新」的完整形态
      for (const rel of trackedRels) expect(fp(r, rel), rel).toMatch(/^[0-9a-f]{12}\.\.[0-9a-f]{12}$/);

      // 未跟踪的只剩 64MB − 3×19MB 可用：按清单顺序读前几个、靠后的退回「大小:修改时间」
      const left = MAX_HASH_TOTAL_BYTES - TRACKED * TRACKED_SIZE;
      const fit = Math.floor(left / SIZE);
      expect(fit).toBeGreaterThan(0); // 自检：还剩一点
      expect(fit).toBeLessThan(UN); // 自检：但放不下全部（否则「共用」与「各用各的」分不出来）
      const untracked = r.files.filter((f) => f.untracked);
      expect(untracked.map((f) => f.path).sort()).toEqual(unRels);
      const read = untracked.filter((f) => /^-\.\.[0-9a-f]{12}$/.test(f.fingerprint ?? ""));
      const fallback = untracked.filter((f) => /^-\.\.m\d+:\d+$/.test(f.fingerprint ?? ""));
      expect(read.map((f) => f.path).sort()).toEqual(unRels.slice(0, fit));
      expect(fallback.map((f) => f.path).sort()).toEqual(unRels.slice(fit));
      expect(fallback.every((f) => f.added === null && !f.binary)).toBe(true);
    },
    60_000,
  );

  it("嵌套仓库项不占「最多处理多少个」的额度：排在最前面也不挤掉普通文件；超出个数的只标新文件、不读盘、没有指纹", async () => {
    const dir = newRepo("ub-quota", { "keep.txt": "k\n" });
    const nested = path.join(dir, "a-nested"); // 字典序排在 f/ 之前
    fs.mkdirSync(nested);
    git(nested, "init", "-q");
    write(nested, "x.txt", "x\n");
    const N = MAX_UNTRACKED_STAT_FILES + 5;
    const rels = Array.from({ length: N }, (_, i) => `f/file-${String(i).padStart(3, "0")}.txt`);
    rels.forEach((rel, i) => write(dir, rel, `n ${i}\n`));
    untrackedSummaryCache.clear();

    const r = await readOne(dir);
    expect(r.files.find((f) => f.nestedRepo)?.path).toBe("a-nested");
    const plain = r.files.filter((f) => f.untracked && !f.nestedRepo);
    expect(plain.map((f) => f.path).sort()).toEqual(rels);
    const counted = plain.filter((f) => f.added === 1);
    const skipped = plain.filter((f) => f.added === null);
    expect(counted.map((f) => f.path).sort()).toEqual(rels.slice(0, MAX_UNTRACKED_STAT_FILES));
    expect(skipped.map((f) => f.path).sort()).toEqual(rels.slice(MAX_UNTRACKED_STAT_FILES));
    expect(skipped.every((f) => f.fingerprint === undefined)).toBe(true);
  });

  it("清单读取接上缓存：同样的磁盘状态第二次读命中缓存，改了内容就读到新的", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const dir = newRepo("ub-e2e-cache", { "keep.txt": "k\n" });
      write(dir, "n/new.txt", "v1\n");
      untrackedSummaryCache.clear();

      const first = await readOne(dir);
      expect(fp(first, "n/new.txt")).toBe(`-..${short(blobOid("v1\n"))}`);
      expect(untrackedSummaryCache.size()).toBe(0); // 刚写入：太新，不缓存

      vi.setSystemTime(Date.now() + HASH_CACHE_MIN_AGE_MS + 5000);
      await readOne(dir);
      expect(untrackedSummaryCache.size()).toBe(1); // 够老了：写入
      const hitsBefore = untrackedSummaryCache.stats().hits;
      expect(fp(await readOne(dir), "n/new.txt")).toBe(`-..${short(blobOid("v1\n"))}`);
      expect(untrackedSummaryCache.stats().hits).toBe(hitsBefore + 1);

      // 同样大小、不同内容：磁盘状态变了，读到新的
      write(dir, "n/new.txt", "v2\n");
      expect(fp(await readOne(dir), "n/new.txt")).toBe(`-..${short(blobOid("v2\n"))}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("两种缓存不串：文件先以「未跟踪」被缓存、再 git add -N 变成已跟踪（磁盘上一个字节没动、缓存键不变），指纹仍是对的", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const dir = newRepo("ub-add-n", { "keep.txt": "k\n" });
      write(dir, "n/new.txt", "v1\n");
      workingHashCache.clear();
      untrackedSummaryCache.clear();
      const expected = `-..${short(blobOid("v1\n"))}`;

      vi.setSystemTime(Date.now() + HASH_CACHE_MIN_AGE_MS + 5000); // 文件够老了：读到的摘要进缓存
      expect(fp(await readOne(dir), "n/new.txt")).toBe(expected);
      expect(untrackedSummaryCache.size()).toBe(1);

      // 登记「将来要加」：路径从未跟踪变成已跟踪，补算新侧 oid 走的是另一条路径、另一份缓存
      git(dir, "add", "-N", "n/new.txt");
      const after = await readOne(dir);
      expect(after.files.find((f) => f.path === "n/new.txt")?.untracked).not.toBe(true); // 自检：确实换了路径
      expect(fp(after, "n/new.txt")).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ======================================================================
// single-flight
// ======================================================================

describe("同参数并发读取合并成一次（single-flight）", () => {
  it("并发同参数拿到同一份结果；不同参数不合并；读完不缓存（下一轮读最新磁盘）", async () => {
    const dir = newRepo("fp-flight", { "s.txt": "s1\n" });
    write(dir, "s.txt", "s2\n");
    const task = chatTask(dir);

    const [x, y] = await Promise.all([readTaskChanges(task), readTaskChanges(task)]);
    expect(y).toBe(x);

    const [ws, uncommitted] = await Promise.all([
      readTaskChanges(task, { ignoreWs: true }),
      readTaskChanges(task, { scope: { kind: "uncommitted" } }),
    ]);
    expect(ws).not.toBe(x);
    expect(uncommitted).not.toBe(x);

    // 读完就摘掉：磁盘变了，下一次拿到的必须是新内容、而不是缓存
    write(dir, "s.txt", "s3 — a much longer line\n");
    const next = await readTaskChanges(task);
    expect(next).not.toBe(x);
    expect(next.repos[0].files[0].fingerprint).not.toBe(x.repos[0].files[0].fingerprint);
  });

  it("读取失败不会卡死后续请求（key 一定被摘掉）", async () => {
    const task: TaskChangesTaskLike = {
      mode: "chat",
      repoPaths: [path.join(TMP, "no-such-dir")],
      workCwd: path.join(TMP, "no-such-dir"),
    };
    const first = await readTaskChanges(task);
    expect(first.repos[0].unavailable).toBe("dir_missing");
    const second = await readTaskChanges(task);
    expect(second).not.toBe(first);
    expect(second.repos[0].unavailable).toBe("dir_missing");
  });
});

// ======================================================================
// 完整 ref：同名 tag 不会让基线算错
// ======================================================================

describe("基线用完整 ref（同名 tag / 分支不串）", () => {
  it("有个叫 main 的 tag 指向更早的提交：基线仍是 main 分支，领先 / 落后 / 文件清单都对", async () => {
    const dir = path.join(TMP, "fp-tag");
    initRepo(dir);
    write(dir, "t.txt", "t0\n");
    const m1 = commitAll(dir, "m1");
    write(dir, "t.txt", "t1\n");
    commitAll(dir, "m2");
    // 与分支同名的 tag（指向更早的 m1）：简写 main 会被 git 解析成这个 tag
    git(dir, "tag", "main", m1);
    git(dir, "checkout", "-q", "-b", "feat");
    write(dir, "f.txt", "f1\n");
    commitAll(dir, "f1");
    write(dir, "f.txt", "f2\n");
    commitAll(dir, "f2");

    const r = await readOne(dir);
    expect(r.base?.label).toBe("main");
    // 基线是 main 分支的 m2：feat 领先 2 个提交；若误把 tag 当基线（m1）这里会是 3、清单里还会多出 t.txt
    expect(r.aheadOfBase).toBe(2);
    expect(r.behindBase).toBe(0);
    expect(pathsOf(r)).toEqual(["f.txt"]);
    const { repos } = await readTaskChangeCommits(chatTask(dir));
    expect(repos[0].commits.map((c) => c.subject)).toEqual(["f2", "f1"]);
  });
});

// ======================================================================
// 合并提交
// ======================================================================

describe("合并提交标注", () => {
  it("只有合并提交带 isMerge", async () => {
    const dir = newRepo("fp-merge", { "m.txt": "m\n" });
    write(dir, "f1.txt", "1\n");
    commitAll(dir, "feat-1");
    git(dir, "checkout", "-q", "-b", "side", "main");
    write(dir, "s1.txt", "s\n");
    commitAll(dir, "side-1");
    git(dir, "checkout", "-q", "feat");
    git(dir, "merge", "--no-ff", "-q", "side", "-m", "merge side");

    const { repos } = await readTaskChangeCommits(chatTask(dir));
    const commits = repos[0].commits;
    expect(commits).toHaveLength(3);
    const by = new Map(commits.map((c) => [c.subject, c]));
    expect(by.get("merge side")?.isMerge).toBe(true);
    expect(by.get("feat-1")?.isMerge).toBeUndefined();
    expect(by.get("side-1")?.isMerge).toBeUndefined();
  });
});

// ======================================================================
// 用户全局 git 配置不影响输出格式
// ======================================================================

describe("用户全局 git 配置不影响解析", () => {
  it("diff.noprefix / mnemonicPrefix 开着，单文件 diff 的文件头仍是 a/ b/；log.showSignature 开着，提交列表照常", async () => {
    const dir = newRepo("fp-config", { "g.txt": "g1\ng2\n" });
    write(dir, "g.txt", "g1\nG2\n");
    commitAll(dir, "tweak g");
    fs.writeFileSync(
      GLOBAL_CFG,
      "[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n[log]\n\tshowSignature = true\n",
    );
    try {
      const res = await readTaskChangeFileDiff(chatTask(dir), dir, "g.txt", null);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.diff).toContain("diff --git a/g.txt b/g.txt");
        expect(res.data.diff).toContain("--- a/g.txt");
        expect(res.data.diff).toContain("+++ b/g.txt");
      }
      const { repos } = await readTaskChangeCommits(chatTask(dir));
      expect(repos[0].commits.map((c) => c.subject)).toEqual(["tweak g"]);
    } finally {
      fs.writeFileSync(GLOBAL_CFG, "");
    }
  });
});

// ======================================================================
// 纯函数
// ======================================================================

describe("parseRawZ", () => {
  const O1 = "1".repeat(40);
  const O2 = "2".repeat(40);
  const Z = "0".repeat(40);

  it("修改 / 新增 / 删除 / 重命名（以新路径为键）/ 路径含空格与中文", () => {
    const out =
      [
        `:100644 100644 ${O1} ${O2} M`,
        "a.txt",
        `:000000 100644 ${Z} ${O2} A`,
        "new file.txt",
        `:100644 000000 ${O1} ${Z} D`,
        "中文.txt",
        `:100644 100644 ${O1} ${O1} R100`,
        "old.txt",
        "renamed.txt",
      ].join("\0") + "\0";
    const m = parseRawZ(out);
    expect([...m.keys()]).toEqual(["a.txt", "new file.txt", "中文.txt", "renamed.txt"]);
    expect(m.get("a.txt")).toEqual({ oldOid: O1, newOid: O2 });
    expect(m.get("new file.txt")).toEqual({ oldOid: Z, newOid: O2 });
    expect(m.get("中文.txt")).toEqual({ oldOid: O1, newOid: Z });
    expect(m.get("renamed.txt")).toEqual({ oldOid: O1, newOid: O1 });
  });

  it("路径本身以冒号开头：按顺序消费，不会被当成下一条记录的头", () => {
    const out = `:100644 100644 ${O1} ${O2} M\0:weird.txt\0:100644 100644 ${O2} ${O1} M\0b.txt\0`;
    const m = parseRawZ(out);
    expect([...m.keys()]).toEqual([":weird.txt", "b.txt"]);
  });

  it("oid 不合法 / 记录残缺 / 空输入：丢弃，不抛错", () => {
    expect(parseRawZ("").size).toBe(0);
    expect(parseRawZ(`:100644 100644 xyz ${O2} M\0a.txt\0`).size).toBe(0);
    expect(parseRawZ(`:100644 100644 ${O1} ${O2} R100\0only-old\0`).size).toBe(0);
    expect(parseRawZ("garbage\0more\0").size).toBe(0);
  });
});
