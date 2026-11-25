/**
 * /api/browser/bookmarks 路由：GET 列表 / POST 加（幂等）/ DELETE 删。
 * 钉死：状态码与稳定 code（invalid_url 400、limit_reached 409、not_found 404）、内部错误只回 *_failed 不透出原文、
 * 坏请求（非 JSON / 非对象 / 缺 id）400。落盘层本身的行为见 browser-bookmarks-server.test.ts。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, POST } from "@/app/api/browser/bookmarks/route";
import { BOOKMARK_LIMIT, type Bookmark } from "@/lib/browser-bookmarks";
import { BOOKMARKS_FILE } from "@/lib/server/browser-bookmarks";

let dir: string;
const file = () => path.join(dir, BOOKMARKS_FILE);
const URL_BASE = "http://127.0.0.1:8876/api/browser/bookmarks";

const post = (body: unknown, raw = false) =>
  POST(new Request(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) }));
const del = (id?: string) => DELETE(new Request(id === undefined ? URL_BASE : `${URL_BASE}?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fe-bookmarks-route-"));
  process.env.FLOWSHIP_DATA_DIR = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET", () => {
  it("没有收藏 → 200 { bookmarks: [] }；响应不缓存（force-dynamic）", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ bookmarks: [] });
  });

  it("返回全部收藏，最新在最前", async () => {
    await post({ url: "https://a.example/", title: "a" });
    await new Promise((r) => setTimeout(r, 5));
    await post({ url: "https://b.example/", title: "b" });
    const body = (await json(await GET())) as { bookmarks: Bookmark[] };
    expect(body.bookmarks.map((b) => b.title)).toEqual(["b", "a"]);
  });

  it("读不出来（路径被目录占着）→ 500 list_failed；错误原文（含路径）不透出", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(file());
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toEqual({ error: "读取收藏夹失败", code: "list_failed" });
    expect(JSON.stringify(body)).not.toContain(dir);
  });
});

describe("POST", () => {
  it("新增 → 201 { bookmark, created:true }", async () => {
    const res = await post({ url: "https://example.com/a", title: "A" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.created).toBe(true);
    expect(body.bookmark).toMatchObject({ url: "https://example.com/a", title: "A" });
  });

  it("同一个地址再加 → 200 { created:false }，同一个 id、标题更新（幂等）", async () => {
    const first = (await json(await post({ url: "https://example.com/a", title: "旧" }))) as { bookmark: Bookmark };
    const res = await post({ url: "https://EXAMPLE.com/a", title: "新" });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { bookmark: Bookmark; created: boolean };
    expect(body.created).toBe(false);
    expect(body.bookmark.id).toBe(first.bookmark.id);
    expect(body.bookmark.title).toBe("新");
  });

  it("createdAt 透传给落盘层（撤销删除用）", async () => {
    const res = await post({ url: "https://example.com/a", title: "A", createdAt: 12_345 });
    expect(((await json(res)) as { bookmark: Bookmark }).bookmark.createdAt).toBe(12_345);
  });

  it("地址不可收藏 → 400 invalid_url，error 是中文原因", async () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "about:blank", "", "not a url", 42, null]) {
      const res = await post({ url, title: "x" });
      expect(res.status, String(url)).toBe(400);
      const body = await json(res);
      expect(body.code, String(url)).toBe("invalid_url");
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
    }
  });

  it("缺 url 字段 → 400 invalid_url", async () => {
    const res = await post({ title: "no url" });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_url");
  });

  it("body 不是合法 JSON / 不是对象（数组、字符串、null）→ 400，不碰落盘", async () => {
    const bad = await post("{ nope", true);
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toContain("JSON");
    for (const body of [[], [{ url: "https://example.com/" }], "text", null, 42]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      // 走的是「body 必须是对象」这一支（没有 code），不是落到 invalid_url：数组不会被当成对象去取字段
      expect(await json(res), JSON.stringify(body)).toEqual({ error: "body 必须是对象" });
    }
    expect(await json(await GET())).toEqual({ bookmarks: [] });
  });

  it(`收藏夹满了 → 409 limit_reached（带上限数字的中文提示）`, async () => {
    writeFileSync(
      file(),
      JSON.stringify({ v: 1, bookmarks: Array.from({ length: BOOKMARK_LIMIT }, (_, i) => ({ id: `id${i}`, url: `https://example.com/${i}`, title: `t${i}`, createdAt: i + 1 })) }),
      "utf-8",
    );
    const res = await post({ url: "https://new.example/x", title: "new" });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.code).toBe("limit_reached");
    expect(body.error).toContain(String(BOOKMARK_LIMIT));
  });

  it("落盘出意外错误 → 500 add_failed，只回固定文案（路径等内部细节不透出）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(file());
    const res = await post({ url: "https://example.com/a", title: "A" });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toEqual({ error: "保存收藏失败", code: "add_failed" });
    expect(JSON.stringify(body)).not.toContain(dir);
  });
});

describe("DELETE", () => {
  it("删存在的 → 200 { ok:true }，文件里没了", async () => {
    const created = (await json(await post({ url: "https://example.com/a", title: "A" }))) as { bookmark: Bookmark };
    const res = await del(created.bookmark.id);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(file(), "utf-8")).bookmarks).toEqual([]);
  });

  it("id 不存在 → 404 not_found（前端把它当成「已经没了」）", async () => {
    const res = await del("no-such-id");
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("not_found");
  });

  it("缺 id / 空 id → 400", async () => {
    expect((await del()).status).toBe(400);
    expect((await del("")).status).toBe(400);
  });

  it("id 里带特殊字符也只是普通字符串：按原样匹配、不影响别的收藏", async () => {
    await post({ url: "https://example.com/a", title: "A" });
    const res = await del("../../etc/passwd");
    expect(res.status).toBe(404);
    expect(((await json(await GET())) as { bookmarks: Bookmark[] }).bookmarks).toHaveLength(1);
  });

  it("落盘出意外错误 → 500 remove_failed，只回固定文案", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(file());
    const res = await del("any");
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "删除收藏失败", code: "remove_failed" });
  });
});
