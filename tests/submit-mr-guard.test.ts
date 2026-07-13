/**
 * submit_mr server 端范围校验单测（安全关键：校验放水 = agent 可用 server PAT 越权提 MR）
 *
 * validateSubmitMr 第 5 步（project_path 对账）依赖真实 git remote、测试里用
 * 不存在的 repoPath——deriveProjectPathFromRepo 读不到返 null、该步放行（fail-open 设计）、
 * 前 4 步纯逻辑全覆盖。
 */
import { describe, expect, it } from "vitest";

import {
  parseProjectPathFromRemoteUrl,
  validateSubmitMr,
} from "@/lib/server/submit-mr-guard";
import type { Task } from "@/lib/types";

// 不存在的路径：跳过 git remote 对账、聚焦前 4 步纯逻辑
const REPO = "/nonexistent/ai-flow-test-repo";

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t_1",
    title: "测试任务",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act_3",
    actions: [
      { id: "act_2", n: 2, type: "build", status: "completed" },
      { id: "act_3", n: 3, type: "ship", status: "running" },
    ],
    mrs: [],
    role: "fe",
    repoPaths: [REPO],
    gitBranches: [{ repoPath: REPO, name: "feature/me/123-x", createdAt: 0 }],
    repoTestBranches: { [REPO]: "test" },
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    events: [],
    contextDocs: [],
    ...over,
  }) as unknown as Task;

const baseMr = {
  kind: "submit_mr" as const,
  actionId: "act_3",
  repoPath: REPO,
  projectPath: "group/proj",
  sourceBranch: "feature/me/123-x",
  targetBranch: "test",
  title: "MR 标题",
  description: "",
  lastCommitHash: "abc1234",
};

