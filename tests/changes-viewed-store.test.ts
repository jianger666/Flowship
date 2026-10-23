/**
 * 「已查看」标记存储：读容错 / 往返 / 上限 / 顺序语义 / 签名失效 / 原型安全 / 存储异常被吞。
 * 存储全部用假 StorageLike，不依赖 DOM。
 */
import { describe, expect, it } from "vitest";

import {
  MAX_VIEWED_ENTRIES,
  getBrowserStorage,
  isViewed,
  isViewedStale,
  loadViewed,
  markViewed,
  pruneViewed,
  saveViewed,
  unmarkViewed,
  viewedNamespace,
  viewedStorageKey,
  type StorageLike,
  type ViewedMap,
} from "@/lib/changes/viewed-store";

/** 记录调用的内存假存储 */
const makeStorage = (initial: Record<string, string> = {}) => {
  const data = new Map<string, string>(Object.entries(initial));
  const calls = { set: 0, remove: 0 };
  const storage: StorageLike = {
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => {
      calls.set++;
      data.set(k, v);
    },
    removeItem: (k) => {
      calls.remove++;
      data.delete(k);
    },
  };
  return { storage, data, calls };
};

const doc = (e: unknown): string => JSON.stringify({ v: 1, e });

describe("viewedStorageKey", () => {
  it("带前缀 + taskId", () => {
    expect(viewedStorageKey("t-1")).toBe("flowship:changes-viewed:t-1");
  });
});

describe("viewedNamespace：已查看按「任务 + 比较口径」分开存", () => {
  const BRANCH = { kind: "branch" } as const;
  const UNCOMMITTED = { kind: "uncommitted" } as const;
  const commit = (sha: string) => ({ kind: "commit", sha }) as const;

  it("范围不同 → 命名空间不同；同一口径 → 同一个", () => {
    const ns = [
      viewedNamespace("t1", BRANCH, null),
      viewedNamespace("t1", UNCOMMITTED, null),
      viewedNamespace("t1", commit("abc1234"), null),
      viewedNamespace("t1", commit("def5678"), null), // 单个提交连 sha 一起
    ];
    expect(new Set(ns).size).toBe(ns.length);
    expect(viewedNamespace("t1", BRANCH, null)).toBe(viewedNamespace("t1", BRANCH, null));
  });

  it("不同任务互不干扰", () => {
    expect(viewedNamespace("t1", BRANCH, null)).not.toBe(viewedNamespace("t2", BRANCH, null));
  });

  it("手动基线只影响「整条分支」；其余两种范围与基线无关（同一提交 / 同一份未提交改动不因基线换了而丢标记）", () => {
    expect(viewedNamespace("t1", BRANCH, "develop")).not.toBe(viewedNamespace("t1", BRANCH, null));
    expect(viewedNamespace("t1", BRANCH, "develop")).not.toBe(viewedNamespace("t1", BRANCH, "main"));
    expect(viewedNamespace("t1", UNCOMMITTED, "develop")).toBe(viewedNamespace("t1", UNCOMMITTED, null));
    expect(viewedNamespace("t1", commit("abc1234"), "develop")).toBe(
      viewedNamespace("t1", commit("abc1234"), null),
    );
  });

  it("不同口径各存各的：在「整条分支」标过的，到「仅未提交」里读不到（不会显示成「看过之后又变了」），也不会互相覆盖", () => {
    const { storage } = makeStorage();
    const branchNs = viewedNamespace("t1", BRANCH, null);
    const uncommittedNs = viewedNamespace("t1", UNCOMMITTED, null);

    saveViewed(storage, branchNs, markViewed({}, "app\0a.ts", "sig-branch"));
    expect(loadViewed(storage, uncommittedNs)).toEqual({});
    expect(isViewedStale(loadViewed(storage, uncommittedNs), "app\0a.ts", "sig-uncommitted")).toBe(false);

    saveViewed(storage, uncommittedNs, markViewed({}, "app\0a.ts", "sig-uncommitted"));
    // 回到「整条分支」：原来的标记还在、签名没被另一个口径覆盖
    const back = loadViewed(storage, branchNs);
    expect(isViewed(back, "app\0a.ts", "sig-branch")).toBe(true);
    expect(isViewedStale(back, "app\0a.ts", "sig-branch")).toBe(false);
  });

  it("落到存储的 key 仍在 flowship:changes-viewed: 前缀下（偏好清理 / 排查都认这个前缀）", () => {
    expect(viewedStorageKey(viewedNamespace("t1", commit("abc1234"), null))).toBe(
      "flowship:changes-viewed:t1::commit:abc1234",
    );
    expect(viewedStorageKey(viewedNamespace("t1", BRANCH, "develop"))).toBe(
      "flowship:changes-viewed:t1::branch@develop",
    );
  });
});

