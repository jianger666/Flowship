/**
 * DELETE /api/system/storage?stale=<id>（存储页「删除残留工作区」）——路由 handler 直接调用。
 *
 * 第三轮 review D2b-01：旧实现裸 `fs.rm`，绕过 WIP 快照守卫——而守卫「快照失败 → 保留」下来的目录，
 * 恰好就是之后出现在这个残留列表里的那批。现在逐目录走同一道守卫：存不下 → 409 + 原因；
 * 用户二次确认后带 `force=1` 才越过；成功时把快照 ref 告诉前端。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import type { Task } from "@/lib/types";

const TMP_ROOT = path.join(os.tmpdir(), `fe-storage-stale-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import { DELETE } from "@/app/api/system/storage/route";
// 路由读任务目录用的是 import 时就求值的 DATA_DIR（= 当时的 dataRoot()/tasks）——夹具必须建在同一处，
// 不能自己用 process.env 再拼一份（import 会被提升到赋值之前，两处可能不是同一个目录）
import { DATA_DIR as TASKS_DIR } from "@/lib/server/task-fs-core";
import {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  getTaskWorktreesDir,
  wipSnapshotRefName,
} from "@/lib/server/task-worktrees";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

let seq = 0;
const setup = async (tag: string) => {
  seq += 1;
  const repo = path.join(TMP_ROOT, `${tag}-repo`);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, "f.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  const t = {
    id: `t_1700000008${String(seq).padStart(3, "0")}_${tag}`,
    mode: "task",
    title: "存储页删除",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [repo],
    isolateWorktree: true,
    repoBaseBranches: { [repo]: "main" },
    feishuStoryUrl: `https://project.feishu.cn/x/story/detail/${810000 + seq}`,
    actions: [],
    mrs: [],
  } as unknown as Task;
  await fs.mkdir(path.join(TASKS_DIR, t.id), { recursive: true });
  await ensureTaskWorktrees(t, () => true);
  const wd = getTaskWorkRepoPaths(t)[0];
  return { repo, t, wd, dirName: path.basename(wd) };
};

const call = (id: string, extra = "") =>
  DELETE(
    new Request(`http://localhost/api/system/storage?stale=${encodeURIComponent(id)}${extra}`, {
      method: "DELETE",
    }),
  );

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("DELETE /api/system/storage?stale=", () => {
  it("任务还在：409 且不碰目录（既有行为不退化）", async () => {
    const { t, wd } = await setup("alive");
    const res = await call(t.id);
    expect(res.status).toBe(409);
    await expect(fs.access(wd)).resolves.toBeUndefined();
  });

  it("残留目录有未提交改动、快照存得下：200，先落 ref 再删，响应带 ref（前端据此告知用户能找回）", async () => {
    const { repo, t, wd, dirName } = await setup("ok");
    await fs.rm(path.join(TASKS_DIR, t.id), { recursive: true, force: true });
    await fs.writeFile(path.join(wd, "precious.txt"), "do-not-lose\n");

    const res = await call(t.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      removedDirs: string[];
      snapshots: Array<{ dirName: string; ref: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.removedDirs).toEqual([dirName]);
    expect(body.snapshots).toEqual([
      expect.objectContaining({ dirName, ref: wipSnapshotRefName(t.id, dirName) }),
    ]);
    expect(git(repo, "show", `${body.snapshots[0].ref}:precious.txt`)).toBe("do-not-lose");
    await expect(fs.access(getTaskWorktreesDir(t.id))).rejects.toThrow();
    expect(git(repo, "worktree", "list")).not.toContain(wd);
  });

  it("快照存不下（ref 名被占）：409 + kept 原因、目录与改动原样保留；force=1 才删", async () => {
    const { repo, t, wd, dirName } = await setup("keep");
    await fs.rm(path.join(TASKS_DIR, t.id), { recursive: true, force: true });
    await fs.writeFile(path.join(wd, "precious.txt"), "do-not-lose\n");
    git(repo, "update-ref", `${wipSnapshotRefName(t.id, dirName)}/blocker`, "HEAD");

    const res = await call(t.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      kept: Array<{ dirName: string; reason: string }>;
    };
    expect(body.error).toMatch(/未提交|保存/);
    expect(body.kept).toEqual([expect.objectContaining({ dirName })]);
    await expect(fs.readFile(path.join(wd, "precious.txt"), "utf8")).resolves.toBe(
      "do-not-lose\n",
    );

    const forced = await call(t.id, "&force=1");
    expect(forced.status).toBe(200);
    await expect(fs.access(wd)).rejects.toThrow();
  });

  it("残留目录不存在 → 404（既有行为）", async () => {
    const res = await call("t_1700000008999_nope");
    expect(res.status).toBe(404);
  });
});
