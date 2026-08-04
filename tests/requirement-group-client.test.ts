/**
 * 客户端 `ensureRequirementGroup` 响应归一——死绑定 code → needGroupRebuild。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureRequirementGroup } from "@/lib/task-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubFetch = (status: number, payload: unknown) => {
  const seen: { body?: Record<string, unknown> } = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      seen.body = init?.body ? JSON.parse(init.body) : undefined;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      };
    }),
  );
  return seen;
};

describe("ensureRequirementGroup 响应归一", () => {
  it("成功带回 chatId / chatName / created", async () => {
    stubFetch(200, {
      ok: true,
      chatId: "oc_x",
      chatName: "登录优化需求群",
      created: true,
    });
    await expect(ensureRequirementGroup("t1")).resolves.toEqual({
      ok: true,
      chatId: "oc_x",
      chatName: "登录优化需求群",
      created: true,
      membershipUnknown: false,
    });
  });

  it.each(["owner_not_in_group", "group_unreachable"])(
    "%s → needGroupRebuild",
    async (code) => {
      stubFetch(409, {
        error: "你已不在需求群",
        code,
        chatId: "oc_dead",
        chatName: "旧群",
      });
      await expect(ensureRequirementGroup("t1")).resolves.toMatchObject({
        ok: false,
        needGroupRebuild: true,
        chatId: "oc_dead",
        chatName: "旧群",
      });
    },
  );

  it("确认重建时带 recreateFrom", async () => {
    const seen = stubFetch(200, {
      ok: true,
      chatId: "oc_new",
      created: true,
    });
    await ensureRequirementGroup("t1", { recreateFrom: "oc_dead" });
    expect(seen.body).toEqual({ recreateFrom: "oc_dead" });
  });
});
