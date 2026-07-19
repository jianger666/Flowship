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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Task } from "@/lib/types";

// dataRoot 走环境变量、指到临时目录（import 被测模块前钉死）
const TMP_ROOT = path.join(os.tmpdir(), `fe-worktree-it-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  removeTaskWorktrees,
} from "@/lib/server/task-worktrees";

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

  it("快照失败仍强制删除：原仓被移走（git status 查不了）→ 目录删掉、记 snapshotFailedRepos", async () => {
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
    // 用户主动删：仍强制删目录释放占用（未提交改动会丢——已拍板可接受）
    await fs.rename(repo2, repo2Moved);
    try {
      const removed = await removeTaskWorktrees(task2);
      expect(removed.snapshotFailedRepos).toEqual([repo2]);
      expect(removed.removedAny).toBe(true);
      await expect(fs.access(workDir2)).rejects.toThrow();
    } finally {
      // 还原（afterAll 统一清 TMP_ROOT、这里只为不影响潜在后续用例）
      await fs.rename(repo2Moved, repo2).catch(() => {});
    }
  });

  it("remove：merge 冲突态 WIP 快照失败 → 仍强制删除、记 snapshotFailedRepos", async () => {
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
    expect(removed.removedAny).toBe(true);
    // 目录已删、分支占用已释放（未提交冲突内容丢——用户主动删可接受）
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
});
