/**
 * refs 很多的仓库：分支列表不能被读成「不是 git 仓」（R14 Q10-02）。
 *
 * 旧写法 `execFile("git", ["for-each-ref", …])` 没传 maxBuffer，Node 默认只有 1MiB；refs 清单超过就抛错，
 * 被上层 catch 成 `isRepo: false`——设置页分支下拉 / 任务页分支选择器静默消失。
 * 公司仓长期不 prune 已合并的远端分支，约 1 万条 ref 就到这个量级。
 *
 * 这里用真 git：直接写 `.git/packed-refs` 批量造 ref（比逐个 update-ref 快几个数量级）。
 * 溢出路径靠 mock 把容量降到 1KiB 触发——真要撑爆 256MiB 得造几百万条 ref，不现实。
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const bufferOverride = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock("@/lib/server/git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/git-exec")>();
  return {
    ...actual,
    get GIT_MAX_BUFFER() {
      return bufferOverride.value ?? actual.GIT_MAX_BUFFER;
    },
  };
});

import { listRepoBranches, readGitBranchState } from "@/lib/server/git-branches";

const TMP_ROOT = path.join(os.tmpdir(), `fe-many-refs-${Date.now()}`);
const REPO = path.join(TMP_ROOT, "many-refs");
const NOT_A_REPO = path.join(TMP_ROOT, "plain-dir");

/**
 * 30000 条、每条 refname 约 183 字节 → 清单约 5.5MiB，既超过 Node execFile 默认的 1MiB，
 * 也超过旧 wk-source-branch 的 2MiB、常见的 4MiB 上限——「把 GIT_MAX_BUFFER 改回某个小常数」这类变异都会被杀。
 * 再大（>8MiB、chat-checkpoint 旧的 8MiB 上限）要写 9MB+ 的 packed-refs 并排序，重负载下噪声风险高，不追。
 */
const MANY = 30_000;
const NAME_PAD = "x".repeat(150);
const refBranch = (i: number): string =>
  `feature/ticket-${String(i).padStart(5, "0")}-${NAME_PAD}`;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();

beforeAll(async () => {
  await fs.mkdir(REPO, { recursive: true });
  await fs.mkdir(NOT_A_REPO, { recursive: true });
  git(REPO, "init", "-b", "main");
  git(REPO, "config", "user.email", "t@t.local");
  git(REPO, "config", "user.name", "t");
  await fs.writeFile(path.join(REPO, "f.txt"), "base\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-m", "init");
  const sha = git(REPO, "rev-parse", "HEAD");

  const lines = ["# pack-refs with: peeled fully-peeled "];
  for (let i = 0; i < MANY; i++) lines.push(`${sha} refs/heads/${refBranch(i)}`);
  await fs.writeFile(path.join(REPO, ".git", "packed-refs"), `${lines.join("\n")}\n`);

  // 自检：清单真的比 4MiB 大，否则「上限改成 1 / 2 / 4MiB」的变异杀不掉
  const listing = git(REPO, "for-each-ref", "refs/heads", "refs/remotes", "--format=%(refname)");
  expect(Buffer.byteLength(listing)).toBeGreaterThan(4 * 1024 * 1024);
}, 60_000);

afterEach(() => {
  bufferOverride.value = undefined;
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("refs 清单超过 1MiB：仍然是仓库、分支列表完整", () => {
  it("listRepoBranches：isRepo、分支数、首尾分支都对，不带 truncated", async () => {
    const res = await listRepoBranches(REPO);

    expect(res.isRepo).toBe(true);
    expect(res.truncated).toBeUndefined();
    expect(res.branches).toHaveLength(MANY + 1); // main + MANY 个 feature
    expect(res.branches).toContain("main");
    expect(res.branches).toContain(refBranch(0));
    expect(res.branches).toContain(refBranch(MANY - 1));
  }, 30_000);

  it("readGitBranchState：isRepo、当前分支、分支数都对，不带 truncated", async () => {
    const res = await readGitBranchState(REPO);

    expect(res.isRepo).toBe(true);
    expect(res.current).toBe("main");
    expect(res.truncated).toBeUndefined();
    expect(res.branches).toHaveLength(MANY + 1);
    expect(res.branches).toContain(refBranch(MANY - 1));
  }, 30_000);
});

describe("超过读取上限：标 truncated，不伪装成「不是 git 仓」，也不拿截断的半截数据", () => {
  it("listRepoBranches：isRepo 仍为 true，branches 为空、truncated=true", async () => {
    bufferOverride.value = 1024;

    const res = await listRepoBranches(REPO);

    expect(res).toEqual({ isRepo: true, branches: [], truncated: true });
  }, 30_000);

  it("readGitBranchState：isRepo 仍为 true、current 照常，branches 为空、truncated=true", async () => {
    bufferOverride.value = 1024;

    const res = await readGitBranchState(REPO);

    expect(res).toEqual({
      isRepo: true,
      current: "main",
      branches: [],
      truncated: true,
    });
  }, 30_000);
});

describe("对照：真正不是 git 仓的目录仍然是 isRepo=false，且不带 truncated", () => {
  it("listRepoBranches / readGitBranchState", async () => {
    const list = await listRepoBranches(NOT_A_REPO);
    const state = await readGitBranchState(NOT_A_REPO);

    expect(list.isRepo).toBe(false);
    expect(list.truncated).toBeUndefined();
    expect(state.isRepo).toBe(false);
    expect(state.truncated).toBeUndefined();
  }, 30_000);
});
