/**
 * POST /api/tasks/[id]/stop：内部抛错要变成带 JSON 体的 500（code=stop_failed），而不是 Next 默认的空 500。
 *
 * 路由整段没有 try/catch：getTask 读盘抛错（EIO / EACCES）或 stopTaskAgent 收尾抛错时，
 * 前端只拿到空 body 的 500、弹不出任何原因。与同目录 schedules 等路由同口径：console.error 记细节、
 * errorResponse(中文提示, 500, { code })，且不把原始 err.message（可能带本机路径）回给前端。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTask = vi.hoisted(() => vi.fn());
const stopTaskAgent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/task-fs", () => ({ getTask }));
vi.mock("@/lib/server/stop-task", () => ({ stopTaskAgent }));

const { POST } = await import("@/app/api/tasks/[id]/stop/route");

const call = async () => {
  const res = await POST(new Request("http://127.0.0.1/api/tasks/t1/stop", { method: "POST" }), {
    params: Promise.resolve({ id: "t1" }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
};

beforeEach(() => {
  getTask.mockReset();
  stopTaskAgent.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("stop 路由", () => {
  it("正常：200 + { ok, hadAgent, task }", async () => {
    getTask.mockResolvedValue({ id: "t1" });
    stopTaskAgent.mockResolvedValue({ hadAgent: true, task: { id: "t1", runStatus: "idle" } });
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, hadAgent: true, task: { id: "t1", runStatus: "idle" } });
  });

  it("任务不存在 → 404（不被 catch 吞成 500）", async () => {
    getTask.mockResolvedValue(null);
    const r = await call();
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not_found" });
    expect(stopTaskAgent).not.toHaveBeenCalled();
  });

  it("stopTaskAgent 抛错 → 500 + JSON 体 code=stop_failed，不回显原始 err.message", async () => {
    getTask.mockResolvedValue({ id: "t1" });
    stopTaskAgent.mockRejectedValue(new Error("EIO: i/o error, write '/Users/secret/path/meta.json'"));
    const r = await call();
    expect(r.status).toBe(500);
    expect(r.text, "改前：Next 默认的空 body 500").not.toBe("");
    expect(r.json.code).toBe("stop_failed");
    expect(typeof r.json.error).toBe("string");
    expect(r.text).not.toContain("/Users/secret");
  });

  it("getTask 读盘抛错 → 同样 500 + stop_failed", async () => {
    getTask.mockRejectedValue(new Error("EACCES"));
    const r = await call();
    expect(r.status).toBe(500);
    expect(r.json.code).toBe("stop_failed");
    expect(stopTaskAgent).not.toHaveBeenCalled();
  });
});
