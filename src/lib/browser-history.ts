/**
 * 内置浏览器「地址栏记忆」：访问历史的存储与联想共用的纯逻辑（无 node / DOM 依赖，可在任何环境里测）。
 *
 * 记什么：只记「用户自己在地址栏敲进去（或从联想里选中）并且成功打开」的网址——
 * AI 导航、无痕标签、搜索词、页面里点出来的链接都不记（判定见 components/browser/typed-visit.ts）。
 * 所以它是「我常敲的网址」，不是 Chrome 那种完整的浏览历史。
 *
 * URL 口径与收藏夹共用 normalizeBookmarkUrl：联想列表里要标出「已收藏」，
 * 两边的规整化只要差一个字符（尾斜杠、默认端口、host 大小写、userinfo）就对不上。
 * 安全口径同收藏夹：只收 http / https、userinfo 剥掉、标题是页面可控文字、入库与展示前都过 clipOneLine。
 * 条数上限 1000，满了淘汰最久没访问的——历史本来就是「记个大概」，和收藏夹「满了拒绝」相反。
 */
import { displayBookmarkUrl, normalizeBookmarkUrl, BOOKMARK_ID_MAX, type Bookmark } from "./browser-bookmarks";
import { clipOneLine } from "./one-line";

/** 历史最多放多少条：满了淘汰最久没访问的 */
export const HISTORY_LIMIT = 1000;
/** 标题长度上限（超出截断加省略号） */
export const HISTORY_TITLE_MAX = 200;
/** 访问次数封顶（防手改文件塞个天文数字把排序顶死） */
export const HISTORY_VISIT_COUNT_MAX = 1_000_000;
/** 联想下拉最多显示几条 */
export const ADDRESS_SUGGESTION_LIMIT = 6;
/** 参与匹配的输入长度上限（再长的串不可能是在找某个已访问的网址） */
export const ADDRESS_QUERY_MAX = 200;

export interface HistoryEntry {
  id: string;
  /** 规整后的 href（已剥 userinfo、host 小写、默认端口省略） */
  url: string;
  /** 清洗后的单行标题；页面没给标题时是主机名 */
  title: string;
  /** 累计访问次数（≥1） */
  visitCount: number;
  /** 最近一次访问的时间，epoch 毫秒 */
  lastVisitAt: number;
}

/** URL 规整：和收藏夹是同一份（见文件头） */
export const normalizeHistoryUrl = normalizeBookmarkUrl;

/** 清洗标题；清洗后为空（没给 / 全是控制字符）→ 用主机名兜底 */
export const cleanHistoryTitle = (title: unknown, fallbackHost: string): string =>
  clipOneLine(typeof title === "string" ? title : "", HISTORY_TITLE_MAX) || fallbackHost;

/** 按最近访问时间倒序（稳定：时间戳相同的保持原有相对顺序） */
export const sortHistory = (list: readonly HistoryEntry[]): HistoryEntry[] =>
  list
    .map((e, i) => [e, i] as const)
    .sort((a, b) => b[0].lastVisitAt - a[0].lastVisitAt || a[1] - b[1])
    .map(([e]) => e);

const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= BOOKMARK_ID_MAX && !/[\p{Cc}\p{Cf}\s]/u.test(v);
const clampCount = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(HISTORY_VISIT_COUNT_MAX, Math.max(1, Math.floor(v))) : 1;

/**
 * 把「盘上的 / 接口回来的」原始值收成合法列表：逐条校验，坏条目丢掉（不让一条坏数据废掉整份历史），
 * URL 重新规整（手改文件带了 userinfo 也会被剥掉）、按 URL / id 去重（保留最近访问的）、倒序、截到上限。
 * 不是数组 → 空列表。
 */
export const parseHistoryList = (raw: unknown): HistoryEntry[] => {
  if (!Array.isArray(raw)) return [];
  const items: HistoryEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!validId(e.id)) continue;
    const normalized = normalizeHistoryUrl(e.url);
    if (!normalized.ok) continue;
    const lastVisitAt = typeof e.lastVisitAt === "number" && Number.isFinite(e.lastVisitAt) && e.lastVisitAt >= 0 ? e.lastVisitAt : 0;
    items.push({
      id: e.id,
      url: normalized.url,
      title: cleanHistoryTitle(e.title, normalized.hostname),
      visitCount: clampCount(e.visitCount),
      lastVisitAt,
    });
  }
  const seenUrl = new Set<string>();
  const seenId = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const e of sortHistory(items)) {
    // 同 URL / 同 id 只留最近的一条（id 撞了会让「按 id 删除」删错）
    if (seenUrl.has(e.url) || seenId.has(e.id)) continue;
    seenUrl.add(e.url);
    seenId.add(e.id);
    out.push(e);
  }
  return out.slice(0, HISTORY_LIMIT);
};

