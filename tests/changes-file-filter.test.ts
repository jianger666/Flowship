/**
 * 改动面板文件搜索：词表解析 / AND 匹配 / 高亮区间。
 * 重点守「偏移基于原 path」——大小写转换改变长度的字符（İ）不能让高亮错位。
 */
import { describe, expect, it } from "vitest";

import { matchRanges, matchesFileQuery, parseFileQuery } from "@/lib/changes/file-filter";

/** 按区间取出原串里被高亮的片段 */
const slices = (path: string, ranges: Array<[number, number]>): string[] =>
  ranges.map(([s, e]) => path.slice(s, e));

describe("parseFileQuery", () => {
  it("按空白切分、转小写、去空", () => {
    expect(parseFileQuery("  Lib   DIFF\tTs\n")).toEqual(["lib", "diff", "ts"]);
  });

  it("全空 / 空串返回 []", () => {
    expect(parseFileQuery("")).toEqual([]);
    expect(parseFileQuery("  \t\n ")).toEqual([]);
  });

  it("保留路径分隔符等特殊字符", () => {
    expect(parseFileQuery("src/lib .test.ts")).toEqual(["src/lib", ".test.ts"]);
  });
});

describe("matchesFileQuery", () => {
  it("空词表 = 全部匹配", () => {
    expect(matchesFileQuery("any/path.ts", [])).toBe(true);
  });

  it("单词子串匹配", () => {
    expect(matchesFileQuery("src/lib/diff-syntax.ts", ["diff"])).toBe(true);
    expect(matchesFileQuery("src/lib/diff-syntax.ts", ["nope"])).toBe(false);
  });

  it("多词 AND：全部出现才算，与出现顺序无关", () => {
    expect(matchesFileQuery("src/lib/diff-syntax.ts", ["ts", "lib", "diff"])).toBe(true);
    expect(matchesFileQuery("src/lib/diff-syntax.ts", ["lib", "missing"])).toBe(false);
  });

  it("大小写不敏感（path 与词两侧都是）", () => {
    expect(matchesFileQuery("src/Components/FileTree.TSX", ["filetree", "tsx"])).toBe(true);
    expect(matchesFileQuery("src/components/filetree.tsx", ["FILETREE"])).toBe(true);
  });

  it("中文路径", () => {
    expect(matchesFileQuery("文档/设计/方案.md", ["设计"])).toBe(true);
    expect(matchesFileQuery("文档/设计/方案.md", ["设计", "方案"])).toBe(true);
    expect(matchesFileQuery("文档/设计/方案.md", ["实现"])).toBe(false);
  });

  it("词里含正则特殊字符时按字面匹配", () => {
    expect(matchesFileQuery("a/[id]/page.tsx", ["[id]"])).toBe(true);
    expect(matchesFileQuery("a/x/page.tsx", ["[id]"])).toBe(false);
    expect(matchesFileQuery("a.b", ["."])).toBe(true);
    expect(matchesFileQuery("ab", ["."])).toBe(false);
  });
});

describe("matchRanges", () => {
  it("空词表 / 无命中返回 []", () => {
    expect(matchRanges("src/a.ts", [])).toEqual([]);
    expect(matchRanges("src/a.ts", ["zzz"])).toEqual([]);
    expect(matchRanges("", ["a"])).toEqual([]);
  });

  it("单词多处命中，区间升序", () => {
    expect(matchRanges("a/ab/ba", ["a"])).toEqual([
      [0, 1],
      [2, 3],
      [6, 7],
    ]);
  });

  it("大小写不敏感，偏移对应原 path", () => {
    const path = "src/FileTree.tsx";
    const ranges = matchRanges(path, ["filetree"]);
    expect(ranges).toEqual([[4, 12]]);
    expect(slices(path, ranges)).toEqual(["FileTree"]);
  });

  it("重叠区间合并", () => {
    // "aaa" 里词 "aa" 在 0 与 1 处命中，合并成 [0,3]
    expect(matchRanges("aaa", ["aa"])).toEqual([[0, 3]]);
    // 两个词交叠：abc 与 bcd
    expect(matchRanges("abcd", ["abc", "bcd"])).toEqual([[0, 4]]);
  });

  it("相邻区间合并", () => {
    expect(matchRanges("abcd", ["ab", "cd"])).toEqual([[0, 4]]);
  });

  it("不相邻的区间保持分开，且与词表顺序无关", () => {
    expect(matchRanges("ab-cd", ["cd", "ab"])).toEqual([
      [0, 2],
      [3, 5],
    ]);
  });

  it("被包含的区间合并后只剩外层", () => {
    expect(matchRanges("abcdef", ["abcdef", "cd"])).toEqual([[0, 6]]);
  });

  it("特殊字符 İ：小写会变长，偏移仍基于原 path", () => {
    // "İ".toLowerCase() === "i̇"（2 个码元）。若直接用小写串下标，词 "a" 会得到 [4,5] 而不是 [2,3]
    const path = "İİa.ts";
    expect("İİa.ts".toLowerCase().indexOf("a")).toBe(4);
    const ranges = matchRanges(path, ["a"]);
    expect(ranges).toEqual([[2, 3]]);
    expect(slices(path, ranges)).toEqual(["a"]);
  });

  it("特殊字符 İ：用完整小写展开（i + 组合点）作为词能命中整个原字符", () => {
    const path = "xİy";
    const ranges = matchRanges(path, ["i\u0307"]);
    expect(ranges).toEqual([[1, 2]]);
    expect(slices(path, ranges)).toEqual(["İ"]);
  });

  it("特殊字符 İ：词 i 命中 İ，且 matchesFileQuery 与 matchRanges 一致", () => {
    const path = "İndex.ts";
    expect(matchesFileQuery(path, ["i"])).toBe(true);
    expect(matchRanges(path, ["i"])).toEqual([[0, 1]]);
    expect(matchRanges(path, ["index"])).toEqual([]);
  });

  it("中文路径", () => {
    const path = "文档/设计/方案.md";
    const ranges = matchRanges(path, ["设计", "md"]);
    expect(slices(path, ranges)).toEqual(["设计", "md"]);
    expect(ranges).toEqual([
      [3, 5],
      [9, 11],
    ]);
  });

  it("代理对（emoji）不被劈开，偏移按码元计", () => {
    const path = "a😀b.ts";
    expect(matchRanges(path, ["b"])).toEqual([[3, 4]]);
    expect(matchRanges(path, ["😀"])).toEqual([[1, 3]]);
  });

  it("词里含特殊字符按字面匹配", () => {
    const path = "app/[id]/page.tsx";
    expect(slices(path, matchRanges(path, ["[id]"]))).toEqual(["[id]"]);
  });
});
