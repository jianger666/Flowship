/**
 * POST /api/tasks/[id]/advance × `expectedCurrentActionId`（R14 Q7a-04）：route handler 行为 + 客户端接线
 *
 * 真调 handler、mock 掉 runner / 存储（同 advance-route-failure.test.ts 的夹具）：
 *  - 不带该字段（老客户端 / 飞书路径）→ 行为不变：入参里没有期望值，不校验
 *  - 带了且与入场快照一致 → 放行，并把期望值原样透传给 advanceTask（runner 排队后还要再验一次）
 *  - 带了但不一致（页面陈旧 / 重复提交 / 另一窗口抢先推进）→ 409 `advance_stale`，
 *    **先于**「落合并后删分支偏好」「存图」这些副作用，也不写事件
 *  - 入场快照一致、runner 排队后才发现被抢先推进（advanceTask 抛 ADVANCE_STALE_MESSAGE）→ 同样 409 `advance_stale`、不写事件；
 *    runner 抛的通用让位文案（停止中 / 任务已变更）不受影响，仍是 400 `advance_failed`
 *  - 值非法（数字 / 空串 / 对象）→ 400
 *  - 客户端接线：任务页提交推进时请求体带 `expectedCurrentActionId: t.currentActionId`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ADVANCE_STALE_MESSAGE } from "../src/lib/server/advance-expectation";

/** runner 的通用让位文案（TASK_OP_STALE_HTTP_MESSAGE）：与推进 CAS 的专用文案不同 */
const STALE = "正在停止/任务已变更、请重发";
const advanceTask = vi.fn();
const getTaskMeta = vi.fn();
const getTaskWithTailEvents = vi.fn();
const writeOwnedEventAndPublish = vi.fn();
const setTaskRemoveSourceBranchOnMerge = vi.fn();
const saveImageAttachments = vi.fn();
const isTaskOpStale = vi.fn(() => false);

vi.mock("@/lib/server/task-runner", () => ({
  advanceTask: (...a: unknown[]) => advanceTask(...a),
  isTaskOpStale: (...a: unknown[]) => isTaskOpStale(...(a as [])),
  TASK_OP_STALE_HTTP_MESSAGE: "正在停止/任务已变更、请重发",
}));
vi.mock("@/lib/server/task-fs", () => ({
  getTaskMeta: (...a: unknown[]) => getTaskMeta(...a),
  getTaskWithTailEvents: (...a: unknown[]) => getTaskWithTailEvents(...a),
  setTaskRemoveSourceBranchOnMerge: (...a: unknown[]) =>
    setTaskRemoveSourceBranchOnMerge(...a),
}));
vi.mock("@/lib/server/task-stream", () => ({
  getTaskOpGeneration: () => 7,
  writeOwnedEventAndPublish: (...a: unknown[]) =>
    writeOwnedEventAndPublish(...a),
}));
vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle: () => null }));
vi.mock("@/lib/server/custom-action-fs", () => ({ getCustomAction: vi.fn() }));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: (...a: unknown[]) => saveImageAttachments(...a),
}));

import { POST } from "../src/app/api/tasks/[id]/advance/route";

const call = (extra: Record<string, unknown> = {}) =>
  POST(
    new Request("http://x/api/tasks/t_1/advance", {
      method: "POST",
      body: JSON.stringify({
        actionType: "build",
        userInstruction: "改一下登录页",
        apiKey: "k",
        model: { id: "m" },
        ...extra,
      }),
    }),
    { params: Promise.resolve({ id: "t_1" }) },
  );

/** advanceTask 收到的入参（第一次调用的第一个实参） */
const advanceInput = (): Record<string, unknown> =>
  advanceTask.mock.calls[0]?.[0] as Record<string, unknown>;