export interface VisitInput {
  url: unknown;
  /** 页面标题；没有 / 不可信就传空串——已有条目的标题不会被空标题覆盖 */
  title?: unknown;
  /** 访问时间，epoch 毫秒 */
  at: number;
  /** 新条目的 id（服务端传 randomUUID；已有条目沿用旧 id） */
  makeId: () => string;
}

/**
 * 记一次访问：同一个地址累加次数、刷新最近访问时间和标题（空标题不覆盖旧标题），新地址插到最前；
 * 超过上限时淘汰最久没访问的。地址不可记录（非 http(s) / 无法解析 / 过长）→ null。
 * 纯函数：不改入参，返回新列表。
 */
export const upsertVisit = (list: readonly HistoryEntry[], visit: VisitInput): { list: HistoryEntry[]; entry: HistoryEntry; created: boolean } | null => {
  const normalized = normalizeHistoryUrl(visit.url);
  if (!normalized.ok) return null;
  // 「刚刚访问」按定义就是最新的：系统时钟被往回拨过时，新访问的时间不能比已有记录还早，
  // 否则它一入库就排到队尾、满员时当场被淘汰
  const newest = list.reduce((m, e) => Math.max(m, e.lastVisitAt), 0);
  const at = Math.max(newest, Number.isFinite(visit.at) && visit.at >= 0 ? visit.at : 0);
  const existing = list.find((e) => e.url === normalized.url);
  const cleaned = clipOneLine(typeof visit.title === "string" ? visit.title : "", HISTORY_TITLE_MAX);
  const entry: HistoryEntry = existing
    ? {
        ...existing,
        title: cleaned || existing.title,
        visitCount: Math.min(HISTORY_VISIT_COUNT_MAX, existing.visitCount + 1),
        lastVisitAt: at,
      }
    : { id: visit.makeId(), url: normalized.url, title: cleaned || normalized.hostname, visitCount: 1, lastVisitAt: at };
  const next = sortHistory([entry, ...list.filter((e) => e !== existing)]).slice(0, HISTORY_LIMIT);
  return { list: next, entry, created: !existing };
};

/** 删掉某一条（按 id）；没有这条 → 原样返回同一个数组引用，调用方据此判断「是否真的删了」 */
export const removeVisit = (list: readonly HistoryEntry[], id: string): readonly HistoryEntry[] => {
  const next = list.filter((e) => e.id !== id);
  return next.length === list.length ? list : next;
};

/** 客户端收到服务端返回的条目后合并进本地列表：同 URL / 同 id 的旧条目被替换，重新排序、截到上限 */
export const mergeEntry = (list: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] =>
  sortHistory([entry, ...list.filter((e) => e.id !== entry.id && e.url !== entry.url)]).slice(0, HISTORY_LIMIT);

// ───────────────────────── 联想 ─────────────────────────

export interface AddressSuggestion {
  /** 规整后的 href：选中它就是打开它 */
  url: string;
  title: string;
  /** 来自历史记录时的条目 id（可以被「×」删掉）；只在收藏夹里的为 null */
  historyId: string | null;
  bookmarked: boolean;
}

const DAY_MS = 86_400_000;
/** 收藏过的地址加分：同样熟的两个地址，收藏过的排前面 */
const BOOKMARK_BONUS = 60;

/**
 * 「又常去又刚去过」的分数：越近权重越大，次数按对数增长（敲过 50 次不该把昨天才敲的新网址压到天边）。
 * 参考 Chrome 的 frecency：分段衰减 × (1 + log2(次数))。
 */
export const frecency = (visitCount: number, lastVisitAt: number, now: number): number => {
  const ageDays = Math.max(0, (now - lastVisitAt) / DAY_MS);
  const recency = ageDays <= 4 ? 100 : ageDays <= 14 ? 70 : ageDays <= 31 ? 50 : ageDays <= 90 ? 30 : 10;
  return recency * (1 + Math.log2(Math.max(1, visitCount)));
};

