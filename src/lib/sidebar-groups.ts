/**
 * 侧栏会话列表分组 / 置顶重排（纯函数）
 *
 * 对标 grok-build 会话组织语义（按 cwd/repo 分组 + 置顶手动序）：
 * - chat 按仓库组；task 模式仍走时间桶（不经本模块）
 * - 置顶 → 仓库组 → Home（未绑仓恒最后）
 * - 对话序是粘性的：不跟 agent 流式 bump 的 updatedAt 走，避免并行时整组对跳。
 *   组间 / 组内都按同一条 itemOrder（先出现的组在上；组内按该序）。
 *   空 order 才回落到 updatedAt 倒序（第一次、还没记下粘性序）。
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
 * 粘性序：order 里靠前的在上。未入序的垫后，再用 updatedAt 倒序当并列。
 */
export const sortByStickyOrder = <T extends { id: string; updatedAt: number }>(
  items: T[],
  order: readonly string[],
): T[] => {
  if (order.length === 0) return sortByUpdatedAtDesc(items);
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra == null && rb == null) return b.updatedAt - a.updatedAt;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
};

/**
 * 对齐当前列表：已有 id 相对序不动，已删的丢掉，新出现的插到最前。
 * 新对话 / 飞书拉起的窗口会出现在顶上；后台 running 不会改序。
 */
export const reconcileChatListOrder = (
  prevOrder: readonly string[],
  liveIds: readonly string[],
): string[] => {
  const live = new Set(liveIds);
  const kept = prevOrder.filter((id) => live.has(id));
  const keptSet = new Set(kept);
  const newcomers = liveIds.filter((id) => !keptSet.has(id));
  return [...newcomers, ...kept];
};

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
 * 构建「按仓库」分组：置顶 → 仓库组 → Home。
 * itemOrder 非空时仓组 / 组内都跟粘性序，不再按 updatedAt 互相比最新。
 */
export const buildRepoGroups = (
  tasks: TaskSummary[],
  repos: RepoNameLookup,
  pinnedOrder: readonly string[] = [],
  itemOrder: readonly string[] = [],
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

  const rank = new Map(itemOrder.map((id, i) => [id, i]));
  const sticky = itemOrder.length > 0;
  const repoGroups = [...repoBuckets.entries()]
    .map(([norm, { path, items }]) => {
      const sorted = sticky
        ? sortByStickyOrder(items, itemOrder)
        : sortByUpdatedAtDesc(items);
      const latest = sorted[0]?.updatedAt ?? 0;
      const stickyRank = sticky
        ? Math.min(
            ...sorted.map((t) => rank.get(t.id) ?? Number.POSITIVE_INFINITY),
          )
        : Number.POSITIVE_INFINITY;
      return {
        key: `repo:${norm}` as SidebarGroupKey,
        label: resolveRepoGroupLabel(path, repos),
        items: sorted,
        latest,
        stickyRank,
      };
    })
    .sort((a, b) =>
      sticky ? a.stickyRank - b.stickyRank : b.latest - a.latest,
    );

  for (const g of repoGroups) {
    groups.push({ key: g.key, label: g.label, items: g.items });
  }

  if (unbound.length > 0) {
    groups.push({
      key: "unbound",
      label: HOME_GROUP_LABEL,
      items: sticky
        ? sortByStickyOrder(unbound, itemOrder)
        : sortByUpdatedAtDesc(unbound),
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
