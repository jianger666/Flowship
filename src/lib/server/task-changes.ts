/**
 * task 模式「代码改动预览」的 git 读取层
 *
 * 回答的问题：这个任务到现在为止，每个仓里改了什么——不用再开 Cursor 翻。
 *
 * 为什么直接问 git、不去聚合事件流里各 edit 工具的 diff：
 * - 同一文件被改多次，事件流只能叠加、看不到净改动；
 * - 工具 diff 在服务端被截断过；
 * - shell 里 sed / mv / 脚本生成的改动、用户自己在 IDE 里的改动，事件流根本没有。
 *
 * 基线 = HEAD 与「线上分支」的分叉点（merge-base）：
 * 隔离 worktree 是从 origin/<base> 切出来的，任务分支上自己的提交 + 未提交改动合起来就是「本任务的改动」。
 * 线上分支依次取 task.gitBranches[].baseBranch → 设置页该仓的线上分支 → origin/HEAD；
 * 一个都解析不出才降级成 HEAD（只看未提交改动、UI 会标注）。
 *
 * 非隔离任务（直接在原仓里干活）走同一套逻辑：当前 HEAD 在哪个分支、就展示哪个分支相对线上分支的整体改动
 * （含任务开始前该分支上已有的提交和未提交内容）。每次实时读 HEAD、不存任何快照，
 * 所以任务中途切分支（分支切换器允许）也会自动跟着走。
 *
 * chat 模式同理（单仓 = 用户选的工作目录、没有 worktree 隔离）：以「当前所在分支」的变更为准。
 * chat 没有任务记录的分支配置 / 设置页快照，所以线上分支多一级兜底：依次探测常见默认分支名
 * （origin/main、origin/master …），再不行才降级成 HEAD；用户也可以在面板里手动指定对比基线。
 * 没绑工作目录的 chat（agent 起在主目录 / process.cwd()）绝不读——那不是用户的仓。
 *
 * 范围（scope）：默认 branch（相对分叉点的全部）；也可以只看 uncommitted（相对 HEAD）、
 * 或分支上的某一个提交（commit）。提交必须落在「线上分支..HEAD」里才认，防止借接口翻任意历史。
 *
 * 约束：
 * - 全程只读：GIT_OPTIONAL_LOCKS=0（git diff 默认会机会性刷新 index、与 agent 的 git 操作抢 index.lock）；
 *   不 git add -N、不碰 index——未跟踪文件的 diff 由我们自己合成。
 * - execFile（不走 shell、无注入面）；路径一律在 `--` 之后并开 --literal-pathspecs。
 * - 工作目录从 task 权威数据算（接口不接受前端传任意路径）；非 git / 只读仓不出现（它们不会被改）。
 * - 仓库根：chat 的工作目录可能是仓库的子目录（monorepo 子包很常见）——git 一律在仓库根里跑、
 *   绝对路径也以它为基准，路径口径才一致（见 resolveRepoRoot）。
 * - 文件级指纹（fingerprint）：旧 / 新两侧 blob 的标识，前端据此判断「这个文件的 diff 还是不是上次那份」。
 *   工作区有未暂存改动的文件 git 不给新侧哈希，用只读的 hash-object --no-filters 补算（不写对象库、不碰 index）。
 * - best-effort：单个仓失败只让该仓带 unavailable、不影响其他仓。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { formatChangeScope } from "../changes/scope";
import { getRepoWorkDirs } from "../path-utils";
import {
  DEFAULT_HASH_LIMITS,
  MAX_HASH_TOTAL_BYTES,
  type HashCache,
  type HashCandidate,
  type HashLimits,
  type UntrackedSummary,
  decodeUntrackedSummary,
  encodeUntrackedSummary,
  hashCacheKey,
  planHashing,
  untrackedSummaryCache,
  workingHashCache,
} from "./working-file-hash";
import type {
  GitBranchInfo,
  TaskChangeCommits,
  TaskChangeFile,
  TaskChangeFileDiff,
  TaskChangeScope,
  TaskChanges,
  TaskChangeStatus,
  TaskMode,
  TaskRepoChangeBase,
  TaskRepoChanges,
  TaskRepoCommit,
  TaskRepoCommitList,
} from "../types";

const execFileAsync = promisify(execFile);

// ----------------- 上限（大 diff / 海量文件的兜底） -----------------

/** 提交选择器最多列多少个提交（再多的只给最近这些、标 truncated） */
export const MAX_COMMITS = 200;
/** 「展开上下文」用的全文件上下文行数（git 的 -U 参数；单文件 diff 的字节上限仍然生效） */
const FULL_CONTEXT_LINES = 1_000_000;
/**
 * chat 没有任务记录的线上分支配置时，依次探测的常见默认分支名。
 * 放在候选链最末尾：任务记录 / 设置页快照 / origin/HEAD 任何一个命中就不会走到这里。
 * 只给 chat 用——task 找不到线上分支时降级成 HEAD 是已发布的行为（UI 有对应说明），不动它。
 */
const COMMON_BASE_BRANCHES = ["main", "master", "develop", "dev", "trunk"] as const;

/** 单次列表最多返回的文件数；超出只列前面这些、totals 仍按全量算 */
export const MAX_CHANGE_FILES = 500;
/** 未跟踪文件最多逐个读取统计行数的个数（再多的只标「新文件」、不数行；嵌套仓库项不占额度） */
export const MAX_UNTRACKED_STAT_FILES = 200;
/** 单个未跟踪文件统计行数时最多读多大 */
const MAX_UNTRACKED_STAT_BYTES = 1024 * 1024;
/** 单个文件 diff 返回给前端的字节上限，超出按行截断 */
export const MAX_FILE_DIFF_BYTES = 400 * 1024;
/** git diff 单文件输出超过它就放弃读取（tooLarge） */
const MAX_FILE_DIFF_BUFFER = 8 * 1024 * 1024;
/** 列表类命令（name-status / numstat / ls-files）的输出上限 */
const MAX_LIST_BUFFER = 8 * 1024 * 1024;
/** 二进制判定：前 8000 字节含 NUL（git 自己也是这么判的） */
const BINARY_SNIFF_BYTES = 8000;
/** 指纹里 blob 哈希取前多少位（够区分，且不让签名在 localStorage / 缓存键里太长） */
const OID_SHORT = 12;
/** 全零 oid = 该侧没有内容，或（新侧）工作区有未暂存改动、git 没为它算哈希 */
const ZERO_OID = /^0+$/;
/** hash-object 一批最多放多少字符的路径参数（Windows 命令行上限 8191，留足余量） */
export const HASH_BATCH_CHARS = 6000;

// ----------------- 任务最小形状（task-fs 的 Task 满足它） -----------------

export interface TaskChangesTaskLike {
  mode?: TaskMode;
  repoPaths: string[];
  workCwd?: string;
  isolateWorktree?: boolean;
  nonGitRepoPaths?: string[];
  readonlyRepoPaths?: string[];
  gitBranches?: Array<Pick<GitBranchInfo, "repoPath" | "baseBranch">>;
  repoBaseBranches?: Record<string, string>;
}

export interface ChangeRepoTarget {
  repoPath: string;
  shortName: string;
  workDir: string;
  isolated: boolean;
}

