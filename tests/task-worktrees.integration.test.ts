/**
 * 任务隔离工作区（V0.10）集成测试——对真实临时 git 仓跑 ensure / remove 全流程
 *
 * 覆盖离线路径（无 origin remote）：fetch best-effort 失败后回退本地 base 分支建
 * worktree。断言：目录建好、分支检出对、.env 拷贝、幂等复用、清理后分支保留。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

// dataRoot 走环境变量、指到临时目录（import 被测模块前钉死）
const TMP_ROOT = path.join(os.tmpdir(), `fe-worktree-it-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  getTaskWorktreesDir,
  formatWorktreeCleanupNotes,
  removeTaskWorktrees,
  syncTaskWorktreesToRepoPaths,
  wipSnapshotRefName,
  WorktreeUnbindError,
} from "@/lib/server/task-worktrees";
import { getUniqueRepoDirNames } from "@/lib/path-utils";
import { resolveWkWorktreeBranchInfos } from "@/lib/server/wk-source-branch";

const REPO = path.join(TMP_ROOT, "origin-repo");
const DATA_DIR = process.env.FLOWSHIP_DATA_DIR!;

/** 模拟「任务仍存活」：自愈逻辑靠 tasks/<id> 是否存在判定孤儿 */
const markTaskAlive = async (taskId: string): Promise<void> => {
  await fs.mkdir(path.join(DATA_DIR, "tasks", taskId), { recursive: true });
};

