/**
 * 收藏夹落盘层（src/lib/server/browser-bookmarks.ts）：真实文件系统 + 每条用例独立的临时数据目录。
 * 钉死的行为：幂等加（按规整后的地址去重）、撤销删除按原时间回位、串行写不丢更新、
 * 坏文件（读路径当空、写路径先备份）、读不出来（目录占位 / 权限）绝不当空列表去覆盖、userinfo 与坏标题不落盘。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKMARK_LIMIT, BOOKMARK_TITLE_MAX, type Bookmark } from "@/lib/browser-bookmarks";
import {
  BOOKMARKS_FILE,
  BookmarkError,
  addBookmark,
  bookmarksPath,
  isBookmarkError,
  listBookmarks,
  removeBookmark,
} from "@/lib/server/browser-bookmarks";

let dir: string;
const file = () => path.join(dir, BOOKMARKS_FILE);
const readFileJson = () => JSON.parse(readFileSync(file(), "utf-8")) as { v: number; bookmarks: Bookmark[] };
const entry = (i: number, over: Partial<Bookmark> = {}): Bookmark => ({
  id: `id-${i}`,
  url: `https://example.com/p${i}`,
  title: `title ${i}`,
  createdAt: 1_000 + i,
  ...over,
});
const seed = (bookmarks: unknown[]) => writeFileSync(file(), JSON.stringify({ v: 1, bookmarks }), "utf-8");

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fe-bookmarks-"));
  process.env.FLOWSHIP_DATA_DIR = dir;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("文件位置与空状态", () => {
  it("落在 <dataRoot>/browser-bookmarks.json（全局一份，不按任务分）", () => {
    expect(bookmarksPath()).toBe(path.join(dir, "browser-bookmarks.json"));
  });

  it("文件不存在 = 空列表，且读取不会凭空建文件", async () => {
    expect(await listBookmarks()).toEqual([]);
    expect(existsSync(file())).toBe(false);
  });
});

describe("addBookmark", () => {
  it("新增：规整地址 + 清洗标题 + UUID id；写成 { v:1, bookmarks }，文件 0600", async () => {
    const { bookmark, created } = await addBookmark({ url: "https://Example.COM:443/a?b=1", title: "  Hello \n World  " });
    expect(created).toBe(true);
    expect(bookmark.url).toBe("https://example.com/a?b=1");
    expect(bookmark.title).toBe("Hello World");
    expect(bookmark.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Number.isFinite(bookmark.createdAt)).toBe(true);
    expect(readFileJson()).toEqual({ v: 1, bookmarks: [bookmark] });
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(await listBookmarks()).toEqual([bookmark]);
  });

  it("没给标题 / 标题清洗后为空 → 用主机名", async () => {
    expect((await addBookmark({ url: "https://docs.example.com/x" })).bookmark.title).toBe("docs.example.com");
    expect((await addBookmark({ url: "https://b.example.com/x", title: "\u200B\u202E  \n" })).bookmark.title).toBe("b.example.com");
  });

  it("标题里的方向控制符 / 控制字符被剥掉，超长截断（总长不超过上限 + 省略号）", async () => {
    const { bookmark } = await addBookmark({ url: "https://a.example/x", title: `evil\u202Etxt\u0007${"字".repeat(BOOKMARK_TITLE_MAX + 40)}` });
    expect(bookmark.title).not.toMatch(/[\u202E\u0007]/);
    expect(bookmark.title.length).toBe(BOOKMARK_TITLE_MAX + 1);
  });

  it("userinfo 不落盘：文件里找不到用户名和密码", async () => {
    const { bookmark } = await addBookmark({ url: "https://admin:hunter2@intranet.example.com/wiki", title: "wiki" });
    expect(bookmark.url).toBe("https://intranet.example.com/wiki");
    const raw = readFileSync(file(), "utf-8");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("admin");
  });

  it("同一个地址（规整后）重复加 = 幂等：不产生重复，id 不变，标题更新，顶到最前，created:false", async () => {
    const first = await addBookmark({ url: "https://example.com/a", title: "旧标题" });
    await new Promise((r) => setTimeout(r, 5));
    await addBookmark({ url: "https://other.example/b", title: "其它" });
    await new Promise((r) => setTimeout(r, 5));
    const again = await addBookmark({ url: "https://EXAMPLE.com:443/a", title: "新标题" });
    expect(again.created).toBe(false);
    expect(again.bookmark.id).toBe(first.bookmark.id);
    expect(again.bookmark.title).toBe("新标题");
    const list = await listBookmarks();
    expect(list.map((b) => b.url)).toEqual(["https://example.com/a", "https://other.example/b"]); // 顶到最前
    expect(list).toHaveLength(2);
  });

  it("已有收藏再点收藏而页面标题暂时为空（还在加载）：沿用原来的好标题，不冲成主机名", async () => {
    await addBookmark({ url: "https://example.com/a", title: "好标题" });
    const again = await addBookmark({ url: "https://example.com/a", title: "" });
    expect(again.created).toBe(false);
    expect(again.bookmark.title).toBe("好标题");
    const third = await addBookmark({ url: "https://example.com/a" });
    expect(third.bookmark.title).toBe("好标题");
  });

  it("列表最新的在最前", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [i, name] of ["a", "b", "c"].entries()) {
      vi.setSystemTime(10_000 + i * 1000);
      await addBookmark({ url: `https://example.com/${name}`, title: name });
    }
    expect((await listBookmarks()).map((b) => b.title)).toEqual(["c", "b", "a"]);
  });

  it("同一毫秒收藏的两条：后加的排在前面（时间戳并列时新的在前）；文件里也是这个顺序", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(50_000); // 时间冻结：三次收藏的 createdAt 完全相同
    for (const name of ["a", "b", "c"]) await addBookmark({ url: `https://example.com/${name}`, title: name });
    expect((await listBookmarks()).map((b) => b.title)).toEqual(["c", "b", "a"]);
    // 落盘顺序本身也是「最新在最前」（文件是用户可能手翻的东西，不能只靠读取时重排来保证）
    expect(readFileJson().bookmarks.map((b) => b.title)).toEqual(["c", "b", "a"]);
  });

  it("撤销删除：带着原来的 createdAt 加回来，列表里回到原来的位置（不是顶到最前）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const made: Bookmark[] = [];
    for (const [i, name] of ["a", "b", "c"].entries()) {
      vi.setSystemTime(10_000 + i * 1000);
      made.push((await addBookmark({ url: `https://example.com/${name}`, title: name })).bookmark);
    }
    const b = made[1]!;
    vi.setSystemTime(99_000);
    expect(await removeBookmark(b.id)).toBe(true);
    expect((await listBookmarks()).map((x) => x.title)).toEqual(["c", "a"]);
    const restored = await addBookmark({ url: b.url, title: b.title, createdAt: b.createdAt });
    expect(restored.created).toBe(true);
    expect(restored.bookmark.createdAt).toBe(b.createdAt);
    expect((await listBookmarks()).map((x) => x.title)).toEqual(["c", "b", "a"]);
  });

  it("createdAt 只接受合法值：不是数字 / 负数 / NaN / 比现在晚太多（> 1 分钟时钟误差）都忽略，按现在算；小数取整", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const now = 1_000_000;
    const at = async (n: number, createdAt: unknown) => (await addBookmark({ url: `https://example.com/${n}`, title: "t", createdAt })).bookmark.createdAt;
    expect(await at(1, "5")).toBe(now);
    expect(await at(2, -1)).toBe(now);
    expect(await at(3, Number.NaN)).toBe(now);
    expect(await at(4, Number.POSITIVE_INFINITY)).toBe(now);
    expect(await at(5, now + 61_000)).toBe(now); // 比现在晚超过 1 分钟
    expect(await at(6, now + 30_000)).toBe(now + 30_000); // 时钟误差内放行
    expect(await at(7, 12_345.9)).toBe(12_345);
    expect(await at(8, 0)).toBe(0);
  });

  it("地址不可收藏 → 拒绝（BookmarkError invalid_url，带中文原因），文件原样", async () => {
    await addBookmark({ url: "https://keep.example/x", title: "keep" });
    const before = readFileSync(file(), "utf-8");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "about:blank", "", "   ", "not a url", undefined, null, 42, {}]) {
      const err = await addBookmark({ url: bad }).catch((e: unknown) => e);
      expect(isBookmarkError(err), String(bad)).toBe(true);
      expect((err as BookmarkError).code).toBe("invalid_url");
      expect((err as BookmarkError).message.length).toBeGreaterThan(0);
    }
    expect(readFileSync(file(), "utf-8")).toBe(before);
  });

  it(`收藏夹满了（${BOOKMARK_LIMIT} 条）：新增被拒（limit_reached，不自动淘汰最旧的）；已有地址再加仍是幂等更新`, async () => {
    seed(Array.from({ length: BOOKMARK_LIMIT }, (_, i) => entry(i)));
    const err = await addBookmark({ url: "https://new.example/x", title: "new" }).catch((e: unknown) => e);
    expect(isBookmarkError(err)).toBe(true);
    expect((err as BookmarkError).code).toBe("limit_reached");
    expect((err as BookmarkError).message).toContain(String(BOOKMARK_LIMIT));
    expect(await listBookmarks()).toHaveLength(BOOKMARK_LIMIT);
    expect((await listBookmarks()).some((b) => b.url === "https://new.example/x")).toBe(false);

    const again = await addBookmark({ url: "https://example.com/p3", title: "改个名" });
    expect(again.created).toBe(false);
    expect(again.bookmark.title).toBe("改个名");
    expect(await listBookmarks()).toHaveLength(BOOKMARK_LIMIT);
  });

  it("满了之后删一条就能再加（limit_reached 的失败不卡住串行队列）", async () => {
    seed(Array.from({ length: BOOKMARK_LIMIT }, (_, i) => entry(i)));
    await expect(addBookmark({ url: "https://new.example/x" })).rejects.toMatchObject({ code: "limit_reached" });
    expect(await removeBookmark("id-0")).toBe(true);
    const ok = await addBookmark({ url: "https://new.example/x", title: "new" });
    expect(ok.created).toBe(true);
    expect(await listBookmarks()).toHaveLength(BOOKMARK_LIMIT);
  });
});

describe("removeBookmark", () => {
  it("按 id 删：返回 true；id 不存在 / 空 / 非字符串 → false，且不动文件", async () => {
    const a = (await addBookmark({ url: "https://a.example/", title: "a" })).bookmark;
    const b = (await addBookmark({ url: "https://b.example/", title: "b" })).bookmark;
    const before = readFileSync(file(), "utf-8");
    for (const bad of ["no-such-id", "", undefined, null, 42, {}]) expect(await removeBookmark(bad), String(bad)).toBe(false);
    expect(readFileSync(file(), "utf-8")).toBe(before);

    expect(await removeBookmark(a.id)).toBe(true);
    expect((await listBookmarks()).map((x) => x.id)).toEqual([b.id]);
    expect(await removeBookmark(a.id)).toBe(false); // 删过了
  });

  it("文件不存在时删 = false，不建文件", async () => {
    expect(await removeBookmark("x")).toBe(false);
    expect(existsSync(file())).toBe(false);
  });
});

describe("串行写：并发请求不丢更新", () => {
  it("20 个不同地址同时加 → 全部在，没有丢失", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => addBookmark({ url: `https://example.com/c${i}`, title: `c${i}` })));
    const list = await listBookmarks();
    expect(list).toHaveLength(20);
    expect(new Set(list.map((b) => b.url)).size).toBe(20);
  });

  it("同一个地址同时加 10 次 → 只有 1 条，恰好 1 次 created:true", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => addBookmark({ url: "https://example.com/same", title: `t${i}` })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.bookmark.id)).size).toBe(1);
    expect(await listBookmarks()).toHaveLength(1);
  });

  it("加与删交错：删掉的不会因为并发的加而复活，其余都在", async () => {
    const keep = (await addBookmark({ url: "https://keep.example/", title: "keep" })).bookmark;
    const drop = (await addBookmark({ url: "https://drop.example/", title: "drop" })).bookmark;
    const ops: Array<Promise<unknown>> = [removeBookmark(drop.id)];
    for (let i = 0; i < 8; i++) ops.push(addBookmark({ url: `https://more.example/${i}`, title: `m${i}` }));
    await Promise.all(ops);
    const urls = (await listBookmarks()).map((b) => b.url);
    expect(urls).toContain(keep.url);
    expect(urls).not.toContain(drop.url);
    expect(urls).toHaveLength(9);
  });

  it("原子写不留临时文件", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => addBookmark({ url: `https://example.com/t${i}` })));
    await removeBookmark((await listBookmarks())[0]!.id);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
    expect(readdirSync(dir)).toEqual([BOOKMARKS_FILE]);
  });
});

describe("损坏的文件：读路径宽容、写路径保守", () => {
  const brokenShapes: Array<[string, string]> = [
    ["不是合法 JSON", "{ this is not json"],
    ["根是数组", JSON.stringify([entry(1)])],
    ["缺 v", JSON.stringify({ bookmarks: [entry(1)] })],
    ["v 不认识", JSON.stringify({ v: 2, bookmarks: [entry(1)] })],
    ["bookmarks 不是数组", JSON.stringify({ v: 1, bookmarks: "nope" })],
    ["根是 null", "null"],
    ["空文件", ""],
  ];

  for (const [name, content] of brokenShapes) {
    it(`${name}：读 = 空列表且不动文件；写 = 先把坏文件改名 .corrupt-<时间戳> 留证据，再写新的`, async () => {
      writeFileSync(file(), content, "utf-8");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await listBookmarks()).toEqual([]);
      expect(readFileSync(file(), "utf-8")).toBe(content); // 读路径不改文件
      expect(readdirSync(dir)).toEqual([BOOKMARKS_FILE]);

      const { bookmark } = await addBookmark({ url: "https://example.com/new", title: "new" });
      const files = readdirSync(dir).sort();
      const backup = files.find((f) => f.startsWith(`${BOOKMARKS_FILE}.corrupt-`));
      expect(backup, name).toBeDefined();
      expect(readFileSync(path.join(dir, backup!), "utf-8")).toBe(content); // 证据原样
      expect(readFileJson()).toEqual({ v: 1, bookmarks: [bookmark] });
      expect(warn).toHaveBeenCalled();
    });
  }

  it("删一条「不存在的」不会为此把坏文件改名（真要写新内容时才备份）", async () => {
    writeFileSync(file(), "{ broken", "utf-8");
    expect(await removeBookmark("whatever")).toBe(false);
    expect(readdirSync(dir)).toEqual([BOOKMARKS_FILE]);
    expect(readFileSync(file(), "utf-8")).toBe("{ broken");
  });

  it("带 BOM 的合法文件（Windows 记事本另存）照常解析，不当损坏", async () => {
    writeFileSync(file(), `\uFEFF${JSON.stringify({ v: 1, bookmarks: [entry(1)] })}`, "utf-8");
    expect((await listBookmarks()).map((b) => b.id)).toEqual(["id-1"]);
    await addBookmark({ url: "https://example.com/more", title: "more" });
    expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("单条坏数据逐条丢弃，不连累其它收藏（并且下一次写入会把坏条目清掉）", async () => {
    seed([entry(1), { id: "no-url" }, { url: "https://example.com/no-id" }, { id: "js", url: "javascript:alert(1)" }, null, "str", entry(2)]);
    expect((await listBookmarks()).map((b) => b.id).sort()).toEqual(["id-1", "id-2"]);
    await addBookmark({ url: "https://example.com/p9", title: "nine" });
    expect(readFileJson().bookmarks.map((b) => b.id).sort()).toEqual(expect.arrayContaining(["id-1", "id-2"]));
    expect(readFileJson().bookmarks).toHaveLength(3);
  });

  it("读路径的坏文件告警限频：同一分钟内反复读只提示一次，过了窗口再提示", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 3600 * 1000); // 越过其它用例留下的限频窗口
    writeFileSync(file(), "{ broken", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await listBookmarks();
    await listBookmarks();
    await listBookmarks();
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    await listBookmarks();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("读不出来 ≠ 空：绝不拿「读不出来的收藏夹」当空列表去覆盖", () => {
  it("收藏文件的位置被一个目录占着（EISDIR）：读 / 加 / 删都抛错，原样保留（不会被覆盖或改名）", async () => {
    mkdirSync(file());
    writeFileSync(path.join(file(), "precious.txt"), "do not touch", "utf-8");
    await expect(listBookmarks()).rejects.toThrow();
    await expect(addBookmark({ url: "https://example.com/x", title: "x" })).rejects.toThrow();
    await expect(removeBookmark("any")).rejects.toThrow();
    expect(statSync(file()).isDirectory()).toBe(true);
    expect(readFileSync(path.join(file(), "precious.txt"), "utf-8")).toBe("do not touch");
    expect(readdirSync(dir)).toEqual([BOOKMARKS_FILE]);
  });

  it("没有读权限（EACCES）：读 / 加都抛错，内容原样（非 root、非 Windows 才有意义）", async () => {
    if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) return;
    seed([entry(1)]);
    const before = readFileSync(file(), "utf-8");
    chmodSync(file(), 0o000);
    try {
      await expect(listBookmarks()).rejects.toThrow();
      await expect(addBookmark({ url: "https://example.com/y", title: "y" })).rejects.toThrow();
    } finally {
      chmodSync(file(), 0o600);
    }
    expect(readFileSync(file(), "utf-8")).toBe(before);
  });

  it("读失败不会卡住串行队列：之后（恢复正常了）的加照常成功", async () => {
    mkdirSync(file());
    await expect(addBookmark({ url: "https://example.com/x" })).rejects.toThrow();
    rmSync(file(), { recursive: true });
    const ok = await addBookmark({ url: "https://example.com/x", title: "x" });
    expect(ok.created).toBe(true);
    expect(await listBookmarks()).toHaveLength(1);
  });
});