/**
 * 本任务有哪些仓值得看改动：
 * - 还没启动（没有 workCwd）/ 没绑仓 → 没有。chat 没绑工作目录时 workCwd 会兜底成 process.cwd()
 *   （Flowship 自己的目录），所以「repoPaths 为空」必须挡在这里——那不是用户的仓、不能读
 * - 非 git、只读仓被剔掉（不会被改、也没有 git 可读）
 * - workDir 与 branches 接口 / IDE 打开同源（getRepoWorkDirs）
 * - chat 没有 worktree 隔离：永远 isolated=false、workDir = 用户选的工作目录
 */
export const resolveChangeRepoTargets = (
  task: TaskChangesTaskLike,
): ChangeRepoTarget[] => {
  if (!task.workCwd || task.repoPaths.length === 0) {
    return [];
  }
  const nonGit = new Set(task.nonGitRepoPaths ?? []);
  const readonly = new Set(task.readonlyRepoPaths ?? []);
  const isolated = task.mode !== "chat" && task.isolateWorktree === true;
  return getRepoWorkDirs(
    task.repoPaths,
    task.workCwd,
    isolated,
    task.nonGitRepoPaths,
    task.readonlyRepoPaths,
  )
    .filter((d) => !nonGit.has(d.repoPath) && !readonly.has(d.repoPath))
    .map((d) => ({
      repoPath: d.repoPath,
      shortName: d.shortName,
      workDir: d.workDir,
      isolated,
    }));
};

// ----------------- git 执行底座 -----------------

interface GitRun {
  ok: boolean;
  stdout: string;
  /** 输出超过 maxBuffer（调用方据此降级、不是普通失败） */
  overflow: boolean;
}

const runGit = async (
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number },
): Promise<GitRun> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: opts?.timeoutMs ?? 20_000,
      maxBuffer: opts?.maxBuffer ?? MAX_LIST_BUFFER,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        // 只读预览：不要去刷新 index（会写 index.lock、跟 agent 的 git 操作抢锁）
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    return { ok: true, stdout, overflow: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    return {
      ok: false,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      overflow: e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    };
  }
};

const dirExists = async (dir: string): Promise<boolean> => {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 仓库根目录（git 吐的路径都相对它）；null = 不是 git 工作树。
 *
 * chat 的工作目录可以是仓库的子目录（monorepo 子包很常见）。而在子目录里 git 的路径口径是乱的：
 * 已跟踪文件的路径相对仓库根、未跟踪文件的路径相对当前目录，pathspec 也按当前目录解析——
 * 直接在子目录里跑会：清单漏掉目录外的未跟踪文件、绝对路径错位（IDE 跳转必失败）、单文件 diff 为空。
 * 所以 git 一律在仓库根里跑、绝对路径也以它为基准（口径本来就是「整条分支」，目录外的改动也该列出）。
 *
 * `--show-toplevel` 吐的是真实路径（macOS 的 /tmp → /private/tmp 已解开）；隔离 worktree 吐 worktree 根，
 * 所以 task 模式（workDir 本来就是根）行为不变。
 */
const resolveRepoRoot = async (dir: string): Promise<string | null> => {
  const r = await runGit(dir, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"]);
  if (!r.ok) return null;
  const [inside, top] = r.stdout.split("\n");
  const root = top?.trim();
  return inside?.trim() === "true" && root ? root : null;
};

// ----------------- 纯函数：解析 git 的 -z 输出 -----------------

export interface NameStatusEntry {
  status: TaskChangeStatus;
  path: string;
  oldPath?: string;
}

/**
 * 解析 `git diff --name-status -z -M`：
 * `M\0path\0`、`D\0path\0`、`R077\0old\0new\0`（重命名带两个路径）。
 */
export const parseNameStatusZ = (out: string): NameStatusEntry[] => {
  const tokens = out.split("\0");
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!code) continue;
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (!oldPath || !newPath) break;
      entries.push(
        kind === "R"
          ? { status: "renamed", path: newPath, oldPath }
          : { status: "added", path: newPath },
      );
      continue;
    }
    const p = tokens[i++];
    if (!p) break;
    entries.push({
      status: kind === "A" ? "added" : kind === "D" ? "deleted" : "modified",
      path: p,
    });
  }
  return entries;
};

export interface NumstatEntry {
  added: number | null;
  removed: number | null;
  binary: boolean;
}

const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

/**
 * 解析 `git diff --numstat -z -M`，按「新路径」建索引：
 * `1\t2\tpath\0`；重命名是 `1\t0\t\0old\0new\0`（路径段为空、后跟两个 token）；二进制是 `-\t-\t`。
 */
export const parseNumstatZ = (out: string): Map<string, NumstatEntry> => {
  const tokens = out.split("\0");
  const map = new Map<string, NumstatEntry>();
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i++];
    if (!token) continue;
    const m = NUMSTAT_RE.exec(token);
    if (!m) continue;
    let filePath = m[3];
    if (filePath === "") {
      i++; // old path
      filePath = tokens[i++] ?? "";
    }
    if (!filePath) continue;
    const binary = m[1] === "-" || m[2] === "-";
    map.set(filePath, {
      added: m[1] === "-" ? null : Number(m[1]),
      removed: m[2] === "-" ? null : Number(m[2]),
      binary,
    });
  }
  return map;
};

export interface RawEntry {
  /** 旧 / 新两侧的 blob oid（完整十六进制；全零 = 该侧没有内容，或新侧在工作区有未暂存改动、git 没为它算哈希） */
  oldOid: string;
  newOid: string;
}

const OID_RE = /^[0-9a-f]{7,64}$/;

/**
 * 解析 `git diff --raw -z --no-abbrev -M`，按「新路径」建索引：
 * `:100644 100644 <old> <new> M\0path\0`；重命名 / 复制 `:… R100\0old\0new\0`（取新路径）。
 * oid 不像十六进制的记录（解析异常）整条丢弃——宁可没有指纹，也不给一个错的。
 */
export const parseRawZ = (out: string): Map<string, RawEntry> => {
  const tokens = out.split("\0");
  const map = new Map<string, RawEntry>();
  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i++];
    if (!meta || !meta.startsWith(":")) continue;
    const [, , oldOid = "", newOid = "", code = ""] = meta.slice(1).split(" ");
    const isPair = code[0] === "R" || code[0] === "C";
    if (isPair) i++; // 旧路径
    const p = tokens[i++];
    if (!p) break;
    if (OID_RE.test(oldOid) && OID_RE.test(newOid)) map.set(p, { oldOid, newOid });
  }
  return map;
};

/** `git ls-files -z` 输出 → 路径数组 */
export const parseNulList = (out: string): string[] =>
  out.split("\0").filter((s) => s.length > 0);

// ----------------- 路径校验 -----------------

/**
 * 接口入参的相对路径校验：必须是仓内相对路径（不许绝对路径 / `..` / NUL）。
 * 返回原样路径（不改写斜杠——git 吐的就是正斜杠、前端原样回传）；不合法返回 null。
 */
export const sanitizeRepoRelPath = (p: string | null | undefined): string | null => {
  if (!p || p.includes("\0")) return null;
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("/")) return null;
  const segments = p.split(/[\\/]/);
  if (segments.some((s) => s === ".." || s === "." || s === "")) return null;
  return p;
};

