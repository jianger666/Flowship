/**
 * 客户端 `shareToGroup` 的响应归一——这是「服务端判出死绑定」到「前端弹重建引导」
 * 之间唯一的一段接线：code 字符串写错一个字母，弹窗就永远不出现、P0 原样还在。
 * 全程 mock fetch，不打任何网络。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { shareToGroup } from "@/lib/task-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 桩一次 fetch 响应；返回被调用时的 body（断言 recreateFrom 有没有带上） */
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

const share = () =>
  shareToGroup("t1", { kind: "message", content: "正文" });

describe("shareToGroup 响应归一", () => {
  it("成功回执带群名 → 透给调用方做 toast", async () => {
    stubFetch(200, {
      ok: true,
      chatId: "oc_x",
      chatName: "登录优化需求群",
      messageId: "om_1",
      created: false,
    });
    await expect(share()).resolves.toEqual({
      ok: true,
      chatId: "oc_x",
      chatName: "登录优化需求群",
      messageId: "om_1",
      created: false,
      membershipUnknown: false,
    });
  });

  it.each(["owner_not_in_group", "group_unreachable"])(
    "%s → needGroupRebuild + 带上失效 chatId / 群名",
    async (code) => {
      stubFetch(409, {
        error: "你已不在需求群「测试需求需求群」，重建一个再分享",
        code,
        chatId: "oc_dead",
        chatName: "测试需求需求群",
      });
      await expect(share()).resolves.toMatchObject({
        ok: false,
        needGroupRebuild: true,
        chatId: "oc_dead",
        chatName: "测试需求需求群",
        needManualBotAdd: false,
      });
    },
  );

  it("bot_not_in_group 仍走加机器人引导、不误触发重建", async () => {
    stubFetch(409, {
      error: "群里还没有你的机器人「江耳的Flowship」",
      code: "bot_not_in_group",
      botLabel: "江耳的Flowship",
      chatId: "oc_x",
    });
    await expect(share()).resolves.toMatchObject({
      ok: false,
      needManualBotAdd: true,
      botLabel: "江耳的Flowship",
      needGroupRebuild: false,
    });
  });

  it("无关业务错误：两个引导都不触发", async () => {
    stubFetch(502, { error: "飞书 API 调用失败", code: "lark_error" });
    await expect(share()).resolves.toMatchObject({
      ok: false,
      needManualBotAdd: false,
      needGroupRebuild: false,
    });
  });

  it("recreateFrom 原样进请求体（服务端据此跳过复用、覆盖绑定）", async () => {
    const seen = stubFetch(200, {
      ok: true,
      chatId: "oc_fresh",
      messageId: "om_2",
      created: true,
    });
    await shareToGroup("t1", {
      kind: "message",
      content: "正文",
      recreateFrom: "oc_dead",
    });
    expect(seen.body).toMatchObject({ recreateFrom: "oc_dead" });
  });
});