/** 去协议、去末尾斜杠、去开头的 www.、转小写：联想匹配用（只是匹配口径，打开用的永远是完整的 url） */
const bareOf = (url: string): string => displayBookmarkUrl(url).toLowerCase().replace(/^www\./, "");

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** 标题里有没有某个词以 token 开头（词边界 = 标题开头或前一个字符不是字母 / 数字） */
const titleWordStartsWith = (title: string, token: string): boolean => {
  for (let from = title.indexOf(token); from !== -1; from = title.indexOf(token, from + 1)) {
    if (from === 0 || !/[\p{L}\p{N}]/u.test(title[from - 1] ?? "")) return true;
  }
  return false;
};

/**
 * 匹配档位（越小越靠前）；不匹配 → null。
 * 所有词都得出现在「地址或标题」里；档位只看第一个词（人敲的第一个词最能说明意图）：
 * 0 地址从头匹配 / 1 主机名的某一段以它开头 / 2 地址里包含 / 3 标题里某个词以它开头 / 4 标题里包含
 */
const matchTier = (bare: string, host: string, title: string, tokens: readonly string[]): number | null => {
  for (const t of tokens) if (!bare.includes(t) && !title.includes(t)) return null;
  const first = tokens[0]!;
  if (bare.startsWith(first)) return 0;
  if (host.split(".").some((label) => label.startsWith(first))) return 1;
  if (bare.includes(first)) return 2;
  if (titleWordStartsWith(title, first)) return 3;
  return 4;
};

interface Candidate {
  suggestion: AddressSuggestion;
  tier: number;
  score: number;
  lastVisitAt: number;
}

/**
 * 地址栏联想：在「历史 + 收藏夹」里按输入匹配地址与标题，常去 / 刚去过的、收藏过的排前面。
 * 同一个地址（规整后）历史与收藏夹各有一条时合并成一条（标 bookmarked、保留历史 id）。
 * 输入为空 / 全是空白 → []；没有任何东西匹配 → []。
 */
export const suggestAddresses = (input: {
  query: string;
  history: readonly HistoryEntry[];
  bookmarks: readonly Bookmark[];
  now: number;
  limit?: number;
}): AddressSuggestion[] => {
  const query = input.query.trim().slice(0, ADDRESS_QUERY_MAX).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const limit = Math.max(0, input.limit ?? ADDRESS_SUGGESTION_LIMIT);

  const byUrl = new Map<string, Candidate>();
  const consider = (url: string, title: string, historyId: string | null, bookmarked: boolean, baseScore: number, lastVisitAt: number) => {
    const tier = matchTier(bareOf(url), hostOf(url), title.toLowerCase(), tokens);
    if (tier === null) return;
    const prev = byUrl.get(url);
    if (!prev) {
      byUrl.set(url, { suggestion: { url, title, historyId, bookmarked }, tier, score: baseScore + (bookmarked ? BOOKMARK_BONUS : 0), lastVisitAt });
      return;
    }
    // 同一个地址的第二条来源：合并（历史 id 与标题以历史为准；已收藏标记补上并加分）
    if (historyId !== null) {
      prev.suggestion.historyId = historyId;
      prev.suggestion.title = title;
      prev.score += baseScore;
      prev.lastVisitAt = Math.max(prev.lastVisitAt, lastVisitAt);
    }
    if (bookmarked && !prev.suggestion.bookmarked) {
      prev.suggestion.bookmarked = true;
      prev.score += BOOKMARK_BONUS;
    }
    prev.tier = Math.min(prev.tier, tier);
  };

  for (const e of input.history) consider(e.url, e.title, e.id, false, frecency(e.visitCount, e.lastVisitAt, input.now), e.lastVisitAt);
  for (const b of input.bookmarks) {
    const n = normalizeHistoryUrl(b.url);
    if (!n.ok) continue;
    // 只在收藏夹里的地址：按「访问过 1 次、收藏的那一刻」算基础分
    consider(n.url, b.title, null, true, frecency(1, b.createdAt, input.now), b.createdAt);
  }

  return [...byUrl.values()]
    .sort((a, b) => a.tier - b.tier || b.score - a.score || b.lastVisitAt - a.lastVisitAt || (a.suggestion.url < b.suggestion.url ? -1 : a.suggestion.url > b.suggestion.url ? 1 : 0))
    .slice(0, limit)
    .map((c) => c.suggestion);
};
