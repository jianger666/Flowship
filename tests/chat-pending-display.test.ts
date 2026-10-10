/**
 * chat 占位气泡展示分类 + 发出后空窗进度行触发判定（纯函数）。
 *
 * 钉死的产品语义：回车后不再出现「发送中…」虚线气泡——立即发送显示为正式气泡 + 进度行；
 * 只有排队（上一轮还在跑）和状态不明才保留待定样式。
 */
import { describe, expect, it } from "vitest";

import {
  classifyPendingBubble,
  hasInflightPending,
  shouldShowSendLoading,
} from "@/lib/chat-pending-display";

describe("classifyPendingBubble", () => {
  it("立即发送（没排队、状态正常）→ inflight：渲染成正式气泡", () => {
    expect(classifyPendingBubble({})).toBe("inflight");
    expect(classifyPendingBubble({ uncertain: false, queued: false })).toBe(
      "inflight",
    );
  });

  it("提交时 run 在跑 → queued：保留待定样式并改说「排队中」", () => {
    expect(classifyPendingBubble({ queued: true })).toBe("queued");
  });

  it("状态不明（uncertain）优先于一切：不能装作已发出，沿用旧样式", () => {
    expect(classifyPendingBubble({ uncertain: true })).toBeUndefined();
    expect(classifyPendingBubble({ uncertain: true, queued: true })).toBeUndefined();
  });
});

describe("hasInflightPending", () => {
  it("只有 inflight 才算；queued / 旧样式 / 空都不算", () => {
    expect(hasInflightPending(undefined)).toBe(false);
    expect(hasInflightPending([])).toBe(false);
    expect(hasInflightPending([{ mode: "queued" }, { mode: undefined }])).toBe(false);
    expect(hasInflightPending([{ mode: "queued" }, { mode: "inflight" }])).toBe(true);
  });
});

describe("shouldShowSendLoading", () => {
  it("原有语义不变：已受理 + 末项是用户消息 + AI 还没动静", () => {
    expect(
      shouldShowSendLoading({ isRunning: true, lastIsUser: true, hasInflight: false }),
    ).toBe(true);
    expect(
      shouldShowSendLoading({ isRunning: true, lastIsUser: false, hasInflight: false }),
    ).toBe(false);
    expect(
      shouldShowSendLoading({ isRunning: false, lastIsUser: true, hasInflight: false }),
    ).toBe(false);
  });

  it("新增：回车后、user_reply 还没落盘（runStatus 可能还没 running）就要有进度行", () => {
    // 冷路径：恢复会话那几秒 runStatus 还是 idle，且末项是上一轮的回复
    expect(
      shouldShowSendLoading({ isRunning: false, lastIsUser: false, hasInflight: true }),
    ).toBe(true);
    // 受理了但 user_reply 还没落盘的窗口：isRunning 已真、末项仍是上一轮回复
    expect(
      shouldShowSendLoading({ isRunning: true, lastIsUser: false, hasInflight: true }),
    ).toBe(true);
  });

  it("占位 → 落盘交接：两段都为真时只出一个进度行（调用方用同一个 __loading__ 项）", () => {
    expect(
      shouldShowSendLoading({ isRunning: true, lastIsUser: true, hasInflight: true }),
    ).toBe(true);
  });
});
