/**
 * chat 工作目录的 git 分支读写（V0.8）
 *
 * 跟 task.gitBranches（agent 跑 checkout 后 upsert 的「工作分支记录」、task 模式用）是两码事——
 * 这里是「读某目录现有的本地分支 + 直接 checkout 切换」，给自由对话的工作目录分支选择器用
 * （对齐 codex / Cursor：cwd 是 git 仓时能看当前分支、下拉切换）。
 *
 * 全部 best-effort + execFile（不走 shell、无注入面）：非 git 仓 / 命令失败一律降级、不抛。
 */

import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { occupantOf, occupiedBranchMessage } from "../git-branch-occupancy";
import { stripHostInjectedEnv } from "./host-env";
import type {
  GitBranchOccupant,
  GitBranchState,
  RepoBranchList,
} from "../types";

const execFileAsync = promisify(execFile);

/**
 * 判定 dir 是否存在（目录）。
 * ⚠️ 为什么必须先查：Node spawn 在 **cwd 不存在** 时也报 ENOENT、跟「git 命令
 * 不存在」错误码一模一样——不先区分会把「路径填错」误诊成「没装 git」。
 */
const dirExists = async (dir: string): Promise<boolean> => {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 最佳努力更新远端 refs（2026-09：测试同事搜不到研发刚推的分支——之前只读本地已知 refs）。
 *
 * 约束：
 * - `GIT_TERMINAL_PROMPT=0`：没配好凭据时直接失败、不弹输入框把 server 挂住
 * - 20s 超时兜底（没配 ssh key 的机器上 ssh 也可能等输入）
 * - 失败一律吞掉返回 false：离线 / 无 remote / 鉴权失败都降级用本地 refs，下拉框不受影响
 */
export const fetchRemoteRefs = async (dir: string): Promise<boolean> => {
  if (!dir) return false;
  try {
    await execFileAsync("git", ["fetch", "--prune"], {
      cwd: dir,
      timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch {
    return false;
  }
};

/** `git worktree list --porcelain` 里的一条记录 */
export interface WorktreeEntry {
  /** 工作树目录（Windows 下 git 吐正斜杠 `C:/x`，这里统一成反斜杠，展示 / stat 都按本机习惯） */
  path: string;
  /** 检出的本地分支名（已去掉 refs/heads/）；detached HEAD / bare 仓为 null */
  branch: string | null;
  bare: boolean;
  /** git 自己判定可 prune（目录丢了；git ≥ 2.31 才输出这一行，旧版靠调用方 stat 兜底） */
  prunable: boolean;
}

// git 在 Windows 上输出正斜杠盘符路径（C:/Users/x）；转成反斜杠，与 Node / 资源管理器习惯一致
const toNativeDisplayPath = (p: string): string =>
  /^[A-Za-z]:\//.test(p) ? p.replace(/\//g, "\\") : p;

/**
 * 解析 `git worktree list --porcelain`（纯函数）。
 *
 * 每个工作树一段、以 `worktree <path>` 开头，随后可有 `HEAD <sha>` /
 * `branch refs/heads/<name>` / `detached` / `bare` / `locked [原因]` / `prunable [原因]`。
 * porcelain 格式稳定、与系统语言无关——这正是不去解析 `git checkout` 报错文案的原因
 * （同一条 fatal 在中文系统上是「已经检出到」、英文是「is already checked out at」，还随 git 版本改过措辞）。
 */
export const parseWorktreeList = (porcelain: string): WorktreeEntry[] => {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      cur = {
        path: toNativeDisplayPath(line.slice("worktree ".length)),
        branch: null,
        bare: false,
        prunable: false,
      };
      entries.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      cur.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      cur.prunable = true;
    }
  }
  return entries;
};

/** 读 dir 所在仓的全部工作树；命令失败（git < 2.7 / 超时）→ 空数组，等价于「查不到占用」 */
const listWorktrees = async (dir: string): Promise<WorktreeEntry[]> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: dir, timeout: 10_000 },
    );
    return parseWorktreeList(stdout);
  } catch {
    return [];
  }
};

/**
 * 从工作树列表算出「被其他工作树占用的分支」（分支名 → 占用者）。
 *
 * - current（当前工作树自己的分支）不算占用；detached / bare 没有分支、跳过
 * - 同一分支被多个工作树强行检出（git worktree add --force）时留第一个
 * - missing：git 已判定 prunable，或目录 stat 不到（旧 git 不输出 prunable）
 */
