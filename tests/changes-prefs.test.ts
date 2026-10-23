/**
 * 改动面板偏好存取：默认值 / 往返 / 字段级回落 / 坏数据 / 异常被吞。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIFF_PREFS,
  DIFF_PREFS_STORAGE_KEY,
  loadDiffPrefs,
  saveDiffPrefs,
  type DiffPrefs,
} from "@/lib/changes/prefs";
import type { StorageLike } from "@/lib/changes/viewed-store";

const makeStorage = (initial?: string) => {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(DIFF_PREFS_STORAGE_KEY, initial);
  const storage: StorageLike = {
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
  return { storage, data };
};

describe("默认值", () => {
  it("DEFAULT_DIFF_PREFS 符合约定", () => {
    expect(DEFAULT_DIFF_PREFS).toEqual({
      view: "unified",
      ignoreWs: false,
      treeMode: "tree",
      wide: false,
      treeHidden: false,
    });
  });

  it("存储 key 带版本号", () => {
    expect(DIFF_PREFS_STORAGE_KEY).toBe("flowship:changes-prefs:v1");
  });

  it("storage 为 null / 无数据 → 默认值", () => {
    expect(loadDiffPrefs(null)).toEqual(DEFAULT_DIFF_PREFS);
    expect(loadDiffPrefs(makeStorage().storage)).toEqual(DEFAULT_DIFF_PREFS);
  });

  it("返回的是副本：改它不会污染默认值", () => {
    const p = loadDiffPrefs(null);
    expect(p).not.toBe(DEFAULT_DIFF_PREFS);
    p.wide = true;
    expect(DEFAULT_DIFF_PREFS.wide).toBe(false);
  });
});

describe("往返", () => {
  it("save → load 保持一致", () => {
    const { storage } = makeStorage();
    const prefs: DiffPrefs = {
      view: "split",
      ignoreWs: true,
      treeMode: "flat",
      wide: true,
      treeHidden: true,
    };
    saveDiffPrefs(storage, prefs);
    expect(loadDiffPrefs(storage)).toEqual(prefs);
  });

  it("写入的只有已知字段", () => {
    const { storage, data } = makeStorage();
    const withExtra = { ...DEFAULT_DIFF_PREFS, junk: 1 } as DiffPrefs;
    saveDiffPrefs(storage, withExtra);
    expect(Object.keys(JSON.parse(data.get(DIFF_PREFS_STORAGE_KEY) as string)).sort()).toEqual(
      ["ignoreWs", "treeHidden", "treeMode", "view", "wide"],
    );
  });
});

describe("字段级回落", () => {
  it("一个坏字段不影响其他字段", () => {
    const { storage } = makeStorage(
      JSON.stringify({ view: "triple", ignoreWs: true, treeMode: "flat", wide: true, treeHidden: true }),
    );
    expect(loadDiffPrefs(storage)).toEqual({
      view: "unified", // 坏 → 默认
      ignoreWs: true,
      treeMode: "flat",
      wide: true,
      treeHidden: true,
    });
  });

  it("类型错误的各字段各自回落", () => {
    const { storage } = makeStorage(
      JSON.stringify({ view: 1, ignoreWs: "yes", treeMode: null, wide: 0, treeHidden: [] }),
    );
    expect(loadDiffPrefs(storage)).toEqual(DEFAULT_DIFF_PREFS);
  });

  it("缺失字段回落默认值，已有字段保留", () => {
    const { storage } = makeStorage(JSON.stringify({ view: "split" }));
    expect(loadDiffPrefs(storage)).toEqual({ ...DEFAULT_DIFF_PREFS, view: "split" });
  });

  it("未知字段被丢弃", () => {
    const { storage } = makeStorage(JSON.stringify({ view: "split", extra: "x", nested: { a: 1 } }));
    const p = loadDiffPrefs(storage);
    expect(Object.keys(p).sort()).toEqual(["ignoreWs", "treeHidden", "treeMode", "view", "wide"]);
    expect(p).not.toHaveProperty("extra");
  });
});

describe("坏数据", () => {
  it("JSON 坏 → 全默认", () => {
    expect(loadDiffPrefs(makeStorage("{oops").storage)).toEqual(DEFAULT_DIFF_PREFS);
  });

  it("非对象（数字 / 字符串 / null / 数组 / 布尔）→ 全默认", () => {
    for (const raw of ["1", '"x"', "null", "[]", '["split"]', "true"]) {
      expect(loadDiffPrefs(makeStorage(raw).storage)).toEqual(DEFAULT_DIFF_PREFS);
    }
  });

  it("空串 → 全默认", () => {
    expect(loadDiffPrefs(makeStorage("").storage)).toEqual(DEFAULT_DIFF_PREFS);
  });

  it("getItem 抛错 → 全默认", () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadDiffPrefs(storage)).toEqual(DEFAULT_DIFF_PREFS);
  });
});

describe("保存异常被吞", () => {
  it("setItem 抛错不外泄", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(() => saveDiffPrefs(storage, DEFAULT_DIFF_PREFS)).not.toThrow();
  });

  it("storage 为 null 不抛", () => {
    expect(() => saveDiffPrefs(null, DEFAULT_DIFF_PREFS)).not.toThrow();
  });
});
