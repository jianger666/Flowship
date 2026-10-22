/**
 * 删任务时 WIP 快照结果要带回响应（第三轮 review F1-03）。
 *
 * 旧实现：`deleteTask` 把 `removeTaskWorktrees` 的返回值整个丢掉。快照失败 → worktree 按设计保留，
 * 但任务 meta / events 随即被删，事件文案无处可写，用户一个字不知道：目录继续占着任务分支，
 * 之后只会在存储页「残留工作区」里以一个 `t_…` id 出现。
 * 现在：`deleteTask(id, report)` 把失败（保留）与成功（落了哪个 ref）的结果收进 report，
 * `DELETE /api/tasks/[id]` 把它带进响应，前端据此 toast。
 *
 * 路由 handler / 真 git 临时仓直接调用；数据目录用 hermetic 测试环境（不覆盖 FLOWSHIP_DATA_DIR——
 * task-fs-core 的 DATA_DIR 在 import 时求值，覆盖会让任务目录与 worktree 根落在两处）。
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DELETE } from "@/app/api/tasks/[id]/route";
import { createTask, deleteTask } from "@/lib/server/task-fs";
import {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  getTaskWorktreesDir,
  wipSnapshotRefName,
} from "@/lib/server/task-worktrees";

const ROOT = path.join(os.tmpdir(), `fe-delete-report-${Date.now()}`);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

let seq = 0;
const setup = async (tag: string) => {
  seq += 1;
  const repo = path.join(ROOT, `${tag}-repo`);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, "f.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  const task = await createTask({
    title: `删除回报-${tag}`,
    mode: "task",
    workRole: "fe",
    repoPaths: [repo],
    repoBaseBranches: { [repo]: "main" },
    feishuStoryUrl: `https://project.feishu.cn/x/story/detail/${820000 + seq}`,
  } as never);
  await ensureTaskWorktrees(task, () => true);
  const wd = getTaskWorkRepoPaths(task)[0];
  return { repo, task, wd, dirName: path.basename(wd) };
};

const callDelete = (id: string) =>
  DELETE(new Request(`http://localhost/api/tasks/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe("deleteTask 带回 worktree 快照结果", () => {
  it("快照失败：report.kept 带仓与原因、worktree 目录保留；任务本身照常删掉", async () => {
    const { repo, task, wd, dirName } = await setup("fn-keep");
    await fs.writeFile(path.join(wd, "precious.txt"), "do-not-lose\n");
    git(repo, "update-ref", `${wipSnapshotRefName(task.id, dirName)}/blocker`, "HEAD");

    const report = { kept: [], snapshots: [] } as Parameters<typeof deleteTask>[1] & object;
    await expect(deleteTask(task.id, report)).resolves.toBe(true);
    expect(report.kept).toEqual([
      expect.objectContaining({ repoPath: repo, workDir: wd, reason: expect.stringContaining("update-ref") }),
    ]);
    expect(report.snapshots).toEqual([]);
    await expect(fs.readFile(path.join(wd, "precious.txt"), "utf8")).resolves.toBe("do-not-lose\n");
  });

  it("不传 report 的老调用方照常工作（签名向后兼容）", async () => {
    const { task, wd } = await setup("fn-compat");
    await expect(deleteTask(task.id)).resolves.toBe(true);
    await expect(fs.access(wd)).rejects.toThrow();
  });
});

describe("DELETE /api/tasks/[id] 响应", () => {
  it("快照失败：200 + worktreeKept（让前端 toast「工作区已保留」），而不是只回 {ok:true}", async () => {
    const { repo, task, wd, dirName } = await setup("route-keep");
    await fs.writeFile(path.join(wd, "precious.txt"), "do-not-lose\n");
    git(repo, "update-ref", `${wipSnapshotRefName(task.id, dirName)}/blocker`, "HEAD");

    const res = await callDelete(task.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      worktreeKept?: Array<{ repoPath: string; workDir: string; reason: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.worktreeKept).toEqual([
      expect.objectContaining({ repoPath: repo, workDir: wd }),
    ]);
    await expect(fs.readFile(path.join(wd, "precious.txt"), "utf8")).resolves.toBe("do-not-lose\n");
  });

  it("快照成功：带 worktreeSnapshots（落在哪个 ref），没有 worktreeKept", async () => {
    const { repo, task, wd, dirName } = await setup("route-snap");
    await fs.writeFile(path.join(wd, "saved.txt"), "keep me\n");

    const res = await callDelete(task.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worktreeKept?: unknown[];
      worktreeSnapshots?: Array<{ repoPath: string; ref: string }>;
    };
    expect(body.worktreeKept ?? []).toEqual([]);
    expect(body.worktreeSnapshots).toEqual([
      { repoPath: repo, ref: wipSnapshotRefName(task.id, dirName) },
    ]);
    expect(git(repo, "show", `${body.worktreeSnapshots![0].ref}:saved.txt`)).toBe("keep me");
    await expect(fs.access(getTaskWorktreesDir(task.id))).rejects.toThrow();
  });

  it("干净 worktree：不带这两个字段（响应保持精简）", async () => {
    const { task } = await setup("route-clean");
    const res = await callDelete(task.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("worktreeKept");
    expect(body).not.toHaveProperty("worktreeSnapshots");
  });
});