describe("loadViewed：容错", () => {
  const key = viewedStorageKey("t1");

  it("storage 为 null → {}", () => {
    expect(loadViewed(null, "t1")).toEqual({});
  });

  it("没有数据 / 空串 → {}", () => {
    expect(loadViewed(makeStorage().storage, "t1")).toEqual({});
    expect(loadViewed(makeStorage({ [key]: "" }).storage, "t1")).toEqual({});
  });

  it("JSON 坏 → {}", () => {
    expect(loadViewed(makeStorage({ [key]: "{not json" }).storage, "t1")).toEqual({});
  });

  it("非对象 / 数组 / null → {}", () => {
    for (const raw of ["123", '"str"', "null", "[]", "true"]) {
      expect(loadViewed(makeStorage({ [key]: raw }).storage, "t1")).toEqual({});
    }
  });

  it("版本不对 → {}", () => {
    expect(loadViewed(makeStorage({ [key]: JSON.stringify({ v: 2, e: [["a", "s"]] }) }).storage, "t1")).toEqual({});
    expect(loadViewed(makeStorage({ [key]: JSON.stringify({ e: [["a", "s"]] }) }).storage, "t1")).toEqual({});
  });

  it("e 不是数组 → {}", () => {
    expect(loadViewed(makeStorage({ [key]: JSON.stringify({ v: 1, e: { a: "s" } }) }).storage, "t1")).toEqual({});
  });

  it("个别条目坏：丢掉那条、保留其余", () => {
    const raw = doc([
      ["good1", "s1"],
      "not-an-array",
      ["too", "many", "items"],
      ["onlyKey"],
      [1, "s"],
      ["k", 2],
      ["", "empty-key"],
      null,
      ["good2", "s2"],
    ]);
    expect(loadViewed(makeStorage({ [key]: raw }).storage, "t1")).toEqual({ good1: "s1", good2: "s2" });
  });

  it("getItem 抛错 → {}", () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadViewed(storage, "t1")).toEqual({});
  });

  it("按任务隔离", () => {
    const { storage } = makeStorage();
    saveViewed(storage, "a", markViewed({}, "f", "s"));
    expect(loadViewed(storage, "a")).toEqual({ f: "s" });
    expect(loadViewed(storage, "b")).toEqual({});
  });

  it("磁盘上超过上限时只保留最新的 MAX 条", () => {
    const e = Array.from({ length: MAX_VIEWED_ENTRIES + 5 }, (_, i) => [`k${i}`, "s"]);
    const m = loadViewed(makeStorage({ [key]: doc(e) }).storage, "t1");
    const keys = Object.keys(m);
    expect(keys).toHaveLength(MAX_VIEWED_ENTRIES);
    expect(keys[0]).toBe("k5");
    expect(keys[keys.length - 1]).toBe(`k${MAX_VIEWED_ENTRIES + 4}`);
  });

  it("重复 key 以后出现者为准", () => {
    const m = loadViewed(makeStorage({ [key]: doc([["a", "old"], ["b", "x"], ["a", "new"]]) }).storage, "t1");
    expect(m).toEqual({ a: "new", b: "x" });
    expect(Object.keys(m)).toEqual(["b", "a"]);
  });
});

