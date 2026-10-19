/**
 * GET /api/schedules（管理页数据源）的错误口径：
 *  - 正常 → 200 + `{ schedules }`（no-store）
 *  - 聚合抛错（几乎不会，但与另两个定时路由一致）→ 带 JSON 体的 500 `{ error, code: "list_failed" }`，
 *    不是 Next 默认的空 500（前端 `readError` 要能读出文案）
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.FLOWSHIP_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-list-route-"));

const mocks = vi.hoisted(() => ({ listScheduleItems: vi.fn() }));
vi.mock("@/lib/server/schedule-service", () => ({
  ensureScheduleRunnerStarted: () => {},
  listScheduleItems: mocks.listScheduleItems,
}));

const route = await import("../src/app/api/schedules/route");

beforeEach(() => {
  mocks.listScheduleItems.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /api/schedules", () => {
  it("正常：200 + schedules，不缓存", async () => {
    mocks.listScheduleItems.mockResolvedValue([{ id: "sch_a" }]);
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ schedules: [{ id: "sch_a" }] });
  });

  it("聚合抛错：带 JSON 体的 500（code=list_failed），并留一条告警", async () => {
    mocks.listScheduleItems.mockRejectedValue(new Error("EMFILE: too many open files"));
    const res = await route.GET();
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe("list_failed");
    expect(body.error).toContain("读取定时失败");
    expect(console.warn).toHaveBeenCalled();
  });
});
