/**
 * 分支命名模板：未知占位符校验 + 渲染整串清洗 + isSafeBranchName
 */
import { describe, expect, it } from "vitest";

import {
  findUnknownPlaceholders,
  guardRepoBranchTemplates,
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

describe("guardRepoBranchTemplates（S13-01：其它保存动作不能把坏模板带进落盘）", () => {
  const persisted = [
    { path: "/a", name: "a", branchTemplate: "feature/{storyId}" },
    { path: "/b", name: "b" },
  ];

  it("草稿含字面量 {yyMMdd} 的仓 → 落盘值回退旧模板、blocked 报出该仓", () => {
    const draft = [
      { path: "/a", name: "a-renamed", branchTemplate: "feat/{yyMMdd}" },
      { path: "/b", name: "b" },
    ];
    const { repos, blocked } = guardRepoBranchTemplates(draft, persisted);
    expect(blocked).toEqual(["/a"]);
    // 其它字段（改名）照常落盘、只有坏模板被顶替
    expect(repos[0]).toMatchObject({
      name: "a-renamed",
      branchTemplate: "feature/{storyId}",
    });
    expect(repos[1]).toBe(draft[1]);
  });

  it("旧值不存在（新仓 / 原本没配）→ 回落 undefined（用全局模板）", () => {
    const { repos, blocked } = guardRepoBranchTemplates(
      [{ path: "/b", name: "b", branchTemplate: "x/{yyMMdd}" }],
      persisted,
    );
    expect(blocked).toEqual(["/b"]);
    expect(repos[0].branchTemplate).toBeUndefined();
  });

  it("旧值自己也非法（历史脏数据）→ 不沿用、清空", () => {
    const { repos } = guardRepoBranchTemplates(
      [{ path: "/a", name: "a", branchTemplate: "{bad}" }],
      [{ path: "/a", name: "a", branchTemplate: "{old-bad}" }],
    );
    expect(repos[0].branchTemplate).toBeUndefined();
  });

  it("全部合法 → 原样返回、blocked 为空", () => {
    const draft = [
      { path: "/a", name: "a", branchTemplate: "feat/{date:yyMMdd}-{taskTitle}" },
    ];
    const { repos, blocked } = guardRepoBranchTemplates(draft, persisted);
    expect(blocked).toEqual([]);
    expect(repos[0]).toBe(draft[0]);
  });
});
