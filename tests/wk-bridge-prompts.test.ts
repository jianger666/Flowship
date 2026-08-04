import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseWkExpectedBranch } from "@/lib/server/wk-source-branch";

const prompt = (name: string): string =>
  readFileSync(path.join(process.cwd(), "prompts", name), "utf8");

describe("WK 联调/提测分支承接", () => {
  it("status 分支只读取顶层字段并按兼容键优先级解析", () => {
    expect(
      parseWkExpectedBranch(
        "expected_git_branch: feature/REQ-1\ngit_branch: feature/REQ-2\n",
      ),
    ).toBe("feature/REQ-1");
    expect(
      parseWkExpectedBranch(
        "expected_git_branch:\nintegration:\n  readiness:\n    branch: nested\n",
      ),
    ).toBeNull();
    expect(parseWkExpectedBranch("branch: 'feature/REQ-3'\n")).toBe(
      "feature/REQ-3",
    );
  });

  it.each(["action-ship.md", "action-dev.md"])(
    "%s 包含 status → REQ-ID → ask_user 的 WK 分支规则",
    (name) => {
      const text = prompt(name);
      expect(text).toContain("expected_git_branch");
      expect(text).toContain("当前分支名包含 `REQ-ID`");
      expect(text).toContain("多个");
      expect(text).toContain("ask_user");
      expect(text).toContain("禁止直接把 `REQ-ID` 当完整分支名");
    },
  );

  it("提测不再把内置 build 作为统一硬前置", () => {
    const text = prompt("action-ship.md");
    expect(text).toContain("WK 流程：不要求存在内置 build artifact");
    expect(text).not.toContain("至少 1 个已通过的 build action");
  });
});