/** 分支名白名单：避免被当 option（`-` 开头）、避免奇怪 ref 语法 */
const isSafeRefName = (s: string): boolean =>
  s.length > 0 &&
  s.length <= 200 &&
  !s.startsWith("-") &&
  !s.includes("..") &&
  /^[\p{L}\p{N}_./@+-]+$/u.test(s);

/**
 * `HEAD`（不分大小写）不是线上分支名：在 git 里它指「当前提交」，而这里的基线必须是一个线上分支。
 * 放过它的话，有 `refs/remotes/origin/HEAD`（clone 出来的仓库都有，指向远端默认分支）的仓库会把它解析成
 * 远端默认分支——与「基线 = 当前提交」的直觉相反。分支候选列表（git-branches）同样跳过这个符号引用。
 * 不分大小写：大小写不敏感的文件系统（macOS 默认）上 `refs/remotes/origin/head` 也能命中 `HEAD` 文件。
 */
const isHeadAlias = (s: string): boolean => s.toUpperCase() === "HEAD";

// ----------------- 基线解析 -----------------

interface ResolvedBase extends TaskRepoChangeBase {
  sha: string;
  /** 命中的线上分支名（不带 origin/）；降级成 HEAD 时没有 */
  baseName?: string;
  /**
   * 线上分支的**完整 ref**（refs/remotes/origin/main 或 refs/heads/main）；只有 merge-base 才有——ahead / behind 用它算。
   * 必须是完整 ref：裸名 `main` 遇到同名 tag 时 git 优先按 tag 解析（还会告警），算出的领先 / 落后就错了。
   */
  ref?: string;
  /** 解析时的 HEAD sha：「只看未提交」范围直接拿它当 diff 基线，不用再问一遍 git */
  headSha: string;
  /** 手动指定了对比基线：requested = 用户选的名字，applied = 是否真的生效（名字不合法 / 找不到会回落） */
  override?: { requested: string; applied: boolean };
}

const SHA_RE = /^[0-9a-f]{40,64}$/;

/**
 * 线上分支候选（去重、按优先级）：
 * 手动指定 > 任务记录 > 设置页快照 > origin/HEAD > （仅 chat）常见默认分支名。
 * 手动指定的排最前：用户在面板里明确选了「对比谁」，找不到时 resolveBase 会自然落到后面的自动候选。
 */
