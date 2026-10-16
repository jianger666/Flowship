/**
 * worktree 依赖准备集成测试（真临时 git 仓）：
 * monorepo 子包克隆 / 克隆原子性 / 抢先安装不被覆盖 / 并发串行 / pnpm .bin shim 改写 /
 * 依赖初始化命令兜底（幂等 + 失败重试封顶）/ 依赖准备状态提示（克隆中 + 锁文件漂移）/ 中转目录清理。
 *
 * 克隆相关断言仅 darwin（APFS clonefile）；初始化命令兜底在任何平台都跑（用无依赖目录的仓触发）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Task } from "@/lib/types";

// dataRoot 走环境变量、指到临时目录（import 被测模块前钉死）
const TMP_ROOT = path.join(os.tmpdir(), `fe-worktree-deps-it-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import { clearFailpoints, setFailpoint } from "@/lib/server/failpoints";
import {
  __readWorktreeGitDirForTest,
  buildDepPrepareHint,
  cleanupOrphanTaskWorktrees,
  cloneMissingTaskDepDirs,
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  getWorktreesRoot,
  removeTaskWorktrees,
} from "@/lib/server/task-worktrees";

const DATA_DIR = process.env.FLOWSHIP_DATA_DIR!;
const MONO = path.join(TMP_ROOT, "mono-repo");
const PLAIN = path.join(TMP_ROOT, "plain-repo");
/** 把 vendor/ 提交进了仓库（Go vendor 模式等）：检出自带的 vendor/ 不是 install 产物（F5-03） */
const VENDORED = path.join(TMP_ROOT, "vendored-repo");
const IS_MAC = process.platform === "darwin";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};
const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );

let seq = 0;
const liveIds: string[] = [];
/** 每个用例一个新任务（独立 id / 标题 / story → 独立分支，互不撞「already checked out」） */
const newTask = async (repo: string): Promise<Task> => {
  seq += 1;
  const id = `t_1700000009${String(seq).padStart(3, "0")}_dep`;
  liveIds.push(id);
  // 自愈逻辑靠 tasks/<id> 判定任务是否存活
  await fs.mkdir(path.join(DATA_DIR, "tasks", id), { recursive: true });
  return {
    id,
    mode: "task",
    title: `依赖准备${seq}`,
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [repo],
    isolateWorktree: true,
    repoBaseBranches: { [repo]: "main" },
    feishuStoryUrl: `https://project.feishu.cn/x/story/detail/77${String(seq).padStart(4, "0")}`,
    actions: [],
    mrs: [],
  } as unknown as Task;
};

const writeSetupCommand = async (
  repo: string,
  setupCommand: string | null,
): Promise<void> => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({
      repos: setupCommand ? [{ name: "r", path: repo, setupCommand }] : [],
    }),
  );
};

/** 追加一行到 worktree 里的 setup-count.txt（跨平台、不含换行字面量） */
const countCmd = (exit = 0): string =>
  `"${process.execPath}" -e "require('fs').appendFileSync('setup-count.txt', String(process.env.ROOT_WORKTREE_PATH) + String.fromCharCode(10)); process.exit(${exit})"`;

/**
 * 先建出（半截）node_modules 再按 exit 退出——模拟 install 装到一半失败 / 超时被杀留下的残局。
 * `countCmd(3)` 那种不建目录的命令覆盖不到「半截目录挡住重试」这条路径（F5-02）。
 */
const halfDepsCmd = (exit = 3): string =>
  `"${process.execPath}" -e "const fs=require('fs'); fs.mkdirSync('node_modules/half',{recursive:true}); fs.writeFileSync('node_modules/half/x','1'); fs.appendFileSync('setup-count.txt','x'+String.fromCharCode(10)); process.exit(${exit})"`;

/** setup 命令在该 worktree 里实际跑过几次（按 setup-count.txt 行数） */
const setupRuns = async (workDir: string): Promise<number> => {
  try {
    return (await fs.readFile(path.join(workDir, "setup-count.txt"), "utf8"))
      .trim()
      .split("\n").length;
  } catch {
    return 0;
  }
};

const DEP_SETUP_MARKER = "flowship-dep-setup.json";

