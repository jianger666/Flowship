/**
 * 任务分支漂移守卫（用户反馈）：task 本来在目标分支，用户自己去 IDE 把仓库切到 master，
 * 回 Flowship 让 AI 改代码——AI 直接在 master 上改了、没人把它切回去。
 *
 * 根因：推进 / 唤醒 / 一次性问答都会先确认分支，但「给存活会话 send 一条消息」这条最常用的路径没人看 HEAD。
 * 修复：send 之前（输入条 / ask 答复 / 推进续接 / 定时消息）探测每个仓是否还在任务分支——
 *   - worktree / testing：硬切回（复用推进路径同一份实现），切不回来 → 拒发并说清原因
 *   - in-place：不替用户切，给 AI 附一段提醒
 *
 * 三层：
 *  1. 纯函数（collectBranchTargets / detectBranchDrift / 文案）——不碰 git
 *  2. 真 git 临时仓跑 guardTaskBranchForUserTurn 的 worktree / in-place / testing 行为
 *  3. 接线契约（源码级）：守卫必须在 agent.send / fulfillAskWait 之前、且各入口把 TaskBranchGuardError 映射成 409
 */
import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Task } from "@/lib/types";

// dataRoot 走环境变量、指到临时目录（import 被测模块前钉死）
const TMP_ROOT = path.join(os.tmpdir(), `fe-branch-guard-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import {
  buildBranchDriftNotice,
  collectBranchTargets,
  describeBranchDrift,
  detectBranchDrift,
  TaskBranchGuardError,
  type BranchDrift,
  type BranchGuardDeps,
} from "@/lib/server/task-branch-guard";
import { guardTaskBranchForUserTurn } from "@/lib/server/task-runner";
import {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  WorktreeLeaseLostError,
} from "@/lib/server/task-worktrees";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const branchOf = (dir: string): string => git(dir, "branch", "--show-current");

const initRepo = async (name: string): Promise<string> => {
  const repo = path.join(TMP_ROOT, name);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  return repo;
};

let seq = 0;
const makeTask = (patch: Partial<Task>): Task =>
  ({
    id: `t_1700000000${String(100 + seq++)}_bg`,
    mode: "task",
    title: "分支守卫",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [],
    isolateWorktree: false,
    feishuStoryUrl: "https://project.feishu.cn/x/story/detail/777777",
    actions: [],
    mrs: [],
    ...patch,
  }) as Task;

const markTaskAlive = async (taskId: string): Promise<void> => {
  await fs.mkdir(path.join(process.env.FLOWSHIP_DATA_DIR!, "tasks", taskId), {
    recursive: true,
  });
};

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

// ───────────────────────── 1. 纯函数 ─────────────────────────

describe("collectBranchTargets：每个仓『应该在哪条分支』", () => {
  it("没记录任务分支的 in-place 任务（轻量日常 / 还没 build）→ 不管", () => {
    expect(
      collectBranchTargets(makeTask({ repoPaths: ["/r/a"], feishuStoryUrl: undefined })),
    ).toEqual([]);
    expect(collectBranchTargets(makeTask({ repoPaths: ["/r/a"], gitBranches: [] }))).toEqual([]);
  });

  it("in-place：按 gitBranches 记录、workDir 就是原仓；非 git / 只读仓、不在 repoPaths 里的记录不算", () => {
    const task = makeTask({
      repoPaths: ["/r/a", "/r/ng", "/r/ro"],
      nonGitRepoPaths: ["/r/ng"],
      readonlyRepoPaths: ["/r/ro"],
      gitBranches: [
        { repoPath: "/r/a", name: "feature/x", baseBranch: "" },
        { repoPath: "/r/ng", name: "feature/x", baseBranch: "" },
        { repoPath: "/r/ro", name: "feature/x", baseBranch: "" },
        { repoPath: "/r/gone", name: "feature/x", baseBranch: "" },
      ],
    });
    expect(collectBranchTargets(task)).toEqual([
      { repoPath: "/r/a", workDir: "/r/a", branch: "feature/x", mode: "in-place" },
    ]);
  });

  it("chat 任务 / WK 主流程：分支不归这里管 → 空（WK 的 AI 会自己建 / 切业务分支，不能按旧记录硬切回）", () => {
    const base = {
      repoPaths: ["/r/a"],
      gitBranches: [{ repoPath: "/r/a", name: "feature/x", baseBranch: "" }],
    };
    expect(collectBranchTargets(makeTask({ ...base, mode: "chat" }))).toHaveLength(0);
    const wk = makeTask({
      ...base,
      actions: [
        {
          id: "a1",
          n: 1,
          type: "custom",
          customActionId: "team:wk-repo-execute",
          status: "completed",
        } as unknown as Task["actions"][number],
      ],
    });
    expect(collectBranchTargets(wk)).toHaveLength(0);
    // 对照：去掉 wk action 就恢复
    expect(collectBranchTargets(makeTask(base))).toHaveLength(1);
  });

  it("测试任务：只认填了『被测业务分支』的 git 仓（原仓目录）、不吃 gitBranches", () => {
    const task = makeTask({
      workRole: "qa",
      repoPaths: ["/r/a", "/r/b", "/r/ng"],
      nonGitRepoPaths: ["/r/ng"],
      repoFeatureBranches: { "/r/a": "feature/qa-a", "/r/ng": "feature/qa-ng" },
      gitBranches: [{ repoPath: "/r/b", name: "feature/should-not-use", baseBranch: "" }],
    });
    expect(collectBranchTargets(task)).toEqual([
      { repoPath: "/r/a", workDir: "/r/a", branch: "feature/qa-a", mode: "testing" },
    ]);
  });

  it("隔离 task：worktree 目录 + 按模板规划的任务分支；非 git 仓跳过", () => {
    const task = makeTask({
      id: "t_1700000000999_iso",
      isolateWorktree: true,
      repoPaths: ["/r/a", "/r/ng"],
      nonGitRepoPaths: ["/r/ng"],
      title: "做点事",
    });
    const targets = collectBranchTargets(task);
    expect(targets).toHaveLength(1);
    expect(targets[0].mode).toBe("worktree");
    expect(targets[0].repoPath).toBe("/r/a");
    expect(targets[0].branch).toBe("feature/777777-做点事");
    expect(targets[0].workDir).toBe(getTaskWorkRepoPaths(task)[0]);
    expect(targets[0].workDir).not.toBe("/r/a");
  });
});

describe("detectBranchDrift（注入假 git 读取）", () => {
  const task = makeTask({
    repoPaths: ["/r/a", "/r/b", "/r/c", "/r/d"],
    gitBranches: ["a", "b", "c", "d"].map((n) => ({
      repoPath: `/r/${n}`,
      name: "feature/x",
      baseBranch: "",
    })),
  });
  const deps = (
    heads: Record<string, string | null | undefined>,
    existing: Set<string> = new Set(["feature/x"]),
  ): BranchGuardDeps => ({
    readBranch: async (dir) => heads[dir.replace("/r/", "")],
    localBranchExists: async (_dir, b) => existing.has(b),
  });

  it("在任务分支 → 无漂移；在别的分支 → 报漂移并带上 actual；detached → actual=null", async () => {
    const drifts = await detectBranchDrift(
      task,
      deps({ a: "feature/x", b: "master", c: null, d: "feature/x" }),
    );
    expect(drifts.map((d) => [d.repoPath, d.actual])).toEqual([
      ["/r/b", "master"],
      ["/r/c", null],
    ]);
  });

  it("读不出来（非 git / unborn / 超时）的仓当没漂移——护栏不能因 git 偶发失败卡住发消息", async () => {
    const drifts = await detectBranchDrift(
      task,
      deps({ a: undefined, b: undefined, c: undefined, d: undefined }),
    );
    expect(drifts).toEqual([]);
  });

  it("in-place 的任务分支本地还没建出来（build 刚起跑、agent 还没按 hint 建）→ 不算漂移", async () => {
    const drifts = await detectBranchDrift(
      task,
      deps({ a: "master", b: "master", c: "master", d: "master" }, new Set()),
    );
    expect(drifts).toEqual([]);
  });
});

describe("文案", () => {
  const drift = (patch: Partial<BranchDrift> = {}): BranchDrift => ({
    repoPath: "/Users/me/code/shop-web/",
    workDir: "/Users/me/code/shop-web",
    branch: "feature/777777-登录",
    mode: "in-place",
    actual: "master",
    ...patch,
  });

  it("describeBranchDrift：一仓一句人话（仓短名 + 当前 + 任务分支）；detached 写『游离 HEAD』", () => {
    expect(describeBranchDrift(drift())).toBe(
      "shop-web 当前在「master」、任务分支是「feature/777777-登录」",
    );
    expect(describeBranchDrift(drift({ actual: null }))).toContain("游离 HEAD");
  });

  it("提醒：列出仓 / 当前分支、给 checkout + 确认命令（分支名单引号包裹）、不许 stash/reset/force、纯提问不用切", () => {
    const text = buildBranchDriftNotice([drift()]);
    expect(text).toContain("〈分支漂移〉");
    expect(text).toContain("shop-web 当前在「master」");
    expect(text).toContain("git -C '/Users/me/code/shop-web' checkout 'feature/777777-登录'");
    expect(text).toContain("branch --show-current");
    expect(text).toMatch(/不要\*\* stash \/ reset \/ force/);
    expect(text).toContain("ask_user");
    expect(text).toContain("只是提问");
  });

  it("分支名没过白名单的仓不进提醒（名字会进 shell 命令）；全不合法 → 空串", () => {
    expect(buildBranchDriftNotice([drift({ branch: "-rf; rm -x" })])).toBe("");
    const text = buildBranchDriftNotice([
      drift({ branch: "a b" }),
      drift({ repoPath: "/r/ok", workDir: "/r/ok", branch: "feature/ok" }),
    ]);
    expect(text).toContain("feature/ok");
    expect(text).not.toContain("a b");
  });

  it("工作目录路径里有单引号 → shell 转义不被破坏", () => {
    const text = buildBranchDriftNotice([drift({ workDir: "/r/it's" })]);
    expect(text).toContain(`git -C '/r/it'\\''s' checkout`);
  });
});

