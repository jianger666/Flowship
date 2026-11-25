/**
 * 收藏夹的共用纯逻辑（src/lib/browser-bookmarks.ts）：URL 规整 / 标题清洗 / 列表解析 / 过滤。
 * 客户端「星标亮不亮」与服务端「按地址去重」共用这一份口径——这里钉死它：任何一边的规整差一个字符，星标就会和服务端对不上。
 */
import { describe, expect, it } from "vitest";

import {
  BOOKMARK_ID_MAX,
  BOOKMARK_LIMIT,
  BOOKMARK_TITLE_MAX,
  BOOKMARK_URL_MAX,
  cleanBookmarkTitle,
  displayBookmarkUrl,
  filterBookmarks,
  findBookmarkByUrl,
  normalizeBookmarkUrl,
  parseBookmarkList,
  sortBookmarks,
  type Bookmark,
} from "@/lib/browser-bookmarks";

const bm = (over: Partial<Bookmark> & Pick<Bookmark, "id">): Bookmark => ({
  url: `https://example.com/${over.id}`,
  title: over.id,
  createdAt: 1000,
  ...over,
});

describe("normalizeBookmarkUrl", () => {
  it("http / https 规整成 href：host 小写、默认端口省略、裸域名补根斜杠；路径 / 查询 / 片段原样保留", () => {
    expect(normalizeBookmarkUrl("https://Example.COM:443/a/B?q=1&r=2#frag")).toEqual({
      ok: true,
      url: "https://example.com/a/B?q=1&r=2#frag",
      hostname: "example.com",
    });
    expect(normalizeBookmarkUrl("http://example.com:80")).toMatchObject({ ok: true, url: "http://example.com/" });
    expect(normalizeBookmarkUrl("  https://example.com/x  ")).toMatchObject({ ok: true, url: "https://example.com/x" });
    // 非默认端口保留
    expect(normalizeBookmarkUrl("http://localhost:3000/app")).toMatchObject({ ok: true, url: "http://localhost:3000/app" });
  });

  it("片段不同就是不同的收藏（SPA 的路由常放在 # 后面）", () => {
    const a = normalizeBookmarkUrl("https://a.com/x#1");
    const b = normalizeBookmarkUrl("https://a.com/x#2");
    expect(a.ok && b.ok && a.url !== b.url).toBe(true);
  });

  it("userinfo（user:pass@）一律剥掉：密码不该以明文进收藏夹", () => {
    const r = normalizeBookmarkUrl("https://admin:s3cret@host.example.com/path?a=1");
    expect(r).toEqual({ ok: true, url: "https://host.example.com/path?a=1", hostname: "host.example.com" });
    expect(JSON.stringify(r)).not.toContain("s3cret");
    expect(JSON.stringify(r)).not.toContain("admin");
  });

  it("国际化域名按 punycode 规整（与浏览器地址栏同一口径）", () => {
    const r = normalizeBookmarkUrl("https://例え.jp/");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hostname).toBe("xn--r8jz45g.jp");
  });

  it("非 http(s) 一律拒绝（file / javascript / data / about / chrome / ftp / blob / 自定义协议）", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "about:blank",
      "chrome://settings",
      "ftp://example.com/x",
      "blob:https://example.com/uuid",
      "vbscript:msgbox(1)",
      "myapp://open?x=1",
    ]) {
      const r = normalizeBookmarkUrl(bad);
      expect(r.ok, bad).toBe(false);
    }
  });

  it("夹换行 / 制表符伪装协议（java\\nscript:）：WHATWG 剥掉后现形成 javascript:，照样拒绝", () => {
    expect(normalizeBookmarkUrl("java\nscript:alert(1)").ok).toBe(false);
    expect(normalizeBookmarkUrl("java\tscript:alert(1)").ok).toBe(false);
    expect(normalizeBookmarkUrl("  \n javascript:alert(1)").ok).toBe(false);
  });

  it("不是字符串 / 空 / 解析不了 / 缺主机名：带中文原因的失败（直接给用户看）", () => {
    for (const bad of [undefined, null, 42, {}, [], "", "   ", "not a url", "https://", "//example.com/x", "example.com/path"]) {
      const r = normalizeBookmarkUrl(bad);
      expect(r.ok, String(bad)).toBe(false);
      if (!r.ok) expect(r.error.length, String(bad)).toBeGreaterThan(0);
    }
  });

  it("规整口径跟浏览器的 URL 解析一致：special scheme 多余的斜杠被吞掉（http:///x 与浏览器一样当成主机 x）", () => {
    expect(normalizeBookmarkUrl("http:///x")).toMatchObject({ ok: true, url: "http://x/", hostname: "x" });
  });

  it("长度上限：规整后恰好 2048 个字符放行，多 1 个拒绝；超长原串不必解析直接拒", () => {
    const base = "https://a.com/";
    const atLimit = base + "x".repeat(BOOKMARK_URL_MAX - base.length);
    expect(atLimit).toHaveLength(BOOKMARK_URL_MAX);
    expect(normalizeBookmarkUrl(atLimit).ok).toBe(true);
    const over = normalizeBookmarkUrl(atLimit + "x");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(String(BOOKMARK_URL_MAX));
    expect(normalizeBookmarkUrl("https://a.com/" + "x".repeat(BOOKMARK_URL_MAX * 2)).ok).toBe(false);
  });

  it("剥 userinfo 后才算长度：原串略超、规整后不超的放行（规整只会缩短）", () => {
    const base = "https://a.com/";
    const path = "x".repeat(BOOKMARK_URL_MAX - base.length);
    const withCreds = `https://${"u".repeat(40)}:${"p".repeat(40)}@a.com/${path}`;
    expect(withCreds.length).toBeGreaterThan(BOOKMARK_URL_MAX);
    const r = normalizeBookmarkUrl(withCreds);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.length).toBeLessThanOrEqual(BOOKMARK_URL_MAX);
  });
});

