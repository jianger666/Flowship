/**
 * 变更面板：清单类 git 输出超过 maxBuffer（8MiB）时降级成「截断清单」，不能整仓 git_error。
 *
 * 旧行为：`--name-status` / `--numstat` 任一超限（`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`）就走
 * `unavailable("git_error")`——海量改动（误提交 node_modules / 构建产物 / 大规模格式化）的仓整个面板空白。
 * 现在：取被截断流里**完整**的记录；name-status 被截断 → files 只列已读到的、标 `filesTruncated`；
 * numstat 被截断 → 清单完整、没读到统计的文件行数记「未知」（null），且绝不能被误标成「仅空白改动」。
 * 其它失败（非超限）仍然整仓 git_error（不给半截清单误导）。
 *
 * 真超限要 8MiB（十万级文件），这里在 execFile 层直接注入 Node 的超限报错形状（含被截断的 stdout），做法同
 * tests/task-changes-head-killed.test.ts：只对一条 git 子命令注入、其余原样走真 git。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  /** 返回 Error = 让这次 git 调用失败；返回 null = 透传给真 git */
  inject: null as null | ((args: string[]) => Error | null),
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
      const err = hook.inject?.(args);
      if (err) throw err;
    }
    return real(cmd, args, opts);
  };
  return { ...actual, execFile: wrapper };
});

