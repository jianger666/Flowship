/**
 * 工作区文件内容指纹的成本控制（纯函数）：哈希预算 / 个数 / 单文件上限、缓存的新鲜窗口与容量。
 */
import { describe, expect, it } from "vitest";

import {
  createHashCache,
  decodeUntrackedSummary,
  DEFAULT_HASH_LIMITS,
  encodeUntrackedSummary,
  HASH_CACHE_MAX,
  HASH_CACHE_MIN_AGE_MS,
  hashCacheKey,
  MAX_HASH_FILE_BYTES,
  MAX_HASH_FILES,
  MAX_HASH_TOTAL_BYTES,
  planHashing,
  untrackedSummaryCache,
  workingHashCache,
  type HashCandidate,
  type UntrackedSummary,
} from "@/lib/server/working-file-hash";

const MB = 1024 * 1024;
const cand = (rel: string, size: number): HashCandidate => ({ rel, size });

describe("planHashing", () => {
  const limits = { maxFiles: 3, maxFileBytes: 50, maxTotalBytes: 100 };

  it("空输入", () => {
    expect(planHashing([], limits)).toEqual({ hash: [], fallback: [] });
  });

  it("个数上限：超出的退回，顺序保持", () => {
    const plan = planHashing(
      ["a", "b", "c", "d", "e"].map((r) => cand(r, 1)),
      limits,
    );
    expect(plan).toEqual({ hash: ["a", "b", "c"], fallback: ["d", "e"] });
  });

  it("单文件上限：超大的退回，不影响后面的小文件继续入选", () => {
    const plan = planHashing([cand("big", 51), cand("s1", 10), cand("s2", 10)], limits);
    expect(plan).toEqual({ hash: ["s1", "s2"], fallback: ["big"] });
    // 恰好等于上限：放行
    expect(planHashing([cand("edge", 50)], limits).hash).toEqual(["edge"]);
  });

  it("总字节预算：累计超了的退回；跳过之后更小的文件仍可入选", () => {
    const plan = planHashing([cand("a", 40), cand("b", 40), cand("c", 40)], limits);
    expect(plan).toEqual({ hash: ["a", "b"], fallback: ["c"] });

    // 恰好吃满预算（50 + 50 = 100）放行；再多 1 字节的退回
    const exact = planHashing([cand("a", 50), cand("b", 50), cand("c", 1)], limits);
    expect(exact).toEqual({ hash: ["a", "b"], fallback: ["c"] });

    const tight = planHashing([cand("a", 50), cand("b", 50), cand("c", 1)], {
      ...limits,
      maxTotalBytes: 99,
    });
    // a 入选（50）、b 超预算退回（100 > 99）、c 仍可入选（51 ≤ 99）
    expect(tight).toEqual({ hash: ["a", "c"], fallback: ["b"] });
  });

  it("空文件（0 字节）不吃字节预算，只占个数名额", () => {
    const plan = planHashing(
      [cand("z1", 0), cand("z2", 0), cand("z3", 0), cand("z4", 0)],
      { maxFiles: 3, maxFileBytes: 10, maxTotalBytes: 0 },
    );
    expect(plan).toEqual({ hash: ["z1", "z2", "z3"], fallback: ["z4"] });
  });

  it("默认限制：最坏情况的读盘量被总预算封住（不是 个数 × 单文件上限 的几个 GB）", () => {
    expect(DEFAULT_HASH_LIMITS).toEqual({
      maxFiles: MAX_HASH_FILES,
      maxFileBytes: MAX_HASH_FILE_BYTES,
      maxTotalBytes: MAX_HASH_TOTAL_BYTES,
    });
    // 预算确实比「个数 × 单文件上限」小得多，才有约束意义
    expect(MAX_HASH_TOTAL_BYTES).toBeLessThan((MAX_HASH_FILES * MAX_HASH_FILE_BYTES) / 10);

    // 200 个正好 20MB 的文件：只会选中预算装得下的那几个
    const many = Array.from({ length: 200 }, (_, i) => cand(`f${i}`, MAX_HASH_FILE_BYTES));
    const plan = planHashing(many);
    expect(plan.hash.length).toBe(Math.floor(MAX_HASH_TOTAL_BYTES / MAX_HASH_FILE_BYTES));
    expect(plan.hash.length * MAX_HASH_FILE_BYTES).toBeLessThanOrEqual(MAX_HASH_TOTAL_BYTES);
    expect(plan.hash.length + plan.fallback.length).toBe(200);
  });

  it("默认限制：130 个小文件 → 前 100 个哈希、其余 30 个退回", () => {
    const small = Array.from({ length: 130 }, (_, i) => cand(`f${i}`, 10));
    const plan = planHashing(small);
    expect(plan.hash).toHaveLength(MAX_HASH_FILES);
    expect(plan.fallback).toHaveLength(30);
    expect(plan.hash[0]).toBe("f0");
    expect(plan.fallback[0]).toBe(`f${MAX_HASH_FILES}`);
  });

  it("每一项恰好出现在 hash / fallback 之一（不丢不重）", () => {
    const input = Array.from({ length: 50 }, (_, i) => cand(`f${i}`, (i % 7) * 20 * MB));
    const plan = planHashing(input);
    expect([...plan.hash, ...plan.fallback].sort()).toEqual(input.map((c) => c.rel).sort());
  });
});

