/**
 * 侧栏会话列表分组 / 置顶重排（纯函数）
 *
 * 对标 grok-build 会话组织语义（按 cwd/repo 分组 + 置顶手动序）：
 * - chat 按仓库组；task 模式仍走时间桶（不经本模块）
 * - 组内 updatedAt 倒序；仓库组间按「组内最新 updatedAt」倒序；Home（未绑仓）恒最后
 * - 置顶序存在 view-memory（不污染 task meta）
 */

import { pathBasename } from "@/lib/path-utils";
import type { TaskSummary } from "@/lib/types";

/** 置顶组 / Home（未绑仓）/ 仓库路径 */
export type SidebarGroupKey = "pinned" | "unbound" | `repo:${string}`;

export type SidebarGroup = {
  key: SidebarGroupKey;
  label: string;
  items: TaskSummary[];
};

/** settings.repos 里用于解析组头的最小字段（name = 展示名） */
export type RepoNameLookup = ReadonlyArray<{ path: string; name: string }>;

/** Home 组展示名（repoPaths 空）；排序 key 仍用 unbound */
export const HOME_GROUP_LABEL = "Home";

/** 组内按 updatedAt 倒序 */
export const sortByUpdatedAtDesc = <T extends { updatedAt: number }>(
  items: T[],
): T[] => [...items].sort((a, b) => b.updatedAt - a.updatedAt);

/**
 * 组头标签：settings 仓 name（展示名）优先；无匹配则 basename(repoPath)。
 * path 做规范化比对（去尾斜杠），避免 `/a/b` vs `/a/b/` 拆成两组。
 */
export const resolveRepoGroupLabel = (
  repoPath: string,
  repos: RepoNameLookup,
): string => {
  const norm = normalizeRepoPath(repoPath);
  const hit = repos.find((r) => normalizeRepoPath(r.path) === norm);
  const name = hit?.name?.trim();
  if (name) return name;
  return pathBasename(repoPath) || repoPath || HOME_GROUP_LABEL;
};

export const normalizeRepoPath = (p: string): string =>
  p.replace(/[/\\]+$/, "").toLowerCase();

/**
 * 任务落入哪个仓库组 key。
 * 多仓取 repoPaths[0]（chat 通常单仓；与 grok cwd 第一公民对齐）。
 */
export const repoGroupKeyFor = (
  task: Pick<TaskSummary, "repoPaths">,
): Exclude<SidebarGroupKey, "pinned"> => {
  const first = task.repoPaths?.[0]?.trim();
  if (!first) return "unbound";
  return `repo:${normalizeRepoPath(first)}`;
};

/**
 * 置顶区按 view-memory 里的 id 序重排；未出现在 order 里的追加到末尾（按 updatedAt 倒序）。
 * order 里的幽灵 id（已删）忽略。
 */
export const applyPinnedOrder = (
  pinned: TaskSummary[],
  order: readonly string[],
): TaskSummary[] => {
  if (pinned.length <= 1) return pinned;
  const byId = new Map(pinned.map((t) => [t.id, t]));
  const ordered: TaskSummary[] = [];
  for (const id of order) {
    const t = byId.get(id);
    if (!t) continue;
    ordered.push(t);
    byId.delete(id);
  }
  const rest = sortByUpdatedAtDesc([...byId.values()]);
  return [...ordered, ...rest];
};

/**
 * 置顶列表内上/下移一位。返回新 order（仅含仍存在的 pinned id）。
 * 越界 / 找不到 → 返回规范化后的当前序（order 优先、其余按 pinnedIds 原序追加）。
 */
export const movePinnedId = (
  pinnedIds: readonly string[],
  order: readonly string[],
  id: string,
  direction: "up" | "down",
): string[] => {
  const idSet = new Set(pinnedIds);
  const current = [
    ...order.filter((x) => idSet.has(x)),
    ...pinnedIds.filter((x) => !order.includes(x)),
  ];
  const idx = current.indexOf(id);
  if (idx < 0) return current;
  const swapWith = direction === "up" ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= current.length) return current;
  const next = [...current];
  const tmp = next[idx]!;
  next[idx] = next[swapWith]!;
  next[swapWith] = tmp;
  return next;
};

/**
 * 构建「按仓库」分组：置顶 → 仓库组（组内最新 updatedAt 倒序）→ Home。
 */
export const buildRepoGroups = (
  tasks: TaskSummary[],
  repos: RepoNameLookup,
  pinnedOrder: readonly string[] = [],
): SidebarGroup[] => {
  const pinned: TaskSummary[] = [];
  const unbound: TaskSummary[] = [];
  // key = normalize path；保留原始 path 用于 label
  const repoBuckets = new Map<
    string,
    { path: string; items: TaskSummary[] }
  >();

  for (const t of tasks) {
    if (t.pinned) {
      pinned.push(t);
      continue;
    }
    const first = t.repoPaths?.[0]?.trim();
    if (!first) {
      unbound.push(t);
      continue;
    }
    const norm = normalizeRepoPath(first);
    let bucket = repoBuckets.get(norm);
    if (!bucket) {
      bucket = { path: first, items: [] };
      repoBuckets.set(norm, bucket);
    }
    bucket.items.push(t);
  }

  const groups: SidebarGroup[] = [];
  if (pinned.length > 0) {
    groups.push({
      key: "pinned",
      label: "置顶",
      items: applyPinnedOrder(pinned, pinnedOrder),
    });
  }

  const repoGroups = [...repoBuckets.entries()]
    .map(([norm, { path, items }]) => {
      const sorted = sortByUpdatedAtDesc(items);
      const latest = sorted[0]?.updatedAt ?? 0;
      return {
        key: `repo:${norm}` as SidebarGroupKey,
        label: resolveRepoGroupLabel(path, repos),
        items: sorted,
        latest,
      };
    })
    .sort((a, b) => b.latest - a.latest);

  for (const g of repoGroups) {
    groups.push({ key: g.key, label: g.label, items: g.items });
  }

  if (unbound.length > 0) {
    groups.push({
      key: "unbound",
      label: HOME_GROUP_LABEL,
      items: sortByUpdatedAtDesc(unbound),
    });
  }

  return groups;
};

/**
 * 组头「+」预绑工作目录：
 * - 仓组 → [该组路径]（取组内首条的 repoPaths[0]）
 * - Home → []（不绑）
 * - 置顶 → null（不展示「+」、无单一 cwd）
 */
export const repoPathsForGroupCreate = (
  group: Pick<SidebarGroup, "key" | "items">,
): string[] | null => {
  if (group.key === "pinned") return null;
  if (group.key === "unbound") return [];
  const path = group.items[0]?.repoPaths?.[0]?.trim();
  return path ? [path] : [];
};
