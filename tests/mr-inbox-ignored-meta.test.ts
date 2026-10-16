/**
 * R8-02：已忽略条目简要信息的纯函数（构造 / 清洗 / 展示回落）。
 */
import { describe, expect, it } from "vitest";

import {
  buildIgnoredMeta,
  describeIgnoredEntry,
  sanitizeIgnoredMeta,
} from "@/lib/mr-inbox-ignored-meta";

const MR = "https://gitlab.corp.com/g/sub/r/-/merge_requests/9?foo=1";

describe("buildIgnoredMeta", () => {
  it("待测 MR：优先 MR 标题，缺则回落工作项名；ref = 仓库!编号", () => {
    expect(
      buildIgnoredMeta({
        url: MR,
        pendingMr: { workItemName: "需求 A", mr: { title: "feat: x" } },
      }),
    ).toEqual({ title: "feat: x", group: "pendingMr", ref: "g/sub/r!9" });
    expect(
      buildIgnoredMeta({
        url: MR,
        pendingMr: { workItemName: "需求 A", mr: null },
      })?.title,
    ).toBe("需求 A");
  });

  it("bug：区分我的 BUG / 待回归，ref = #工作项 id", () => {
    const url = "https://meegle.example.com/p/issue/detail/55";
    expect(
      buildIgnoredMeta({
        url,
        myBugs: { name: "崩溃", workItemId: "55" },
      }),
    ).toEqual({ title: "崩溃", group: "myBugs", ref: "#55" });
    expect(
      buildIgnoredMeta({
        url,
        pendingRegression: { name: "崩溃", workItemId: "55" },
      })?.group,
    ).toBe("pendingRegression");
  });

  it("快照里没抠到条目：不造 meta", () => {
    expect(buildIgnoredMeta({ url: MR })).toBeUndefined();
  });
});

describe("sanitizeIgnoredMeta", () => {
  it("只留已知字段、非法值丢弃、全空返回 undefined", () => {
    expect(
      sanitizeIgnoredMeta({ title: " t ", group: "myBugs", ref: "#1", x: 1 }),
    ).toEqual({ title: "t", group: "myBugs", ref: "#1" });
    expect(sanitizeIgnoredMeta({ group: "nope", title: 3 })).toBeUndefined();
    expect(sanitizeIgnoredMeta(null)).toBeUndefined();
    expect(sanitizeIgnoredMeta([1])).toBeUndefined();
  });
});

describe("describeIgnoredEntry", () => {
  it("旧数据缺标题 → 回落 url、无副标题", () => {
    expect(describeIgnoredEntry({ url: MR, at: 1 })).toEqual({
      title: MR,
      sub: "",
    });
  });
  it("有 meta → 标题 + 分组 · 引用", () => {
    expect(
      describeIgnoredEntry({
        url: MR,
        at: 1,
        title: "feat: x",
        group: "pendingMr",
        ref: "g/r!9",
      }),
    ).toEqual({ title: "feat: x", sub: "待测 MR · g/r!9" });
  });
});
