/**
 * 用户可见版本说明：区间收集 / 本版回退 / 开发版跳过
 */
import { describe, expect, it } from "vitest";

import {
  collectWhatsNew,
  compareVersions,
  notesForCurrentVersion,
  shouldSkipAutoWhatsNew,
} from "@/lib/whats-new";

describe("compareVersions", () => {
  it("按数字比，不是字符串", () => {
    expect(compareVersions("1.9.10", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.9.2", "1.9.2")).toBe(0);
  });
});

describe("collectWhatsNew", () => {
  it("不含 after、含 through", () => {
    const blocks = collectWhatsNew("1.9.2", "1.9.4");
    expect(blocks.map((b) => b.version)).toEqual(["1.9.4"]);
  });

  it("首次 after=null 仍返回 through 及更早有文案的版本（调用方自己决定不弹）", () => {
    const blocks = collectWhatsNew(null, "1.9.4");
    expect(blocks.map((b) => b.version)).toContain("1.9.4");
    expect(blocks.map((b) => b.version)).toContain("1.9.2");
  });

  it("比 through 新的条目不收", () => {
    const blocks = collectWhatsNew("1.9.0", "1.9.2");
    expect(blocks.every((b) => b.version !== "1.9.4")).toBe(true);
    expect(blocks.map((b) => b.version)).toEqual(["1.9.2"]);
  });

  it("开发版不收", () => {
    expect(collectWhatsNew("1.9.2", "0.0.0-dev")).toEqual([]);
  });
});

describe("notesForCurrentVersion", () => {
  it("有本版条目就只返回本版", () => {
    const blocks = notesForCurrentVersion("1.9.4");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.version).toBe("1.9.4");
  });

  it("没有本版则退到不超过当前的最近一条", () => {
    const blocks = notesForCurrentVersion("1.9.3");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.version).toBe("1.9.2");
  });
});

describe("shouldSkipAutoWhatsNew", () => {
  it("开发版 / 空 / 非三段号跳过", () => {
    expect(shouldSkipAutoWhatsNew("0.0.0-dev")).toBe(true);
    expect(shouldSkipAutoWhatsNew("")).toBe(true);
    expect(shouldSkipAutoWhatsNew("1.9.4")).toBe(false);
  });
});
