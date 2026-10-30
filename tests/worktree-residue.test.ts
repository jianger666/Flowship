/**
 * R14 B5-2（Q10-01）：`git worktree add` 被硬杀残留的判定——纯逻辑部分（不跑 git、不读盘）。
 * 真 git + 真 SIGKILL 的行为见 tests/worktree-half-checkout-*.integration.test.ts。
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetWorktreeAddInFlightForTest,
  beginWorktreeAdd,
  describeLiveInitializing,
  INITIALIZING_LOCK_REASON,
  isInitializingLockText,
  isWorktreeAddInFlight,
  judgeInitializingLock,
  parseGitdirPointerValue,
  STALE_INITIALIZING_AFTER_MS,
  worktreePathFromAdminGitdirFile,
} from "@/lib/server/worktree-residue";

afterEach(() => {
  __resetWorktreeAddInFlightForTest();
});

describe("常量（防被悄悄改）", () => {
  it("git 写的 initializing 原因串与 5 分钟阈值", () => {
    expect(INITIALIZING_LOCK_REASON).toBe("initializing");
    expect(STALE_INITIALIZING_AFTER_MS).toBe(5 * 60_000);
  });
});

describe("isInitializingLockText：严格相等、不是 includes", () => {
  it.each([
    ["initializing\n", true],
    ["initializing", true],
    ["  initializing \r\n", true],
    ["", false], // 用户 `worktree lock` 不带 reason
    ["\n", false],
    ["initializing storage", false], // 用户 reason 里含这个词
    ["not initializing", false],
    ["initializing\nmore", false],
    ["Initializing", false],
    ["added with --lock", false], // add --lock 的原因串
    ["我的锁", false],
  ])("%j → %s", (text, want) => {
    expect(isInitializingLockText(text)).toBe(want);
  });

  it("null / undefined（没有 locked 文件）→ false", () => {
    expect(isInitializingLockText(null)).toBe(false);
    expect(isInitializingLockText(undefined)).toBe(false);
  });
});

describe("judgeInitializingLock", () => {
  const T = STALE_INITIALIZING_AFTER_MS;
  const judge = (lockText: string | null, ageMs: number, inFlight = false) =>
    judgeInitializingLock({ lockText, ageMs, inFlight });

  it("没有 initializing 锁 → none，不管年龄多大、有没有在途 add", () => {
    for (const lockText of [null, "", "initializing storage", "added with --lock", "我的锁"]) {
      expect(judge(lockText, 10 * T, false)).toEqual({ kind: "none" });
      expect(judge(lockText, 10 * T, true)).toEqual({ kind: "none" });
      expect(judge(lockText, 0, false)).toEqual({ kind: "none" });
    }
  });

  it("本进程有在途 add → live（in-flight），年龄再大也是；且优先于年龄", () => {
    expect(judge("initializing\n", 10 * T, true)).toEqual({
      kind: "live",
      why: "in-flight",
      ageMs: 10 * T,
    });
    expect(judge("initializing\n", 0, true)).toMatchObject({ kind: "live", why: "in-flight" });
  });

  it("年龄不足阈值 → live（recent）", () => {
    expect(judge("initializing\n", 0)).toEqual({ kind: "live", why: "recent", ageMs: 0 });
    expect(judge("initializing\n", T - 1)).toEqual({ kind: "live", why: "recent", ageMs: T - 1 });
  });

  it("年龄恰好等于阈值就是 stale（边界是 `<` 不是 `<=`）", () => {
    expect(judge("initializing\n", T)).toEqual({ kind: "stale", ageMs: T });
    expect(judge("initializing\n", T + 1)).toEqual({ kind: "stale", ageMs: T + 1 });
    expect(judge("initializing\n", 24 * 3600_000)).toMatchObject({ kind: "stale" });
  });

  it("年龄为负（时钟回拨 / 未来 mtime）→ 保守按 live", () => {
    expect(judge("initializing\n", -5_000)).toEqual({ kind: "live", why: "recent", ageMs: -5_000 });
    expect(judge("initializing\n", -10 * T)).toMatchObject({ kind: "live", why: "recent" });
  });
});

describe("describeLiveInitializing", () => {
  it("in-flight：说本进程有 add 在进行", () => {
    expect(describeLiveInitializing({ kind: "live", why: "in-flight", ageMs: 10 * STALE_INITIALIZING_AFTER_MS })).toMatch(
      /本进程里另一次 git worktree add 还在进行/,
    );
  });

  it("recent：给出已过秒数与「约 N 秒后重试」，N 随年龄递减、至少 1", () => {
    const d = (ageMs: number) => describeLiveInitializing({ kind: "live", why: "recent", ageMs });
    expect(d(0)).toMatch(/才 0s/);
    expect(d(0)).toMatch(/约 300s 后重试/);
    expect(d(100_000)).toMatch(/才 100s/);
    expect(d(100_000)).toMatch(/约 200s 后重试/);
    expect(d(100_500)).toMatch(/约 200s 后重试/); // 199.5s 向上取整，不是向下
    expect(d(STALE_INITIALIZING_AFTER_MS - 1)).toMatch(/约 1s 后重试/);
  });

  it("recent：负年龄按 0 算、重试秒数不超过阈值本身", () => {
    const text = describeLiveInitializing({ kind: "live", why: "recent", ageMs: -9_999_999 });
    expect(text).toMatch(/才 0s/);
    expect(text).toMatch(/约 300s 后重试/);
  });
});

describe("parseGitdirPointerValue（worktree 里 .git 指针文件）", () => {
  it("取 gitdir: 后的值（绝对路径 / 相对路径 / CRLF / 多余空白）", () => {
    expect(parseGitdirPointerValue("gitdir: /r/.git/worktrees/x\n")).toBe("/r/.git/worktrees/x");
    expect(parseGitdirPointerValue("gitdir:/r/.git/worktrees/x")).toBe("/r/.git/worktrees/x");
    expect(parseGitdirPointerValue("gitdir: ../repo/.git/worktrees/x\r\n")).toBe(
      "../repo/.git/worktrees/x",
    );
    expect(parseGitdirPointerValue("gitdir:   C:/r/.git/worktrees/x  \n")).toBe(
      "C:/r/.git/worktrees/x",
    );
  });

  it("没有合法 gitdir 行 / 值为空 → null", () => {
    expect(parseGitdirPointerValue("")).toBeNull();
    expect(parseGitdirPointerValue("garbage\n")).toBeNull();
    expect(parseGitdirPointerValue("gitdir:\n")).toBeNull();
    expect(parseGitdirPointerValue("gitdir:   \n")).toBeNull();
  });
});

describe("worktreePathFromAdminGitdirFile（登记目录里的 gitdir 文件）", () => {
  it("去掉末尾 /.git，得到 worktree 目录", () => {
    expect(worktreePathFromAdminGitdirFile("/p/wt/.git\n")).toBe("/p/wt");
    expect(worktreePathFromAdminGitdirFile("/p/wt/.git")).toBe("/p/wt");
    expect(worktreePathFromAdminGitdirFile("C:/p/wt/.git\r\n")).toBe("C:/p/wt");
    expect(worktreePathFromAdminGitdirFile("C:\\p\\wt\\.git\n")).toBe("C:\\p\\wt");
  });

  it("只去掉末尾的 .git，目录名里带 .git 的不误伤", () => {
    expect(worktreePathFromAdminGitdirFile("/p/my.git.d/wt/.git\n")).toBe("/p/my.git.d/wt");
    expect(worktreePathFromAdminGitdirFile("/p/x.git/.git\n")).toBe("/p/x.git");
  });

  it("不以 /.git 结尾的异常内容原样返回（后续比较自然对不上）；只看第一行；空 → null", () => {
    expect(worktreePathFromAdminGitdirFile("/p/wt\n")).toBe("/p/wt");
    expect(worktreePathFromAdminGitdirFile("/p/a/.git\n/p/b/.git\n")).toBe("/p/a");
    expect(worktreePathFromAdminGitdirFile("")).toBeNull();
    expect(worktreePathFromAdminGitdirFile("\n  \n")).toBeNull();
  });
});

describe("在途 add 登记表", () => {
  it("begin 后在途、end 后不在途；其它目录不受影响", () => {
    const end = beginWorktreeAdd("/w/a");
    expect(isWorktreeAddInFlight("/w/a")).toBe(true);
    expect(isWorktreeAddInFlight("/w/b")).toBe(false);
    end();
    expect(isWorktreeAddInFlight("/w/a")).toBe(false);
  });

  it("同一目录嵌套登记（计数）：最后一个结束才算不在途", () => {
    const e1 = beginWorktreeAdd("/w/a");
    const e2 = beginWorktreeAdd("/w/a");
    e1();
    expect(isWorktreeAddInFlight("/w/a")).toBe(true);
    e2();
    expect(isWorktreeAddInFlight("/w/a")).toBe(false);
  });

  it("end 可重复调用，只算一次（重复调用不会把别人的登记减掉）", () => {
    const e1 = beginWorktreeAdd("/w/a");
    const e2 = beginWorktreeAdd("/w/a");
    e1();
    e1();
    e1();
    expect(isWorktreeAddInFlight("/w/a")).toBe(true);
    e2();
    expect(isWorktreeAddInFlight("/w/a")).toBe(false);
  });

  it("键规范化：尾分隔符、`..` 折叠、相对路径都落到同一个键", () => {
    const end = beginWorktreeAdd("/w/a/");
    expect(isWorktreeAddInFlight("/w/a")).toBe(true);
    expect(isWorktreeAddInFlight("/w/x/../a")).toBe(true);
    expect(isWorktreeAddInFlight(path.relative(process.cwd(), "/w/a"))).toBe(true);
    end();
    expect(isWorktreeAddInFlight("/w/a")).toBe(false);
  });

  it("登记表在 globalThis 上：模块多实例也共享（重置后清空）", () => {
    beginWorktreeAdd("/w/a");
    const g = globalThis as { __flowshipWorktreeAddInFlight?: Map<string, number> };
    expect(g.__flowshipWorktreeAddInFlight?.size).toBe(1);
    __resetWorktreeAddInFlightForTest();
    expect(isWorktreeAddInFlight("/w/a")).toBe(false);
    expect(g.__flowshipWorktreeAddInFlight?.size).toBe(0);
  });

  it("Windows：键不区分大小写", () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const end = beginWorktreeAdd("/W/Task/Repo");
      expect(isWorktreeAddInFlight("/w/task/repo")).toBe(true);
      end();
      expect(isWorktreeAddInFlight("/w/task/repo")).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
  });

  it("非 Windows：键区分大小写", () => {
    if (process.platform === "win32") return;
    const end = beginWorktreeAdd("/W/Task/Repo");
    expect(isWorktreeAddInFlight("/w/task/repo")).toBe(false);
    end();
  });
});
