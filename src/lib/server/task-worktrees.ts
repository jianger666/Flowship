/**
 * 任务隔离工作区（git worktree）管理（V0.10）
 *
 * 动机：多 task 并行改同一个仓库时、共享同一个工作区会互相踩（A task 切走分支、
 * B task 的半成品全乱）。V0.10 起新建 task 默认给每个仓建一个专属 worktree：
 *
 *   <dataRoot>/worktrees/<taskId>/<仓短名>/
 *
 * - worktree 跟原仓库共享同一 git 对象库（占用小、commit/push 全通用）、
 *   但各自有独立的 HEAD / index / 工作区文件——并行任务物理隔离
 * - 分支检出由 runner 确定性完成（本模块 ensureTaskWorktrees）、不再靠 prompt
 *   引导 agent 自己 checkout（软约束 → 硬保证、符合 harness 哲学）
 * - 逃生口：task.isolateWorktree === false 时全部函数退化为原仓库路径直跑（V0.9 行为）
 *
 * 依赖方向：本模块只依赖 types / data-root / path-utils / branch-template、
 * 不 import task-fs / task-runner（task-fs 反过来 import 本模块、保证无环）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "./data-root";
import { getEffectiveCwd, getUniqueRepoDirNames } from "@/lib/path-utils";
import {
  DEFAULT_BRANCH_TEMPLATE,
  extractFeishuStoryId,
  renderBranchName,
} from "@/lib/branch-template";
import type { GitBranchInfo, Task, TaskMode } from "@/lib/types";

const execFileAsync = promisify(execFile);

// ----------------- 类型：Task / TaskMetaV06 都能喂的最小形状 -----------------

/**
 * worktree 判定 / 路径映射需要的最小 task 形状——Task 和 TaskMetaV06 都满足、
 * 让 task-fs（只有 meta）和 runner（有完整 Task）共用同一套函数。
 */
export interface WorktreeTaskLike {
  id: string;
  mode?: TaskMode;
  repoPaths: string[];
  isolateWorktree?: boolean;
}

// ----------------- 纯函数：判定 + 路径映射 -----------------

/** 本 task 是否走隔离工作区（chat 模式 / 逃生口 / 无仓库一律不隔离） */
export const isWorktreeTask = (t: WorktreeTaskLike): boolean =>
  t.mode !== "chat" && t.isolateWorktree === true && t.repoPaths.length > 0;

/** 所有 task worktree 的根目录 */
export const getWorktreesRoot = (): string => path.join(dataRoot(), "worktrees");

/** 单个 task 的 worktree 容器目录（多仓时也是 effective cwd 的公共父目录） */
export const getTaskWorktreesDir = (taskId: string): string =>
  path.join(getWorktreesRoot(), taskId);

// 路径归一：反斜杠转正斜杠 + 去尾斜杠（对齐 path-utils 的比较口径）
const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * task 的「工作路径」列表——agent 实际干活的目录：
 * - 隔离 task → 逐仓映射到 worktree 子目录（子目录名 = getUniqueRepoDirNames、
 *   跟 client 端 task 详情页的路径前缀校验同源；顺序跟 repoPaths 一一对应）
 * - 非隔离 → 原样返回 repoPaths
 */
export const getTaskWorkRepoPaths = (t: WorktreeTaskLike): string[] => {
  if (!isWorktreeTask(t)) return t.repoPaths;
  const dir = getTaskWorktreesDir(t.id);
  return getUniqueRepoDirNames(t.repoPaths).map((name) => path.join(dir, name));
};

/** task 的 effective cwd（Agent.create / stop hook / 检查统一走这里、替代裸 getEffectiveCwd） */
export const getTaskCwd = (t: WorktreeTaskLike): string =>
  getEffectiveCwd(getTaskWorkRepoPaths(t));

/**
 * 把 agent 上报的路径归一回「原仓库路径」（submit_mr 校验 / MR 落库用）。
 * agent 在 worktree 里 `pwd` 拿到的是 worktree 路径、而 task.repoPaths / gitBranches /
 * repoTestBranches 等权威数据全按原仓库路径记——不归一 validateSubmitMr 必拦。
 * 匹配不上（agent 报了原路径 / 幻觉路径）原样返回、由下游校验兜底。
 */
export const resolveOriginalRepoPath = (
  t: WorktreeTaskLike,
  reported: string,
): string => {
  const target = normPath(reported);
  const workPaths = getTaskWorkRepoPaths(t);
  for (let i = 0; i < workPaths.length; i++) {
    if (normPath(workPaths[i]) === target) return t.repoPaths[i];
  }
  return reported;
};

