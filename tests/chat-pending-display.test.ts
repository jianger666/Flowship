/**
 * chat 占位气泡展示分类 + 发出后空窗进度行触发判定（纯函数）。
 *
 * 钉死的产品语义：回车后不再出现「发送中…」虚线气泡——立即发送显示为正式气泡 + 进度行；
 * 只有排队（上一轮还在跑）和状态不明才保留待定样式。
 *
 * 同一个空窗里输入框一侧的判定（2026-10-12 补）：气泡已经说「AI 在处理了」，输入框就必须按运行态画
 * （停止键），而不是只剩一个转圈的发送键；受理前点停止要等提交落地再停（热路径发送前快照窗口里
 * 没有占位，直接停会让 AI 在「已停止」之后被重新拉起）。
 */
import { describe, expect, it } from "vitest";

import {
  classifyPendingBubble,
  decideChatStop,
  hasInflightPending,
  settleStopIntent,
  shouldShowComposerRunning,
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

describe("shouldShowComposerRunning", () => {
  it("回车后提交还在飞、服务端还没受理（isRunning 仍假）→ 就按运行态画：不能只剩转圈的发送键", () => {
    // 实测这个窗口：热路径 1.3–2.7s、冷路径 4.5–6.7s——气泡已是正式消息、列表末尾是「准备环境…」，
    // 输入框却没有停止键，用户想停也停不了（这是本次要修的现象）
    expect(
      shouldShowComposerRunning({ isRunning: false, submitting: true, awaitingAsk: false }),
    ).toBe(true);
  });

  it("run 在跑 → 运行态（原有语义不变，含提交已落地后的常规情形）", () => {
    expect(
      shouldShowComposerRunning({ isRunning: true, submitting: false, awaitingAsk: false }),
    ).toBe(true);
    // 排队发送：run 在跑 + 又在提交
    expect(
      shouldShowComposerRunning({ isRunning: true, submitting: true, awaitingAsk: false }),
    ).toBe(true);
  });

  it("既没在跑也没在提交 → 常态发送键", () => {
    expect(
      shouldShowComposerRunning({ isRunning: false, submitting: false, awaitingAsk: false }),
    ).toBe(false);
  });

  it("有待答提问时一律不画运行态：回车 = 隐式跳过提问，输入条要保持可发", () => {
    for (const isRunning of [false, true]) {
      for (const submitting of [false, true]) {
        expect(
          shouldShowComposerRunning({ isRunning, submitting, awaitingAsk: true }),
        ).toBe(false);
      }
    }
  });
});

describe("decideChatStop", () => {
  it("提交在飞 + 服务端还没受理 → 不能直接停，等提交落地再停", () => {
    // 热路径发送前快照窗口里没有任何占位：此刻 stop 会把会话关掉，随后 sendChatMessage 发现
    // 无会话、落到「起新会话」并重新领 lease——停止后 AI 又被拉起来
    expect(decideChatStop({ submitting: true, runActive: false })).toBe("after_submit");
  });

  it("提交在飞 + 已受理（runActive 已真）→ 直接停：run 已被取消闭包持有", () => {
    // 含两种情形：agent.send 受理后到 HTTP 返回前那几十~几百 ms；以及 AI 在跑时的排队发送
    expect(decideChatStop({ submitting: true, runActive: true })).toBe("now");
  });

  it("没在提交 → 直接停（常规停止；run 没在跑时 stop 本身也是幂等的）", () => {
    expect(decideChatStop({ submitting: false, runActive: true })).toBe("now");
    expect(decideChatStop({ submitting: false, runActive: false })).toBe("now");
  });
});

describe("settleStopIntent", () => {
  it("没登记过停止意图 → 什么都不做（无论提交结果如何）", () => {
    for (const accepted of [false, true]) {
      for (const alive of [false, true]) {
        expect(settleStopIntent({ pending: false, accepted, alive })).toBe("none");
      }
    }
  });

  it("登记过 + 消息已落地 + 任务还在 → 现在兑现这次停止", () => {
    expect(settleStopIntent({ pending: true, accepted: true, alive: true })).toBe("stop");
  });

  it("登记过 + 消息没发出去（被拒 / 状态不明）→ 只收掉「停止中」外观，不 stop", () => {
    // 没有 run 可停；硬 stop 只会落一条多余的「用户停止了对话」，还把用户保留的草稿场景搅乱
    expect(settleStopIntent({ pending: true, accepted: false, alive: true })).toBe("release");
  });

  it("登记过 + 任务已删 / 已切走 → 收掉外观，不 stop（stop 只会 404、弹一条多余的错）", () => {
    expect(settleStopIntent({ pending: true, accepted: true, alive: false })).toBe("release");
    expect(settleStopIntent({ pending: true, accepted: false, alive: false })).toBe("release");
  });
});
