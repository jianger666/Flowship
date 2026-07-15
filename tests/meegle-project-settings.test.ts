/**
 * normalizeSettings：meegleProject 缺 / 坏 → DEFAULT_MEEGLE_PROJECT
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/local-store";
import { DEFAULT_MEEGLE_PROJECT } from "@/lib/types";

describe("normalizeSettings meegleProject", () => {
  it("DEFAULT_SETTINGS 带悟空默认空间", () => {
    expect(DEFAULT_SETTINGS.meegleProject).toEqual({
      ...DEFAULT_MEEGLE_PROJECT,
    });
  });

  it("缺字段 → 回落 DEFAULT_MEEGLE_PROJECT", () => {
    const s = normalizeSettings({ apiKey: "x", repos: [] });
    expect(s.meegleProject).toEqual({ ...DEFAULT_MEEGLE_PROJECT });
  });

  it("key 空串 / 非字符串 → 回落默认", () => {
    expect(
      normalizeSettings({
        meegleProject: { key: "", name: "x" },
      } as never).meegleProject,
    ).toEqual({ ...DEFAULT_MEEGLE_PROJECT });
    expect(
      normalizeSettings({
        meegleProject: { key: 1, name: "x" },
      } as never).meegleProject,
    ).toEqual({ ...DEFAULT_MEEGLE_PROJECT });
  });

  it("合法对象透传（含 simpleName）", () => {
    const s = normalizeSettings({
      meegleProject: {
        key: "abc",
        name: "测试空间",
        simpleName: "test",
      },
    });
    expect(s.meegleProject).toEqual({
      key: "abc",
      name: "测试空间",
      simpleName: "test",
    });
  });
});