// ───────────────────────── 2. 真 git ─────────────────────────

describe("guardTaskBranchForUserTurn（真 git）", () => {
  describe("隔离 worktree 任务：硬切回", () => {
    let repo: string;
    let task: Task;
    let workDir: string;
    let taskBranch: string;

    beforeAll(async () => {
      repo = await initRepo("wt-repo");
      task = makeTask({
        isolateWorktree: true,
        repoPaths: [repo],
        repoBaseBranches: { [repo]: "main" },
        title: "改登录",
      });
      await markTaskAlive(task.id);
      const ensured = await ensureTaskWorktrees(task, () => true);
      taskBranch = ensured.infos[0].name;
      workDir = getTaskWorkRepoPaths(task)[0];
      // 旁路分支：main 被原仓占着，worktree 切不过去，用 side 模拟用户切走（IDE 里切到别的分支）
      git(repo, "branch", "side-detour", "main");
    });

    it("没漂移 → 放行、不动 HEAD、无提醒", async () => {
      expect(branchOf(workDir)).toBe(taskBranch);
      await expect(guardTaskBranchForUserTurn(task, () => true)).resolves.toBeUndefined();
      expect(branchOf(workDir)).toBe(taskBranch);
    });

    it("用户在 IDE 里把 worktree 切到别的分支 → 发消息前自动切回任务分支（核心回归）", async () => {
      git(workDir, "checkout", "side-detour");
      expect(branchOf(workDir)).toBe("side-detour");
      await expect(guardTaskBranchForUserTurn(task, () => true)).resolves.toBeUndefined();
      expect(branchOf(workDir)).toBe(taskBranch);
    });

    it("detached HEAD 同样切回", async () => {
      git(workDir, "checkout", "--detach");
      expect(branchOf(workDir)).toBe("");
      await guardTaskBranchForUserTurn(task, () => true);
      expect(branchOf(workDir)).toBe(taskBranch);
    });

    it("失主（stop / 重发抢占）→ 抛 WorktreeLeaseLostError、HEAD 不动", async () => {
      git(workDir, "checkout", "side-detour");
      await expect(guardTaskBranchForUserTurn(task, () => false)).rejects.toBeInstanceOf(
        WorktreeLeaseLostError,
      );
      expect(branchOf(workDir)).toBe("side-detour");
      // 复位给后面的用例
      await guardTaskBranchForUserTurn(task, () => true);
      expect(branchOf(workDir)).toBe(taskBranch);
    });

    it("切不回来（目标分支与当前分支在同一文件上冲突、工作区有未提交改动）→ 拒发：TaskBranchGuardError 说清原因与处置、不动用户现场", async () => {
      // side 分支改 a.txt；回到 side 后再在工作区改 a.txt（未提交）→ 切回任务分支会覆盖未提交改动、git 拒绝
      git(workDir, "checkout", "side-detour");
      await fs.writeFile(path.join(workDir, "a.txt"), "side commit\n");
      git(workDir, "commit", "-am", "side change");
      await fs.writeFile(path.join(workDir, "a.txt"), "uncommitted work\n");

      const err = await guardTaskBranchForUserTurn(task, () => true).catch((e) => e);
      expect(err).toBeInstanceOf(TaskBranchGuardError);
      const msg = (err as Error).message;
      expect(msg).toContain("自动切回失败");
      expect(msg).toContain("side-detour");
      expect(msg).toContain(taskBranch);
      expect(msg).toContain("没有送给 AI");
      // 不含「正在跑 / 等它说完」——排队重放按这两个词判 busy 会无限放回
      expect(msg).not.toMatch(/正在跑|等它说完/);
      // fail-closed：没动用户的未提交改动、HEAD 还在 side
      expect(branchOf(workDir)).toBe("side-detour");
      expect(await fs.readFile(path.join(workDir, "a.txt"), "utf8")).toBe("uncommitted work\n");
    });
  });

  describe("in-place（原仓直跑）：只提醒、不替用户切", () => {
    it("原仓被切到 master（任务分支本地存在）→ 返回提醒、HEAD 保持在 master", async () => {
      const repo = await initRepo("ip-repo");
      git(repo, "branch", "feature/ip");
      const task = makeTask({
        repoPaths: [repo],
        gitBranches: [{ repoPath: repo, name: "feature/ip", baseBranch: "main" }],
      });
      await markTaskAlive(task.id);

      const notice = await guardTaskBranchForUserTurn(task, () => true);
      expect(notice).toContain("〈分支漂移〉");
      expect(notice).toContain("feature/ip");
      expect(notice).toContain(`git -C '${repo}' checkout 'feature/ip'`);
      // 没替用户切
      expect(branchOf(repo)).toBe("main");
    });

    it("已经在任务分支 → 无提醒", async () => {
      const repo = await initRepo("ip-repo-ok");
      git(repo, "checkout", "-b", "feature/ok");
      const task = makeTask({
        repoPaths: [repo],
        gitBranches: [{ repoPath: repo, name: "feature/ok", baseBranch: "main" }],
      });
      await expect(guardTaskBranchForUserTurn(task, () => true)).resolves.toBeUndefined();
    });

    it("任务分支还没建出来（build 刚起跑）→ 无提醒", async () => {
      const repo = await initRepo("ip-repo-nobranch");
      const task = makeTask({
        repoPaths: [repo],
        gitBranches: [{ repoPath: repo, name: "feature/not-yet", baseBranch: "main" }],
      });
      await expect(guardTaskBranchForUserTurn(task, () => true)).resolves.toBeUndefined();
    });
  });

  describe("测试任务：沿用 prepareTestingTaskBranches 硬切回", () => {
    it("原仓被切走 → 自动切回被测业务分支", async () => {
      const repo = await initRepo("qa-repo");
      git(repo, "branch", "feature/under-test");
      const task = makeTask({
        workRole: "qa",
        repoPaths: [repo],
        repoFeatureBranches: { [repo]: "feature/under-test" },
      });
      await markTaskAlive(task.id);
      expect(branchOf(repo)).toBe("main");

      await expect(guardTaskBranchForUserTurn(task, () => true)).resolves.toBeUndefined();
      expect(branchOf(repo)).toBe("feature/under-test");
    });

    it("原仓有未提交改动 → 拒切、拒发（不覆盖用户现场）", async () => {
      const repo = await initRepo("qa-repo-dirty");
      git(repo, "branch", "feature/under-test");
      await fs.writeFile(path.join(repo, "a.txt"), "dirty\n");
      const task = makeTask({
        workRole: "qa",
        repoPaths: [repo],
        repoFeatureBranches: { [repo]: "feature/under-test" },
      });
      await markTaskAlive(task.id);

      await expect(guardTaskBranchForUserTurn(task, () => true)).rejects.toBeInstanceOf(
        TaskBranchGuardError,
      );
      expect(branchOf(repo)).toBe("main");
      expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe("dirty\n");
    });
  });
});

