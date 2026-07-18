/**
 * 分支命名模板：未知占位符校验 + 渲染整串清洗 + isSafeBranchName
 */
import { describe, expect, it } from "vitest";

import {
  findUnknownPlaceholders,
  isSafeBranchName,
  renderBranchName,
  sanitizeBranchName,
} from "@/lib/branch-template";

describe("findUnknownPlaceholders", () => {
  it("合法模板（含 date 格式）→ 空数组", () => {
    expect(
      findUnknownPlaceholders("feature/{storyId}-{taskTitle}"),
    ).toEqual([]);
    expect(
      findUnknownPlaceholders("feature/{date:yyMMdd}-{taskTitle}"),
    ).toEqual([]);
    expect(
      findUnknownPlaceholders("feat/{date:yyyy-MM-dd}/{storyId}"),
    ).toEqual([]);
  });

  it("常见 typo {yyMMdd}（漏写 date:）→ 报出原文", () => {
    expect(
      findUnknownPlaceholders("feature/{yyMMdd}-{taskTitle}"),
    ).toEqual(["{yyMMdd}"]);
  });

  it("{date:} 空格式 → 未知", () => {
    expect(findUnknownPlaceholders("feature/{date:}-x")).toEqual([
      "{date:}",
    ]);
  });

  it("已废弃 {username} 放行（历史配置可能残留）", () => {
    expect(
      findUnknownPlaceholders("feature/{username}/{storyId}"),
    ).toEqual([]);
  });

  it("无花括号 → 合法", () => {
    expect(findUnknownPlaceholders("feature/hardcoded-name")).toEqual([]);
    expect(findUnknownPlaceholders("")).toEqual([]);
  });
});

describe("renderBranchName 整串清洗（含模板字面量）", () => {
  it("占位符值非法字符仍清洗；模板字面 $ ; 等也洗掉", () => {
    expect(
      renderBranchName("feature/{storyId}-{taskTitle}", {
        storyId: "123",
        taskTitle: "修 bug",
      }),
    ).toBe("feature/123-修-bug");
    // 字面量带 $() / 空格 / 分号 → 整串再过 sanitizeBranchName
    expect(
      renderBranchName("feat$ure/{storyId}", { storyId: "99" }),
    ).toBe("feat-ure/99");
    expect(
      renderBranchName("a;b/{storyId}", { storyId: "1" }),
    ).toBe("a-b/1");
  });

  it("保留 / 作路径分隔、连续 / 折叠", () => {
    expect(
      renderBranchName("feature//{storyId}//x", { storyId: "1" }),
    ).toBe("feature/1/x");
  });
});

describe("isSafeBranchName / sanitizeBranchName", () => {
  it("合法 feature 名放行", () => {
    expect(isSafeBranchName("feature/123-测")).toBe(true);
    expect(isSafeBranchName("v1.0.0")).toBe(true);
  });

  it("拒空串、前导 -、空白、..、非法 ref 字符", () => {
    expect(isSafeBranchName("")).toBe(false);
    expect(isSafeBranchName("  ")).toBe(false);
    expect(isSafeBranchName("-evil")).toBe(false);
    expect(isSafeBranchName("a b")).toBe(false);
    expect(isSafeBranchName("a..b")).toBe(false);
    expect(isSafeBranchName("a;b")).toBe(false);
    expect(isSafeBranchName("a$(x)")).toBe(false);
    expect(isSafeBranchName("a^b")).toBe(false);
  });

  it("sanitizeBranchName 分段清洗并保留 /", () => {
    expect(sanitizeBranchName("a;b/c d")).toBe("a-b/c-d");
  });
});
