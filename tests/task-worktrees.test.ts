/**
 * 任务隔离工作区（V0.10）纯函数单测
 *
 * 只测不碰 git / fs 写操作的部分：隔离判定、原仓库 ↔ worktree 路径双向映射、
 * 分支规划（含 storyId 兜底）、目录短名去重。路径映射错 = agent cwd 错 /
 * submit_mr 校验误拦 / artifact 链接全断、是本特性的正确性基本盘。
 *
 * 混合隔离读 nonGitRepoPaths 快照分流（不再运行时 existsSync）——测试里显式塞快照。
 * isGitRepoPath 仅保留给建 / 编辑任务算快照用、仍用临时目录 + 手造 .git 标记测。
 */
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Task } from "@/lib/types";

// dataRoot 读环境变量、先钉死再 import 被测模块（模块内是调用时求值、这里保险起见前置）
const DATA = "/tmp/fe-ai-flow-test-data";
beforeAll(() => {
  process.env.FE_AI_FLOW_DATA_DIR = DATA;
});
process.env.FE_AI_FLOW_DATA_DIR = DATA;

// fixture：git 仓 = 带 .git 子目录的临时目录；非 git = 裸目录（算快照用）
const FIXTURE = path.join(os.tmpdir(), `fe-wt-unit-${process.pid}`);
const REPO_WEB = path.join(FIXTURE, "work", "crm-web");
const REPO_API = path.join(FIXTURE, "work", "crm-api");
const REPO_CLIENT_A = path.join(FIXTURE, "a", "client");
const REPO_CLIENT_B = path.join(FIXTURE, "b", "client");
// 非 git 纯脚本目录（测试团队挂脚本库场景）——故意放在不同父目录下、验证 cwd 不漂到公共祖先
const SCRIPTS_DIR = path.join(FIXTURE, "scripts-elsewhere", "qa-scripts");
for (const repo of [REPO_WEB, REPO_API, REPO_CLIENT_A, REPO_CLIENT_B]) {
  mkdirSync(path.join(repo, ".git"), { recursive: true });
}
mkdirSync(SCRIPTS_DIR, { recursive: true });

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
});

import {
  getTaskCwd,
  getTaskWorkRepoPaths,
  isGitRepoPath,
  isWorktreeTask,
  parseMainGitDirFromPointer,
  parseOccupyingWorktreePath,
  planWorktreeBranchInfos,
  resolveOriginalRepoPath,
} from "@/lib/server/task-worktrees";
import {
  formatRepoSectionForPrompt,
  getRepoWorkDirs,
  getUniqueRepoDirNames,
} from "@/lib/path-utils";
import { extractFeishuStoryId } from "@/lib/branch-template";

const baseTask = (patch: Partial<Task> = {}): Task =>
  ({
    id: "t_1700000000000_abc123",
    mode: "task",
    title: "测试需求",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [REPO_WEB],
    isolateWorktree: true,
    actions: [],
    mrs: [],
    ...patch,
  }) as Task;

/** 混合仓快捷构造：显式带 nonGitRepoPaths 快照（运行时映射读这份） */
const mixedTask = (
  gitRepos: string[],
  nonGitRepos: string[],
  patch: Partial<Task> = {},
): Task =>
  baseTask({
    repoPaths: [...gitRepos, ...nonGitRepos],
    nonGitRepoPaths: nonGitRepos,
    ...patch,
  });

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

describe("isGitRepoPath 判定（仅建 / 编辑任务算快照用）", () => {
  it("带 .git 的目录 = git 仓、裸目录 / 不存在的路径 = 非 git", () => {
    expect(isGitRepoPath(REPO_WEB)).toBe(true);
    expect(isGitRepoPath(SCRIPTS_DIR)).toBe(false);
    expect(isGitRepoPath("/no/such/path")).toBe(false);
  });
});

