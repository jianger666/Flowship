import { describe, expect, it } from "vitest";

import {
  resolveLaunchIsolateWorktree,
  roleSupportsWorktree,
} from "@/lib/role-worktree";

describe("测试角色的 worktree 规则", () => {
  it("测试角色不支持 worktree，其它角色保持原能力", () => {
    expect(roleSupportsWorktree("qa")).toBe(false);
    expect(roleSupportsWorktree("fe")).toBe(true);
    expect(roleSupportsWorktree("be")).toBe(true);
    expect(roleSupportsWorktree(undefined)).toBe(true);
  });

  it("测试角色无论旧默认如何都强制在原仓运行", () => {
    expect(
      resolveLaunchIsolateWorktree({
        role: "qa",
        forceOriginalRepo: false,
        runInRepo: false,
      }),
    ).toBe(false);
  });

  it("其它角色保留强制原仓和用户选择语义", () => {
    expect(
      resolveLaunchIsolateWorktree({
        role: "fe",
        forceOriginalRepo: false,
        runInRepo: false,
      }),
    ).toBe(true);
    expect(
      resolveLaunchIsolateWorktree({
        role: "fe",
        forceOriginalRepo: true,
        runInRepo: false,
      }),
    ).toBe(false);
    expect(
      resolveLaunchIsolateWorktree({
        role: "be",
        forceOriginalRepo: false,
        runInRepo: true,
      }),
    ).toBe(false);
  });
});
