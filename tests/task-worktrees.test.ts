/**
 * 任务隔离工作区（V0.10）纯函数单测
 *
 * 只测不碰 git / fs 的部分：隔离判定、原仓库 ↔ worktree 路径双向映射、
 * 分支规划（含 storyId 兜底）、目录短名去重。路径映射错 = agent cwd 错 /
 * submit_mr 校验误拦 / artifact 链接全断、是本特性的正确性基本盘。
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Task } from "@/lib/types";

// dataRoot 读环境变量、先钉死再 import 被测模块（模块内是调用时求值、这里保险起见前置）
const DATA = "/tmp/fe-ai-flow-test-data";
beforeAll(() => {
  process.env.FE_AI_FLOW_DATA_DIR = DATA;
});
process.env.FE_AI_FLOW_DATA_DIR = DATA;

import {
  getTaskCwd,
  getTaskWorkRepoPaths,
  isWorktreeTask,
  parseMainGitDirFromPointer,
  planWorktreeBranchInfos,
  resolveOriginalRepoPath,
} from "@/lib/server/task-worktrees";
import { getUniqueRepoDirNames } from "@/lib/path-utils";
import { extractFeishuStoryId } from "@/lib/branch-template";

const baseTask = (patch: Partial<Task> = {}): Task =>
  ({
    id: "t_1700000000000_abc123",
    mode: "task",
    title: "测试需求",
    role: "fe",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: ["/Users/me/work/crm-web"],
    isolateWorktree: true,
    actions: [],
    mrs: [],
    ...patch,
  }) as Task;

describe("isWorktreeTask 隔离判定", () => {
  it("task 模式 + isolateWorktree=true + 有仓 → 隔离", () => {
    expect(isWorktreeTask(baseTask())).toBe(true);
  });

  it("chat 模式 / 逃生口 false / 老 task undefined / 无仓 → 不隔离", () => {
    expect(isWorktreeTask(baseTask({ mode: "chat" }))).toBe(false);
    expect(isWorktreeTask(baseTask({ isolateWorktree: false }))).toBe(false);
    expect(isWorktreeTask(baseTask({ isolateWorktree: undefined }))).toBe(false);
    expect(isWorktreeTask(baseTask({ repoPaths: [] }))).toBe(false);
  });
});

describe("getTaskWorkRepoPaths / getTaskCwd 路径映射", () => {
  it("非隔离 task 原样透传（V0.9 行为不变）", () => {
    const t = baseTask({ isolateWorktree: false });
    expect(getTaskWorkRepoPaths(t)).toEqual(["/Users/me/work/crm-web"]);
    expect(getTaskCwd(t)).toBe("/Users/me/work/crm-web");
  });

  it("单仓隔离：work path = worktrees/<taskId>/<仓短名>、cwd = 该 worktree", () => {
    const t = baseTask();
    const expected = `${DATA}/worktrees/${t.id}/crm-web`;
    expect(getTaskWorkRepoPaths(t)).toEqual([expected]);
    expect(getTaskCwd(t)).toBe(expected);
  });

  it("多仓隔离：cwd = worktrees/<taskId>（公共父目录）、顺序跟 repoPaths 对齐", () => {
    const t = baseTask({
      repoPaths: ["/Users/me/work/crm-web", "/Users/me/work/crm-api"],
    });
    expect(getTaskWorkRepoPaths(t)).toEqual([
      `${DATA}/worktrees/${t.id}/crm-web`,
      `${DATA}/worktrees/${t.id}/crm-api`,
    ]);
    expect(getTaskCwd(t)).toBe(`${DATA}/worktrees/${t.id}`);
  });

  it("同名末段仓（/a/client + /b/client）短名追加序号去重", () => {
    const t = baseTask({ repoPaths: ["/a/client", "/b/client"] });
    expect(getTaskWorkRepoPaths(t)).toEqual([
      `${DATA}/worktrees/${t.id}/client`,
      `${DATA}/worktrees/${t.id}/client-2`,
    ]);
  });
});

describe("resolveOriginalRepoPath 反向归一（submit_mr 用）", () => {
  const t = baseTask({
    repoPaths: ["/Users/me/work/crm-web", "/Users/me/work/crm-api"],
  });

  it("agent 上报 worktree 路径 → 归一回原仓库路径（含尾斜杠容错）", () => {
    const wt = `${DATA}/worktrees/${t.id}/crm-api`;
    expect(resolveOriginalRepoPath(t, wt)).toBe("/Users/me/work/crm-api");
    expect(resolveOriginalRepoPath(t, `${wt}/`)).toBe("/Users/me/work/crm-api");
  });

  it("上报的已是原仓库路径 / 未知路径 → 原样返回（交下游校验兜底）", () => {
    expect(resolveOriginalRepoPath(t, "/Users/me/work/crm-web")).toBe(
      "/Users/me/work/crm-web",
    );
    expect(resolveOriginalRepoPath(t, "/some/other/repo")).toBe(
      "/some/other/repo",
    );
  });

  it("非隔离 task 恒原样返回", () => {
    const plain = baseTask({ isolateWorktree: false });
    expect(resolveOriginalRepoPath(plain, "/whatever")).toBe("/whatever");
  });
});

describe("planWorktreeBranchInfos 分支规划", () => {
  it("按模板渲染（storyId 从飞书 URL 抠）、已有 gitBranches 条目原样复用", () => {
    const t = baseTask({
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/6956910305",
    });
    const infos = planWorktreeBranchInfos(t, "clj");
    expect(infos).toHaveLength(1);
    expect(infos[0].name).toBe("feature/clj/6956910305-测试需求");

    // 已有记录（返工场景）→ 不重算、保 createdAt / baseBranch 历史值
    const existing = { ...infos[0], name: "feature/manual", baseBranch: "master" };
    const again = planWorktreeBranchInfos(
      baseTask({ ...t, gitBranches: [existing] }),
      "clj",
    );
    expect(again[0]).toEqual(existing);
  });

  it("用户指定「已有工作分支」优先于模板", () => {
    const t = baseTask({
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/123456",
      repoFeatureBranches: { "/Users/me/work/crm-web": "feature/mine" },
    });
    expect(planWorktreeBranchInfos(t, "clj")[0].name).toBe("feature/mine");
  });

  it("无飞书 URL（抠不到 storyId）兜底用 task id 时间戳段、分支名仍合法非空", () => {
    const infos = planWorktreeBranchInfos(baseTask(), "clj");
    expect(infos[0].name).toBe("feature/clj/1700000000000-测试需求");
  });
});

describe("getUniqueRepoDirNames / extractFeishuStoryId 基础件", () => {
  it("短名去重：重名追加 -2 / -3、顺序确定", () => {
    expect(getUniqueRepoDirNames(["/a/web", "/b/web", "/c/web"])).toEqual([
      "web",
      "web-2",
      "web-3",
    ]);
    expect(getUniqueRepoDirNames(["C:\\work\\app"])).toEqual(["app"]);
  });

  it("去重后缀跟真实目录名撞车时继续探重（不产出重名）", () => {
    // 旧实现产出 [web, web-2, web-2]——两仓映射同一 worktree 目录、静默错绑
    expect(getUniqueRepoDirNames(["/a/web", "/b/web", "/c/web-2"])).toEqual([
      "web",
      "web-2",
      "web-2-2",
    ]);
    expect(getUniqueRepoDirNames(["/c/web-2", "/a/web", "/b/web"])).toEqual([
      "web-2",
      "web",
      "web-3",
    ]);
  });

  it("storyId：detail 段优先、长数字兜底、抠不到返 null", () => {
    expect(
      extractFeishuStoryId("https://project.feishu.cn/x/story/detail/695691"),
    ).toBe("695691");
    expect(extractFeishuStoryId("https://x.cn/?id=12345678")).toBe("12345678");
    expect(extractFeishuStoryId("https://x.cn/abc")).toBeNull();
    expect(extractFeishuStoryId(undefined)).toBeNull();
  });
});

describe("parseMainGitDirFromPointer（worktree .git 指针 → 主仓 git dir）", () => {
  it("mac/linux 正斜杠", () => {
    expect(
      parseMainGitDirFromPointer("gitdir: /Users/me/repo/.git/worktrees/t1\n"),
    ).toBe("/Users/me/repo/.git");
  });

  it("Windows：git 写正斜杠盘符路径也能解（不能用 path.sep 匹配的原因）", () => {
    expect(
      parseMainGitDirFromPointer("gitdir: C:/work/repo/.git/worktrees/t1"),
    ).toBe("C:/work/repo/.git");
    expect(
      parseMainGitDirFromPointer("gitdir: C:\\work\\repo\\.git\\worktrees\\t1"),
    ).toBe("C:\\work\\repo\\.git");
  });

  it("仓路径里恰好含 worktrees 字样不误切（$ 锚定最后一段）", () => {
    expect(
      parseMainGitDirFromPointer("gitdir: /a/worktrees/.git/worktrees/x"),
    ).toBe("/a/worktrees/.git");
  });

  it("解析不了返 null", () => {
    expect(parseMainGitDirFromPointer("not a pointer")).toBeNull();
    expect(parseMainGitDirFromPointer("gitdir: /plain/repo/.git")).toBeNull();
  });
});