const baseBranchCandidates = async (
  dir: string,
  task: TaskChangesTaskLike,
  repoPath: string,
  override?: string | null,
): Promise<string[]> => {
  const out: string[] = [];
  const push = (raw: string | undefined | null) => {
    const v = raw?.trim();
    if (v && isSafeRefName(v) && !isHeadAlias(v) && !out.includes(v)) out.push(v);
  };
  push(override);
  push(task.gitBranches?.find((b) => b.repoPath === repoPath)?.baseBranch);
  push(task.repoBaseBranches?.[repoPath]);
  const head = await runGit(dir, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (head.ok) push(head.stdout.trim().replace(/^origin\//, ""));
  // chat 没有任务记录的线上分支配置：兜底探测常见名字。task 不走这一级——
  // 它找不到线上分支时降级成 HEAD 是已发布的行为（UI 有对应文案），不能因为这次改动悄悄变掉
  if (task.mode === "chat") for (const name of COMMON_BASE_BRANCHES) push(name);
  return out;
};

/**
 * 解析基线 commit。HEAD 都不存在（空仓）返回 null。
 * 远端引用优先（worktree 就是基于 origin/<base> 切的）、本地分支兜底。
 */
const resolveBase = async (
  dir: string,
  task: TaskChangesTaskLike,
  repoPath: string,
  override?: string | null,
): Promise<ResolvedBase | null> => {
  const head = await runGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const headSha = head.stdout.trim();
  if (!head.ok || !SHA_RE.test(headSha)) return null;

  const requested = override?.trim() ?? "";
  const overrideOf = (applied: boolean): Pick<ResolvedBase, "override"> =>
    requested ? { override: { requested, applied } } : {};

  for (const name of await baseBranchCandidates(dir, task, repoPath, requested)) {
    const refs: Array<[string, string]> = [
      [`refs/remotes/origin/${name}`, `origin/${name}`],
      [`refs/heads/${name}`, name],
    ];
    for (const [ref, label] of refs) {
      const exists = await runGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (!exists.ok) continue;
      const mb = await runGit(dir, ["merge-base", "HEAD", ref]);
      const sha = mb.stdout.trim();
      if (mb.ok && SHA_RE.test(sha)) {
        return {
          kind: "merge-base",
          label,
          sha,
          shortSha: sha.slice(0, 7),
          baseName: name,
          ref,
          headSha,
          ...overrideOf(name === requested),
        };
      }
    }
  }
  return {
    kind: "head",
    label: "HEAD",
    sha: headSha,
    shortSha: headSha.slice(0, 7),
    headSha,
    ...overrideOf(false),
  };
};

/** 对外展示的基线（不带内部字段） */
const toBase = (b: ResolvedBase): TaskRepoChangeBase => ({
  kind: b.kind,
  label: b.label,
  shortSha: b.shortSha,
});

// ----------------- 范围（scope）解析 -----------------

interface ResolvedScope {
  /** `git diff` 的 revision 参数：1 个 = 工作区对它；2 个 = 两个提交之间 */
  revs: string[];
  /** 未跟踪文件算不算（只有「工作区视角」的范围才算；看单个提交时没有未跟踪的概念） */
  includeUntracked: boolean;
  /** 展示用基线 */
  base: TaskRepoChangeBase;
  resolved: ResolvedBase;
}

type ScopeResult =
  | { ok: true; value: ResolvedScope }
  | { ok: false; reason: "no_head" | "scope_invalid" };

/**
 * 校验并展开「单个提交」范围。必须同时满足：
 * - 有线上分支可比（merge-base 基线）——没有基线就谈不上「分支上的提交」；
 * - 它是 HEAD 的祖先、且在线上分支分叉点之后（不是分叉点本身）。
 * 这样既防止借接口翻任意历史，也保证它一定有父提交（--is-ancestor 对自己返回 0，所以要显式排除分叉点）。
 */
const resolveCommitScope = async (
  dir: string,
  resolved: ResolvedBase,
  rawSha: string,
): Promise<ResolvedScope | null> => {
  if (resolved.kind !== "merge-base" || !/^[0-9a-f]{7,64}$/i.test(rawSha)) return null;
  const full = await runGit(dir, ["rev-parse", "--verify", "--quiet", `${rawSha}^{commit}`]);
  const sha = full.stdout.trim();
  if (!full.ok || !SHA_RE.test(sha) || sha === resolved.sha) return null;
  const [afterBase, onBranch, parentRun] = await Promise.all([
    runGit(dir, ["merge-base", "--is-ancestor", resolved.sha, sha]),
    runGit(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]),
    runGit(dir, ["rev-parse", "--verify", "--quiet", `${sha}^1^{commit}`]),
  ]);
  const parent = parentRun.stdout.trim();
  if (!afterBase.ok || !onBranch.ok || !parentRun.ok || !SHA_RE.test(parent)) return null;
  return {
    revs: [parent, sha],
    includeUntracked: false,
    base: { kind: "commit-parent", label: `${sha.slice(0, 7)}^`, shortSha: parent.slice(0, 7) },
    resolved,
  };
};

const resolveScope = async (
  dir: string,
  task: TaskChangesTaskLike,
  repoPath: string,
  scope: TaskChangeScope,
  override?: string | null,
): Promise<ScopeResult> => {
  const resolved = await resolveBase(dir, task, repoPath, override);
  if (!resolved) return { ok: false, reason: "no_head" };
  if (scope.kind === "branch") {
    return {
      ok: true,
      value: { revs: [resolved.sha], includeUntracked: true, base: toBase(resolved), resolved },
    };
  }
  if (scope.kind === "uncommitted") {
    return {
      ok: true,
      value: {
        revs: [resolved.headSha],
        includeUntracked: true,
        base: { kind: "head", label: "HEAD", shortSha: resolved.headSha.slice(0, 7) },
        resolved,
      },
    };
  }
  const commit = await resolveCommitScope(dir, resolved, scope.sha);
  return commit ? { ok: true, value: commit } : { ok: false, reason: "scope_invalid" };
};

/** `git rev-list --left-right --count A...B` 的输出：左 = A 独有（落后）、右 = B 独有（领先） */
export const parseLeftRightCount = (
  out: string,
): { behind: number; ahead: number } | null => {
  const m = /^(\d+)\s+(\d+)\s*$/.exec(out);
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
};

const readAheadBehind = async (
  dir: string,
  ref: string,
): Promise<{ behind: number; ahead: number } | null> => {
  const r = await runGit(dir, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
  return r.ok ? parseLeftRightCount(r.stdout) : null;
};

const readBranchName = async (dir: string): Promise<string | null> => {
  const r = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = r.stdout.trim();
  return r.ok && name && name !== "HEAD" ? name : null;
};

// ----------------- 未跟踪文件 -----------------

const isBinaryBuffer = (buf: Buffer): boolean =>
  buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);

const countLines = (buf: Buffer): number => {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const byte of buf) if (byte === 0x0a) n++;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
};

/**
 * 按 git blob 的口径算内容的 oid（`blob <字节数>\0<内容>` 的 SHA-1）。
 * 和 git 自己给的 oid 逐位一致（没有过滤器时）——所以同一份内容不管 oid 是 git 给的还是我们补算的，
 * 指纹字符串都相同：`git add` / `git commit` / `git status` 刷新 index 前后「已查看」不会无故失效。
 * （SHA-256 对象格式的仓库极罕见：符号链接这条补算会与 git 的 oid 对不上，只是偶发多失效一次。）
 */
const gitBlobOid = (content: Buffer): string =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

const shortOid = (oid: string): string => oid.slice(0, OID_SHORT);

interface UntrackedStat {
  added: number | null;
  binary: boolean;
  /** 文件级指纹（没有旧侧：`-..` 开头）；没 stat 到就缺省 */
  fingerprint?: string;
}

/**
 * 读到内容后的摘要：行数 / 是否二进制 / 按 git blob 口径算的 oid。
 * 内容本来就要读进来数行数了，顺手算 oid：这样 `git add` / 提交之后 git 给出的 oid 与这里是同一个字符串
 * （旧侧「没有」统一写 `-`，见 attachFingerprints），「已查看」不会因此失效；
 * 行数与指纹取自同一份读到的内容，读的过程中文件被改写也不会互相矛盾。
 */
const summarizeUntracked = (buf: Buffer): UntrackedSummary => {
  const binary = isBinaryBuffer(buf);
  return { added: binary ? null : countLines(buf), binary, oid: shortOid(gitBlobOid(buf)) };
};

const statFromSummary = (s: UntrackedSummary): UntrackedStat => ({
  added: s.added,
  binary: s.binary,
  fingerprint: `-..${s.oid}`,
});

export interface UntrackedBatchResult {
  /** rel → 行数 / 二进制 / 指纹；没 stat 到（读失败、超出个数）的不一定在里面 */
  stats: Map<string, UntrackedStat>;
  /** 这次真正读盘读了多少字节（缓存命中的不算）——上限就是 budgetBytes */
  readBytes: number;
}

/**
 * 一批未跟踪文件的「行数 + 指纹」。轮询是 4 秒一次，所以读盘量必须有上限：
 * - 最多处理前 MAX_UNTRACKED_STAT_FILES 个，单个超过 MAX_UNTRACKED_STAT_BYTES 的不读；
 * - 没读内容的（超大 / 超出预算 / 非普通文件）退回「大小 + mtime」指纹、不数行；
 * - 磁盘状态没变的直接用缓存摘要（不占预算、预算耗尽了也照样完整显示）；
 * - 其余的按清单顺序消耗 budgetBytes（与已跟踪文件的哈希共用一份总预算，见 readRepoChanges），
 *   超出的退回——清单顺序固定，所以同样的输入永远读同样的一批，不会时有时无地抖。
 * 符号链接不跟随：指纹来自链接目标文本（readlink 很小，不占预算）。
 */
export const statUntrackedBatch = async (
  root: string,
  rels: readonly string[],
  opts: { budgetBytes?: number; cache?: HashCache } = {},
): Promise<UntrackedBatchResult> => {
  const budgetBytes = Math.max(0, opts.budgetBytes ?? MAX_HASH_TOTAL_BYTES);
  const cache = opts.cache ?? untrackedSummaryCache;
  const stats = new Map<string, UntrackedStat>();
  const considered = rels.slice(0, MAX_UNTRACKED_STAT_FILES);

  interface Pending extends HashCandidate {
    key: string;
    mtimeMs: number;
    ctimeMs: number;
    /** 没读内容时的指纹 */
    fallback: string;
  }
  const pending: Pending[] = [];
  await Promise.all(
    considered.map(async (rel) => {
      try {
        const abs = absoluteIn(root, rel);
        const st = await fs.lstat(abs);
        const fallback = `-..m${st.size}:${Math.trunc(st.mtimeMs)}`;
        if (st.isSymbolicLink()) {
          // git 把符号链接当一行（链接目标）；指纹用链接目标的 blob oid（不跟随链接）
          const target = await fs.readlink(abs, "buffer");
          stats.set(rel, { added: 1, binary: false, fingerprint: `-..${shortOid(gitBlobOid(target))}` });
        } else if (!st.isFile() || st.size > MAX_UNTRACKED_STAT_BYTES) {
          stats.set(rel, { added: null, binary: false, fingerprint: fallback });
        } else {
          const key = hashCacheKey(root, rel, st);
          const hit = cache.get(key);
          // 缓存里的值格式不对（被污染 / 版本变了）当没命中，重新读
          const summary = hit === undefined ? null : decodeUntrackedSummary(hit);
          if (summary) {
            stats.set(rel, statFromSummary(summary));
          } else {
            pending.push({ rel, size: st.size, key, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, fallback });
          }
        }
      } catch {
        // 读不到（刚被删 / 没权限）：不给指纹，前端退回「状态 + 行数」签名
        stats.set(rel, { added: null, binary: false });
      }
    }),
  );

  // 并发 lstat 的完成顺序不定：按清单顺序排好，预算裁剪才稳定
  const order = new Map(considered.map((rel, i) => [rel, i]));
  pending.sort((a, b) => (order.get(a.rel) ?? 0) - (order.get(b.rel) ?? 0));
  const plan = planHashing(pending, {
    maxFiles: MAX_UNTRACKED_STAT_FILES,
    maxFileBytes: MAX_UNTRACKED_STAT_BYTES,
    maxTotalBytes: budgetBytes,
  });
  const byRel = new Map(pending.map((p) => [p.rel, p]));
  for (const rel of plan.fallback) {
    const p = byRel.get(rel);
    if (p) stats.set(rel, { added: null, binary: false, fingerprint: p.fallback });
  }

  let readBytes = 0;
  await Promise.all(
    plan.hash.map(async (rel) => {
      const p = byRel.get(rel);
      if (!p) return;
      try {
        const buf = await fs.readFile(absoluteIn(root, rel));
        readBytes += buf.length;
        const summary = summarizeUntracked(buf);
        stats.set(rel, statFromSummary(summary));
        // 以「读盘前」的磁盘状态为键：读的过程中文件又被改写的话，新状态的 key 不同、不会误命中
        cache.set(p.key, encodeUntrackedSummary(summary), p.mtimeMs, p.ctimeMs);
      } catch {
        stats.set(rel, { added: null, binary: false });
      }
    }),
  );
  return { stats, readBytes };
};

/** 跨平台的仓内绝对路径（git 吐的是正斜杠相对路径） */
const absoluteIn = (base: string, rel: string): string =>
  path.join(base, ...rel.split("/"));

// ----------------- 文件级指纹（tracked 文件） -----------------

interface WorkingFingerprints {
  /** path → 新侧指纹串；取不到的不在里面 */
  fingerprints: Map<string, string>;
  /** 这次真正去读盘哈希了多少字节（缓存命中 / 退回的不算） */
  hashedBytes: number;
}

/**
 * 工作区里一批「有未暂存改动」的文件的新侧指纹。
 * git diff 对这类文件不给新侧哈希（oid 全零），这里补算：
 * - 普通文件：`git hash-object --no-filters`——只读（不带 -w：不写对象库）、不碰 index、
 *   --no-filters 不触发 clean 过滤器 / 换行转换这类外部程序；分批以免命令行过长；
 * - 符号链接：不跟随（hash-object 会去读链接指向的文件、可能在仓外），按链接目标文本算 blob oid；
 * - 目录（子模块）/ 超大 / 超出个数或字节预算：退回 `m<size>:<mtime>`；
 * - 磁盘状态（路径 + 大小 + mtime + ctime + inode）没变的文件直接用缓存、不重复读盘；
 *   每次真去哈希的个数与字节数都有上限（见 working-file-hash）——轮询是 4 秒一次，最坏情况不能是读几个 GB。
 * 前两种和 git 自己给的 oid 同口径、同字符串（见 gitBlobOid），所以不加任何前缀。
 * 返回每个文件的新侧指纹串（取不到的不在结果里）和这次实际读盘的字节数。
 */
const fingerprintWorkingFiles = async (
  root: string,
  rels: readonly string[],
  limits: HashLimits = DEFAULT_HASH_LIMITS,
): Promise<WorkingFingerprints> => {
  const out = new Map<string, string>();
  interface Pending extends HashCandidate {
    key: string;
    mtimeMs: number;
    ctimeMs: number;
    /** 退回时用的「大小:修改时间」 */
    meta: string;
  }
  const pending: Pending[] = [];
  await Promise.all(
    rels.map(async (rel) => {
      try {
        const abs = absoluteIn(root, rel);
        const st = await fs.lstat(abs);
        const meta = `m${st.size}:${Math.trunc(st.mtimeMs)}`;
        if (st.isSymbolicLink()) {
          out.set(rel, shortOid(gitBlobOid(await fs.readlink(abs, "buffer"))));
        } else if (!st.isFile()) {
          out.set(rel, meta);
        } else {
          const key = hashCacheKey(root, rel, st);
          const cached = workingHashCache.get(key);
          if (cached !== undefined) {
            out.set(rel, cached);
          } else {
            pending.push({ rel, size: st.size, key, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, meta });
          }
        }
      } catch {
        // 读不到（刚被删 / 没权限）：不给指纹，前端退回「状态 + 行数」签名
      }
    }),
  );

  // 并发 lstat 的完成顺序不定：按清单顺序排好，预算裁剪才稳定（同样的输入永远哈希同样的那一批）
  const order = new Map(rels.map((rel, i) => [rel, i]));
  pending.sort((a, b) => (order.get(a.rel) ?? 0) - (order.get(b.rel) ?? 0));
  const plan = planHashing(pending, limits);
  const byRel = new Map(pending.map((p) => [p.rel, p]));
  for (const rel of plan.fallback) {
    const p = byRel.get(rel);
    if (p) out.set(rel, p.meta);
  }

  const batches: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const rel of plan.hash) {
    if (cur.length > 0 && chars + rel.length + 1 > HASH_BATCH_CHARS) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(rel);
    chars += rel.length + 1;
  }
  if (cur.length > 0) batches.push(cur);

  await Promise.all(
    batches.map(async (batch) => {
      const r = await runGit(root, ["hash-object", "--no-filters", "--", ...batch]);
      const lines = r.stdout.split("\n").filter((l) => l.length > 0);
      // 行数对不上（某个文件读失败等）= 对应关系不可信，整批放弃
      if (!r.ok || lines.length !== batch.length) return;
      batch.forEach((rel, i) => {
        const oid = shortOid(lines[i]);
        out.set(rel, oid);
        // 以「读盘前」的磁盘状态为键缓存：读的过程中文件又被改写的话，新状态的 key 不同、不会误命中
        const p = byRel.get(rel);
        if (p) workingHashCache.set(p.key, oid, p.mtimeMs, p.ctimeMs);
      });
    }),
  );
  // 实际交给 hash-object 去读的字节数（缓存命中的没读）：未跟踪文件的读盘要从同一份总预算里扣
  const hashedBytes = plan.hash.reduce((n, rel) => n + (byRel.get(rel)?.size ?? 0), 0);
  return { fingerprints: out, hashedBytes };
};

