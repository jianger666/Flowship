/**
 * 会话管理页的纯过滤 / 批量选中逻辑（可单测）。
 *
 * - 搜索覆盖任务关联的**所有**仓（原来只看 repoPaths[0]，多仓任务搜第二个仓搜不到）。
 * - 「选中已终结 / 30 天未活跃 / 已归档」只作用于传入的行（页面传「当前已渲染的行」——
 *   筛选后可见且已展示出来的行，未点「显示更多」的行不算），否则勾选对象可能用户根本没看到。
 * - 已勾选集合随筛选 / 搜索 / 排序 / 分批渲染用 prunePicked 与可见 key 求交，删除前再求交一次。
 * - 「30 天未活跃」是按时间推断出来的快捷选中：不替用户决定删掉置顶 / 在跑 / 带定时的会话
 *   （isBulkProtected）。「已终结 / 已归档」是用户自己声明过的状态，不在此列；手动逐行勾选也不拦，
 *   只在确认框里汇总提示（buildBatchDeleteSummary）。
 */

import { pathBasename } from "@/lib/path-utils";
import { hasBackgroundSubagents } from "@/lib/task-background";

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
  /**
   * 以下四个只给「受保护」判定用（isBulkProtected），都可选、缺省 = 不保护。
   * 列表行（GET /api/tasks）本来就带着它们，不需要新字段或新请求。
   */
  pinned?: boolean;
  runStatus?: string;
  backgroundSubagentCount?: number;
  hasLiveSchedule?: boolean;
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

/**
 * 「快捷选中」不替用户决定删掉的会话：置顶、主 AI 在跑、后台子代理在跑、带「还会触发」的定时。
 *
 * 为什么：「30 天未活跃」只看 updatedAt，而一个每月触发一次的定时会话、或挂着后台子代理的会话，
 * 两次活动的间隔本来就可能超过 30 天——它们不是「没人要了」，删掉还会连同定时一起没。
 * 口径与列表行上的标记一致：
 * - 在跑 = 主 AI 在 running，或后台子代理在跑（hasBackgroundSubagents；会话页自己也为后台子代理画「后台运行中」，
 *   只看 runStatus 会漏）；
 * - 带定时 = hasLiveSchedule（服务端打的：active，或 paused 但还有待投递的；纯 paused 且无待投递的不算）。
 */
export const isBulkProtected = (
  t: Pick<
    SessionRowLike,
    "pinned" | "runStatus" | "backgroundSubagentCount" | "hasLiveSchedule"
  >,
): boolean =>
  t.pinned === true ||
  t.runStatus === "running" ||
  hasBackgroundSubagents(t) ||
  t.hasLiveSchedule === true;

/** 按时间推断「不活跃」的对话（不看是否受保护；pick / count 两处共用，口径不会漂移） */
const isStaleChat = (t: SessionRowLike, now: number): boolean =>
  t.mode === "chat" && now - t.updatedAt > CHAT_STALE_MS;

/**
 * 30 天未活跃的对话（now 由调用方现取，别 memo 冻住）。
 * 置顶 / 在跑 / 带定时的不选（isBulkProtected）：这是推断出来的快捷选中，宁可少选、不替用户误删。
 */
export const pickStaleChatSessions = <T extends SessionRowLike>(
  rows: T[],
  now: number,
): T[] => rows.filter((t) => isStaleChat(t, now) && !isBulkProtected(t));

/** 30 天未活跃、但因受保护没被快捷选中的对话个数（页面灰字「跳过了几个」用，与 pickStaleChatSessions 互补） */
export const countProtectedStaleChats = <T extends SessionRowLike>(
  rows: T[],
  now: number,
): number => rows.filter((t) => isStaleChat(t, now) && isBulkProtected(t)).length;

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

/** 批量删除确认框里最多列几个会话标题（弹窗是窄的 sm:max-w-sm，列多了要滚半屏） */
export const BATCH_DELETE_LIST_MAX = 8;
/** 单个标题最多显示多少个字符（按码点算，emoji 这类代理对不会被劈成乱码；ZWJ 组合序列仍可能被截开） */
export const BATCH_DELETE_TITLE_MAX_CHARS = 24;

/** 标题压成一行并截短：折叠所有空白（含换行）、按码点截断、空标题给占位 */
const shortenTitle = (title: string): string => {
  const flat = title.replace(/\s+/g, " ").trim();
  if (!flat) return "（无标题）";
  const chars = Array.from(flat);
  return chars.length > BATCH_DELETE_TITLE_MAX_CHARS
    ? `${chars.slice(0, BATCH_DELETE_TITLE_MAX_CHARS).join("")}…`
    : flat;
};

/**
 * 批量删除确认框里的「到底会删哪些」清单（纯函数，多行文本——弹窗描述要有 whitespace-pre-line 才会换行）。
 *
 * 为什么：确认框原来只说「N 项、体积」，不列标题。手动勾选 / 快捷选中混在一起时，
 * 用户没法在点「删除」前再看一眼删的是什么；受保护的会话（置顶 / 在跑 / 带定时）被手选进来也不拦，
 * 但要在这里明说。
 *
 * 版式：最多 BATCH_DELETE_LIST_MAX 个标题，每个一行；超出显示「…另有 N 个会话」；
 * 残留工作区不逐个列，合成一行；有受保护项时才多一行「其中含置顶 x、带定时 y、在跑 z」（只列 > 0 的）。
 * 没有任何会话也没有残留工作区时返回空串（调用方据此决定拼不拼）。
 */
export const buildBatchDeleteSummary = (
  rows: ReadonlyArray<
    Pick<
      SessionRowLike,
      "title" | "pinned" | "runStatus" | "backgroundSubagentCount" | "hasLiveSchedule"
    >
  >,
  staleWorktreeCount: number,
): string => {
  const lines: string[] = [];
  for (const t of rows.slice(0, BATCH_DELETE_LIST_MAX)) {
    lines.push(`· ${shortenTitle(t.title)}`);
  }
  if (rows.length > BATCH_DELETE_LIST_MAX) {
    lines.push(`· …另有 ${rows.length - BATCH_DELETE_LIST_MAX} 个会话`);
  }
  if (staleWorktreeCount > 0) {
    lines.push(`· ${staleWorktreeCount} 个残留工作区`);
  }
  const pinned = rows.filter((t) => t.pinned === true).length;
  const scheduled = rows.filter((t) => t.hasLiveSchedule === true).length;
  const running = rows.filter(
    (t) => t.runStatus === "running" || hasBackgroundSubagents(t),
  ).length;
  const flags: string[] = [];
  if (pinned > 0) flags.push(`置顶 ${pinned}`);
  if (scheduled > 0) flags.push(`带定时 ${scheduled}`);
  if (running > 0) flags.push(`在跑 ${running}`);
  if (flags.length > 0) lines.push(`其中含${flags.join("、")}`);
  return lines.join("\n");
};
