/**
 * 收藏的交互流程：
 * - bookmark-flow.ts（无 React 的判定与顺序：能不能收藏、切换、撤销请求、打开方式、列表视图）；
 * - use-bookmark-actions.ts（hook 真跑在受控 dispatcher 下：防连点、取最新快照判断、toast / 撤销）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOOKMARK_ADD_LABEL,
  BOOKMARK_FILTER_THRESHOLD,
  BOOKMARK_REMOVE_LABEL,
  bookmarkErrorText,
  bookmarkListView,
  bookmarkTargetOf,
  bookmarkToggleLabel,
  resolveBookmarkOpen,
  restoreRequestOf,
  runToggleBookmark,
  type ToggleBookmarkDeps,
} from "@/components/browser/bookmark-flow";
import type { BookmarksStore } from "@/components/browser/bookmarks-store";
import { useBookmarkActions } from "@/components/browser/use-bookmark-actions";
import type { Bookmark } from "@/lib/browser-bookmarks";

import { bm, readyStore, reply } from "./helpers/bookmarks-fake-fetch";
import { deferred } from "./helpers/deferred";
import { createHookHarness } from "./helpers/react-hook-stub";

// ───────────── sonner / store 注入（hook 测试用） ─────────────
const toastMock = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { error: ReturnType<typeof vi.fn> };
  fn.error = vi.fn();
  return fn;
});
vi.mock("sonner", () => ({ toast: toastMock }));

const storeHolder = vi.hoisted(() => ({ current: null as unknown as BookmarksStore }));
vi.mock("@/components/browser/bookmarks-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/browser/bookmarks-store")>();
  return { ...actual, getBookmarksStore: () => storeHolder.current };
});

beforeEach(() => {
  toastMock.mockClear();
  toastMock.error.mockClear();
});

// ───────────── 纯函数 ─────────────
describe("bookmarkTargetOf：只有 http(s) 网页能收藏", () => {
  it("http / https → 目标（地址原样、不规整；规整交给服务端与 findBookmarkByUrl 的同一口径）", () => {
    expect(bookmarkTargetOf({ url: "https://example.com/a", title: "示例" })).toEqual({ url: "https://example.com/a", title: "示例" });
    expect(bookmarkTargetOf({ url: "HTTP://Example.com:80/a#x", title: "T" })).toEqual({ url: "HTTP://Example.com:80/a#x", title: "T" });
  });

  it("标题不是字符串 / 缺失 → 空串（服务端再退回主机名）", () => {
    expect(bookmarkTargetOf({ url: "https://example.com/", title: null })?.title).toBe("");
    expect(bookmarkTargetOf({ url: "https://example.com/" })?.title).toBe("");
    expect(bookmarkTargetOf({ url: "https://example.com/", title: 42 as never })?.title).toBe("");
  });

  it.each([
    ["没有标签", null],
    ["undefined", undefined],
    ["空白页", { url: "about:blank", title: "" }],
    ["错误页", { url: "chrome-error://chromewebdata/", title: "" }],
    ["file:", { url: "file:///etc/passwd", title: "x" }],
    ["javascript:", { url: "javascript:alert(1)", title: "x" }],
    ["data:", { url: "data:text/html,<b>x</b>", title: "x" }],
    ["url 缺失", { title: "x" }],
    ["url 为 null", { url: null, title: "x" }],
    ["url 是空串", { url: "", title: "x" }],
    ["不是 URL", { url: "not a url", title: "x" }],
  ])("%s → null", (_name, tab) => {
    expect(bookmarkTargetOf(tab as never)).toBeNull();
  });
});

describe("文案与列表视图", () => {
  it("bookmarkToggleLabel：已收藏 → 取消收藏；否则 → 收藏此页", () => {
    expect(bookmarkToggleLabel(true)).toBe(BOOKMARK_REMOVE_LABEL);
    expect(bookmarkToggleLabel(false)).toBe(BOOKMARK_ADD_LABEL);
    expect(BOOKMARK_REMOVE_LABEL).toBe("取消收藏");
    expect(BOOKMARK_ADD_LABEL).toBe("收藏此页");
  });

  it("bookmarkErrorText：Error 取 message（去首尾空白）；空 message / 非 Error 一律兜底，不透出 [object Object]", () => {
    expect(bookmarkErrorText(new Error("  收藏夹已满  "))).toBe("收藏夹已满");
    for (const weird of [new Error(""), new Error("   "), "字符串", { message: "x" }, undefined, null, 42]) {
      expect(bookmarkErrorText(weird), String(weird)).toBe("操作失败，请稍后重试");
    }
  });

  it("bookmarkListView：不超过阈值 → 不出过滤框、不过滤；超过 → 出过滤框并按标题 / 地址过滤（不区分大小写）", () => {
    const few = Array.from({ length: BOOKMARK_FILTER_THRESHOLD }, (_, i) => bm(i + 1));
    expect(bookmarkListView(few, "")).toEqual({ showFilter: false, query: "", visible: few });

    const many = [...few, bm(99, { title: "Needle Doc", url: "https://docs.example.org/guide" })];
    const all = bookmarkListView(many, "");
    expect(all.showFilter).toBe(true);
    expect(all.visible).toHaveLength(many.length);
    expect(bookmarkListView(many, "  needle ").visible.map((b) => b.id)).toEqual(["id-99"]);
    expect(bookmarkListView(many, "DOCS.EXAMPLE").visible.map((b) => b.id)).toEqual(["id-99"]);
    expect(bookmarkListView(many, "  needle ").query).toBe("needle"); // 返回的是 trim 之后生效的词
    expect(bookmarkListView(many, "zzz").visible).toEqual([]);
  });

  it("过滤框不显示时忽略残留的查询词：列表缩到阈值以下后，不能被看不见的过滤词藏光", () => {
    const few = Array.from({ length: BOOKMARK_FILTER_THRESHOLD }, (_, i) => bm(i + 1));
    const view = bookmarkListView(few, "残留的词");
    expect(view.showFilter).toBe(false);
    expect(view.query).toBe("");
    expect(view.visible).toEqual(few);
  });

  it("resolveBookmarkOpen：只有「要新标签 且 会话已存在」才走 new-tab；没有会话时退回当前标签（navigate 会启动会话）", () => {
    expect(resolveBookmarkOpen({ newTab: true, sessionExists: true })).toBe("new-tab");
    expect(resolveBookmarkOpen({ newTab: true, sessionExists: false })).toBe("navigate");
    expect(resolveBookmarkOpen({ newTab: false, sessionExists: true })).toBe("navigate");
    expect(resolveBookmarkOpen({ newTab: false, sessionExists: false })).toBe("navigate");
  });

  it("restoreRequestOf：撤销要带回原来的收藏时间（回到原位，不是顶到最前），且不带 id", () => {
    expect(restoreRequestOf({ id: "id-7", url: "https://example.com/p7", title: "title 7", createdAt: 1007 })).toEqual({
      url: "https://example.com/p7",
      title: "title 7",
      createdAt: 1007,
    });
  });
});

describe("runToggleBookmark", () => {
  const target = { url: "https://example.com/a", title: "A 页面" };
  const existing: Bookmark = { id: "id-a", url: "https://example.com/a", title: "旧标题", createdAt: 5 };

  const make = (over: Partial<ToggleBookmarkDeps> = {}) => {
    const order: string[] = [];
    const deps = {
      target,
      bookmarks: [] as Bookmark[],
      add: vi.fn(async () => {
        order.push("add");
      }),
      remove: vi.fn(async () => {
        order.push("remove");
      }),
      onRemoved: vi.fn(() => {
        order.push("onRemoved");
      }),
      onError: vi.fn(() => {
        order.push("onError");
      }),
      ...over,
    } satisfies ToggleBookmarkDeps;
    return { deps, order };
  };

  it("没收藏 → add({ url, title })，返回 added；不删、不弹撤销", async () => {
    const { deps } = make();
    await expect(runToggleBookmark(deps)).resolves.toBe("added");
    expect(deps.add).toHaveBeenCalledWith({ url: target.url, title: target.title });
    expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.onRemoved).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("已收藏 → remove(id) 成功之后才 onRemoved(原收藏)，返回 removed；不 add", async () => {
    const { deps, order } = make({ bookmarks: [existing] });
    await expect(runToggleBookmark(deps)).resolves.toBe("removed");
    expect(deps.remove).toHaveBeenCalledWith("id-a");
    expect(deps.onRemoved).toHaveBeenCalledWith(existing);
    expect(deps.add).not.toHaveBeenCalled();
    expect(order).toEqual(["remove", "onRemoved"]);
  });

  it("判断「已收藏」用与服务端同一套规整：默认端口 / host 大小写 / userinfo 的不同写法不会让星标和服务端对不上", async () => {
    for (const url of ["HTTPS://EXAMPLE.com:443/a", "https://user:pw@example.com/a", "  https://example.com:443/a  "]) {
      const { deps } = make({ bookmarks: [existing], target: { url, title: "x" } });
      await expect(runToggleBookmark(deps), url).resolves.toBe("removed");
      expect(deps.add, url).not.toHaveBeenCalled();
    }
  });

  it("hash 算地址的一部分（hash 路由的单页应用里 #/a 与 #/b 是两个页面）：不同 hash = 不同收藏", async () => {
    const hashed: Bookmark = { id: "id-h", url: "https://app.example.com/#/orders", title: "订单", createdAt: 9 };
    const same = make({ bookmarks: [hashed], target: { url: "https://app.example.com/#/orders", title: "订单" } });
    await expect(runToggleBookmark(same.deps)).resolves.toBe("removed");
    const other = make({ bookmarks: [hashed], target: { url: "https://app.example.com/#/users", title: "用户" } });
    await expect(runToggleBookmark(other.deps)).resolves.toBe("added");
    expect(other.deps.remove).not.toHaveBeenCalled();
  });

  it("add 失败 → failed，原因交给 onError；永远不抛", async () => {
    const { deps } = make({
      add: vi.fn(async () => {
        throw new Error("收藏夹已满（最多 500 个），请先删除一些");
      }),
    });
    await expect(runToggleBookmark(deps)).resolves.toBe("failed");
    expect(deps.onError).toHaveBeenCalledWith("收藏夹已满（最多 500 个），请先删除一些");
    expect(deps.onRemoved).not.toHaveBeenCalled();
  });

  it("remove 失败 → failed，且不弹「已取消收藏」的撤销（东西并没有被删掉）", async () => {
    const { deps } = make({
      bookmarks: [existing],
      remove: vi.fn(async () => {
        throw new Error("删除收藏失败");
      }),
    });
    await expect(runToggleBookmark(deps)).resolves.toBe("failed");
    expect(deps.onRemoved).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith("删除收藏失败");
  });

  it("抛出非 Error 的值 → 兜底文案", async () => {
    const { deps } = make({ add: vi.fn(() => Promise.reject("boom")) });
    await expect(runToggleBookmark(deps)).resolves.toBe("failed");
    expect(deps.onError).toHaveBeenCalledWith("操作失败，请稍后重试");
  });

  it("add / remove 同步抛错也走 onError（不让点击处理器里冒出未处理的异常）", async () => {
    const { deps } = make({
      add: vi.fn(() => {
        throw new Error("sync boom");
      }),
    });
    await expect(runToggleBookmark(deps)).resolves.toBe("failed");
    expect(deps.onError).toHaveBeenCalledWith("sync boom");
  });
});

// ───────────── hook：useBookmarkActions ─────────────
describe("useBookmarkActions（hook 真跑）", () => {
  const target = { url: "https://example.com/p1", title: "title 1" };

  /** 装一个已加载 initial 的 store 注入给 hook；hook 以 autoLoad:false 渲染（加载由测试自己控制） */
  const setup = async (initial: Bookmark[], impl: Parameters<typeof readyStore>[1]) => {
    const ctx = await readyStore(initial, impl);
    storeHolder.current = ctx.store;
    const harness = createHookHarness({ memoCallbacks: true });
    const render = () => harness.render(() => useBookmarkActions({ autoLoad: false }));
    return { ...ctx, harness, render };
  };

  it("没收藏 → toggle 发 POST，返回 added；成功没有 toast（星标变亮就是反馈）", async () => {
    const { render, calls } = await setup([], () => reply(201, { bookmark: bm(1), created: true }));
    const api = render();
    await expect(api.toggle(target)).resolves.toBe("added");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", body: { url: target.url, title: target.title } });
    expect(toastMock).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(render().bookmarks.map((b) => b.id)).toEqual(["id-1"]);
  });

  it("已收藏 → toggle 发 DELETE，返回 removed，并弹带「撤销」的 toast（8 秒、标题被截成一行）", async () => {
    const long = bm(1, { title: `很长的标题${"字".repeat(60)}` });
    const { render, calls } = await setup([long], () => reply(200, { ok: true }));
    const api = render();
    await expect(api.toggle({ url: long.url, title: long.title })).resolves.toBe("removed");
    expect(calls[0]).toMatchObject({ method: "DELETE" });
    expect(toastMock).toHaveBeenCalledTimes(1);
    const [message, options] = toastMock.mock.calls[0] as [string, { duration: number; action: { label: string; onClick: () => void } }];
    expect(message.startsWith("已取消收藏「很长的标题")).toBe(true);
    expect(message.endsWith("…」")).toBe(true);
    expect(message.length).toBeLessThan(45); // 标题被截到 28 字 + 省略号，不是整段塞进 toast
    expect(options.duration).toBe(8000);
    expect(options.action.label).toBe("撤销");
  });

  it("点「撤销」→ 带着原来的收藏时间 POST 回去，列表回到原位", async () => {
    const list = [bm(3), bm(2), bm(1)];
    const { render, calls, store } = await setup(list, (c) => (c.method === "DELETE" ? reply(200, { ok: true }) : reply(201, { bookmark: bm(2), created: true })));
    const api = render();
    await api.toggle({ url: bm(2).url, title: bm(2).title });
    expect(store.getSnapshot().bookmarks.map((b) => b.id)).toEqual(["id-3", "id-1"]);
    const options = toastMock.mock.calls[0]![1] as { action: { onClick: () => void } };
    options.action.onClick();
    await vi.waitFor(() => expect(store.getSnapshot().bookmarks.map((b) => b.id)).toEqual(["id-3", "id-2", "id-1"]));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ url: bm(2).url, title: bm(2).title, createdAt: bm(2).createdAt });
  });

  it("撤销失败 → 错误 toast「恢复收藏失败：原因」", async () => {
    const { render } = await setup([bm(1)], (c) => (c.method === "DELETE" ? reply(200, { ok: true }) : reply(409, { error: "收藏夹已满" })));
    const api = render();
    await api.toggle({ url: bm(1).url, title: bm(1).title });
    (toastMock.mock.calls[0]![1] as { action: { onClick: () => void } }).action.onClick();
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("恢复收藏失败：收藏夹已满"));
  });

  it("失败 → 返回 failed 并弹错误 toast（服务端的中文原因），不弹撤销", async () => {
    const { render } = await setup([], () => reply(409, { error: "收藏夹已满（最多 500 个），请先删除一些", code: "limit_reached" }));
    const api = render();
    await expect(api.toggle(target)).resolves.toBe("failed");
    expect(toastMock.error).toHaveBeenCalledWith("收藏夹已满（最多 500 个），请先删除一些");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("判断「已收藏」用调用时 store 里的最新快照，不用渲染时闭包里的旧列表（连续操作不会拿着过期列表做错判断）", async () => {
    const { render, calls, store } = await setup([], (c) => (c.method === "GET" ? reply(200, { bookmarks: [bm(1)] }) : reply(200, { ok: true })));
    const api = render(); // 渲染时列表是空的
    expect(api.bookmarks).toEqual([]);
    await store.load(); // 渲染之后别处（另一个窗口 / 对话框）把这页收藏进来了：store 里现在有它
    expect(store.getSnapshot().bookmarks.map((b) => b.id)).toEqual(["id-1"]);
    expect(api.bookmarks).toEqual([]); // 手里这份渲染快照仍是旧的
    await expect(api.toggle({ url: bm(1).url, title: "x" })).resolves.toBe("removed"); // 但切换看的是调用时的最新快照
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("防连点：切换进行中再点直接忽略（返回 busy、不发第二个请求）；落定后又能点；busy 状态随之翻转", async () => {
    const gate = deferred<Response>();
    const { render, calls, harness } = await setup([], () => gate.promise);
    const api = render();
    const first = api.toggle(target);
    expect(harness.states()[0]).toBe(true); // busy
    await expect(api.toggle(target)).resolves.toBe("busy");
    await expect(api.toggle(target)).resolves.toBe("busy");
    expect(calls).toHaveLength(1);
    gate.resolve(reply(201, { bookmark: bm(1), created: true }));
    await expect(first).resolves.toBe("added");
    expect(harness.states()[0]).toBe(false);
    // 落定之后不再 busy：下一次是「已收藏 → 取消」
    const next = render();
    expect(next.busy).toBe(false);
  });

  it("失败后也会放开 busy（finally）：不会卡死星标", async () => {
    let fail = true;
    const { render } = await setup([], () => (fail ? reply(500, { error: "boom" }) : reply(201, { bookmark: bm(1), created: true })));
    const api = render();
    await expect(api.toggle(target)).resolves.toBe("failed");
    fail = false;
    await expect(api.toggle(target)).resolves.toBe("added");
  });

  it("removeWithUndo：成功 → true + 「已删除收藏」撤销 toast；失败 → false + 错误 toast，不弹撤销", async () => {
    const ok = await setup([bm(1)], () => reply(200, { ok: true }));
    await expect(ok.render().removeWithUndo(bm(1))).resolves.toBe(true);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0]![0]).toBe("已删除收藏「title 1」");
    expect((toastMock.mock.calls[0]![1] as { action: { label: string } }).action.label).toBe("撤销");

    toastMock.mockClear();
    const bad = await setup([bm(1)], () => reply(500, { error: "删除收藏失败" }));
    await expect(bad.render().removeWithUndo(bm(1))).resolves.toBe(false);
    expect(toastMock).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("删除失败：删除收藏失败");
  });
});
