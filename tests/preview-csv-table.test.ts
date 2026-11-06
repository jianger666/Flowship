/**
 * CSV 解析 + 表格视图模型（过滤 / 排序 / 列标 / 列宽）
 */
import { describe, expect, it } from "vitest";

import { detectDelimiter, parseDelimited } from "@/lib/preview/csv";
import {
  buildTableView,
  columnLabel,
  compareCells,
  estimateColumnWidths,
  nextSort,
  parseNumericCell,
} from "@/lib/preview/table-model";

const parse = (text: string, d: "," | "\t" | ";" | "|" = ",", maxRows = 1000, maxCols = 100) =>
  parseDelimited(text, d, { maxRows, maxCols });

describe("parseDelimited", () => {
  it("基础：行列 / 末尾换行不多出空行 / 无末尾换行的最后一行", () => {
    expect(parse("a,b\n1,2\n").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parse("a,b\n1,2").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parse("a,b\r\n1,2\r\n").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parse("a,b\r1,2\r").rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("引号字段：含分隔符 / 换行 / 转义引号", () => {
    const r = parse('name,note\n"张, 三","第一行\n第二行"\n"say ""hi""",x\n');
    expect(r.rows).toEqual([
      ["name", "note"],
      ["张, 三", "第一行\n第二行"],
      ['say "hi"', "x"],
    ]);
  });

  it("引号不闭合：不抛错，剩余内容都进最后一个字段", () => {
    const r = parse('a,"never closed\nb,c\n');
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]![0]).toBe("a");
    expect(r.rows[0]![1]).toBe("never closed\nb,c\n");
  });

  it("字段中间的引号是普通字符（不是转义）", () => {
    expect(parse('5" pipe,x\n').rows).toEqual([['5" pipe', "x"]]);
  });

  it("空字段 / 末尾分隔符 / 空行被跳过但显式 \"\" 不跳过", () => {
    expect(parse("a,,c\n,\n").rows).toEqual([["a", "", "c"], ["", ""]]);
    expect(parse("a\n\n\nb\n").rows).toEqual([["a"], ["b"]]);
    expect(parse('""\n').rows).toEqual([[""]]);
  });

  it("行 / 列上限：存不下的不存，但总行数照数、给截断标记", () => {
    const text = Array.from({ length: 50 }, (_, i) => `r${i},${"x,".repeat(10)}end`).join("\n");
    const r = parse(text, ",", 10, 5);
    expect(r.rows.length).toBe(10);
    expect(r.totalRows).toBe(50);
    expect(r.truncatedRows).toBe(true);
    expect(r.truncatedCols).toBe(true);
    expect(r.rows.every((row) => row.length === 5)).toBe(true);
    expect(r.totalCols).toBe(5);
  });

  it("空文本 → 没有行", () => {
    const r = parse("");
    expect(r.rows).toEqual([]);
    expect(r.totalRows).toBe(0);
    expect(r.truncatedRows).toBe(false);
  });

  it("制表符 / 分号 / 竖线分隔", () => {
    expect(parse("a\tb\n1\t2", "\t").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parse("a;b\n1;2", ";").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parse("a|b", "|").rows).toEqual([["a", "b"]]);
  });
});

describe("detectDelimiter", () => {
  it("按扩展名 / 内容识别", () => {
    expect(detectDelimiter("a,b\n1,2\n3,4", "csv")).toBe(",");
    expect(detectDelimiter("a,b\n1,2", "tsv")).toBe("\t");
    expect(detectDelimiter("a\tb\n1\t2\n3\t4")).toBe("\t");
    expect(detectDelimiter("a;b;c\n1;2;3\n4;5;6")).toBe(";");
    expect(detectDelimiter("a|b\n1|2\n3|4")).toBe("|");
  });

  it("引号里的分隔符不参与统计；没有任何分隔符回逗号", () => {
    expect(detectDelimiter('"a;b;c;d",x\n"1;2;3;4",y\n"5;6;7;8",z')).toBe(",");
    expect(detectDelimiter("just one column\nanother line")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });
});

describe("columnLabel", () => {
  it("Excel 列标", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLabel)).toEqual([
      "A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA",
    ]);
  });
});

