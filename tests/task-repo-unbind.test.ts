/**
 * 任务编辑整份替换仓库：禁空、running 409、剪 5 张 map + 独立剪 gitBranches。
 * 日常轻量态不建 worktree，本文件不碰 git。
 */
import { mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-repo-unbind-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const {
  createTask,
  setTaskRunStatus,
  TaskFieldUpdateError,
  updateTaskFields,
} = await import("@/lib/server/task-fs");
const { readMetaV06, writeMeta, withTaskLock } = await import(
  "@/lib/server/task-fs-core"
);

const REPO_A = path.join(TMP_ROOT, "work", "crm-web");
const REPO_B = path.join(TMP_ROOT, "work", "crm-api");
mkdirSync(path.join(REPO_A, ".git"), { recursive: true });
mkdirSync(path.join(REPO_B, ".git"), { recursive: true });

afterAll(async () => {
  const { rmSync } = await import("node:fs");
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const seedTask = async () => {
  const task = await createTask({
    title: "解绑测试",
    mode: "task",
    workRole: "fe",
    repoPaths: [REPO_A, REPO_B],
    repoBaseBranches: { [REPO_A]: "main", [REPO_B]: "master" },
    repoTestBranches: { [REPO_A]: "test", [REPO_B]: "qa" },
    repoDevBranches: { [REPO_A]: "develop", [REPO_B]: "dev" },
    repoBranchTemplates: { [REPO_A]: "{storyId}", [REPO_B]: "{storyId}" },
  });
  await withTaskLock(task.id, async () => {
    const meta = await readMetaV06(task.id);
    if (!meta) throw new Error("missing meta");
    meta.gitBranches = [
      { repoPath: REPO_A, name: "feature/a", baseBranch: "main" },
      { repoPath: REPO_B, name: "feature/b", baseBranch: "master" },
    ];
    meta.sessionAgentId = "agent_old";
    await writeMeta(meta);
  });
  return task;
};

describe("updateTaskFields 整份替换仓库", () => {
  it("禁空", async () => {
    const task = await seedTask();
    await expect(
      updateTaskFields(task.id, { repoPaths: [] }),
    ).rejects.toMatchObject({
      name: "TaskFieldUpdateError",
      httpStatus: 400,
    });
    await expect(
      updateTaskFields(task.id, { repoPaths: ["  ", ""] }),
    ).rejects.toBeInstanceOf(TaskFieldUpdateError);
  });

  it("running 时 409", async () => {
    const task = await seedTask();
    await setTaskRunStatus(task.id, "running");
    await expect(
      updateTaskFields(task.id, { repoPaths: [REPO_A] }),
    ).rejects.toMatchObject({
      name: "TaskFieldUpdateError",
      httpStatus: 409,
    });
  });

  it("解绑一个仓：剪 5 张 map、独立剪 gitBranches、清 sessionAgentId", async () => {
    const task = await seedTask();
    const result = await updateTaskFields(task.id, { repoPaths: [REPO_A] });
    expect(result).not.toBeNull();
    expect(result!.reposChanged).toBe(true);
    expect(result!.unboundRepoPaths).toEqual([REPO_B]);
    expect(result!.task.repoPaths).toEqual([REPO_A]);
    expect(result!.task.repoBaseBranches).toEqual({ [REPO_A]: "main" });
    expect(result!.task.repoTestBranches).toEqual({ [REPO_A]: "test" });
    expect(result!.task.repoDevBranches).toEqual({ [REPO_A]: "develop" });
    expect(result!.task.repoBranchTemplates).toEqual({ [REPO_A]: "{storyId}" });
    expect(result!.task.gitBranches).toEqual([
      { repoPath: REPO_A, name: "feature/a", baseBranch: "main" },
    ]);
    expect(result!.task.sessionAgentId).toBeUndefined();
  });
});
