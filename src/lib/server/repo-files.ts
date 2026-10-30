/**
 * 仓库文件模糊索引（chat / task composer `@` 引用）
 *
 * 按 root 扫相对路径清单，模块级（挂 globalThis）60s TTL + in-flight 去重——
 * Next dev 多 chunk 下纯 module Map 会分裂，跟 task-fs / settings-fs 同构。
 *
 * 索引来源（R14 B6-5 / Q21-01）：
 *  1. 优先 `git ls-files -co --exclude-standard -z`：只看 git 认为属于这个仓的路径，**任意名字**的被 .gitignore 的大目录
 *     （`aaa-cache/`、`.nuxt/`、`DerivedData/`……）根本不会被遍历，不再吃光额度；再用 `--deleted` 扣掉
 *     「已跟踪但工作区已删」的旧路径（`rm` / 改名后还没 stage，`--cached` 会一直列着）；
 *  2. 不是 git 仓 / git 起不来（没装、没同意 Xcode license、超时、输出超容量、输出为空）/ 根上有 `.gitmodules`
 *     （子模块里的文件 git 这条路看不到）→ 退回「浅层优先」的目录遍历（BFS），可见集与改前一致。
 * 两条路都以 {@link REPO_FILES_MAX_ENTRIES} 为上限；超限时丢最深的、并带 `truncated`，一路透传到菜单的提示。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { getUniqueRepoDirNames } from "@/lib/path-utils";
import {
  REPO_FILES_MAX_ENTRIES,
  REPO_FILES_Q_MAX_LEN,
  REPO_FILES_RESULT_LIMIT,
} from "@/lib/repo-files-shared";
import { gitEnv } from "@/lib/server/git-exec";

export { REPO_FILES_MAX_ENTRIES, REPO_FILES_Q_MAX_LEN, REPO_FILES_RESULT_LIMIT };

const execFileAsync = promisify(execFile);

/** 扫仓时跳过的目录名（常见构建 / 依赖 / VCS 噪音） */
export const REPO_SCAN_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "out",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "Pods",
  ".pnpm-store",
  ".yarn",
  "tmp",
  "temp",
  ".idea",
  ".vscode",
  // R14 B6-5 补：框架 / 工具链的缓存与产物目录。体积大、名字又常排在 `src` 前面，
  // 改前遍历会被它们吃光额度、`src/` 一条都收不到（Q21-01）
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".gradle",
  ".dart_tool",
  ".terraform",
  "DerivedData",
  ".angular",
  ".parcel-cache",
  ".expo",
  ".vite",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
]);

const CACHE_TTL_MS = 60_000;
/**
 * V3：bucket 多存 `truncated`、in-flight 的值从数组变成 `{ entries, truncated }`。
 * 挂 globalThis 防 Next dev 多 chunk 分裂；换键 = 热更新后旧形状的缓存不会被新代码读到。
 * （V2：加 inFlight，避免首次扫描未完成时并发重复扫仓）
 */
const CACHE_KEY = "__flowshipRepoFilesCacheV3__";

/** `git ls-files` 的整体超时：大仓冷缓存下也够用；超时按「git 这条路不通」退回目录遍历 */
const GIT_LS_TIMEOUT_MS = 10_000;
/**
 * `git ls-files` 的输出容量上限。不用共享的 `GIT_MAX_BUFFER`（256MiB）：这条路在每个仓每 60s 一次的热路径上，
 * 输出只是路径清单；超过 64MiB 说明仓大到 2 万额度本来就覆盖不了，直接当失败走目录遍历（它有早停，成本有界）。
 */
const GIT_LS_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `git ls-files` 的参数：已跟踪 + 未跟踪（`--exclude-standard` 去掉被 .gitignore 命中的），NUL 分隔（路径不转义）。
 * 另给每个 denylist 目录名一个 `--exclude=<名>/`：它只剪未跟踪文件的遍历——
 * 新仓还没有 .gitignore 时，没有它 `node_modules/` 会被整个扫进来拖垮这一次调用。
 * 已跟踪的文件不受 `--exclude` 影响，由 {@link entriesFromPaths} 按路径段过滤。
 */
const GIT_LS_FILES_ARGS: string[] = [
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
  ...[...REPO_SCAN_IGNORE_DIRS].map((d) => `--exclude=${d}/`),
];
/**
 * 「已跟踪、但工作区里已经不在」的清单（`rm` / 改名后还没 `git add`）。`--cached` 会一直列着这些旧路径，
 * 直到用户 stage 或提交——不扣掉的话 `@` 菜单里会长期挂着早已不存在的文件。干净仓输出为空，是正常情形。
 */
