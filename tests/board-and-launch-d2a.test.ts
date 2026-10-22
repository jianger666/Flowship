/**
 * 第三轮 D2a：看板区间分段 / 平移取消、启动表单的 fetch 范围与「非仓库根」提示。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_BOARD_WINDOWS,
  MAX_BOARD_WINDOW_MS,
  mergeBoardWindows,
  splitBoardWindows,
} from "@/lib/board-range";
import { needsRemoteBranchRefresh, notGitRootRepoPaths } from "@/lib/launch-repos-state";

const DAY = 24 * 60 * 60 * 1000;

describe("D2a-02 splitBoardWindows / mergeBoardWindows", () => {
  it("半年预设（181 天）→ 3 段：90 + 90 + 1，首尾相接、每段 ≤ 90 天", () => {
    const from = 1_700_000_000_000;
    const to = from + 181 * DAY;
    const { windows, truncated } = splitBoardWindows(from, to);
    expect(truncated).toBe(false);
    expect(windows).toHaveLength(3);
    expect(windows[0]!.from).toBe(from);
    expect(windows[windows.length - 1]!.to).toBe(to);
    for (let i = 0; i < windows.length; i++) {
      expect(windows[i]!.to - windows[i]!.from).toBeLessThanOrEqual(MAX_BOARD_WINDOW_MS);
      if (i > 0) expect(windows[i]!.from).toBe(windows[i - 1]!.to);
    }
  });

  it("≤ 90 天只一段；反向 / 非有限区间原样单窗（交给上游按旧行为处理）", () => {
    expect(splitBoardWindows(0, 90 * DAY).windows).toEqual([{ from: 0, to: 90 * DAY }]);
    expect(splitBoardWindows(5, 5).windows).toEqual([{ from: 5, to: 5 }]);
    expect(splitBoardWindows(10, 5).windows).toEqual([{ from: 10, to: 5 }]);
    expect(splitBoardWindows(Number.NaN, 5).windows).toHaveLength(1);
  });

  it(`超过 ${MAX_BOARD_WINDOWS} 段只取前面并标 truncated`, () => {
    const r = splitBoardWindows(0, 10_000 * DAY);
    expect(r.truncated).toBe(true);
    expect(r.windows).toHaveLength(MAX_BOARD_WINDOWS);
  });

  it("合并按 id 去重（跨窗口工作项在相邻两段都出现），保留首次出现的内容与顺序", () => {
    const merged = mergeBoardWindows([
      [{ id: "a", v: 1 }, { id: "b", v: 1 }],
      [{ id: "b", v: 2 }, { id: "c", v: 2 }],
      [{ id: "c", v: 3 }],
    ]);
    expect(merged).toEqual([
      { id: "a", v: 1 },
      { id: "b", v: 1 },
      { id: "c", v: 2 },
    ]);
  });
});

describe("D2a-02/04 GET /api/feishu/board（真实 route + 桩 meegle）", () => {
  const fetchUserSchedule = vi.fn();
  const meegleAuthStatus = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    fetchUserSchedule.mockReset();
    meegleAuthStatus.mockReset();
    meegleAuthStatus.mockResolvedValue({ installed: true, authenticated: true, host: "meegle.example.com" });
    vi.doMock("@/lib/server/meegle-cli", () => ({
      fetchMyUserKey: async () => "u1",
      fetchProjects: async () => [{ key: "P", name: "P" }],
      fetchProjectSimpleNames: async () => new Map([["P", "simple"]]),
      fetchUserSchedule,
      meegleAuthStatus,
      MeegleError: class MeegleError extends Error {
        kind = "error";
      },
    }));
    vi.doMock("@/lib/server/task-fs", () => ({
      listTasks: async () => [],
      filterCommittedReads: (t: unknown[]) => t,
      assertTaskReadable: () => true,
    }));
    vi.doMock("@/lib/server/failpoints", () => ({ failpoint: async () => undefined }));
  });

  const call = async (from: number, to: number, signal?: AbortSignal) => {
    const { GET } = await import("@/app/api/feishu/board/route");
    const url = `http://localhost/api/feishu/board?project=P&from=${from}&to=${to}`;
    return GET(new Request(url, signal ? { signal } : undefined));
  };

  it("181 天区间 → 分 3 次向飞书取、每次 ≤ 90 天，结果合并去重（以前后 91 天静默为空）", async () => {
    const from = 1_700_000_000_000;
    const to = from + 181 * DAY;
    fetchUserSchedule.mockImplementation(async (_p: string, _u: string, f: number) => {
      // 每段各返回一个自己的工作项，再加一个跨窗口的重复项
      return [
        { id: `item-${f}`, name: "x", raw: {} },
        { id: "shared", name: "shared", raw: {} },
      ];
    });
    const res = await call(from, to);
    const body = (await res.json()) as { status: string; items: Array<{ id: string }>; coveredTo?: number };
    expect(body.status).toBe("ok");
    expect(fetchUserSchedule).toHaveBeenCalledTimes(3);
    for (const [, , f, t] of fetchUserSchedule.mock.calls as Array<[string, string, number, number]>) {
      expect(t - f).toBeLessThanOrEqual(MAX_BOARD_WINDOW_MS);
    }
    expect(body.items.filter((i) => i.id === "shared")).toHaveLength(1);
    expect(body.items).toHaveLength(4);
    expect(body.coveredTo).toBeUndefined();
  });

  it("客户端中途取消（换区间）→ 不再继续向飞书取后面的分段", async () => {
    const from = 1_700_000_000_000;
    const ctrl = new AbortController();
    fetchUserSchedule.mockImplementation(async () => {
      ctrl.abort(); // 第一段返回时用户已经换了区间
      return [];
    });
    const res = await call(from, from + 181 * DAY, ctrl.signal);
    expect(fetchUserSchedule).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(499);
  });

  it("auth host 60s 内只问一次（连点平移不再每次排进 meegle 串行队列）", async () => {
    fetchUserSchedule.mockResolvedValue([]);
    const from = 1_700_000_000_000;
    await call(from, from + 10 * DAY);
    await call(from + DAY, from + 11 * DAY);
    await call(from + 2 * DAY, from + 12 * DAY);
    expect(meegleAuthStatus).toHaveBeenCalledTimes(1);
  });
});

describe("D2a-01/03 启动表单", () => {
  it("只有 QA + 非日常 + 选了仓才需要 refresh（git fetch --prune）", () => {
    const base = { isDailyLaunch: false, userRole: "qa", repoCount: 2 };
    expect(needsRemoteBranchRefresh(base)).toBe(true);
    expect(needsRemoteBranchRefresh({ ...base, userRole: "fe" })).toBe(false);
    expect(needsRemoteBranchRefresh({ ...base, userRole: undefined })).toBe(false);
    expect(needsRemoteBranchRefresh({ ...base, userRole: null })).toBe(false);
    expect(needsRemoteBranchRefresh({ ...base, isDailyLaunch: true })).toBe(false);
    expect(needsRemoteBranchRefresh({ ...base, repoCount: 0 })).toBe(false);
  });

  it("notGitRootRepoPaths：只挑 isRepo 且 notRoot 的路径", () => {
    expect(
      notGitRootRepoPaths(["/a", "/b", "/c", "/d"], {
        "/a": { isRepo: true },
        "/b": { isRepo: true, notRoot: true },
        "/c": { isRepo: false, notRoot: true },
        "/d": undefined,
      }),
    ).toEqual(["/b"]);
  });
});

describe("D2a-03 listRepoBranches 的 notRoot（真实 git 临时仓库）", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fe-d2a03-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd,
      stdio: "pipe",
    });

  it("仓库根：不带 notRoot；monorepo 子目录：isRepo=true 且 notRoot=true（任务快照会判它非 git）", async () => {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, "packages", "web"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "packages", "web", "a.txt"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");

    const { listRepoBranches } = await import("@/lib/server/git-branches");
    const atRoot = await listRepoBranches(repo);
    expect(atRoot.isRepo).toBe(true);
    expect(atRoot.notRoot).toBeUndefined();
    const sub = await listRepoBranches(path.join(repo, "packages", "web"));
    expect(sub.isRepo).toBe(true);
    expect(sub.notRoot).toBe(true);
  });
});