describe("createHashCache", () => {
  const stamp = { mtimeMs: 1_000, ctimeMs: 1_000 };

  const make = (max = 3) => {
    const clock = { t: 100_000 };
    const cache = createHashCache({ max, minAgeMs: 2000, now: () => clock.t });
    return { cache, clock };
  };

  it("基本读写与命中统计", () => {
    const { cache } = make();
    expect(cache.get("k")).toBeUndefined();
    expect(cache.set("k", "abc", stamp.mtimeMs, stamp.ctimeMs)).toBe(true);
    expect(cache.get("k")).toBe("abc");
    expect(cache.get("other")).toBeUndefined();
    expect(cache.stats()).toEqual({ hits: 1, misses: 2 });
    expect(cache.size()).toBe(1);
  });

  it("刚改过的文件不缓存（racy 保护）；够老了才缓存；恰好到窗口边界放行", () => {
    const { cache, clock } = make();
    // 文件 1 秒前刚变动过
    expect(cache.set("fresh", "x", clock.t - 1000, clock.t - 1000)).toBe(false);
    expect(cache.get("fresh")).toBeUndefined();
    expect(cache.size()).toBe(0);
    // 恰好 2000ms：放行
    expect(cache.set("edge", "x", clock.t - 2000, clock.t - 2000)).toBe(true);
    // 比窗口再差 1ms：不放行
    expect(cache.set("almost", "x", clock.t - 1999, clock.t - 1999)).toBe(false);
  });

  it("按 mtime 与 ctime 里更新的那个判断（`touch -r` 把 mtime 还原成很久以前，ctime 仍是刚刚）", () => {
    const { cache, clock } = make();
    expect(cache.set("restored", "x", clock.t - 3_600_000, clock.t - 500)).toBe(false);
    expect(cache.set("old", "x", clock.t - 3_600_000, clock.t - 3_000)).toBe(true);
  });

  it("mtime 比 now 还晚（亚毫秒小数 / 时钟漂移）：minAgeMs≥0 都当「刚改过」不缓存；真要关掉保护得用负数", () => {
    // Date.now() 只到整毫秒、文件 mtime 带小数毫秒：刚写完就读，now − mtime 常常是 −0.4。
    // 所以 minAgeMs=0 **不是**「关闭保护」，而是「不足约 1ms 的也不缓存」——测试里想绕过 racy 保护要用负数
    //（integration 的 freshCache 就是这样；当初用 0 时偶发红，根因就在这里）
    const t = 100_000;
    const future = t + 0.4;

    const zero = createHashCache({ max: 3, minAgeMs: 0, now: () => t });
    expect(zero.set("future", "x", future, future)).toBe(false);
    expect(zero.set("same-ms", "x", t, t)).toBe(true); // 年龄恰好 0：不小于 0，放行

    const off = createHashCache({ max: 3, minAgeMs: -1_000, now: () => t });
    expect(off.set("future", "x", future, future)).toBe(true);

    // 生产配置（正数窗口）：mtime 在未来 = 太新 = 不缓存，方向是安全的
    const prod = createHashCache({ max: 3, minAgeMs: HASH_CACHE_MIN_AGE_MS, now: () => t });
    expect(prod.set("future", "x", t + 50, t + 50)).toBe(false);
    expect(prod.set("far-future", "x", t + 3_600_000, t + 3_600_000)).toBe(false);
  });

  it("容量满了先进先出；已有的 key 重复写入不淘汰别人、也不增加条目数", () => {
    const { cache } = make(3);
    for (const k of ["a", "b", "c"]) cache.set(k, k.toUpperCase(), 0, 0);
    expect(cache.size()).toBe(3);

    cache.set("b", "B2", 0, 0); // 覆盖已有
    expect(cache.size()).toBe(3);
    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBe("B2");

    cache.set("d", "D", 0, 0); // 满了：淘汰最先进来的 a
    expect(cache.size()).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toBe("D");
    expect(cache.get("c")).toBe("C");
  });

  it("clear 清掉条目与统计", () => {
    const { cache } = make();
    cache.set("k", "v", 0, 0);
    cache.get("k");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.stats()).toEqual({ hits: 0, misses: 0 });
  });

  it("默认时钟：每次现读 Date.now（不在创建时捕获函数引用，假时钟才改得动）", () => {
    const cache = createHashCache({ max: 2, minAgeMs: 2000 });
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000;
      expect(cache.set("fresh", "x", 999_000, 999_000)).toBe(false);
      Date.now = () => 1_010_000;
      expect(cache.set("old", "x", 999_000, 999_000)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("常量关系：新鲜窗口是正数、容量够大", () => {
    expect(HASH_CACHE_MIN_AGE_MS).toBeGreaterThanOrEqual(1000);
    expect(HASH_CACHE_MAX).toBeGreaterThanOrEqual(1000);
  });
});

describe("hashCacheKey", () => {
  const st = { size: 10, mtimeMs: 1.5, ctimeMs: 2.5, ino: 7 };

  it("相同磁盘状态同一个键；仓 / 路径 / 大小 / mtime / ctime / inode 任一变化都换键", () => {
    const base = hashCacheKey("/r", "a.txt", st);
    expect(hashCacheKey("/r", "a.txt", { ...st })).toBe(base);
    for (const other of [
      hashCacheKey("/r2", "a.txt", st),
      hashCacheKey("/r", "b.txt", st),
      hashCacheKey("/r", "a.txt", { ...st, size: 11 }),
      hashCacheKey("/r", "a.txt", { ...st, mtimeMs: 1.6 }),
      hashCacheKey("/r", "a.txt", { ...st, ctimeMs: 2.6 }),
      hashCacheKey("/r", "a.txt", { ...st, ino: 8 }),
    ]) {
      expect(other).not.toBe(base);
    }
  });

  it("仓路径与文件路径的边界不会拼出相同的键", () => {
    expect(hashCacheKey("/r/a", "b.txt", st)).not.toBe(hashCacheKey("/r", "a/b.txt", st));
  });
});

describe("未跟踪文件的读盘摘要：编码 / 解码 / 独立缓存", () => {
  const OID = "0123456789ab";

  it("往返：有行数 / 二进制（行数 null）/ 0 行 / 很大的行数", () => {
    const cases: UntrackedSummary[] = [
      { added: 12, binary: false, oid: OID },
      { added: null, binary: true, oid: OID },
      { added: 0, binary: false, oid: OID },
      { added: 9_999_999, binary: false, oid: OID },
    ];
    for (const s of cases) expect(decodeUntrackedSummary(encodeUntrackedSummary(s)), JSON.stringify(s)).toEqual(s);
    expect(encodeUntrackedSummary({ added: null, binary: true, oid: OID })).toBe(`n:1:${OID}`);
    expect(encodeUntrackedSummary({ added: 3, binary: false, oid: OID })).toBe(`3:0:${OID}`);
  });

  it("不合法的值解不出来（调用方当没命中、重新读），而不是解出一个半对的摘要", () => {
    for (const bad of [
      "",
      "garbage",
      "12:0", // 缺 oid
      ":0:abc",
      "x:0:abc",
      "-1:0:abc", // 负数
      "1.5:0:abc",
      "12:2:abc", // binary 只能 0 / 1
      "12:0:", // oid 为空
      "12:0:ZZZ", // oid 不是十六进制
      "12:0:abc:extra",
      " 12:0:abc",
      "99999999999999999999:0:abc", // 超出安全整数
      "012345678901234567890123:0:abc",
    ]) {
      expect(decodeUntrackedSummary(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("未跟踪摘要缓存与已跟踪哈希缓存是两个实例（值的格式不同，不能共用键空间）", () => {
    expect(untrackedSummaryCache).not.toBe(workingHashCache);
    untrackedSummaryCache.clear();
    workingHashCache.clear();
    untrackedSummaryCache.set("k", `1:0:${OID}`, 0, 0);
    expect(workingHashCache.get("k")).toBeUndefined();
    expect(untrackedSummaryCache.get("k")).toBe(`1:0:${OID}`);
    untrackedSummaryCache.clear();
  });
});