/**
 * 给 tracked 文件挂上指纹（就地改）：`<旧侧 blob 前 12 位>..<新侧>`。
 * 新侧：已提交 / 已暂存的取 git 给的 blob oid；工作区有未暂存改动（oid 全零）的补算；已删除的是 `-`。
 * 返回补算时实际读盘的字节数（给未跟踪文件扣总预算用）。
 */
const attachFingerprints = async (
  root: string,
  files: TaskChangeFile[],
  raw: ReadonlyMap<string, RawEntry>,
): Promise<number> => {
  const needWorktree = files
    .filter((f) => {
      const e = raw.get(f.path);
      return !!e && f.status !== "deleted" && ZERO_OID.test(e.newOid);
    })
    .map((f) => f.path);
  const { fingerprints: worktree, hashedBytes } =
    needWorktree.length > 0
      ? await fingerprintWorkingFiles(root, needWorktree)
      : { fingerprints: new Map<string, string>(), hashedBytes: 0 };
  for (const f of files) {
    const e = raw.get(f.path);
    if (!e) continue;
    const newSide =
      f.status === "deleted"
        ? "-"
        : ZERO_OID.test(e.newOid)
          ? worktree.get(f.path)
          : shortOid(e.newOid);
    if (newSide === undefined) continue;
    // 旧侧没有（新增文件：git 给全零）统一写 `-`：与「还没 git add 的未跟踪文件」同一个字符串
    const oldSide = ZERO_OID.test(e.oldOid) ? "-" : shortOid(e.oldOid);
    f.fingerprint = `${oldSide}..${newSide}`;
  }
  return hashedBytes;
};