describe("validateSubmitMr", () => {
  it("全部合法 → ok", async () => {
    const r = await validateSubmitMr(baseTask(), baseMr);
    expect(r.ok).toBe(true);
  });

  it("只读仓拒绝提 MR", async () => {
    const r = await validateSubmitMr(
      baseTask({ readonlyRepoPaths: [REPO] }),
      baseMr,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("只读仓");
  });

  it("repo_path 不在 task.repoPaths → 拒（核心越权防线）", async () => {
    const r = await validateSubmitMr(baseTask(), {
      ...baseMr,
      repoPath: "/other/repo",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不属于本 task");
  });

  it("action_id 不是 ship / dev / custom action → 拒", async () => {
    const r = await validateSubmitMr(baseTask(), {
      ...baseMr,
      actionId: "act_2", // build action
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ship / dev / custom action");
  });

  it("target_branch 不是该仓测试分支 → 拒（不许提 master）", async () => {
    const r = await validateSubmitMr(baseTask(), {
      ...baseMr,
      targetBranch: "master",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("测试分支");
  });

  it("repoTestBranches 没配 → 默认 test", async () => {
    const task = baseTask({ repoTestBranches: undefined } as Partial<Task>);
    expect((await validateSubmitMr(task, baseMr)).ok).toBe(true);
    expect(
      (await validateSubmitMr(task, { ...baseMr, targetBranch: "main" })).ok,
    ).toBe(false);
  });

  it("source_branch 必须是已记录 feature 分支或其 __conflict 变体", async () => {
    expect((await validateSubmitMr(baseTask(), baseMr)).ok).toBe(true);
    expect(
      (
        await validateSubmitMr(baseTask(), {
          ...baseMr,
          sourceBranch: "feature/me/123-x__conflict",
        })
      ).ok,
    ).toBe(true);
    const r = await validateSubmitMr(baseTask(), {
      ...baseMr,
      sourceBranch: "random-branch",
    });
    expect(r.ok).toBe(false);
  });

  it("gitBranches 没记录该仓 → 退化兜底：非空且 ≠ 目标分支", async () => {
    const task = baseTask({ gitBranches: [] } as Partial<Task>);
    expect(
      (await validateSubmitMr(task, { ...baseMr, sourceBranch: "any-branch" }))
        .ok,
    ).toBe(true);
    expect(
      (await validateSubmitMr(task, { ...baseMr, sourceBranch: "test" })).ok,
    ).toBe(false);
    expect(
      (await validateSubmitMr(task, { ...baseMr, sourceBranch: "  " })).ok,
    ).toBe(false);
  });

  // V0.x：联调（dev action）提 PR——target 校验改成该仓 dev 分支（必须显式配）
  const devTask = (over: Partial<Task> = {}): Task =>
    baseTask({
      currentActionId: "act_4",
      actions: [
        { id: "act_2", n: 2, type: "build", status: "completed" },
        { id: "act_4", n: 4, type: "dev", status: "running" },
      ],
      repoDevBranches: { [REPO]: "develop" },
      ...over,
    } as Partial<Task>);
  const devMr = { ...baseMr, actionId: "act_4", targetBranch: "develop" };

  it("dev action + target=该仓 dev 分支 → ok", async () => {
    expect((await validateSubmitMr(devTask(), devMr)).ok).toBe(true);
  });

  it("dev action + target 不是 dev 分支（如 test）→ 拒", async () => {
    const r = await validateSubmitMr(devTask(), {
      ...devMr,
      targetBranch: "test",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("dev 分支");
  });

  it("dev action 但该仓没配 dev 分支 → 拒", async () => {
    const task = devTask({ repoDevBranches: undefined } as Partial<Task>);
    const r = await validateSubmitMr(task, devMr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("没配 dev 分支");
  });

  // V0.9.4：custom action 的 target 完全放开（任意分支、由该 action playbook 决定）。
  // target 提到的都是「本仓内」分支、不构成越权；越权仍由 仓范围 / source 必须 feature / project 对账 三道闸守着。
  const customTask = (over: Partial<Task> = {}): Task =>
    baseTask({
      currentActionId: "act_5",
      actions: [
        { id: "act_2", n: 2, type: "build", status: "completed" },
        { id: "act_5", n: 5, type: "custom", status: "running" },
      ],
      repoBaseBranches: { [REPO]: "master" },
      ...over,
    } as Partial<Task>);
  const customMr = { ...baseMr, actionId: "act_5", targetBranch: "master" };

  it("custom action + target=线上分支 → ok", async () => {
    expect((await validateSubmitMr(customTask(), customMr)).ok).toBe(true);
  });

  it("custom action + target=test → ok（放开、不限分支）", async () => {
    const r = await validateSubmitMr(customTask(), {
      ...customMr,
      targetBranch: "test",
    });
    expect(r.ok).toBe(true);
  });

  it("custom action + target=任意分支（如 release/1.2）→ ok（放开、不限分支）", async () => {
    const r = await validateSubmitMr(customTask(), {
      ...customMr,
      targetBranch: "release/1.2",
    });
    expect(r.ok).toBe(true);
  });

  it("custom action 没配线上分支也能提（target 不再依赖 repoBaseBranches）", async () => {
    const task = customTask({ repoBaseBranches: undefined } as Partial<Task>);
    const r = await validateSubmitMr(task, { ...customMr, targetBranch: "test" });
    expect(r.ok).toBe(true);
  });

  it("custom action 仍受仓范围约束（repo_path 不在 task → 拒）", async () => {
    const r = await validateSubmitMr(customTask(), {
      ...customMr,
      repoPath: "/other/repo",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不属于本 task");
  });

  it("custom action 仍受 source 必须 feature 约束（不能拿线上分支当 source）", async () => {
    const r = await validateSubmitMr(customTask(), {
      ...customMr,
      sourceBranch: "master",
    });
    expect(r.ok).toBe(false);
  });
});

describe("parseProjectPathFromRemoteUrl", () => {
  it("git@ SSH 形态", () => {
    expect(parseProjectPathFromRemoteUrl("git@git.corp.com:wkid/crm-web.git")).toBe(
      "wkid/crm-web",
    );
  });

  it("https 形态", () => {
    expect(
      parseProjectPathFromRemoteUrl("https://git.corp.com/group/sub/proj.git"),
    ).toBe("group/sub/proj");
  });

  it("无 .git 后缀也可", () => {
    expect(parseProjectPathFromRemoteUrl("https://git.corp.com/g/p")).toBe("g/p");
  });

  it("空 / 解析不出 → null", () => {
    expect(parseProjectPathFromRemoteUrl("")).toBe(null);
  });
});
