import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { renderRepoBranchSection } from "@/lib/server/task-prompts";
import {
  blockingPorcelainPaths,
  isBuildArtifactPath,
  prepareTestingTaskBranches,
  restoreRepoAfterFailedTestingCheckout,
} from "@/lib/server/testing-task-branches";
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
    ).rejects.toThrow(/存在未提交改动[\s\S]*dirty\.txt/);
    expect((await git(["branch", "--show-current"])).stdout.trim()).toBe("main");
  });

  it("未跟踪的 Maven target 不挡切分支", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-qa-target-"));
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
    await git(["checkout", "main"]);
    await fs.mkdir(path.join(repo, "pkg", "target"), { recursive: true });
    await fs.writeFile(path.join(repo, "pkg", "target", "Foo.class"), "class\n");

    await prepareTestingTaskBranches(
      taskOf({
        id: "t_qa_target",
        repoPaths: [repo],
        nonGitRepoPaths: [],
        repoFeatureBranches: { [repo]: "feature/qa-ready" },
      }),
      () => true,
    );

    expect((await git(["branch", "--show-current"])).stdout.trim()).toBe(
      "feature/qa-ready",
    );
    expect(
      await fs.readFile(path.join(repo, "pkg", "target", "Foo.class"), "utf8"),
    ).toBe("class\n");
  });

  it("checkout 失败残留的 index 能复位到进入前的干净分支", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-qa-restore-"));
    tempDirs.push(repo);
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Flowship Test"]);
    await git(["config", "user.email", "flowship@example.test"]);
    await fs.writeFile(path.join(repo, "README.md"), "main\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "main"]);
    const mainHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["checkout", "-b", "feature/qa-ready"]);
    await fs.writeFile(path.join(repo, "feature.txt"), "ready\n");
    await git(["add", "feature.txt"]);
    await git(["commit", "-m", "feature"]);
    await git(["checkout", "main"]);
    // 模拟 checkout 写完 index 但 HEAD 还停在原分支
    await git(["checkout", "feature/qa-ready", "--", "."]);
    expect((await git(["status", "--porcelain"])).stdout.trim()).not.toBe("");

    await restoreRepoAfterFailedTestingCheckout(
      {
        repoPath: repo,
        branch: "feature/qa-ready",
        currentBranch: "main",
        currentCommit: mainHead,
      },
      new AbortController().signal,
    );

    expect((await git(["branch", "--show-current"])).stdout.trim()).toBe("main");
    expect((await git(["status", "--porcelain"])).stdout.trim()).toBe("");
    expect(
      (await git(["branch", "--list", "feature/qa-ready"])).stdout.trim(),
    ).toBe("feature/qa-ready");
  });

  it("半截建出的 tracking 分支会删掉", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-qa-delbranch-"));
    tempDirs.push(repo);
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Flowship Test"]);
    await git(["config", "user.email", "flowship@example.test"]);
    await fs.writeFile(path.join(repo, "README.md"), "main\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "main"]);
    const mainHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["branch", "feature/leftover-bridge"]);
    await fs.writeFile(path.join(repo, "extra.txt"), "staged-from-other-tree\n");
    await git(["add", "extra.txt"]);

    await restoreRepoAfterFailedTestingCheckout(
      {
        repoPath: repo,
        branch: "feature/leftover-bridge",
        currentBranch: "main",
        currentCommit: mainHead,
        checkoutFrom: "origin/feature/leftover-bridge",
      },
      new AbortController().signal,
    );

    expect((await git(["branch", "--show-current"])).stdout.trim()).toBe("main");
    expect((await git(["status", "--porcelain"])).stdout.trim()).toBe("");
    expect(
      (await git(["branch", "--list", "feature/leftover-bridge"])).stdout.trim(),
    ).toBe("");
  });

  it("checkout 中途失败会复位工作区再抛错", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-qa-smudge-"));
    tempDirs.push(repo);
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Flowship Test"]);
    await git(["config", "user.email", "flowship@example.test"]);
    await fs.writeFile(path.join(repo, "README.md"), "main\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "main"]);
    await git(["checkout", "-b", "feature/qa-ready"]);
    await fs.writeFile(path.join(repo, "blob.bin"), "secret\n");
    await fs.writeFile(
      path.join(repo, ".gitattributes"),
      "blob.bin filter=flowshipfail\n",
    );
    await git(["add", "."]);
    await git(["commit", "-m", "feature"]);
    await git(["config", "filter.flowshipfail.smudge", "false"]);
    await git(["config", "filter.flowshipfail.clean", "cat"]);
    await git(["config", "filter.flowshipfail.required", "true"]);
    await git(["checkout", "main"]);

    await expect(
      prepareTestingTaskBranches(
        taskOf({
          id: "t_qa_smudge",
          repoPaths: [repo],
          nonGitRepoPaths: [],
          repoFeatureBranches: { [repo]: "feature/qa-ready" },
        }),
        () => true,
      ),
    ).rejects.toThrow(/无法检出被测业务分支/);
    expect((await git(["branch", "--show-current"])).stdout.trim()).toBe("main");
    expect((await git(["status", "--porcelain"])).stdout.trim()).toBe("");
  });
});

describe("测试任务脏检查过滤", () => {
  it("未跟踪编译产物不挡，源码改动仍挡", () => {
    expect(isBuildArtifactPath("ms-ai-dto/target/")).toBe(true);
    expect(isBuildArtifactPath("pkg/node_modules/lodash/index.js")).toBe(true);
    expect(isBuildArtifactPath("src/page.tsx")).toBe(false);
    expect(
      blockingPorcelainPaths(
        ["?? ms-ai-dto/target/", "?? open-ai-sdk/target/", " M src/page.tsx"].join(
          "\n",
        ),
      ),
    ).toEqual(["src/page.tsx"]);
    expect(
      blockingPorcelainPaths("?? pkg/target/\n?? src/new-test.java"),
    ).toEqual(["src/new-test.java"]);
  });
});