// ----------------- 列表 -----------------

const emptyTotals = () => ({ files: 0, added: 0, removed: 0 });

/** 读改动清单 / 单文件 diff 共用的查询选项 */
export interface ReadChangesOptions {
  /** 看哪一段改动；缺省 = branch（整条分支相对线上分支，含未提交） */
  scope?: TaskChangeScope;
  /** 手动指定的对比基线（分支名，不带 origin/）；缺省 = 自动探测 */
  baseRef?: string | null;
  /** 忽略空白（git diff -w） */
  ignoreWs?: boolean;
}

/** 读一个仓相对基线的改动清单（不含 patch、很轻） */
export const readRepoChanges = async (
  target: ChangeRepoTarget,
  task: TaskChangesTaskLike,
  opts: ReadChangesOptions = {},
): Promise<TaskRepoChanges> => {
  const { repoPath, shortName, workDir, isolated } = target;
  const scope = opts.scope ?? { kind: "branch" };
  const unavailable = (
    reason: NonNullable<TaskRepoChanges["unavailable"]>,
    extra?: Partial<TaskRepoChanges>,
  ): TaskRepoChanges => ({
    repoPath,
    shortName,
    workDir,
    isolated,
    unavailable: reason,
    branch: null,
    base: null,
    files: [],
    totals: emptyTotals(),
    scope: scope.kind,
    ...extra,
  });

  if (!(await dirExists(workDir))) return unavailable("dir_missing");

  // 工作目录可能是仓库的子目录（chat）：之后 git 一律在仓库根里跑、绝对路径也以它为基准。
  // 返回给前端的 workDir 仍是用户选的目录
  const root = await resolveRepoRoot(workDir);
  if (!root) return unavailable("not_git");

  const sc = await resolveScope(root, task, repoPath, scope, opts.baseRef);
  if (!sc.ok) return unavailable(sc.reason);
  const { revs, includeUntracked, base: shownBase, resolved } = sc.value;

  const diffArgs = (...flags: string[]) => [
    "--literal-pathspecs",
    "diff",
    ...flags,
    "-z",
    "-M",
    "--no-ext-diff",
    // 与单文件 diff 同一组格式开关（防御性）：实测 textconv 只影响 patch 文本、不改变 numstat / name-status / raw，
    // 但清单与单文件走同一组参数，口径就不会因 git 版本 / 配置差异而分叉，也不会去执行用户配的 textconv 外部命令
    "--no-textconv",
    // 注意：这里不带 -w。-w 只给 numstat（见下）——name-status / raw 必须是「完整清单」，不能随忽略空白而变
    ...revs,
    "--",
  ];
  const [branch, nameStatus, numstat, rawRun, untrackedRun, counts] = await Promise.all([
    readBranchName(root),
    runGit(root, diffArgs("--name-status")),
    // -w 只加在 numstat 上：清单（name-status）与指纹（raw）一律不带。较新的 git（实测 2.54.0）在 -w 下会把
    // 「只改了空白」的文件从 name-status / raw 里整行省略（2.42.0 不会）——清单里这些文件就凭空消失，
    // 「仅空白改动」的标记也就没有了。numstat 里缺的那些 = 只改了空白，由下面的 wsOnly 补上
    runGit(root, diffArgs("--numstat", ...(opts.ignoreWs ? ["-w"] : []))),
    // 两侧 blob 的 oid：文件级指纹用。读失败不影响清单（只是没有指纹、前端退回行数签名）
    runGit(root, diffArgs("--raw", "--no-abbrev")),
    includeUntracked
      ? runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])
      : Promise.resolve(null),
    resolved.kind === "merge-base" && resolved.ref
      ? readAheadBehind(root, resolved.ref)
      : Promise.resolve(null),
  ]);
  // tracked 部分是主体：读不出来就整仓报错（不给半截清单误导）
  if (!nameStatus.ok || !numstat.ok) return unavailable("git_error", { branch });

  const stats = parseNumstatZ(numstat.stdout);
  const files: TaskChangeFile[] = parseNameStatusZ(nameStatus.stdout).map((e) => {
    const s = stats.get(e.path);
    // name-status 不带 -w、是完整清单；numstat 带 -w 时会把「只改了空白」的文件整行省略——
    // 不特殊处理会被当成「没统计到 = 二进制 / 过大」，这里明确标成「仅空白」、行数记 0
    const wsOnly = opts.ignoreWs === true && s === undefined;
    return {
      path: e.path,
      ...(e.oldPath ? { oldPath: e.oldPath } : {}),
      status: e.status,
      added: s?.added ?? (wsOnly ? 0 : null),
      removed: s?.removed ?? (wsOnly ? 0 : null),
      binary: s?.binary ?? false,
      untracked: false,
      absolutePath: absoluteIn(root, e.path),
      ...(wsOnly ? { whitespaceOnly: true } : {}),
    };
  });
  // 已跟踪文件补算哈希读了多少字节：下面未跟踪文件的读盘与它共用同一份总预算（MAX_HASH_TOTAL_BYTES）
  const trackedHashedBytes = rawRun.ok
    ? await attachFingerprints(root, files, parseRawZ(rawRun.stdout))
    : 0;

  // 未跟踪文件：git diff 看不到、单独补。清单读失败 / 超限只标 skipped、不拖垮整仓。
  // 没请求（看单个提交时没有「未跟踪」的概念）就既不读、也不标 skipped
  const untrackedSkipped = untrackedRun !== null && !untrackedRun.ok;
  if (untrackedRun?.ok) {
    const trackedPaths = new Set(files.map((f) => f.path));
    const untracked = parseNulList(untrackedRun.stdout).filter(
      (p) => !trackedPaths.has(p),
    );
    // 读盘有预算：与已跟踪文件的哈希共用 MAX_HASH_TOTAL_BYTES，已跟踪的先用、剩下的给未跟踪；
    // 嵌套仓库项（以 `/` 结尾）不读盘、也不占「最多处理多少个」的额度
    const { stats: untrackedStats } = await statUntrackedBatch(
      root,
      untracked.filter((p) => !p.endsWith("/")),
      { budgetBytes: Math.max(0, MAX_HASH_TOTAL_BYTES - trackedHashedBytes) },
    );
    const counted = untracked.map((p): TaskChangeFile => {
      // git 看不进去的目录（里面自带 .git 的嵌套仓库）会整个以 `dir/` 的形式列出：
      // 规范成不带尾斜杠的一项并标注；不读它里面的任何东西，也没有 diff 可看
      if (p.endsWith("/")) {
        const rel = p.replace(/\/+$/, "");
        return {
          path: rel,
          status: "added",
          added: null,
          removed: 0,
          binary: false,
          untracked: true,
          absolutePath: absoluteIn(root, rel),
          nestedRepo: true,
        };
      }
      // 超出个数 / 读失败的：只标「新文件」、不数行
      const s: UntrackedStat = untrackedStats.get(p) ?? { added: null, binary: false };
      return {
        path: p,
        status: "added",
        added: s.added,
        removed: s.binary ? null : 0,
        binary: s.binary,
        untracked: true,
        absolutePath: absoluteIn(root, p),
        ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}),
      };
    });
    files.push(...counted);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const totals = files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      added: acc.added + (f.added ?? 0),
      removed: acc.removed + (f.removed ?? 0),
    }),
    emptyTotals(),
  );
  const filesTruncated = files.length > MAX_CHANGE_FILES;
  // 当前就在线上分支本身上：没有「分支上的提交」可看、只会有未提交 / 未推送的改动（UI 据此说明）
  const onBaseBranch =
    resolved.kind === "merge-base" && branch !== null && branch === resolved.baseName;

  return {
    repoPath,
    shortName,
    workDir,
    isolated,
    branch,
    base: shownBase,
    files: filesTruncated ? files.slice(0, MAX_CHANGE_FILES) : files,
    totals,
    scope: scope.kind,
    ...(onBaseBranch ? { onBaseBranch: true } : {}),
    ...(counts ? { aheadOfBase: counts.ahead, behindBase: counts.behind } : {}),
    ...(resolved.override ? { baseOverride: resolved.override } : {}),
    ...(filesTruncated ? { filesTruncated: true } : {}),
    ...(untrackedSkipped ? { untrackedSkipped: true } : {}),
  };
};