import {
  parseNameStatusZ,
  parseNumstatZ,
  readTaskChanges,
  trimToCompleteZTokens,
  type TaskChangesTaskLike,
} from "@/lib/server/task-changes";
import type { TaskRepoChanges } from "@/lib/types";

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

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "flowship-list-overflow-")));
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
});
afterAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** 有历史的仓库：f1..f4 已提交，工作区里 f1..f3 各加了一行 */
const makeRepo = (name: string): string => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "tester");
  for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `line ${i}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `line ${i}\nchanged\n`);
  return dir;
};

const chatTask = (dir: string): TaskChangesTaskLike => ({ mode: "chat", repoPaths: [dir], workCwd: dir });
const readOne = async (dir: string, opts: { ignoreWs?: boolean } = {}): Promise<TaskRepoChanges> => {
  const { repos } = await readTaskChanges(chatTask(dir), opts);
  expect(repos).toHaveLength(1);
  return repos[0];
};

/** Node execFile 超限报错的形状：code = ERR_CHILD_PROCESS_STDIO_MAXBUFFER，stdout = 被截断的那部分 */
const overflowErr = (stdout: string): Error =>
  Object.assign(new Error("stdout maxBuffer length exceeded"), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    stdout,
    stderr: "",
  });

const isNameStatus = (args: string[]): boolean => args.includes("--name-status");
const isNumstat = (args: string[]): boolean => args.includes("--numstat");

describe("trimToCompleteZTokens（纯函数）", () => {
  it("砍掉最后一个 NUL 之后的半截 token；没有 NUL → 空串", () => {
    expect(trimToCompleteZTokens("M\0a.txt\0M\0b.t")).toBe("M\0a.txt\0M\0");
    expect(trimToCompleteZTokens("M\0a.txt\0")).toBe("M\0a.txt\0");
    expect(trimToCompleteZTokens("M\0a.tx")).toBe("M\0");
    expect(trimToCompleteZTokens("半截")).toBe("");
  });

  it("截断后的流喂给解析器：残缺记录（缺路径 / 重命名缺新路径）整条丢掉，不把半截路径当文件", () => {
    expect(parseNameStatusZ(trimToCompleteZTokens("M\0a.txt\0M\0b.t")).map((e) => e.path)).toEqual(["a.txt"]);
    expect(parseNameStatusZ(trimToCompleteZTokens("M\0a.txt\0R100\0old.txt\0new.t")).map((e) => e.path)).toEqual([
      "a.txt",
    ]);
    const stats = parseNumstatZ(trimToCompleteZTokens("1\t0\ta.txt\0" + "2\t3\tb.t"));
    expect([...stats.keys()]).toEqual(["a.txt"]);
    // 重命名记录 `1\t0\t\0old\0new\0` 在 old 之后被截断：丢掉，不会把 old 当成新路径
    expect(parseNumstatZ(trimToCompleteZTokens("1\t0\t\0old.txt\0ne")).size).toBe(0);
  });
});

describe("清单类输出超限：降级成截断清单，不整仓 git_error", { timeout: 30_000 }, () => {
  it("对照（不注入）：f1..f3 三个已跟踪改动，行数齐全、没有 filesTruncated", async () => {
    const r = await readOne(makeRepo("plain"));
    expect(r.unavailable).toBeUndefined();
    expect(r.files.map((f) => f.path)).toEqual(["f1.txt", "f2.txt", "f3.txt"]);
    expect(r.files.every((f) => f.added === 1)).toBe(true);
    expect(r.filesTruncated).toBeUndefined();
    expect(r.listOverflow).toBeUndefined(); // totals 是精确值：不带「下限」标记
    expect(r.totals.files).toBe(3);
  });

  it("name-status 超限（流被截断在 f3 路径中间）：面板照常给出前面完整的文件、标 filesTruncated，不是 git_error", async () => {
    const dir = makeRepo("ns-overflow");
    hook.inject = (args) =>
      isNameStatus(args) ? overflowErr("M\0f1.txt\0M\0f2.txt\0M\0f3.t") : null;

    const r = await readOne(dir);

    expect(r.unavailable).toBeUndefined();
    expect(r.files.map((f) => f.path)).toEqual(["f1.txt", "f2.txt"]); // 半截的 f3.t 没有被当成文件
    expect(r.filesTruncated).toBe(true);
    expect(r.listOverflow).toBe(true); // totals 只是已读到部分的合计（下限）：前端不能写成「共 N 个」
    expect(r.totals.files).toBe(2);
    // 统计行来自真 numstat：已列出的文件行数正常
    expect(r.files.every((f) => f.added === 1)).toBe(true);
  });

  it("name-status 与 numstat 同时超限：同样降级（海量改动的真实形态）", async () => {
    const dir = makeRepo("both-overflow");
    hook.inject = (args) => {
      if (isNameStatus(args)) return overflowErr("M\0f1.txt\0M\0f2.t");
      if (isNumstat(args)) return overflowErr("1\t0\tf1.txt\0" + "1\t0\tf2.t");
      return null;
    };

    const r = await readOne(dir);

    expect(r.unavailable).toBeUndefined();
    expect(r.files.map((f) => f.path)).toEqual(["f1.txt"]);
    expect(r.files[0].added).toBe(1);
    expect(r.filesTruncated).toBe(true);
    expect(r.listOverflow).toBe(true);
  });

  it("只有 numstat 超限：清单完整，没读到统计的文件行数记 null；忽略空白模式下也不会被误标成「仅空白」", async () => {
    const dir = makeRepo("num-overflow");
    hook.inject = (args) => (isNumstat(args) ? overflowErr("1\t0\tf1.txt\0" + "1\t0\tf2.t") : null);

    for (const ignoreWs of [false, true]) {
      const r = await readOne(dir, { ignoreWs });
      expect(r.unavailable, `ignoreWs=${ignoreWs}`).toBeUndefined();
      expect(r.files.map((f) => f.path)).toEqual(["f1.txt", "f2.txt", "f3.txt"]);
      expect(r.files[0].added).toBe(1);
      expect(r.files[1].added).toBeNull();
      expect(r.files[2].added).toBeNull();
      expect(r.files.some((f) => f.whitespaceOnly)).toBe(false);
      expect(r.filesTruncated).toBeUndefined(); // 清单本身是全的
      expect(r.listOverflow).toBe(true); // 但行数是下限（部分文件没读到统计）
      expect(r.totals.files).toBe(3); // 文件数仍精确
    }
  });

  it("非超限的失败（如 git 异常退出）仍然整仓 git_error：不给半截清单误导", async () => {
    const dir = makeRepo("plain-fail");
    hook.inject = (args) =>
      isNameStatus(args)
        ? Object.assign(new Error("Command failed"), { code: 128, killed: false, signal: null, stdout: "M\0f1.txt\0", stderr: "boom" })
        : null;

    const r = await readOne(dir);

    expect(r.unavailable).toBe("git_error");
    expect(r.files).toEqual([]);
  });
});