describe("saveViewed", () => {
  it("storage 为 null 不抛", () => {
    expect(() => saveViewed(null, "t1", { a: "s" })).not.toThrow();
  });

  it("写入格式为 v1 数组，保序", () => {
    const { storage, data } = makeStorage();
    saveViewed(storage, "t1", { a: "s1", b: "s2" });
    expect(JSON.parse(data.get(viewedStorageKey("t1")) as string)).toEqual({
      v: 1,
      e: [
        ["a", "s1"],
        ["b", "s2"],
      ],
    });
  });

  it("save → load 往返（含顺序）", () => {
    const { storage } = makeStorage();
    let m: ViewedMap = {};
    m = markViewed(m, "z", "1");
    m = markViewed(m, "a", "2");
    m = markViewed(m, "m", "3");
    saveViewed(storage, "t1", m);
    const back = loadViewed(storage, "t1");
    expect(back).toEqual(m);
    expect(Object.keys(back)).toEqual(["z", "a", "m"]);
  });

  it("超过 MAX_VIEWED_ENTRIES 时丢弃最早插入的", () => {
    const { storage } = makeStorage();
    let m: ViewedMap = {};
    for (let i = 0; i < MAX_VIEWED_ENTRIES + 3; i++) m = markViewed(m, `k${i}`, "s");
    saveViewed(storage, "t1", m);
    const back = loadViewed(storage, "t1");
    const keys = Object.keys(back);
    expect(keys).toHaveLength(MAX_VIEWED_ENTRIES);
    expect(Object.hasOwn(back, "k0")).toBe(false);
    expect(Object.hasOwn(back, "k2")).toBe(false);
    expect(keys[0]).toBe("k3");
    expect(keys[keys.length - 1]).toBe(`k${MAX_VIEWED_ENTRIES + 2}`);
  });

  it("不修改入参 map", () => {
    const { storage } = makeStorage();
    const m: ViewedMap = Object.freeze({ a: "s" });
    saveViewed(storage, "t1", m);
    expect(m).toEqual({ a: "s" });
  });

  it("空 map 触发 removeItem 而不是写入空数据", () => {
    const { storage, data, calls } = makeStorage();
    saveViewed(storage, "t1", { a: "s" });
    expect(data.has(viewedStorageKey("t1"))).toBe(true);
    saveViewed(storage, "t1", {});
    expect(calls.remove).toBe(1);
    expect(data.has(viewedStorageKey("t1"))).toBe(false);
  });

  it("setItem 抛错（配额满）被吞", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(() => saveViewed(storage, "t1", { a: "s" })).not.toThrow();
  });

  it("removeItem 抛错也被吞", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => saveViewed(storage, "t1", {})).not.toThrow();
  });
});

describe("isViewed / isViewedStale：签名失效", () => {
  const m: ViewedMap = { f: "sig-1" };

  it("签名相等才算已查看", () => {
    expect(isViewed(m, "f", "sig-1")).toBe(true);
    expect(isViewedStale(m, "f", "sig-1")).toBe(false);
  });

  it("签名变了：不再算已查看，但算「看过又变了」", () => {
    expect(isViewed(m, "f", "sig-2")).toBe(false);
    expect(isViewedStale(m, "f", "sig-2")).toBe(true);
  });

  it("从没标记过：两者都 false", () => {
    expect(isViewed(m, "other", "sig-1")).toBe(false);
    expect(isViewedStale(m, "other", "sig-1")).toBe(false);
  });

  it("原型链上的名字不会被当成已标记", () => {
    expect(isViewed({}, "constructor", "x")).toBe(false);
    expect(isViewedStale({}, "toString", "x")).toBe(false);
    expect(isViewed({}, "__proto__", "x")).toBe(false);
  });
});