// ----------------- 分支规划（worktree 检出用、跟 planBranchesForBuild 同规则） -----------------

/**
 * 逐仓算本 task 的工作分支（已有 gitBranches 记录 > 用户指定已有分支 > 模板渲染）。
 * 跟 action-gates.planBranchesForBuild 同一套命名规则；区别是这里必须**总能**给出
 * 分支名（worktree 创建不能没分支）——storyId 抠不到时兜底用 task id 的时间戳段。
 */
export const planWorktreeBranchInfos = (
  task: Task,
  username: string | undefined,
): GitBranchInfo[] => {
  const storyId =
    extractFeishuStoryId(task.feishuStoryUrl) ??
    // task id 形如 t_<ts>_<rand>、取时间戳段兜底（branch-safe 纯数字、跨 task 唯一性够用）
    task.id.split("_")[1] ??
    task.id;
  const existing = task.gitBranches ?? [];
  const now = Date.now();
  return task.repoPaths.map((repoPath) => {
    const old = existing.find((b) => b.repoPath === repoPath);
    if (old) return old;
    const explicitName = task.repoFeatureBranches?.[repoPath]?.trim();
    return {
      repoPath,
      name:
        explicitName ||
        renderBranchName(
          task.repoBranchTemplates?.[repoPath] || DEFAULT_BRANCH_TEMPLATE,
          { username, storyId, taskTitle: task.title },
        ),
      baseBranch: "",
      checkedOut: false,
      createdAt: now,
    };
  });
};

// ----------------- git 执行底座 -----------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const runGit = async (
  repoPath: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<GitResult> => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
    };
  }
};

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

// ----------------- worktree 创建（确定性、幂等） -----------------

export interface EnsureWorktreesResult {
  /** 逐仓分支信息（含已存在的历史记录、runner 拿去 upsert gitBranches） */
  infos: GitBranchInfo[];
  /** 本次真正新建了 worktree 的原仓库路径（写事件流告知用户用） */
  createdRepos: string[];
  /** 本次从原仓库秒级克隆了 node_modules 的原仓库路径（写事件流告知用户用） */
  clonedNodeModulesRepos: string[];
}

/**
 * 确保本 task 每个仓的 worktree 都存在且检出了任务分支（幂等、可反复调）。
 *
 * 单仓流程：
 *   1. worktree 目录已是合法 git 工作区 → 复用、跳过（分支被人为切走由 build 自检兜底）
 *   2. `git worktree prune` 清掉「目录被手删但 git 还记着」的僵尸注册
 *   3. 定分支起点：本地已有分支 → 直接挂；远程有同名分支（用户自己建过）→ fetch 后基于它建本地；
 *      都没有 → 基于线上分支（设置页快照、缺省探 origin/HEAD）新建、`--no-track` 防误推线上
 *   4. 拷根目录 `.env*`（gitignore 的本地配置不在检出里、不拷 dev server 起不来）
 *
 * 失败抛错（带仓名 + git stderr + 处置建议）——worktree 是硬前置、创建不了不该带病起 agent。
 */
