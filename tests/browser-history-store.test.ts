/**
 * 地址栏记忆的前端 store（src/components/browser/history-store.ts，无 React，假 fetch 驱动）。
 * 与收藏夹 store 同一套行为（load 单飞 / 后台刷新失败保留陈旧列表 / 变更改本地 / 未加载时变更改为重拉 / 乱序保护 / 404 当成功 / 快照引用稳定），
 * 另外钉死 record（回包合并进本地、同地址替换不出重复）与 clear（清空本地、未加载时改为重拉、失败不动本地）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHistoryStore, getHistoryStore, HISTORY_API, IDLE_HISTORY_SNAPSHOT } from "@/components/browser/history-store";
import type { HistoryEntry } from "@/lib/browser-history";

import { deferred } from "./helpers/deferred";
import { hist, idsOf as ids, makeFetch, readyHistoryStore, reply } from "./helpers/history-fake-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("初始状态与订阅", () => {
  it("初始是 idle 空快照；没变化时 getSnapshot 返回同一个引用", () => {
    const store = createHistoryStore(makeFetch(() => reply(200, { history: [] })).fetchImpl);
    expect(store.getSnapshot()).toBe(IDLE_HISTORY_SNAPSHOT);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("subscribe 返回取消函数；通知期间有人取消订阅不影响其它监听者", async () => {
    const store = createHistoryStore(makeFetch(() => reply(200, { history: [hist(1)] })).fetchImpl);
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    let unsubA = () => {};
    unsubA = store.subscribe(() => {
      a();
      unsubA();
    });
    store.subscribe(b);
    store.subscribe(c)();
    await store.load(); // loading → ready 各通知一次
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(c).not.toHaveBeenCalled();
  });

  it("getHistoryStore 是全应用单例", () => {
    expect(getHistoryStore()).toBe(getHistoryStore());
  });

  it("惰性取 fetch：创建 store 时不碰全局 fetch（SSR 安全），用到时才取", async () => {
    const store = createHistoryStore();
    const fetchMock = vi.fn(async () => reply(200, { history: [hist(1)] }));
    vi.stubGlobal("fetch", fetchMock);
    await store.load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ids(store)).toEqual(["h-1"]);
  });
});

describe("load", () => {
  it("成功：idle → loading → ready；列表经校验（坏条目丢弃）并按最近访问倒序；GET 带 no-store", async () => {
    const h = makeFetch(() => reply(200, { history: [hist(1), { id: "bad" }, { id: "js", url: "javascript:alert(1)" }, hist(3), hist(2)] }));
    const store = createHistoryStore(h.fetchImpl);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().status));
    await store.load();
    expect(seen).toEqual(["loading", "ready"]);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: null });
    expect(ids(store)).toEqual(["h-3", "h-2", "h-1"]);
    expect(h.calls).toEqual([{ url: HISTORY_API, method: "GET", body: undefined, cache: "no-store" }]);
  });

  it("单飞：并发的 load 复用同一个请求；落定后再 load 才发新请求", async () => {
    const gate = deferred<Response>();
    const h = makeFetch(() => gate.promise);
    const store = createHistoryStore(h.fetchImpl);
    const all = Promise.all([store.load(), store.load(), store.load()]);
    gate.resolve(reply(200, { history: [hist(1)] }));
    await all;
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await store.load();
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("首次失败：status=error 带原因、列表为空、load 本身不抛；原因取服务端的中文 error，没有就给「请求失败（状态码）」，网络错用原文", async () => {
    const cases: Array<[() => Promise<Response> | Response, string]> = [
      [() => reply(500, { error: "读取浏览历史失败", code: "list_failed" }), "读取浏览历史失败"],
      [() => reply(502, "<html>bad gateway</html>"), "请求失败（502）"],
      [() => reply(503), "请求失败（503）"],
      [() => Promise.reject(new TypeError("Failed to fetch")), "Failed to fetch"],
    ];
    for (const [impl, expected] of cases) {
      const store = createHistoryStore(makeFetch(impl).fetchImpl);
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.getSnapshot()).toMatchObject({ status: "error", error: expected, history: [] });
    }
  });

  it("失败之后重试成功：回到 ready，error 清空", async () => {
    let fail = true;
    const store = createHistoryStore(makeFetch(() => (fail ? reply(500, { error: "boom" }) : reply(200, { history: [hist(1)] }))).fetchImpl);
    await store.load();
    expect(store.getSnapshot().status).toBe("error");
    fail = false;
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: null });
    expect(ids(store)).toEqual(["h-1"]);
  });

  it("已有数据时再 load = 后台刷新：status 始终是 ready（不闪 loading）", async () => {
    const { store } = await readyHistoryStore([hist(1)], () => reply(200, { history: [hist(2), hist(1)] }));
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().status));
    await store.load();
    expect(seen.every((s) => s === "ready")).toBe(true);
    expect(ids(store)).toEqual(["h-2", "h-1"]);
  });

  it("后台刷新失败：保留陈旧列表、status 仍是 ready、不变成 error（陈旧的联想比没有联想好用）", async () => {
    const { store } = await readyHistoryStore([hist(1), hist(2)], () => reply(500, { error: "boom" }));
    const before = store.getSnapshot();
    await store.load();
    expect(store.getSnapshot()).toBe(before);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: null });
  });
});

describe("record", () => {
  const recorded = (i: number, over: Partial<HistoryEntry> = {}) => hist(i, { lastVisitAt: 5000 + i, ...over });

  it("已加载：POST 带 JSON body，成功后直接按回包合并进本地（最近的在最前），不再发 GET；返回 { entry, created }", async () => {
    const { store, calls, gets } = await readyHistoryStore([hist(1), hist(2)], () => reply(201, { entry: recorded(9), created: true }));
    const seen: Array<readonly HistoryEntry[]> = [];
    store.subscribe(() => seen.push(store.getSnapshot().history));
    const result = await store.record({ url: "https://example.com/p9", title: "nine" });
    expect(result.created).toBe(true);
    expect(result.entry.id).toBe("h-9");
    expect(ids(store)).toEqual(["h-9", "h-2", "h-1"]);
    expect(calls).toEqual([{ url: HISTORY_API, method: "POST", body: { url: "https://example.com/p9", title: "nine" }, cache: undefined }]);
    expect(gets()).toHaveLength(0);
    expect(seen).toHaveLength(1); // 一次变更只通知一次
  });

  it("地址以前记过（created:false）：用服务端回的那条替换本地同一条（按地址 / id 去重，不出重复），顶到最前", async () => {
    const { store } = await readyHistoryStore([hist(1), hist(2), hist(3)], () => reply(200, { entry: recorded(2, { visitCount: 5, title: "新标题" }), created: false }));
    const result = await store.record({ url: "https://example.com/p2", title: "新标题" });
    expect(result.created).toBe(false);
    expect(ids(store)).toEqual(["h-2", "h-3", "h-1"]);
    expect(store.getSnapshot().history[0]).toMatchObject({ title: "新标题", visitCount: 5 });
  });

  it("失败：抛 Error(服务端中文原因)，本地列表原样（同一个引用）", async () => {
    const { store } = await readyHistoryStore([hist(1)], () => reply(400, { error: "这个地址不记入浏览历史", code: "invalid_url" }));
    const before = store.getSnapshot();
    await expect(store.record({ url: "nope" })).rejects.toThrow("这个地址不记入浏览历史");
    expect(store.getSnapshot()).toBe(before);
  });

  it("失败原因的兜底：非 JSON 回包 →「请求失败（状态码）」；网络错抛原文", async () => {
    const a = await readyHistoryStore([hist(1)], () => reply(500, "oops"));
    await expect(a.store.record({ url: "https://example.com/x" })).rejects.toThrow("请求失败（500）");
    const b = await readyHistoryStore([hist(1)], () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(b.store.record({ url: "https://example.com/x" })).rejects.toThrow("Failed to fetch");
  });

  it("成功回包的记录格式不对（缺 entry / 地址不合法）：抛错，不污染本地列表", async () => {
    for (const body of [{ created: true }, { entry: null, created: true }, { entry: { id: "x", url: "javascript:alert(1)", title: "x", visitCount: 1, lastVisitAt: 1 }, created: true }, "not json at all"]) {
      const { store } = await readyHistoryStore([hist(1)], () => reply(201, body));
      const before = store.getSnapshot();
      await expect(store.record({ url: "https://example.com/x" })).rejects.toThrow("服务端返回的记录格式不对");
      expect(store.getSnapshot()).toBe(before);
    }
  });

  it("还没加载成功过：变更成功后不能把「只有这一条」当完整列表——改为重拉整份列表", async () => {
    const h = makeFetch((call) => (call.method === "POST" ? reply(201, { entry: recorded(9), created: true }) : reply(200, { history: [recorded(9), hist(1), hist(2)] })));
    const store = createHistoryStore(h.fetchImpl);
    expect(store.getSnapshot().status).toBe("idle");
    await store.record({ url: "https://example.com/p9", title: "nine" });
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    expect(ids(store)).toEqual(["h-9", "h-2", "h-1"]);
    expect(h.gets()).toHaveLength(1);
  });
});

describe("乱序保护：load 在途期间发生变更", () => {
  it("未加载时：GET 先发、POST 先落盘 → 第一次 GET 的结果不含新增，被丢弃并重拉一次，最终列表含新增", async () => {
    const firstGet = deferred<Response>();
    let gets = 0;
    const h = makeFetch((call) => {
      if (call.method === "POST") return reply(201, { entry: hist(9, { lastVisitAt: 9000 }), created: true });
      gets += 1;
      return gets === 1 ? firstGet.promise : reply(200, { history: [hist(9, { lastVisitAt: 9000 }), hist(1)] });
    });
    const store = createHistoryStore(h.fetchImpl);
    const loading = store.load();
    await store.record({ url: "https://example.com/p9", title: "nine" });
    firstGet.resolve(reply(200, { history: [hist(1)] }));
    await loading;
    expect(h.gets()).toHaveLength(2);
    expect(store.getSnapshot().status).toBe("ready");
    expect(ids(store)).toEqual(["h-9", "h-1"]);
  });

  it("已加载时的后台刷新：变更已即时改了本地，陈旧的 GET 结果到达时不能覆盖它", async () => {
    const staleGet = deferred<Response>();
    const secondGet = deferred<Response>();
    let gets = 0;
    const { store, gets: getCalls } = await readyHistoryStore([hist(1)], (call) => {
      if (call.method === "POST") return reply(201, { entry: hist(9, { lastVisitAt: 9000 }), created: true });
      gets += 1;
      return gets === 1 ? staleGet.promise : secondGet.promise;
    });
    const refresh = store.load();
    await store.record({ url: "https://example.com/p9", title: "nine" });
    expect(ids(store)).toEqual(["h-9", "h-1"]);
    staleGet.resolve(reply(200, { history: [hist(1)] }));
    await vi.waitFor(() => expect(getCalls()).toHaveLength(2));
    expect(ids(store)).toEqual(["h-9", "h-1"]);
    secondGet.resolve(reply(200, { history: [hist(9, { lastVisitAt: 9000 }), hist(1)] }));
    await refresh;
    expect(ids(store)).toEqual(["h-9", "h-1"]);
  });

  it("没有变更时不重拉：一次 GET 就落定", async () => {
    const h = makeFetch(() => reply(200, { history: [hist(1)] }));
    const store = createHistoryStore(h.fetchImpl);
    await store.load();
    expect(h.gets()).toHaveLength(1);
  });
});

describe("remove", () => {
  it("已加载：DELETE ?id=（id 做 URL 编码），成功后本地立刻去掉，不发 GET", async () => {
    const weird = hist(1, { id: "a/b c?d" });
    const { store, calls, gets } = await readyHistoryStore([weird, hist(2)], () => reply(200, { ok: true }));
    await store.remove("a/b c?d");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `${HISTORY_API}?id=${encodeURIComponent("a/b c?d")}` });
    expect(ids(store)).toEqual(["h-2"]);
    expect(gets()).toHaveLength(0);
  });

  it("服务端说 404（别处已经删了）当成功：目的达到了，本地照样去掉", async () => {
    const { store } = await readyHistoryStore([hist(1), hist(2)], () => reply(404, { error: "这条记录不存在（可能已被删除）", code: "not_found" }));
    await expect(store.remove("h-1")).resolves.toBeUndefined();
    expect(ids(store)).toEqual(["h-2"]);
  });

  it("其它失败：抛 Error(原因)，本地列表原样", async () => {
    const a = await readyHistoryStore([hist(1)], () => reply(500, { error: "删除浏览历史失败", code: "remove_failed" }));
    const before = a.store.getSnapshot();
    await expect(a.store.remove("h-1")).rejects.toThrow("删除浏览历史失败");
    expect(a.store.getSnapshot()).toBe(before);

    const b = await readyHistoryStore([hist(1)], () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(b.store.remove("h-1")).rejects.toThrow("Failed to fetch");
    expect(ids(b.store)).toEqual(["h-1"]);
  });

  it("本地本来就没有这条（id 不在列表里）：服务端成功后快照引用不变（不触发无谓的重渲染）", async () => {
    const { store } = await readyHistoryStore([hist(1)], () => reply(200, { ok: true }));
    const before = store.getSnapshot();
    await store.remove("not-in-list");
    expect(store.getSnapshot().history).toBe(before.history);
  });

  it("还没加载成功过：删除成功后改为重拉，不拿空列表当真", async () => {
    const h = makeFetch((call) => (call.method === "DELETE" ? reply(200, { ok: true }) : reply(200, { history: [hist(2)] })));
    const store = createHistoryStore(h.fetchImpl);
    await store.remove("h-1");
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    expect(ids(store)).toEqual(["h-2"]);
    expect(h.gets()).toHaveLength(1);
  });
});

describe("clear（清除浏览历史）", () => {
  it("已加载：DELETE ?all=1，成功后本地清空，返回服务端清掉的条数，不发 GET", async () => {
    const { store, calls, gets } = await readyHistoryStore([hist(1), hist(2), hist(3)], () => reply(200, { ok: true, removed: 3 }));
    expect(await store.clear()).toBe(3);
    expect(calls).toEqual([{ url: `${HISTORY_API}?all=1`, method: "DELETE", body: undefined, cache: undefined }]);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", history: [] });
    expect(gets()).toHaveLength(0);
  });

  it("回包里没有合法的 removed → 返回 0，但本地照样清空", async () => {
    for (const body of [{ ok: true }, { ok: true, removed: "3" }, { ok: true, removed: Number.NaN }, "not json"]) {
      const { store } = await readyHistoryStore([hist(1)], () => reply(200, body));
      expect(await store.clear()).toBe(0);
      expect(ids(store)).toEqual([]);
    }
  });

  it("失败：抛 Error(原因)，本地列表原样（同一个引用）", async () => {
    const a = await readyHistoryStore([hist(1)], () => reply(500, { error: "清除浏览历史失败", code: "clear_failed" }));
    const before = a.store.getSnapshot();
    await expect(a.store.clear()).rejects.toThrow("清除浏览历史失败");
    expect(a.store.getSnapshot()).toBe(before);

    const b = await readyHistoryStore([hist(1)], () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(b.store.clear()).rejects.toThrow("Failed to fetch");
    expect(ids(b.store)).toEqual(["h-1"]);
  });

  it("还没加载成功过：清除成功后改为重拉（服务端说了算），不凭空把快照当成已加载的空列表", async () => {
    const h = makeFetch((call) => (call.method === "DELETE" ? reply(200, { ok: true, removed: 4 }) : reply(200, { history: [] })));
    const store = createHistoryStore(h.fetchImpl);
    expect(await store.clear()).toBe(4);
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    expect(h.gets()).toHaveLength(1);
  });
});