/** 模拟「任务已删」：只留 worktree、清掉 tasks/<id> */
const markTaskDeleted = async (taskId: string): Promise<void> => {
  await fs.rm(path.join(DATA_DIR, "tasks", taskId), {
    recursive: true,
    force: true,
  });
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeTask = (patch: Partial<Task> = {}): Task =>
  ({
    id: "t_1700000000001_it",
    mode: "task",
    title: "集成测试",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [REPO],
    isolateWorktree: true,
    // 本地仓无 origin、base 显式指到本地已有分支（离线回退路径）
    repoBaseBranches: { [REPO]: "main" },
    feishuStoryUrl: "https://project.feishu.cn/x/story/detail/888888",
    actions: [],
    mrs: [],
    ...patch,
  }) as Task;

beforeAll(async () => {
  await fs.mkdir(REPO, { recursive: true });
  git(REPO, "init", "-b", "main");
  git(REPO, "config", "user.email", "t@t.local");
  git(REPO, "config", "user.name", "t");
  await fs.writeFile(path.join(REPO, "a.txt"), "hello\n");
  // gitignore 的 .env.local / 依赖目录——worktree 检出不带、靠拷贝 / 克隆
  await fs.writeFile(
    path.join(REPO, ".gitignore"),
    ".env.local\nnode_modules/\nvendor/\n.venv/\n",
  );
  await fs.writeFile(path.join(REPO, ".env.local"), "SECRET=1\n");
  // 模拟已装好的依赖目录（V0.11.3 白名单克隆的源）：node_modules（JS）+ vendor（PHP/Ruby/Go）
  await fs.mkdir(path.join(REPO, "node_modules", "some-pkg"), { recursive: true });
  await fs.writeFile(
    path.join(REPO, "node_modules", "some-pkg", "index.js"),
    "module.exports = 1;\n",
  );
  await fs.mkdir(path.join(REPO, "vendor", "acme"), { recursive: true });
  await fs.writeFile(path.join(REPO, "vendor", "acme", "lib.php"), "<?php\n");
  // .venv 是白名单外的反例（Python 虚拟环境路径写死、克隆过去是坏的、必须不跟过来）
  await fs.mkdir(path.join(REPO, ".venv", "bin"), { recursive: true });
  await fs.writeFile(path.join(REPO, ".venv", "bin", "python"), "#!/abs/path\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-m", "init");
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("ensureTaskWorktrees / removeTaskWorktrees 真 git 集成", () => {
  const task = makeTask();
  // 混合隔离后路径映射按「有没有 .git」分流——必须等外层 beforeAll 把仓 init 完
  // （.git 存在）再算 workDir，收集期算会被当成非 git 目录、原地返回 REPO 自身
  let workDir: string;
  beforeAll(() => {
    workDir = getTaskWorkRepoPaths(task)[0];
  });

  it("首次 ensure：建 worktree + 基于 base 检出新任务分支 + 拷 .env* + 克隆依赖目录", async () => {
    await markTaskAlive(task.id);
    const res = await ensureTaskWorktrees(task, () => true);
    expect(res.createdRepos).toEqual([REPO]);
    expect(res.infos[0].name).toBe("feature/888888-集成测试");
    expect(res.infos[0].baseBranch).toBe("main");

    // worktree 里检出的就是任务分支、原仓库 HEAD 不动
    expect(git(workDir, "branch", "--show-current")).toBe(
      "feature/888888-集成测试",
    );
    expect(git(REPO, "branch", "--show-current")).toBe("main");
    // 内容检出 + gitignore 的 .env.local 已拷过来
    await expect(fs.readFile(path.join(workDir, "a.txt"), "utf8")).resolves.toBe(
      "hello\n",
    );
    await expect(
      fs.readFile(path.join(workDir, ".env.local"), "utf8"),
    ).resolves.toBe("SECRET=1\n");
    // 依赖目录白名单克隆（APFS clonefile 仅 mac、其它平台跳过回退 agent 自装）
    if (process.platform === "darwin") {
      expect(res.clonedDeps).toEqual([
        { repoPath: REPO, dirs: ["node_modules", "vendor"] },
      ]);
      await expect(
        fs.readFile(path.join(workDir, "node_modules", "some-pkg", "index.js"), "utf8"),
      ).resolves.toBe("module.exports = 1;\n");
      await expect(
        fs.readFile(path.join(workDir, "vendor", "acme", "lib.php"), "utf8"),
      ).resolves.toBe("<?php\n");
    } else {
      expect(res.clonedDeps).toEqual([]);
    }
    // 白名单外的 .venv 绝不跟过来（Python venv 路径写死、克隆过去是坏的）
    await expect(fs.access(path.join(workDir, ".venv"))).rejects.toThrow();
  });

  it("二次 ensure 幂等：复用现成 worktree、createdRepos 为空", async () => {
    const res = await ensureTaskWorktrees(task, () => true);
    expect(res.createdRepos).toEqual([]);
  });

  it("同分支被占用时另一个 task 明确报错（git 同分支单检出约束）", async () => {
    // 同 feishuStoryUrl + 同 title → 渲染出同名分支、必撞「already checked out」
    // 先标活任务目录：否则自愈会把占用方误判成「已删任务孤儿」强删后重试成功
    await markTaskAlive(task.id);
    const other = makeTask({ id: "t_1700000000002_it" });
    await markTaskAlive(other.id);
    await expect(ensureTaskWorktrees(other, () => true)).rejects.toThrow(
      /创建隔离工作区失败/,
    );
  });

  it("ensure 撞已删任务孤儿 → 自愈释放后重试成功", async () => {
    // 前置：task 的 worktree 仍占用分支；清掉 tasks/<id> 模拟「删任务但 worktree 残留」
    await markTaskDeleted(task.id);
    const other = makeTask({ id: "t_1700000000006_orphan_heal" });
    await markTaskAlive(other.id);
    const res = await ensureTaskWorktrees(other, () => true);
    expect(res.createdRepos).toEqual([REPO]);
    const otherWork = getTaskWorkRepoPaths(other)[0];
    expect(git(otherWork, "branch", "--show-current")).toBe(
      "feature/888888-集成测试",
    );
    // 旧孤儿目录应已释放
    await expect(fs.access(workDir)).rejects.toThrow();
    // 清掉 other、把共享 task 的 worktree 建回来，方便后续用例
    await removeTaskWorktrees(other);
    await markTaskDeleted(other.id);
    await markTaskAlive(task.id);
    await ensureTaskWorktrees(task, () => true);
  });

  it("remove：脏工作区先自动 commit WIP 快照、目录删掉、任务分支保留在原仓库", async () => {
    // 模拟 build 完没 ship：worktree 里有未提交改动（改 tracked + 新增 untracked）
    await fs.writeFile(path.join(workDir, "a.txt"), "changed by build\n");
    await fs.writeFile(path.join(workDir, "new-file.ts"), "export const x = 1;\n");

    const removed = await removeTaskWorktrees(task);
    expect(removed.removedAny).toBe(true);
    expect(removed.snapshotRepos).toEqual([REPO]);
    expect(removed.snapshotFailedRepos).toEqual([]);
    await expect(fs.access(workDir)).rejects.toThrow();
    // 分支还在（合入前产物不丢、reopen 后可重建 worktree 续推）
    const branches = git(REPO, "branch", "--list", "feature/888888-集成测试");
    expect(branches).toContain("feature/888888-集成测试");
    // git 注册也清了（可立刻重建）
    expect(git(REPO, "worktree", "list")).not.toContain(workDir);
    // WIP 快照真的落在任务分支上（未提交改动没被 --force 销毁）
    expect(git(REPO, "log", "-1", "--format=%s", "feature/888888-集成测试")).toContain(
      "WIP",
    );
    const wipFiles = git(
      REPO,
      "show",
      "--stat",
      "--format=",
      "feature/888888-集成测试",
    );
    expect(wipFiles).toContain("a.txt");
    expect(wipFiles).toContain("new-file.ts");

    // review #2：快照同时落在 refs/flowship/wip/*（不依赖任务分支，detached 场景也不会悬空），
    // 且返回值带 ref / commit / 记到的任务分支，供事件文案如实描述
    const wipRef = wipSnapshotRefName(task.id, getUniqueRepoDirNames(task.repoPaths)[0]);
    expect(removed.snapshots).toHaveLength(1);
    expect(removed.snapshots![0]).toMatchObject({
      repoPath: REPO,
      ref: wipRef,
      branch: "feature/888888-集成测试",
    });
    expect(removed.snapshotFailures).toEqual([]);
    expect(git(REPO, "rev-parse", wipRef)).toBe(removed.snapshots![0].commit);
    // 任务分支 HEAD 与 wip ref 是同一个提交（附着分支 → 快进到同一 commit）
    expect(git(REPO, "rev-parse", "feature/888888-集成测试")).toBe(
      git(REPO, "rev-parse", wipRef),
    );
    // 被 .gitignore 忽略的文件（.env.local / node_modules）不进快照——只存用户代码改动
    const wipTree = git(REPO, "ls-tree", "-r", "--name-only", wipRef).split("\n");
    expect(wipTree).toContain("new-file.ts");
    expect(wipTree).not.toContain(".env.local");
    expect(wipTree.some((f) => f.startsWith("node_modules/"))).toBe(false);
    // 主仓 index / 工作区没被快照流程弄脏（临时 index 不污染真 index）
    expect(git(REPO, "status", "--porcelain")).toBe("");
  });

  it("移除后可重建（reopen 场景）：分支已存在 → 直接挂载、WIP 快照内容还在", async () => {
    const res = await ensureTaskWorktrees(task, () => true);
    expect(res.createdRepos).toEqual([REPO]);
    expect(git(workDir, "branch", "--show-current")).toBe(
      "feature/888888-集成测试",
    );
    // 上一条 case 的 WIP 快照随分支检出回来（产物真的没丢）
    await expect(
      fs.readFile(path.join(workDir, "new-file.ts"), "utf8"),
    ).resolves.toContain("export const x = 1;");
    const removed = await removeTaskWorktrees(task);
    // 这轮没新改动、不再落快照
    expect(removed.snapshotRepos).toEqual([]);
    expect(removed.snapshotFailedRepos).toEqual([]);
  });

  it("复用热路径：worktree 里手动 checkout 切走 → ensure 自动切回任务分支", async () => {
    await ensureTaskWorktrees(task, () => true);
    const taskBranch = "feature/888888-集成测试";
    // main 在原仓检出、不能在 worktree 再切；另建旁路分支模拟用户 / agent 手动切走
    git(REPO, "branch", "side-detour", "main");
    git(workDir, "checkout", "side-detour");
    expect(git(workDir, "branch", "--show-current")).toBe("side-detour");

    const res = await ensureTaskWorktrees(task, () => true);
    expect(res.createdRepos).toEqual([]);
    expect(git(workDir, "branch", "--show-current")).toBe(taskBranch);
  });

  it("快照失败保留 worktree：原仓被移走（git status 查不了）→ 目录不删、记 snapshotFailedRepos，修复后可再清", async () => {
    // 独立仓 + 独立 task（不污染共享 REPO 的后续用例）
    const repo2 = path.join(TMP_ROOT, "origin-repo-2");
    const repo2Moved = `${repo2}-moved`;
    await fs.mkdir(repo2, { recursive: true });
    git(repo2, "init", "-b", "main");
    git(repo2, "config", "user.email", "t@t.local");
    git(repo2, "config", "user.name", "t");
    await fs.writeFile(path.join(repo2, "b.txt"), "hi\n");
    git(repo2, "add", "-A");
    git(repo2, "commit", "-m", "init");

    const task2 = makeTask({
      id: "t_1700000000003_it",
      repoPaths: [repo2],
      repoBaseBranches: { [repo2]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/999999",
    });
    await markTaskAlive(task2.id);
    await ensureTaskWorktrees(task2, () => true);
    const workDir2 = getTaskWorkRepoPaths(task2)[0];
    // 工作区留未提交改动
    await fs.writeFile(path.join(workDir2, "uncommitted.txt"), "precious\n");

    // 原仓整个移走 → worktree 的 .git 指针失效、git status 必失败。
    // review #2：快照没落下就**不删**目录（此前是「仍强制删」→ 未提交改动随目录一起丢）
    await fs.rename(repo2, repo2Moved);
    try {
      const removed = await removeTaskWorktrees(task2);
      expect(removed.snapshotFailedRepos).toEqual([repo2]);
      expect(removed.snapshotRepos).toEqual([]);
      expect(removed.removedAny).toBe(false);
      expect(removed.snapshotFailures).toHaveLength(1);
      expect(removed.snapshotFailures![0]).toMatchObject({
        repoPath: repo2,
        workDir: workDir2,
      });
      expect(removed.snapshotFailures![0].reason).not.toBe("");
      // 未提交改动原封不动还在
      await expect(
        fs.readFile(path.join(workDir2, "uncommitted.txt"), "utf8"),
      ).resolves.toBe("precious\n");
    } finally {
      await fs.rename(repo2Moved, repo2).catch(() => {});
    }

    // 原仓还原后再清一次：这次快照成功 → 未提交改动进 refs/flowship/wip → 才删目录
    const retry = await removeTaskWorktrees(task2);
    expect(retry.snapshotFailedRepos).toEqual([]);
    expect(retry.snapshotRepos).toEqual([repo2]);
    expect(retry.removedAny).toBe(true);
    await expect(fs.access(workDir2)).rejects.toThrow();
    const wip2 = retry.snapshots![0];
    expect(git(repo2, "show", `${wip2.ref}:uncommitted.txt`)).toBe("precious");
  });

  it("remove：merge 冲突态 WIP 快照失败 → 保留 worktree、记 snapshotFailedRepos，解决冲突后可再清", async () => {
    // 前置：上一条 ensure 后 worktree 仍在任务分支上
    const taskBranch = "feature/888888-集成测试";
    const conflictFile = path.join(workDir, "conflict.txt");
    await fs.writeFile(conflictFile, "base\n");
    git(workDir, "add", "conflict.txt");
    git(workDir, "commit", "-m", "conflict base");

    // 两分支改同文件 → merge 必冲突（porcelain 出现 UU、工作区留下 <<<<<<<）
    git(workDir, "checkout", "-b", "conflict-side");
    await fs.writeFile(conflictFile, "from-side\n");
    git(workDir, "add", "conflict.txt");
    git(workDir, "commit", "-m", "side edit");

    git(workDir, "checkout", taskBranch);
    await fs.writeFile(conflictFile, "from-feature\n");
    git(workDir, "add", "conflict.txt");
    git(workDir, "commit", "-m", "feature edit");

    let mergeFailed = false;
    try {
      git(workDir, "merge", "conflict-side");
    } catch {
      mergeFailed = true;
    }
    expect(mergeFailed).toBe(true);
    const before = await fs.readFile(conflictFile, "utf8");
    expect(before).toMatch(/<<<<<<</);

    const removed = await removeTaskWorktrees(task);
    expect(removed.snapshotFailedRepos).toEqual([REPO]);
    expect(removed.snapshotRepos).toEqual([]);
    expect(removed.removedAny).toBe(false);
    expect(removed.snapshotFailures![0].reason).toMatch(/冲突|unmerged/);
    // review #2：冲突态没法安全快照 → 目录与冲突内容原样保留（此前会被 --force 删掉）
    await expect(fs.readFile(conflictFile, "utf8")).resolves.toMatch(/<<<<<<</);
    expect(git(REPO, "worktree", "list")).toContain(workDir);

    // 用户解决（这里直接 abort）后再清：干净 → 无需快照、正常删
    git(workDir, "merge", "--abort");
    const cleaned = await removeTaskWorktrees(task);
    expect(cleaned.snapshotFailedRepos).toEqual([]);
    expect(cleaned.removedAny).toBe(true);
    await expect(fs.access(workDir)).rejects.toThrow();
    expect(git(REPO, "worktree", "list")).not.toContain(workDir);
  });

  it("混合隔离：非 git 目录混进 repoPaths → ensure 不抛、映射原地、只建 git 仓 worktree", async () => {
    // 纯脚本目录（无 .git、测试团队挂脚本库场景）——旧实现在这里直接 throw 拦推进
    const scriptsDir = path.join(TMP_ROOT, "qa-scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, "run.sh"), "#!/bin/sh\necho ok\n");

    const mixed = makeTask({
      id: "t_1700000000004_it",
      repoPaths: [REPO, scriptsDir],
      nonGitRepoPaths: [scriptsDir],
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/777777",
    });

    // 路径映射：git 仓 → worktree 子目录；非 git → 原路径（index 对齐）
    const workPaths = getTaskWorkRepoPaths(mixed);
    expect(workPaths).toHaveLength(2);
    expect(workPaths[0]).not.toBe(REPO);
    expect(workPaths[0]).toContain(mixed.id);
    expect(workPaths[1]).toBe(scriptsDir);

    // ensure 平安走完：只建 git 仓的 worktree、非 git 跳过不抛
    const res = await ensureTaskWorktrees(mixed, () => true);
    expect(res.createdRepos).toEqual([REPO]);
    // 分支记录只有 git 仓（非 git 无分支概念、不进 gitBranches）
    expect(res.infos.map((i) => i.repoPath)).toEqual([REPO]);
    expect(git(workPaths[0], "branch", "--show-current")).toBe(
      "feature/777777-集成测试",
    );
    // 非 git 目录没被动过（没有 worktree 子目录、原文件还在）
    await expect(
      fs.readFile(path.join(scriptsDir, "run.sh"), "utf8"),
    ).resolves.toContain("echo ok");

    // 二次 ensure 幂等（非 git 跳过路径也幂等）
    const again = await ensureTaskWorktrees(mixed, () => true);
    expect(again.createdRepos).toEqual([]);

    // remove：只清 git 仓 worktree、绝不碰非 git 原目录
    const removed = await removeTaskWorktrees(mixed);
    expect(removed.removedAny).toBe(true);
    await expect(fs.access(workPaths[0])).rejects.toThrow();
    await expect(
      fs.readFile(path.join(scriptsDir, "run.sh"), "utf8"),
    ).resolves.toContain("echo ok");
  });

  it("全仓非 git 的隔离 task：ensure 等效 no-op、remove 不碰原目录", async () => {
    const onlyScripts = path.join(TMP_ROOT, "only-scripts");
    await fs.mkdir(onlyScripts, { recursive: true });
    await fs.writeFile(path.join(onlyScripts, "a.py"), "print(1)\n");

    const t = makeTask({
      id: "t_1700000000005_it",
      repoPaths: [onlyScripts],
      nonGitRepoPaths: [onlyScripts],
      repoBaseBranches: {},
    });
    expect(getTaskWorkRepoPaths(t)).toEqual([onlyScripts]);

    const res = await ensureTaskWorktrees(t, () => true);
    expect(res.createdRepos).toEqual([]);
    expect(res.infos).toEqual([]);

    const removed = await removeTaskWorktrees(t);
    expect(removed.removedAny).toBe(false);
    await expect(
      fs.readFile(path.join(onlyScripts, "a.py"), "utf8"),
    ).resolves.toBe("print(1)\n");
  });

  it("WK：先 detached 预热物理工作区，业务分支就绪后再原地绑定", async () => {
    const repo = path.join(TMP_ROOT, "wk-worktree-repo");
    await fs.mkdir(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t.local");
    git(repo, "config", "user.name", "t");
    await fs.writeFile(path.join(repo, "wk.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");

    const wkTask = makeTask({
      id: "t_1700000000007_wk",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      reqId: "REQ-777",
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/REQ-777",
    });
    await markTaskAlive(wkTask.id);
    const wkWorkDir = getTaskWorkRepoPaths(wkTask)[0];

    const prewarmed = await ensureTaskWorktrees(wkTask, () => true, {
      branchSelection: { kind: "detached" },
    });
    expect(prewarmed.infos).toEqual([]);
    expect(git(wkWorkDir, "branch", "--show-current")).toBe("");
    expect(git(repo, "branch", "--show-current")).toBe("main");

    // 分支尚不存在：帮切软跳过，不硬拦推进（worktree 保持 detached）
    await expect(resolveWkWorktreeBranchInfos(wkTask)).resolves.toEqual([]);
    await ensureTaskWorktrees(wkTask, () => true, {
      branchSelection: {
        kind: "explicit",
        infos: [{ repoPath: repo, name: "feature/REQ-777", baseBranch: "" }],
      },
    });
    expect(git(wkWorkDir, "branch", "--show-current")).toBe("");

    git(repo, "branch", "feature/REQ-777", "main");
    await expect(resolveWkWorktreeBranchInfos(wkTask)).resolves.toEqual([
      { repoPath: repo, name: "feature/REQ-777", baseBranch: "" },
    ]);
    const bound = await ensureTaskWorktrees(wkTask, () => true, {
      branchSelection: {
        kind: "explicit",
        infos: [{ repoPath: repo, name: "feature/REQ-777", baseBranch: "" }],
      },
    });
    expect(bound.createdRepos).toEqual([]);
    expect(git(wkWorkDir, "branch", "--show-current")).toBe(
      "feature/REQ-777",
    );
    expect(git(repo, "branch", "--show-current")).toBe("main");

    await removeTaskWorktrees(wkTask);
  });

  it("普通流程：detached 预热后首次 ensure 在原地创建 Flowship 分支", async () => {
    const repo = path.join(TMP_ROOT, "legacy-prewarm-repo");
    await fs.mkdir(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t.local");
    git(repo, "config", "user.name", "t");
    await fs.writeFile(path.join(repo, "base.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");

    const legacyTask = makeTask({
      id: "t_1700000000008_legacy",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/999001",
    });
    await markTaskAlive(legacyTask.id);
    const workDir = getTaskWorkRepoPaths(legacyTask)[0];
    await ensureTaskWorktrees(legacyTask, () => true, {
      branchSelection: { kind: "detached" },
    });
    expect(git(workDir, "branch", "--show-current")).toBe("");

    const bound = await ensureTaskWorktrees(legacyTask, () => true);
    expect(bound.infos[0].name).toBe("feature/999001-集成测试");
    expect(git(workDir, "branch", "--show-current")).toBe(
      "feature/999001-集成测试",
    );
    expect(git(repo, "branch", "--show-current")).toBe("main");

    await removeTaskWorktrees(legacyTask);
  });

  it("同 basename 两仓解绑靠前的：按旧短名拆、剩余仓从 foo-2 挪到 foo", async () => {
    const repoA = path.join(TMP_ROOT, "a", "app");
    const repoB = path.join(TMP_ROOT, "b", "app");
    for (const repo of [repoA, repoB]) {
      await fs.mkdir(repo, { recursive: true });
      git(repo, "init", "-b", "main");
      git(repo, "config", "user.email", "t@t.local");
      git(repo, "config", "user.name", "t");
      await fs.writeFile(path.join(repo, "f.txt"), "x\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-m", "init");
    }
    git(repoA, "checkout", "-b", "feature/unbind-a");
    git(repoA, "checkout", "main");
    git(repoB, "checkout", "-b", "feature/unbind-b");
    git(repoB, "checkout", "main");

    const oldPaths = [repoA, repoB];
    const task = makeTask({
      id: "t_1700000000009_samebase",
      repoPaths: oldPaths,
      repoBaseBranches: { [repoA]: "main", [repoB]: "main" },
      gitBranches: [
        { repoPath: repoA, name: "feature/unbind-a", baseBranch: "main" },
        { repoPath: repoB, name: "feature/unbind-b", baseBranch: "main" },
      ],
    });
    await markTaskAlive(task.id);
    await ensureTaskWorktrees(task, () => true, {
      branchSelection: {
        kind: "explicit",
        infos: [
          { repoPath: repoA, name: "feature/unbind-a", baseBranch: "main" },
          { repoPath: repoB, name: "feature/unbind-b", baseBranch: "main" },
        ],
      },
    });

    const oldNames = getUniqueRepoDirNames(oldPaths);
    expect(oldNames).toEqual(["app", "app-2"]);
    const taskDir = getTaskWorktreesDir(task.id);
    expect(
      await fs
        .stat(path.join(taskDir, "app"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await fs
        .stat(path.join(taskDir, "app-2"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    await fs.writeFile(path.join(taskDir, "app", "wip.txt"), "dirty\n");
    const sync = await syncTaskWorktreesToRepoPaths(task, oldPaths, [repoB]);
    expect(sync.unboundRepos).toEqual([repoA]);
    expect(sync.snapshotRepos).toContain(repoA);

    expect(
      await fs
        .stat(path.join(taskDir, "app"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await fs
        .stat(path.join(taskDir, "app-2"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    expect(git(path.join(taskDir, "app"), "branch", "--show-current")).toBe(
      "feature/unbind-b",
    );
    expect(git(repoA, "log", "feature/unbind-a", "-1", "--oneline")).toMatch(
      /WIP/,
    );

    const remaining = makeTask({
      ...task,
      repoPaths: [repoB],
      gitBranches: [
        { repoPath: repoB, name: "feature/unbind-b", baseBranch: "main" },
      ],
    });
    await removeTaskWorktrees(remaining);
  });

  it("S03-01：gitdir 指针失效（rev-parse 失败）时改名隔离保留未提交改动、不直接 rm，重复触发后缀唯一", async () => {
    const repo = path.join(TMP_ROOT, "broken-pointer-repo");
    await fs.mkdir(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t.local");
    git(repo, "config", "user.name", "t");
    await fs.writeFile(path.join(repo, "base.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");

    const t = makeTask({
      id: "t_1700000000010_brokenptr",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/999002",
    });
    await markTaskAlive(t.id);
    const wd = getTaskWorkRepoPaths(t)[0];
    await ensureTaskWorktrees(t, () => true);

    // 固定时间戳：第二轮同名目录必须追加 -1 后缀、不覆盖第一轮隔离目录
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      for (const round of [0, 1]) {
        // 用户未提交改动 + 把 .git 指针改坏（模拟主仓被移动 → git rev-parse 失败）
        await fs.writeFile(path.join(wd, `wip-${round}.txt`), `dirty-${round}\n`);
        await fs.writeFile(
          path.join(wd, ".git"),
          `gitdir: ${path.join(TMP_ROOT, "moved-away", ".git", "worktrees", "x")}\n`,
        );
        const res = await ensureTaskWorktrees(t, () => true);
        expect(res.infos[0].name).toBe("feature/999002-集成测试");
        // 重建后的新 worktree 是合法的
        expect(git(wd, "rev-parse", "--is-inside-work-tree")).toBe("true");
      }
    } finally {
      nowSpy.mockRestore();
    }

    const first = `${wd}.orphaned-1800000000000`;
    const second = `${wd}.orphaned-1800000000000-1`;
    await expect(fs.readFile(path.join(first, "wip-0.txt"), "utf8")).resolves.toBe(
      "dirty-0\n",
    );
    // 第二轮隔离的是第一轮重建出来的新目录——里面不应有 wip-0（新建的干净检出）、只有 wip-1
    await expect(fs.readFile(path.join(second, "wip-1.txt"), "utf8")).resolves.toBe(
      "dirty-1\n",
    );
    await expect(fs.access(path.join(second, "wip-0.txt"))).rejects.toThrow();
    // 新目录不带旧改动
    await expect(fs.access(path.join(wd, "wip-0.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(wd, "wip-1.txt"))).rejects.toThrow();

    await removeTaskWorktrees(t);
  });

  /** 建临时仓 + 已 ensure 的 worktree，返回任务与工作区路径 */
  const setupEnsuredTask = async (
    key: string,
    storyId: string,
  ): Promise<{ t: Task; wd: string }> => {
    const repo = path.join(TMP_ROOT, `${key}-repo`);
    await fs.mkdir(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t.local");
    git(repo, "config", "user.name", "t");
    await fs.writeFile(path.join(repo, "base.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");
    const t = makeTask({
      id: `t_1700000000020_${key}`,
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: `https://project.feishu.cn/x/story/detail/${storyId}`,
    });
    await markTaskAlive(t.id);
    const wd = getTaskWorkRepoPaths(t)[0];
    await ensureTaskWorktrees(t, () => true);
    return { t, wd };
  };

  it.each(["EBUSY", "EXDEV"])(
    "R2-01：带 .git 的损坏目录改名隔离失败（%s）时抛错、保留目录与未提交改动、不降级 rm",
    async (code) => {
      const { t, wd } = await setupEnsuredTask(
        `rename-fail-${code.toLowerCase()}`,
        code === "EBUSY" ? "999003" : "999004",
      );
      await fs.writeFile(path.join(wd, "wip.txt"), "dirty\n");
      await fs.writeFile(
        path.join(wd, ".git"),
        `gitdir: ${path.join(TMP_ROOT, "moved-away", ".git", "worktrees", "y")}\n`,
      );

      const realRename = fs.rename.bind(fs);
      const renameSpy = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (from, to) => {
          if (String(to).includes(".orphaned-")) {
            throw Object.assign(new Error(`${code}: rename failed`), { code });
          }
          return realRename(from, to);
        });
      try {
        await expect(ensureTaskWorktrees(t, () => true)).rejects.toThrow(
          /自动改名隔离失败[\s\S]*已保留原目录/,
        );
        await expect(ensureTaskWorktrees(t, () => true)).rejects.toThrow(
          new RegExp(wd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        expect(renameSpy).toHaveBeenCalled();
      } finally {
        renameSpy.mockRestore();
      }

      // 目录、未提交文件、坏 .git 指针全部原样、没有半截删除
      await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe(
        "dirty\n",
      );
      await expect(fs.readFile(path.join(wd, "base.txt"), "utf8")).resolves.toBe(
        "base\n",
      );
      await expect(fs.readFile(path.join(wd, ".git"), "utf8")).resolves.toContain(
        "moved-away",
      );
      // 没产生隔离目录
      const siblings = await fs.readdir(path.dirname(wd));
      expect(siblings.filter((n) => n.includes(".orphaned-"))).toEqual([]);

      await fs.rm(wd, { recursive: true, force: true });
      await removeTaskWorktrees(t);
    },
  );

  it("R2-01 回归：无 .git 的半截目录（只有依赖克隆残留）仍被清理并重建 worktree", async () => {
    const { t, wd } = await setupEnsuredTask("half-dir", "999005");
    // 模拟半截目录：整个工作区换成只有依赖残留、没有 .git
    await removeTaskWorktrees(t);
    await fs.mkdir(path.join(wd, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(wd, "node_modules", "pkg", "i.js"), "1\n");
    await expect(fs.access(path.join(wd, ".git"))).rejects.toThrow();

    const renameSpy = vi.spyOn(fs, "rename");
    try {
      const res = await ensureTaskWorktrees(t, () => true);
      expect(res.infos[0].name).toBe("feature/999005-集成测试");
      // 无 .git 不走改名隔离
      expect(
        renameSpy.mock.calls.some(([, to]) => String(to).includes(".orphaned-")),
      ).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
    expect(git(wd, "rev-parse", "--is-inside-work-tree")).toBe("true");
    await expect(fs.access(path.join(wd, "node_modules", "pkg", "i.js"))).rejects.toThrow();
    const siblings = await fs.readdir(path.dirname(wd));
    expect(siblings.filter((n) => n.includes(".orphaned-"))).toEqual([]);

    await removeTaskWorktrees(t);
  });

  // ───────────── N10-02：「坏掉」判定只认结构性证据，不再因一次 git 失败就改名隔离 ─────────────

  /** 读 worktree 的 `.git` 指针，返回它指向的 gitdir（主仓 `.git/worktrees/<name>`） */
  const readGitDirOf = async (wd: string): Promise<string> => {
    const raw = await fs.readFile(path.join(wd, ".git"), "utf8");
    return raw.match(/^gitdir:\s*(.+?)\s*$/m)![1];
  };

  /**
   * 在 PATH 最前面塞一个 git 包装：FLOWSHIP_TEST_GIT_FAIL_REVPARSE=1 时让
   * `rev-parse --is-inside-work-tree` 假失败（模拟超时 / 负载 / 权限等临时故障），其余命令原样透传给真 git。
   * 返回还原函数。仅 Unix（shell 脚本）。
   */
  const installFlakyGit = async (): Promise<() => void> => {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const binDir = path.join(TMP_ROOT, "flaky-git-bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$FLOWSHIP_TEST_GIT_FAIL_REVPARSE" = "1" ]; then',
        '  case "$*" in',
        '    *--is-inside-work-tree*) echo "fatal: simulated transient failure (load / timeout)" >&2; exit 128 ;;',
        "  esac",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ""}`;
    return () => {
      process.env.PATH = prevPath;
      delete process.env.FLOWSHIP_TEST_GIT_FAIL_REVPARSE;
    };
  };

  it.skipIf(process.platform === "win32")(
    "N10-02：rev-parse 临时失败但 .git 指针 / gitdir 完好 → 不改名、不删、抛错；恢复后原目录原样复用（未提交改动还在）",
    async () => {
      const { t, wd } = await setupEnsuredTask("transient-git", "999010");
      await fs.writeFile(path.join(wd, "wip.txt"), "dirty\n");
      const pointerBefore = await fs.readFile(path.join(wd, ".git"), "utf8");

      const restore = await installFlakyGit();
      const renameSpy = vi.spyOn(fs, "rename");
      const rmSpy = vi.spyOn(fs, "rm");
      try {
        process.env.FLOWSHIP_TEST_GIT_FAIL_REVPARSE = "1";
        // 连续两次都是临时失败：每次都只抛错、都不动目录（报错里带 git 的 stderr 方便排查）
        for (let i = 0; i < 2; i++) {
          await expect(ensureTaskWorktrees(t, () => true)).rejects.toThrow(
            /simulated transient failure[\s\S]*没有证据表明目录已损坏[\s\S]*已保留原目录/,
          );
        }
        expect(
          renameSpy.mock.calls.some(([, to]) => String(to).includes(".orphaned-")),
        ).toBe(false);
        expect(rmSpy.mock.calls.filter(([p]) => String(p) === wd)).toEqual([]);
      } finally {
        renameSpy.mockRestore();
        rmSpy.mockRestore();
        restore();
      }

      // 抛错期间目录、未提交文件、指针全部原样、没有隔离目录
      await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe("dirty\n");
      await expect(fs.readFile(path.join(wd, ".git"), "utf8")).resolves.toBe(pointerBefore);
      const siblings = await fs.readdir(path.dirname(wd));
      expect(siblings.filter((n) => n.includes(".orphaned-"))).toEqual([]);

      // git 恢复后再 ensure：复用同一个目录（没有新建 / 重建），改动还在
      const res = await ensureTaskWorktrees(t, () => true);
      expect(res.createdRepos).toEqual([]);
      await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe("dirty\n");
      expect(git(wd, "rev-parse", "--is-inside-work-tree")).toBe("true");

      await removeTaskWorktrees(t);
    },
    60_000,
  );

  type BreakCase = {
    name: string;
    storyId: string;
    /** 把 worktree 的 .git 结构弄坏成 git 必定认不出的样子 */
    breakIt: (wd: string) => Promise<void>;
  };
  const breakCases: BreakCase[] = [
    {
      name: ".git 指针文件被截断成空文件",
      storyId: "999011",
      breakIt: async (wd) => {
        await fs.writeFile(path.join(wd, ".git"), "");
      },
    },
    {
      name: ".git 指针文件内容不是 gitdir: 行",
      storyId: "999012",
      breakIt: async (wd) => {
        await fs.writeFile(path.join(wd, ".git"), "garbage\n");
      },
    },
    {
      name: "指针指向的 gitdir 缺 HEAD",
      storyId: "999013",
      breakIt: async (wd) => {
        await fs.rm(path.join(await readGitDirOf(wd), "HEAD"));
      },
    },
    {
      name: "指针指向的 worktree gitdir 缺 commondir",
      storyId: "999014",
      breakIt: async (wd) => {
        await fs.rm(path.join(await readGitDirOf(wd), "commondir"));
      },
    },
    {
      name: ".git 被换成缺 HEAD 的空目录",
      storyId: "999015",
      breakIt: async (wd) => {
        await fs.rm(path.join(wd, ".git"));
        await fs.mkdir(path.join(wd, ".git"));
      },
    },
    // ───── M6-02：HEAD 在、但内容不是合法 ref / sha——git 实测同样 `fatal: not a git repository` ─────
    {
      name: "M6-02：指针指向的 gitdir 的 HEAD 是空文件",
      storyId: "999016",
      breakIt: async (wd) => {
        await fs.writeFile(path.join(await readGitDirOf(wd), "HEAD"), "");
      },
    },
    {
      name: "M6-02：指针指向的 gitdir 的 HEAD 是垃圾内容",
      storyId: "999017",
      breakIt: async (wd) => {
        await fs.writeFile(path.join(await readGitDirOf(wd), "HEAD"), "garbage\n");
      },
    },
    {
      name: "M6-02：指针指向的 gitdir 的 HEAD 只有 39 位十六进制（不是合法 sha）",
      storyId: "999018",
      breakIt: async (wd) => {
        await fs.writeFile(
          path.join(await readGitDirOf(wd), "HEAD"),
          `${"a".repeat(39)}\n`,
        );
      },
    },
    {
      name: "M6-02：.git 目录里的 HEAD 是空文件",
      storyId: "999019",
      breakIt: async (wd) => {
        await fs.rm(path.join(wd, ".git"));
        await fs.mkdir(path.join(wd, ".git"));
        await fs.writeFile(path.join(wd, ".git", "HEAD"), "");
      },
    },
    // ───── M6-01 对照：主仓本身可达、只是 worktree 登记没了——这才是「指针失效」的正面证据 ─────
    {
      name: "M6-01 对照：主仓可达、但 worktree 登记目录（.git/worktrees/<name>）被删",
      storyId: "999020",
      breakIt: async (wd) => {
        await fs.rm(await readGitDirOf(wd), { recursive: true, force: true });
      },
    },
  ];

  it.each(breakCases)(
    "N10-02：结构性损坏（$name）仍改名隔离保留未提交改动并重建",
    async ({ name, storyId, breakIt }) => {
      const key = `struct-${storyId}`;
      const { t, wd } = await setupEnsuredTask(key, storyId);
      await fs.writeFile(path.join(wd, "wip.txt"), `dirty-${name}\n`);
      await breakIt(wd);

      const res = await ensureTaskWorktrees(t, () => true);
      expect(res.createdRepos).toHaveLength(1);

      // 旧目录被改名隔离、未提交改动原样在里面
      const siblings = await fs.readdir(path.dirname(wd));
      const isolated = siblings.filter((n) => n.includes(".orphaned-"));
      expect(isolated).toHaveLength(1);
      await expect(
        fs.readFile(path.join(path.dirname(wd), isolated[0], "wip.txt"), "utf8"),
      ).resolves.toBe(`dirty-${name}\n`);
      // 原路径上是重新建好的合法 worktree（不带旧改动）
      expect(git(wd, "rev-parse", "--is-inside-work-tree")).toBe("true");
      await expect(fs.access(path.join(wd, "wip.txt"))).rejects.toThrow();

      await removeTaskWorktrees(t);
    },
    60_000,
  );

  // ───────────── 第四轮 M6：边缘形态（主仓不可达 / HEAD 内容合法性 / 悬空软链） ─────────────

  /** 软链 / 改权限 / 假 git 都是 Unix 手段；Windows 跳过（见汇报「未验证项」） */
  const itPosix = process.platform === "win32" ? it.skip : it;
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** 目录里名字带 .orphaned- 的兄弟项（改名隔离留下的） */
  const isolatedSiblings = async (wd: string): Promise<string[]> =>
    (await fs.readdir(path.dirname(wd))).filter((n) => n.includes(".orphaned-"));
  /** 断言：ensure 抛了「不动目录」的错——没产生 .orphaned-、没对 wd 递归 rm */
  const expectLeftUntouched = async (
    run: () => Promise<unknown>,
    wd: string,
    messageRe: RegExp,
    times = 2,
  ): Promise<void> => {
    const renameSpy = vi.spyOn(fs, "rename");
    const rmSpy = vi.spyOn(fs, "rm");
    try {
      // 连续多次：每次都只抛错、都不动目录（下次推进自然重试，不是一次性判决）
      for (let i = 0; i < times; i++) {
        await expect(run()).rejects.toThrow(messageRe);
      }
      expect(
        renameSpy.mock.calls.some(([, to]) => String(to).includes(".orphaned-")),
      ).toBe(false);
      expect(rmSpy.mock.calls.filter(([p]) => String(p) === wd)).toEqual([]);
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }
    expect(await isolatedSiblings(wd)).toEqual([]);
  };

  it("M6-01：主仓暂时不可达（整个目录改名模拟没挂载）→ 不隔离不删、抛错带挂载提示与路径、改动原地不动；主仓恢复后复用同一目录", async () => {
    const { t, wd } = await setupEnsuredTask("repo-unmounted", "999030");
    const repo = t.repoPaths[0];
    await fs.writeFile(path.join(wd, "wip.txt"), "dirty\n");
    const pointerBefore = await fs.readFile(path.join(wd, ".git"), "utf8");
    // 指针里记的主仓 .git（macOS tmpdir 下是 realpath、跟 repo 字面路径可能不同），报错里应带的就是它
    const mainGit = path.resolve(path.dirname(path.dirname(await readGitDirOf(wd))));
    const away = `${repo}.away`;
    await fs.rename(repo, away);
    try {
      await expectLeftUntouched(
        () => ensureTaskWorktrees(t, () => true),
        wd,
        new RegExp(
          `主仓暂时不可达（是否未挂载？）[\\s\\S]*${escapeRe(mainGit)}[\\s\\S]*已保留原目录`,
        ),
      );
    } finally {
      // 无论断言成败都要还原主仓，否则后续用例 / afterAll 清理受影响
      await fs.rename(away, repo);
    }

    // 主仓回来：目录、未提交文件、指针全部原样，复用同一目录（没有重建）
    await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe("dirty\n");
    await expect(fs.readFile(path.join(wd, ".git"), "utf8")).resolves.toBe(pointerBefore);
    const res = await ensureTaskWorktrees(t, () => true);
    expect(res.createdRepos).toEqual([]);
    await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe("dirty\n");
    expect(git(wd, "rev-parse", "--is-inside-work-tree")).toBe("true");

    await removeTaskWorktrees(t);
  }, 60_000);

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  (process.platform === "win32" || isRoot ? it.skip : it)(
    "M6-01：主仓目录无权限（stat 报 EACCES、不是 ENOENT）→ 同样不当成损坏、不隔离，带不可达提示；权限恢复后复用",
    async () => {
      const { t, wd } = await setupEnsuredTask("repo-eacces", "999031");
      const repo = t.repoPaths[0];
      await fs.writeFile(path.join(wd, "wip.txt"), "dirty\n");
      await fs.chmod(repo, 0o000);
      try {
        await expectLeftUntouched(
          () => ensureTaskWorktrees(t, () => true),
          wd,
          /主仓暂时不可达（是否未挂载？）[\s\S]*已保留原目录/,
        );
      } finally {
        await fs.chmod(repo, 0o755);
      }

      const res = await ensureTaskWorktrees(t, () => true);
      expect(res.createdRepos).toEqual([]);
      await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe("dirty\n");

      await removeTaskWorktrees(t);
    },
    60_000,
  );

  /** HEAD 的几种 git 认的合法写法（相对 sha 构造）——这些不能被误判成损坏 */
  const validHeads: Array<{
    name: string;
    storyId: string;
    head: (sha: string) => string;
  }> = [
    { name: "ref 无空格（ref:refs/heads/x）", storyId: "999040", head: () => "ref:refs/heads/x\n" },
    { name: "detached 40 位 sha1", storyId: "999041", head: (sha) => `${sha}\n` },
    {
      name: "detached 64 位十六进制（sha256 形态）",
      storyId: "999042",
      head: (sha) => `${sha}${sha.slice(0, 24)}\n`,
    },
  ];
  itPosix.each(validHeads)(
    "M6-02 反例：HEAD 是 git 认的合法写法（$name）+ rev-parse 临时失败 → 仍不隔离、抛错，不误伤",
    async ({ storyId, head }) => {
      const { t, wd } = await setupEnsuredTask(`valid-head-${storyId}`, storyId);
      await fs.writeFile(path.join(wd, "wip.txt"), "dirty\n");
      const headFile = path.join(await readGitDirOf(wd), "HEAD");
      const headBefore = await fs.readFile(headFile, "utf8");
      const sha = git(t.repoPaths[0], "rev-parse", "HEAD");
      await fs.writeFile(headFile, head(sha));

      const restore = await installFlakyGit();
      try {
        process.env.FLOWSHIP_TEST_GIT_FAIL_REVPARSE = "1";
        await expectLeftUntouched(
          () => ensureTaskWorktrees(t, () => true),
          wd,
          /没有证据表明目录已损坏[\s\S]*已保留原目录/,
        );
      } finally {
        restore();
        await fs.writeFile(headFile, headBefore);
      }

      const res = await ensureTaskWorktrees(t, () => true);
      expect(res.createdRepos).toEqual([]);
      await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe("dirty\n");

      await removeTaskWorktrees(t);
    },
    60_000,
  );

  itPosix(
    "M6-02 反例：旧式软链 HEAD（core.preferSymlinkRefs，loose ref 不在 → 软链悬空，但 git 认）+ rev-parse 临时失败 → 不当成「缺 HEAD」、不隔离",
    async () => {
      const { t, wd } = await setupEnsuredTask("symlink-head", "999043");
      await fs.writeFile(path.join(wd, "wip.txt"), "dirty\n");
      // 工作区换成「独立仓 + 软链 HEAD」：.git 是目录，HEAD → refs/heads/main（未出生分支，loose ref 不存在 → 软链悬空）
      await fs.rm(path.join(wd, ".git"));
      git(wd, "-c", "core.preferSymlinkRefs=true", "init", "-q", "-b", "main");
      const headFile = path.join(wd, ".git", "HEAD");
      expect((await fs.lstat(headFile)).isSymbolicLink()).toBe(true);
      // open 跟随软链会 ENOENT——这正是旧实现把它误判成「缺 HEAD」的原因
      await expect(fs.access(headFile)).rejects.toThrow();
      // 对照：git 自己认这种仓（否则本用例没有意义）
      expect(git(wd, "rev-parse", "--is-inside-work-tree")).toBe("true");

      const restore = await installFlakyGit();
      try {
        process.env.FLOWSHIP_TEST_GIT_FAIL_REVPARSE = "1";
        await expectLeftUntouched(
          () => ensureTaskWorktrees(t, () => true),
          wd,
          /没有证据表明目录已损坏[\s\S]*已保留原目录/,
        );
      } finally {
        restore();
      }
      await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe("dirty\n");
      expect((await fs.lstat(headFile)).isSymbolicLink()).toBe(true);

      await fs.rm(wd, { recursive: true, force: true });
      await removeTaskWorktrees(t);
    },
    60_000,
  );

  itPosix(
    "M6-03：.git 是悬空软链（相对目标不存在、其所在目录可达）→ 正面证据，改名隔离保留改动并重建",
    async () => {
      const { t, wd } = await setupEnsuredTask("dangling-link", "999032");
      await fs.writeFile(path.join(wd, "wip.txt"), "dirty-link\n");
      await fs.rm(path.join(wd, ".git"));
      // 相对目标按软链所在目录（workDir）解析：落在 <taskDir>/no-such-dotgit，其所在 <taskDir> 存在
      await fs.symlink("../no-such-dotgit", path.join(wd, ".git"));

      const res = await ensureTaskWorktrees(t, () => true);
      expect(res.createdRepos).toHaveLength(1);

      const isolated = await isolatedSiblings(wd);
      expect(isolated).toHaveLength(1);
      const orphan = path.join(path.dirname(wd), isolated[0]);
      await expect(fs.readFile(path.join(orphan, "wip.txt"), "utf8")).resolves.toBe(
        "dirty-link\n",
      );
      // 软链本身原样搬进隔离目录（没被跟随删除）
      expect((await fs.lstat(path.join(orphan, ".git"))).isSymbolicLink()).toBe(true);
      expect(git(wd, "rev-parse", "--is-inside-work-tree")).toBe("true");
      await expect(fs.access(path.join(wd, "wip.txt"))).rejects.toThrow();

      await removeTaskWorktrees(t);
    },
    60_000,
  );

  itPosix(
    "M6-03：悬空软链的目标所在目录不可达（疑似没挂载）→ 不隔离、抛挂载提示；目录「挂回来」后同一目录被判坏并重建",
    async () => {
      const { t, wd } = await setupEnsuredTask("dangling-unmounted", "999033");
      await fs.writeFile(path.join(wd, "wip.txt"), "dirty-unmounted\n");
      await fs.rm(path.join(wd, ".git"));
      const mountRoot = path.join(TMP_ROOT, "unmounted-disk");
      const target = path.join(mountRoot, "repo", ".git");
      await fs.symlink(target, path.join(wd, ".git"));

      await expectLeftUntouched(
        () => ensureTaskWorktrees(t, () => true),
        wd,
        new RegExp(
          `主仓暂时不可达（是否未挂载？）[\\s\\S]*${escapeRe(path.dirname(target))}[\\s\\S]*已保留原目录`,
        ),
      );
      await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe(
        "dirty-unmounted\n",
      );
      expect((await fs.lstat(path.join(wd, ".git"))).isSymbolicLink()).toBe(true);

      // 目标所在目录「挂回来」但里面确实没有 .git → 这回是确凿的悬空软链、照常隔离重建
      await fs.mkdir(path.dirname(target), { recursive: true });
      const res = await ensureTaskWorktrees(t, () => true);
      expect(res.createdRepos).toHaveLength(1);
      const isolated = await isolatedSiblings(wd);
      expect(isolated).toHaveLength(1);
      await expect(
        fs.readFile(path.join(path.dirname(wd), isolated[0], "wip.txt"), "utf8"),
      ).resolves.toBe("dirty-unmounted\n");

      await removeTaskWorktrees(t);
    },
    60_000,
  );

  itPosix(
    "M6-03 补充：悬空软链是多跳（.git → 本地软链 → 没挂载的路径）→ 沿链走到末端判不可达，不被第一跳「所在目录可达」误判成损坏",
    async () => {
      const { t, wd } = await setupEnsuredTask("dangling-chain", "999034");
      await fs.writeFile(path.join(wd, "wip.txt"), "dirty-chain\n");
      await fs.rm(path.join(wd, ".git"));
      // 第一跳（<taskDir>/gitdir-hop）本身在、所在目录也在；真正够不着的是它再往后指的那块盘
      const hop = path.join(path.dirname(wd), "gitdir-hop");
      const target = path.join(TMP_ROOT, "unmounted-chain-disk", "repo", ".git");
      await fs.symlink(target, hop);
      await fs.symlink("../gitdir-hop", path.join(wd, ".git"));

      await expectLeftUntouched(
        () => ensureTaskWorktrees(t, () => true),
        wd,
        new RegExp(
          `主仓暂时不可达（是否未挂载？）[\\s\\S]*${escapeRe(path.dirname(target))}[\\s\\S]*已保留原目录`,
        ),
      );
      await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe(
        "dirty-chain\n",
      );

      // 末端所在目录「挂回来」但没有 .git → 确凿的悬空软链链、照常隔离重建，改动在 .orphaned-*
      await fs.mkdir(path.dirname(target), { recursive: true });
      const res = await ensureTaskWorktrees(t, () => true);
      expect(res.createdRepos).toHaveLength(1);
      const isolated = await isolatedSiblings(wd);
      expect(isolated).toHaveLength(1);
      await expect(
        fs.readFile(path.join(path.dirname(wd), isolated[0], "wip.txt"), "utf8"),
      ).resolves.toBe("dirty-chain\n");

      await fs.rm(hop, { force: true });
      await removeTaskWorktrees(t);
    },
    60_000,
  );

  it("M6-01 补充：任务主仓 repoPath 自己是 linked worktree（.git 是指针文件），gitdir 宿主没挂载 → 不能因 repoPath/.git「存在」就判可重建而隔离", async () => {
    const key = "repo-linked-wt";
    const host = path.join(TMP_ROOT, `${key}-host`);
    const repo = path.join(TMP_ROOT, `${key}-repo`);
    await fs.mkdir(host, { recursive: true });
    git(host, "init", "-b", "main");
    git(host, "config", "user.email", "t@t.local");
    git(host, "config", "user.name", "t");
    await fs.writeFile(path.join(host, "base.txt"), "base\n");
    git(host, "add", "-A");
    git(host, "commit", "-m", "init");
    // repo 是 host 的 linked worktree：它的 .git 只是个指向 host/.git/worktrees/<name> 的指针文件
    git(host, "worktree", "add", "--detach", repo);
    expect((await fs.lstat(path.join(repo, ".git"))).isFile()).toBe(true);

    const t = makeTask({
      id: `t_1700000000020_${key}`,
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/999035",
    });
    await markTaskAlive(t.id);
    const wd = getTaskWorkRepoPaths(t)[0];
    await ensureTaskWorktrees(t, () => true);
    await fs.writeFile(path.join(wd, "wip.txt"), "dirty-linked\n");

    // host 整个挪走模拟没挂载：repo 目录本身还在本地、repo/.git 文件也还在，但它指向的 gitdir 够不着
    const away = `${host}.away`;
    await fs.rename(host, away);
    try {
      await expectLeftUntouched(
        () => ensureTaskWorktrees(t, () => true),
        wd,
        /主仓暂时不可达（是否未挂载？）[\s\S]*已保留原目录/,
      );
    } finally {
      await fs.rename(away, host);
    }

    // host 回来：同一目录原样复用、改动还在
    const res = await ensureTaskWorktrees(t, () => true);
    expect(res.createdRepos).toEqual([]);
    await expect(fs.readFile(path.join(wd, "wip.txt"), "utf8")).resolves.toBe(
      "dirty-linked\n",
    );
    expect(git(wd, "rev-parse", "--is-inside-work-tree")).toBe("true");

    await removeTaskWorktrees(t);
  }, 60_000);
});

/**
 * review #2：删 worktree 前的 WIP 快照改 plumbing（临时 index → write-tree → commit-tree → update-ref），
 * 并且「快照没落下就不删目录」。下面几条用真 git 复现 review 里的三类故障：
 * 签名 / prepare-commit-msg 让 `git commit` 失败、detached HEAD 快照悬空、失败后仍强删。
 */
describe("WIP 快照（review #2）：落 refs/flowship/wip、失败保留 worktree", () => {
  /** 静默跑 git（预期会失败的调用不往测试输出里喷 fatal 噪音） */
  const gitQuiet = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

  const initRepo = async (name: string): Promise<string> => {
    const repo = path.join(TMP_ROOT, name);
    await fs.mkdir(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t.local");
    git(repo, "config", "user.name", "t");
    await fs.writeFile(path.join(repo, "f.txt"), "base\n");
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");
    return repo;
  };

  /** 在 ref 名下先占一个子 ref → 之后 update-ref 该 ref 必因 D/F 冲突失败（确定性地让「落 ref」这一步挂掉） */
  const blockWipRef = (repo: string, taskId: string, dirName: string): string => {
    const ref = wipSnapshotRefName(taskId, dirName);
    git(repo, "update-ref", `${ref}/blocker`, "HEAD");
    return ref;
  };

  it("detached HEAD + commit.gpgsign=true + 必失败的 prepare-commit-msg：旧写法 commit 必挂，新快照照样落到 ref、ref 不悬空、忽略文件不入快照", async () => {
    const repo = await initRepo("wip-gpg-repo");
    // 复现 review 的环境：签名程序不可用 + prepare-commit-msg hook 失败（--no-verify 对这个 hook 无效）
    git(repo, "config", "commit.gpgsign", "true");
    git(repo, "config", "gpg.program", "false");
    const hook = path.join(repo, ".git", "hooks", "prepare-commit-msg");
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const t = makeTask({
      id: "t_1700000000101_wipgpg",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/555101",
    });
    await markTaskAlive(t.id);
    // detached 预热：worktree 没有任何分支（旧实现 commit 出来后无 ref 指向）
    await ensureTaskWorktrees(t, () => true, { branchSelection: { kind: "detached" } });
    const wd = getTaskWorkRepoPaths(t)[0];
    expect(git(wd, "branch", "--show-current")).toBe("");

    await fs.writeFile(path.join(wd, "f.txt"), "changed\n");
    await fs.writeFile(path.join(wd, "new.ts"), "export const n = 1;\n");
    await fs.writeFile(path.join(wd, ".env.local"), "SECRET=1\n");
    // 对照：旧写法（add -A && commit --no-verify）在这个环境下确实失败
    expect(() =>
      gitQuiet(wd, "commit", "--allow-empty", "--no-verify", "-m", "x"),
    ).toThrow();
    // …且失败的 commit 没留下任何东西（HEAD 仍是 main 的那个提交）
    expect(git(wd, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));

    const mainTip = git(repo, "rev-parse", "main");
    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(removed.snapshotRepos).toEqual([repo]);
    expect(removed.removedAny).toBe(true);
    await expect(fs.access(wd)).rejects.toThrow();
    expect(git(repo, "worktree", "list")).not.toContain(wd);

    const snap = removed.snapshots![0];
    expect(snap.ref).toBe(wipSnapshotRefName(t.id, "wip-gpg-repo"));
    // detached：没有分支可记 → 只落在 ref 上，如实不声称「记到了任务分支」
    expect(snap.branch).toBeUndefined();
    // ref 真的指向快照 commit（不悬空）、parent 是原 HEAD、main 没被动
    expect(git(repo, "rev-parse", snap.ref)).toBe(snap.commit);
    expect(git(repo, "rev-parse", `${snap.ref}^`)).toBe(mainTip);
    expect(git(repo, "rev-parse", "main")).toBe(mainTip);
    // 内容：tracked 改动 + untracked 新文件在；被 .gitignore 忽略的 .env.local 不在
    expect(git(repo, "show", `${snap.ref}:f.txt`)).toBe("changed");
    expect(git(repo, "show", `${snap.ref}:new.ts`)).toContain("export const n = 1;");
    expect(git(repo, "ls-tree", "-r", "--name-only", snap.ref).split("\n")).not.toContain(
      ".env.local",
    );
    // 有 reflog（--create-reflog）：同一任务再次快照覆盖 ref 时旧版本仍可找回
    expect(git(repo, "reflog", "show", snap.ref)).toContain(snap.commit.slice(0, 7));
    // 原仓 main 工作区干净、没被临时 index 弄脏
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("落 ref 失败（ref 名被占）→ worktree 保留、未提交改动与分支原样、removedAny=false；修好后再清成功", async () => {
    const repo = await initRepo("wip-keep-repo");
    const t = makeTask({
      id: "t_1700000000102_wipkeep",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/555102",
    });
    await markTaskAlive(t.id);
    await ensureTaskWorktrees(t, () => true);
    const wd = getTaskWorkRepoPaths(t)[0];
    const branch = git(wd, "branch", "--show-current");
    const branchTip = git(repo, "rev-parse", branch);
    await fs.writeFile(path.join(wd, "precious.txt"), "do-not-lose\n");

    const ref = blockWipRef(repo, t.id, "wip-keep-repo");
    const removed = await removeTaskWorktrees(t);
    expect(removed.removedAny).toBe(false);
    expect(removed.snapshotRepos).toEqual([]);
    expect(removed.snapshotFailedRepos).toEqual([repo]);
    expect(removed.snapshotFailures![0].workDir).toBe(wd);
    expect(removed.snapshotFailures![0].reason).toContain("update-ref");
    // 目录、改动、git 注册、分支都没动
    await expect(fs.readFile(path.join(wd, "precious.txt"), "utf8")).resolves.toBe(
      "do-not-lose\n",
    );
    expect(git(repo, "worktree", "list")).toContain(wd);
    expect(git(repo, "rev-parse", branch)).toBe(branchTip);
    // 事件文案如实：保留、不是「已强制删除」
    const { snapshotNote, failedNote } = formatWorktreeCleanupNotes(removed);
    expect(snapshotNote).toBe("");
    expect(failedNote).toContain("工作区已保留未删除");
    expect(failedNote).not.toContain("强制删除");

    // 用户处理掉占位后再清：这次成功、分支前进到 WIP（附着在任务分支上）
    git(repo, "update-ref", "-d", `${ref}/blocker`);
    const retry = await removeTaskWorktrees(t);
    expect(retry.snapshotFailedRepos).toEqual([]);
    expect(retry.removedAny).toBe(true);
    await expect(fs.access(wd)).rejects.toThrow();
    expect(retry.snapshots![0].branch).toBe(branch);
    expect(git(repo, "show", `${ref}:precious.txt`)).toBe("do-not-lose");
    expect(git(repo, "rev-parse", branch)).toBe(git(repo, "rev-parse", ref));
  });

  it("HEAD 附着的不是任务分支（已知任务分支名时）：只写 ref、不污染那条别的分支", async () => {
    const repo = await initRepo("wip-wrongbranch-repo");
    git(repo, "branch", "integration", "main");
    const t = makeTask({
      id: "t_1700000000103_wipwrong",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/555103",
      gitBranches: [{ repoPath: repo, name: "feature/555103-集成测试", baseBranch: "main" }],
    });
    await markTaskAlive(t.id);
    await ensureTaskWorktrees(t, () => true);
    const wd = getTaskWorkRepoPaths(t)[0];
    // 模拟 agent 手滑把 worktree 切到了集成分支（#10 的 checkout -B 类场景）
    git(wd, "checkout", "integration");
    await fs.writeFile(path.join(wd, "stray.txt"), "oops\n");
    const integrationTip = git(repo, "rev-parse", "integration");

    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotRepos).toEqual([repo]);
    expect(removed.snapshots![0].branch).toBeUndefined();
    // 集成分支没被塞 WIP commit，改动只在 ref 上
    expect(git(repo, "rev-parse", "integration")).toBe(integrationTip);
    expect(git(repo, "show", `${removed.snapshots![0].ref}:stray.txt`)).toBe("oops");
  });

  it("ensure 撞已删任务孤儿：孤儿有未提交改动 → 先落 ref 再释放（不动分支）；快照失败 → 不强删、ensure 抛错", async () => {
    const repo = await initRepo("wip-orphan-repo");
    const story = "https://project.feishu.cn/x/story/detail/555104";
    const a = makeTask({
      id: "t_1700000000104_orphan_a",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: story,
    });
    const b = makeTask({
      id: "t_1700000000105_orphan_b",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: story,
    });
    await markTaskAlive(a.id);
    await ensureTaskWorktrees(a, () => true);
    const wdA = getTaskWorkRepoPaths(a)[0];
    const branch = git(wdA, "branch", "--show-current");
    const branchTip = git(repo, "rev-parse", branch);
    await fs.writeFile(path.join(wdA, "orphan-dirty.txt"), "from-a\n");
    // 删任务但 worktree 残留（tasks/<id> 没了），另一个任务同 story 要用同名分支
    await markTaskDeleted(a.id);
    await markTaskAlive(b.id);

    const ref = blockWipRef(repo, a.id, "wip-orphan-repo");
    await expect(ensureTaskWorktrees(b, () => true)).rejects.toThrow(/创建隔离工作区失败/);
    // 孤儿没被强删：改动还在、git 仍登记着
    await expect(fs.readFile(path.join(wdA, "orphan-dirty.txt"), "utf8")).resolves.toBe(
      "from-a\n",
    );
    expect(git(repo, "worktree", "list")).toContain(wdA);

    // 占位清掉后重试：孤儿先快照（只写 ref、任务已删不动分支）再释放，b 成功接管分支
    git(repo, "update-ref", "-d", `${ref}/blocker`);
    const res = await ensureTaskWorktrees(b, () => true);
    expect(res.createdRepos).toEqual([repo]);
    await expect(fs.access(wdA)).rejects.toThrow();
    expect(git(repo, "show", `${ref}:orphan-dirty.txt`)).toBe("from-a");
    expect(git(repo, "rev-parse", branch)).toBe(branchTip);

    await removeTaskWorktrees(b);
    await markTaskDeleted(b.id);
  });

  it("syncTaskWorktreesToRepoPaths 解绑：快照失败 → 抛 WorktreeUnbindError、保留目录；修好后再解绑成功并留 ref", async () => {
    const repoX = await initRepo("wip-sync-x");
    const repoY = await initRepo("wip-sync-y");
    const t = makeTask({
      id: "t_1700000000106_wipsync",
      repoPaths: [repoX, repoY],
      repoBaseBranches: { [repoX]: "main", [repoY]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/555106",
    });
    await markTaskAlive(t.id);
    await ensureTaskWorktrees(t, () => true);
    const dirNames = getUniqueRepoDirNames(t.repoPaths);
    const wdX = path.join(getTaskWorktreesDir(t.id), dirNames[0]);
    await fs.writeFile(path.join(wdX, "unbind-dirty.txt"), "keep-me\n");

    const ref = blockWipRef(repoX, t.id, dirNames[0]);
    const failure = syncTaskWorktreesToRepoPaths(t, [repoX, repoY], [repoY]);
    await expect(failure).rejects.toBeInstanceOf(WorktreeUnbindError);
    await expect(failure).rejects.toThrow(/未提交的改动/);
    await expect(fs.readFile(path.join(wdX, "unbind-dirty.txt"), "utf8")).resolves.toBe(
      "keep-me\n",
    );

    git(repoX, "update-ref", "-d", `${ref}/blocker`);
    const ok = await syncTaskWorktreesToRepoPaths(t, [repoX, repoY], [repoY]);
    expect(ok.unboundRepos).toEqual([repoX]);
    expect(ok.snapshotRepos).toEqual([repoX]);
    await expect(fs.access(wdX)).rejects.toThrow();
    expect(git(repoX, "show", `${ref}:unbind-dirty.txt`)).toBe("keep-me");

    await removeTaskWorktrees(makeTask({ ...t, repoPaths: [repoY] }));
  });
});