beforeAll(async () => {
  // ---- monorepo：根 node_modules（含 pnpm 风格 shim + .cache）+ 子包 node_modules ----
  await fs.mkdir(MONO, { recursive: true });
  git(MONO, "init", "-b", "main");
  git(MONO, "config", "user.email", "t@t.local");
  git(MONO, "config", "user.name", "t");
  await write(
    path.join(MONO, "package.json"),
    JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }),
  );
  await write(path.join(MONO, ".gitignore"), "node_modules/\n");
  await write(path.join(MONO, "yarn.lock"), "# lock v1\n");
  await write(path.join(MONO, "apps/web/package.json"), '{"name":"web"}');
  git(MONO, "add", "-A");
  git(MONO, "commit", "-m", "init");
  // 以下都是 untracked / ignored：worktree 检出不带
  await write(path.join(MONO, "node_modules/some-pkg/index.js"), "module.exports=1;\n");
  await write(path.join(MONO, "node_modules/.cache/babel/x.json"), "{}");
  await write(path.join(MONO, "node_modules/.yarn-integrity"), "integrity\n");
  await write(
    path.join(MONO, "node_modules/.bin/cmd"),
    `#!/bin/sh\nexport NODE_PATH="${MONO}/node_modules/.pnpm/a/node_modules"\nexec node "$0.js"\n`,
  );
  await fs.chmod(path.join(MONO, "node_modules/.bin/cmd"), 0o755);
  await write(path.join(MONO, "apps/web/node_modules/local-pkg/index.js"), "module.exports=2;\n");
  // 原仓有、但任务分支里不存在的子包（untracked）：不能在 worktree 里凭空建目录
  await write(path.join(MONO, "apps/ghost/package.json"), '{"name":"ghost"}');
  await write(path.join(MONO, "apps/ghost/node_modules/g/index.js"), "module.exports=3;\n");

  // ---- 无任何依赖目录的仓：触发初始化命令兜底 ----
  await fs.mkdir(PLAIN, { recursive: true });
  git(PLAIN, "init", "-b", "main");
  git(PLAIN, "config", "user.email", "t@t.local");
  git(PLAIN, "config", "user.name", "t");
  await write(path.join(PLAIN, "requirements.txt"), "requests\n");
  git(PLAIN, "add", "-A");
  git(PLAIN, "commit", "-m", "init");

  // ---- vendor/ 已提交的仓 ----
  await fs.mkdir(VENDORED, { recursive: true });
  git(VENDORED, "init", "-b", "main");
  git(VENDORED, "config", "user.email", "t@t.local");
  git(VENDORED, "config", "user.name", "t");
  await write(path.join(VENDORED, "go.mod"), "module x\n");
  await write(path.join(VENDORED, "vendor/dep/dep.go"), "package dep\n");
  git(VENDORED, "add", "-A");
  git(VENDORED, "commit", "-m", "init");
});

afterEach(async () => {
  clearFailpoints();
  await writeSetupCommand(PLAIN, null);
});

