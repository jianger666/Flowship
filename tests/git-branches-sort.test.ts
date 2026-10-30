/**
 * 分支下拉的顺序：按最近提交倒序，活跃分支排前面（R14 B5-1 预审补洞：变异 RR13「去掉 --sort=-committerdate」存活）。
 *
 * `readGitBranchState` / `listRepoBranches` 共用 `REF_LIST_ARGS`（`for-each-ref … --sort=-committerdate`）。
 * 这是改前就有的行为（B5-1 只放大了 maxBuffer、加了 truncated），当时没有任何用例钉住它——
 * 去掉 `--sort` 后顺序退回 refname 字母序，所有既有用例照样绿。
 *
 * 真 git：三个分支的提交时间用 GIT_COMMITTER_DATE 固定成不同的日子（与跑测试的时间无关）；
 * 分支名特意取成「字母序和时间序不一样」，退回字母序一定对不上。
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listRepoBranches, readGitBranchState } from "@/lib/server/git-branches";

const TMP_ROOT = path.join(os.tmpdir(), `fe-branch-sort-${Date.now()}`);
const REPO = path.join(TMP_ROOT, "repo");

const git = (
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, ...env },
  }).trim();

const at = (iso: string): Record<string, string> => ({
  GIT_AUTHOR_DATE: iso,
  GIT_COMMITTER_DATE: iso,
});

beforeAll(async () => {
  await fs.mkdir(REPO, { recursive: true });
  git(REPO, {}, "init", "-b", "main");
  git(REPO, {}, "config", "user.email", "t@t.local");
  git(REPO, {}, "config", "user.name", "t");
  await fs.writeFile(path.join(REPO, "f.txt"), "base\n");
  git(REPO, {}, "add", "-A");
  git(REPO, at("2020-01-01T00:00:00+0000"), "commit", "-m", "init");

  // 提交时间：main(2020) < zz-oldest(2021) < mm-middle(2022) < aa-newest(2023)
  for (const [name, iso] of [
    ["zz-oldest", "2021-01-01T00:00:00+0000"],
    ["aa-newest", "2023-01-01T00:00:00+0000"],
    ["mm-middle", "2022-01-01T00:00:00+0000"],
  ] as const) {
    git(REPO, {}, "checkout", "-b", name, "main");
    await fs.writeFile(path.join(REPO, "f.txt"), `${name}\n`);
    git(REPO, {}, "add", "-A");
    git(REPO, at(iso), "commit", "-m", name);
  }
  git(REPO, {}, "checkout", "main");
}, 30_000);

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

// 字母序是 aa-newest、main、mm-middle、zz-oldest；最近提交倒序是下面这个——两者在 main 的位置上就不同
const BY_COMMIT_DATE_DESC = ["aa-newest", "mm-middle", "zz-oldest", "main"];

describe("分支列表按最近提交倒序（活跃分支排前面）", () => {
  it("listRepoBranches：顺序是提交时间倒序，不是字母序", async () => {
    const res = await listRepoBranches(REPO);

    expect(res.isRepo).toBe(true);
    expect(res.branches).toEqual(BY_COMMIT_DATE_DESC);
  });

  it("readGitBranchState：同一个顺序；当前分支单独给（main 的提交最早、排最后，但仍是 current）", async () => {
    const res = await readGitBranchState(REPO);

    expect(res.isRepo).toBe(true);
    expect(res.current).toBe("main");
    expect(res.branches).toEqual(BY_COMMIT_DATE_DESC);
  });
});