export const buildBranchOccupancy = async (
  entries: WorktreeEntry[],
  current: string | null,
): Promise<Record<string, GitBranchOccupant>> => {
  const others = entries.filter(
    (e) => !e.bare && e.branch !== null && e.branch !== current,
  );
  const resolved = await Promise.all(
    others.map(async (entry) => ({
      entry,
      missing: entry.prunable || !(await dirExists(entry.path)),
    })),
  );
  // 用 Map 再转对象：分支名可以叫 __proto__，直接 obj[name] = … 会改原型而不是加属性
  const occupied = new Map<string, GitBranchOccupant>();
  for (const { entry, missing } of resolved) {
    if (entry.branch !== null && !occupied.has(entry.branch)) {
      occupied.set(entry.branch, { path: entry.path, missing });
    }
  }
  return Object.fromEntries(occupied);
};

/** 当前分支名；detached HEAD（git 返回字面 "HEAD"）/ 非 git 仓 / 命令失败 → null */
const readCurrentBranch = async (dir: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: dir, timeout: 10_000 },
    );
    const name = stdout.trim();
    return name && name !== "HEAD" ? name : null;
  } catch {
    return null;
  }
};

/**
 * 读某目录的本地 git 分支状态。
 * 非 git 仓 / 命令失败 → isRepo=false（调用方据此隐藏分支选择器）。
 * 被其他工作树占用的分支放在 occupied 里（git 不让同一分支同时检出到两处、切不过去）。
 */
export const readGitBranchState = async (
  dir: string,
  opts?: { refresh?: boolean },
): Promise<GitBranchState> => {
  const empty: GitBranchState = { isRepo: false, current: null, branches: [] };
  if (!dir) return empty;
  try {
    // 当前分支：detached HEAD 时 git 返回字面 "HEAD"、归一成 null
    const { stdout: head } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: dir, timeout: 10_000 },
    );
    const current = head.trim();
    const currentName = current && current !== "HEAD" ? current : null;
    // refresh：先更新远端 refs（研发刚推的分支不 fetch 本地根本没有）
    if (opts?.refresh) await fetchRemoteRefs(dir);
    // 本地 + 远端混列、去重（origin/ 前缀去掉）：刚 fetch 回来的远端分支也能切——
    // git checkout 对纯远端名会自动建本地跟踪分支（--guess），列表里有就能选中。
    // 占用关系与分支列表并行读：多 spawn 一个 git、但不多一段串行等待（Windows 上 spawn 偏慢）。
    // 占用查询失败只当「没有占用」、不影响分支列表。
    const [{ stdout: list }, occupied] = await Promise.all([
      execFileAsync(
        "git",
        [
          "for-each-ref",
          "refs/heads",
          "refs/remotes",
          "--format=%(refname)",
          "--sort=-committerdate",
        ],
        { cwd: dir, timeout: 10_000 },
      ),
      listWorktrees(dir).then((entries) =>
        buildBranchOccupancy(entries, currentName),
      ),
    ]);
    const seen = new Set<string>();
    for (const line of list.split("\n")) {
      const ref = line.trim();
      if (!ref) continue;
      if (ref.startsWith("refs/heads/")) {
        seen.add(ref.slice("refs/heads/".length));
      } else if (ref.startsWith("refs/remotes/")) {
        const rest = ref.slice("refs/remotes/".length);
        const idx = rest.indexOf("/");
        const name = idx >= 0 ? rest.slice(idx + 1) : null;
        // origin/HEAD 是符号引用、跳过
        if (name && name !== "HEAD") seen.add(name);
      }
    }
    const branches = [...seen];
    return {
      isRepo: true,
      current: currentName,
      branches,
      // 没有占用时不带这个字段（绝大多数仓都没有额外工作树、响应体保持跟以前一样）
      ...(Object.keys(occupied).length > 0 ? { occupied } : {}),
    };
  } catch {
    return empty;
  }
};

/**
 * 列某仓的分支候选：本地 + 远端合并去重（v0.9.11、设置页分支下拉 / 测试任务被测分支 Combobox 用）。
 *
 * 跟 readGitBranchState 的区别：线上 / test / develop 这类长期分支本地常常没 checkout 过、
 * 只列本地分支会缺——所以一并列 refs/remotes、去掉 remote 名前缀后合并。
 * 默认不主动 git fetch（慢 + 可能要凭据）、用本地已知的 refs；调用方传
 * refresh: true 时先最佳努力 fetch 一次（失败降级本地、不抛）。前端 Combobox 只从这份列表选，搜不到不造新值。
 */
