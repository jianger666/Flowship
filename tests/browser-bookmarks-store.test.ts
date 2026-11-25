/**
 * 收藏夹的前端 store（src/components/browser/bookmarks-store.ts，无 React，假 fetch 驱动）。
 * 钉死：load 单飞、已有数据时后台刷新失败不把列表换成报错、变更成功后星标即时翻转（改本地）、
 * 还没加载成功过时变更不能把「只有这一条」当完整列表（改为重拉）、load 在途期间发生变更的乱序保护、
 * remove 遇 404 当成功、快照引用稳定（useSyncExternalStore 的要求）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOOKMARKS_API, createBookmarksStore, getBookmarksStore, IDLE_BOOKMARKS_SNAPSHOT } from "@/components/browser/bookmarks-store";
import type { Bookmark } from "@/lib/browser-bookmarks";

import { bm, idsOf as ids, makeFetch, readyStore, reply } from "./helpers/bookmarks-fake-fetch";
import { deferred } from "./helpers/deferred";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("初始状态与订阅", () => {
  it("初始是 idle 空快照；没变化时 getSnapshot 返回同一个引用", () => {
    const store = createBookmarksStore(makeFetch(() => reply(200, { bookmarks: [] })).fetchImpl);
    expect(store.getSnapshot()).toBe(IDLE_BOOKMARKS_SNAPSHOT);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("subscribe 返回取消函数；通知期间有人取消订阅不影响其它监听者", async () => {
    const store = createBookmarksStore(makeFetch(() => reply(200, { bookmarks: [bm(1)] })).fetchImpl);
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    let unsubA = () => {};
    unsubA = store.subscribe(() => {
      a();
      unsubA(); // 通知里取消自己
    });
    store.subscribe(b);
    const unsubC = store.subscribe(c);
    unsubC(); // 订阅后立刻取消：一次都不该收到
    await store.load(); // loading → ready 各通知一次
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(c).not.toHaveBeenCalled();
  });

  it("getBookmarksStore 是全应用单例", () => {
    expect(getBookmarksStore()).toBe(getBookmarksStore());
  });

  it("惰性取 fetch：创建 store 时不碰全局 fetch（SSR 安全），用到时才取", async () => {
    const store = createBookmarksStore();
    const fetchMock = vi.fn(async () => reply(200, { bookmarks: [bm(1)] }));
    vi.stubGlobal("fetch", fetchMock);
    await store.load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ids(store)).toEqual(["id-1"]);
  });
});

describe("load", () => {
  it("成功：idle → loading → ready；列表经校验（坏条目丢弃）并按时间倒序；GET 带 no-store", async () => {
    const h = makeFetch(() => reply(200, { bookmarks: [bm(1), { id: "bad" }, { id: "js", url: "javascript:alert(1)" }, bm(3), bm(2)] }));
    const store = createBookmarksStore(h.fetchImpl);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().status));
    await store.load();
    expect(seen).toEqual(["loading", "ready"]);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: null });
    expect(ids(store)).toEqual(["id-3", "id-2", "id-1"]);
    expect(h.calls).toEqual([{ url: BOOKMARKS_API, method: "GET", body: undefined, cache: "no-store" }]);
  });

  it("单飞：并发的 load 复用同一个请求；落定后再 load 才发新请求", async () => {
    const gate = deferred<Response>();
    const h = makeFetch(() => gate.promise);
    const store = createBookmarksStore(h.fetchImpl);
    const all = Promise.all([store.load(), store.load(), store.load()]);
    gate.resolve(reply(200, { bookmarks: [bm(1)] }));
    await all;
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await store.load();
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("首次失败：status=error 带原因、列表为空、load 本身不抛；原因取服务端的中文 error，没有就给「请求失败（状态码）」，网络错用原文", async () => {
    const cases: Array<[() => Promise<Response> | Response, string]> = [
      [() => reply(500, { error: "读取收藏夹失败", code: "list_failed" }), "读取收藏夹失败"],
      [() => reply(502, "<html>bad gateway</html>"), "请求失败（502）"],
      [() => reply(503), "请求失败（503）"],
      [() => Promise.reject(new TypeError("Failed to fetch")), "Failed to fetch"],
    ];
    for (const [impl, expected] of cases) {
      const store = createBookmarksStore(makeFetch(impl).fetchImpl);
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.getSnapshot()).toMatchObject({ status: "error", error: expected, bookmarks: [] });
    }
  });

  it("失败之后重试成功：回到 ready，error 清空", async () => {
    let fail = true;
    const store = createBookmarksStore(makeFetch(() => (fail ? reply(500, { error: "boom" }) : reply(200, { bookmarks: [bm(1)] }))).fetchImpl);
    await store.load();
    expect(store.getSnapshot().status).toBe("error");
    fail = false;
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: null });
    expect(ids(store)).toEqual(["id-1"]);
  });

  it("已有数据时再 load = 后台刷新：status 始终是 ready（不闪 loading）", async () => {
    const { store } = await readyStore([bm(1)], () => reply(200, { bookmarks: [bm(2), bm(1)] }));
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().status));
    await store.load();
    expect(seen.every((s) => s === "ready")).toBe(true);
    expect(ids(store)).toEqual(["id-2", "id-1"]);
  });

  it("后台刷新失败：保留陈旧列表、status 仍是 ready、不变成 error（陈旧的列表比空白好用）", async () => {
    const { store } = await readyStore([bm(1), bm(2)], () => reply(500, { error: "boom" }));
    const before = store.getSnapshot();
    await store.load();
    expect(store.getSnapshot()).toBe(before);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: null });
  });
});

describe("add", () => {
  it("已加载：POST 带 JSON body，成功后直接按回包改本地（新的在最前），不再发 GET；返回 { bookmark, created }", async () => {
    const { store, calls, gets } = await readyStore([bm(1), bm(2)], () => reply(201, { bookmark: bm(9, { createdAt: 5000 }), created: true }));
    const seen: Array<readonly Bookmark[]> = [];
    store.subscribe(() => seen.push(store.getSnapshot().bookmarks));
    const result = await store.add({ url: "https://example.com/p9", title: "nine" });
    expect(result.created).toBe(true);
    expect(result.bookmark.id).toBe("id-9");
    expect(ids(store)).toEqual(["id-9", "id-2", "id-1"]);
    expect(calls).toEqual([{ url: BOOKMARKS_API, method: "POST", body: { url: "https://example.com/p9", title: "nine" }, cache: undefined }]);
    expect(gets()).toHaveLength(0);
    expect(seen).toHaveLength(1); // 一次变更只通知一次
  });

  it("撤销删除的请求带 createdAt 原样发给服务端；服务端回的位置决定本地位置", async () => {
    const { store, calls } = await readyStore([bm(1), bm(3)], () => reply(201, { bookmark: bm(2), created: true }));
    await store.add({ url: "https://example.com/p2", title: "title 2", createdAt: 1002 });
    expect((calls[0]!.body as { createdAt: number }).createdAt).toBe(1002);
    expect(ids(store)).toEqual(["id-3", "id-2", "id-1"]); // 回到原来的中间位置
  });

  it("地址已收藏（created:false）：用服务端回的那条替换本地同一条（按地址 / id 去重，不出重复），顶到最前", async () => {
    const { store } = await readyStore([bm(1), bm(2), bm(3)], () => reply(200, { bookmark: bm(2, { title: "新标题", createdAt: 9000 }), created: false }));
    const result = await store.add({ url: "https://example.com/p2", title: "新标题" });
    expect(result.created).toBe(false);
    expect(ids(store)).toEqual(["id-2", "id-3", "id-1"]);
    expect(store.getSnapshot().bookmarks[0]!.title).toBe("新标题");
  });

  it("失败：抛 Error(服务端中文原因)，本地列表原样（同一个引用）", async () => {
    const { store } = await readyStore([bm(1)], () => reply(409, { error: "收藏夹已满（最多 500 个），请先删除一些", code: "limit_reached" }));
    const before = store.getSnapshot();
    await expect(store.add({ url: "https://example.com/x" })).rejects.toThrow("收藏夹已满（最多 500 个），请先删除一些");
    expect(store.getSnapshot()).toBe(before);
  });

  it("失败原因的兜底：非 JSON 回包 →「请求失败（状态码）」；网络错抛原文", async () => {
    const a = await readyStore([bm(1)], () => reply(500, "oops"));
    await expect(a.store.add({ url: "https://example.com/x" })).rejects.toThrow("请求失败（500）");
    const b = await readyStore([bm(1)], () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(b.store.add({ url: "https://example.com/x" })).rejects.toThrow("Failed to fetch");
  });

  it("成功回包的收藏格式不对（缺 bookmark / 地址不合法）：抛错，不污染本地列表", async () => {
    for (const body of [{ created: true }, { bookmark: null, created: true }, { bookmark: { id: "x", url: "javascript:alert(1)", title: "x", createdAt: 1 }, created: true }, "not json at all"]) {
      const { store } = await readyStore([bm(1)], () => reply(201, body));
      const before = store.getSnapshot();
      await expect(store.add({ url: "https://example.com/x" })).rejects.toThrow("服务端返回的收藏格式不对");
      expect(store.getSnapshot()).toBe(before);
    }
  });

  it("还没加载成功过：变更成功后不能把「只有这一条」当完整列表——改为重拉整份列表", async () => {
    const h = makeFetch((call) => (call.method === "POST" ? reply(201, { bookmark: bm(9), created: true }) : reply(200, { bookmarks: [bm(9), bm(1), bm(2)] })));
    const store = createBookmarksStore(h.fetchImpl);
    expect(store.getSnapshot().status).toBe("idle");
    await store.add({ url: "https://example.com/p9", title: "nine" });
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    expect(ids(store)).toEqual(["id-9", "id-2", "id-1"]); // 整份来自重拉的 GET（含 POST 之外的 id-1/id-2），按时间倒序
    expect(h.gets()).toHaveLength(1);
  });
});

describe("乱序保护：load 在途期间发生变更", () => {
  it("未加载时：GET 先发、POST 先落盘 → 第一次 GET 的结果不含新增，被丢弃并重拉一次，最终列表含新增", async () => {
    const firstGet = deferred<Response>();
    let gets = 0;
    const h = makeFetch((call) => {
      if (call.method === "POST") return reply(201, { bookmark: bm(9), created: true });
      gets += 1;
      return gets === 1 ? firstGet.promise : reply(200, { bookmarks: [bm(9), bm(1)] });
    });
    const store = createBookmarksStore(h.fetchImpl);
    const loading = store.load(); // GET #1 在途（服务端是在 POST 落盘之前读的）
    await store.add({ url: "https://example.com/p9", title: "nine" }); // 变更成功：版本号 +1；未加载 → load() 并入在途的那次
    firstGet.resolve(reply(200, { bookmarks: [bm(1)] })); // 陈旧结果
    await loading;
    expect(h.gets()).toHaveLength(2); // 陈旧结果丢弃、重拉了一次
    expect(store.getSnapshot().status).toBe("ready");
    expect(ids(store)).toEqual(["id-9", "id-1"]);
  });

  it("已加载时的后台刷新：变更已即时改了本地，陈旧的 GET 结果到达时不能覆盖它——重拉期间本地仍含新增", async () => {
    const staleGet = deferred<Response>();
    const secondGet = deferred<Response>();
    let gets = 0;
    const { store, gets: getCalls } = await readyStore([bm(1)], (call) => {
      if (call.method === "POST") return reply(201, { bookmark: bm(9), created: true });
      gets += 1;
      return gets === 1 ? staleGet.promise : secondGet.promise;
    });
    const refresh = store.load(); // 后台刷新，GET #1 在途
    await store.add({ url: "https://example.com/p9", title: "nine" });
    expect(ids(store)).toEqual(["id-9", "id-1"]); // 本地已即时翻转
    staleGet.resolve(reply(200, { bookmarks: [bm(1)] })); // 不含新增的陈旧结果
    await vi.waitFor(() => expect(getCalls()).toHaveLength(2)); // 丢弃并发起了第二次
    expect(ids(store)).toEqual(["id-9", "id-1"]); // 陈旧结果没有覆盖本地
    secondGet.resolve(reply(200, { bookmarks: [bm(9), bm(1)] }));
    await refresh;
    expect(ids(store)).toEqual(["id-9", "id-1"]);
  });

  it("没有变更时不重拉：一次 GET 就落定", async () => {
    const h = makeFetch(() => reply(200, { bookmarks: [bm(1)] }));
    const store = createBookmarksStore(h.fetchImpl);
    await store.load();
    expect(h.gets()).toHaveLength(1);
  });
});

describe("remove", () => {
  it("已加载：DELETE ?id=（id 做 URL 编码），成功后本地立刻去掉，不发 GET", async () => {
    const weird = bm(1, { id: "a/b c?d" });
    const { store, calls, gets } = await readyStore([weird, bm(2)], () => reply(200, { ok: true }));
    await store.remove("a/b c?d");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `${BOOKMARKS_API}?id=${encodeURIComponent("a/b c?d")}` });
    expect(ids(store)).toEqual(["id-2"]);
    expect(gets()).toHaveLength(0);
  });

  it("服务端说 404（别处已经删了）当成功：目的达到了，本地照样去掉", async () => {
    const { store } = await readyStore([bm(1), bm(2)], () => reply(404, { error: "收藏不存在（可能已被删除）", code: "not_found" }));
    await expect(store.remove("id-1")).resolves.toBeUndefined();
    expect(ids(store)).toEqual(["id-2"]);
  });

  it("其它失败：抛 Error(原因)，本地列表原样", async () => {
    const a = await readyStore([bm(1)], () => reply(500, { error: "删除收藏失败", code: "remove_failed" }));
    const before = a.store.getSnapshot();
    await expect(a.store.remove("id-1")).rejects.toThrow("删除收藏失败");
    expect(a.store.getSnapshot()).toBe(before);

    const b = await readyStore([bm(1)], () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(b.store.remove("id-1")).rejects.toThrow("Failed to fetch");
    expect(ids(b.store)).toEqual(["id-1"]);
  });

  it("还没加载成功过：删除成功后改为重拉，不拿空列表当真", async () => {
    const h = makeFetch((call) => (call.method === "DELETE" ? reply(200, { ok: true }) : reply(200, { bookmarks: [bm(2)] })));
    const store = createBookmarksStore(h.fetchImpl);
    await store.remove("id-1");
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    expect(ids(store)).toEqual(["id-2"]);
    expect(h.gets()).toHaveLength(1);
  });
});
