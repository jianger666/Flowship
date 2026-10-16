/**
 * F5-04：prewarm 路径不同步跑「依赖初始化命令」。
 *
 * setupCommand 最长可跑 15 分钟，而 prewarmTaskWorkspace 全程握着 runAdvanceExclusive——
 * 命令若在预热里同步跑，「建完任务立刻推进」会被卡满一个超时。预热只做秒级克隆 + 建 worktree，
 * 命令留给推进启动后的后台补齐（cloneMissingTaskDepDirs）。
 *
 * 真 git 仓 + 真 prewarmTaskWorkspace：用一条会挂 60 秒的命令当探针——
 * 预热若仍同步跑它，下面轮询「预热完成 info」会超时（红）；跳过则几秒内完成（绿）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-prewarm-skip-setup-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({
    servers,
    dropped: [],
  }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));
vi.mock("@/lib/server/update-pending", () => ({
  assertNoUpdatePendingRestart: async () => {},
}));

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { clearResourceJobs, clearTaskStarting } = await import(
  "@/lib/server/task-stream"
);
const { prewarmTaskWorkspace } = await import("@/lib/server/task-runner");
const { listTasks } = await import("@/lib/server/task-fs");
const { cloneMissingTaskDepDirs, getTaskWorkRepoPaths } = await import(
  "@/lib/server/task-worktrees"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}
await listTasks();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );

const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "f504@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "f504"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const makeMeta = (id: string, repo: string): TaskMetaV06 =>
  ({
    id,
    title: `f504 ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [repo],
    isolateWorktree: true,
    repoBaseBranches: { [repo]: "main" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

describe("F5-04 prewarm 不同步跑依赖初始化命令", () => {
  const ids: string[] = [];
  afterEach(() => {
    for (const id of ids.splice(0)) {
      clearTaskStarting(id);
      clearResourceJobs(id);
      try {
        rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });

  it("预热在几秒内完成（worktree 已建、命令没跑）；命令留给后台补齐路径", async () => {
    const id = `t_f504_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    const repo = mkdtempSync(path.join(TMP_ROOT, "f504-repo-"));
    initGitRepo(repo);
    // 命令会写计数文件、再挂 60 秒：预热若同步跑它，下面的轮询必超时
    const setupCommand = `"${process.execPath}" -e "require('fs').appendFileSync('setup-count.txt','x'); setTimeout(()=>{},60000)"`;
    await fs.mkdir(process.env.FLOWSHIP_DATA_DIR!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.FLOWSHIP_DATA_DIR!, "config.json"),
      JSON.stringify({ repos: [{ name: "r", path: repo, setupCommand }] }),
    );
    const meta = makeMeta(id, repo);
    await writeMeta(meta);

    prewarmTaskWorkspace(id);

    let warmed = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !warmed) {
      const events = await readEvents(id);
      warmed = events.some(
        (e) =>
          e.kind === "info" &&
          typeof e.text === "string" &&
          e.text.includes("后台预热"),
      );
      if (!warmed) await sleep(50);
    }
    expect(warmed).toBe(true);

    const workDir = getTaskWorkRepoPaths(meta as never)[0];
    expect(await exists(path.join(workDir, ".git"))).toBe(true);
    // 预热期间命令没被启动
    expect(await exists(path.join(workDir, "setup-count.txt"))).toBe(false);
    // 预热 info 里也不该出现「依赖初始化命令…」的成败描述
    const infoTexts = (await readEvents(id))
      .filter((e) => e.kind === "info" && typeof e.text === "string")
      .map((e) => String(e.text));
    expect(infoTexts.some((t) => t.includes("依赖初始化命令"))).toBe(false);

    // 后台补齐路径（推进启动后 kickoffDeferredDepClone 走的就是它）才会真正启动命令：
    // 只确认它被拉起（计数文件出现）、然后立刻 revoke 掉，不真等 60 秒
    const { revokeResourceJobs } = await import("@/lib/server/resource-jobs");
    const bg = cloneMissingTaskDepDirs(meta as never, () => true).catch(
      (e: unknown) => e,
    );
    const started = Date.now();
    while (
      !(await exists(path.join(workDir, "setup-count.txt"))) &&
      Date.now() - started < 10_000
    ) {
      await sleep(30);
    }
    expect(await exists(path.join(workDir, "setup-count.txt"))).toBe(true);
    revokeResourceJobs(id);
    await bg;
  }, 60_000);
});
