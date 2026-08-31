import { describe, expect, it, beforeEach } from "vitest";

import {
  attachAskWaiter,
  buildAskWaitCurl,
  cancelAskWait,
  fulfillAskWait,
  getAskWait,
  hasLiveAskWaiter,
  hasParkedAskWaitReply,
  isAskWaitCommand,
  openAskWait,
  resetAskWaitForTest,
  toolArgsLookLikeAskWait,
} from "@/lib/server/ask-wait";

describe("ask-wait 槽", () => {
  beforeEach(() => {
    resetAskWaitForTest();
  });

  it("curl 挂上后 fulfill 把答案交给 waiter、不再走 send", async () => {
    openAskWait({ taskId: "t1", askId: "ask_1", token: "tok" });
    const chunks: string[] = [];
    let closed = false;
    const slot = attachAskWaiter("t1", "tok", {
      write: (c) => chunks.push(c),
      close: () => {
        closed = true;
      },
    });
    expect(slot?.askId).toBe("ask_1");
    expect(hasLiveAskWaiter("t1")).toBe(true);
    expect(
      await fulfillAskWait("t1", "ask_1", "[ASK_USER_REPLY]\n答：梅国标"),
    ).toBe(true);
    expect(chunks.join("")).toContain("[ASK_USER_REPLY]");
    expect(chunks.join("")).toContain("梅国标");
    expect(closed).toBe(true);
    expect(getAskWait("t1")).toBeNull();
  });

  it("秒答先压槽，curl 随后挂上立刻吐出、不走 send", async () => {
    openAskWait({ taskId: "t1", askId: "ask_1", token: "tok" });
    const pending = fulfillAskWait(
      "t1",
      "ask_1",
      "[ASK_USER_REPLY]\n答：梅国标",
      { attachWaitMs: 5_000 },
    );
    expect(hasParkedAskWaitReply("t1")).toBe(true);
    expect(getAskWait("t1")?.pendingReply).toContain("梅国标");

    const chunks: string[] = [];
    let closed = false;
    const slot = attachAskWaiter("t1", "tok", {
      write: (c) => chunks.push(c),
      close: () => {
        closed = true;
      },
    });
    expect(slot?.settled).toBe(true);
    expect(await pending).toBe(true);
    expect(chunks.join("")).toContain("[ASK_USER_REPLY]");
    expect(chunks.join("")).toContain("梅国标");
    expect(closed).toBe(true);
    expect(getAskWait("t1")).toBeNull();
    expect(hasParkedAskWaitReply("t1")).toBe(false);
  });

  it("没挂 curl 且超时后 fulfill 关掉槽并返回 false（调用方走 send）", async () => {
    openAskWait({ taskId: "t1", askId: "ask_1", token: "tok" });
    expect(
      await fulfillAskWait("t1", "ask_1", "[ASK_USER_REPLY]\n答：x", {
        attachWaitMs: 20,
      }),
    ).toBe(false);
    expect(getAskWait("t1")).toBeNull();
    expect(
      attachAskWaiter("t1", "tok", { write: () => {}, close: () => {} }),
    ).toBeNull();
  });

  it("token / askId 不对不能挂、也不能 fulfill", async () => {
    openAskWait({ taskId: "t1", askId: "ask_1", token: "tok" });
    expect(
      attachAskWaiter("t1", "other", { write: () => {}, close: () => {} }),
    ).toBeNull();
    expect(await fulfillAskWait("t1", "ask_other", "nope")).toBe(false);
    expect(getAskWait("t1")?.askId).toBe("ask_1");
  });

  it("新提问顶掉旧槽", () => {
    openAskWait({ taskId: "t1", askId: "ask_old", token: "a" });
    const ended: string[] = [];
    attachAskWaiter("t1", "a", {
      write: (c) => ended.push(c),
      close: () => {},
    });
    openAskWait({ taskId: "t1", askId: "ask_new", token: "b" });
    expect(ended.join("")).toContain("superseded");
    expect(getAskWait("t1")?.askId).toBe("ask_new");
  });

  it("新提问顶掉旧槽时，压着的秒答也不再等旧 curl", async () => {
    openAskWait({ taskId: "t1", askId: "ask_old", token: "a" });
    const pending = fulfillAskWait("t1", "ask_old", "[ASK_USER_REPLY]\n答：旧", {
      attachWaitMs: 5_000,
    });
    openAskWait({ taskId: "t1", askId: "ask_new", token: "b" });
    expect(await pending).toBe(false);
    expect(getAskWait("t1")?.askId).toBe("ask_new");
  });

  it("cancelAskWait 按 askId 门控，不误清新提问", () => {
    openAskWait({ taskId: "t1", askId: "ask_b", token: "b" });
    expect(cancelAskWait("t1", "stale", "ask_a")).toBe(false);
    expect(getAskWait("t1")?.askId).toBe("ask_b");
    expect(cancelAskWait("t1", "stop", "ask_b")).toBe(true);
    expect(getAskWait("t1")).toBeNull();
  });

  it("isAskWaitCommand 只认 ask-wait，不认旧 wait-ack", () => {
    expect(
      isAskWaitCommand(buildAskWaitCurl("t1", "tok")),
    ).toBe(true);
    expect(
      isAskWaitCommand("curl http://127.0.0.1:8876/api/tasks/t1/wait-ack?token=x"),
    ).toBe(false);
    expect(
      toolArgsLookLikeAskWait({ command: buildAskWaitCurl("t1", "tok") }),
    ).toBe(true);
  });
});