export const ensureTaskWorktrees = async (
  task: Task,
  username: string | undefined,
): Promise<EnsureWorktreesResult> => {
  const infos = planWorktreeBranchInfos(task, username);
  const workPaths = getTaskWorkRepoPaths(task);
  const createdRepos: string[] = [];
  const clonedNodeModulesRepos: string[] = [];

  await fs.mkdir(getTaskWorktreesDir(task.id), { recursive: true });

  for (let i = 0; i < task.repoPaths.length; i++) {
    const repoPath = task.repoPaths[i];
    const workDir = workPaths[i];
    const info = infos[i];

    // 已存在且是合法工作区 → 复用（幂等热路径、每次推进都会走到）。
    // 顺手补克隆 node_modules（老 worktree 建于克隆功能上线前 / 上次克隆失败）——
    // 缺依赖会连锁炸 pre-commit hook / lint / typecheck（实测：dev 联调 agent 被迫 --no-verify）
    if (await pathExists(path.join(workDir, ".git"))) {
      const check = await runGit(workDir, ["rev-parse", "--is-inside-work-tree"]);
      if (check.ok) {
        if (await cloneNodeModules(repoPath, workDir)) {
          clonedNodeModulesRepos.push(repoPath);
        }
        continue;
      }
    }

    // 原仓库必须是 git 仓
    if (!(await pathExists(path.join(repoPath, ".git")))) {
      throw new Error(`仓库 ${repoPath} 不是 git 仓库、无法创建隔离工作区`);
    }

    // 半截目录（上次创建失败残留 / 非法内容）→ 清掉重来
    if (await pathExists(workDir)) {
      await fs.rm(workDir, { recursive: true, force: true });
    }
    // 清「目录没了但 git 还记着」的僵尸 worktree 注册（否则 add 同路径报错）
    await runGit(repoPath, ["worktree", "prune"]);

    const branch = info.name;
    const localBranchExists = (
      await runGit(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
    ).ok;

    let added: GitResult;
    let resolvedBase = info.baseBranch;
    if (localBranchExists) {
      // 本地已有任务分支（返工 / 用户自己建过）→ 直接挂到 worktree
      added = await runGit(repoPath, ["worktree", "add", workDir, branch], 120_000);
    } else {
      // 远程可能有同名分支（用户在别的机器 / 之前推过）→ fetch 后基于它建本地。
      // best-effort、30s 上限：fetch 只是「拿最新」的锦上添花、慢网络 / 被墙远程（github）
      // 挂太久会把整个推进卡住（实测 120s×2 把 advance 拖到 4 分钟+）、超时就用本地现有引用
      await runGit(repoPath, ["fetch", "origin", branch], 30_000);
      const remoteBranchExists = (
        await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `origin/${branch}`])
      ).ok;
      if (remoteBranchExists) {
        added = await runGit(
          repoPath,
          ["worktree", "add", "--no-track", "-b", branch, workDir, `origin/${branch}`],
          120_000,
        );
      } else {
        // 全新分支：基于线上分支建。base = 设置页快照、缺省探 origin/HEAD
        let base = task.repoBaseBranches?.[repoPath]?.trim() ?? "";
        if (!base) {
          const head = await runGit(repoPath, [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
          ]);
          base = head.ok ? head.stdout.replace("refs/remotes/origin/", "") : "";
        }
        if (!base) {
          throw new Error(
            `仓库 ${repoPath} 探不到主分支（origin/HEAD 未设置）——去设置页给该仓配「线上分支」后重试`,
          );
        }
        await runGit(repoPath, ["fetch", "origin", base], 30_000); // best-effort、同上 30s 上限
        // 起点优先 origin/<base>（最新）、离线 / 无远程时回退本地 <base>
        const startPoint = (
          await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `origin/${base}`])
        ).ok
          ? `origin/${base}`
          : (
                await runGit(repoPath, [
                  "show-ref",
                  "--verify",
                  "--quiet",
                  `refs/heads/${base}`,
                ])
              ).ok
            ? base
            : "";
        if (!startPoint) {
          throw new Error(
            `仓库 ${repoPath} 找不到线上分支「${base}」（远程 / 本地都没有）——核对设置页该仓的线上分支名`,
          );
        }
        resolvedBase = base;
        // --no-track：防 git 自动设 upstream=origin/<线上>、之后裸 push 误推线上（同 build hint 老规则）
        added = await runGit(
          repoPath,
          ["worktree", "add", "--no-track", "-b", branch, workDir, startPoint],
          120_000,
        );
      }
    }

    if (!added.ok) {
      // 最常见：分支已在原仓库 / 别的 worktree 检出（git 同一分支只允许一个检出点）
      //（不提「改用直接在原仓库运行」——isolateWorktree 建完没有入口能改、提了也做不到）
      const hint = /already checked out/i.test(added.stderr)
        ? "——该分支已在原仓库或其它任务的工作区检出：去原仓库把这个分支切走（checkout 别的分支）、或删掉占用它的任务后重试"
        : "";
      throw new Error(
        `仓库 ${repoPath} 创建隔离工作区失败（分支 ${branch}）：${added.stderr || added.stdout}${hint}`,
      );
    }

    info.baseBranch = resolvedBase;
    info.checkedOut = true;
    await copyRootEnvFiles(repoPath, workDir);
    if (await cloneNodeModules(repoPath, workDir)) {
      clonedNodeModulesRepos.push(repoPath);
    }
    createdRepos.push(repoPath);
  }

  return { infos, createdRepos, clonedNodeModulesRepos };
};

