/**
 * 收藏夹前端测试共用的假 fetch 夹具（store / 动作 hook 的测试都用它）：
 * 不起服务、不碰真实网络；每次调用都记下来，回包由测试按 (method, 第几次) 决定。
 */
import { vi } from "vitest";

import { createBookmarksStore } from "@/components/browser/bookmarks-store";
import type { Bookmark } from "@/lib/browser-bookmarks";

/** 造一条收藏：createdAt 随编号递增（编号大 = 更新 = 排得更靠前） */
export const bm = (i: number, over: Partial<Bookmark> = {}): Bookmark => ({
  id: `id-${i}`,
  url: `https://example.com/p${i}`,
  title: `title ${i}`,
  createdAt: 1_000 + i,
  ...over,
});

export const reply = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export interface FakeCall {
  url: string;
  method: string;
  body: unknown;
  cache?: RequestCache;
}

/** 假 fetch：impl 按调用给回包（n = 第几次调用，从 1 起）；所有调用都记在 calls 里 */
export const makeFetch = (impl: (call: FakeCall, n: number) => Promise<Response> | Response) => {
  const calls: FakeCall[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call: FakeCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      cache: init?.cache,
    };
    calls.push(call);
    return impl(call, calls.length);
  });
  return { fetchImpl, calls, gets: () => calls.filter((c) => c.method === "GET") };
};

/**
 * 建一个已加载好 initial 列表的 store。初始那一次 GET 之后清空调用记录，
 * 后面的断言只看「变更」产生的请求；impl 里的 n 从变更之后的第 1 次请求起算。
 */
export const readyStore = async (initial: Bookmark[], impl: (call: FakeCall, n: number) => Promise<Response> | Response) => {
  let primed = false;
  let sinceReady = 0;
  const h = makeFetch((call) => {
    if (!primed) return reply(200, { bookmarks: initial });
    sinceReady += 1;
    return impl(call, sinceReady);
  });
  const store = createBookmarksStore(h.fetchImpl);
  await store.load();
  if (store.getSnapshot().status !== "ready") throw new Error("readyStore：初始加载没有成功");
  primed = true;
  h.calls.length = 0;
  h.fetchImpl.mockClear();
  return { store, ...h };
};

export const idsOf = (store: { getSnapshot: () => { bookmarks: readonly Bookmark[] } }) => store.getSnapshot().bookmarks.map((b) => b.id);