describe("markViewed / unmarkViewed / pruneViewed", () => {
  it("markViewed 返回新对象、不改入参", () => {
    const base: ViewedMap = Object.freeze({ a: "1" });
    const next = markViewed(base, "b", "2");
    expect(next).not.toBe(base);
    expect(next).toEqual({ a: "1", b: "2" });
    expect(base).toEqual({ a: "1" });
  });

  it("markViewed 对已存在的 key：更新签名并挪到末尾", () => {
    let m: ViewedMap = {};
    m = markViewed(m, "a", "1");
    m = markViewed(m, "b", "2");
    m = markViewed(m, "c", "3");
    const next = markViewed(m, "a", "9");
    expect(Object.keys(next)).toEqual(["b", "c", "a"]);
    expect(next.a).toBe("9");
    expect(Object.keys(m)).toEqual(["a", "b", "c"]);
  });

  it("重复标记后再超限，被丢的是真正最早的而不是被刷新过的", () => {
    const { storage } = makeStorage();
    let m: ViewedMap = {};
    for (let i = 0; i < MAX_VIEWED_ENTRIES; i++) m = markViewed(m, `k${i}`, "s");
    m = markViewed(m, "k0", "s2"); // k0 刷新为最新
    m = markViewed(m, "extra", "s");
    saveViewed(storage, "t1", m);
    const back = loadViewed(storage, "t1");
    expect(Object.hasOwn(back, "k0")).toBe(true);
    expect(Object.hasOwn(back, "k1")).toBe(false);
  });

  it("unmarkViewed 返回不含该 key 的新对象、不改入参", () => {
    const base: ViewedMap = Object.freeze({ a: "1", b: "2" });
    const next = unmarkViewed(base, "a");
    expect(next).toEqual({ b: "2" });
    expect(base).toEqual({ a: "1", b: "2" });
  });

  it("unmarkViewed 对不存在的 key 无副作用", () => {
    const base: ViewedMap = { a: "1" };
    expect(unmarkViewed(base, "zzz")).toEqual({ a: "1" });
  });

  it("pruneViewed 只保留 liveKeys 里的条目（保序），不改入参", () => {
    const base: ViewedMap = Object.freeze({ a: "1", b: "2", c: "3" });
    const next = pruneViewed(base, new Set(["c", "a", "not-in-map"]));
    expect(next).toEqual({ a: "1", c: "3" });
    expect(Object.keys(next)).toEqual(["a", "c"]);
    expect(base).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("pruneViewed：liveKeys 为空 → 全清", () => {
    expect(pruneViewed({ a: "1" }, new Set())).toEqual({});
  });
});

describe("原型安全：__proto__ key", () => {
  it("markViewed 拒绝 __proto__，不污染原型", () => {
    const next = markViewed({}, "__proto__", "evil");
    expect(Object.keys(next)).toEqual([]);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype); // 原型没被改写成别的对象
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    expect(isViewed(next, "__proto__", "evil")).toBe(false);
  });

  it("markViewed 的结果不带 Object.prototype，普通 key 不受影响", () => {
    const next = markViewed({}, "ok", "s");
    expect(Object.getPrototypeOf(next)).toBeNull();
    expect(next.ok).toBe("s");
  });

  it("loadViewed 丢弃存储里的 __proto__ 条目", () => {
    const raw = '{"v":1,"e":[["__proto__","x"],["ok","s"]]}';
    const { storage } = makeStorage({ [viewedStorageKey("t1")]: raw });
    const m = loadViewed(storage, "t1");
    expect(Object.keys(m)).toEqual(["ok"]);
    expect(Object.getPrototypeOf(m)).toBeNull();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("存储里嵌套的 __proto__ 污染载荷无效", () => {
    const raw = '{"v":1,"e":[["a","s"]],"__proto__":{"polluted":true}}';
    const { storage } = makeStorage({ [viewedStorageKey("t1")]: raw });
    loadViewed(storage, "t1");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("getBrowserStorage", () => {
  it("node 环境（无 window）返回 null", () => {
    expect(typeof window).toBe("undefined");
    expect(getBrowserStorage()).toBeNull();
  });
});