/**
 * node_modules 秒级克隆（V0.10.1、用户实测痛点：umi 类大包每个 worktree 重装太久、
 * 且 postinstall 在新环境偶发失败 → build 的 lint/typecheck 被迫 skip）。
 *
 * 原仓库有现成 node_modules 时用 APFS copy-on-write 克隆（mac `cp -Rc`、clonefile(2)）：
 * 不走网络、秒到十几秒级、磁盘块共享几乎不占空间、postinstall 产物原样带过来。
 * 两边是独立副本（非 symlink）、互不污染；分支间依赖有差异时 agent 增量 install 补齐。
 * 失败（跨卷 / 非 APFS / 非 mac）静默跳过、回退 agent 自装。
 */
const cloneNodeModules = async (
  repoPath: string,
  workDir: string,
): Promise<boolean> => {
  if (process.platform !== "darwin") return false; // clonefile 仅 APFS、其它平台回退 agent 自装
  const src = path.join(repoPath, "node_modules");
  const dst = path.join(workDir, "node_modules");
  if (!(await pathExists(src)) || (await pathExists(dst))) return false;
  try {
    // -c = clonefile；大 node_modules（几十万文件）逐文件克隆也只是元数据操作、给足超时
    await execFileAsync("cp", ["-Rc", src, dst], { timeout: 600_000 });
    return true;
  } catch (err) {
    // 半截残留必须清掉——否则 agent 看到 node_modules 存在就不装了、比没有更坑
    await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
    console.warn(
      `[task-worktrees] node_modules 克隆失败（回退 agent 自装）repo=${repoPath}：`,
      err,
    );
    return false;
  }
};

// 拷原仓库根目录的 .env* 到 worktree（只拷 worktree 里没有的——tracked 的 .env 检出自带、不覆盖）
// dev server / 本地脚本常依赖 gitignore 的 .env.local 等、不拷新工作区直接跑不起来
const copyRootEnvFiles = async (repoPath: string, workDir: string): Promise<void> => {
  try {
    const entries = await fs.readdir(repoPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith(".env")) continue;
      const target = path.join(workDir, e.name);
      if (await pathExists(target)) continue;
      await fs.copyFile(path.join(repoPath, e.name), target);
    }
  } catch (err) {
    // 拷贝失败不挡启动（agent 跑不起 dev server 时用户自己补）、只 log
    console.warn(`[task-worktrees] 拷贝 .env* 失败（忽略）repo=${repoPath}：`, err);
  }
};

// ----------------- worktree 清理 -----------------

/**
 * 删 worktree 前的产物保底：工作区脏（build 完没 ship 时、改动只以未提交形式存在）
 * → 自动 commit 一份 WIP 快照到任务分支再删——「分支保留 = 产物保留」才真成立、
 * reopen 重建 worktree 检出分支还能无缝续推。快照失败不挡删除（best-effort、只 log）。
 * @returns 是否真的 commit 了快照
 */
const snapshotDirtyWorktree = async (workDir: string): Promise<boolean> => {
  const status = await runGit(workDir, ["status", "--porcelain"]);
  if (!status.ok || status.stdout.length === 0) return false; // 干净 / 查不了、直接删
  const added = await runGit(workDir, ["add", "-A"]);
  if (!added.ok) {
    console.warn(`[task-worktrees] WIP 快照 git add 失败（照常删）${workDir}：${added.stderr}`);
    return false;
  }
  // 本地快照 commit：绕过业务仓库自己的 hooks（可能装了 lint-staged 等、失败会挡快照）；
  // 用户没配 git 身份时给个兜底身份、保证 commit 一定能落
  const committed = await runGit(workDir, [
    "-c", "user.name=fe-ai-flow",
    "-c", "user.email=fe-ai-flow@local",
    "commit", "--no-verify", "-m", "WIP：任务终结前自动快照（fe-ai-flow）",
  ]);
  if (!committed.ok) {
    console.warn(
      `[task-worktrees] WIP 快照 commit 失败（照常删）${workDir}：${committed.stderr}`,
    );
    return false;
  }
  return true;
};

export interface RemoveWorktreesResult {
  /** 是否真的清理了至少一个目录 */
  removedAny: boolean;
  /** 删前自动 commit 了 WIP 快照的原仓库路径（写事件告知用户用） */
  snapshotRepos: string[];
}