describe("getTaskWorkRepoPaths / getTaskCwd 路径映射", () => {
  it("非隔离 task 原样透传（V0.9 行为不变）", () => {
    const t = baseTask({ isolateWorktree: false });
    expect(getTaskWorkRepoPaths(t)).toEqual([REPO_WEB]);
    expect(getTaskCwd(t)).toBe(REPO_WEB);
  });

  it("单仓隔离：work path = worktrees/<taskId>/<仓短名>、cwd = 该 worktree", () => {
    const t = baseTask();
    const expected = `${DATA}/worktrees/${t.id}/crm-web`;
    expect(getTaskWorkRepoPaths(t)).toEqual([expected]);
    expect(getTaskCwd(t)).toBe(expected);
  });

  it("多仓隔离：cwd = worktrees/<taskId>（公共父目录）、顺序跟 repoPaths 对齐", () => {
    const t = baseTask({ repoPaths: [REPO_WEB, REPO_API] });
    expect(getTaskWorkRepoPaths(t)).toEqual([
      `${DATA}/worktrees/${t.id}/crm-web`,
      `${DATA}/worktrees/${t.id}/crm-api`,
    ]);
    expect(getTaskCwd(t)).toBe(`${DATA}/worktrees/${t.id}`);
  });

  it("同名末段仓（a/client + b/client）短名追加序号去重", () => {
    const t = baseTask({ repoPaths: [REPO_CLIENT_A, REPO_CLIENT_B] });
    expect(getTaskWorkRepoPaths(t)).toEqual([
      `${DATA}/worktrees/${t.id}/client`,
      `${DATA}/worktrees/${t.id}/client-2`,
    ]);
  });

  it("混合隔离：git 仓映射 worktree、非 git 目录原地、index 对齐", () => {
    const t = mixedTask([REPO_WEB], [SCRIPTS_DIR]);
    expect(getTaskWorkRepoPaths(t)).toEqual([
      `${DATA}/worktrees/${t.id}/crm-web`,
      SCRIPTS_DIR, // 非 git 原样返回、脚本库没有分支概念不需要隔离
    ]);
  });

  it("混合 1 git + 非 git：cwd = 该 git worktree 自身（非 git 不参与聚合、不漂到公共祖先）", () => {
    const t = mixedTask([REPO_WEB], [SCRIPTS_DIR]);
    const wt = `${DATA}/worktrees/${t.id}/crm-web`;
    expect(getTaskCwd(t)).toBe(wt);
    // 旧实现会对 [worktree, scripts] 做公共父 → 落到 FIXTURE 甚至更高、必错
    expect(getTaskCwd(t)).not.toBe(FIXTURE);
  });

  it("混合多 git + 非 git：cwd = worktrees/<taskId> 容器", () => {
    const t = mixedTask([REPO_WEB, REPO_API], [SCRIPTS_DIR]);
    expect(getTaskCwd(t)).toBe(`${DATA}/worktrees/${t.id}`);
  });

  it("全仓非 git 的隔离 task：路径全部原地、cwd = 原路径公共父", () => {
    const t = baseTask({
      repoPaths: [SCRIPTS_DIR],
      nonGitRepoPaths: [SCRIPTS_DIR],
    });
    expect(getTaskWorkRepoPaths(t)).toEqual([SCRIPTS_DIR]);
    expect(getTaskCwd(t)).toBe(SCRIPTS_DIR);
  });

  it("老任务 nonGitRepoPaths=undefined → 按全 git 映射（不迁移兜底）", () => {
    const t = baseTask({
      repoPaths: [REPO_WEB, SCRIPTS_DIR],
      nonGitRepoPaths: undefined,
    });
    // 无快照时 SCRIPTS_DIR 也被当 git、映射进 worktree（老任务本就不会挂非 git）
    expect(getTaskWorkRepoPaths(t)[1]).toContain(`/worktrees/${t.id}/`);
  });

  it("只读仓不进 worktree：映射原地、cwd 只聚合可隔离仓", () => {
    const t = baseTask({
      repoPaths: [REPO_WEB, REPO_API],
      readonlyRepoPaths: [REPO_API],
    });
    expect(getTaskWorkRepoPaths(t)).toEqual([
      `${DATA}/worktrees/${t.id}/crm-web`,
      REPO_API, // 只读仓原地
    ]);
    // cwd 只对可隔离仓聚合 → 单仓 worktree 自身（不漂到公共祖先）
    expect(getTaskCwd(t)).toBe(`${DATA}/worktrees/${t.id}/crm-web`);
  });

  it("全仓只读的隔离 task：路径全部原地、cwd = 原路径公共父", () => {
    const t = baseTask({
      repoPaths: [REPO_WEB, REPO_API],
      readonlyRepoPaths: [REPO_WEB, REPO_API],
    });
    expect(getTaskWorkRepoPaths(t)).toEqual([REPO_WEB, REPO_API]);
    // 两仓都在 FIXTURE/work/ 下 → 公共父 = .../work
    expect(getTaskCwd(t)).toBe(path.join(FIXTURE, "work"));
  });
});