const GIT_LS_DELETED_ARGS: string[] = ["ls-files", "-z", "--deleted"];

export interface RepoFileEntry {
  /** 插入 `@` token 的相对路径；目录以 `/` 结尾 */
  path: string;
  isDir: boolean;
}

/** 一次建索引的结果：`truncated` = 仓里还有条目没收进来（超过 {@link REPO_FILES_MAX_ENTRIES}） */
export interface RepoIndexResult {
  entries: RepoFileEntry[];
  truncated: boolean;
}

interface CacheBucket extends RepoIndexResult {
  cachedAt: number;
}

interface RepoFilesCache {
  buckets: Map<string, CacheBucket>;
  /** 同一 root 扫描进行中时复用同一 Promise，避免并发翻倍扫盘 */
  inFlight: Map<string, Promise<RepoIndexResult>>;
}

const getCache = (): RepoFilesCache => {
  const g = globalThis as unknown as Record<string, RepoFilesCache | undefined>;
  if (!g[CACHE_KEY]) {
    g[CACHE_KEY] = { buckets: new Map(), inFlight: new Map() };
  }
  return g[CACHE_KEY]!;
};

/** 归一化 root 键：绝对路径 + 去尾 slash，缓存 / 越权比对共用 */
export const normalizeRepoRoot = (root: string): string =>
  path.resolve(root).replace(/[/\\]+$/, "");

/**
 * 递归扫 root，产出相对路径列表（目录带尾 `/`）。
 * 跳过 REPO_SCAN_IGNORE_DIRS；不跟随 symlink，防环。
 *
 * **浅层优先（BFS）**：一层走完再走下一层。额度用完时丢的是最深的那些，而不是字母序排在后面的整棵兄弟目录
 * （改前是深度优先：排在 `src` 前面的 `.nuxt/` 之类把额度吃光，`src/` 一条都收不到）。
 * 局限：BFS 只救「深而窄」的树；若某个扁平目录自己的直接子项就超过上限、又排在 `src` 前面，它照样把额度吃光。
 */
export const scanRepoRoot = async (
  rootAbs: string,
  maxEntries: number = REPO_FILES_MAX_ENTRIES,
): Promise<RepoIndexResult> => {
  const out: RepoFileEntry[] = [];
  let level: Array<{ abs: string; rel: string }> = [{ abs: rootAbs, rel: "" }];

  while (level.length > 0) {
    const nextLevel: Array<{ abs: string; rel: string }> = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await fs.readdir(dir.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      // 稳定一点：名字排序后再走，空 query 时结果可预期
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        // 只跟真实目录 / 文件；symlink 跳过（防环 + 防扫出 root 外）
        if (ent.isSymbolicLink()) continue;
        const isDir = ent.isDirectory();
        if (!isDir && !ent.isFile()) continue;
        if (isDir && REPO_SCAN_IGNORE_DIRS.has(ent.name)) continue;
        // 走到这里说明还有一个条目要收：已满就是被截断了（恰好收满、后面没有条目了不算）
        if (out.length >= maxEntries) return { entries: out, truncated: true };
        const rel = dir.rel ? `${dir.rel}/${ent.name}` : ent.name;
        if (isDir) {
          out.push({ path: `${rel}/`, isDir: true });
          nextLevel.push({ abs: path.join(dir.abs, ent.name), rel });
        } else {
          out.push({ path: rel, isDir: false });
        }
      }
    }
    level = nextLevel;
  }
  return { entries: out, truncated: false };
};

/**
 * `git ls-files -co` 的输出（相对 root 的路径）→ 索引条目。纯函数。
 *
 * - 去重：合并冲突态下同一路径会出现多次；
 * - 以 `/` 结尾的项是嵌套仓库（未跟踪、自带 .git）：当目录收，里面的文件 git 这条路不展开；
 * - 可见集与目录遍历一致：路径里**目录段**命中 {@link REPO_SCAN_IGNORE_DIRS} 的整条丢掉
 *   （已跟踪的 `build/` `vendor/` 改前就看不见，保持）；文件名本身恰好叫 `out` / `tmp` 的文件不误杀；
 * - 补祖先目录项（git 只给文件，菜单里目录也要能 `@`）；
 * - 超限：按深度从浅到深留前 `maxEntries` 个、`truncated: true`（祖先一定比后代浅，所以留下的条目其祖先都在）。
 */
