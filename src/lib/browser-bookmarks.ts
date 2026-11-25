/**
 * 内置浏览器收藏夹：服务端存储与客户端 store / UI 共用的纯逻辑（无 node / DOM 依赖，可在任何环境里测）。
 *
 * 为什么口径要共用：「当前页是不是已收藏」在客户端按 URL 比（星标亮不亮），服务端按 URL 去重。
 * 两边的规整化只要差一个字符（尾斜杠、默认端口、host 大小写、userinfo），星标就会和服务端对不上——
 * 所以 URL 规整 / 标题清洗 / 列表解析 / 排序都放这里，两边 import 同一份。
 *
 * 安全口径：
 * - 只收 http / https（和内置浏览器能导航的范围一致；file: / javascript: / data: 收下来也打不开，还可能被当成别的东西渲染）；
 * - userinfo（`https://user:pass@host/`）一律剥掉：密码不该以明文落进 JSON、也不该出现在列表里；
 * - 标题是页面可控的文字：入库与展示前都过 `clipOneLine`（剥控制 / 格式字符、压平空白、截断），夹方向控制符伪装不了。
 */
import { clipOneLine } from "./one-line";

/** 收藏夹最多放多少条：满了拒绝新增（不自动淘汰最旧的——静默丢用户数据比报「已满」糟得多） */
export const BOOKMARK_LIMIT = 500;
/** 地址长度上限（规整后的 href） */
export const BOOKMARK_URL_MAX = 2048;
/** 标题长度上限（超出截断加省略号） */
export const BOOKMARK_TITLE_MAX = 200;
/** id 长度上限（服务端自己生成 UUID；手改文件时容忍别的写法，但不容忍离谱的长度） */
export const BOOKMARK_ID_MAX = 64;

export interface Bookmark {
  id: string;
  /** 规整后的 href（已剥 userinfo、host 小写、默认端口省略） */
  url: string;
  /** 清洗后的单行标题；页面没给标题时是主机名 */
  title: string;
  /** 收藏（或重新收藏）的时间，epoch 毫秒。列表按它倒序：最新的在最前 */
  createdAt: number;
}

export type NormalizedBookmarkUrl = { ok: true; url: string; hostname: string } | { ok: false; error: string };

/** 把任意输入规整成「可收藏的 URL」；不可收藏 → 带中文原因（直接给用户看） */
export const normalizeBookmarkUrl = (input: unknown): NormalizedBookmarkUrl => {
  if (typeof input !== "string") return { ok: false, error: "地址不是字符串" };
  const raw = input.trim();
  if (raw === "") return { ok: false, error: "地址为空" };
  // 先按原串长度拦：规整只会缩短（剥 userinfo），远超上限的串连解析都不必做
  if (raw.length > BOOKMARK_URL_MAX * 2) return { ok: false, error: `地址过长（上限 ${BOOKMARK_URL_MAX} 个字符）` };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "地址无法解析" };
  }
  // 解析后的 protocol 才算数：`java\nscript:` 这类被 WHATWG 剥掉换行后的伪装在这里现形
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "只能收藏 http / https 网页" };
  if (!u.hostname) return { ok: false, error: "地址缺少主机名" };
  u.username = "";
  u.password = "";
  const url = u.href;
  if (url.length > BOOKMARK_URL_MAX) return { ok: false, error: `地址过长（上限 ${BOOKMARK_URL_MAX} 个字符）` };
  return { ok: true, url, hostname: u.hostname };
};

/** 清洗标题；清洗后为空（没给 / 全是控制字符）→ 用主机名兜底 */
export const cleanBookmarkTitle = (title: unknown, fallbackHost: string): string =>
  clipOneLine(typeof title === "string" ? title : "", BOOKMARK_TITLE_MAX) || fallbackHost;

/** 按 createdAt 倒序（稳定：时间戳相同的保持原有相对顺序） */
export const sortBookmarks = (list: readonly Bookmark[]): Bookmark[] =>
  list
    .map((b, i) => [b, i] as const)
    .sort((a, b) => b[0].createdAt - a[0].createdAt || a[1] - b[1])
    .map(([b]) => b);

const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= BOOKMARK_ID_MAX && !/[\p{Cc}\p{Cf}\s]/u.test(v);

/**
 * 把「盘上的 / 接口回来的」原始值收成合法列表：逐条校验，坏条目丢掉（不让一条坏数据废掉整个收藏夹），
 * URL 重新规整（手改文件带了 userinfo 也会被剥掉）、按 URL 去重（保留 createdAt 最新的）、倒序、截到上限。
 * 不是数组 → 空列表。
 */
export const parseBookmarkList = (raw: unknown): Bookmark[] => {
  if (!Array.isArray(raw)) return [];
  const items: Bookmark[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!validId(e.id)) continue;
    const normalized = normalizeBookmarkUrl(e.url);
    if (!normalized.ok) continue;
    const createdAt = typeof e.createdAt === "number" && Number.isFinite(e.createdAt) && e.createdAt >= 0 ? e.createdAt : 0;
    items.push({ id: e.id, url: normalized.url, title: cleanBookmarkTitle(e.title, normalized.hostname), createdAt });
  }
  const seenUrl = new Set<string>();
  const seenId = new Set<string>();
  const out: Bookmark[] = [];
  for (const b of sortBookmarks(items)) {
    // 同 URL / 同 id 只留最新的一条（id 撞了会让「按 id 删除」删错）
    if (seenUrl.has(b.url) || seenId.has(b.id)) continue;
    seenUrl.add(b.url);
    seenId.add(b.id);
    out.push(b);
  }
  return out.slice(0, BOOKMARK_LIMIT);
};

/** 在列表里找某个地址（先按同一套规则规整）；地址本身不可收藏 → undefined */
export const findBookmarkByUrl = (list: readonly Bookmark[], url: unknown): Bookmark | undefined => {
  const normalized = normalizeBookmarkUrl(url);
  if (!normalized.ok) return undefined;
  return list.find((b) => b.url === normalized.url);
};

/** 列表里给人看的地址：去协议、去末尾的斜杠（`https://a.com/` → `a.com`）；只是展示，打开用的永远是完整的 url */
export const displayBookmarkUrl = (url: string): string => url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** 对话框里的过滤：标题或地址包含关键词（不区分大小写、忽略首尾空白）；关键词为空 → 原列表 */
export const filterBookmarks = (list: readonly Bookmark[], query: string): readonly Bookmark[] => {
  const q = query.trim().toLowerCase();
  if (q === "") return list;
  return list.filter((b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q));
};
