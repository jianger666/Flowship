/**
 * /api/browser/history 路由：GET 列表 / POST 记一次访问 / DELETE ?id= 删一条 / DELETE ?all=1 清空。
 * 钉死：状态码与稳定 code（invalid_url 400、not_found 404）、内部错误只回 *_failed 不透出原文、
 * 坏请求（非 JSON / 非对象 / 缺 id）400、客户端传的时间不被接受。落盘层本身的行为见 browser-history-server.test.ts。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, POST } from "@/app/api/browser/history/route";
import type { HistoryEntry } from "@/lib/browser-history";
import { HISTORY_FILE } from "@/lib/server/browser-history";

let dir: string;
const file = () => path.join(dir, HISTORY_FILE);
const URL_BASE = "http://127.0.0.1:8876/api/browser/history";

const post = (body: unknown, raw = false) =>
  POST(new Request(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) }));
const del = (query: string) => DELETE(new Request(`${URL_BASE}${query}`, { method: "DELETE" }));
const delId = (id?: string) => del(id === undefined ? "" : `?id=${encodeURIComponent(id)}`);
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fe-history-route-"));
  process.env.FLOWSHIP_DATA_DIR = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET", () => {
  it("没有记录 → 200 { history: [] }", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ history: [] });
  });

  it("返回全部记录，最近访问的在最前", async () => {
    await post({ url: "https://a.example/", title: "a" });
    await new Promise((r) => setTimeout(r, 5));
    await post({ url: "https://b.example/", title: "b" });
    const body = (await json(await GET())) as { history: HistoryEntry[] };
    expect(body.history.map((e) => e.title)).toEqual(["b", "a"]);
  });

  it("读不出来（路径被目录占着）→ 500 list_failed；错误原文（含路径）不透出", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(file());
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toEqual({ error: "读取浏览历史失败", code: "list_failed" });
    expect(JSON.stringify(body)).not.toContain(dir);
  });
});

describe("POST", () => {
  it("新增 → 201 { entry, created:true }，次数 1", async () => {
    const res = await post({ url: "https://example.com/a", title: "A" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.created).toBe(true);
    expect(body.entry).toMatchObject({ url: "https://example.com/a", title: "A", visitCount: 1 });
  });

  it("同一个地址再记 → 200 { created:false }，同一个 id、次数 +1、标题刷新", async () => {
    const first = (await json(await post({ url: "https://example.com/a", title: "旧" }))) as { entry: HistoryEntry };
    const res = await post({ url: "https://EXAMPLE.com/a", title: "新" });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { entry: HistoryEntry; created: boolean };
    expect(body.created).toBe(false);
    expect(body.entry).toMatchObject({ id: first.entry.id, visitCount: 2, title: "新" });
  });

  it("客户端传的时间一律忽略（访问时间只用服务端的现在）", async () => {
    const before = Date.now();
    const res = await post({ url: "https://example.com/a", title: "A", lastVisitAt: 5, at: 5, createdAt: 5 });
    const { entry } = (await json(res)) as { entry: HistoryEntry };
    expect(entry.lastVisitAt).toBeGreaterThanOrEqual(before);
  });

  it("地址不可记录 → 400 invalid_url，error 是中文原因", async () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "about:blank", "chrome-error://chromewebdata/", "", "not a url", 42, null]) {
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
      expect(await json(res), JSON.stringify(body)).toEqual({ error: "body 必须是对象" });
    }
    expect(await json(await GET())).toEqual({ history: [] });
  });

  it("落盘出意外错误 → 500 record_failed，只回固定文案（路径等内部细节不透出）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(file());
    const res = await post({ url: "https://example.com/a", title: "A" });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toEqual({ error: "记录浏览历史失败", code: "record_failed" });
    expect(JSON.stringify(body)).not.toContain(dir);
  });
});

describe("DELETE ?id=", () => {
  it("删存在的 → 200 { ok:true }，文件里没了", async () => {
    const created = (await json(await post({ url: "https://example.com/a", title: "A" }))) as { entry: HistoryEntry };
    const res = await delId(created.entry.id);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(file(), "utf-8")).history).toEqual([]);
  });

  it("id 不存在 → 404 not_found（前端把它当成「已经没了」）", async () => {
    const res = await delId("no-such-id");
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("not_found");
  });

  it("缺 id / 空 id → 400", async () => {
    expect((await delId()).status).toBe(400);
    expect((await delId("")).status).toBe(400);
  });

  it("id 里带特殊字符也只是普通字符串：按原样匹配、不影响别的记录", async () => {
    await post({ url: "https://example.com/a", title: "A" });
    const res = await delId("../../etc/passwd");
    expect(res.status).toBe(404);
    expect(((await json(await GET())) as { history: HistoryEntry[] }).history).toHaveLength(1);
  });

  it("落盘出意外错误 → 500 remove_failed，只回固定文案", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(file());
    const res = await delId("any");
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "删除浏览历史失败", code: "remove_failed" });
  });
});

describe("DELETE ?all=1（清除浏览历史）", () => {
  it("清空 → 200 { ok:true, removed:N }，之后 GET = 空", async () => {
    for (const n of ["a", "b", "c"]) await post({ url: `https://${n}.example/` });
    const res = await del("?all=1");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, removed: 3 });
    expect(await json(await GET())).toEqual({ history: [] });
  });

  it("本来就是空 → 200 removed:0", async () => {
    expect(await json(await del("?all=1"))).toEqual({ ok: true, removed: 0 });
  });

  it("all 只认 1：?all=0 / ?all=true / ?all= 都不会清空（没给 id → 400），记录原样", async () => {
    await post({ url: "https://example.com/a", title: "A" });
    for (const q of ["?all=0", "?all=true", "?all=", "?all=yes"]) {
      expect((await del(q)).status, q).toBe(400);
    }
    expect(((await json(await GET())) as { history: HistoryEntry[] }).history).toHaveLength(1);
  });

  it("all=1 优先于 id：同时带 id 也是整体清空", async () => {
    const a = (await json(await post({ url: "https://a.example/" }))) as { entry: HistoryEntry };
    await post({ url: "https://b.example/" });
    const res = await del(`?all=1&id=${a.entry.id}`);
    expect(await json(res)).toEqual({ ok: true, removed: 2 });
  });

  it("落盘出意外错误 → 500 clear_failed，只回固定文案（不会为了清空去动读不出来的文件）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(file());
    writeFileSync(path.join(file(), "precious.txt"), "do not touch", "utf-8");
    const res = await del("?all=1");
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toEqual({ error: "清除浏览历史失败", code: "clear_failed" });
    expect(JSON.stringify(body)).not.toContain(dir);
    expect(readFileSync(path.join(file(), "precious.txt"), "utf-8")).toBe("do not touch");
  });
});