export const entriesFromPaths = (
  paths: readonly string[],
  maxEntries: number = REPO_FILES_MAX_ENTRIES,
): RepoIndexResult => {
  const seen = new Set<string>();
  const all: Array<RepoFileEntry & { depth: number }> = [];
  const add = (p: string, isDir: boolean, depth: number): void => {
    if (seen.has(p)) return;
    seen.add(p);
    all.push({ path: p, isDir, depth });
  };

  for (const raw of paths) {
    if (!raw) continue;
    const isDirItem = raw.endsWith("/");
    const segs = (isDirItem ? raw.slice(0, -1) : raw).split("/");
    // 畸形（开头 / 连续斜杠）：git 不会这样输出，防御性跳过
    if (segs.some((s) => s === "")) continue;
    const dirSegs = isDirItem ? segs : segs.slice(0, -1);
    if (dirSegs.some((s) => REPO_SCAN_IGNORE_DIRS.has(s))) continue;

    let prefix = "";
    for (let i = 0; i < segs.length - 1; i++) {
      prefix += `${segs[i]}/`;
      add(prefix, true, i + 1);
    }
    const last = segs[segs.length - 1]!;
    add(isDirItem ? `${prefix}${last}/` : `${prefix}${last}`, isDirItem, segs.length);
  }

  if (all.length <= maxEntries) {
    return { entries: all.map(({ path: p, isDir }) => ({ path: p, isDir })), truncated: false };
  }
  // Array.prototype.sort 是稳定的：同深度保持 git 给的顺序
  all.sort((a, b) => a.depth - b.depth);
  return {
    entries: all.slice(0, maxEntries).map(({ path: p, isDir }) => ({ path: p, isDir })),
    truncated: true,
  };
};

/**
 * 跑一次只读的 `git ls-files`，输出按 NUL 切成路径数组（空输出 = `[]`，由调用方决定空算不算失败）；
 * 任何失败（不是仓、git 没装 / 起不来、超时、输出超容量）一律返回 null。不抛错、不打日志（每个键一次的热路径）。
 *
 * `GIT_OPTIONAL_LOCKS=0` 让 `ls-files` 不去刷新 index（不写 `.git/index.lock`，不和用户 / agent 的 git 抢锁）。
 */
const runGitLs = async (
  rootAbs: string,
  args: string[],
  timeoutMs: number,
): Promise<string[] | null> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: rootAbs,
      timeout: timeoutMs,
      maxBuffer: GIT_LS_MAX_BUFFER,
      env: gitEnv({ GIT_OPTIONAL_LOCKS: "0" }),
      windowsHide: true,
    });
    const paths = stdout.split("\0");
    if (paths[paths.length - 1] === "") paths.pop();
    return paths;
  } catch {
    return null;
  }
};

/**
 * 在 root 下用 git 列出「工作区里有的」路径（相对 root）：已跟踪 + 未跟踪（去掉被 .gitignore 命中的），
 * 再扣掉「已跟踪但工作区已删」的。任何一种「这条路不通」都返回 null，由调用方退回目录遍历：
 * 不是 git 仓（128）、git 没装（ENOENT）、git 起不来（比如没同意 Xcode license，`/usr/bin/git` 直接退出 69）、
 * 超时、输出超过容量上限、主清单为空。
 *
 * 两次只读调用并行跑；任何一次不通都算这条路不通（宁可退回遍历，也不拿半份结果）。
 */
export const listGitPaths = async (
  rootAbs: string,
  opts?: { timeoutMs?: number },
): Promise<string[] | null> => {
  const timeoutMs = opts?.timeoutMs ?? GIT_LS_TIMEOUT_MS;
  const [listed, deleted] = await Promise.all([
    runGitLs(rootAbs, GIT_LS_FILES_ARGS, timeoutMs),
    runGitLs(rootAbs, GIT_LS_DELETED_ARGS, timeoutMs),
  ]);
  if (!listed || !deleted || listed.length === 0) return null;
  if (deleted.length === 0) return listed;
  const gone = new Set(deleted);
  return listed.filter((p) => !gone.has(p));
};

/** 建一次索引：git 优先，不通就退回目录遍历 */
const buildIndex = async (rootAbs: string): Promise<RepoIndexResult> => {
  // 根上有 .gitmodules：子模块里的文件 `git ls-files` 看不到（改前的遍历会进去），保持原行为 → 直接遍历
  const hasSubmodules = await fs.access(path.join(rootAbs, ".gitmodules")).then(
    () => true,
    () => false,
  );
  if (!hasSubmodules) {
    const paths = await listGitPaths(rootAbs);
    if (paths) {
      const fromGit = entriesFromPaths(paths);
      // 过滤后一条不剩（比如仓里只有 node_modules 下的已跟踪文件）：让遍历再确认一遍
      if (fromGit.entries.length > 0) return fromGit;
    }
  }
  return scanRepoRoot(rootAbs);
};

