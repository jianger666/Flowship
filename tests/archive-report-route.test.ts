/**
 * PATCH /api/tasks/[id] {archived} 的响应带「服务端实际做了什么」（第三轮 review D2b-06 / D2b-03）。
 *
 * D2b-06：归档 toast「已清理隔离工作区」原本由客户端按任务形状预测（`willCleanup`），
 * 服务端快照失败时其实保留了目录——文案与行为不同源。现在响应带 `report.worktree`，toast 只认它。
 * D2b-03：归档会取消该会话全部定时，toast 一字不提、「撤销」只翻标记。现在响应带取消 / 恢复的条数，
 * 取消归档时按「恢复」口径还原。
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { PATCH } from "@/app/api/tasks/[id]/route";
import { createSchedule, readSchedules } from "@/lib/server/schedule-store";
import { createTask } from "@/lib/server/task-fs";
import {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  wipSnapshotRefName,
} from "@/lib/server/task-worktrees";
import type { ArchiveReport } from "@/lib/worktree-report";

const ROOT = path.join(os.tmpdir(), `fe-archive-report-${Date.now()}`);
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const patchArchived = async (id: string, archived: boolean) => {
  const res = await PATCH(
    new Request(`http://localhost/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return {
    status: res.status,
    body: (await res.json()) as { task: { archived?: boolean }; report?: ArchiveReport },
  };
};

let seq = 0;
const setupWorktreeTask = async (tag: string) => {
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
    title: `归档回报-${tag}`,
    mode: "task",
    workRole: "fe",
    repoPaths: [repo],
    repoBaseBranches: { [repo]: "main" },
    feishuStoryUrl: `https://project.feishu.cn/x/story/detail/${830000 + seq}`,
  } as never);
  await ensureTaskWorktrees(task, () => true);
  const wd = getTaskWorkRepoPaths(task)[0];
  return { repo, task, wd, dirName: path.basename(wd) };
};

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe("归档响应的 report.worktree 以服务端实际结果为准（D2b-06）", () => {
  it("干净 worktree：removed=true、没有 kept", async () => {
    const { task, wd } = await setupWorktreeTask("clean");
    const { status, body } = await patchArchived(task.id, true);
    expect(status).toBe(200);
    expect(body.task.archived).toBe(true);
    expect(body.report?.worktree).toEqual({ removed: true, kept: [], snapshotCount: 0 });
    await expect(fs.access(wd)).rejects.toThrow();
  });

  it("有未提交改动且快照存得下：removed=true、snapshotCount=1", async () => {
    const { task, wd } = await setupWorktreeTask("snap");
    await fs.writeFile(path.join(wd, "wip.txt"), "wip\n");
    const { body } = await patchArchived(task.id, true);
    expect(body.report?.worktree).toEqual({ removed: true, kept: [], snapshotCount: 1 });
  });

  it("快照失败：目录保留——removed=false、kept 带仓与原因（客户端据此改成「保留」的警示，而不是说已清理）", async () => {
    const { repo, task, wd, dirName } = await setupWorktreeTask("keep");
    await fs.writeFile(path.join(wd, "precious.txt"), "do-not-lose\n");
    git(repo, "update-ref", `${wipSnapshotRefName(task.id, dirName)}/blocker`, "HEAD");

    const { status, body } = await patchArchived(task.id, true);
    expect(status).toBe(200);
    expect(body.task.archived).toBe(true);
    expect(body.report?.worktree?.removed).toBe(false);
    expect(body.report?.worktree?.kept).toEqual([
      expect.objectContaining({ repoPath: repo, workDir: wd }),
    ]);
    await expect(fs.readFile(path.join(wd, "precious.txt"), "utf8")).resolves.toBe(
      "do-not-lose\n",
    );
  });

  it("chat（没有隔离工作区流程）：不带 worktree 字段——toast 不会凭空说「已清理」", async () => {
    const task = await createTask({ title: "聊天归档", mode: "chat" } as never);
    const { body } = await patchArchived(task.id, true);
    expect(body.report).toBeDefined();
    expect(body.report?.worktree).toBeUndefined();
  });
});

describe("归档取消定时 / 取消归档还原（D2b-03）", () => {
  it("归档：report.cancelledSchedules=N；取消归档：report.restoredSchedules=N 且定时真回来了", async () => {
    const task = await createTask({ title: "盯 CI 的会话", mode: "chat" } as never);
    const created = await createSchedule(task.id, {
      kind: "every",
      title: "盯 CI",
      message: "看 CI",
      firstFireAt: Date.now() + 10 * 60_000,
      intervalMs: 10 * 60_000,
    });
    expect(created.ok).toBe(true);
    await createSchedule(task.id, {
      kind: "once",
      title: "提醒合代码",
      message: "该合了",
      firstFireAt: Date.now() + 3 * 60 * 60_000,
    });

    const archived = await patchArchived(task.id, true);
    expect(archived.body.report?.cancelledSchedules).toBe(2);
    expect((await readSchedules(task.id)).every((r) => r.status === "cancelled")).toBe(true);

    const restored = await patchArchived(task.id, false);
    expect(restored.body.task.archived).toBeUndefined();
    expect(restored.body.report?.restoredSchedules).toBe(2);
    const list = await readSchedules(task.id);
    expect(list.map((r) => r.status).sort()).toEqual(["active", "active"]);
  });

  it("Q9-06：归档期间一次性定时已过点 → 取消归档的 report 带 missedSchedules，info 事件如实说「已错过」", async () => {
    const task = await createTask({ title: "只带一次提醒", mode: "chat" } as never);
    const fireAt = Date.now() + 30 * 60_000;
    const created = await createSchedule(task.id, {
      kind: "once",
      title: "半小时后看 CI",
      message: "看 CI",
      firstFireAt: fireAt,
    });
    expect(created.ok).toBe(true);
    const archived = await patchArchived(task.id, true);
    expect(archived.body.report?.cancelledSchedules).toBe(1);

    // 只快进 Date（不碰其它计时器），模拟「过点之后才取消归档」
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(fireAt + 5 * 60_000);
      const restored = await patchArchived(task.id, false);
      expect(restored.body.report?.restoredSchedules).toBe(0);
      expect(restored.body.report?.missedSchedules).toBe(1);
      expect(restored.body.report?.endedSchedules).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect((await readSchedules(task.id)).map((r) => r.status)).toEqual(["missed"]);
    // 事件流里也有一条如实的提示（不是静默）
    const { readEvents } = await import("@/lib/server/task-fs-core");
    const events = await readEvents(task.id);
    expect(events.some((e) => e.kind === "info" && /已过点、记为「已错过」/.test(String((e as { text?: string }).text)))).toBe(true);
  });

  it("没有定时的会话：两个计数都是 0", async () => {
    const task = await createTask({ title: "没定时", mode: "chat" } as never);
    const a = await patchArchived(task.id, true);
    expect(a.body.report?.cancelledSchedules).toBe(0);
    const b = await patchArchived(task.id, false);
    expect(b.body.report?.restoredSchedules).toBe(0);
  });
});
