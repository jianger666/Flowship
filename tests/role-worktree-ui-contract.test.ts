import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSrc = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("测试角色隐藏 worktree 配置", () => {
  it("设置页和任务创建页共用同一角色规则", () => {
    const preferences = readSrc("src/components/settings/preference-card.tsx");
    const launchForm = readSrc("src/components/tasks/task-launch-form.tsx");

    expect(preferences).toContain("roleSupportsWorktree(userRole)");
    expect(launchForm).toContain("showWorktreeOptions");
    expect(launchForm).toContain("resolveLaunchIsolateWorktree");
  });
});