describe("cleanBookmarkTitle", () => {
  it("压平空白、剥控制 / 格式字符（U+202E 方向控制符伪装不了标题）", () => {
    expect(cleanBookmarkTitle("  hello \n\t world  ", "fallback")).toBe("hello world");
    expect(cleanBookmarkTitle("report\u202Etxt.exe", "fallback")).toBe("reporttxt.exe");
    expect(cleanBookmarkTitle("a\u200Bb\u0000c", "fallback")).toBe("abc");
  });

  it("没给 / 不是字符串 / 清洗后为空（全是控制字符、零宽字符、空白）→ 退回兜底值", () => {
    for (const t of [undefined, null, 42, {}, "", "   ", "\u200B\u200C\u202E", "\n\t"]) {
      expect(cleanBookmarkTitle(t, "example.com"), String(t)).toBe("example.com");
    }
    expect(cleanBookmarkTitle("", "")).toBe("");
  });

  it("超过上限截断并带省略号（总长不超过上限 + 1）", () => {
    const out = cleanBookmarkTitle("字".repeat(BOOKMARK_TITLE_MAX + 50), "x");
    expect(out.length).toBe(BOOKMARK_TITLE_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(cleanBookmarkTitle("a".repeat(BOOKMARK_TITLE_MAX), "x")).toBe("a".repeat(BOOKMARK_TITLE_MAX));
  });
});

describe("sortBookmarks", () => {
  it("createdAt 倒序；时间戳相同的保持原有相对顺序（稳定）", () => {
    const list = [bm({ id: "a", createdAt: 1 }), bm({ id: "b", createdAt: 3 }), bm({ id: "c", createdAt: 3 }), bm({ id: "d", createdAt: 2 })];
    expect(sortBookmarks(list).map((b) => b.id)).toEqual(["b", "c", "d", "a"]);
  });

  it("不改入参", () => {
    const list = [bm({ id: "a", createdAt: 1 }), bm({ id: "b", createdAt: 2 })];
    const snapshot = list.map((b) => b.id);
    sortBookmarks(list);
    expect(list.map((b) => b.id)).toEqual(snapshot);
  });
});

describe("parseBookmarkList：盘上 / 接口回来的原始值 → 合法列表", () => {
  it("不是数组 → 空列表", () => {
    for (const raw of [undefined, null, {}, "x", 5, { bookmarks: [] }]) expect(parseBookmarkList(raw)).toEqual([]);
  });

  it("逐条校验：坏条目（非对象 / 没 id / id 带空白或控制字符 / id 过长 / 地址不合法）丢弃，其余保留", () => {
    const good = { id: "ok-1", url: "https://example.com/a", title: "A", createdAt: 5 };
    const out = parseBookmarkList([
      null,
      "str",
      42,
      [],
      { url: "https://example.com/noid", title: "x", createdAt: 1 },
      { id: "", url: "https://example.com/emptyid" },
      { id: "has space", url: "https://example.com/space" },
      { id: "bad\nid", url: "https://example.com/nl" },
      { id: "x".repeat(BOOKMARK_ID_MAX + 1), url: "https://example.com/long" },
      { id: "js", url: "javascript:alert(1)" },
      { id: "file", url: "file:///etc/passwd" },
      good,
    ]);
    expect(out).toEqual([{ ...good }]);
  });

  it("URL 重新规整：手改文件带了 userinfo / 大写 host 也会被收成规范形态", () => {
    const [b] = parseBookmarkList([{ id: "1", url: "https://u:p@EXAMPLE.com:443/x", title: "t", createdAt: 1 }]);
    expect(b!.url).toBe("https://example.com/x");
  });

  it("标题清洗，空标题用主机名；createdAt 缺失 / 负数 / NaN / 非数字 → 0", () => {
    const out = parseBookmarkList([
      { id: "a", url: "https://a.example/x", title: "  \n  ", createdAt: 10 },
      { id: "b", url: "https://b.example/x", title: "t\u202Ex", createdAt: -5 },
      { id: "c", url: "https://c.example/x", createdAt: Number.NaN },
      { id: "d", url: "https://d.example/x", title: "d", createdAt: "123" },
    ]);
    const byId = Object.fromEntries(out.map((b) => [b.id, b]));
    expect(byId.a).toMatchObject({ title: "a.example", createdAt: 10 });
    expect(byId.b).toMatchObject({ title: "tx", createdAt: 0 });
    expect(byId.c).toMatchObject({ title: "c.example", createdAt: 0 });
    expect(byId.d).toMatchObject({ createdAt: 0 });
  });

  it("同 URL 只留 createdAt 最新的一条（规整后相同也算同一条）；同 id 也只留一条", () => {
    const out = parseBookmarkList([
      { id: "old", url: "https://example.com/x", title: "old", createdAt: 1 },
      { id: "new", url: "https://EXAMPLE.com/x", title: "new", createdAt: 9 },
      { id: "dup-id", url: "https://example.com/y", title: "first", createdAt: 5 },
      { id: "dup-id", url: "https://example.com/z", title: "second", createdAt: 4 },
    ]);
    expect(out.map((b) => [b.id, b.title])).toEqual([
      ["new", "new"],
      ["dup-id", "first"],
    ]);
  });

  it("按 createdAt 倒序输出", () => {
    const out = parseBookmarkList([
      { id: "a", url: "https://a.example/", createdAt: 1 },
      { id: "b", url: "https://b.example/", createdAt: 3 },
      { id: "c", url: "https://c.example/", createdAt: 2 },
    ]);
    expect(out.map((b) => b.id)).toEqual(["b", "c", "a"]);
  });

  it("超过上限只留最新的 BOOKMARK_LIMIT 条", () => {
    const raw = Array.from({ length: BOOKMARK_LIMIT + 25 }, (_, i) => ({ id: `id${i}`, url: `https://example.com/${i}`, title: `t${i}`, createdAt: i }));
    const out = parseBookmarkList(raw);
    expect(out).toHaveLength(BOOKMARK_LIMIT);
    expect(out[0]!.id).toBe(`id${BOOKMARK_LIMIT + 24}`); // 最新的在最前
    expect(out.at(-1)!.id).toBe("id25"); // 最旧的 25 条被截掉
  });
});

describe("findBookmarkByUrl：按同一套规则找（星标亮不亮）", () => {
  const list = [bm({ id: "a", url: "https://example.com/x", title: "A" }), bm({ id: "b", url: "https://example.com/", title: "B" })];

  it("尾斜杠 / 默认端口 / host 大小写 / userinfo 的差异不影响命中", () => {
    expect(findBookmarkByUrl(list, "https://EXAMPLE.com:443/x")?.id).toBe("a");
    expect(findBookmarkByUrl(list, "https://user:pw@example.com/x")?.id).toBe("a");
    expect(findBookmarkByUrl(list, "https://example.com")?.id).toBe("b"); // 裸域名 = 根路径
    expect(findBookmarkByUrl(list, " https://example.com/x ")?.id).toBe("a");
  });

  it("路径 / 查询 / 片段不同就是另一个地址", () => {
    expect(findBookmarkByUrl(list, "https://example.com/x/")).toBeUndefined();
    expect(findBookmarkByUrl(list, "https://example.com/x?a=1")).toBeUndefined();
    expect(findBookmarkByUrl(list, "https://example.com/x#h")).toBeUndefined();
    expect(findBookmarkByUrl(list, "http://example.com/x")).toBeUndefined(); // http ≠ https
  });

  it("地址本身不可收藏（about:blank / javascript: / 非字符串）→ undefined，不抛", () => {
    for (const bad of ["about:blank", "javascript:alert(1)", undefined, null, 5, ""]) {
      expect(findBookmarkByUrl(list, bad)).toBeUndefined();
    }
  });
});

describe("displayBookmarkUrl / filterBookmarks", () => {
  it("展示地址：去协议、去末尾斜杠；只是展示", () => {
    expect(displayBookmarkUrl("https://example.com/")).toBe("example.com");
    expect(displayBookmarkUrl("http://example.com/a/b?q=1")).toBe("example.com/a/b?q=1");
    expect(displayBookmarkUrl("https://example.com/docs/")).toBe("example.com/docs");
  });

  const list = [
    bm({ id: "1", title: "Flowship 文档", url: "https://docs.flowship.dev/start" }),
    bm({ id: "2", title: "GitHub", url: "https://github.com/jianger666/Flowship" }),
    bm({ id: "3", title: "新闻", url: "https://news.example.com/" }),
  ];

  it("标题或地址包含关键词；不区分大小写、忽略首尾空白", () => {
    expect(filterBookmarks(list, "flowship").map((b) => b.id)).toEqual(["1", "2"]);
    expect(filterBookmarks(list, "  GITHUB ").map((b) => b.id)).toEqual(["2"]);
    expect(filterBookmarks(list, "新").map((b) => b.id)).toEqual(["3"]);
    expect(filterBookmarks(list, "nomatch")).toEqual([]);
  });

  it("关键词为空 / 全空白 → 原列表（同一个引用，不白白换对象触发重渲）", () => {
    expect(filterBookmarks(list, "")).toBe(list);
    expect(filterBookmarks(list, "   ")).toBe(list);
  });
});