describe("resolveOriginalRepoPath 反向归一（submit_mr 用）", () => {
  const t = baseTask({ repoPaths: [REPO_WEB, REPO_API] });

  it("agent 上报 worktree 路径 → 归一回原仓库路径（含尾斜杠容错）", () => {
    const wt = `${DATA}/worktrees/${t.id}/crm-api`;
    expect(resolveOriginalRepoPath(t, wt)).toBe(REPO_API);
    expect(resolveOriginalRepoPath(t, `${wt}/`)).toBe(REPO_API);
  });

  it("上报的已是原仓库路径 / 未知路径 → 原样返回（交下游校验兜底）", () => {
    expect(resolveOriginalRepoPath(t, REPO_WEB)).toBe(REPO_WEB);
    expect(resolveOriginalRepoPath(t, "/some/other/repo")).toBe(
      "/some/other/repo",
    );
  });

  it("混合隔离：非 git 目录 workPath = 原路径、归一恒等成立", () => {
    const mixed = mixedTask([REPO_WEB], [SCRIPTS_DIR]);
    expect(resolveOriginalRepoPath(mixed, SCRIPTS_DIR)).toBe(SCRIPTS_DIR);
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
    const infos = planWorktreeBranchInfos(t);
    expect(infos).toHaveLength(1);
    expect(infos[0].name).toBe("feature/6956910305-测试需求");

    // 已有记录（返工场景）→ 不重算、保 createdAt / baseBranch 历史值
    const existing = { ...infos[0], name: "feature/manual", baseBranch: "master" };
    const again = planWorktreeBranchInfos(
      baseTask({ ...t, gitBranches: [existing] }),
    );
    expect(again[0]).toEqual(existing);
  });

  it("用户指定「已有工作分支」优先于模板", () => {
    const t = baseTask({
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/123456",
      repoFeatureBranches: { [REPO_WEB]: "feature/mine" },
    });
    expect(planWorktreeBranchInfos(t)[0].name).toBe("feature/mine");
  });

  it("无飞书 URL（抠不到 storyId）兜底用 task id 时间戳段、分支名仍合法非空", () => {
    const infos = planWorktreeBranchInfos(baseTask());
    expect(infos[0].name).toBe("feature/1700000000000-测试需求");
  });

  it("混合隔离：只给 git 仓造分支记录、非 git 目录不进 gitBranches", () => {
    const t = mixedTask([REPO_WEB], [SCRIPTS_DIR]);
    const infos = planWorktreeBranchInfos(t);
    expect(infos).toHaveLength(1);
    expect(infos[0].repoPath).toBe(REPO_WEB);
  });

  it("只读仓不进 gitBranches（与非 git 同款跳过）", () => {
    const t = baseTask({
      repoPaths: [REPO_WEB, REPO_API],
      readonlyRepoPaths: [REPO_API],
    });
    const infos = planWorktreeBranchInfos(t);
    expect(infos).toHaveLength(1);
    expect(infos[0].repoPath).toBe(REPO_WEB);
  });
});