// 把 PLAIN 的 setup 命令写进配置后，下面这批 F5-0x 用例共用的 worktree 准备
const prepPlainWorktree = async (
  setupCommand: string,
): Promise<{ task: Task; workDir: string }> => {
  await writeSetupCommand(PLAIN, setupCommand);
  const task = await newTask(PLAIN);
  await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
  return { task, workDir: getTaskWorkRepoPaths(task)[0] };
};

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe.skipIf(!IS_MAC)("依赖克隆（APFS clonefile、仅 darwin）", () => {
  it("monorepo：根 + 子包 node_modules 一并克隆；任务分支里没有的子包不凭空建目录", async () => {
    const task = await newTask(MONO);
    const res = await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(res.clonedDeps).toEqual([
      { repoPath: MONO, dirs: ["node_modules", "apps/web/node_modules"] },
    ]);
    await expect(
      fs.readFile(path.join(workDir, "node_modules/some-pkg/index.js"), "utf8"),
    ).resolves.toBe("module.exports=1;\n");
    await expect(
      fs.readFile(path.join(workDir, "apps/web/node_modules/local-pkg/index.js"), "utf8"),
    ).resolves.toBe("module.exports=2;\n");
    // apps/ghost 在任务分支里不存在：不能为了放 node_modules 去建它
    expect(await exists(path.join(workDir, "apps/ghost"))).toBe(false);
    // 构建缓存删掉、原仓不受影响
    expect(await exists(path.join(workDir, "node_modules/.cache"))).toBe(false);
    expect(await exists(path.join(MONO, "node_modules/.cache/babel/x.json"))).toBe(true);
    // 中转目录不留垃圾
    expect(await exists(path.join(getWorktreesRoot(), ".dep-clone-tmp", task.id))).toBe(false);
  });

  it("pnpm 风格 .bin shim 里写死的原仓路径被改写成 worktree 路径（原仓 shim 不动）", async () => {
    const task = await newTask(MONO);
    await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    const shim = await fs.readFile(path.join(workDir, "node_modules/.bin/cmd"), "utf8");
    expect(shim).toContain(`NODE_PATH="${workDir}/node_modules/.pnpm/a/node_modules"`);
    expect(shim).not.toContain(MONO);
    // 可执行位保留
    expect((await fs.stat(path.join(workDir, "node_modules/.bin/cmd"))).mode & 0o111).not.toBe(0);
    // 原仓库的 shim 原样（克隆是独立副本）
    expect(await fs.readFile(path.join(MONO, "node_modules/.bin/cmd"), "utf8")).toContain(
      `NODE_PATH="${MONO}/node_modules/.pnpm/a/node_modules"`,
    );
  });

  it("原子性：cp 完成但 rename 之前，worktree 里看不到目标目录（只有中转目录）", async () => {
    const task = await newTask(MONO);
    await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(await exists(path.join(workDir, "node_modules"))).toBe(false);

    // 单元按序处理：先 node_modules、再 apps/web/node_modules。
    // 每个单元 rename 前：它自己的目标必须不可见；中转目录里已有完整副本
    const units = ["node_modules", "apps/web/node_modules"];
    const seen: {
      unit: string;
      dstVisible: boolean;
      tmpHasCompleteCopy: boolean;
    }[] = [];
    setFailpoint("ensure.afterDepCloneBeforeRename", async () => {
      const unit = units[seen.length];
      const tmpRoot = path.join(getWorktreesRoot(), ".dep-clone-tmp", task.id);
      const entries = await fs.readdir(tmpRoot).catch(() => [] as string[]);
      const probe = unit === "node_modules" ? "some-pkg/index.js" : "local-pkg/index.js";
      seen.push({
        unit,
        dstVisible: await exists(path.join(workDir, unit)),
        tmpHasCompleteCopy:
          entries.length === 1 &&
          (await exists(path.join(tmpRoot, entries[0], probe))),
      });
    });
    const cloned = await cloneMissingTaskDepDirs(task, () => true);
    expect(cloned).toEqual([{ repoPath: MONO, dirs: units }]);
    expect(seen).toEqual([
      { unit: "node_modules", dstVisible: false, tmpHasCompleteCopy: true },
      { unit: "apps/web/node_modules", dstVisible: false, tmpHasCompleteCopy: true },
    ]);
    expect(await exists(path.join(workDir, "node_modules/some-pkg/index.js"))).toBe(true);
  });

  it("克隆期间 agent 抢先装好了目标：不覆盖、不合并，丢弃中转副本", async () => {
    const task = await newTask(MONO);
    await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
    const workDir = getTaskWorkRepoPaths(task)[0];
    let first = true;
    setFailpoint("ensure.afterDepCloneBeforeRename", async () => {
      if (!first) return;
      first = false;
      await write(path.join(workDir, "node_modules/agent-installed.txt"), "mine\n");
    });
    const cloned = await cloneMissingTaskDepDirs(task, () => true);
    // 根 node_modules 被 agent 抢先、不算克隆；子包照常克隆
    expect(cloned).toEqual([{ repoPath: MONO, dirs: ["apps/web/node_modules"] }]);
    expect(await fs.readFile(path.join(workDir, "node_modules/agent-installed.txt"), "utf8")).toBe(
      "mine\n",
    );
    expect(await exists(path.join(workDir, "node_modules/some-pkg"))).toBe(false);
    expect(await exists(path.join(getWorktreesRoot(), ".dep-clone-tmp", task.id))).toBe(false);
  });

  it("同一 worktree 并发补依赖：串行、只克隆一次", async () => {
    const task = await newTask(MONO);
    await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
    const [a, b] = await Promise.all([
      cloneMissingTaskDepDirs(task, () => true),
      cloneMissingTaskDepDirs(task, () => true),
    ]);
    const all = [...a, ...b];
    expect(all).toHaveLength(1);
    expect(all[0].dirs).toEqual(["node_modules", "apps/web/node_modules"]);
  });

  it("配了初始化命令但克隆成功：不执行命令", async () => {
    await writeSetupCommand(MONO, countCmd());
    const task = await newTask(MONO);
    const res = await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(res.clonedDeps[0].setup).toBeUndefined();
    expect(await exists(path.join(workDir, "setup-count.txt"))).toBe(false);
    await writeSetupCommand(MONO, null);
  });

  it("removeTaskWorktrees 顺带清掉该任务的克隆中转目录残留", async () => {
    const task = await newTask(MONO);
    await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
    const leftover = path.join(getWorktreesRoot(), ".dep-clone-tmp", task.id, "apps__web__node_modules-1");
    await write(path.join(leftover, "half.txt"), "x");
    await removeTaskWorktrees(task);
    expect(await exists(path.join(getWorktreesRoot(), ".dep-clone-tmp", task.id))).toBe(false);
  });

  it("开机孤儿扫描清掉崩溃遗留的整个中转目录（活任务的 worktree 不动）", async () => {
    const task = await newTask(MONO);
    await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
    const workDir = getTaskWorkRepoPaths(task)[0];
    const stale = path.join(getWorktreesRoot(), ".dep-clone-tmp", "t_crashed", "x__node_modules-1");
    await write(path.join(stale, "half.txt"), "x");
    await cleanupOrphanTaskWorktrees(new Set(liveIds));
    expect(await exists(path.join(getWorktreesRoot(), ".dep-clone-tmp"))).toBe(false);
    expect(await exists(path.join(workDir, ".git"))).toBe(true);
  });
});

