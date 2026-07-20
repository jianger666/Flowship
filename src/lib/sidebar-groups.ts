/**
 * 侧栏会话列表分组 / 置顶重排 / 搜索合并（纯函数）
 *
 * 对标 grok-build 会话组织语义（按 cwd/repo 分组 + 可选按状态 + 置顶手动序）：
 * - chat 默认按仓库组；task 模式仍走时间桶（不经本模块）
 * - 组内 updatedAt 倒序；仓库组间按「组内最新 updatedAt」倒序；「未绑定」恒最后
 * - 置顶序存在 view-memory（不污染 task meta）
 */

import { pathBasename } from "@/lib/path-utils";
import type { TaskSummary } from "@/lib/types";

/** 侧栏分组视图：按仓（默认）/ 按状态 */
export type SidebarGroupMode = "repo" | "status";

/** 置顶组 / 未绑定 / 仓库路径 / 状态桶 */
export type SidebarGroupKey =
  | "pinned"
  | "unbound"
  | `repo:${string}`
  | "status:awaiting"
  | "status:running"
  | "status:idle";

export type SidebarGroup = {
  key: SidebarGroupKey;
  label: string;
  items: TaskSummary[];
};

/** settings.repos 里用于解析组头的最小字段（name = 展示名） */
export type RepoNameLookup = ReadonlyArray<{ path: string; name: string }>;

/** 正文搜索命中（API 返回形态） */
export type ContentSearchHit = {
  taskId: string;
  /** 命中附近摘要片段 */
  snippet: string;
};

/** 搜索结果分节：标题命中 / 内容命中 */
export type SidebarSearchSection = {
  key: "title" | "content";
  label: string;
  items: Array<TaskSummary & { contentSnippet?: string }>;
};

export const UNBOUND_GROUP_LABEL = "未绑定工作目录";

const STATUS_GROUP_ORDER: Array<{
  key: Extract<SidebarGroupKey, `status:${string}`>;
  label: string;
}> = [
  { key: "status:awaiting", label: "等你回复" },
  { key: "status:running", label: "运行中" },
  { key: "status:idle", label: "空闲" },
];

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
  return pathBasename(repoPath) || repoPath || UNBOUND_GROUP_LABEL;
};

export const normalizeRepoPath = (p: string): string =>
  p.replace(/[/\\]+$/, "").toLowerCase();

/**
 * 任务落入哪个仓库组 key。
 * 多仓取 repoPaths[0]（chat 通常单仓；与 grok cwd 第一公民对齐）。
 */
export const repoGroupKeyFor = (
  task: Pick<TaskSummary, "repoPaths">,
): Exclude<SidebarGroupKey, "pinned" | `status:${string}`> => {
  const first = task.repoPaths?.[0]?.trim();
  if (!first) return "unbound";
  return `repo:${normalizeRepoPath(first)}`;
};

/**
 * 按状态分桶（chat 侧栏「按状态」视图）。
 * - running → 运行中
 * - awaiting_user → 等你回复（含 ask / wait 交卷后等你）
 * - 其余（idle / error）→ 空闲
 */
export const statusBucketFor = (
  task: Pick<TaskSummary, "runStatus">,
): "awaiting" | "running" | "idle" => {
  if (task.runStatus === "running") return "running";
  if (task.runStatus === "awaiting_user") return "awaiting";
  return "idle";
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
 * 构建「按仓库」分组：置顶 → 仓库组（组内最新 updatedAt 倒序）→ 未绑定。
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
      label: UNBOUND_GROUP_LABEL,
      items: sortByUpdatedAtDesc(unbound),
    });
  }

  return groups;
};

/**
 * 构建「按状态」分组：置顶 → 等你回复 → 运行中 → 空闲。
 * 空节不渲染（filter length）。
 */
export const buildStatusGroups = (
  tasks: TaskSummary[],
  pinnedOrder: readonly string[] = [],
): SidebarGroup[] => {
  const pinned: TaskSummary[] = [];
  const buckets: Record<"awaiting" | "running" | "idle", TaskSummary[]> = {
    awaiting: [],
    running: [],
    idle: [],
  };

  for (const t of tasks) {
    if (t.pinned) {
      pinned.push(t);
      continue;
    }
    buckets[statusBucketFor(t)].push(t);
  }

  const groups: SidebarGroup[] = [];
  if (pinned.length > 0) {
    groups.push({
      key: "pinned",
      label: "置顶",
      items: applyPinnedOrder(pinned, pinnedOrder),
    });
  }

  for (const { key, label } of STATUS_GROUP_ORDER) {
    const bucket = key.replace("status:", "") as "awaiting" | "running" | "idle";
    const items = sortByUpdatedAtDesc(buckets[bucket]);
    if (items.length === 0) continue;
    groups.push({ key, label, items });
  }

  return groups;
};

/**
 * 合并标题命中与正文命中：两节；标题已命中的不再进内容节（避免重复行）。
 * titleHits / contentHits 均保持调用方传入顺序。
 */
export const mergeSidebarSearchSections = (
  titleHits: TaskSummary[],
  contentHits: ContentSearchHit[],
  tasksById: Map<string, TaskSummary>,
): SidebarSearchSection[] => {
  const titleIds = new Set(titleHits.map((t) => t.id));
  const sections: SidebarSearchSection[] = [];

  if (titleHits.length > 0) {
    sections.push({
      key: "title",
      label: "标题命中",
      items: titleHits,
    });
  }

  const contentItems: Array<TaskSummary & { contentSnippet?: string }> = [];
  for (const hit of contentHits) {
    if (titleIds.has(hit.taskId)) continue;
    const task = tasksById.get(hit.taskId);
    if (!task) continue;
    contentItems.push({ ...task, contentSnippet: hit.snippet });
  }
  if (contentItems.length > 0) {
    sections.push({
      key: "content",
      label: "内容命中",
      items: contentItems,
    });
  }

  return sections;
};

/**
 * 从正文抽摘要片段：命中处前后各 pad 字符；超出加省略号。
 * 大小写不敏感定位。
 */
export const buildSearchSnippet = (
  text: string,
  query: string,
  pad = 36,
): string => {
  const q = query.trim();
  if (!q || !text) return text.slice(0, pad * 2);
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, pad * 2);
  const start = Math.max(0, idx - pad);
  const end = Math.min(text.length, idx + q.length + pad);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
};