export const listRepoBranches = async (
  dir: string,
  opts?: { refresh?: boolean },
): Promise<RepoBranchList> => {
  const empty: RepoBranchList = { isRepo: false, branches: [] };
  if (!dir) return empty;
  try {
    // refresh：先更新远端 refs（研发刚推的分支不 fetch 本地根本没有）
    if (opts?.refresh) await fetchRemoteRefs(dir);
    // 一条命令混列本地 + 远端、按最近提交倒序（活跃分支排前面、两类场景都顺手）
    const { stdout } = await execFileAsync(
      "git",
      [
        "for-each-ref",
        "refs/heads",
        "refs/remotes",
        "--format=%(refname)",
        "--sort=-committerdate",
      ],
      { cwd: dir, timeout: 10_000 },
    );
    const seen = new Set<string>();
    for (const line of stdout.split("\n")) {
      const ref = line.trim();
      if (!ref) continue;
      let name: string | null = null;
      if (ref.startsWith("refs/heads/")) {
        name = ref.slice("refs/heads/".length);
      } else if (ref.startsWith("refs/remotes/")) {
        // refs/remotes/<remote>/<branch>：去掉 remote 段；origin/HEAD 是符号引用、跳过
        const rest = ref.slice("refs/remotes/".length);
        const idx = rest.indexOf("/");
        name = idx >= 0 ? rest.slice(idx + 1) : null;
        if (name === "HEAD") name = null;
      }
      if (name) seen.add(name);
    }
    // 子目录（monorepo 的 packages/web 之类）：git 能列分支，但任务快照口径（目录下有 .git）判它「非 git」
    const notRoot = !existsSync(path.join(dir, ".git"));
    return { isRepo: true, branches: [...seen], ...(notRoot ? { notRoot: true } : {}) };
  } catch (err) {
    // 三种失败分开诊断（同事 Windows「真 git 仓被报非 git」排查不动、被迫较真）：
    // ① 路径不存在（spawn cwd 不存在也报 ENOENT、必须先 stat 区分）
    // ② git 命令不存在（PATH 里没有）
    // ③ 真不是 git 仓 / 其他 git 报错
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      if (!(await dirExists(dir))) {
        console.warn(`[git-branches] 仓库路径不存在：${dir}`);
        return { isRepo: false, branches: [], pathMissing: true };
      }
      console.warn(`[git-branches] git 命令不存在（PATH 里没有）、dir=${dir}`);
      return { isRepo: false, branches: [], gitMissing: true };
    }
    console.warn(
      `[git-branches] listRepoBranches 失败 dir=${dir}：${(e.stderr || e.message || "").slice(0, 200)}`,
    );
    return empty;
  }
};

/**
 * 切换某目录的 git 分支（git checkout）。
 * 失败（分支不存在 / 工作区有未提交改动会被覆盖 / 非 git 仓）把 git stderr 带回、调用方 toast；
 * 分支被其他工作树占用时不进 git、直接返回带路径的说明（见下）。
 */
export const checkoutGitBranch = async (
  dir: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  if (!dir) return { ok: false, error: "工作目录为空" };
  const b = branch.trim();
  if (!b) return { ok: false, error: "分支名为空" };
  // 防 "-" 开头被 git 当 flag 解析（合法分支名不以 - 开头）
  if (b.startsWith("-")) return { ok: false, error: `非法分支名：${b}` };
  // 先查占用再 checkout：git 不让同一分支同时在两个工作树检出，直接切只会拿到一条
  // 随系统语言变的 fatal 原文、也没有「怎么办」。选择器虽已置灰，但列表可能过期
  //（别处刚建好 worktree），所以这里再兜一次。
  // 切到当前分支自己不会误拦：buildBranchOccupancy 本来就把 current 排除在占用之外。
  const [current, entries] = await Promise.all([
    readCurrentBranch(dir),
    listWorktrees(dir),
  ]);
  const occupant = occupantOf(await buildBranchOccupancy(entries, current), b);
  if (occupant) return { ok: false, error: occupiedBranchMessage(b, occupant) };
  try {
    // 尾部 `--`：声明 b 只能是分支 / 提交、不能退化成路径。不带它时，分支名来自 UI（列表可能已过期、
    // 分支刚被删），若工作区恰有同名已跟踪文件，`git checkout b` 会静默把该文件从 index 还原、丢未提交改动
    //（实测 Updated 1 path from the index）；带 `--` 则直接 `fatal: invalid reference`。
    // 远端独有分支的 DWIM（自动建跟踪分支）在带 `--` 时照常生效（实测）。
    // env 剔宿主注入变量：checkout 会触发用户仓的 post-checkout 钩子（见 host-env.ts / task-worktrees.runGit）
    await execFileAsync("git", ["checkout", b, "--"], {
      cwd: dir,
      timeout: 15_000,
      env: stripHostInjectedEnv(),
    });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const msg = (e.stderr || e.message || "git checkout 失败").trim();
    return { ok: false, error: msg };
  }
};