/**
 * 删掉本 task 的全部 worktree（task 终结 / 删除时调）。
 * feature 分支**保留**在原仓库（worktree 删了分支还在）；工作区有未提交改动时
 * 先自动 commit WIP 快照到任务分支（见 snapshotDirtyWorktree）、防 build 未 ship 的产物被销毁。
 * best-effort：单仓失败只 log、不抛（boot 孤儿扫描兜底）。
 */
export const removeTaskWorktrees = async (
  t: WorktreeTaskLike,
): Promise<RemoveWorktreesResult> => {
  const taskDir = getTaskWorktreesDir(t.id);
  if (!(await pathExists(taskDir))) return { removedAny: false, snapshotRepos: [] };

  const workPaths = getTaskWorkRepoPaths(t);
  let removedAny = false;
  const snapshotRepos: string[] = [];
  for (let i = 0; i < t.repoPaths.length; i++) {
    const repoPath = t.repoPaths[i];
    const workDir = workPaths[i];
    if (!(await pathExists(workDir))) continue;
    // 未提交改动先落 WIP 快照到任务分支（--force 删除会连未提交改动一起销毁）
    if (await snapshotDirtyWorktree(workDir)) snapshotRepos.push(repoPath);
    // 优先走 git worktree remove（同时清 .git/worktrees 注册）；原仓库没了 / 命令失败退回 rm + prune
    const removed = await runGit(
      repoPath,
      ["worktree", "remove", "--force", workDir],
      60_000,
    );
    if (!removed.ok) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      await runGit(repoPath, ["worktree", "prune"]);
    }
    removedAny = true;
  }
  // 容器目录清空后移除（还有残留就留着、不 force 递归删以防误伤）
  await fs.rmdir(taskDir).catch(() => {});
  return { removedAny, snapshotRepos };
};

/**
 * 从 worktree `.git` 指针文件内容解析主仓公共 git dir。
 * 内容形如 `gitdir: <原仓>/.git/worktrees/<name>`——注意 git 在 Windows 上也写
 * **正斜杠**、不能用 path.sep 匹配（stop-hook-inject 同款逻辑、双端分隔符都认）。
 * 解析不了返 null。
 */
export const parseMainGitDirFromPointer = (pointer: string): string | null => {
  const m = pointer.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  const gitdir = m[1].trim();
  const idx = gitdir.search(/[\\/]worktrees[\\/][^\\/]+[\\/]?$/);
  return idx > 0 ? gitdir.slice(0, idx) : null;
};

/**
 * 启动孤儿扫描（boot recovery 调）：worktrees/ 下不属于任何「存活 task」的目录整个清掉。
 * 覆盖：task 被删但清理失败 / 终结时 app 崩了没来得及清。
 * 反向解析原仓库：worktree 的 `.git` 指针（见 parseMainGitDirFromPointer）
 * 找到原仓库跑 `worktree prune` 清注册；脏工作区删前照样落 WIP 快照。全程 best-effort、绝不抛。
 */
export const cleanupOrphanTaskWorktrees = async (
  liveTaskIds: Set<string>,
): Promise<void> => {
  const root = getWorktreesRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // 目录不存在 = 没建过 worktree
  }
  for (const e of entries) {
    if (!e.isDirectory() || liveTaskIds.has(e.name)) continue;
    const orphanDir = path.join(root, e.name);
    try {
      // 删目录前先收集各仓的主 .git 目录（删完就读不到 gitdir 指针了）
      const mainGitDirs = new Set<string>();
      const repoDirs = await fs.readdir(orphanDir, { withFileTypes: true });
      for (const r of repoDirs) {
        if (!r.isDirectory()) continue;
        const workDir = path.join(orphanDir, r.name);
        try {
          const gitFile = await fs.readFile(path.join(workDir, ".git"), "utf8");
          const mainGitDir = parseMainGitDirFromPointer(gitFile);
          if (mainGitDir) mainGitDirs.add(mainGitDir);
          // 跟 removeTaskWorktrees 同一条保底：未提交改动先 commit 到任务分支再删
          await snapshotDirtyWorktree(workDir);
        } catch {
          // .git 文件读不到（非 worktree 残留）、直接随目录删
        }
      }
      await fs.rm(orphanDir, { recursive: true, force: true });
      for (const gitDir of mainGitDirs) {
        await runGit(path.dirname(gitDir), ["worktree", "prune"]);
      }
      console.log(`[task-worktrees] 已清理孤儿 worktree：${orphanDir}`);
    } catch (err) {
      console.warn(`[task-worktrees] 清理孤儿 worktree 失败（忽略）${orphanDir}：`, err);
    }
  }
};
