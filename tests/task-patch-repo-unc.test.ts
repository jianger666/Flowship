/**
 * Q4-01 补洞：编辑入口 `PATCH /api/tasks/[id] { repoPaths }` 与创建入口（POST /api/tasks）同口径，
 * 拒收 UNC / WSL 仓库并写明原因（第四轮报告：创建处拒了、编辑处还放行，同一个事实两个口径）。
 * 用真实 route handler + 真实 createTask（vitest 的 hermetic 数据目录），不 mock 下游。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PATCH } from "@/app/api/tasks/[id]/route";
import { createTask, getTask } from "@/lib/server/task-fs";

const ROOT = path.join(os.tmpdir(), `fe-task-patch-unc-${Date.now()}`);

const patchRepoPaths = async (id: string, repoPaths: unknown) => {
  const res = await PATCH(
    new Request(`http://localhost/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPaths }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as { error?: string; task?: { repoPaths?: string[] } } };
};

const UNC_FORMS = [
  "//attacker.example/share/repo",
  "\\\\attacker.example\\share\\repo",
  "\\\\wsl$\\Ubuntu\\home\\me\\repo",
  "file://attacker.example/share/repo",
];

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe("PATCH /api/tasks/[id] repoPaths：UNC / WSL 编辑入口拒收（Q4-01）", () => {
  it.each(UNC_FORMS)("chat 任务：%s → 400 带原因、repoPaths 不变", async (unc) => {
    const task = await createTask({ title: "对话", mode: "chat", repoPaths: [] } as never);
    const { status, body } = await patchRepoPaths(task.id, [unc]);
    expect(status).toBe(400);
    expect(body.error).toContain("不可用");
    expect(body.error).toContain("UNC");
    expect((await getTask(task.id))?.repoPaths ?? []).toEqual([]);
  });

  it("task 模式同样拒收（守卫在 chat / task 分叉之前）", async () => {
    const local = path.join(ROOT, "local-repo");
    await fs.mkdir(local, { recursive: true });
    const task = await createTask({
      title: "需求",
      mode: "task",
      workRole: "fe",
      repoPaths: [local],
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/840001",
    } as never);
    const { status, body } = await patchRepoPaths(task.id, [local, "\\\\attacker.example\\share\\repo"]);
    expect(status).toBe(400);
    expect(body.error).toContain("attacker.example");
    expect((await getTask(task.id))?.repoPaths).toEqual([local]);
  });

  it("旧树能用的情形仍能用：chat 任务换成本机目录 → 200；清空 → 200", async () => {
    const local = path.join(ROOT, "chat-local");
    await fs.mkdir(local, { recursive: true });
    const task = await createTask({ title: "对话", mode: "chat", repoPaths: [] } as never);
    const ok = await patchRepoPaths(task.id, [local]);
    expect(ok.status).toBe(200);
    expect((await getTask(task.id))?.repoPaths).toEqual([local]);
    const cleared = await patchRepoPaths(task.id, []);
    expect(cleared.status).toBe(200);
  });

  it("非字符串数组仍是原来的 400 文案（守卫不吞既有校验）", async () => {
    const task = await createTask({ title: "对话", mode: "chat", repoPaths: [] } as never);
    const { status, body } = await patchRepoPaths(task.id, "not-an-array");
    expect(status).toBe(400);
    expect(body.error).toBe("repoPaths 必须是字符串数组");
  });
});
