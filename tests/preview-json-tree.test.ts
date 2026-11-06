/**
 * JSON 树视图数据层：摊平 / 展开 / 路径 / 搜索
 */
import { describe, expect, it } from "vitest";

import {
  allContainerPaths,
  childPath,
  defaultExpandedPaths,
  flattenJson,
  kindOf,
  searchJson,
} from "@/lib/preview/json-tree";

const doc = {
  name: "flowship",
  version: 2,
  tags: ["a", "b"],
  nested: { "key with space": true, empty: {}, list: [{ id: 1 }, { id: 2 }], nothing: null },
};

describe("childPath", () => {
  it("标识符用点、其它用 [\"..\"]、数组用下标；引号被转义", () => {
    expect(childPath("$", "name")).toBe("$.name");
    expect(childPath("$", "a b")).toBe('$["a b"]');
    expect(childPath("$", 'q"uote')).toBe('$["q\\"uote"]');
    expect(childPath("$.tags", 0)).toBe("$.tags[0]");
    expect(childPath("$", "1abc")).toBe('$["1abc"]');
  });
});

describe("kindOf", () => {
  it("区分 null / array / object / 基本类型", () => {
    expect([null, [], {}, "s", 1, true].map(kindOf)).toEqual(["null", "array", "object", "string", "number", "boolean"]);
  });
});

describe("flattenJson", () => {
  it("全部折叠：只有根一行；根摘要显示子项数", () => {
    const { rows } = flattenJson(doc, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "$", display: "{4}", expandable: true, expanded: false });
  });

  it("默认展开两层：根 + 直接容器子节点，按文档顺序", () => {
    const expanded = defaultExpandedPaths(doc, 2);
    expect([...expanded].sort()).toEqual(["$", "$.nested", "$.tags"]);
    const { rows } = flattenJson(doc, expanded);
    expect(rows.map((r) => r.path)).toEqual([
      "$",
      "$.name",
      "$.version",
      "$.tags",
      "$.tags[0]",
      "$.tags[1]",
      "$.nested",
      '$.nested["key with space"]',
      "$.nested.empty",
      "$.nested.list",
      "$.nested.nothing",
    ]);
    expect(rows.find((r) => r.path === "$.name")).toMatchObject({ display: '"flowship"', kind: "string", depth: 1, key: "name" });
    expect(rows.find((r) => r.path === "$.tags[1]")).toMatchObject({ arrayIndex: 1, key: null, depth: 2 });
  });

  it("空对象 / 空数组不可展开（没有子项）", () => {
    const { rows } = flattenJson(doc, new Set(["$", "$.nested"]));
    const empty = rows.find((r) => r.path === "$.nested.empty")!;
    expect(empty).toMatchObject({ expandable: false, expanded: false, display: "{0}" });
  });

  it("展开集合里写了但不可展开的路径不影响结果", () => {
    const { rows } = flattenJson({ a: 1 }, new Set(["$", "$.a"]));
    expect(rows.map((r) => r.path)).toEqual(["$", "$.a"]);
  });

  it("根是基本类型 / 数组", () => {
    expect(flattenJson(42, new Set()).rows[0]).toMatchObject({ path: "$", display: "42", expandable: false });
    expect(flattenJson([1, [2]], new Set(["$"])).rows.map((r) => r.path)).toEqual(["$", "$[0]", "$[1]"]);
  });

  it("行数封顶：超出给 capped 标记，不无限增长", () => {
    const big = Array.from({ length: 1000 }, (_, i) => i);
    const { rows, capped } = flattenJson(big, new Set(["$"]), 100);
    expect(rows).toHaveLength(100);
    expect(capped).toBe(true);
  });

  it("极深嵌套：不爆栈", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 50_000; i++) deep = [deep];
    const expanded = allContainerPaths(deep, 60_000);
    expect(() => flattenJson(deep, expanded, 100)).not.toThrow();
  });

  it("__proto__ 键作为普通键展示（JSON.parse 产生的自有属性），不污染原型", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}') as Record<string, unknown>;
    const { rows } = flattenJson(parsed, new Set(["$"]));
    expect(rows.map((r) => r.key)).toEqual([null, "__proto__", "x"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("searchJson", () => {
  it("键名与值都能命中，不区分大小写；祖先路径用来展开", () => {
    const r = searchJson(doc, "ID");
    expect(r.matches).toEqual(["$.nested.list[0].id", "$.nested.list[1].id"]);
    expect([...r.ancestors].sort()).toEqual(["$", "$.nested", "$.nested.list", "$.nested.list[0]", "$.nested.list[1]"]);
  });

  it("按值命中（字符串 / 数字 / 布尔 / null）", () => {
    expect(searchJson(doc, "flowship").matches).toEqual(["$.name"]);
    expect(searchJson(doc, "true").matches).toEqual(['$.nested["key with space"]']);
    expect(searchJson(doc, "null").matches).toEqual(["$.nested.nothing"]);
  });

  it("容器自身的摘要文字（{4}）不参与匹配", () => {
    expect(searchJson(doc, "{").matches).toEqual([]);
  });

  it("命中数封顶；空查询没有结果", () => {
    const many = Array.from({ length: 100 }, () => "hit");
    const r = searchJson(many, "hit", { limit: 10 });
    expect(r.matches).toHaveLength(10);
    expect(r.capped).toBe(true);
    expect(searchJson(doc, "  ").matches).toEqual([]);
  });

  it("把祖先并进展开集合后，命中节点出现在摊平结果里", () => {
    const r = searchJson(doc, "key with");
    const expanded = new Set<string>(r.ancestors);
    const rows = flattenJson(doc, expanded).rows;
    expect(rows.map((x) => x.path)).toContain('$.nested["key with space"]');
  });

  it("极深嵌套：不爆栈", () => {
    let deep: unknown = "needle";
    for (let i = 0; i < 50_000; i++) deep = [deep];
    expect(() => searchJson(deep, "needle")).not.toThrow();
  });
});
