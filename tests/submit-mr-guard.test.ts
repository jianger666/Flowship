/**
 * submit_mr server 端范围校验单测（安全关键：校验放水 = agent 可用 server PAT 越权提 MR）
 *
 * 第 5 步 project_path 对账已改为 fail-closed（审查发现：读不到 remote 就放行可被弄坏
 * remote 绕过）。合法用例用临时 git 仓 + 已知 origin；另有用例锁「读不到 → 拒」。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  parseProjectPathFromRemoteUrl,
  validateSubmitMr,
} from "@/lib/server/submit-mr-guard";
import type { Task } from "@/lib/types";

/** 读不到 remote 的路径（闸 5 fail-closed 用例） */
const MISSING_REPO = "/nonexistent/ai-flow-test-repo";

/** 临时仓 remote → project_path 对账用 */
const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";

let REPO = "";

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "submit-mr-guard-"));
  execFileSync("git", ["init"], { cwd: REPO });
  execFileSync("git", ["remote", "add", "origin", REMOTE_URL], { cwd: REPO });
});

afterAll(() => {
  if (REPO) rmSync(REPO, { recursive: true, force: true });
});

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
    repoPaths: [REPO],
    gitBranches: [
      { repoPath: REPO, name: "feature/me/123-x", baseBranch: "master" },
    ],
    repoTestBranches: { [REPO]: "test" },
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    events: [],
    contextDocs: [],
    ...over,
  }) as unknown as Task;

const baseMr = () => ({
  kind: "submit_mr" as const,
  actionId: "act_3",
  repoPath: REPO,
  projectPath: PROJECT_PATH,
  sourceBranch: "feature/me/123-x",
  targetBranch: "test",
  title: "MR 标题",
  description: "",
  lastCommitHash: "abc1234",
});