/** 取 root 的索引连同 `truncated`（命中缓存 / 复用 in-flight / 新建） */
export const getRepoFileIndexWithMeta = async (rootAbs: string): Promise<RepoIndexResult> => {
  const key = normalizeRepoRoot(rootAbs);
  const cache = getCache();
  const hit = cache.buckets.get(key);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return { entries: hit.entries, truncated: hit.truncated };
  }
  const pending = cache.inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const result = await buildIndex(key);
    // 成功才写 bucket；失败让调用方看到 reject，下次可重试
    cache.buckets.set(key, { ...result, cachedAt: Date.now() });
    return result;
  })().finally(() => {
    cache.inFlight.delete(key);
  });

  cache.inFlight.set(key, promise);
  return promise;
};

/** 取 root 的索引条目（命中缓存 / 复用 in-flight / 新建） */
export const getRepoFileIndex = async (rootAbs: string): Promise<RepoFileEntry[]> =>
  (await getRepoFileIndexWithMeta(rootAbs)).entries;

/**
 * 文件名 / 路径模糊过滤：basename 前缀 > basename 包含 > 全路径包含；
 * 同分更短路径优先。
 */
export const filterRepoFiles = (
  entries: RepoFileEntry[],
  query: string,
  limit = REPO_FILES_RESULT_LIMIT,
): RepoFileEntry[] => {
  const q = query.trim().toLowerCase();
  if (!q) {
    // 空 query：浅路径优先（段数少），方便刚打 @ 就看到顶层文件 / 目录
    return [...entries]
      .sort((a, b) => {
        const da = a.path.split("/").length;
        const db = b.path.split("/").length;
        if (da !== db) return da - db;
        return a.path.localeCompare(b.path);
      })
      .slice(0, limit);
  }

  const scored: Array<RepoFileEntry & { score: number }> = [];
  for (const e of entries) {
    const full = e.path.toLowerCase();
    const base = (e.isDir ? e.path.slice(0, -1) : e.path)
      .split("/")
      .pop()!
      .toLowerCase();
    let score = 0;
    if (base.startsWith(q)) score = 3;
    else if (base.includes(q)) score = 2;
    else if (full.includes(q)) score = 1;
    else continue;
    scored.push({ ...e, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });
  return scored.slice(0, limit).map(({ path: p, isDir }) => ({ path: p, isDir }));
};

/** `searchTaskRepoFiles` 的返回：命中的候选 + 是否来自被截断的索引（任一仓被截断就算） */
export interface RepoFileSearchResult {
  files: RepoFileEntry[];
  truncated: boolean;
}

/**
 * 对 task 的若干 root 建索引并过滤。
 * 多仓时相对路径前缀仓短名（相对 effective cwd 的写法，agent 能直接 read）。
 */
export const searchTaskRepoFiles = async (
  repoPaths: string[],
  query: string,
  opts?: { root?: string },
): Promise<RepoFileSearchResult> => {
  if (repoPaths.length === 0) return { files: [], truncated: false };

  const roots = opts?.root
    ? [normalizeRepoRoot(opts.root)]
    : repoPaths.map(normalizeRepoRoot);

  const shortNames =
    roots.length > 1 || (opts?.root && repoPaths.length > 1)
      ? getUniqueRepoDirNames(repoPaths)
      : null;

  // root → 短名前缀（多仓插入路径用）
  const prefixByRoot = new Map<string, string>();
  if (shortNames) {
    for (let i = 0; i < repoPaths.length; i++) {
      prefixByRoot.set(normalizeRepoRoot(repoPaths[i]!), shortNames[i]!);
    }
  }

  const merged: RepoFileEntry[] = [];
  let truncated = false;
  for (const root of roots) {
    const prefix = prefixByRoot.get(root);
    const index = await getRepoFileIndexWithMeta(root);
    if (index.truncated) truncated = true;
    for (const e of index.entries) {
      merged.push(
        prefix
          ? { path: `${prefix}/${e.path}`, isDir: e.isDir }
          : e,
      );
    }
  }
  return { files: filterRepoFiles(merged, query), truncated };
};
