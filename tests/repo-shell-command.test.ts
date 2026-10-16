import { describe, expect, it } from "vitest";

import { sanitizeRepoShellCommand } from "@/lib/repo-shell-command";

describe("sanitizeRepoShellCommand", () => {
  it("trim 后空串 / 非 string → undefined", () => {
    expect(sanitizeRepoShellCommand("  ")).toBeUndefined();
    expect(sanitizeRepoShellCommand(null)).toBeUndefined();
  });

  it("含换行 → undefined", () => {
    expect(sanitizeRepoShellCommand("pnpm install\n evil")).toBeUndefined();
    expect(sanitizeRepoShellCommand("a\rb")).toBeUndefined();
  });

  it("合法命令保留；刚好 500 字符保留", () => {
    expect(sanitizeRepoShellCommand("  yarn install  ")).toBe("yarn install");
    expect(sanitizeRepoShellCommand("x".repeat(500))?.length).toBe(500);
  });

  it("超长丢弃、绝不截断（截断的 shell 命令可能变成另一条命令）", () => {
    expect(sanitizeRepoShellCommand("x".repeat(501))).toBeUndefined();
    expect(
      sanitizeRepoShellCommand(`yarn install && ${"y".repeat(600)}`),
    ).toBeUndefined();
  });
});
