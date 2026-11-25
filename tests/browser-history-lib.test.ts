/**
 * 地址栏记忆的纯逻辑（src/lib/browser-history.ts）：
 * URL 口径与收藏夹一致、列表解析的容错、记一次访问（累加 / 标题不被空标题冲掉 / 满员淘汰 / 时钟回拨）、
 * 联想的匹配档位与排序（前缀 > 主机名段 > 地址包含 > 标题词首 > 标题包含；常去 + 刚去过 + 收藏过的靠前）、历史与收藏夹的合并。
 */
import { describe, expect, it } from "vitest";

import { normalizeBookmarkUrl, type Bookmark } from "@/lib/browser-bookmarks";
import {
  ADDRESS_QUERY_MAX,
  ADDRESS_SUGGESTION_LIMIT,
  HISTORY_LIMIT,
  HISTORY_TITLE_MAX,
  HISTORY_VISIT_COUNT_MAX,
  cleanHistoryTitle,
  frecency,
  mergeEntry,
  normalizeHistoryUrl,
  parseHistoryList,
  removeVisit,
  sortHistory,
  suggestAddresses,
  upsertVisit,
  type HistoryEntry,
} from "@/lib/browser-history";

import { hist } from "./helpers/history-fake-fetch";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const ids = (list: readonly { id: string }[]) => list.map((e) => e.id);
const mk = () => {
  let n = 0;
  return () => `id-${(n += 1)}`;
};
const bk = (i: number, over: Partial<Bookmark> = {}): Bookmark => ({ id: `b-${i}`, url: `https://example.com/b${i}`, title: `bookmark ${i}`, createdAt: NOW - i * DAY, ...over });

describe("URL 口径：与收藏夹是同一份", () => {
  it.each([
    "https://Example.COM:443/a?b=1#x",
    "http://user:pass@host.example/path",
    "https://a.example",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "not a url",
    "",
    "   ",
  ])("%s → 与 normalizeBookmarkUrl 一致", (input) => {
    expect(normalizeHistoryUrl(input)).toEqual(normalizeBookmarkUrl(input));
  });

  it("userinfo 被剥掉、host 小写、默认端口省略", () => {
    expect(normalizeHistoryUrl("https://u:p@Example.COM:443/x")).toMatchObject({ ok: true, url: "https://example.com/x" });
  });
});

