/**
 * 只需要 meta 字段的高频路由不得整文件读事件日志。
 *
 * `@` 文件联想（repo-files）每个按键一次、打开分支面板（branches）一次——它们只用 repoPaths / worktree
 * 这类 meta 字段，却曾经走 `getTask`（整文件 parse events.jsonl）。事件日志越大每次越慢。
 *
 * 做法：mock 的 task-fs **只提供 getTaskMeta**——谁把它改回 getTask，路由一调用就会因为
 * mock 上没有该导出而直接失败。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

const { getTaskMeta, searchTaskRepoFiles, readGitBranchState } = vi.hoisted(
  () => ({
    getTaskMeta: vi.fn(),
    searchTaskRepoFiles: vi.fn(async () => [] as string[]),
    readGitBranchState: vi.fn(async () => ({
      isRepo: true,
      current: "main",
      branches: ["main"],
    })),
  }),
);

vi.mock("@/lib/server/task-fs", () => ({ getTaskMeta }));
vi.mock("@/lib/server/repo-files", () => ({
  normalizeRepoRoot: (p: string) => p,
  REPO_FILES_Q_MAX_LEN: 200,
  searchTaskRepoFiles,
}));
vi.mock("@/lib/server/git-branches", () => ({
  checkoutGitBranch: vi.fn(),
  readGitBranchState,
}));

const repoFiles = await import("@/app/api/repo-files/route");
const branches = await import("@/app/api/tasks/[id]/branches/route");

const meta = (): Task =>
  ({
    id: "t1",
    title: "t",
    mode: "task",
    repoPaths: ["/tmp/repo-a"],
    readonlyRepoPaths: [],
    events: [],
  }) as unknown as Task;

beforeEach(() => {
  vi.clearAllMocks();
  getTaskMeta.mockResolvedValue(meta());
});

describe("repo-files：@ 联想只读 meta", () => {
  it("正常搜索：走 getTaskMeta、把 task.repoPaths 交给搜索", async () => {
    const resp = await repoFiles.GET(
      new Request("http://localhost/api/repo-files?taskId=t1&q=foo"),
    );

    expect(resp.status).toBe(200);
    expect(getTaskMeta).toHaveBeenCalledWith("t1");
    expect(searchTaskRepoFiles).toHaveBeenCalledWith(
      ["/tmp/repo-a"],
      "foo",
      expect.anything(),
    );
  });

  it("任务不存在 → 404", async () => {
    getTaskMeta.mockResolvedValue(null);

    const resp = await repoFiles.GET(
      new Request("http://localhost/api/repo-files?taskId=t1&q=foo"),
    );

    expect(resp.status).toBe(404);
  });

  it("root 不属于本任务 → 400（防路径穿越的校验仍在）", async () => {
    const resp = await repoFiles.GET(
      new Request(
        "http://localhost/api/repo-files?taskId=t1&q=foo&root=/etc",
      ),
    );

    expect(resp.status).toBe(400);
    expect(searchTaskRepoFiles).not.toHaveBeenCalled();
  });
});

describe("branches：分支面板只读 meta", () => {
  it("GET：走 getTaskMeta、读第一个仓的分支状态", async () => {
    const resp = await branches.GET(
      new Request("http://localhost/api/tasks/t1/branches"),
      { params: Promise.resolve({ id: "t1" }) },
    );

    expect(resp.status).toBe(200);
    expect(getTaskMeta).toHaveBeenCalledWith("t1");
    expect(readGitBranchState).toHaveBeenCalledWith(
      "/tmp/repo-a",
      expect.anything(),
    );
  });

  it("GET：任务不存在 → 404", async () => {
    getTaskMeta.mockResolvedValue(null);

    const resp = await branches.GET(
      new Request("http://localhost/api/tasks/t1/branches"),
      { params: Promise.resolve({ id: "t1" }) },
    );

    expect(resp.status).toBe(404);
  });

  it("POST：只读仓库不能切分支（校验用的仍是 meta 字段）", async () => {
    getTaskMeta.mockResolvedValue({
      ...meta(),
      readonlyRepoPaths: ["/tmp/repo-a"],
    });

    const resp = await branches.POST(
      new Request("http://localhost/api/tasks/t1/branches", {
        method: "POST",
        body: JSON.stringify({ branch: "dev", repoPath: "/tmp/repo-a" }),
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );

    expect(resp.status).toBe(400);
  });
});
