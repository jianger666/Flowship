import { describe, expect, it } from "vitest";

import {
  feishuConsumerIssueDetail,
  feishuConsumerIssueTone,
  isFeishuConsumerBlocking,
} from "../src/lib/feishu-bridge-display";

describe("飞书桥接检查行：conflict 不是失败", () => {
  it("conflict 用注意态，文案讲另一处占用、不说开通/恢复", () => {
    expect(feishuConsumerIssueTone("conflict")).toBe("warning");
    expect(isFeishuConsumerBlocking("conflict")).toBe(false);
    expect(
      feishuConsumerIssueDetail({
        eventKey: "im.message.receive_v1",
        status: "conflict",
        lastError: "event_key=im.message.receive_v1 已被 pid=1 占用",
      }),
    ).toBe("本机另一处 Flowship 已在收消息");
    expect(
      feishuConsumerIssueDetail({
        eventKey: "card.action.trigger",
        status: "conflict",
      }),
    ).toBe("本机另一处 Flowship 已在处理卡片按钮");
  });

  it("unsupported 仍是失败，卡片走开通", () => {
    expect(feishuConsumerIssueTone("unsupported")).toBe("error");
    expect(isFeishuConsumerBlocking("unsupported")).toBe(true);
    expect(
      feishuConsumerIssueDetail({
        eventKey: "card.action.trigger",
        status: "unsupported",
      }),
    ).toBe("开通后可直接点卡片按钮答题");
  });

  it("error 仍是失败，收消息走恢复", () => {
    expect(feishuConsumerIssueTone("error")).toBe("error");
    expect(isFeishuConsumerBlocking("error")).toBe(true);
    expect(
      feishuConsumerIssueDetail({
        eventKey: "im.message.receive_v1",
        status: "error",
      }),
    ).toBe("恢复后才能在飞书里回消息");
  });
});
