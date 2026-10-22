/**
 * DELETE /api/tasks/[id] 的兜底 catch（第三轮 review D4b-04）。
 *
 * 旧实现把任何内部异常报成 `400 {"error":"bad_request"}`：状态码语义错了（不是请求的问题），
 * 用户也只会看到一句不透明的 HTTP 400。现在 500 + 可读原因，并且（沿用原语义）门闩已释放、
 * 任务没被删、重试能成功。
 */
import { describe, expect, it, vi } from "vitest";

const boom = vi.hoisted(() => ({ on: false, error: new Error("boom: disk exploded") as Error }));

vi.mock("@/lib/server/task-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-runner")>();
  return {
    ...actual,
    // DELETE 里在 journal 提交之前调用——此处抛错 = 「提交前的内部异常」，正好走到兜底 catch
    abortRunningCheck: (id: string) => {
      if (boom.on) throw boom.error;
      return actual.abortRunningCheck(id);
    },
  };
});

import { DELETE } from "@/app/api/tasks/[id]/route";
import { describeDeleteFailure } from "@/lib/server/delete-failure";
import { createTask, getTask } from "@/lib/server/task-fs";

const callDelete = (id: string) =>
  DELETE(new Request(`http://localhost/api/tasks/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

describe("DELETE 兜底 catch：内部异常 = 500 + 可读原因（不是不透明的 400）", () => {
  it("提交前的内部异常：500、带「删除失败」与原因、任务还在；清掉故障后重试成功", async () => {
    const task = await createTask({ title: "兜底失败", mode: "chat" } as never);
    boom.on = true;
    const res = await callDelete(task.id);
    boom.on = false;

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).not.toBe("bad_request");
    expect(body.error).toContain("删除失败");
    expect(body.error).toContain("boom: disk exploded");
    expect(body.error).toContain("没有被删除");
    expect(body.code).toBe("delete_failed");
    // 任务没被删、deleting 门闩已释放：重试成功
    expect(await getTask(task.id)).not.toBeNull();
    const retry = await callDelete(task.id);
    expect(retry.status).toBe(200);
    expect(await getTask(task.id)).toBeNull();
  });
});

describe("describeDeleteFailure", () => {
  it("常见系统错误码翻成人话（不暴露 errno 码）", () => {
    for (const [code, text] of [
      ["EACCES", "没有权限"],
      ["EPERM", "没有权限"],
      ["EBUSY", "占用"],
      ["ENOSPC", "磁盘空间不足"],
      ["EMFILE", "文件太多"],
    ] as const) {
      const msg = describeDeleteFailure(Object.assign(new Error(`${code}: low level`), { code }));
      expect(msg).toContain(text);
      expect(msg).not.toContain(code);
      expect(msg).toContain("可以稍后重试");
    }
  });

  it("认不出的异常带上原始 message 首行（截断）；没有 message 给「未知原因」", () => {
    expect(describeDeleteFailure(new Error("something odd\nstack line"))).toContain("something odd");
    expect(describeDeleteFailure(new Error("something odd\nstack line"))).not.toContain("stack line");
    const long = describeDeleteFailure(new Error("x".repeat(500)));
    expect(long.length).toBeLessThan(200);
    expect(long).toContain("…");
    expect(describeDeleteFailure(undefined)).toContain("未知原因");
    expect(describeDeleteFailure({})).toContain("未知原因");
  });
});
