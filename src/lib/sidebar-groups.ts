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
import { isTaskBusy } from "@/lib/task-background";
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
 * 此刻能不能拿「当前列表」去对齐并持久化粘性序（2026-10-20 第二轮 review V7-08）。
 *
 * 冷启动时列表还没拉到（或首拉失败）→ 全量对话 id 为空；此时对齐会把 localStorage 里的粘性序
 * 清成 []，列表到齐后只能按 pinned + updatedAt 重建，「发送才上浮、后台流式不改序」每次重启都归零。
 * - 没 loaded：不动
 * - loaded 但带 loadError 且列表为空：「没拉到」≠「没有对话」，不动
 * - loaded 且无错：即使真的为空也要对齐（用户确实删光了所有对话）
 */
export const canReconcileChatOrder = (state: {
  loaded: boolean;
  loadError: string | null;
  chatCount: number;
}): boolean => {
  if (!state.loaded) return false;
  if (state.loadError && state.chatCount === 0) return false;
  return true;
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
 *
 * @deprecated 置顶行内排序 UI 已下线（2026-09-09，箭头跟标题挤在一起被点名去掉）；
 * 仅单测还在覆盖，生产代码不再调用，不要复活它。
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
 * 仓组默认只展前 limit 条（其余走「展开其余 N 条」）；但**正在看的那条**若落在被收起的
 * 尾部，也得露出来——侧栏里看不到当前对话，用户就只能绕去会话管理找（2026-10-15 实测）。
 * 已展开 / 条数没超限 → 全展；limit 传 Infinity = 不限（置顶组）。
 *
 * 被收起的尾部里还有两类行必须露出（保持原排序位置、不改顺序），hiddenCount 只算仍被藏起来的：
 * - 当前打开的那条（activeId）；
 * - `alwaysShow(t)` 为真的行（V7-02，2026-10-20 第二轮 review）：转圈 / 后台子代理 / 等你回答
 *   这些信号只画在行上，行一旦被挤出前 N 条、折进「展开其余 N 条」，信号就跟着消失。
 *   排序来自「发送成功才上浮」——先开跑的长任务会被后发消息的对话挤到第 5 位，正是最需要被看见的那条。
 *   谓词由调用方给（见 isSidebarAlwaysShowItem），本函数不认识任务状态。
 */
export const pickVisibleGroupItems = <T extends { id: string }>(
  items: readonly T[],
  opts: {
    limit: number;
    expanded: boolean;
    activeId?: string;
    alwaysShow?: (item: T) => boolean;
  },
): { visible: T[]; hiddenCount: number } => {
  if (opts.expanded || items.length <= opts.limit) {
    return { visible: [...items], hiddenCount: 0 };
  }
  // 按原序过滤：前 limit 条 + 当前条 + 必须露出的行。不能写成「head 后面追加」，
  // 否则第 5 位的忙行会被排到第 6 位的当前条之后，列表顺序与粘性序不一致
  const visible = items.filter(
    (t, i) =>
      i < opts.limit ||
      (opts.activeId !== undefined && t.id === opts.activeId) ||
      opts.alwaysShow?.(t) === true,
  );
  return { visible, hiddenCount: items.length - visible.length };
};

/**
 * 侧栏仓组里「不许被折叠」的行：AI 在跑 / 后台子代理在跑 / 有未答的提问。
 * 与行首指示（task-list-item 的 LeadingIndicator）同一套判定——转圈用 isTaskBusy，
 * 「等你回答」看 hasPendingAsk——折叠不能比指示灯更晚知道「这行有事」。
 * 空闲 / 出错不算：全都算的话折叠就形同虚设。
 */
export const isSidebarAlwaysShowItem = (
  t: Pick<TaskSummary, "runStatus" | "backgroundSubagentCount" | "hasPendingAsk">,
): boolean => isTaskBusy(t) || t.hasPendingAsk === true;

/**
 * 把某行滚进可视区所需的 scrollTop 增量（纯函数，坐标同一坐标系即可）。
 * 已完整在视口内 → 0；在上方 → 负数；在下方 → 正数；pad 为露出后留的边距。
 * 行比视口还高时优先对齐顶部。
 */
export const scrollDeltaToReveal = (
  view: { top: number; bottom: number },
  row: { top: number; bottom: number },
  pad = 8,
): number => {
  if (row.top < view.top) return row.top - view.top - pad;
  if (row.bottom > view.bottom) {
    const down = row.bottom - view.bottom + pad;
    // 行比视口高：别把顶部滚出去
    const maxDown = row.top - view.top - pad;
    return Math.max(0, Math.min(down, maxDown));
  }
  return 0;
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