describe("getUniqueRepoDirNames / getRepoWorkDirs / formatRepoSection / storyId", () => {
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

  it("getRepoWorkDirs：多仓给各自项目根、绝不给公共父目录（IDE 打开用）", () => {
    // 非隔离多仓：workCwd 是公共父（D:/IdeaProjects）、必须逐仓返原仓路径
    expect(
      getRepoWorkDirs(
        ["D:\\IdeaProjects\\tch-studio", "D:\\IdeaProjects\\stu-center"],
        "D:/IdeaProjects",
        false,
      ).map((t) => t.workDir),
    ).toEqual(["D:/IdeaProjects/tch-studio", "D:/IdeaProjects/stu-center"]);
    // 隔离多仓：worktree 容器下的每仓子目录
    expect(
      getRepoWorkDirs(["/a/web", "/b/web"], "/data/worktrees/t1", true).map(
        (t) => t.workDir,
      ),
    ).toEqual(["/data/worktrees/t1/web", "/data/worktrees/t1/web-2"]);
    // 单仓：workCwd 自身（隔离 = worktree、非隔离 = 原仓）
    expect(
      getRepoWorkDirs(["/a/web"], "/data/worktrees/t1/web", true)[0].workDir,
    ).toBe("/data/worktrees/t1/web");
  });

  it("getRepoWorkDirs 混合：非 git 用原路径、唯一 git 仓用 workCwd 自身", () => {
    const dirs = getRepoWorkDirs(
      ["/repos/crm-web", "/scripts/qa"],
      "/data/worktrees/t1/crm-web",
      true,
      ["/scripts/qa"],
    );
    expect(dirs.map((d) => d.workDir)).toEqual([
      "/data/worktrees/t1/crm-web",
      "/scripts/qa",
    ]);
  });

  it("getRepoWorkDirs 混合多 git：git 拼容器下短名、非 git 原路径", () => {
    const dirs = getRepoWorkDirs(
      ["/repos/web", "/repos/api", "/scripts/qa"],
      "/data/worktrees/t1",
      true,
      ["/scripts/qa"],
    );
    expect(dirs.map((d) => d.workDir)).toEqual([
      "/data/worktrees/t1/web",
      "/data/worktrees/t1/api",
      "/scripts/qa",
    ]);
  });

  it("getRepoWorkDirs 只读仓用原路径、可写仓走 worktree", () => {
    const dirs = getRepoWorkDirs(
      ["/repos/web", "/repos/api"],
      "/data/worktrees/t1/web",
      true,
      undefined,
      ["/repos/api"],
    );
    expect(dirs.map((d) => d.workDir)).toEqual([
      "/data/worktrees/t1/web",
      "/repos/api",
    ]);
  });

  it("formatRepoSectionForPrompt 混合：标注种类、用传入 agentCwd、不说『下挂 N 个 git』", () => {
    const text = formatRepoSectionForPrompt(
      ["/data/wt/crm-web", "/scripts/qa"],
      {
        agentCwd: "/data/wt/crm-web",
        nonGitRepoPaths: ["/scripts/qa"],
        originalRepoPaths: ["/repos/crm-web", "/scripts/qa"],
      },
    );
    expect(text).toContain("agent cwd");
    expect(text).toContain("/data/wt/crm-web");
    // 标注是中性的「git 仓库」——chat / 非隔离任务也走混合模板、不能写死「隔离」
    expect(text).toContain("（git 仓库）");
    expect(text).toContain("非 git 目录");
    expect(text).not.toContain("下挂");
    expect(text).not.toContain("公共父目录");
  });

  it("formatRepoSectionForPrompt 纯多 git：现状模板保留", () => {
    const text = formatRepoSectionForPrompt(["/a/web", "/a/api"]);
    expect(text).toContain("下挂 2 个 git 仓库子目录");
    expect(text).toContain("公共父目录");
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

describe("parseOccupyingWorktreePath（git worktree add 占用路径）", () => {
  it("旧文案 already checked out at", () => {
    expect(
      parseOccupyingWorktreePath(
        "fatal: 'feature/x' is already checked out at '/data/worktrees/t1/crm-web'",
      ),
    ).toBe("/data/worktrees/t1/crm-web");
  });

  it("新文案 already used by worktree at", () => {
    expect(
      parseOccupyingWorktreePath(
        "fatal: 'feature/x' is already used by worktree at '/data/worktrees/t_old/repo'",
      ),
    ).toBe("/data/worktrees/t_old/repo");
  });

  it("无占用路径文案 → null", () => {
    expect(parseOccupyingWorktreePath("fatal: invalid reference")).toBeNull();
  });
});
