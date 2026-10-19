/**
 * 定时任务 API 路由的入参 / 错误口径（review 🟢）：
 *  - 请求体是合法 JSON 但不是对象（`null` / 数组 / 数字）→ 400，而不是读 `body.action` 抛 TypeError 变成 500
 *  - 非法会话 id（带点 / 斜杠）→ 404，不是 taskDir() 抛错变 500
 *  - 会话不存在的错误文案是中文（前端会原样 toast 出来）
 *  - 「已错过」不能取消（文件头注释曾写错）：409，要走「立即触发 / 删除记录」
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-api-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const mocks = vi.hoisted(() => ({
  getTaskMeta: vi.fn(),
  fireScheduleNow: vi.fn(),
  noteScheduleEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/task-fs", () => ({ getTaskMeta: mocks.getTaskMeta }));
vi.mock("@/lib/server/schedule-service", () => ({
  ensureScheduleRunnerStarted: () => {},
  fireScheduleNow: mocks.fireScheduleNow,
  noteScheduleEvent: mocks.noteScheduleEvent,
}));

const sidRoute = await import("../src/app/api/tasks/[id]/schedules/[sid]/route");
const listRoute = await import("../src/app/api/tasks/[id]/schedules/route");
const store = await import("../src/lib/server/schedule-store");
const { taskDir } = await import("../src/lib/server/task-fs-core");
const { markMissed } = await import("../src/lib/schedule");

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 18, 2, 0, 0);

let seq = 0;
const freshTask = async (): Promise<string> => {
  seq += 1;
  const id = `t_api_${seq}`;
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

const post = (id: string, sid: string, rawBody: string): Promise<Response> =>
  sidRoute.POST(
    new Request("http://localhost/x", { method: "POST", body: rawBody, headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ id, sid }) },
  );

const errorOf = async (res: Response): Promise<{ error?: string; code?: string }> =>
  (await res.json()) as { error?: string; code?: string };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTaskMeta.mockResolvedValue({ id: "any", mode: "chat" });
});

describe("POST /api/tasks/[id]/schedules/[sid]：请求体", () => {
  it("JSON null / 数组 / 数字 / 字符串 → 400（不是 500）", async () => {
    const id = await freshTask();
    for (const raw of ["null", "[]", "[1]", "5", '"cancel"', "true"]) {
      const res = await post(id, "sch_x", raw);
      expect(res.status, raw).toBe(400);
      expect((await errorOf(res)).error, raw).toContain("JSON 对象");
    }
  });

  it("不是合法 JSON → 400；action 缺失 / 非法 → 400", async () => {
    const id = await freshTask();
    expect((await post(id, "sch_x", "{not json")).status).toBe(400);
    expect((await post(id, "sch_x", "{}")).status).toBe(400);
    expect((await post(id, "sch_x", JSON.stringify({ action: "explode" }))).status).toBe(400);
  });
});

describe("会话 id 非法 / 不存在 → 404 + 中文文案", () => {
  it("非法 id（点 / 斜杠 / 空格）不抛、不碰 getTaskMeta", async () => {
    for (const bad of ["a.b", "..", "a b", "x%2Fy"]) {
      const res = await post(bad, "sch_x", JSON.stringify({ action: "cancel" }));
      expect(res.status, bad).toBe(404);
      expect((await errorOf(res)).error, bad).toBe("会话不存在");
      const list = await listRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: bad }) });
      expect(list.status, bad).toBe(404);
    }
    expect(mocks.getTaskMeta).not.toHaveBeenCalled();
  });

  it("会话不存在：404，文案是中文、带 code=not_found（不是裸的 not_found）", async () => {
    mocks.getTaskMeta.mockResolvedValue(null);
    const res = await post("t_none", "sch_x", JSON.stringify({ action: "pause" }));
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ error: "会话不存在", code: "not_found" });
    const list = await listRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "t_none" }) });
    expect(list.status).toBe(404);
    expect((await errorOf(list)).error).toBe("会话不存在");
  });
});

describe("cancel 的状态口径", () => {
  const input = {
    kind: "once" as const,
    title: "看 CI",
    message: "去看 CI",
    firstFireAt: NOW + 20 * MIN,
  };

  it("进行中的 → 200，并写「已取消」提示事件", async () => {
    const id = await freshTask();
    const r = await store.createSchedule(id, input, NOW);
    if (!r.ok) throw new Error(r.error);
    const res = await post(id, r.record.id, JSON.stringify({ action: "cancel" }));
    expect(res.status).toBe(200);
    expect(mocks.noteScheduleEvent).toHaveBeenCalledWith(id, r.record.id, "cancelled", expect.stringContaining("已取消"));
  });

  it("已错过的 → 409（已结束，不用取消）；只能立即触发 / 删除记录", async () => {
    const id = await freshTask();
    const r = await store.createSchedule(id, input, NOW);
    if (!r.ok) throw new Error(r.error);
    await store.mutateSchedules(id, (list) => ({
      list: list.map((x) => (x.id === r.record.id ? markMissed(x, NOW + 8 * 60 * MIN, "睡眠") : x)),
      result: null,
    }));
    const res = await post(id, r.record.id, JSON.stringify({ action: "cancel" }));
    expect(res.status).toBe(409);
    expect(mocks.noteScheduleEvent).not.toHaveBeenCalled();
    // 删除记录可以
    expect((await post(id, r.record.id, JSON.stringify({ action: "remove" }))).status).toBe(200);
  });

  it("定时不存在 → 404", async () => {
    const id = await freshTask();
    const res = await post(id, "sch_nope", JSON.stringify({ action: "pause" }));
    expect(res.status).toBe(404);
  });
});

describe("定时文件读写抛错 → 带 JSON 体的 500（不是 Next 默认的空 500）", () => {
  // schedules.json 的位置放一个目录：readFile 抛 EISDIR（非 ENOENT 的读错误），模拟 EIO / EACCES 一类
  const breakStore = async (): Promise<string> => {
    const id = await freshTask();
    await fs.mkdir(path.join(taskDir(id), "schedules.json"), { recursive: true });
    return id;
  };

  it("GET 列表：读不出来 → 500 + { error, code: read_failed }", async () => {
    const id = await breakStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await listRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(500);
      const body = await errorOf(res);
      expect(body.code).toBe("read_failed");
      expect(body.error).toContain("读取定时失败");
      // 不把 fs 的原始报错（带本机路径）原样甩给前端
      expect(body.error).not.toContain("EISDIR");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("POST 操作：读写抛错 → 500 + { error, code: store_error }", async () => {
    const id = await breakStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const action of ["cancel", "pause", "resume", "remove"]) {
        const res = await post(id, "sch_x", JSON.stringify({ action }));
        expect(res.status, action).toBe(500);
        expect((await errorOf(res)).code, action).toBe("store_error");
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("POST fire：投递链路里抛错同样是 JSON 500", async () => {
    const id = await freshTask();
    mocks.fireScheduleNow.mockRejectedValueOnce(new Error("EIO: boom /Users/x/secret"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await post(id, "sch_x", JSON.stringify({ action: "fire" }));
      expect(res.status).toBe(500);
      const body = await errorOf(res);
      expect(body.code).toBe("store_error");
      expect(JSON.stringify(body)).not.toContain("/Users/x/secret");
    } finally {
      warn.mockRestore();
    }
  });
});