describe("parseNumericCell / compareCells", () => {
  it("识别数字：千分位 / 百分号 / 货币 / 科学计数；非数字返回 null", () => {
    expect(parseNumericCell("1,234.5")).toBe(1234.5);
    expect(parseNumericCell(" 12% ")).toBe(12);
    expect(parseNumericCell("$99")).toBe(99);
    expect(parseNumericCell("-3e2")).toBe(-300);
    expect(parseNumericCell(".5")).toBe(0.5);
    expect(parseNumericCell("abc")).toBeNull();
    expect(parseNumericCell("12abc")).toBeNull();
    expect(parseNumericCell("")).toBeNull();
    expect(parseNumericCell("1.2.3")).toBeNull();
  });

  it("数字按数值比较（10 > 9，不是字典序）、数字排在文本前、文本自然排序", () => {
    expect(compareCells("10", "9")).toBeGreaterThan(0);
    expect(compareCells("9", "abc")).toBeLessThan(0);
    expect(compareCells("file2", "file10")).toBeLessThan(0);
  });
});

describe("buildTableView", () => {
  const rows = [
    ["name", "score"],
    ["bob", "10"],
    ["alice", "9"],
    ["carol", ""],
    ["dave", "100"],
  ];

  it("有表头：表头单独返回，body 下标从表头之后算", () => {
    const v = buildTableView(rows, { hasHeader: true, filter: "", sort: null });
    expect(v.header).toEqual(["name", "score"]);
    expect(v.bodyOffset).toBe(1);
    expect(v.bodyCount).toBe(4);
    expect(v.order).toEqual([0, 1, 2, 3]);
  });

  it("无表头：所有行都是 body", () => {
    const v = buildTableView(rows, { hasHeader: false, filter: "", sort: null });
    expect(v.header).toBeNull();
    expect(v.bodyCount).toBe(5);
  });

  it("数值列升序 / 降序；空单元格永远排最后（不随方向翻转）", () => {
    const names = (sort: "asc" | "desc") =>
      buildTableView(rows, { hasHeader: true, filter: "", sort: { col: 1, dir: sort } }).order.map(
        (i) => rows[1 + i]![0],
      );
    expect(names("asc")).toEqual(["alice", "bob", "dave", "carol"]);
    expect(names("desc")).toEqual(["dave", "bob", "alice", "carol"]);
  });

  it("过滤：任一单元格包含（不区分大小写），表头不参与过滤", () => {
    const v = buildTableView(rows, { hasHeader: true, filter: "AL", sort: null });
    expect(v.order.map((i) => rows[1 + i]![0])).toEqual(["alice"]);
    // 关键字恰好等于表头文字：表头不是数据行，不会被匹配出来
    expect(buildTableView(rows, { hasHeader: true, filter: "score", sort: null }).order).toEqual([]);
  });

  it("过滤 + 排序组合；排序稳定（相等项保持原顺序）", () => {
    const dup = [["k", "v"], ["a", "1"], ["b", "1"], ["c", "1"]];
    const v = buildTableView(dup, { hasHeader: true, filter: "", sort: { col: 1, dir: "asc" } });
    expect(v.order).toEqual([0, 1, 2]);
  });

  it("空表 / 只有表头：不崩", () => {
    expect(buildTableView([], { hasHeader: true, filter: "", sort: null }).order).toEqual([]);
    const only = buildTableView([["h"]], { hasHeader: true, filter: "", sort: null });
    expect(only.header).toEqual(["h"]);
    expect(only.order).toEqual([]);
  });

  it("行比表头短（参差不齐）：排序缺失单元格按空处理，不抛错", () => {
    const ragged = [["a", "b"], ["x"], ["y", "2"]];
    expect(() => buildTableView(ragged, { hasHeader: true, filter: "", sort: { col: 1, dir: "asc" } })).not.toThrow();
  });
});

describe("nextSort / estimateColumnWidths", () => {
  it("点同一列：升序 → 降序 → 取消；点别的列从升序开始", () => {
    const s1 = nextSort(null, 2);
    expect(s1).toEqual({ col: 2, dir: "asc" });
    const s2 = nextSort(s1, 2);
    expect(s2).toEqual({ col: 2, dir: "desc" });
    expect(nextSort(s2, 2)).toBeNull();
    expect(nextSort(s2, 0)).toEqual({ col: 0, dir: "asc" });
  });

  it("列宽：CJK 按 2 宽、限制在 [6,48]", () => {
    const w = estimateColumnWidths(
      [["a", "中文标题很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长", "abcdefgh"]],
      3,
    );
    expect(w[0]).toBe(6);
    expect(w[1]).toBe(48);
    expect(w[2]).toBe(10);
  });
});
