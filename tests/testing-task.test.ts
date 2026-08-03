import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { renderRepoBranchSection } from "@/lib/server/task-prompts";
import { prepareTestingTaskBranches } from "@/lib/server/testing-task-branches";
import {
  isTestingTask,
  testingTaskConfiguredBranchRepoPaths,
  testingTaskMissingBranchRepoPaths,
} from "@/lib/testing-task";
import type { Task } from "@/lib/types";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

const taskOf = (patch: Partial<Task> = {}): Task =>
  ({
    id: "t_qa",
    title: "测试任务",
    mode: "task",
    workRole: "qa",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: ["/repo/a", "/repo/b", "/docs"],
    feishuStoryUrl: "https://project.feishu.cn/demo/story/detail/123",
    nonGitRepoPaths: ["/docs"],
    repoFeatureBranches: { "/repo/a": "feature/a" },
    createdAt: 1,
    updatedAt: 1,
    events: [],
    ...patch,
  }) as Task;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("测试任务分支语义", () => {
  it("角色快照决定测试语义，并区分已配置 / 待补仓库", () => {
    const task = taskOf();
    expect(isTestingTask(task)).toBe(true);
    expect(testingTaskConfiguredBranchRepoPaths(task)).toEqual(["/repo/a"]);
    expect(testingTaskMissingBranchRepoPaths(task)).toEqual(["/repo/b"]);
    expect(isTestingTask(taskOf({ workRole: "fe" }))).toBe(false);
  });

  it("测试角色的日常任务不要求被测业务分支", () => {
    const daily = taskOf({ feishuStoryUrl: undefined });
    expect(isTestingTask(daily)).toBe(true);
    expect(testingTaskConfiguredBranchRepoPaths(daily)).toEqual([]);
    expect(testingTaskMissingBranchRepoPaths(daily)).toEqual([]);
  });

  it("prompt 明确未就绪分支不能被当作需求实现", () => {
    const prompt = renderRepoBranchSection(taskOf());
    expect(prompt).toContain("被测业务分支=feature/a");
    expect(prompt).toContain("被测业务分支=（未就绪）");
    expect(prompt).toContain("当前 checkout **不代表本需求实现**");
    expect(prompt).toContain("禁止创建 feature 分支");
  });

  it("Action 前检出已配置分支并记录实际提交", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-qa-branch-"));
    tempDirs.push(repo);
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Flowship Test"]);
    await git(["config", "user.email", "flowship@example.test"]);
    await fs.writeFile(path.join(repo, "README.md"), "main\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "main"]);
    await git(["checkout", "-b", "feature/qa-ready"]);
    await fs.writeFile(path.join(repo, "feature.txt"), "ready\n");
    await git(["add", "feature.txt"]);
    await git(["commit", "-m", "feature"]);
    const expectedHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["checkout", "main"]);

    const infos = await prepareTestingTaskBranches(
      taskOf({
        id: "t_qa_checkout",
        repoPaths: [repo],
        nonGitRepoPaths: [],
        repoFeatureBranches: { [repo]: "feature/qa-ready" },
      }),
      () => true,
    );

    expect((await git(["branch", "--show-current"])).stdout.trim()).toBe(
      "feature/qa-ready",
    );
    expect(infos).toEqual([
      {
        repoPath: repo,
        name: "feature/qa-ready",
        baseBranch: "",
        headCommit: expectedHead,
      },
    ]);
  });

  it("工作区有未提交改动时拒绝自动切分支", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-qa-dirty-"));
    tempDirs.push(repo);
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Flowship Test"]);
    await git(["config", "user.email", "flowship@example.test"]);
    await fs.writeFile(path.join(repo, "README.md"), "main\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "main"]);
    await git(["branch", "feature/qa-ready"]);
    await fs.writeFile(path.join(repo, "dirty.txt"), "dirty\n");

    await expect(
      prepareTestingTaskBranches(
        taskOf({
          id: "t_qa_dirty",
          repoPaths: [repo],
          nonGitRepoPaths: [],
          repoFeatureBranches: { [repo]: "feature/qa-ready" },
        }),
        () => true,
      ),
    ).rejects.toThrow("存在未提交改动");
    expect((await git(["branch", "--show-current"])).stdout.trim()).toBe("main");
  });
});
