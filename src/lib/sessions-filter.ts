/**
 * 会话管理页的纯过滤 / 批量选中逻辑（可单测）。
 *
 * - 搜索覆盖任务关联的**所有**仓（原来只看 repoPaths[0]，多仓任务搜第二个仓搜不到）。
 * - 「选中已终结 / 30 天未活跃 / 已归档」只作用于传入的行（页面传「当前已渲染的行」——
 *   筛选后可见且已展示出来的行，未点「显示更多」的行不算），否则勾选对象可能用户根本没看到。
 * - 已勾选集合随筛选 / 搜索 / 排序 / 分批渲染用 prunePicked 与可见 key 求交，删除前再求交一次。
 */

import { pathBasename } from "@/lib/path-utils";

/** 「不活跃对话」阈值（30 天未活跃快捷选中用） */
export const CHAT_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** 会话列表一次渲染的行数上限（「显示更多」每次追加一批） */
export const SESSIONS_PAGE_SIZE = 100;

interface SessionRowLike {
  id: string;
  title: string;
  mode?: string;
  repoPaths?: string[];
  repoStatus?: string;
  archived?: boolean;
  updatedAt: number;
}

/** 仓名（首个仓的 basename；无仓 = Home），与行内展示一致 */
const repoName = (t: Pick<SessionRowLike, "repoPaths">): string => {
  const first = t.repoPaths?.[0]?.trim();
  if (!first) return "Home";
  return pathBasename(first) || first;
};

/** 关键词是否命中：标题 / 任一仓的路径与目录名（小写子串）。kw 为空 = 命中 */
export const matchesSessionQuery = (
  t: Pick<SessionRowLike, "title" | "repoPaths">,
  rawKeyword: string,
): boolean => {
  const kw = rawKeyword.trim().toLowerCase();
  if (!kw) return true;
  if (t.title.toLowerCase().includes(kw)) return true;
  if (repoName(t).toLowerCase().includes(kw)) return true;
  for (const p of t.repoPaths ?? []) {
    const path = p.trim().toLowerCase();
    if (path.includes(kw)) return true;
    if ((pathBasename(p) || "").toLowerCase().includes(kw)) return true;
  }
  return false;
};

/** 已终结任务（非对话、已合并 / 已放弃） */
export const pickFinishedSessions = <T extends SessionRowLike>(rows: T[]): T[] =>
  rows.filter(
    (t) =>
      (t.mode ?? "task") !== "chat" &&
      (t.repoStatus === "merged" || t.repoStatus === "abandoned"),
  );

/** 30 天未活跃的对话（now 由调用方现取，别 memo 冻住） */
export const pickStaleChatSessions = <T extends SessionRowLike>(
  rows: T[],
  now: number,
): T[] =>
  rows.filter((t) => t.mode === "chat" && now - t.updatedAt > CHAT_STALE_MS);

/** 已归档会话 */
export const pickArchivedSessions = <T extends SessionRowLike>(rows: T[]): T[] =>
  rows.filter((t) => t.archived);

/**
 * 把已勾选集合与「当前可勾选的 key 集合」求交（R8-05）。
 * 筛选 / 搜索 / 排序 / 分批渲染变化后，旧勾选里不在当前列表（页面传「已渲染的行」+ 残留工作区 key）
 * 里的项不再算数——否则批量删除会删到用户此刻看不见的行。
 * 没有任何被剔除时返回原集合引用（调用方可用 `===` 判断、避免无谓重渲染）。
 */
export const prunePicked = (
  picked: Set<string>,
  visibleIds: Iterable<string>,
): Set<string> => {
  const allowed = new Set(visibleIds);
  let changed = false;
  const next = new Set<string>();
  for (const id of picked) {
    if (allowed.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : picked;
};
