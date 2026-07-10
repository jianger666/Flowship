/**
 * adaptive 角色任务的创建 / 编辑 route 回归（CR-07）
 *
 * 回归点：PATCH /api/tasks/[id] 原来手写 `role !== "fe" && role !== "be"` 白名单、
 * 漏了 adaptive——自适应任务连改标题都 400（编辑弹窗总是随请求带 role）。
 * 现在两个 route 共用 types.ts 的 isTaskRole 单一源。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-role-route-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = TMP_ROOT;

import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { PATCH as patchTaskRoute } from "@/app/api/tasks/[id]/route";
import type { Task } from "@/lib/types";

const jsonRequest = (method: string, body: unknown): Request =>
  new Request("http://127.0.0.1/api/tasks", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const patchTask = (id: string, body: unknown): Promise<Response> =>
  patchTaskRoute(jsonRequest("PATCH", body), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("adaptive 角色的创建与编辑（CR-07）", () => {
  let taskId = "";

  it("创建 adaptive 任务成功、role 落库", async () => {
    const res = await createTaskRoute(
      jsonRequest("POST", {
        title: "自适应任务",
        role: "adaptive",
        mode: "task",
        repoPaths: [TMP_ROOT],
        feishuStoryUrl: "https://project.feishu.cn/x/story/detail/123456",
      }),
    );
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: Task };
    expect(task.role).toBe("adaptive");
    taskId = task.id;
  });

  it("编辑 adaptive 任务（改标题、role 随行）→ 200（旧白名单在此 400）", async () => {
    const res = await patchTask(taskId, { title: "改个标题", role: "adaptive" });
    expect(res.status).toBe(200);
    const { task } = (await res.json()) as { task: Task };
    expect(task.title).toBe("改个标题");
    expect(task.role).toBe("adaptive");
  });

  it("adaptive → fe 改角色也成功", async () => {
    const res = await patchTask(taskId, { role: "fe" });
    expect(res.status).toBe(200);
    const { task } = (await res.json()) as { task: Task };
    expect(task.role).toBe("fe");
  });

  it("枚举外的角色仍被拒（400）", async () => {
    const res = await patchTask(taskId, { title: "x", role: "qa" });
    expect(res.status).toBe(400);
  });
});
