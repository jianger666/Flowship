/**
 * 分支命名模板：未知占位符校验（保存入口拦 typo、避免建出字面 `{yyMMdd}` 分支）
 */
import { describe, expect, it } from "vitest";

import { findUnknownPlaceholders } from "@/lib/branch-template";

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
