/**
 * 收藏夹的前端 store（无 React，可在 node 里测）
 *
 * 为什么要自己搭一个 store、而不是每个组件各自 fetch：地址栏旁的星标、「更多」菜单、收藏夹对话框、空状态里的快捷入口
 * 读的是同一份数据——各自 fetch 会出现「对话框里删了、星标还亮着」。store 是全应用单例，组件用 useSyncExternalStore 订阅。
 *
 * 行为要点：
 *  - `load` 单飞（进行中的复用同一个 promise）；已有数据时后台刷新失败不把列表换成报错——陈旧的列表比空白好用；
 *  - 变更（add / remove）成功后：已加载 → 直接按服务端回包改本地列表（星标即时翻转）；还没加载成功过 → 不能把「只有这一条」当成完整列表，改为重新拉；
 *  - 版本号防乱序：load 在途期间发生了变更，这次 load 的结果可能不含该变更（GET 先发、POST 先落盘），不能直接覆盖——丢弃并重拉一次；
 *  - remove 遇到 404（别处已经删了）当成功：目的达到了；
 *  - 快照是不可变对象，只在 set 时换新引用：两次 getSnapshot 之间没有变更就返回同一个引用（useSyncExternalStore 的要求）。
 */
import { parseBookmarkList, sortBookmarks, type Bookmark } from "@/lib/browser-bookmarks";

export type BookmarksStatus = "idle" | "loading" | "ready" | "error";

export interface BookmarksSnapshot {
  status: BookmarksStatus;
  bookmarks: readonly Bookmark[];
  /** status === "error" 时给用户看的原因 */
  error: string | null;
}

export interface AddBookmarkRequest {
  url: string;
  title?: string;
  /** 只给「撤销删除」用：带着原来的时间加回来，它就回到原来的位置 */
  createdAt?: number;
}

export interface BookmarksStore {
  getSnapshot: () => BookmarksSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** 拉一次最新列表（进行中的复用）。失败不抛：写进快照的 status / error */
  load: () => Promise<void>;
  /** 加一条（地址已收藏 = 更新标题并顶到最前）。失败抛 Error(中文原因) */
  add: (input: AddBookmarkRequest) => Promise<{ bookmark: Bookmark; created: boolean }>;
  /** 删一条。失败抛 Error(中文原因)；服务端说「不存在」当成功 */
  remove: (id: string) => Promise<void>;
}

export const BOOKMARKS_API = "/api/browser/bookmarks";

export const IDLE_BOOKMARKS_SNAPSHOT: BookmarksSnapshot = { status: "idle", bookmarks: [], error: null };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const readBody = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return null; // 无 body / 非 JSON
  }
};

const errorOf = (body: unknown, status: number): string => {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" && error.trim() !== "" ? error : `请求失败（${status}）`;
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const createBookmarksStore = (fetchImpl?: FetchLike): BookmarksStore => {
  // 惰性取 fetch：模块加载时不碰全局（SSR 安全），测试可注入
  const doFetch: FetchLike = (input, init) => (fetchImpl ?? fetch)(input, init);
  let snapshot: BookmarksSnapshot = IDLE_BOOKMARKS_SNAPSHOT;
  const listeners = new Set<() => void>();
  let version = 0;
  let inflight: Promise<void> | null = null;

  const set = (next: BookmarksSnapshot) => {
    if (next.status === snapshot.status && next.error === snapshot.error && next.bookmarks === snapshot.bookmarks) return;
    snapshot = next;
    for (const l of [...listeners]) l();
  };

  const fetchList = async (): Promise<Bookmark[]> => {
    const res = await doFetch(BOOKMARKS_API, { cache: "no-store" });
    const body = await readBody(res);
    if (!res.ok) throw new Error(errorOf(body, res.status));
    return parseBookmarkList((body as { bookmarks?: unknown } | null)?.bookmarks);
  };

  const runLoad = async (): Promise<void> => {
    // 已有数据：后台刷新，status 保持 ready（不闪 loading）；否则进入 loading
    if (snapshot.status !== "ready") set({ status: "loading", bookmarks: snapshot.bookmarks, error: null });
    // 乱序保护：load 在途期间若发生变更，结果可能不含该变更——丢弃、重拉一次（第二次不再检查，避免和连续变更互相追）
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startedAt = version;
      try {
        const list = await fetchList();
        if (version !== startedAt && attempt === 0) continue;
        set({ status: "ready", bookmarks: list, error: null });
        return;
      } catch (err) {
        if (snapshot.status === "ready") return; // 后台刷新失败：保留陈旧列表
        set({ status: "error", bookmarks: snapshot.bookmarks, error: messageOf(err) });
        return;
      }
    }
  };

  const load = (): Promise<void> => {
    inflight ??= runLoad().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  /** 变更成功后的落地：已加载就直接改本地；否则重拉（本地只有这一条不是完整列表） */
  const applyLocal = (next: (list: readonly Bookmark[]) => Bookmark[]) => {
    version += 1;
    if (snapshot.status === "ready") set({ status: "ready", bookmarks: next(snapshot.bookmarks), error: null });
    else void load();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    add: async (input) => {
      const res = await doFetch(BOOKMARKS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await readBody(res);
      if (!res.ok) throw new Error(errorOf(body, res.status));
      const parsed = parseBookmarkList([(body as { bookmark?: unknown } | null)?.bookmark])[0];
      if (!parsed) throw new Error("服务端返回的收藏格式不对");
      const created = (body as { created?: unknown }).created === true;
      applyLocal((list) => sortBookmarks([parsed, ...list.filter((b) => b.url !== parsed.url && b.id !== parsed.id)]));
      return { bookmark: parsed, created };
    },
    remove: async (id) => {
      const res = await doFetch(`${BOOKMARKS_API}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(errorOf(await readBody(res), res.status));
      applyLocal((list) => list.filter((b) => b.id !== id));
    },
  };
};

let singleton: BookmarksStore | null = null;

/** 全应用共用的 store */
export const getBookmarksStore = (): BookmarksStore => {
  singleton ??= createBookmarksStore();
  return singleton;
};