const setCurrent = (currentActionId: string | null | undefined) => {
  getTaskMeta.mockResolvedValue({
    id: "t_1",
    mode: "task",
    runStatus: "idle",
    repoStatus: "developing",
    ...(currentActionId === undefined ? {} : { currentActionId }),
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  isTaskOpStale.mockReturnValue(false);
  setCurrent("act_1");
  advanceTask.mockResolvedValue({ action: { id: "act_new" } });
  getTaskWithTailEvents.mockResolvedValue({
    id: "t_1",
    runStatus: "running",
    repoStatus: "developing",
    events: [],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("advance route × expectedCurrentActionId：放行", () => {
  it("不带该字段（老客户端 / 飞书路径）：照常推进，入参里没有期望值（不校验）", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(advanceTask).toHaveBeenCalledTimes(1);
    expect(advanceInput().expectedCurrentActionId).toBeUndefined();
  });

  it("带了且与盘上当前 action 一致：放行，期望值原样透传给 advanceTask", async () => {
    const res = await call({ expectedCurrentActionId: "act_1" });
    expect(res.status).toBe(200);
    expect(advanceTask).toHaveBeenCalledTimes(1);
    expect(advanceInput().expectedCurrentActionId).toBe("act_1");
  });

  it("带 null 且盘上当前没有 action：放行，透传的是 null（不是 undefined）", async () => {
    setCurrent(null);
    const res = await call({ expectedCurrentActionId: null });
    expect(res.status).toBe(200);
    expect(advanceInput().expectedCurrentActionId).toBeNull();
  });

  it("盘上没有 currentActionId 字段（老任务）按「没有当前 action」算：带 null 放行", async () => {
    setCurrent(undefined);
    const res = await call({ expectedCurrentActionId: null });
    expect(res.status).toBe(200);
    expect(advanceTask).toHaveBeenCalledTimes(1);
  });
});

describe("advance route × expectedCurrentActionId：陈旧请求早拒绝", () => {
  it("期望的 action 与盘上不同：409 + advance_stale + 专用陈旧文案，advanceTask 没被调用", async () => {
    setCurrent("act_2");
    const res = await call({ expectedCurrentActionId: "act_1" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe(ADVANCE_STALE_MESSAGE);
    expect(body.code).toBe("advance_stale");
    expect(advanceTask).not.toHaveBeenCalled();
  });

  it("客户端以为空闲（null）、盘上其实有当前 action：409", async () => {
    setCurrent("act_1");
    const res = await call({ expectedCurrentActionId: null });
    expect(res.status).toBe(409);
    expect(advanceTask).not.toHaveBeenCalled();
  });

  it("客户端以为有 action、盘上已回到空闲：409", async () => {
    setCurrent(null);
    const res = await call({ expectedCurrentActionId: "act_1" });
    expect(res.status).toBe(409);
    expect(advanceTask).not.toHaveBeenCalled();
  });

  it("陈旧请求不产生任何副作用：不落「合并后删分支」偏好、不存图、不写事件", async () => {
    setCurrent("act_2");
    const res = await call({
      expectedCurrentActionId: "act_1",
      actionType: "ship",
      removeSourceBranch: true,
      images: [{ data: "aGVsbG8=", mimeType: "image/png", filename: "a.png" }],
    });
    expect(res.status).toBe(409);
    expect(setTaskRemoveSourceBranchOnMerge).not.toHaveBeenCalled();
    expect(saveImageAttachments).not.toHaveBeenCalled();
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
    expect(advanceTask).not.toHaveBeenCalled();
  });

  it("【对照】期望一致时同样的 ship 请求照常落偏好 + 存图（副作用没被一并吞掉）", async () => {
    saveImageAttachments.mockResolvedValue([{ absPath: "/tmp/a.png" }]);
    const res = await call({
      expectedCurrentActionId: "act_1",
      actionType: "ship",
      removeSourceBranch: true,
      images: [{ data: "aGVsbG8=", mimeType: "image/png", filename: "a.png" }],
    });
    expect(res.status).toBe(200);
    expect(setTaskRemoveSourceBranchOnMerge).toHaveBeenCalledWith("t_1", true);
    expect(saveImageAttachments).toHaveBeenCalledTimes(1);
  });

  it("入场快照一致但 runner 排队后发现已被抢先推进（advanceTask 抛专用陈旧文案）：同样 409 advance_stale、不写事件（与早拒绝同口径）", async () => {
    advanceTask.mockRejectedValue(new Error(ADVANCE_STALE_MESSAGE));
    getTaskWithTailEvents.mockResolvedValue({
      id: "t_1",
      runStatus: "idle",
      repoStatus: "developing",
      events: [],
    });
    const res = await call({ expectedCurrentActionId: "act_1" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe(ADVANCE_STALE_MESSAGE);
    expect(body.code).toBe("advance_stale");
    // 先到的那次推进其实成功了：事件流里不能多一条假的「推进失败」
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });

  it("【对照】runner 抛的是通用让位文案（停止中 / 任务已变更）：仍是 400 advance_failed、不写事件，不被当成推进陈旧", async () => {
    advanceTask.mockRejectedValue(new Error(STALE));
    getTaskWithTailEvents.mockResolvedValue({
      id: "t_1",
      runStatus: "idle",
      repoStatus: "developing",
      events: [],
    });
    const res = await call({ expectedCurrentActionId: "act_1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe(STALE);
    expect(body.code).toBe("advance_failed");
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });
});

describe("advance route × expectedCurrentActionId：非法取值", () => {
  it.each([
    ["数字", 3],
    ["空串", ""],
    ["全空白", "   "],
    ["对象", { id: "act_1" }],
    ["数组", ["act_1"]],
    ["布尔", false],
  ])("%s → 400、点名字段，不读任务也不推进", async (_name, value) => {
    const res = await call({ expectedCurrentActionId: value });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("expectedCurrentActionId");
    expect(advanceTask).not.toHaveBeenCalled();
    expect(getTaskMeta).not.toHaveBeenCalled();
  });
});

describe("客户端接线（源码扫描）：任务页提交推进时带上 expectedCurrentActionId", () => {
  it("fetch `/advance` 的请求体含 `expectedCurrentActionId: t.currentActionId`（t = 切换提供方后的 task ?? 当前 task）", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/app/tasks/[id]/page.tsx"),
      "utf8",
    );
    const at = src.indexOf("/advance`");
    expect(at).toBeGreaterThan(0);
    // 请求体就在 fetch 调用之后：往后取一段足够长的窗口
    const region = src.slice(at, at + 5000);
    expect(region).toMatch(/expectedCurrentActionId:\s*t\.currentActionId/);
    // t 的来源没被改成别的（切换提供方后用切后的 task、否则当前 task）
    expect(src).toMatch(/const t = input\.switchedTask \?\? task;/);
  });
});
