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
 * 约束：
 * - 全程只读：GIT_OPTIONAL_LOCKS=0（git diff 默认会机会性刷新 index、与 agent 的 git 操作抢 index.lock）；
 *   不 git add -N、不碰 index——未跟踪文件的 diff 由我们自己合成。
 * - execFile（不走 shell、无注入面）；路径一律在 `--` 之后并开 --literal-pathspecs。
 * - 工作目录从 task 权威数据算（接口不接受前端传任意路径）；非 git / 只读仓不出现（它们不会被改）。
 * - best-effort：单个仓失败只让该仓带 unavailable、不影响其他仓。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { getRepoWorkDirs } from "../path-utils";
import type {
  GitBranchInfo,
  TaskChangeFile,
  TaskChangeFileDiff,
  TaskChanges,
  TaskChangeStatus,
  TaskMode,
  TaskRepoChangeBase,
  TaskRepoChanges,
} from "../types";

const execFileAsync = promisify(execFile);

// ----------------- 上限（大 diff / 海量文件的兜底） -----------------

/** 单次列表最多返回的文件数；超出只列前面这些、totals 仍按全量算 */
export const MAX_CHANGE_FILES = 500;
/** 未跟踪文件最多逐个读取统计行数的个数（再多的只标「新文件」、不数行） */
const MAX_UNTRACKED_STAT_FILES = 200;
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
 * - chat / 还没启动（没有 workCwd）→ 没有
 * - 非 git、只读仓被剔掉（不会被改、也没有 git 可读）
 * - workDir 与 branches 接口 / IDE 打开同源（getRepoWorkDirs）
 */
