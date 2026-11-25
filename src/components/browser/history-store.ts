/**
 * 地址栏记忆（访问历史）的前端 store（无 React，可在 node 里测）。结构与收藏夹 store 同一套，差别只在三处：
 *  - 多一个 `record`（敲网址成功后记一次，失败不打扰用户——调用方自己吞）与 `clear`（清除浏览历史）；
 *  - 没有「撤销」：删一条联想就是删了；
 *  - 联想下拉与「清除浏览历史」读的是同一份数据，所以也做成全应用单例，组件用 useSyncExternalStore 订阅。
 *
 * 行为要点（与收藏夹 store 一致）：
 *  - `load` 单飞；已有数据时后台刷新失败不把列表换成报错——陈旧的联想比没有联想好用；
 *  - 变更成功后：已加载 → 直接按服务端回包改本地列表；还没加载成功过 → 不能把「只有这一条」当成完整列表，改为重新拉；
 *  - 版本号防乱序：load 在途期间发生了变更，这次 load 的结果可能不含该变更，丢弃并重拉一次；
 *  - remove 遇到 404（别处已经删了）当成功；
 *  - 快照是不可变对象，只在 set 时换新引用（useSyncExternalStore 的要求）。
 */
import { mergeEntry, parseHistoryList, removeVisit, type HistoryEntry } from "@/lib/browser-history";

export type HistoryStatus = "idle" | "loading" | "ready" | "error";

export interface HistorySnapshot {
  status: HistoryStatus;
  history: readonly HistoryEntry[];
  /** status === "error" 时的原因 */
  error: string | null;
}

export interface RecordVisitRequest {
  url: string;
  title?: string;
}

export interface HistoryStore {
  getSnapshot: () => HistorySnapshot;
  subscribe: (listener: () => void) => () => void;
  /** 拉一次最新列表（进行中的复用）。失败不抛：写进快照的 status / error */
  load: () => Promise<void>;
  /** 记一次访问。失败抛 Error(中文原因)，调用方决定要不要提示（敲网址的记录不该打扰用户） */
  record: (input: RecordVisitRequest) => Promise<{ entry: HistoryEntry; created: boolean }>;
  /** 删一条联想。失败抛 Error(中文原因)；服务端说「不存在」当成功 */
  remove: (id: string) => Promise<void>;
  /** 清空全部。失败抛 Error(中文原因)；返回服务端清掉了几条 */
  clear: () => Promise<number>;
}

export const HISTORY_API = "/api/browser/history";

export const IDLE_HISTORY_SNAPSHOT: HistorySnapshot = { status: "idle", history: [], error: null };

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

export const createHistoryStore = (fetchImpl?: FetchLike): HistoryStore => {
  // 惰性取 fetch：模块加载时不碰全局（SSR 安全），测试可注入
  const doFetch: FetchLike = (input, init) => (fetchImpl ?? fetch)(input, init);
  let snapshot: HistorySnapshot = IDLE_HISTORY_SNAPSHOT;
  const listeners = new Set<() => void>();
  let version = 0;
  let inflight: Promise<void> | null = null;

  const set = (next: HistorySnapshot) => {
    if (next.status === snapshot.status && next.error === snapshot.error && next.history === snapshot.history) return;
    snapshot = next;
    for (const l of [...listeners]) l();
  };

  const fetchList = async (): Promise<HistoryEntry[]> => {
    const res = await doFetch(HISTORY_API, { cache: "no-store" });
    const body = await readBody(res);
    if (!res.ok) throw new Error(errorOf(body, res.status));
    return parseHistoryList((body as { history?: unknown } | null)?.history);
  };

  const runLoad = async (): Promise<void> => {
    // 已有数据：后台刷新，status 保持 ready（不闪 loading）；否则进入 loading
    if (snapshot.status !== "ready") set({ status: "loading", history: snapshot.history, error: null });
    // 乱序保护：load 在途期间若发生变更，结果可能不含该变更——丢弃、重拉一次（第二次不再检查，避免和连续变更互相追）
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startedAt = version;
      try {
        const list = await fetchList();
        if (version !== startedAt && attempt === 0) continue;
        set({ status: "ready", history: list, error: null });
        return;
      } catch (err) {
        if (snapshot.status === "ready") return; // 后台刷新失败：保留陈旧列表
        set({ status: "error", history: snapshot.history, error: messageOf(err) });
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
  const applyLocal = (next: (list: readonly HistoryEntry[]) => readonly HistoryEntry[]) => {
    version += 1;
    if (snapshot.status === "ready") set({ status: "ready", history: next(snapshot.history), error: null });
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
    record: async (input) => {
      const res = await doFetch(HISTORY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await readBody(res);
      if (!res.ok) throw new Error(errorOf(body, res.status));
      const entry = parseHistoryList([(body as { entry?: unknown } | null)?.entry])[0];
      if (!entry) throw new Error("服务端返回的记录格式不对");
      const created = (body as { created?: unknown }).created === true;
      applyLocal((list) => mergeEntry(list, entry));
      return { entry, created };
    },
    remove: async (id) => {
      const res = await doFetch(`${HISTORY_API}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(errorOf(await readBody(res), res.status));
      applyLocal((list) => removeVisit(list, id));
    },
    clear: async () => {
      const res = await doFetch(`${HISTORY_API}?all=1`, { method: "DELETE" });
      const body = await readBody(res);
      if (!res.ok) throw new Error(errorOf(body, res.status));
      const removed = (body as { removed?: unknown } | null)?.removed;
      applyLocal(() => []);
      return typeof removed === "number" && Number.isFinite(removed) ? removed : 0;
    },
  };
};

let singleton: HistoryStore | null = null;

/** 全应用共用的 store */
export const getHistoryStore = (): HistoryStore => {
  singleton ??= createHistoryStore();
  return singleton;
};
