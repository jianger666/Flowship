/**
 * 代码改动面板的「条目」层（纯函数，无 React / DOM）：
 * 服务端按仓给的清单 → 摊平成可导航的条目。
 *
 * 文件列表的显示顺序与 j/k 导航顺序用同一份（orderedEntries）——
 * 不会出现「列表里下一个是 B、按 j 却跳到 C」。
 */

import { matchesFileQuery } from "@/lib/changes/file-filter";
import { buildFileTree, treeFileOrder } from "@/lib/changes/file-tree";
import { isViewed, type ViewedMap } from "@/lib/changes/viewed-store";
import type { TaskChangeFile, TaskRepoChanges } from "@/lib/types";

/** 一个文件在面板里的唯一标识（跨仓不撞） */
export const entryKey = (repoPath: string, filePath: string): string =>
  `${repoPath}\u0000${filePath}`;

/**
 * 「已查看」用的内容签名：文件的状态 + 增删统计 + 文件级内容指纹，任何一项变了就当作「看过之后又改了」。
 *
 * 指纹是关键：只靠「状态 + 行数」会把「切分支后同一文件同样 +1 −1」「等量替换」当成没变——
 * 已查看标记沿用到别的内容上，单文件 diff 缓存也命中旧内容（用户看到的是错的 diff）。
 * 指纹缺省（服务端没取到）时退回只比状态 + 行数。
 * 刻意不带路径（路径已经是 viewed 记录的 key，避免重复占 localStorage）。
 */
export const viewedSignature = (f: TaskChangeFile): string =>
  `${f.status}:${f.added}:${f.removed}:${f.untracked ? 1 : 0}:${f.whitespaceOnly ? 1 : 0}:${f.fingerprint ?? ""}`;

/** diff 缓存 / 重拉用的签名（带路径，跨仓不撞） */
export const fileSignature = (repoPath: string, f: TaskChangeFile): string =>
  `${entryKey(repoPath, f.path)}\u0000${viewedSignature(f)}`;

export interface ChangeEntry {
  key: string;
  repoPath: string;
  repoShortName: string;
  file: TaskChangeFile;
  /** diff 缓存签名 */
  signature: string;
  /** 已查看签名 */
  viewedSig: string;
}

const toEntry = (repo: TaskRepoChanges, file: TaskChangeFile): ChangeEntry => ({
  key: entryKey(repo.repoPath, file.path),
  repoPath: repo.repoPath,
  repoShortName: repo.shortName,
  file,
  signature: fileSignature(repo.repoPath, file),
  viewedSig: viewedSignature(file),
});

/** 全部仓的全部文件（服务端顺序；读不到的仓跳过） */
export const flattenEntries = (repos: readonly TaskRepoChanges[]): ChangeEntry[] =>
  repos.flatMap((repo) => (repo.unavailable ? [] : repo.files.map((file) => toEntry(repo, file))));

export interface OrderOptions {
  /** tree：目录在前、自然排序（与文件树显示一致）；flat：服务端顺序 */
  treeMode: "tree" | "flat";
  /** parseFileQuery 的结果；空数组 = 不过滤 */
  terms: readonly string[];
}

/**
 * 面板里「看得见的」文件顺序：每个仓内按显示顺序，仓之间保持服务端顺序；过滤后。
 * 折叠状态不影响它（导航跳进被折叠目录时由调用方展开祖先）。
 */
export const orderedEntries = (
  repos: readonly TaskRepoChanges[],
  opts: OrderOptions,
): ChangeEntry[] => {
  const out: ChangeEntry[] = [];
  for (const repo of repos) {
    if (repo.unavailable) continue;
    const entries = repo.files
      .filter((f) => matchesFileQuery(f.path, opts.terms))
      .map((f) => toEntry(repo, f));
    if (opts.treeMode === "flat") {
      out.push(...entries);
      continue;
    }
    const byKey = new Map(entries.map((e) => [e.key, e]));
    const tree = buildFileTree(
      entries.map((e) => ({
        key: e.key,
        path: e.file.path,
        added: e.file.added,
        removed: e.file.removed,
        data: e,
      })),
    );
    for (const item of treeFileOrder(tree)) {
      const entry = byKey.get(item.key);
      if (entry) out.push(entry);
    }
  }
  return out;
};

/**
 * 上一个 / 下一个文件（边界不回绕：到头就停，j 按到最后一个不会突然跳回开头）。
 * 当前文件不在顺序里（被过滤掉 / 清单刷新后没了）：下一个 = 第一个、上一个 = 最后一个。
 */
export const stepEntry = (
  order: readonly ChangeEntry[],
  currentKey: string | null,
  delta: 1 | -1,
): ChangeEntry | null => {
  if (order.length === 0) return null;
  const idx = currentKey === null ? -1 : order.findIndex((e) => e.key === currentKey);
  if (idx < 0) return delta === 1 ? order[0] : order[order.length - 1];
  const next = idx + delta;
  return next >= 0 && next < order.length ? order[next] : null;
};

/**
 * 当前文件之后第一个「还没看过」的文件；走到末尾回绕到开头继续找；全看过 = null。
 * 「看过之后又改了」的文件（签名对不上）算没看过。
 */
export const nextUnviewed = (
  order: readonly ChangeEntry[],
  currentKey: string | null,
  viewed: ViewedMap,
): ChangeEntry | null => {
  const n = order.length;
  if (n === 0) return null;
  const start = currentKey === null ? -1 : order.findIndex((e) => e.key === currentKey);
  for (let step = 1; step <= n; step++) {
    const entry = order[(start + step + n) % n];
    // 回绕一圈走回自己：自己不算「下一个」
    if (entry.key === currentKey) continue;
    if (!isViewed(viewed, entry.key, entry.viewedSig)) return entry;
  }
  return null;
};

/** 已查看进度（分母是传入的全部条目） */
export const viewedProgress = (
  entries: readonly ChangeEntry[],
  viewed: ViewedMap,
): { viewed: number; total: number } => {
  let done = 0;
  for (const e of entries) {
    if (isViewed(viewed, e.key, e.viewedSig)) done++;
  }
  return { viewed: done, total: entries.length };
};

/** 路径拆成「目录/」+「文件名」（文件名恒非空） */
export const splitPath = (p: string): { dir: string; name: string } => {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? { dir: "", name: p } : { dir: p.slice(0, idx + 1), name: p.slice(idx + 1) };
};