export const resolveChangeRepoTargets = (
  task: TaskChangesTaskLike,
): ChangeRepoTarget[] => {
  if (task.mode === "chat" || !task.workCwd || task.repoPaths.length === 0) {
    return [];
  }
  const nonGit = new Set(task.nonGitRepoPaths ?? []);
  const readonly = new Set(task.readonlyRepoPaths ?? []);
  const isolated = task.isolateWorktree === true;
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

// ----------------- 基线解析 -----------------

interface ResolvedBase extends TaskRepoChangeBase {
  sha: string;
  /** 命中的线上分支名（不带 origin/）；降级成 HEAD 时没有 */
  baseName?: string;
}

const SHA_RE = /^[0-9a-f]{40,64}$/;

/** 线上分支候选（去重、按优先级）：任务记录 > 设置页快照 > origin/HEAD */
const baseBranchCandidates = async (
  dir: string,
  task: TaskChangesTaskLike,
  repoPath: string,
): Promise<string[]> => {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    const v = raw?.trim();
    if (v && isSafeRefName(v) && !out.includes(v)) out.push(v);
  };
  push(task.gitBranches?.find((b) => b.repoPath === repoPath)?.baseBranch);
  push(task.repoBaseBranches?.[repoPath]);
  const head = await runGit(dir, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (head.ok) push(head.stdout.trim().replace(/^origin\//, ""));
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
): Promise<ResolvedBase | null> => {
  const head = await runGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const headSha = head.stdout.trim();
  if (!head.ok || !SHA_RE.test(headSha)) return null;

  for (const name of await baseBranchCandidates(dir, task, repoPath)) {
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
        };
      }
    }
  }
  return { kind: "head", label: "HEAD", sha: headSha, shortSha: headSha.slice(0, 7) };
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

const statUntrackedFile = async (
  abs: string,
): Promise<{ added: number | null; binary: boolean }> => {
  try {
    const st = await fs.lstat(abs);
    // 符号链接：git 把它当一行（链接目标）
    if (st.isSymbolicLink()) return { added: 1, binary: false };
    if (!st.isFile() || st.size > MAX_UNTRACKED_STAT_BYTES) {
      return { added: null, binary: false };
    }
    const buf = await fs.readFile(abs);
    if (isBinaryBuffer(buf)) return { added: null, binary: true };
    return { added: countLines(buf), binary: false };
  } catch {
    return { added: null, binary: false };
  }
};

/** 跨平台的仓内绝对路径（git 吐的是正斜杠相对路径） */
const absoluteIn = (workDir: string, rel: string): string =>
  path.join(workDir, ...rel.split("/"));

// ----------------- 列表 -----------------

const emptyTotals = () => ({ files: 0, added: 0, removed: 0 });

/** 读一个仓相对基线的改动清单（不含 patch、很轻） */
export const readRepoChanges = async (
  target: ChangeRepoTarget,
  task: TaskChangesTaskLike,
): Promise<TaskRepoChanges> => {
  const { repoPath, shortName, workDir, isolated } = target;
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
    ...extra,
  });

  if (!(await dirExists(workDir))) return unavailable("dir_missing");

  const inside = await runGit(workDir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return unavailable("not_git");

  const base = await resolveBase(workDir, task, repoPath);
  if (!base) return unavailable("no_head");

  const diffArgs = (flag: string) => [
    "--literal-pathspecs",
    "diff",
    flag,
    "-z",
    "-M",
    "--no-ext-diff",
    base.sha,
    "--",
  ];
  const [branch, nameStatus, numstat, untrackedRun] = await Promise.all([
    readBranchName(workDir),
    runGit(workDir, diffArgs("--name-status")),
    runGit(workDir, diffArgs("--numstat")),
    runGit(workDir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  // tracked 部分是主体：读不出来就整仓报错（不给半截清单误导）
  if (!nameStatus.ok || !numstat.ok) return unavailable("git_error", { branch });

  const stats = parseNumstatZ(numstat.stdout);
  const files: TaskChangeFile[] = parseNameStatusZ(nameStatus.stdout).map((e) => {
    const s = stats.get(e.path);
    return {
      path: e.path,
      ...(e.oldPath ? { oldPath: e.oldPath } : {}),
      status: e.status,
      added: s?.added ?? null,
      removed: s?.removed ?? null,
      binary: s?.binary ?? false,
      untracked: false,
      absolutePath: absoluteIn(workDir, e.path),
    };
  });

  // 未跟踪文件：git diff 看不到、单独补。清单读失败 / 超限只标 skipped、不拖垮整仓
  const untrackedSkipped = !untrackedRun.ok;
  if (untrackedRun.ok) {
    const trackedPaths = new Set(files.map((f) => f.path));
    const untracked = parseNulList(untrackedRun.stdout).filter(
      (p) => !trackedPaths.has(p),
    );
    const counted = await Promise.all(
      untracked.map(async (p, idx) => {
        const abs = absoluteIn(workDir, p);
        const s =
          idx < MAX_UNTRACKED_STAT_FILES
            ? await statUntrackedFile(abs)
            : { added: null, binary: false };
        const file: TaskChangeFile = {
          path: p,
          status: "added",
          added: s.added,
          removed: s.binary ? null : 0,
          binary: s.binary,
          untracked: true,
          absolutePath: abs,
        };
        return file;
      }),
    );
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
    base.kind === "merge-base" && branch !== null && branch === base.baseName;

  return {
    repoPath,
    shortName,
    workDir,
    isolated,
    branch,
    base: { kind: base.kind, label: base.label, shortSha: base.shortSha },
    files: filesTruncated ? files.slice(0, MAX_CHANGE_FILES) : files,
    totals,
    ...(onBaseBranch ? { onBaseBranch: true } : {}),
    ...(filesTruncated ? { filesTruncated: true } : {}),
    ...(untrackedSkipped ? { untrackedSkipped: true } : {}),
  };
};

/** 本任务全部仓的改动清单（各仓并行、互不影响） */
export const readTaskChanges = async (
  task: TaskChangesTaskLike,
): Promise<TaskChanges> => {
  const repos = await Promise.all(
    resolveChangeRepoTargets(task).map((t) => readRepoChanges(t, task)),
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

// ----------------- 单文件 diff -----------------

export type FileDiffResult =
  | { ok: true; data: TaskChangeFileDiff }
  | { ok: false; status: 400 | 404 | 500; error: string };

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
  workDir: string,
  rel: string,
): Promise<TaskChangeFileDiff> => {
  const abs = absoluteIn(workDir, rel);
  // 兜底：父目录真实路径必须还在工作目录里（未跟踪清单已验证过、这里防符号链接目录逃逸）
  const [realDir, realRoot] = await Promise.all([
    fs.realpath(path.dirname(abs)),
    fs.realpath(workDir),
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
  };
};

/**
 * 读某个文件相对基线的 unified diff。
 * repoPath 必须属于本任务可看的仓；filePath / oldPath 必须是仓内相对路径。
 */
export const readTaskChangeFileDiff = async (
  task: TaskChangesTaskLike,
  repoPath: string,
  filePath: string,
  oldPath?: string | null,
): Promise<FileDiffResult> => {
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

  try {
    // 未跟踪：必须确实在「未跟踪且未被 ignore」清单里才读盘（防止借这个接口读 .env 之类被忽略的文件）
    const untracked = await runGit(workDir, [
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      rel,
    ]);
    if (untracked.ok && parseNulList(untracked.stdout).includes(rel)) {
      return { ok: true, data: await synthesizeNewFileDiff(workDir, rel) };
    }

    const base = await resolveBase(workDir, task, repoPath);
    if (!base) return { ok: false, status: 404, error: "仓库还没有任何提交" };

    const r = await runGit(
      workDir,
      [
        "--literal-pathspecs",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-U3",
        "-M",
        base.sha,
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
      data: { diff: clamped.text, truncated: clamped.truncated, binary: false },
    };
  } catch (err) {
    console.warn(
      `[task-changes] 读取文件 diff 失败 repo=${repoPath} file=${rel}：${(err as Error).message}`,
    );
    return { ok: false, status: 500, error: "读取 diff 失败" };
  }
};