// ───────────────────────── 3. 接线契约 ─────────────────────────

const src = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

describe("接线契约：守卫必须在『消息真正送给 AI』之前", () => {
  const runner = src("src/lib/server/task-runner.ts");

  it("sendToTaskSessionBody：存活会话（非本轮 resume、非非属主轮）送之前守；顺序在登记非属主标记与 agent.send 之前", () => {
    const body = runner.slice(runner.indexOf("const sendToTaskSessionBody = async"));
    const iGuard = body.indexOf("guardTaskBranchForUserTurn(");
    const iNonOwner = body.indexOf("beginNonOwnerTurn(task.id)");
    const iSend = body.indexOf("agent.send(sendText");
    expect(iGuard).toBeGreaterThan(0);
    expect(iGuard).toBeLessThan(iNonOwner);
    expect(iNonOwner).toBeLessThan(iSend);
    // 条件：resume 刚 ensure 过 / 非属主轮 / 调用方已守过 都不重复守
    expect(body).toMatch(
      /!resumedThisCall\s*&&\s*!opts\.nonOwnerTurn\s*&&\s*!opts\.skipBranchGuard/,
    );
    // 失主让位成 stale；提醒附在末尾而不是替换原文
    expect(body).toMatch(/err instanceof WorktreeLeaseLostError\) return "stale"/);
    expect(body).toContain("`${text}\\n\\n${branchNotice}`");
  });

  it("ask-reply 路由：curl 路径（fulfillAskWait）之前守；失败放回答案登记并返 409 + 固定 code；deliver 不再重复守", () => {
    const route = src("src/app/api/tasks/[id]/ask-reply/route.ts");
    const iGuard = route.indexOf("guardTaskBranchForUserTurn(");
    const iWait = route.indexOf("fulfillAskWait(task.id, askId, liveAgentText)");
    expect(iGuard).toBeGreaterThan(0);
    expect(iGuard).toBeLessThan(iWait);
    expect(route).toContain("err instanceof TaskBranchGuardError");
    expect(route).toContain("TASK_BRANCH_GUARD_CODE");
    // 失败分支里先 giveBackPending 再返回
    const catchBlock = route.slice(
      route.indexOf("// 没送出去：答案登记放回"),
      route.indexOf("// 同一轮 curl 已挂上"),
    );
    expect(catchBlock).toContain("giveBackPending()");
    expect(route).toMatch(/liveAgentText,\s*allAbsPaths[\s\S]{0,200}branchGuarded,/);
    // chat 没有任务分支、不守
    expect(route).toMatch(/if \(!isChat\) \{\s*try \{\s*const notice = await guardTaskBranchForUserTurn/);
  });

  it("question 注入：隐式跳过（curl 路径）之前守；deliver 抛 TaskBranchGuardError → 409 + code；已守不重复守", () => {
    const inject = src("src/lib/server/task-question-inject.ts");
    const iGuard = inject.indexOf("guardTaskBranchForUserTurn(");
    const iWait = inject.indexOf("fulfillAskSkipViaWait(task.id, askSkip, liveAgentText");
    expect(iGuard).toBeGreaterThan(0);
    expect(iGuard).toBeLessThan(iWait);
    // 只在认领了待答提问（curl 可能还挂着）时才在注入层守；其余走 sendToTaskSession 里那道
    expect(inject).toMatch(
      /if \(askSkip\?\.claimed\) \{\s*try \{\s*const notice = await guardTaskBranchForUserTurn\(/,
    );
    expect(inject).toMatch(
      /if \(err instanceof TaskBranchGuardError\) \{\s*return errorResponse\(err\.message, 409, \{ code: TASK_BRANCH_GUARD_CODE \}\);/,
    );
    expect(inject).toMatch(/liveAgentText,\s*imageAbsPaths/);
    expect(inject).toMatch(/branchGuarded,\s*\),/);
  });
});