describe("validateSubmitMr", () => {
  it("全部合法 → ok", async () => {
    const r = await validateSubmitMr(baseTask(), baseMr());
    expect(r.ok).toBe(true);
  });

  it("只读仓拒绝提 MR", async () => {
    const r = await validateSubmitMr(
      baseTask({ readonlyRepoPaths: [REPO] }),
      baseMr(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("只读仓");
  });

  it("repo_path 不在 task.repoPaths → 拒（核心越权防线）", async () => {
    const r = await validateSubmitMr(baseTask(), {
      ...baseMr(),
      repoPath: "/other/repo",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不属于本 task");
  });

  it("action_id 不是 ship / dev / custom action → 拒", async () => {
    const r = await validateSubmitMr(baseTask(), {
      ...baseMr(),
      actionId: "act_2", // build action
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ship / dev / custom action");
  });

  it("target_branch 不是该仓测试分支 → 拒（不许提 master）", async () => {
    const r = await validateSubmitMr(baseTask(), {
      ...baseMr(),
      targetBranch: "master",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("测试分支");
  });

  it("repoTestBranches 没配 → 默认 test", async () => {
    const task = baseTask({ repoTestBranches: undefined } as Partial<Task>);
    expect((await validateSubmitMr(task, baseMr())).ok).toBe(true);
    expect(
      (await validateSubmitMr(task, { ...baseMr(), targetBranch: "main" })).ok,
    ).toBe(false);
  });

  it("source_branch 必须是已记录 feature 分支或其 __conflict 变体", async () => {
    expect((await validateSubmitMr(baseTask(), baseMr())).ok).toBe(true);
    expect(
      (
        await validateSubmitMr(baseTask(), {
          ...baseMr(),
          sourceBranch: "feature/me/123-x__conflict",
        })
      ).ok,
    ).toBe(true);
    const r = await validateSubmitMr(baseTask(), {
      ...baseMr(),
      sourceBranch: "random-branch",
    });
    expect(r.ok).toBe(false);
  });

  it("gitBranches 没记录该仓 → 退化兜底：非空且 ≠ 目标分支", async () => {
    const task = baseTask({ gitBranches: [] } as Partial<Task>);
    expect(
      (await validateSubmitMr(task, { ...baseMr(), sourceBranch: "any-branch" }))
        .ok,
    ).toBe(true);
    expect(
      (await validateSubmitMr(task, { ...baseMr(), sourceBranch: "test" })).ok,
    ).toBe(false);
    expect(
      (await validateSubmitMr(task, { ...baseMr(), sourceBranch: "  " })).ok,
    ).toBe(false);
  });

  // 审查发现：旧 fail-open（derived=null 放行）可被弄坏 remote 绕过防越权闸 → 改为 fail-closed
  it("读不到该仓 remote → 拒（fail-closed，审查发现可绕过）", async () => {
    const task = baseTask({
      repoPaths: [MISSING_REPO],
      gitBranches: [
        {
          repoPath: MISSING_REPO,
          name: "feature/me/123-x",
          baseBranch: "master",
        },
      ],
      repoTestBranches: { [MISSING_REPO]: "test" },
    });
    const r = await validateSubmitMr(task, {
      ...baseMr(),
      repoPath: MISSING_REPO,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("读不到该仓 remote");
      expect(r.error).toContain("无法核对 project_path");
    }
  });

  it("project_path 跟 remote 反解不一致 → 拒", async () => {
    const r = await validateSubmitMr(baseTask(), {
      ...baseMr(),
      projectPath: "other/evil",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不一致");
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
  const devMr = () => ({
    ...baseMr(),
    actionId: "act_4",
    targetBranch: "develop",
  });

  it("dev action + target=该仓 dev 分支 → ok", async () => {
    expect((await validateSubmitMr(devTask(), devMr())).ok).toBe(true);
  });

  it("dev action + target 不是 dev 分支（如 test）→ 拒", async () => {
    const r = await validateSubmitMr(devTask(), {
      ...devMr(),
      targetBranch: "test",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("dev 分支");
  });

  it("dev action 但该仓没配 dev 分支 → 拒", async () => {
    const task = devTask({ repoDevBranches: undefined } as Partial<Task>);
    const r = await validateSubmitMr(task, devMr());
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
  const customMr = () => ({
    ...baseMr(),
    actionId: "act_5",
    targetBranch: "master",
  });

  it("custom action + target=线上分支 → ok", async () => {
    expect((await validateSubmitMr(customTask(), customMr())).ok).toBe(true);
  });

  it("custom action + target=test → ok（放开、不限分支）", async () => {
    const r = await validateSubmitMr(customTask(), {
      ...customMr(),
      targetBranch: "test",
    });
    expect(r.ok).toBe(true);
  });

  it("custom action + target=任意分支（如 release/1.2）→ ok（放开、不限分支）", async () => {
    const r = await validateSubmitMr(customTask(), {
      ...customMr(),
      targetBranch: "release/1.2",
    });
    expect(r.ok).toBe(true);
  });

  it("custom action 没配线上分支也能提（target 不再依赖 repoBaseBranches）", async () => {
    const task = customTask({ repoBaseBranches: undefined } as Partial<Task>);
    const r = await validateSubmitMr(task, {
      ...customMr(),
      targetBranch: "test",
    });
    expect(r.ok).toBe(true);
  });

  it("custom action 仍受仓范围约束（repo_path 不在 task → 拒）", async () => {
    const r = await validateSubmitMr(customTask(), {
      ...customMr(),
      repoPath: "/other/repo",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不属于本 task");
  });

  it("custom action 仍受 source 必须 feature 约束（不能拿线上分支当 source）", async () => {
    const r = await validateSubmitMr(customTask(), {
      ...customMr(),
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

  it("ssh:// 带端口", () => {
    expect(
      parseProjectPathFromRemoteUrl("ssh://git@git.corp.com:22/g/r.git"),
    ).toBe("g/r");
  });

  it("ssh:// 不带端口", () => {
    expect(
      parseProjectPathFromRemoteUrl("ssh://git@git.corp.com/g/r.git"),
    ).toBe("g/r");
  });

  it("空 / 解析不出 → null", () => {
    expect(parseProjectPathFromRemoteUrl("")).toBe(null);
  });
});
