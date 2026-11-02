/**
 * POST /api/tasks/[id]/action-exclude：划除 / 恢复失败的 500 不把本机绝对路径回给前端（与 stop 路由同口径）。
 *
 * `ArtifactMoveRollbackError.message` 带着 artifact 的绝对路径（给日志用：文件现在在哪、该挪回哪）；
 * 旧路由直接 `errorResponse(err.message, …)` 回给了前端。现在：前端文案固定、不含路径，详细路径只进 console.error。
 *
 * task-artifacts 保留真实的 ArtifactMoveRollbackError 类、只桩掉 setActionArtifactExcluded；数据目录指向临时目录（不写盘）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(path.join(os.tmpdir(), "flowship-action-exclude-route-"));
process.env.FLOWSHIP_DATA_DIR = DATA;
afterAll(() => rmSync(DATA, { recursive: true, force: true }));

const getTask = vi.hoisted(() => vi.fn());
const setActionArtifactExcluded = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/task-fs", () => ({ getTask }));
vi.mock("@/lib/server/stop-task", () => ({ stopTaskAgent: vi.fn() }));
vi.mock("@/lib/server/task-stream", () => ({ publishTaskStreamEvent: vi.fn() }));
vi.mock("@/lib/server/task-artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/task-artifacts")>()),
  setActionArtifactExcluded,
}));

const { POST } = await import("@/app/api/tasks/[id]/action-exclude/route");
const { ArtifactMoveRollbackError } = await import("@/lib/server/task-artifacts");

const SECRET_DIR = "/Users/secret-user/Library/Application Support/Flowship/tasks/t1/artifacts";

const call = async () => {
  const res = await POST(
    new Request("http://127.0.0.1/api/tasks/t1/action-exclude", {
      method: "POST",
      body: JSON.stringify({ actionId: "a1", excluded: true }),
    }),
    { params: Promise.resolve({ id: "t1" }) },
  );
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
};

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getTask.mockReset();
  setActionArtifactExcluded.mockReset();
  getTask.mockResolvedValue({ id: "t1", runStatus: "idle", actions: [{ id: "a1", status: "done" }] });
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("action-exclude 路由：500 文案不泄绝对路径", () => {
  it("回滚失败（ArtifactMoveRollbackError）：500 + code=artifact_rollback_failed，响应体不含绝对路径；路径只进日志", async () => {
    setActionArtifactExcluded.mockRejectedValue(
      new ArtifactMoveRollbackError("t1", "a1", `${SECRET_DIR}/.excluded/plan.md`, `${SECRET_DIR}/plan.md`),
    );
    const r = await call();

    expect(r.status).toBe(500);
    expect(r.json.code).toBe("artifact_rollback_failed");
    expect(typeof r.json.error).toBe("string");
    expect(r.text).not.toContain("/Users/secret-user");
    expect(r.text).not.toContain("Application Support");
    expect(r.text).not.toContain("plan.md");
    // 文案仍然有用：说清「没回滚成功、记录与文件可能不一致」
    expect(r.json.error).toContain("回滚");
    // 详细路径只写 server 日志
    expect(errorLog.mock.calls.flat().join(" ")).toContain(`${SECRET_DIR}/.excluded/plan.md`);
  });

  it("其它失败：500 + code=exclude_failed，不回显原始 err.message（可能带路径）", async () => {
    setActionArtifactExcluded.mockRejectedValue(new Error(`EIO: i/o error, write '${SECRET_DIR}/meta.json'`));
    const r = await call();

    expect(r.status).toBe(500);
    expect(r.json.code).toBe("exclude_failed");
    expect(r.text).not.toContain("/Users/secret-user");
  });

  it("成功路径不受影响：200 + { ok, task }", async () => {
    setActionArtifactExcluded.mockResolvedValue({ id: "t1", actions: [] });
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, task: { id: "t1" } });
  });
});
