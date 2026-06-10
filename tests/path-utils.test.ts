/**
 * path-utils 单测——重点保 cursor:// 链接生成（链接坏 = 用户点了 Cursor 静默无反应、难排查）
 *
 * 起因（2026-06-10 实测踩坑）：agent 在 artifact 里写 `index.tsx:54,81-84,99` 逗号多段行号、
 * 旧正则只认 `:line` / `:line-line`、整个后缀被当成文件名、生成的链接指向不存在的文件。
 */
import { describe, expect, it } from "vitest";

import {
  buildCursorLink,
  looksLikePath,
  parsePathSegments,
} from "@/lib/path-utils";

const BASE = "/Users/me/work";

describe("buildCursorLink", () => {
  it("绝对路径直接走、忽略 baseDir", () => {
    expect(buildCursorLink("/a/b/c.ts")).toBe("cursor://file/a/b/c.ts");
    expect(buildCursorLink("/a/b/c.ts", BASE)).toBe("cursor://file/a/b/c.ts");
  });

  it("相对路径 + baseDir 拼绝对路径；没 baseDir 拼不出来返 null", () => {
    expect(buildCursorLink("src/foo.ts", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts`,
    );
    expect(buildCursorLink("src/foo.ts")).toBeNull();
  });

  it("已经是 url 的不动（http / cursor 协议）", () => {
    expect(buildCursorLink("https://example.com/a.ts")).toBeNull();
    expect(buildCursorLink("cursor://file/a.ts")).toBeNull();
  });

  it("单行号 / 范围行号 → 取起始行拼 :line 后缀", () => {
    expect(buildCursorLink("src/foo.ts:271", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts:271`,
    );
    expect(buildCursorLink("src/foo.ts:271-279", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts:271`,
    );
    expect(buildCursorLink("src/foo.ts:271:5", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts:271`,
    );
  });

  it("逗号 / 顿号分隔的多段行号 → 行号后缀不混进文件名、取起始行", () => {
    // 实测踩坑 case：旧正则不认逗号、`:54,81-84,99` 整段被 encode 进文件名
    expect(
      buildCursorLink(
        "crm-web/src/pages/order/components/AddTextbookButton/index.tsx:54,81-84,99",
        BASE,
      ),
    ).toBe(
      `cursor://file${BASE}/crm-web/src/pages/order/components/AddTextbookButton/index.tsx:54`,
    );
    expect(buildCursorLink("src/foo.ts:54、81-84", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts:54`,
    );
  });

  it("逗号后带空格的多段行号（agent 实测写法）→ 同样取起始行", () => {
    // 实测踩坑 case 2：`SendOrderDetail.vue:20-88, 189-210, 260-450, 830-878`
    expect(
      buildCursorLink(
        "tch-service-center/packages/tch-sc/src/components/SendOrderDetail.vue:20-88, 189-210, 260-450, 830-878",
        BASE,
      ),
    ).toBe(
      `cursor://file${BASE}/tch-service-center/packages/tch-sc/src/components/SendOrderDetail.vue:20`,
    );
    expect(buildCursorLink("src/TaskInfo.vue:147-154、 1350-1363", BASE)).toBe(
      `cursor://file${BASE}/src/TaskInfo.vue:147`,
    );
  });

  it("非数字冒号后缀不当行号、原样进路径", () => {
    const link = buildCursorLink("src/foo.ts:next", BASE);
    expect(link).toBe(`cursor://file${BASE}/src/foo.ts%3Anext`);
  });

  it("中文 / 空格段被 encode、`/` 和 :line 不被 encode", () => {
    expect(buildCursorLink("/a/中 文/b.ts:12")).toBe(
      `cursor://file/a/${encodeURIComponent("中 文")}/b.ts:12`,
    );
  });
});

describe("parsePathSegments", () => {
  it("多段行号全部拆出来：每段带起始行 + 原文 + 前置分隔符", () => {
    // 实测踩坑 case：`studentSituation.vue:147-175、341-370、485-508` 只能跳首段
    expect(
      parsePathSegments("src/views/studentSituation.vue:147-175、341-370、485-508"),
    ).toEqual({
      path: "src/views/studentSituation.vue",
      segments: [
        { text: "147-175", line: 147, sep: "" },
        { text: "341-370", line: 341, sep: "、" },
        { text: "485-508", line: 485, sep: "、" },
      ],
    });
  });

  it("逗号 + 空格分隔：sep 原样保留（渲染层逐字拼回原文）", () => {
    expect(parsePathSegments("a/b.vue:20-88, 189-210")).toEqual({
      path: "a/b.vue",
      segments: [
        { text: "20-88", line: 20, sep: "" },
        { text: "189-210", line: 189, sep: ", " },
      ],
    });
  });

  it("单段 / 列号也能解析（调用方按 segments.length 决定走单链接还是多链接）", () => {
    expect(parsePathSegments("a/b.vue:271")).toEqual({
      path: "a/b.vue",
      segments: [{ text: "271", line: 271, sep: "" }],
    });
    expect(parsePathSegments("a/b.vue:271:5")).toEqual({
      path: "a/b.vue",
      segments: [{ text: "271:5", line: 271, sep: "" }],
    });
  });

  it("无行号后缀 / 非数字后缀 → null", () => {
    expect(parsePathSegments("a/b.vue")).toBeNull();
    expect(parsePathSegments("a/b.vue:next")).toBeNull();
  });
});

describe("looksLikePath", () => {
  it("常规相对 / 绝对路径命中", () => {
    expect(looksLikePath("src/foo.ts")).toBe(true);
    expect(looksLikePath("/a/b/c.vue")).toBe(true);
  });

  it("带行号后缀（含逗号多段）剥掉后仍命中", () => {
    expect(looksLikePath("src/foo.ts:271-279")).toBe(true);
    expect(looksLikePath("src/foo.ts:54,81-84,99")).toBe(true);
    // 行号后缀里的空格不影响识别（路径部分无空格即可）
    expect(
      looksLikePath("src/components/SendOrderDetail.vue:20-88, 189-210, 830-878"),
    ).toBe(true);
  });

  it("不像路径的不命中：无 /、路径含空格、最后一段无扩展名", () => {
    expect(looksLikePath("foo.ts")).toBe(false);
    expect(looksLikePath("a b/c.ts")).toBe(false);
    expect(looksLikePath("src/foo")).toBe(false);
    // 空格在路径部分（不是行号后缀）→ 仍然拒绝
    expect(looksLikePath("const x = foo/bar.map()")).toBe(false);
  });
});
