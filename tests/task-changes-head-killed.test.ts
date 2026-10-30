/**
 * HEAD 解析「被超时杀掉、但退出码恰好是 1」≠「还没有任何提交」（R14 B6-4 P3-2 补洞 / 变更 AI 变异 Q12 存活项）。
 *
 * resolveBase 靠 runGit 回的 `exitCode === 1` 判「空仓」；runGit 只在 git 自己正常退出时才给 exitCode
 * （`typeof e.code === "number" && !e.killed && !e.signal`）。超时被杀时 Node 会把 `killed` 设成 true：
 *  - POSIX 上一般是 code = null、signal = SIGTERM —— `typeof` / `!e.signal` 已经挡住，
 *    `tests/task-changes-head-failure.integration.test.ts` 用真子进程覆盖的就是这一支；
 *  - 但进程捕获 SIGTERM 后自己 `exit 1`，或 Windows 的 TerminateProcess（退出码 1、没有 signal）会得到
 *    `{ code: 1, killed: true, signal: null }`：只有 `!e.killed` 能挡住它。没挡住 → 一个有历史的仓库只因为 git 卡了 20 秒，
 *    就被当成空仓，全部已跟踪文件列成「新增」、面板还写「仓库还没有任何提交」。
 * 真实的 20s 超时要等满 20 秒（resolveBase 不传 timeoutMs），所以这里在 execFile 层直接注入这个形状
 * （做法同 `tests/git-runner-r4.test.ts`：透传包装，只对一条 git 子命令注入错误，其余原样走真 git）。
 *
 * 断言我们自己算出来的结构（基线类型 / 文件清单 / 是否可用），不依赖报错文案。
 * 局限：注入的是 Node 报错对象的形状，没有真的等满超时、也没有在 Windows 上跑（Windows 上 TerminateProcess 的退出码是 1
 * 是 libuv / Node 文档行为，本测试没有真机验证）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  /** 返回 Error = 让这次 git 调用失败；返回 null = 透传给真 git */
  inject: null as null | ((args: string[]) => Error | null),
  calls: [] as string[][],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const real = promisify(actual.execFile) as unknown as (
    cmd: string,
    args: string[],
    opts: object,
  ) => Promise<{ stdout: string; stderr: string }>;
  const wrapper = ((...a: Parameters<typeof actual.execFile>) =>
    actual.execFile(...a)) as typeof actual.execFile;
  (wrapper as unknown as Record<symbol, unknown>)[promisify.custom] = async (
    cmd: string,
    args: string[],
    opts: object,
  ) => {
    if (cmd === "git") {
      hook.calls.push([...args]);
      const err = hook.inject?.(args);
      if (err) throw err;
    }
    return real(cmd, args, opts);
  };
  return { ...actual, execFile: wrapper };
});

import { readTaskChanges, type TaskChangesTaskLike } from "@/lib/server/task-changes";
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

// macOS 的 tmpdir 在 /var → /private/var 的软链下，git 吐的是真实路径，统一取 realpath
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "flowship-head-killed-")));
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

afterEach(() => {
  hook.inject = null;
  hook.calls.length = 0;
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
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** 有历史的正常仓库：6 个已提交文件，工作区里只改了 f1.txt */
const makeNormalRepo = (name: string): string => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "tester");
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

const isHeadVerify = (args: string[]): boolean =>
  args.join(" ") === "rev-parse --verify --quiet HEAD^{commit}";

/** Node 的 execFile 失败对象形状：{ code, killed, signal, stdout, stderr }（超时被杀时 killed = true） */
const execFailure = (shape: { code: number | null; killed: boolean; signal: string | null }): Error =>
  Object.assign(new Error("Command failed: git rev-parse --verify --quiet HEAD^{commit}\n"), {
    ...shape,
    cmd: "git rev-parse --verify --quiet HEAD^{commit}",
    stdout: "",
    stderr: "",
  });

// ---------------------------------------------------------------------- 用例

describe("HEAD 解析被超时杀掉且退出码恰好是 1：读不出，不能当空仓", { timeout: 30_000 }, () => {
  it("对照（不注入）：正常仓库只列出改过的 f1.txt，基线不是空树", async () => {
    const dir = makeNormalRepo("plain");
    const r = await readOne(dir);
    expect(r.unavailable).toBeUndefined();
    expect(r.base?.kind).not.toBe("empty-tree");
    expect(r.files.map((f) => `${f.path}:${f.status}`)).toEqual(["f1.txt:modified"]);
  });

  it("{ code: 1, killed: true, signal: null }（捕获 SIGTERM 后自己 exit 1 / Windows TerminateProcess）：读不出，不列任何文件、基线不是空树", async () => {
    const dir = makeNormalRepo("killed-exit1");
    hook.inject = (args) => (isHeadVerify(args) ? execFailure({ code: 1, killed: true, signal: null }) : null);
    const r = await readOne(dir);
    // 注入确实生效过（否则这条会因为真 git 读得出 HEAD 而「碰巧」满足下面的 files / unavailable 之外的断言）
    expect(hook.calls.some(isHeadVerify)).toBe(true);
    expect(r.base?.kind).not.toBe("empty-tree");
    expect(r.files).toEqual([]);
    expect(r.unavailable).toBeTruthy();
  });

  it("对照：同一条命令以 { code: 1, killed: false } 失败（git 自己干净地答「没有这个提交」）→ 仍走空树，证明 exit 1 这条路是通的", async () => {
    const dir = makeNormalRepo("clean-exit1");
    hook.inject = (args) => (isHeadVerify(args) ? execFailure({ code: 1, killed: false, signal: null }) : null);
    const r = await readOne(dir);
    expect(r.unavailable).toBeUndefined();
    expect(r.base?.kind).toBe("empty-tree");
    // 空树基线：所有已跟踪文件都是「新增」——和上面「读不出」时的空清单形成对比
    expect(r.files.map((f) => f.path).sort()).toEqual(["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt"]);
  });
});
