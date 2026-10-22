/**
 * R2-01（第三轮 review）：带前缀的断线文案不得被判成「账户额度不足」。
 *
 * 服务端对「裸 agent run status=error」有意写一句中性文案（sdk-error.BARE_RUN_DROP_TEXT：
 * 「可能是长连接断开……也可能是 Cursor 额度·用量已用完」，刻意不断言是额度）。
 * 分类器对这句整句放行（PASSTHROUGH_RES）。但答疑 / 群答疑 / 唤醒 / agent 异常等路径会在前面加前缀
 * （「答疑失败：」等），放行正则原先锚了行首 `^\s*`，加前缀就失效 → 命中 QUOTA_STRONG_RES 的「用量已用完」
 * → 卡片写「账户额度不足」并推「去设置」。
 *
 * 行为级：直接用真实 summarizeRunFailure 产出的文案 × 真实各路径前缀 → classifyErrorText 必须 unknown。
 */
import { describe, expect, it } from "vitest";

import { classifyErrorText } from "@/lib/error-classify";
import { summarizeRunFailure } from "@/lib/server/sdk-error";

/** 仓库里实际会加在这句前面的前缀（task-runner / restricted-question / chat-runner / 唤醒路径） */
const PREFIXES = [
  "",
  "答疑失败：",
  "群答疑失败：",
  "Task agent 失败：",
  "Chat agent 异常：",
  "唤醒当前阶段失败：",
  "  答疑失败：",
] as const;

const bareDrop = (): string => {
  const s = summarizeRunFailure("agent run status=error", new Error("agent run status=error"));
  expect(s.isConnectionDrop).toBe(true);
  return s.text;
};

describe("R2-01：断线文案 × 路径前缀 → 一律放行（unknown），不被判额度", () => {
  for (const prefix of PREFIXES) {
    it(`前缀「${prefix.trim() || "（无）"}」+ 服务端真实的裸断线文案 → unknown`, () => {
      const c = classifyErrorText(`${prefix}${bareDrop()}`);
      expect(c.kind).toBe("unknown");
      expect(c.title).toBe("");
      expect(c.hint).toBe("");
    });
  }

  it("放行没有放宽到别的额度文案：带前缀的真额度错误照样判 quota", () => {
    expect(classifyErrorText("答疑失败：insufficient_quota: You exceeded your current quota").kind).toBe("quota");
    expect(classifyErrorText("Chat agent 异常：账户余额不足，请充值").kind).toBe("quota");
  });

  it("带前缀的「SDK 放弃本轮」整句同样放行（本来就不带锚点，不回归）", () => {
    const giveUp = summarizeRunFailure(
      "SDK 连续多次连接失败",
      new Error("x"),
    );
    // 不依赖具体命中哪条规则：只钉「前缀 + 服务端友好整句」不被二次归类
    expect(
      classifyErrorText(
        "答疑失败：SDK 连续多次连接失败，已放弃本轮（网络或服务端不稳）。已生成的内容保留在上方；稍后发一条消息即可接着继续。",
      ).kind,
    ).toBe("unknown");
    void giveUp;
  });
});
