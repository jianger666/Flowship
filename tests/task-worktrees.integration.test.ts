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
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

import {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  removeTaskWorktrees,
} from "@/lib/server/task-worktrees";

const REPO = path.join(TMP_ROOT, "origin-repo");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeTask = (patch: Partial<Task> = {}): Task =>
  ({
    id: "t_1700000000001_it",
    mode: "task",
    title: "集成测试",
    role: "fe",
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
  const workDir = getTaskWorkRepoPaths(task)[0];

  it("首次 ensure：建 worktree + 基于 base 检出新任务分支 + 拷 .env* + 克隆依赖目录", async () => {
    const res = await ensureTaskWorktrees(task);
    expect(res.createdRepos).toEqual([REPO]);
    expect(res.infos[0].name).toBe("feature/888888-集成测试");
    expect(res.infos[0].baseBranch).toBe("main");
    expect(res.infos[0].checkedOut).toBe(true);

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
    const res = await ensureTaskWorktrees(task);
    expect(res.createdRepos).toEqual([]);
  });

  it("同分支被占用时另一个 task 明确报错（git 同分支单检出约束）", async () => {
    // 同 feishuStoryUrl + 同 title → 渲染出同名分支、必撞「already checked out」
    const other = makeTask({ id: "t_1700000000002_it" });
    await expect(ensureTaskWorktrees(other)).rejects.toThrow(
      /创建隔离工作区失败/,
    );
  });

  it("remove：脏工作区先自动 commit WIP 快照、目录删掉、任务分支保留在原仓库", async () => {
    // 模拟 build 完没 ship：worktree 里有未提交改动（改 tracked + 新增 untracked）
    await fs.writeFile(path.join(workDir, "a.txt"), "changed by build\n");
    await fs.writeFile(path.join(workDir, "new-file.ts"), "export const x = 1;\n");

    const removed = await removeTaskWorktrees(task);
    expect(removed.removedAny).toBe(true);
    expect(removed.snapshotRepos).toEqual([REPO]);
    expect(removed.skippedRepos).toEqual([]);
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
    const res = await ensureTaskWorktrees(task);
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
    expect(removed.skippedRepos).toEqual([]);
  });

  it("复用热路径：worktree 里手动 checkout 切走 → ensure 自动切回任务分支", async () => {
    await ensureTaskWorktrees(task);
    const taskBranch = "feature/888888-集成测试";
    // main 在原仓检出、不能在 worktree 再切；另建旁路分支模拟用户 / agent 手动切走
    git(REPO, "branch", "side-detour", "main");
    git(workDir, "checkout", "side-detour");
    expect(git(workDir, "branch", "--show-current")).toBe("side-detour");

    const res = await ensureTaskWorktrees(task);
    expect(res.createdRepos).toEqual([]);
    expect(git(workDir, "branch", "--show-current")).toBe(taskBranch);
  });

  it("CR-03 fail-closed：原仓被移走（git status 查不了）→ 绝不删、脏改动保留", async () => {
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
    await ensureTaskWorktrees(task2);
    const workDir2 = getTaskWorkRepoPaths(task2)[0];
    // 工作区留未提交改动
    await fs.writeFile(path.join(workDir2, "uncommitted.txt"), "precious\n");

    // 原仓整个移走 → worktree 的 .git 指针失效、git status 必失败。
    // 旧实现把「status 查不了」当 clean、git worktree remove 也失败后回退
    // fs.rm --force 递归删——未提交改动被永久销毁（本用例在旧实现上必挂）
    await fs.rename(repo2, repo2Moved);
    try {
      const removed = await removeTaskWorktrees(task2);
      expect(removed.skippedRepos).toEqual([repo2]);
      expect(removed.removedAny).toBe(false);
      // 目录 + 未提交文件都还在
      await expect(
        fs.readFile(path.join(workDir2, "uncommitted.txt"), "utf8"),
      ).resolves.toBe("precious\n");
    } finally {
      // 还原（afterAll 统一清 TMP_ROOT、这里只为不影响潜在后续用例）
      await fs.rename(repo2Moved, repo2).catch(() => {});
    }
  });

  it("remove：merge 冲突态 WIP 快照失败 → 跳过删除、目录与未提交改动保留", async () => {
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
    expect(removed.skippedRepos).toEqual([REPO]);
    expect(removed.snapshotRepos).toEqual([]);
    expect(removed.removedAny).toBe(false);
    // 目录保留、冲突内容还在（没被 --force 抹掉）
    await expect(fs.access(workDir)).resolves.toBeUndefined();
    await expect(fs.readFile(conflictFile, "utf8")).resolves.toBe(before);
    expect(git(REPO, "worktree", "list")).toContain(workDir);
  });
});