describe("依赖初始化命令兜底（任何平台；用无依赖目录的仓触发）", () => {
  it("没克隆出依赖 → 执行一次；命令成功后再 ensure 不重跑；ROOT_WORKTREE_PATH 指向原仓", async () => {
    await writeSetupCommand(PLAIN, countCmd());
    const task = await newTask(PLAIN);
    const res = await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(res.clonedDeps).toEqual([
      { repoPath: PLAIN, dirs: [], setup: { command: countCmd(), ok: true } },
    ]);
    const lines = (await fs.readFile(path.join(workDir, "setup-count.txt"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toEqual([PLAIN]);

    // 复用路径再 ensure、后台补齐：都不重跑
    await ensureTaskWorktrees(task, () => true);
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(
      (await fs.readFile(path.join(workDir, "setup-count.txt"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  });

  it("没配命令 → 不执行；skipDepClone（答疑 oneshot）→ 不执行", async () => {
    const t1 = await newTask(PLAIN);
    const r1 = await ensureTaskWorktrees(t1, () => true);
    expect(r1.clonedDeps).toEqual([]);

    await writeSetupCommand(PLAIN, countCmd());
    const t2 = await newTask(PLAIN);
    const r2 = await ensureTaskWorktrees(t2, () => true, { skipDepClone: true });
    expect(r2.clonedDeps).toEqual([]);
    expect(await exists(path.join(getTaskWorkRepoPaths(t2)[0], "setup-count.txt"))).toBe(false);
  });

  it("命令失败：带退出码返回；最多再试一次（共 2 次）、之后不再跑", async () => {
    await writeSetupCommand(PLAIN, countCmd(3));
    const task = await newTask(PLAIN);
    const first = await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(first.clonedDeps[0].setup?.ok).toBe(false);
    expect(first.clonedDeps[0].setup?.detail).toContain("退出码 3");

    const second = await cloneMissingTaskDepDirs(task, () => true);
    expect(second[0].setup?.ok).toBe(false);

    const third = await cloneMissingTaskDepDirs(task, () => true);
    expect(third).toEqual([]);
    expect(
      (await fs.readFile(path.join(workDir, "setup-count.txt"), "utf8")).trim().split("\n"),
    ).toHaveLength(2);
  });

  it("命令被改过：旧标记作废、按新命令重跑", async () => {
    await writeSetupCommand(PLAIN, countCmd());
    const task = await newTask(PLAIN);
    await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];

    const changed = `${countCmd()} `.trim() + " && echo changed";
    await writeSetupCommand(PLAIN, changed);
    const again = await cloneMissingTaskDepDirs(task, () => true);
    expect(again[0].setup).toEqual({ command: changed, ok: true });
    expect(
      (await fs.readFile(path.join(workDir, "setup-count.txt"), "utf8")).trim().split("\n"),
    ).toHaveLength(2);
  });

  it("revoke 中止：命令被杀、抛让位错误、不占重试次数（下次仍会跑）", async () => {
    const { revokeResourceJobs } = await import("@/lib/server/resource-jobs");
    const { WorktreeLeaseLostError } = await import("@/lib/server/task-worktrees");
    // 先建好 worktree 但不跑命令
    const task = await newTask(PLAIN);
    await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
    await writeSetupCommand(
      PLAIN,
      `"${process.execPath}" -e "setInterval(()=>{},1000)"`,
    );
    setFailpoint("ensure.beforeDepSetup", async () => {
      // 命令真正起来之后再 revoke
      setTimeout(() => revokeResourceJobs(task.id), 300);
    });
    await expect(cloneMissingTaskDepDirs(task, () => true)).rejects.toBeInstanceOf(
      WorktreeLeaseLostError,
    );
    // 标记没写 → 换成正常命令后仍会跑
    clearFailpoints();
    await writeSetupCommand(PLAIN, countCmd());
    const retry = await cloneMissingTaskDepDirs(task, () => true);
    expect(retry[0].setup?.ok).toBe(true);
  });

  // ---------- F5-02：失败 / 中止 / 崩溃留下半截依赖目录，不能让重试永远被挡住 ----------

  it("F5-02：setup 失败并留下半截 node_modules → 下次仍重试（共 2 次）、之后不再跑", async () => {
    await writeSetupCommand(PLAIN, halfDepsCmd(3));
    const task = await newTask(PLAIN);
    const first = await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(first.clonedDeps[0].setup?.ok).toBe(false);
    // 前提：命令确实留下了半截依赖目录（不是 process.exit(3) 那种不建目录的假覆盖）
    expect(await exists(path.join(workDir, "node_modules/half/x"))).toBe(true);

    const second = await cloneMissingTaskDepDirs(task, () => true);
    expect(second).toHaveLength(1);
    expect(second[0].setup?.ok).toBe(false);
    expect(await setupRuns(workDir)).toBe(2);

    // 试满 2 次：半截目录还在、也不再跑
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(await setupRuns(workDir)).toBe(2);
  });

  it("F5-02 主路径不破坏：setup 成功并建出 node_modules → 之后 ensure / 后台补齐都不重跑", async () => {
    await writeSetupCommand(PLAIN, halfDepsCmd(0));
    const task = await newTask(PLAIN);
    const first = await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(first.clonedDeps[0].setup?.ok).toBe(true);
    expect(await exists(path.join(workDir, "node_modules/half/x"))).toBe(true);

    await ensureTaskWorktrees(task, () => true);
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(await setupRuns(workDir)).toBe(1);
  });

  it("F5-02 主路径不破坏：没有标记、用户 / agent 已有依赖目录 → 不跑初始化命令", async () => {
    const { task, workDir } = await prepPlainWorktree(countCmd());
    await write(path.join(workDir, "node_modules/user-installed/index.js"), "x\n");
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(await setupRuns(workDir)).toBe(0);
  });

  it("F5-02 不过度重试：setup 干净失败（没留下目录）后 agent 自己装好了依赖 → 不再重跑", async () => {
    await writeSetupCommand(PLAIN, countCmd(3));
    const task = await newTask(PLAIN);
    const first = await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(first.clonedDeps[0].setup?.ok).toBe(false);
    expect(await exists(path.join(workDir, "node_modules"))).toBe(false);

    // 回退 agent 自装：此刻的依赖目录是 agent 的、不是失败的 setup 留下的
    await write(path.join(workDir, "node_modules/agent-installed/index.js"), "x\n");
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(await setupRuns(workDir)).toBe(1);
  });

  it("F5-02：revoke 中止留下半截 node_modules → 同一条命令下次仍会重跑，且这次中止不占重试次数", async () => {
    const { revokeResourceJobs } = await import("@/lib/server/resource-jobs");
    const { WorktreeLeaseLostError } = await import("@/lib/server/task-worktrees");
    // 第一次：建出半截目录后挂住等 revoke；第二次（计数文件已存在）：直接成功退出
    const cmd = `"${process.execPath}" -e "const fs=require('fs'); const first=!fs.existsSync('setup-count.txt'); fs.mkdirSync('node_modules/half',{recursive:true}); fs.appendFileSync('setup-count.txt','x'+String.fromCharCode(10)); if(first) setInterval(()=>{},1000)"`;
    const { task, workDir } = await prepPlainWorktree(cmd);
    setFailpoint("ensure.beforeDepSetup", async () => {
      // 等命令真把半截目录建出来再 revoke（不靠固定延时、高负载下也稳）
      void (async () => {
        const deadline = Date.now() + 10_000;
        while (
          !(await exists(path.join(workDir, "node_modules/half"))) &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 20));
        }
        revokeResourceJobs(task.id);
      })();
    });
    await expect(cloneMissingTaskDepDirs(task, () => true)).rejects.toBeInstanceOf(
      WorktreeLeaseLostError,
    );
    clearFailpoints();
    expect(await exists(path.join(workDir, "node_modules/half"))).toBe(true);

    const retry = await cloneMissingTaskDepDirs(task, () => true);
    expect(retry).toHaveLength(1);
    expect(retry[0].setup?.ok).toBe(true);
    expect(await setupRuns(workDir)).toBe(2);

    // 中止那次没有计入 attempts：重试成功时落的是第 1 次
    const gitDir = (await __readWorktreeGitDirForTest(workDir))!;
    const marker = JSON.parse(
      await fs.readFile(path.join(gitDir, DEP_SETUP_MARKER), "utf8"),
    );
    expect(marker.ok).toBe(true);
    expect(marker.attempts).toBe(1);
  });

  it("F5-02：setup 开跑后没落结束标记（进程被杀 / 崩溃）+ 留下半截目录 → 重试；已试满次数则不再", async () => {
    const { task, workDir } = await prepPlainWorktree(countCmd());
    await write(path.join(workDir, "node_modules/half/x"), "1");
    const gitDir = (await __readWorktreeGitDirForTest(workDir))!;
    const markerFile = path.join(gitDir, DEP_SETUP_MARKER);

    // 崩在第 2 次：次数已用完、不再重试
    await fs.writeFile(
      markerFile,
      JSON.stringify({ command: countCmd(), ok: false, attempts: 2, started: true }),
    );
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(await setupRuns(workDir)).toBe(0);

    // 崩在第 1 次：还有一次机会
    await fs.writeFile(
      markerFile,
      JSON.stringify({ command: countCmd(), ok: false, attempts: 1, started: true }),
    );
    const again = await cloneMissingTaskDepDirs(task, () => true);
    expect(again).toHaveLength(1);
    expect(again[0].setup?.ok).toBe(true);
    expect(await setupRuns(workDir)).toBe(1);
  });

  it("F5-02 保守取舍：旧版本落的标记（没有 started / leftDeps）+ 已有依赖目录 → 不重试", async () => {
    const { task, workDir } = await prepPlainWorktree(countCmd());
    await write(path.join(workDir, "node_modules/some/x"), "1");
    const gitDir = (await __readWorktreeGitDirForTest(workDir))!;
    await fs.writeFile(
      path.join(gitDir, DEP_SETUP_MARKER),
      JSON.stringify({ command: countCmd(), ok: false, attempts: 1, at: 1 }),
    );
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(await setupRuns(workDir)).toBe(0);
  });

  it("F5-02 保守取舍：失败后用户改了命令、worktree 里已有（半截）依赖目录 → 不自动按新命令重跑", async () => {
    await writeSetupCommand(PLAIN, halfDepsCmd(3));
    const task = await newTask(PLAIN);
    await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(await setupRuns(workDir)).toBe(1);

    await writeSetupCommand(PLAIN, countCmd());
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(await setupRuns(workDir)).toBe(1);
  });

  it("F5-02：最后一次重试正在跑的时候，依赖准备提示仍说「正在后台执行」（开跑前已预占 attempts、不能因此哑掉）", async () => {
    // 命令：落计数 → 等 release.txt 出现（最多 20s）→ 失败退出
    const cmd = `"${process.execPath}" -e "const fs=require('fs'); fs.appendFileSync('setup-count.txt','x'+String.fromCharCode(10)); const t=Date.now(); const w=()=>{ if(fs.existsSync('release.txt')||Date.now()-t>20000) process.exit(3); else setTimeout(w,30); }; w()"`;
    const { task, workDir } = await prepPlainWorktree(cmd);
    const gitDir = (await __readWorktreeGitDirForTest(workDir))!;
    // 上一次已失败过一次：此刻跑的是第 2（最后）次
    await fs.writeFile(
      path.join(gitDir, DEP_SETUP_MARKER),
      JSON.stringify({ command: cmd, ok: false, attempts: 1, at: 1 }),
    );
    const bg = cloneMissingTaskDepDirs(task, () => true);
    const started = Date.now();
    while (!(await exists(path.join(workDir, "setup-count.txt"))) && Date.now() - started < 10_000) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(await exists(path.join(workDir, "setup-count.txt"))).toBe(true);
    const during = await buildDepPrepareHint(task);
    await fs.writeFile(path.join(workDir, "release.txt"), "go");
    const res = await bg;
    expect(res[0].setup?.ok).toBe(false);
    expect(during).toContain("初始化命令");
    // 跑完、次数用尽之后不再提示
    expect(await buildDepPrepareHint(task)).toBeUndefined();
  });

  it("F5-02：半截目录重试期间，依赖准备提示照样说「正在后台执行」（避免 agent 同时 install）", async () => {
    const { task, workDir } = await prepPlainWorktree(halfDepsCmd(3));
    // 第一次失败、留下半截目录
    await cloneMissingTaskDepDirs(task, () => true);
    expect(await exists(path.join(workDir, "node_modules/half/x"))).toBe(true);
    // 还有一次重试机会 → 提示里要告知
    const hint = await buildDepPrepareHint(task);
    expect(hint).toContain("初始化命令");

    // 试满之后不再提示
    await cloneMissingTaskDepDirs(task, () => true);
    expect(await buildDepPrepareHint(task)).toBeUndefined();
  });

  // ---------- F5-03：已提交（tracked）的 vendor/ 不是 install 产物 ----------

  it("F5-03：vendor/ 是仓库已提交内容 → 不算「已有依赖」，配置的初始化命令照常执行", async () => {
    await writeSetupCommand(VENDORED, countCmd());
    const task = await newTask(VENDORED);
    const res = await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    // 前提：检出自带了 vendor/
    expect(await exists(path.join(workDir, "vendor/dep/dep.go"))).toBe(true);
    expect(res.clonedDeps).toEqual([
      { repoPath: VENDORED, dirs: [], setup: { command: countCmd(), ok: true } },
    ]);
    expect(await setupRuns(workDir)).toBe(1);
    // 成功落标记后不重跑
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(await setupRuns(workDir)).toBe(1);
    await writeSetupCommand(VENDORED, null);
  });

  it("F5-03：git 判断不了（找不到 git）→ 保持旧口径，vendor/ 在就算已有依赖、不跑", async () => {
    await writeSetupCommand(VENDORED, countCmd());
    const task = await newTask(VENDORED);
    await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
    const workDir = getTaskWorkRepoPaths(task)[0];
    const prevPath = process.env.PATH;
    process.env.PATH = path.join(TMP_ROOT, "no-such-bin");
    try {
      expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
    expect(await setupRuns(workDir)).toBe(0);
    await writeSetupCommand(VENDORED, null);
  });

  it("F5-03：未提交的 vendor/（install 产物 / 用户自建）仍算「已有依赖」→ 不跑", async () => {
    const { task, workDir } = await prepPlainWorktree(countCmd());
    await write(path.join(workDir, "vendor/composer-installed/x.php"), "<?php\n");
    expect(await cloneMissingTaskDepDirs(task, () => true)).toEqual([]);
    expect(await setupRuns(workDir)).toBe(0);
  });

  // ---------- F5-04：prewarm 不同步跑 setup 命令（最长 15 分钟、会占住 runAdvanceExclusive） ----------

  it("F5-04：skipDepSetup（prewarm）→ ensure 不跑初始化命令；留给后台补齐路径去跑", async () => {
    await writeSetupCommand(PLAIN, countCmd());
    const task = await newTask(PLAIN);
    const res = await ensureTaskWorktrees(task, () => true, { skipDepSetup: true });
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(res.clonedDeps).toEqual([]);
    expect(await setupRuns(workDir)).toBe(0);

    // 复用路径再 ensure（prewarm 之后推进的 ensure 走 defer）也不该偷跑
    await ensureTaskWorktrees(task, () => true, { skipDepSetup: true });
    expect(await setupRuns(workDir)).toBe(0);

    // 后台补齐（cloneMissingTaskDepDirs，不带 skipDepSetup）才真正执行
    const bg = await cloneMissingTaskDepDirs(task, () => true);
    expect(bg).toEqual([
      { repoPath: PLAIN, dirs: [], setup: { command: countCmd(), ok: true } },
    ]);
    expect(await setupRuns(workDir)).toBe(1);
  });
});

describe("buildDepPrepareHint（拼进 prompt 的依赖准备状态）", () => {
  it.skipIf(!IS_MAC)("克隆未完成：提示别自己 install；克隆完成且锁文件一致 → 无提示", async () => {
    const task = await newTask(MONO);
    await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
    const pending = await buildDepPrepareHint(task);
    expect(pending).toContain("依赖准备状态");
    expect(pending).toContain("后台克隆");
    expect(pending).toContain("不要此时自己 install");

    await cloneMissingTaskDepDirs(task, () => true);
    expect(await buildDepPrepareHint(task)).toBeUndefined();
  });

  it.skipIf(!IS_MAC)("锁文件漂移：提示先增量安装；worktree 里装过之后不再唠叨", async () => {
    const task = await newTask(MONO);
    await ensureTaskWorktrees(task, () => true);
    const workDir = getTaskWorkRepoPaths(task)[0];
    expect(await buildDepPrepareHint(task)).toBeUndefined();

    const lock = path.join(MONO, "yarn.lock");
    const original = await fs.readFile(lock, "utf8");
    try {
      await fs.writeFile(lock, "# lock v1 — 原仓库当前分支的改动\n");
      const drifted = await buildDepPrepareHint(task);
      expect(drifted).toContain("yarn.lock");
      expect(drifted).toContain("增量安装");

      // 模拟 agent 在 worktree 里跑过 install：安装器元数据 mtime 晚于 node_modules 落位时刻
      const integrity = path.join(workDir, "node_modules/.yarn-integrity");
      const later = new Date(Date.now() + 60_000);
      await fs.utimes(integrity, later, later);
      expect(await buildDepPrepareHint(task)).toBeUndefined();
    } finally {
      await fs.writeFile(lock, original);
    }
  });

  it("非 mac 且没配初始化命令：提示自行安装；配了则提示后台执行命令", async () => {
    const task = await newTask(MONO);
    await ensureTaskWorktrees(task, () => true, { skipDepClone: true });
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const noCmd = await buildDepPrepareHint(task);
      expect(noCmd).toContain("不支持依赖目录秒级克隆");

      await writeSetupCommand(MONO, "yarn install --frozen-lockfile");
      const withCmd = await buildDepPrepareHint(task);
      expect(withCmd).toContain("初始化命令");
      expect(withCmd).toContain("yarn install --frozen-lockfile");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
      await writeSetupCommand(MONO, null);
    }
  });

  it("非隔离任务 / 没有依赖可说 → undefined", async () => {
    const plain = await newTask(PLAIN);
    await ensureTaskWorktrees(plain, () => true);
    expect(await buildDepPrepareHint(plain)).toBeUndefined();
    expect(
      await buildDepPrepareHint({ ...plain, isolateWorktree: false } as Task),
    ).toBeUndefined();
  });
});