describe("cleanHistoryTitle", () => {
  it("剥方向控制 / 控制字符、压平空白", () => {
    expect(cleanHistoryTitle("  a\u202Eb \n c\u0007 ", "h")).toBe("ab c");
  });

  it("空 / 非字符串 / 全是控制字符 → 主机名兜底", () => {
    expect(cleanHistoryTitle("", "h.example")).toBe("h.example");
    expect(cleanHistoryTitle(undefined, "h.example")).toBe("h.example");
    expect(cleanHistoryTitle(42, "h.example")).toBe("h.example");
    expect(cleanHistoryTitle("\u200B\u202E \n", "h.example")).toBe("h.example");
  });

  it("超长截断（上限 + 省略号）", () => {
    const t = cleanHistoryTitle("字".repeat(HISTORY_TITLE_MAX + 50), "h");
    expect(t.length).toBe(HISTORY_TITLE_MAX + 1);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("sortHistory", () => {
  it("按最近访问倒序；时间相同保持原相对顺序（稳定）；不改入参", () => {
    const input = [hist(1, { lastVisitAt: 5 }), hist(2, { lastVisitAt: 9 }), hist(3, { lastVisitAt: 5 })];
    const before = JSON.stringify(input);
    expect(ids(sortHistory(input))).toEqual(["h-2", "h-1", "h-3"]);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("parseHistoryList", () => {
  it("不是数组 → 空列表", () => {
    for (const raw of [null, undefined, {}, "x", 3, { history: [] }]) expect(parseHistoryList(raw)).toEqual([]);
  });

  it("逐条校验：没 id / id 离谱 / 地址不合法 / 非对象 的丢掉，好的留下", () => {
    const good = hist(1);
    const out = parseHistoryList([
      good,
      null,
      "str",
      { ...hist(2), id: "" },
      { ...hist(3), id: "a b" },
      { ...hist(4), id: "x".repeat(65) },
      { ...hist(5), url: "javascript:alert(1)" },
      { ...hist(6), url: "file:///etc/passwd" },
      { ...hist(7), url: 42 },
    ]);
    expect(out).toEqual([good]);
  });

  it("URL 重新规整（手改文件带了 userinfo 也剥掉）；标题重新清洗；空标题用主机名", () => {
    const [e] = parseHistoryList([{ id: "a", url: "https://user:secret@Example.COM:443/p", title: "x\u202Ey", visitCount: 2, lastVisitAt: 5 }]);
    expect(e!.url).toBe("https://example.com/p");
    expect(e!.title).toBe("xy");
    const [e2] = parseHistoryList([{ id: "b", url: "https://h.example/", title: "", visitCount: 1, lastVisitAt: 1 }]);
    expect(e2!.title).toBe("h.example");
  });

  it("visitCount / lastVisitAt 容错：非数 → 1 / 0；小数取整；负数、0 → 1；超大封顶", () => {
    const [a, b, c, d, e] = parseHistoryList([
      { ...hist(1), visitCount: "3", lastVisitAt: "9" },
      { ...hist(2), visitCount: 2.9, lastVisitAt: -5 },
      { ...hist(3), visitCount: 0 },
      { ...hist(4), visitCount: -7 },
      { ...hist(5), visitCount: 1e12 },
    ]);
    // 排序后 lastVisitAt 都是 0 或 1005 / 1004 / 1003：按各自值倒序
    const byId = Object.fromEntries([a, b, c, d, e].map((x) => [x!.id, x!]));
    expect(byId["h-1"]).toMatchObject({ visitCount: 1, lastVisitAt: 0 });
    expect(byId["h-2"]).toMatchObject({ visitCount: 2, lastVisitAt: 0 });
    expect(byId["h-3"]!.visitCount).toBe(1);
    expect(byId["h-4"]!.visitCount).toBe(1);
    expect(byId["h-5"]!.visitCount).toBe(HISTORY_VISIT_COUNT_MAX);
  });

  it("同 URL（规整后）只留最近的一条；同 id 只留最近的一条", () => {
    const out = parseHistoryList([
      { ...hist(1), url: "https://a.example/x", lastVisitAt: 10 },
      { ...hist(2), url: "https://A.EXAMPLE:443/x", lastVisitAt: 30 },
      { ...hist(3), id: "dup", url: "https://b.example/", lastVisitAt: 20 },
      { ...hist(4), id: "dup", url: "https://c.example/", lastVisitAt: 5 },
    ]);
    expect(ids(out)).toEqual(["h-2", "dup"]);
    expect(out[1]!.url).toBe("https://b.example/");
  });

  it("倒序、截到上限（留最近的 HISTORY_LIMIT 条）", () => {
    const raw = Array.from({ length: HISTORY_LIMIT + 25 }, (_, i) => hist(i));
    const out = parseHistoryList(raw);
    expect(out).toHaveLength(HISTORY_LIMIT);
    expect(out[0]!.id).toBe(`h-${HISTORY_LIMIT + 24}`);
    expect(out.at(-1)!.id).toBe("h-25");
  });
});

describe("upsertVisit", () => {
  const visit = (url: unknown, over: Partial<{ title: unknown; at: number }> = {}, makeId = mk()) => ({ url, at: NOW, makeId, ...over });

  it("新地址：规整地址、清洗标题、次数 1、created=true、插到最前", () => {
    const base = [hist(1)];
    const r = upsertVisit(base, visit("https://Example.COM:443/a", { title: "  Hi \n there " }))!;
    expect(r.created).toBe(true);
    expect(r.entry).toMatchObject({ id: "id-1", url: "https://example.com/a", title: "Hi there", visitCount: 1, lastVisitAt: NOW });
    expect(ids(r.list)).toEqual(["id-1", "h-1"]);
    expect(base).toEqual([hist(1)]); // 不改入参
  });

  it("新地址没给标题 → 主机名", () => {
    expect(upsertVisit([], visit("https://docs.example.com/x"))!.entry.title).toBe("docs.example.com");
    expect(upsertVisit([], visit("https://docs.example.com/x", { title: "\u200B" }))!.entry.title).toBe("docs.example.com");
  });

  it("同一个地址（规整后）再记：次数 +1、时间刷新、沿用旧 id、不产生重复、顶到最前", () => {
    const base = [hist(2), hist(1, { url: "https://example.com/a", visitCount: 4, lastVisitAt: 10 })];
    const makeId = () => {
      throw new Error("不该为已有条目生成新 id");
    };
    const r = upsertVisit(base, { url: "https://EXAMPLE.com:443/a", title: "新标题", at: NOW, makeId })!;
    expect(r.created).toBe(false);
    expect(r.entry).toMatchObject({ id: "h-1", visitCount: 5, lastVisitAt: NOW, title: "新标题" });
    expect(ids(r.list)).toEqual(["h-1", "h-2"]);
  });

  it("空标题 / 全是控制字符的标题不覆盖旧标题；真标题会更新", () => {
    const base = [hist(1, { url: "https://example.com/a", title: "好标题" })];
    expect(upsertVisit(base, visit("https://example.com/a", { title: "" }))!.entry.title).toBe("好标题");
    expect(upsertVisit(base, visit("https://example.com/a", { title: "\u200B\u202E" }))!.entry.title).toBe("好标题");
    expect(upsertVisit(base, visit("https://example.com/a"))!.entry.title).toBe("好标题");
    expect(upsertVisit(base, visit("https://example.com/a", { title: "改名了" }))!.entry.title).toBe("改名了");
  });

  it("地址不可记录 → null（非 http(s) / 解析不了 / 非字符串 / 过长）", () => {
    for (const url of ["file:///x", "javascript:1", "chrome-error://chromewebdata/", "about:blank", "nope", "", null, 5, `https://a.example/${"x".repeat(2100)}`]) {
      expect(upsertVisit([], visit(url)), String(url)).toBeNull();
    }
  });

  it("满员：淘汰最久没访问的，新的留下", () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => hist(i, { lastVisitAt: 1_000 + i }));
    const r = upsertVisit(full, visit("https://new.example/"))!;
    expect(r.list).toHaveLength(HISTORY_LIMIT);
    expect(r.list[0]!.url).toBe("https://new.example/");
    expect(ids(r.list)).not.toContain("h-0"); // 最久没访问的被淘汰
    expect(ids(r.list)).toContain("h-1");
  });

  it("满员时再记一个已有地址：不淘汰任何条目", () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => hist(i));
    const r = upsertVisit(full, visit("https://example.com/p0"))!;
    expect(r.created).toBe(false);
    expect(r.list).toHaveLength(HISTORY_LIMIT);
    expect(r.list[0]!.id).toBe("h-0");
  });

  it("系统时钟被往回拨：新访问的时间不会比已有记录还早（否则一入库就排队尾、满员时当场被淘汰）", () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => hist(i, { lastVisitAt: NOW + i }));
    const r = upsertVisit(full, visit("https://new.example/", { at: NOW - 365 * DAY }))!;
    expect(r.entry.lastVisitAt).toBe(NOW + HISTORY_LIMIT - 1);
    expect(r.list[0]!.url).toBe("https://new.example/");
    expect(r.list).toContain(r.entry);
  });

  it("访问次数封顶；at 非法按 0（再与已有最新时间取大）", () => {
    const base = [hist(1, { url: "https://example.com/a", visitCount: HISTORY_VISIT_COUNT_MAX, lastVisitAt: 77 })];
    const r = upsertVisit(base, visit("https://example.com/a", { at: Number.NaN }))!;
    expect(r.entry.visitCount).toBe(HISTORY_VISIT_COUNT_MAX);
    expect(r.entry.lastVisitAt).toBe(77);
  });
});

describe("removeVisit / mergeEntry", () => {
  it("removeVisit：删到了 → 新数组；没这条 → 原样返回同一个引用", () => {
    const list = [hist(1), hist(2)];
    expect(ids(removeVisit(list, "h-1"))).toEqual(["h-2"]);
    expect(removeVisit(list, "nope")).toBe(list);
    expect(list).toHaveLength(2);
  });

  it("mergeEntry：同 id / 同 URL 的旧条目被替换，按时间重新排序", () => {
    const list = [hist(3), hist(2), hist(1)];
    const merged = mergeEntry(list, hist(1, { lastVisitAt: 9_999, visitCount: 7 }));
    expect(ids(merged)).toEqual(["h-1", "h-3", "h-2"]);
    expect(merged[0]!.visitCount).toBe(7);
    // 同 URL、不同 id（别处记的）也替换，不会出现两条同地址
    const merged2 = mergeEntry(list, { ...hist(9), url: list[1]!.url });
    expect(merged2.filter((e) => e.url === list[1]!.url)).toHaveLength(1);
    expect(ids(merged2)).toContain("h-9");
    expect(ids(merged2)).not.toContain("h-2");
  });
});

describe("frecency", () => {
  it("越近权重越大（分段：≤4 天 / ≤14 / ≤31 / ≤90 / 更久）", () => {
    const at = (days: number) => frecency(1, NOW - days * DAY, NOW);
    expect([at(0), at(4), at(5), at(14), at(15), at(31), at(32), at(90), at(91)]).toEqual([100, 100, 70, 70, 50, 50, 30, 30, 10]);
  });

  it("次数按对数增长：1 次 ×1，2 次 ×2，8 次 ×4；0 / 负数按 1 次", () => {
    const f = (n: number) => frecency(n, NOW, NOW);
    expect([f(1), f(2), f(8)]).toEqual([100, 200, 400]);
    expect(f(0)).toBe(f(1));
    expect(f(-3)).toBe(f(1));
  });

  it("时间在「未来」（时钟漂移）按刚刚算", () => {
    expect(frecency(1, NOW + 5 * DAY, NOW)).toBe(100);
  });
});

describe("suggestAddresses：匹配", () => {
  const H = (url: string, title: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
    id: `id:${url}`,
    url,
    title,
    visitCount: 1,
    lastVisitAt: NOW,
    ...over,
  });
  const run = (query: string, history: HistoryEntry[], bookmarks: Bookmark[] = [], extra: { limit?: number } = {}) =>
    suggestAddresses({ query, history, bookmarks, now: NOW, ...extra });
  const urls = (r: { url: string }[]) => r.map((s) => s.url);

  it("空输入 / 全是空白 / 只有协议头 → 没有联想", () => {
    const h = [H("https://github.com/", "GitHub")];
    for (const q of ["", "   ", "https://", "http://www.", "www."]) expect(run(q, h), JSON.stringify(q)).toEqual([]);
  });

  it("没有任何东西匹配 → []", () => {
    expect(run("zzzz", [H("https://github.com/", "GitHub")])).toEqual([]);
  });

  it("按地址匹配：忽略协议、www.、大小写、末尾斜杠", () => {
    const h = [H("https://www.github.com/", "x"), H("https://gitlab.com/", "y")];
    expect(urls(run("GIT", h))).toHaveLength(2);
    expect(urls(run("https://git", h))).toHaveLength(2);
    expect(urls(run("www.github", h))).toEqual(["https://www.github.com/"]);
    expect(urls(run("github.com", h))).toEqual(["https://www.github.com/"]);
  });

  it("带端口 / 路径 / 查询的输入也能前缀匹配", () => {
    const h = [H("http://localhost:3000/app?x=1", "local")];
    expect(urls(run("localhost:3000/a", h))).toEqual(["http://localhost:3000/app?x=1"]);
    expect(urls(run("http://localhost:3000/app?x", h))).toEqual(["http://localhost:3000/app?x=1"]);
  });

  it("按标题匹配（包含即可），中文标题也行", () => {
    const h = [H("https://tq.example/", "今日天气预报"), H("https://other.example/", "无关")];
    expect(urls(run("天气", h))).toEqual(["https://tq.example/"]);
    expect(urls(run("PRE", [H("https://a.example/", "Release Notes")]))).toEqual([]);
    expect(urls(run("NOTES", [H("https://a.example/", "Release Notes")]))).toEqual(["https://a.example/"]);
  });

  it("多个词：每个词都得出现在「地址或标题」里（可以分处两边）", () => {
    const h = [H("https://github.com/issues", "Issues · Pull requests"), H("https://github.com/", "GitHub")];
    expect(urls(run("github issues", h))).toEqual(["https://github.com/issues"]);
    expect(urls(run("github pull", h))).toEqual(["https://github.com/issues"]);
    expect(urls(run("github nothing", h))).toEqual([]);
  });

  it("档位：地址前缀 > 主机名某段开头 > 地址里包含 > 标题词首 > 标题里包含（各档位同分时按档位排）", () => {
    // 每条都「同样熟」（次数 / 时间一致），排序只能由档位决定
    const h = [
      H("https://x.example/", "xx tool box"), //                 标题词首：tool
      H("https://x.example/y", "stool"), //                      标题里包含：tool
      H("https://x.example/a/tool", "z"), //                     地址里包含
      H("https://my.tool.example/", "z"), //                     主机名某段以 tool 开头
      H("https://tool.example/", "z"), //                        地址前缀
    ];
    expect(urls(run("tool", h))).toEqual([
      "https://tool.example/",
      "https://my.tool.example/",
      "https://x.example/a/tool",
      "https://x.example/",
      "https://x.example/y",
    ]);
  });

  it("同档位内：次数多且刚去过的靠前（频率按对数增长，不压过更近的）", () => {
    const h = [
      H("https://a.example/one", "t", { visitCount: 1, lastVisitAt: NOW - 100 * DAY }),
      H("https://a.example/many", "t", { visitCount: 9, lastVisitAt: NOW - 100 * DAY }),
      H("https://a.example/new", "t", { visitCount: 1, lastVisitAt: NOW - DAY }),
    ];
    // new: 100×1=100；many: 10×(1+log2 9)=10×4.17=41.7；one: 10
    expect(urls(run("a.example/", h))).toEqual(["https://a.example/new", "https://a.example/many", "https://a.example/one"]);
  });

  it("完全同分时按最近访问、再按地址排，结果稳定", () => {
    const h = [H("https://b.example/", "t", { lastVisitAt: NOW }), H("https://a.example/", "t", { lastVisitAt: NOW }), H("https://c.example/", "t", { lastVisitAt: NOW - 1 })];
    expect(urls(run("example", h))).toEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
    expect(urls(run("example", [...h].reverse()))).toEqual(urls(run("example", h)));
  });

  it("默认最多 6 条；可传 limit；limit=0 → []", () => {
    const h = Array.from({ length: 12 }, (_, i) => H(`https://s${i}.example/`, "t"));
    expect(run("s", h)).toHaveLength(ADDRESS_SUGGESTION_LIMIT);
    expect(ADDRESS_SUGGESTION_LIMIT).toBe(6);
    expect(run("s", h, [], { limit: 3 })).toHaveLength(3);
    expect(run("s", h, [], { limit: 0 })).toEqual([]);
  });

  it("超长输入不炸（只取前 ADDRESS_QUERY_MAX 个字符参与匹配）", () => {
    const r = suggestAddresses({ query: `github${"x".repeat(ADDRESS_QUERY_MAX * 3)}`, history: [H("https://github.com/", "GitHub")], bookmarks: [], now: NOW });
    expect(r).toEqual([]);
    expect(suggestAddresses({ query: `${"g".repeat(ADDRESS_QUERY_MAX)}zzz`, history: [H(`https://${"g".repeat(ADDRESS_QUERY_MAX)}.example/`, "t")], bookmarks: [], now: NOW })).toHaveLength(1);
  });

  it("不改入参", () => {
    const history = [H("https://github.com/", "GitHub")];
    const bookmarks = [bk(1)];
    const before = JSON.stringify({ history, bookmarks });
    suggestAddresses({ query: "g", history, bookmarks, now: NOW });
    suggestAddresses({ query: "b", history, bookmarks, now: NOW });
    expect(JSON.stringify({ history, bookmarks })).toBe(before);
  });

  it("历史里夹了不合法地址的收藏（手改文件）：忽略，不炸", () => {
    const r = suggestAddresses({ query: "x", history: [], bookmarks: [{ ...bk(1), url: "javascript:alert(1)", title: "x" }], now: NOW });
    expect(r).toEqual([]);
  });
});

describe("suggestAddresses：与收藏夹合并", () => {
  const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({ id: "h1", url: "https://example.com/a", title: "历史标题", visitCount: 3, lastVisitAt: NOW - DAY, ...over });

  it("只在收藏夹里的地址也会出现：historyId=null、bookmarked=true（不能被「×」删）", () => {
    const r = suggestAddresses({ query: "bookmark 1", history: [], bookmarks: [bk(1)], now: NOW });
    expect(r).toEqual([{ url: "https://example.com/b1", title: "bookmark 1", historyId: null, bookmarked: true }]);
  });

  it("历史和收藏夹里是同一个地址（规整后）→ 合并成一条：标 bookmarked、保留历史 id 与历史标题", () => {
    const r = suggestAddresses({
      query: "example.com/a",
      history: [entry()],
      bookmarks: [bk(1, { url: "https://EXAMPLE.com:443/a", title: "收藏标题" })],
      now: NOW,
    });
    expect(r).toEqual([{ url: "https://example.com/a", title: "历史标题", historyId: "h1", bookmarked: true }]);
  });

  it("只在历史里：bookmarked=false、带 historyId", () => {
    const r = suggestAddresses({ query: "example.com/a", history: [entry()], bookmarks: [], now: NOW });
    expect(r).toEqual([{ url: "https://example.com/a", title: "历史标题", historyId: "h1", bookmarked: false }]);
  });

  it("收藏过的加分：同档位、同样熟的两个地址，收藏过的排前面", () => {
    const a = entry({ id: "a", url: "https://same.example/a" });
    const b = entry({ id: "b", url: "https://same.example/b" });
    const r = suggestAddresses({ query: "same.example", history: [a, b], bookmarks: [bk(1, { url: "https://same.example/b" })], now: NOW });
    expect(r.map((s) => s.historyId)).toEqual(["b", "a"]);
    expect(r[0]!.bookmarked).toBe(true);
  });

  it("历史条目没匹配上、同地址的收藏标题匹配上：按收藏条目出现（historyId=null，只展示、不能被「×」删）", () => {
    const r = suggestAddresses({
      query: "我的收藏夹标题词",
      history: [entry({ title: "无关" })],
      bookmarks: [bk(1, { url: "https://example.com/a", title: "我的收藏夹标题词" })],
      now: NOW,
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ url: "https://example.com/a", bookmarked: true, historyId: null });
  });

  it("合并不会重复计入：同一个地址只出现一次", () => {
    const r = suggestAddresses({ query: "example", history: [entry()], bookmarks: [bk(1, { url: "https://example.com/a" }), bk(2, { url: "https://example.com/a" })], now: NOW });
    expect(r.filter((s) => s.url === "https://example.com/a")).toHaveLength(1);
  });
});