/** 本任务全部仓的改动清单（各仓并行、互不影响） */
const readTaskChangesNow = async (
  task: TaskChangesTaskLike,
  opts: ReadChangesOptions,
): Promise<TaskChanges> => {
  const repos = await Promise.all(
    resolveChangeRepoTargets(task).map((t) => readRepoChanges(t, task, opts)),
  );
  const totals = repos.reduce(
    (acc, r) => ({
      files: acc.files + r.totals.files,
      added: acc.added + r.totals.added,
      removed: acc.removed + r.totals.removed,
    }),
    emptyTotals(),
  );
  return { repos, totals };
};

/**
 * 同一份请求并发时合并成一次实际读取（single-flight）。
 *
 * 大仓里一次清单要跑十来个 git 子进程，而触发源很多：4 秒轮询、窗口聚焦、切分支事件、多个窗口……
 * 客户端会尽量不并发，但服务端不能指望它：请求被客户端取消后服务端这一份仍在跑，
 * 下一个请求再起一份就开始堆积。key = 任务的「定位 + 基线配置」+ 范围 + 手动基线 + 忽略空白——
 * 这些都相同，读到的结果就一定相同。读完立刻摘掉（不缓存结果：磁盘随时在变，只合并「正在跑的」）。
 */
const inflightChanges = new Map<string, Promise<TaskChanges>>();

const changesFlightKey = (task: TaskChangesTaskLike, opts: ReadChangesOptions): string =>
  JSON.stringify([
    task.mode ?? null,
    task.workCwd ?? null,
    task.repoPaths,
    task.isolateWorktree ?? null,
    task.nonGitRepoPaths ?? null,
    task.readonlyRepoPaths ?? null,
    task.gitBranches?.map((b) => [b.repoPath, b.baseBranch]) ?? null,
    task.repoBaseBranches ?? null,
    formatChangeScope(opts.scope ?? { kind: "branch" }),
    opts.baseRef ?? null,
    opts.ignoreWs === true,
  ]);

export const readTaskChanges = (
  task: TaskChangesTaskLike,
  opts: ReadChangesOptions = {},
): Promise<TaskChanges> => {
  const key = changesFlightKey(task, opts);
  const running = inflightChanges.get(key);
  if (running) return running;
  const p: Promise<TaskChanges> = readTaskChangesNow(task, opts).finally(() => {
    if (inflightChanges.get(key) === p) inflightChanges.delete(key);
  });
  inflightChanges.set(key, p);
  return p;
};

// ----------------- 单文件 diff -----------------

export type FileDiffResult =
  | { ok: true; data: TaskChangeFileDiff }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/** 按行截断到字节上限（不切半行），返回是否发生了截断 */
const clampDiffText = (text: string): { text: string; truncated: boolean } => {
  if (Buffer.byteLength(text, "utf8") <= MAX_FILE_DIFF_BYTES) {
    return { text, truncated: false };
  }
  const cut = Buffer.from(text, "utf8")
    .subarray(0, MAX_FILE_DIFF_BYTES)
    .toString("utf8");
  const lastNl = cut.lastIndexOf("\n");
  return { text: lastNl > 0 ? cut.slice(0, lastNl) : cut, truncated: true };
};

/**
 * 把一个未跟踪的新文件合成 unified diff（全是 + 行）。
 * 不用 git add -N / --no-index：前者要写 index，后者每个文件多一次 spawn 且 Windows 上 /dev/null 不稳。
 */
const synthesizeNewFileDiff = async (
  root: string,
  rel: string,
): Promise<TaskChangeFileDiff> => {
  const abs = absoluteIn(root, rel);
  // 兜底：父目录真实路径必须还在仓库根里（未跟踪清单已验证过、这里防符号链接目录逃逸）
  const [realDir, realRoot] = await Promise.all([
    fs.realpath(path.dirname(abs)),
    fs.realpath(root),
  ]);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    return { diff: "", truncated: false, binary: false };
  }

  const st = await fs.lstat(abs);
  const header = [
    `diff --git a/${rel} b/${rel}`,
    `new file mode ${st.isSymbolicLink() ? "120000" : "100644"}`,
    "--- /dev/null",
    `+++ b/${rel}`,
  ];

  let text: string;
  let truncated = false;
  if (st.isSymbolicLink()) {
    text = `${await fs.readlink(abs)}\n`;
  } else {
    const fh = await fs.open(abs, "r");
    try {
      const size = (await fh.stat()).size;
      const len = Math.min(size, MAX_FILE_DIFF_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      if (isBinaryBuffer(buf)) return { diff: "", truncated: false, binary: true };
      truncated = size > MAX_FILE_DIFF_BYTES;
      text = buf.toString("utf8");
      if (truncated) {
        const lastNl = text.lastIndexOf("\n");
        if (lastNl > 0) text = text.slice(0, lastNl + 1);
      }
    } finally {
      await fh.close();
    }
  }

  const endsWithNl = text.endsWith("\n");
  // 空文件没有任何行（"".split 会给出 [""]、不能当成一行空行）
  const lines = text === "" ? [] : text.split("\n");
  if (endsWithNl) lines.pop();
  const body: string[] = [];
  if (lines.length > 0) {
    body.push(`@@ -0,0 +1,${lines.length} @@`);
    for (const l of lines) body.push(`+${l}`);
    if (!endsWithNl && !truncated) body.push("\\ No newline at end of file");
  }
  // 上限以「返回的 diff 文本」为准：读入的原文已限过，但每行的 `+` 前缀和文件头会再撑大一点
  const clamped = clampDiffText([...header, ...body].join("\n"));
  return {
    diff: clamped.text,
    truncated: truncated || clamped.truncated,
    binary: false,
    // 新文件的 diff 本来就是整个文件：前端不用再「展开上下文」
    fullContext: true,
  };
};

/**
 * 读某个文件相对基线的 unified diff。
 * repoPath 必须属于本任务可看的仓；filePath / oldPath 必须是仓内相对路径。
 */
