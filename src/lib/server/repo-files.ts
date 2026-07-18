/**
 * 仓库文件模糊索引（chat / task composer `@` 引用）
 *
 * 按 root 扫相对路径清单，模块级（挂 globalThis）60s TTL + in-flight 去重——
 * Next dev 多 chunk 下纯 module Map 会分裂，跟 task-fs / settings-fs 同构。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { getUniqueRepoDirNames } from "@/lib/path-utils";
import {
  REPO_FILES_Q_MAX_LEN,
  REPO_FILES_RESULT_LIMIT,
} from "@/lib/repo-files-shared";

export { REPO_FILES_Q_MAX_LEN, REPO_FILES_RESULT_LIMIT };

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
]);

/** 单 root 最多收录条目（文件 + 目录），防超大仓把内存打爆 */
const MAX_ENTRIES_PER_ROOT = 20_000;

const CACHE_TTL_MS = 60_000;
/** V2：加 inFlight，避免首次扫描未完成时并发重复扫仓；挂 globalThis 防 Next dev 多 chunk 分裂 */
const CACHE_KEY = "__feAiFlowRepoFilesCacheV2__";

export interface RepoFileEntry {
  /** 插入 `@` token 的相对路径；目录以 `/` 结尾 */
  path: string;
  isDir: boolean;
}

interface CacheBucket {
  entries: RepoFileEntry[];
  cachedAt: number;
}

interface RepoFilesCache {
  buckets: Map<string, CacheBucket>;
  /** 同一 root 扫描进行中时复用同一 Promise，避免并发翻倍扫盘 */
  inFlight: Map<string, Promise<RepoFileEntry[]>>;
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
 */
const scanRoot = async (rootAbs: string): Promise<RepoFileEntry[]> => {
  const out: RepoFileEntry[] = [];

  const walk = async (absDir: string, relBase: string): Promise<void> => {
    if (out.length >= MAX_ENTRIES_PER_ROOT) return;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    // 稳定一点：名字排序后再走，空 query 时结果可预期
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (out.length >= MAX_ENTRIES_PER_ROOT) return;
      // 只跟真实目录 / 文件；symlink 跳过（防环 + 防扫出 root 外）
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (REPO_SCAN_IGNORE_DIRS.has(ent.name)) continue;
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        out.push({ path: `${rel}/`, isDir: true });
        await walk(path.join(absDir, ent.name), rel);
      } else if (ent.isFile()) {
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        out.push({ path: rel, isDir: false });
      }
    }
  };

  await walk(rootAbs, "");
  return out;
};

/** 取 root 扫描结果（命中缓存 / 复用 in-flight / 新扫） */
export const getRepoFileIndex = async (
  rootAbs: string,
): Promise<RepoFileEntry[]> => {
  const key = normalizeRepoRoot(rootAbs);
  const cache = getCache();
  const hit = cache.buckets.get(key);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return hit.entries;
  }
  const pending = cache.inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const entries = await scanRoot(key);
    // 成功才写 bucket；失败让调用方看到 reject，下次可重试
    cache.buckets.set(key, { entries, cachedAt: Date.now() });
    return entries;
  })().finally(() => {
    cache.inFlight.delete(key);
  });

  cache.inFlight.set(key, promise);
  return promise;
};

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

/**
 * 对 task 的若干 root 建索引并过滤。
 * 多仓时相对路径前缀仓短名（相对 effective cwd 的写法，agent 能直接 read）。
 */
export const searchTaskRepoFiles = async (
  repoPaths: string[],
  query: string,
  opts?: { root?: string },
): Promise<RepoFileEntry[]> => {
  if (repoPaths.length === 0) return [];

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
  for (const root of roots) {
    const prefix = prefixByRoot.get(root);
    const index = await getRepoFileIndex(root);
    for (const e of index) {
      merged.push(
        prefix
          ? { path: `${prefix}/${e.path}`, isDir: e.isDir }
          : e,
      );
    }
  }
  return filterRepoFiles(merged, query);
};
