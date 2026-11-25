/**
 * 地址栏记忆（历史）前端测试共用的假 fetch 夹具：不起服务、不碰真实网络。
 * 通用部分（makeFetch / reply / FakeCall）与收藏夹测试共用同一份，这里只补历史专属的造数据与「已加载好」的 store。
 */
import { createHistoryStore } from "@/components/browser/history-store";
import type { HistoryEntry } from "@/lib/browser-history";

import type { FakeCall } from "./bookmarks-fake-fetch";
import { makeFetch, reply } from "./bookmarks-fake-fetch";

export { makeFetch, reply };
export type { FakeCall };

/** 造一条历史：lastVisitAt 随编号递增（编号大 = 更近 = 排得更靠前） */
export const hist = (i: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: `h-${i}`,
  url: `https://example.com/p${i}`,
  title: `title ${i}`,
  visitCount: 1,
  lastVisitAt: 1_000 + i,
  ...over,
});

/**
 * 建一个已加载好 initial 列表的 store。初始那一次 GET 之后清空调用记录，
 * 后面的断言只看「变更」产生的请求；impl 里的 n 从变更之后的第 1 次请求起算。
 */
export const readyHistoryStore = async (initial: HistoryEntry[], impl: (call: FakeCall, n: number) => Promise<Response> | Response) => {
  let primed = false;
  let sinceReady = 0;
  const h = makeFetch((call) => {
    if (!primed) return reply(200, { history: initial });
    sinceReady += 1;
    return impl(call, sinceReady);
  });
  const store = createHistoryStore(h.fetchImpl);
  await store.load();
  if (store.getSnapshot().status !== "ready") throw new Error("readyHistoryStore：初始加载没有成功");
  primed = true;
  h.calls.length = 0;
  h.fetchImpl.mockClear();
  return { store, ...h };
};

export const idsOf = (store: { getSnapshot: () => { history: readonly HistoryEntry[] } }) => store.getSnapshot().history.map((e) => e.id);
