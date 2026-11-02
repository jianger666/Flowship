/**
 * view-memory 的两处健壮性：
 *  1. sessionStorage 写入（配额满 / 被禁）不能抛——saveDraft 每次按键都调，抛了会把输入框 / effect 带崩；
 *  2. 「任务已读」每次读整份 localStorage 并 JSON.parse（侧栏每行一次）：改模块级内存缓存，
 *     写入同步更新、storage 事件（别的窗口写）失效；没有 window / localStorage 时兜底不抛。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeStorage {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
}

const makeStorage = (opts: { throwOnWrite?: boolean } = {}): FakeStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      if (opts.throwOnWrite) throw new DOMException("quota", "QuotaExceededError");
      data.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      if (opts.throwOnWrite) throw new DOMException("quota", "QuotaExceededError");
      data.delete(k);
    }),
  };
};

type Listener = (e: { key: string | null }) => void;

const installWindow = (session: FakeStorage, local: FakeStorage) => {
  const listeners = new Map<string, Listener[]>();
  const win = {
    sessionStorage: session,
    localStorage: local,
    addEventListener: (type: string, fn: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatch: (type: string, e: { key: string | null }) => {
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", local);
  return win;
};

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessionStorage 写入失败不抛", () => {
  it("rememberLastChat / rememberLastWork / rememberWorkBoard / clearLastWork / saveDraft / saveBoardRange", async () => {
    installWindow(makeStorage({ throwOnWrite: true }), makeStorage());
    const vm = await import("@/lib/view-memory");
    expect(() => vm.rememberLastChat("t1")).not.toThrow();
    expect(() => vm.rememberLastWork("t1")).not.toThrow();
    expect(() => vm.rememberWorkBoard()).not.toThrow();
    expect(() => vm.clearLastWork()).not.toThrow();
    expect(() => vm.saveDraft("reply", "t1", "草稿")).not.toThrow();
    expect(() => vm.saveDraft("reply", "t1", "")).not.toThrow();
    expect(() => vm.saveBoardRange({ from: 1, to: 2 })).not.toThrow();
  });

  it("存储正常时行为不变：写入后能读回", async () => {
    installWindow(makeStorage(), makeStorage());
    const vm = await import("@/lib/view-memory");
    vm.saveDraft("reply", "t1", "hello");
    expect(vm.loadDraft("reply", "t1")).toBe("hello");
    vm.rememberLastChat("t9");
    expect(vm.getLastChatId()).toBe("t9");
  });
});

describe("任务已读：模块级内存缓存", () => {
  it("连续 getTaskSeenAt 只解析一次 localStorage", async () => {
    const local = makeStorage();
    local.data.set("flowship:task-seen", JSON.stringify({ a: 100, b: 200 }));
    installWindow(makeStorage(), local);
    const vm = await import("@/lib/view-memory");
    expect(vm.getTaskSeenAt("a")).toBe(100);
    expect(vm.getTaskSeenAt("b")).toBe(200);
    expect(vm.getTaskSeenAt("zzz")).toBe(0);
    const seenReads = local.getItem.mock.calls.filter((c) => c[0] === "flowship:task-seen");
    expect(seenReads.length).toBe(1);
  });

  it("markTaskSeen 写后缓存是新值：之后的纯读不再碰 localStorage", async () => {
    const local = makeStorage();
    installWindow(makeStorage(), local);
    const vm = await import("@/lib/view-memory");
    expect(vm.getTaskSeenAt("a")).toBe(0);
    vi.spyOn(Date, "now").mockReturnValue(12345);
    vm.markTaskSeen("a");
    const afterWrite = local.getItem.mock.calls.length;
    expect(vm.getTaskSeenAt("a")).toBe(12345);
    expect(vm.getTaskSeenAt("a")).toBe(12345);
    expect(local.getItem.mock.calls.length).toBe(afterWrite);
    // 持久化也写了
    expect(JSON.parse(local.data.get("flowship:task-seen") ?? "{}")).toEqual({ a: 12345 });
    vi.restoreAllMocks();
  });

  it("多窗口并发：缓存是旧的、别的窗口已写入新条目时，markTaskSeen 写前重读 storage 再合并，不丢对方的更新", async () => {
    const local = makeStorage();
    local.data.set("flowship:task-seen", JSON.stringify({ a: 1 }));
    installWindow(makeStorage(), local);
    const vm = await import("@/lib/view-memory");
    // 本窗口读过一次、缓存里是 { a: 1 }
    expect(vm.getTaskSeenAt("a")).toBe(1);
    // 另一个窗口写入 b（本窗口收不到 / 还没收到 storage 事件）
    local.data.set("flowship:task-seen", JSON.stringify({ a: 1, b: 777 }));
    vi.spyOn(Date, "now").mockReturnValue(5000);
    vm.markTaskSeen("c");
    expect(JSON.parse(local.data.get("flowship:task-seen") ?? "{}")).toEqual({ a: 1, b: 777, c: 5000 });
    // 写后缓存也是合并结果
    expect(vm.getTaskSeenAt("b")).toBe(777);
    expect(vm.getTaskSeenAt("c")).toBe(5000);
    vi.restoreAllMocks();
  });

  it("写盘失败（配额）：缓存保持与盘一致、不抛", async () => {
    const local = makeStorage({ throwOnWrite: true });
    local.data.set("flowship:task-seen", JSON.stringify({ a: 1 }));
    installWindow(makeStorage(), local);
    const vm = await import("@/lib/view-memory");
    expect(vm.getTaskSeenAt("a")).toBe(1);
    expect(() => vm.markTaskSeen("z")).not.toThrow();
    expect(vm.getTaskSeenAt("z")).toBe(0);
    expect(vm.getTaskSeenAt("a")).toBe(1);
  });

  it("storage 事件（别的窗口写了 task-seen / 整体清空）使缓存失效、重新读盘", async () => {
    const local = makeStorage();
    local.data.set("flowship:task-seen", JSON.stringify({ a: 1 }));
    const win = installWindow(makeStorage(), local);
    const vm = await import("@/lib/view-memory");
    expect(vm.getTaskSeenAt("a")).toBe(1);
    local.data.set("flowship:task-seen", JSON.stringify({ a: 999 }));
    // 无关 key 不失效
    win.dispatch("storage", { key: "other" });
    expect(vm.getTaskSeenAt("a")).toBe(1);
    win.dispatch("storage", { key: "flowship:task-seen" });
    expect(vm.getTaskSeenAt("a")).toBe(999);
    local.data.set("flowship:task-seen", JSON.stringify({ a: 5 }));
    win.dispatch("storage", { key: null });
    expect(vm.getTaskSeenAt("a")).toBe(5);
  });

  it("没有 window / localStorage（SSR）：读 0、写不抛", async () => {
    const vm = await import("@/lib/view-memory");
    expect(vm.getTaskSeenAt("a")).toBe(0);
    expect(() => vm.markTaskSeen("a")).not.toThrow();
  });

  it("损坏的 JSON / 形状不对（数组、字符串、null）：读不抛、按「都没看过」给 0，且不缓存（盘恢复后下次就能读到）", async () => {
    for (const bad of ["{not json", "[1,2,3]", '"str"', "null", "42"]) {
      vi.resetModules();
      const local = makeStorage();
      local.data.set("flowship:task-seen", bad);
      installWindow(makeStorage(), local);
      const vm = await import("@/lib/view-memory");
      expect(() => vm.getTaskSeenAt("a"), bad).not.toThrow();
      expect(vm.getTaskSeenAt("a"), bad).toBe(0);
      // 读失败不缓存：每次都重试读盘（getItem 次数递增），而不是把「空」固化成缓存
      const readsBefore = local.getItem.mock.calls.filter((c) => c[0] === "flowship:task-seen").length;
      expect(vm.getTaskSeenAt("b"), bad).toBe(0);
      const readsAfter = local.getItem.mock.calls.filter((c) => c[0] === "flowship:task-seen").length;
      expect(readsAfter, bad).toBe(readsBefore + 1);
      // 盘上内容恢复正常后，下一次读就能读到
      local.data.set("flowship:task-seen", JSON.stringify({ a: 7 }));
      expect(vm.getTaskSeenAt("a"), bad).toBe(7);
    }
  });

  it("损坏的 JSON 上 markTaskSeen：不抛，用只含本次的合法记录自愈覆盖（旧内容本来就读不出来）", async () => {
    const local = makeStorage();
    local.data.set("flowship:task-seen", "{not json");
    installWindow(makeStorage(), local);
    const vm = await import("@/lib/view-memory");
    vi.spyOn(Date, "now").mockReturnValue(4242);
    expect(() => vm.markTaskSeen("a")).not.toThrow();
    expect(JSON.parse(local.data.get("flowship:task-seen") ?? "null")).toEqual({ a: 4242 });
    expect(vm.getTaskSeenAt("a")).toBe(4242);
    vi.restoreAllMocks();
  });

  it("缓存里是好数据、别的窗口随后写坏了盘并触发 storage 事件：缓存失效后读不抛、给 0（不继续用过期缓存）", async () => {
    const local = makeStorage();
    local.data.set("flowship:task-seen", JSON.stringify({ a: 1 }));
    const win = installWindow(makeStorage(), local);
    const vm = await import("@/lib/view-memory");
    expect(vm.getTaskSeenAt("a")).toBe(1);
    local.data.set("flowship:task-seen", "{corrupt");
    win.dispatch("storage", { key: "flowship:task-seen" });
    expect(() => vm.getTaskSeenAt("a")).not.toThrow();
    expect(vm.getTaskSeenAt("a")).toBe(0);
  });

  it("脏数据（非对象 / 非数字值）照旧被过滤", async () => {
    const local = makeStorage();
    local.data.set("flowship:task-seen", JSON.stringify({ a: "x", b: 3, c: null }));
    installWindow(makeStorage(), local);
    const vm = await import("@/lib/view-memory");
    expect(vm.getTaskSeenAt("a")).toBe(0);
    expect(vm.getTaskSeenAt("b")).toBe(3);
  });
});