export interface ReadFileDiffOptions extends ReadChangesOptions {
  /** 拉整文件内容（-U1000000）：给「展开上下文」用；缺省 -U3 */
  fullContext?: boolean;
}

export const readTaskChangeFileDiff = async (
  task: TaskChangesTaskLike,
  repoPath: string,
  filePath: string,
  oldPath?: string | null,
  opts: ReadFileDiffOptions = {},
): Promise<FileDiffResult> => {
  const scope = opts.scope ?? { kind: "branch" };
  const target = resolveChangeRepoTargets(task).find((t) => t.repoPath === repoPath);
  if (!target) return { ok: false, status: 404, error: "仓库不在本任务的改动范围内" };
  const rel = sanitizeRepoRelPath(filePath);
  if (!rel) return { ok: false, status: 400, error: "非法的文件路径" };
  let oldRel: string | null = null;
  if (oldPath) {
    oldRel = sanitizeRepoRelPath(oldPath);
    if (!oldRel) return { ok: false, status: 400, error: "非法的旧文件路径" };
  }
  const { workDir } = target;
  if (!(await dirExists(workDir))) {
    return { ok: false, status: 404, error: "工作区目录不存在（任务未启动或已清理）" };
  }
  // 路径（rel / oldRel）相对仓库根——工作目录可能是子目录（chat），git 与文件读取都以仓库根为准
  const root = await resolveRepoRoot(workDir);
  if (!root) return { ok: false, status: 404, error: "该目录不是 git 仓库" };

  try {
    // 未跟踪（只有工作区视角的范围才有这个概念；看单个提交时跳过）：
    // 必须确实在「未跟踪且未被 ignore」清单里才读盘（防止借这个接口读 .env 之类被忽略的文件）
    if (scope.kind !== "commit") {
      const untracked = await runGit(root, [
        "--literal-pathspecs",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        rel,
      ]);
      if (untracked.ok && parseNulList(untracked.stdout).includes(rel)) {
        return { ok: true, data: await synthesizeNewFileDiff(root, rel) };
      }
    }

    const sc = await resolveScope(root, task, repoPath, scope, opts.baseRef);
    if (!sc.ok) {
      return sc.reason === "no_head"
        ? { ok: false, status: 404, error: "仓库还没有任何提交" }
        : { ok: false, status: 409, error: "所选提交已不在当前分支上，请刷新后重选" };
    }

    const r = await runGit(
      root,
      [
        "--literal-pathspecs",
        "diff",
        "--no-color",
        "--no-ext-diff",
        // 输出格式不受用户全局 git 配置影响：textconv（会把二进制 / 文档转成文本再比）、
        // diff.noprefix / mnemonicPrefix（改文件头的 a/ b/ 前缀）都固定掉，解析才稳
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `-U${opts.fullContext ? FULL_CONTEXT_LINES : 3}`,
        "-M",
        ...(opts.ignoreWs ? ["-w"] : []),
        ...sc.value.revs,
        "--",
        ...(oldRel ? [oldRel] : []),
        rel,
      ],
      { maxBuffer: MAX_FILE_DIFF_BUFFER, timeoutMs: 30_000 },
    );
    if (r.overflow) {
      return {
        ok: true,
        data: { diff: "", truncated: false, binary: false, tooLarge: true },
      };
    }
    if (!r.ok) return { ok: false, status: 500, error: "读取 diff 失败" };

    if (/^Binary files .* differ$/m.test(r.stdout) || r.stdout.includes("GIT binary patch")) {
      return { ok: true, data: { diff: "", truncated: false, binary: true } };
    }
    const clamped = clampDiffText(r.stdout);
    return {
      ok: true,
      data: {
        diff: clamped.text,
        truncated: clamped.truncated,
        binary: false,
        ...(opts.fullContext ? { fullContext: true } : {}),
      },
    };
  } catch (err) {
    console.warn(
      `[task-changes] 读取文件 diff 失败 repo=${repoPath} file=${rel}：${(err as Error).message}`,
    );
    return { ok: false, status: 500, error: "读取 diff 失败" };
  }
};

// ----------------- 分支提交列表 -----------------

/**
 * 解析 `git log --format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e` 的输出（%P = 全部父提交、空格分隔；多于一个 = 合并提交）。
 * 用控制字符分隔（提交主题 / 作者名里不会出现），记录之间 git 还会补一个换行、解析时去掉。
 * 不合规的记录（sha 不是十六进制等）静默丢弃——宁可少一条也不让一条坏数据拖垮整个列表。
 */
export const parseCommitLog = (out: string): TaskRepoCommit[] => {
  const commits: TaskRepoCommit[] = [];
  for (const rec of out.split("\x1e")) {
    const body = rec.replace(/^\s+/, "");
    if (!body) continue;
    const [sha = "", parents = "", author = "", at = "", ...rest] = body.split("\x1f");
    if (!SHA_RE.test(sha)) continue;
    const ts = Number(at);
    const parentCount = parents.trim() === "" ? 0 : parents.trim().split(/\s+/).length;
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      subject: rest.join("\x1f").trim().slice(0, 300),
      author: author.slice(0, 100),
      ts: Number.isFinite(ts) ? ts : 0,
      ...(parentCount > 1 ? { isMerge: true } : {}),
    });
  }
  return commits;
};

const readRepoCommits = async (
  target: ChangeRepoTarget,
  task: TaskChangesTaskLike,
  opts: Pick<ReadChangesOptions, "baseRef">,
): Promise<TaskRepoCommitList> => {
  const { repoPath, shortName, workDir } = target;
  const empty = (unavailable?: TaskRepoCommitList["unavailable"]): TaskRepoCommitList => ({
    repoPath,
    shortName,
    base: null,
    commits: [],
    ...(unavailable ? { unavailable } : {}),
  });

  if (!(await dirExists(workDir))) return empty("dir_missing");
  const root = await resolveRepoRoot(workDir);
  if (!root) return empty("not_git");

  const resolved = await resolveBase(root, task, repoPath, opts.baseRef);
  if (!resolved) return empty("no_head");
  const base = toBase(resolved);
  // 找不到线上分支就界定不了「分支上的提交」——不拿整段历史凑数
  if (resolved.kind !== "merge-base") return { ...empty("no_base"), base };

  const r = await runGit(root, [
    "log",
    // 用户全局开了 log.showSignature 时，git 会把签名校验文字插进输出、破坏下面的解析
    "--no-show-signature",
    `--max-count=${MAX_COMMITS + 1}`,
    "--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e",
    `${resolved.sha}..HEAD`,
    "--",
  ]);
  if (!r.ok) return { ...empty("git_error"), base };

  const all = parseCommitLog(r.stdout);
  const truncated = all.length > MAX_COMMITS;
  return {
    repoPath,
    shortName,
    base,
    commits: truncated ? all.slice(0, MAX_COMMITS) : all,
    ...(truncated ? { truncated: true } : {}),
  };
};

/** 本任务 / 会话各仓「基线之后的提交」列表（新到旧；范围选择器里点单个提交看它自己的改动用） */
export const readTaskChangeCommits = async (
  task: TaskChangesTaskLike,
  opts: Pick<ReadChangesOptions, "baseRef"> = {},
): Promise<TaskChangeCommits> => ({
  repos: await Promise.all(
    resolveChangeRepoTargets(task).map((t) => readRepoCommits(t, task, opts)),
  ),
});
