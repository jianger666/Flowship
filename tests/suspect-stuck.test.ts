import { describe, expect, it } from "vitest";

import {
  SUSPECT_STUCK_MS,
  isSuspectStuck,
  latestEventTs,
} from "@/lib/suspect-stuck";

describe("latestEventTs", () => {
  it("空列表是 0", () => {
    expect(latestEventTs([])).toBe(0);
  });

  it("取末条（新事件 append 在尾、上拉历史在头）", () => {
    expect(latestEventTs([{ ts: 10 }, { ts: 20 }, { ts: 50 }])).toBe(50);
  });
});

describe("isSuspectStuck", () => {
  const now = 1_000_000;

  it("非 running 不亮", () => {
    expect(isSuspectStuck(false, now - SUSPECT_STUCK_MS * 2, 0, now)).toBe(
      false,
    );
  });

  it("没有任何事件 / 直播不亮（刚起步）", () => {
    expect(isSuspectStuck(true, 0, 0, now)).toBe(false);
  });

  it("事件流一直在更新：跑超过 5 分钟也不亮", () => {
    expect(isSuspectStuck(true, now - 10_000, 0, now)).toBe(false);
  });

  it("事件流停了超过 5 分钟才亮", () => {
    expect(
      isSuspectStuck(true, now - SUSPECT_STUCK_MS - 1, 0, now),
    ).toBe(true);
    expect(isSuspectStuck(true, now - SUSPECT_STUCK_MS, 0, now)).toBe(false);
  });

  it("事件停了但流式输出还在，不亮", () => {
    expect(
      isSuspectStuck(true, now - SUSPECT_STUCK_MS * 2, now - 1000, now),
    ).toBe(false);
  });

  it("有未答提问不亮：等你答，不是卡住", () => {
    expect(
      isSuspectStuck(true, now - SUSPECT_STUCK_MS * 2, 0, now, {
        awaitingAsk: true,
      }),
    ).toBe(false);
  });
});
