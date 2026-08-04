/**
 * planBranchesForBuild：分支名拼进 bash hint 时必须单引号包裹 + 白名单清洗
 */
import { describe, expect, it } from "vitest";

import { planBranchesForBuild } from "@/lib/server/action-gates";
import type { Task } from "@/lib/types";

const baseTask = (patch: Partial<Task> = {}): Task =>
  ({
    id: "t_1",
    title: "测 hint",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: ["/tmp/fake-repo-for-hint"],
    feishuStoryUrl: "https://project.feishu.cn/x/story/detail/123456",
    actions: [],
    mrs: [],
    ...patch,
  }) as Task;

describe("planBranchesForBuild bash hint 防注入", () => {
  it("正常分支名单引号包裹进 git checkout / show-ref", () => {
    const r = planBranchesForBuild(baseTask());
    expect(r).not.toBeNull();
    expect(r!.infos[0].name).toBe("feature/123456-测-hint");
    // 单引号包裹，不是裸拼
    expect(r!.promptHint).toContain("git checkout 'feature/123456-测-hint'");
    expect(r!.promptHint).toContain(
      "refs/heads/'feature/123456-测-hint'",
    );
    expect(r!.promptHint).not.toMatch(/git checkout feature\/123456/);
  });

  it("无飞书链接（日常轻量态）→ 不建分支 / 不注入 checkout hint", () => {
    expect(planBranchesForBuild(baseTask({ feishuStoryUrl: undefined }))).toBeNull();
    expect(planBranchesForBuild(baseTask({ feishuStoryUrl: "" }))).toBeNull();
    expect(planBranchesForBuild(baseTask({ feishuStoryUrl: "  " }))).toBeNull();
  });

  it("任务标题含 ; /$() → 清洗后再进 hint", () => {
    const r = planBranchesForBuild(
      baseTask({
        title: "evil;rm -rf /",
      }),
    );
    expect(r).not.toBeNull();
    // 非法字符洗成 -，且整串单引号
    expect(r!.infos[0].name).not.toContain(";");
    expect(r!.promptHint).not.toContain("evil;rm");
    expect(r!.promptHint).toMatch(/git checkout '[^']+'/);
  });

  it("非测试任务忽略 repoFeatureBranches 覆盖、仍走模板", () => {
    const r = planBranchesForBuild(
      baseTask({
        repoFeatureBranches: {
          "/tmp/fake-repo-for-hint": "feature/override",
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.infos[0].name).toBe("feature/123456-测-hint");
  });

  it("测试任务不走开发任务的自动建 feature 分支", () => {
    expect(
      planBranchesForBuild(
        baseTask({
          workRole: "qa",
          repoFeatureBranches: {
            "/tmp/fake-repo-for-hint": "feature/ready",
          },
        }),
      ),
    ).toBeNull();
  });
});
