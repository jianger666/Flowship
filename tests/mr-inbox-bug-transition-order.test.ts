/**
 * Q21-02：待回归「不通过」—— 先流转、后评论；评论失败不回滚、不报流转失败，响应带 commentFailed。
 *
 * 以前先发评论、再流转：流转失败（必填字段 / 权限 / 网络）时评论已经发出去了，用户重试一次就多一条「回归不通过」。
 *
 * 真路由 handler + 真 mr-inbox 常量 / route-helpers；mock 的只有 meegle CLI 与 scanner 缓存。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/meegle-cli", () => {
  class MeegleError extends Error {
    constructor(
      public readonly kind: "not_installed" | "not_authed" | "error",
      message: string,
    ) {
      super(message);
    }
  }
  return {
    MeegleError,
    fetchMyUserKey: vi.fn(),
    listBugStateTransitions: vi.fn(),
    listBugStateRequired: vi.fn(),
    addWorkitemComment: vi.fn(),
    transitionBugState: vi.fn(),
  };
});
vi.mock("@/lib/server/mr-inbox-scanner", () => ({
  invalidateMrInboxCache: vi.fn(),
  removeBugFromInboxCache: vi.fn(),
}));

import { POST } from "@/app/api/mr-inbox/bug-transition/route";
import {
  addWorkitemComment,
  fetchMyUserKey,
  listBugStateRequired,
  listBugStateTransitions,
  MeegleError,
  transitionBugState,
} from "@/lib/server/meegle-cli";
import {
  invalidateMrInboxCache,
  removeBugFromInboxCache,
} from "@/lib/server/mr-inbox-scanner";

const BUG_URL = "https://project.example.com/p1/issue/detail/101";
const BASE = { projectKey: "p1", workItemId: "101", bugUrl: BUG_URL };
const REJECT = { ...BASE, action: "reject", reason: "还是能复现" };
const PASS = { ...BASE, action: "pass" };

const post = (body: Record<string, unknown>): Promise<Response> =>
  POST(
    new Request("http://localhost/api/mr-inbox/bug-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const order = (fn: unknown): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock
    .invocationCallOrder[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchMyUserKey).mockResolvedValue("u1");
  vi.mocked(listBugStateTransitions).mockResolvedValue([
    { transitionId: "t-reopen", targetStateLabel: "REOPENED", targetStateKey: "FNB4WAesv" },
    { transitionId: "t-close", targetStateLabel: "CLOSED", targetStateKey: "BBteJzss3" },
  ]);
  vi.mocked(listBugStateRequired).mockResolvedValue([]);
  vi.mocked(addWorkitemComment).mockResolvedValue(undefined);
  vi.mocked(transitionBugState).mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("不通过：先流转、后评论", () => {
  it("顺序：流转在评论之前；评论正文是「回归不通过：原因」；响应干净（没有 commentFailed）", async () => {
    const res = await post(REJECT);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, action: "reject", bugUrl: BUG_URL, transitionId: "t-reopen" });
    expect(body).not.toHaveProperty("commentFailed");

    expect(transitionBugState).toHaveBeenCalledWith("p1", "101", "t-reopen");
    expect(addWorkitemComment).toHaveBeenCalledWith("p1", "101", "回归不通过：还是能复现");
    expect(order(transitionBugState)).toBeLessThan(order(addWorkitemComment));
    expect(removeBugFromInboxCache).toHaveBeenCalledWith(BUG_URL);
  });

  it("流转失败：评论根本没发（重试不会重复评论），缓存也不动，响应是流转的错误", async () => {
    vi.mocked(transitionBugState).mockRejectedValueOnce(
      new MeegleError("error", "流转超时"),
    );
    const res = await post(REJECT);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("流转超时");
    expect(addWorkitemComment).not.toHaveBeenCalled();
    expect(removeBugFromInboxCache).not.toHaveBeenCalled();
  });

  it("流转成功、评论失败：不回滚、不报流转失败——200 + commentFailed，bug 照样从收件箱剔除", async () => {
    vi.mocked(addWorkitemComment).mockRejectedValueOnce(
      new MeegleError("error", "评论接口超时"),
    );
    const res = await post(REJECT);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      action: "reject",
      transitionId: "t-reopen",
      commentFailed: true,
    });
    expect(transitionBugState).toHaveBeenCalledTimes(1);
    expect(removeBugFromInboxCache).toHaveBeenCalledWith(BUG_URL);
    // 原因进服务端日志，便于排查
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]![0]).toContain("评论发送失败");
  });

  it("评论因为登录过期失败（not_authed）也一样：流转已成功，不能把它翻成 401", async () => {
    vi.mocked(addWorkitemComment).mockRejectedValueOnce(
      new MeegleError("not_authed", "未登录"),
    );
    const res = await post(REJECT);
    expect(res.status).toBe(200);
    expect((await res.json()).commentFailed).toBe(true);
  });

  it("评论抛的不是 MeegleError（意外错误）：同样只标 commentFailed，不 500", async () => {
    vi.mocked(addWorkitemComment).mockRejectedValueOnce(new Error("spawn EAGAIN"));
    const res = await post(REJECT);
    expect(res.status).toBe(200);
    expect((await res.json()).commentFailed).toBe(true);
  });
});

describe("其余分支不受影响", () => {
  it("通过：不发评论，响应没有 commentFailed", async () => {
    const res = await post(PASS);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("commentFailed");
    expect(transitionBugState).toHaveBeenCalledWith("p1", "101", "t-close");
    expect(addWorkitemComment).not.toHaveBeenCalled();
  });

  it("目标状态有必填字段：409 去飞书，既不流转也不评论", async () => {
    vi.mocked(listBugStateRequired).mockResolvedValueOnce([
      { fieldKey: "root_cause", fieldName: "根因" },
    ]);
    const res = await post(REJECT);
    expect(res.status).toBe(409);
    expect(transitionBugState).not.toHaveBeenCalled();
    expect(addWorkitemComment).not.toHaveBeenCalled();
  });

  it("没有可流转的打回目标：400，不评论", async () => {
    vi.mocked(listBugStateTransitions).mockResolvedValueOnce([
      { transitionId: "t-close", targetStateLabel: "CLOSED", targetStateKey: "BBteJzss3" },
    ]);
    const res = await post(REJECT);
    expect(res.status).toBe(400);
    expect(transitionBugState).not.toHaveBeenCalled();
    expect(addWorkitemComment).not.toHaveBeenCalled();
  });

  it("不通过必须有原因：缺原因 400，什么都不发", async () => {
    const res = await post({ ...BASE, action: "reject", reason: "  " });
    expect(res.status).toBe(400);
    expect(fetchMyUserKey).not.toHaveBeenCalled();
    expect(transitionBugState).not.toHaveBeenCalled();
    expect(addWorkitemComment).not.toHaveBeenCalled();
  });

  it("就地流转（我的 BUG 状态下拉）：不评论；仍属待修只失效缓存", async () => {
    const res = await post({
      ...BASE,
      action: "transition",
      transitionId: "t-x",
      targetStateLabel: "IN PROGRESS",
    });
    expect(res.status).toBe(200);
    expect(transitionBugState).toHaveBeenCalledWith("p1", "101", "t-x");
    expect(addWorkitemComment).not.toHaveBeenCalled();
    expect(invalidateMrInboxCache).toHaveBeenCalledTimes(1);
    expect(removeBugFromInboxCache).not.toHaveBeenCalled();
  });
});
