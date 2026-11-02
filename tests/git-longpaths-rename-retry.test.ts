/**
 * Windows 低风险加固（没法在 Windows 实测，只测平台分支与重试预算这两个纯逻辑）：
 *
 * (a) `core.longpaths`：git for Windows 默认关闭，深路径下 `git worktree add` 会 `Filename too long`。
 *     只在 win32 给这一次 git 调用补 `-c core.longpaths=true`（不改仓库 / 全局 git 配置）；其它平台参数原样。
 * (b) `renameWithRetry`：以前总共只等约 750ms，杀软占着目标文件超过 1 秒就穿透。现在累计约 3s，仍只对 EPERM / EACCES / EBUSY 重试。
 *
 * 不碰真实文件：rename 全程 spy。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RENAME_RETRY_DELAYS_MS, renameWithRetry } from "@/lib/server/data-root";
import {
  gitEnv,
  gitLongPathsConfigArgs,
  withGitLongPaths,
  withGitLongPathsEnv,
} from "@/lib/server/git-exec";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("core.longpaths（win32 only，纯函数）", () => {
  it("win32：在子命令前补 `-c core.longpaths=true`", () => {
    expect(gitLongPathsConfigArgs("win32")).toEqual(["-c", "core.longpaths=true"]);
    expect(withGitLongPaths(["worktree", "add", "--detach", "C:\\w", "origin/main"], "win32")).toEqual([
      "-c",
      "core.longpaths=true",
      "worktree",
      "add",
      "--detach",
      "C:\\w",
      "origin/main",
    ]);
  });

  it.each(["darwin", "linux", "freebsd"] as const)("%s：参数原样（不多一个字）", (platform) => {
    expect(gitLongPathsConfigArgs(platform)).toEqual([]);
    expect(withGitLongPaths(["worktree", "add", "/w", "main"], platform)).toEqual(["worktree", "add", "/w", "main"]);
  });

  it("不改入参数组；缺省平台取 process.platform", () => {
    const args = ["worktree", "add", "x"] as const;
    const out = withGitLongPaths(args, "win32");
    expect(args).toEqual(["worktree", "add", "x"]);
    expect(out).not.toBe(args);
    expect(withGitLongPaths(args)).toEqual(process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : [...args]);
  });
});

describe("core.longpaths 统一走 env（win32 only，覆盖 reset / clean / add -A / worktree remove 等所有走 gitEnv 的调用点）", () => {
  const base = { PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0" } as unknown as NodeJS.ProcessEnv;

  it("win32：补 GIT_CONFIG_COUNT=1 / KEY_0=core.longpaths / VALUE_0=true，不改入参", () => {
    const input = { ...base };
    const out = withGitLongPathsEnv(input, "win32");
    expect(out).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.longpaths",
      GIT_CONFIG_VALUE_0: "true",
      PATH: "/usr/bin",
    });
    expect(input).toEqual(base);
    expect(out).not.toBe(input);
  });

  it.each(["darwin", "linux"] as const)("%s：原样返回同一个对象、一个变量都不加", (platform) => {
    const input = { ...base };
    expect(withGitLongPathsEnv(input, platform)).toBe(input);
    expect(Object.keys(input).filter((k) => k.startsWith("GIT_CONFIG_"))).toEqual([]);
  });

  it("不覆盖已有的 GIT_CONFIG_*：COUNT=2 时追加到下标 2、COUNT 改成 3，0 / 1 号条目原样保留", () => {
    const input: NodeJS.ProcessEnv = {
      ...base,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "alice",
      GIT_CONFIG_KEY_1: "core.autocrlf",
      GIT_CONFIG_VALUE_1: "false",
    };
    const out = withGitLongPathsEnv(input, "win32");
    expect(out).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "alice",
      GIT_CONFIG_KEY_1: "core.autocrlf",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "core.longpaths",
      GIT_CONFIG_VALUE_2: "true",
    });
    expect(input.GIT_CONFIG_COUNT).toBe("2");
  });

  it("调用方已显式配置 core.longpaths（哪怕是 false）→ 尊重，不追加", () => {
    const input: NodeJS.ProcessEnv = {
      ...base,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.longpaths",
      GIT_CONFIG_VALUE_0: "false",
    };
    expect(withGitLongPathsEnv(input, "win32")).toBe(input);
  });

  it("已有 COUNT 不是非负整数（git 自己会报 bogus count）→ 原样返回，不在坏配置上叠加", () => {
    for (const bad of ["", "abc", "-1", "1.5"]) {
      const input: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_COUNT: bad };
      expect(withGitLongPathsEnv(input, "win32")).toBe(input);
    }
  });

  it("env 名大小写不敏感（Windows 环境变量展开后可能保留原始大小写）：不留下两个 COUNT", () => {
    const input: NodeJS.ProcessEnv = {
      ...base,
      Git_Config_Count: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "alice",
    };
    const out = withGitLongPathsEnv(input, "win32");
    expect(Object.keys(out).filter((k) => k.toUpperCase() === "GIT_CONFIG_COUNT")).toEqual(["GIT_CONFIG_COUNT"]);
    expect(out.GIT_CONFIG_COUNT).toBe("2");
    expect(out.GIT_CONFIG_KEY_1).toBe("core.longpaths");
  });

  it("gitEnv：win32 带上、其它平台一个字不加；调用方 extra 里的 GIT_CONFIG_* 也不被覆盖", () => {
    const extra = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "alice" };
    const win = gitEnv(extra, "win32");
    expect(win).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "alice",
      GIT_CONFIG_KEY_1: "core.longpaths",
      GIT_CONFIG_VALUE_1: "true",
      GIT_TERMINAL_PROMPT: "0",
    });
    const mac = gitEnv(extra, "darwin");
    expect(mac).toMatchObject(extra);
    expect(mac.GIT_CONFIG_KEY_1).toBeUndefined();
  });

  it("真 git（>= 2.31）认这组变量：`git config --get core.longpaths` 读到 true，且不碰任何配置文件", () => {
    const ver = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
    const [major, minor] = [Number(ver?.[1]), Number(ver?.[2])];
    if (!(major > 2 || (major === 2 && minor >= 31))) return; // 更老的 git 不认 GIT_CONFIG_COUNT（行为是忽略、不报错）
    const dir = mkdtempSync(path.join(os.tmpdir(), "flowship-longpaths-env-"));
    try {
      const empty = path.join(dir, "empty-gitconfig");
      execFileSync("git", ["config", "--file", empty, "user.name", "x"]); // 建一个存在的空壳全局配置
      const env = withGitLongPathsEnv(
        { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1" },
        "win32",
      );
      for (const k of Object.keys(env)) if (k.toUpperCase() === "GIT_CONFIG_PARAMETERS") delete env[k];
      const out = execFileSync("git", ["config", "--get", "core.longpaths"], { cwd: dir, env, encoding: "utf8" });
      expect(out.trim()).toBe("true");
      // 对照：不带这组变量时读不到（退出码 1）
      const bare: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1" };
      delete bare.GIT_CONFIG_COUNT;
      expect(() => execFileSync("git", ["config", "--get", "core.longpaths"], { cwd: dir, env: bare, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renameWithRetry：退避预算约 3 秒", () => {
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

  it("退避表累计约 3s（旧版 750ms）", () => {
    const total = RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(2500);
    expect(total).toBeLessThanOrEqual(3500);
  });

  it("EPERM / EBUSY 一直占用：重试满预算后抛原始错误；最后一次失败后不再白等", async () => {
    vi.useFakeTimers();
    const stamps: number[] = [];
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      stamps.push(Date.now());
      throw err("EPERM");
    });

    const p = renameWithRetry("a.tmp", "a");
    const settled = p.then(
      () => "ok",
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await settled;

    expect(result).toMatchObject({ code: "EPERM" });
    expect(stamps).toHaveLength(RENAME_RETRY_DELAYS_MS.length + 1);
    // 首尾间隔 = 退避总和：说明最后一次失败后没有多等一轮
    expect(stamps[stamps.length - 1]! - stamps[0]!).toBe(RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
  });

  it("占用了 1 秒多之后释放（旧版 750ms 预算会穿透）：第 6 次尝试成功、不抛", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      calls += 1;
      if (calls <= 5) throw err("EBUSY");
    });

    const p = renameWithRetry("a.tmp", "a");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(p).resolves.toBeUndefined();
    expect(calls).toBe(6);
  });

  it.each(["ENOSPC", "EXDEV", "EIO", "ENOENT"])("非占用类错误码 %s：立即抛、不重试不等待", async (code) => {
    let calls = 0;
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      calls += 1;
      throw err(code);
    });

    await expect(renameWithRetry("a.tmp", "a")).rejects.toMatchObject({ code });
    expect(calls).toBe(1);
  });
});
