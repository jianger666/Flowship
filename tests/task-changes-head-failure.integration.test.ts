/**
 * HEAD 解析「失败」不等于「还没有任何提交」（R14 B6-4 审查补洞 / Q4-03）。
 *
 * resolveBase 在 `rev-parse --verify --quiet HEAD^{commit}` 没给出 SHA 时回退空树（空仓列文件）。--quiet 下 git 对
 * 「没有这个提交」的退出码是 1；但超时被杀 / 被信号终止（code 为 null）、退出码 128（不是仓库 / 锁 / 权限）、
 * spawn 失败也都是 ok:false——当空仓处理，会把一个有历史的正常仓库的全部已跟踪文件列成「新增」，
 * 面板还写「仓库还没有任何提交」。这些是「读不出」，应沿用不可用提示、不列任何文件。
 *
 * 做法：PATH 前面放一个假 git，只对 `rev-parse --verify --quiet HEAD^{commit}` 这一条命令模拟失败，其余原样转给真 git；
 * 用真仓库（6 个已提交文件、只改了 f1.txt）对照。断言我们自己算出来的结构（基线类型 / 文件清单），不依赖报错文案。
 * 局限：真实的 20s 超时没有等满（用「被信号杀掉」走同一条 code=null 路径）；Windows 没有 bash，整组跳过。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  readTaskChanges,
  type TaskChangesTaskLike,
} from "@/lib/server/task-changes";
import type { TaskRepoChanges } from "@/lib/types";

// 在 git hook 里跑测试时这些变量会指向「外层仓」；用户全局 git 配置也会让结果因人而异——一并隔离
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
const savedPath = process.env.PATH;

// macOS 的 tmpdir 在 /var → /private/var 的软链下，git 吐的是真实路径，统一取 realpath
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "flowship-head-failure-")));
const GLOBAL_CFG = path.join(TMP, "global-gitconfig");

let realGit = "";
let fakeSeq = 0;

beforeAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fs.writeFileSync(GLOBAL_CFG, "");
  process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
});

afterEach(() => {
  process.env.PATH = savedPath;
});

afterAll(() => {
  process.env.PATH = savedPath;
  for (const k of LEAKY_GIT_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------- 夹具

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const initRepo = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "tester");
};

/** 有历史的正常仓库：6 个已提交文件，工作区里只改了 f1.txt */
const makeNormalRepo = (name: string): string => {
  const dir = path.join(TMP, name);
  initRepo(dir);
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `line ${i}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(dir, "f1.txt"), "line 1\nchanged\n");
  return dir;
};

const chatTask = (dir: string): TaskChangesTaskLike => ({ mode: "chat", repoPaths: [dir], workCwd: dir });

const readOne = async (dir: string): Promise<TaskRepoChanges> => {
  const { repos } = await readTaskChanges(chatTask(dir), {});
  expect(repos).toHaveLength(1);
  return repos[0];
};

/** 假 git：对 `rev-parse --verify --quiet HEAD^{commit}` 执行 onHead（shell 片段），其余原样转给真 git */
const installFakeGit = (onHead: string): void => {
  const bin = path.join(TMP, `fakebin-${++fakeSeq}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "git"),
    [
      "#!/bin/bash",
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "--quiet" ] && [ "$4" = "HEAD^{commit}" ]; then',
      `  ${onHead}`,
      "fi",
      `exec "${realGit}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
};

// ---------------------------------------------------------------------- 用例

describe.skipIf(process.platform === "win32")(
  "HEAD 解析失败 ≠ 还没有任何提交：失败时不能把有历史的仓库整仓列成新增",
  { timeout: 30_000 },
  () => {
    it("对照（没有假 git）：正常仓库只列出改过的 f1.txt，基线不是空树", async () => {
      const dir = makeNormalRepo("normal");
      const r = await readOne(dir);
      expect(r.unavailable).toBeUndefined();
      expect(r.base?.kind).not.toBe("empty-tree");
      expect(r.files.map((f) => `${f.path}:${f.status}`)).toEqual(["f1.txt:modified"]);
    });

    it("HEAD 解析以退出码 128 失败（不是仓库 / 锁 / 权限那类）：读不出，不列任何文件、基线不是空树", async () => {
      const dir = makeNormalRepo("exit128");
      installFakeGit("exit 128");
      const r = await readOne(dir);
      expect(r.base?.kind).not.toBe("empty-tree");
      expect(r.files).toEqual([]);
      expect(r.unavailable).toBeTruthy();
    });

    it("HEAD 解析被信号杀掉（超时被杀走同一条 code=null 路径）：同样读不出，不当空仓", async () => {
      const dir = makeNormalRepo("killed");
      installFakeGit("kill -9 $$");
      const r = await readOne(dir);
      expect(r.base?.kind).not.toBe("empty-tree");
      expect(r.files).toEqual([]);
      expect(r.unavailable).toBeTruthy();
    });

    it("对照：真·空仓（git init 后没有任何提交，rev-parse 退出码 1）仍走空树、列出已写入的文件", async () => {
      const dir = path.join(TMP, "unborn");
      initRepo(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "a1\n");
      expect(() => git(dir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")).toThrow();
      const r = await readOne(dir);
      expect(r.unavailable).toBeUndefined();
      expect(r.base?.kind).toBe("empty-tree");
      expect(r.files.map((f) => f.path)).toEqual(["a.txt"]);
    });
  },
);
