/**
 * Q4-01：UNC / WSL 仓库在「登记 / 创建」处就拒收并写原因（已拍板）。
 *
 * 旧行为：登记入口放行 UNC → `POST /api/tasks` 的 sanitizeRepoPaths 只 trim → 任务建出来后
 * `repo-branches` 回 400，`use-repo-branches` 把非 ok 吞成「非 git 仓库」并禁用分支框，用户看不到原因；
 * 推进弹窗批量调 `repo-remote-meta`，任一仓是 UNC 就整体 400、同任务的本地仓被连坐。
 * 这里用真实 route handler（mock 掉下游 createTask）+ 纯函数 + 真实 hook 辅助函数断言行为。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  UNC_REJECT_MESSAGE,
  filterProbeableRepoPaths,
  firstNonLocalRepoPath,
} from "@/lib/unc-path";
import { readServerReason } from "@/hooks/use-repo-branches";

const createTask = vi.hoisted(() =>
  vi.fn(async (input: { repoPaths: string[] }) => ({ id: "t_1", repoPaths: input.repoPaths })),
);
vi.mock("@/lib/server/task-fs", () => ({
  listTasks: async () => [],
  listTasksWithCorrupt: async () => ({ tasks: [], corrupt: [] }),
  commitReadableTaskListResponse: <T extends { id: string }>(
    items: T[],
    wrap: (filtered: T[]) => unknown,
  ) => Response.json(wrap(items)),
  createTask,
}));
vi.mock("@/lib/server/feishu-bridge/bootstrap", () => ({
  ensureFeishuBridgeBootstrapped: () => {},
}));
vi.mock("@/lib/server/failpoints", () => ({ failpoint: async () => {} }));
vi.mock("@/lib/server/task-runner", () => ({ prewarmTaskWorkspace: () => {} }));

const { POST } = await import("@/app/api/tasks/route");

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const UNC_FORMS = [
  "//attacker.example/share/repo",
  "\\\\attacker.example\\share\\repo",
  "file:////attacker.example/share/repo",
  "file://attacker.example/share/repo",
  "\\\\wsl$\\Ubuntu\\home\\me\\repo",
  "\\\\?\\UNC\\attacker.example\\share\\repo",
];

beforeEach(() => {
  createTask.mockClear();
});

describe("POST /api/tasks：UNC / WSL 仓库创建处拒收并写原因", () => {
  it.each(UNC_FORMS)("task 模式 %s → 400 + 明确原因，且 createTask 一次都没调", async (p) => {
    const res = await post({ title: "t", mode: "task", repoPaths: ["/tmp/ok-repo", p] });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(p);
    expect(error).toContain(UNC_REJECT_MESSAGE);
    expect(error).toContain("暂不支持");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("chat 模式（repoPaths 选填）带 UNC 同样 400", async () => {
    const res = await post({ mode: "chat", repoPaths: [UNC_FORMS[0]] });
    expect(res.status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("回归：全是本地路径 → 照常 201 创建（路径原样传给 createTask）", async () => {
    const res = await post({ title: "t", mode: "task", repoPaths: [" /tmp/a ", "/tmp/b"] });
    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0][0].repoPaths).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("回归：Windows 盘符路径 / 无仓库的 chat 不受影响", async () => {
    expect((await post({ title: "t", repoPaths: ["D:\\repo", "C:/repo"] })).status).toBe(201);
    expect((await post({ mode: "chat" })).status).toBe(201);
  });

  it("回归：task 模式没有仓库仍是原来的 400 文案", async () => {
    const res = await post({ title: "t", mode: "task", repoPaths: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("repoPaths");
  });
});

describe("firstNonLocalRepoPath / filterProbeableRepoPaths", () => {
  it("返回第一个被拒的路径与可直接给用户看的完整原因", () => {
    const r = firstNonLocalRepoPath(["/a", "//h/s/r", "\\\\h2\\s"]);
    expect(r?.path).toBe("//h/s/r");
    expect(r?.reason).toContain("//h/s/r");
    expect(firstNonLocalRepoPath(["/a", "/b", "D:\\x"])).toBeNull();
    expect(firstNonLocalRepoPath([])).toBeNull();
  });

  it("win32 口径：只认盘符绝对路径，WSL / NT 命名空间 / 根相对都拒", () => {
    for (const p of ["\\\\wsl$\\U\\r", "\\??\\UNC\\h\\s\\r", "/c/Users/r", "\\Windows\\r"]) {
      expect(firstNonLocalRepoPath([p], "win32"), p).not.toBeNull();
    }
    expect(firstNonLocalRepoPath(["D:\\repo", "c:/repo"], "win32")).toBeNull();
  });

  it("filterProbeableRepoPaths：只滤掉 UNC / WSL，本地仓保持顺序（推进弹窗不再被连坐）", () => {
    expect(filterProbeableRepoPaths(["/a", "//h/s/r", "/b", "\\\\h\\s", "D:\\c"])).toEqual([
      "/a",
      "/b",
      "D:\\c",
    ]);
    expect(filterProbeableRepoPaths(["//h/s", "\\\\h\\s"])).toEqual([]);
    expect(filterProbeableRepoPaths([])).toEqual([]);
  });
});

describe("use-repo-branches：保留服务端原因，不再一律「非 git 仓库」", () => {
  it("读出 400 响应里的 error 文案", async () => {
    const r = new Response(JSON.stringify({ error: UNC_REJECT_MESSAGE }), { status: 400 });
    expect(await readServerReason(r)).toEqual({ reason: UNC_REJECT_MESSAGE });
  });

  it("读不出 / 不是字符串 / 空串 → 空对象（调用方退回通用「非 git 仓库」）", async () => {
    expect(await readServerReason(new Response("<html>", { status: 500 }))).toEqual({});
    expect(await readServerReason(new Response(JSON.stringify({ error: 5 }), { status: 400 }))).toEqual({});
    expect(await readServerReason(new Response(JSON.stringify({ error: "  " }), { status: 400 }))).toEqual({});
    expect(await readServerReason(new Response(JSON.stringify({}), { status: 400 }))).toEqual({});
  });
});
