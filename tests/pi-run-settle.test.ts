import { describe, expect, it } from "vitest";

import {
  readAssistantError,
  settleErrorFromTranscript,
  stickyErrorAfterMessageEnd,
} from "@/lib/pi-run-settle";

const assistant = (
  stopReason: string,
  errorMessage?: string,
): Record<string, unknown> => ({
  role: "assistant",
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
});

describe("pi-run-settle", () => {
  it("单条 503 assistant 仍算失败", () => {
    const msg = assistant("error", "Endpoint is unavailable");
    expect(readAssistantError(msg)).toBe("Endpoint is unavailable");
    expect(settleErrorFromTranscript([msg], null)).toBe(
      "Endpoint is unavailable",
    );
  });

  it("中途 503 后最后一条是 stop / toolUse → 不当失败", () => {
    const messages = [
      assistant("toolUse"),
      assistant("error", "Endpoint is unavailable"),
      assistant("toolUse"),
      assistant("stop"),
    ];
    expect(settleErrorFromTranscript(messages, "Endpoint is unavailable")).toBeNull();
  });

  it("最后一条仍是 error → 失败（重试耗尽）", () => {
    const messages = [
      assistant("toolUse"),
      assistant("error", "Endpoint is unavailable"),
    ];
    expect(settleErrorFromTranscript(messages, null)).toBe(
      "Endpoint is unavailable",
    );
  });

  it("没有 assistant 时才用粘性错误", () => {
    expect(
      settleErrorFromTranscript([{ role: "user" }], "fetch failed"),
    ).toBe("fetch failed");
    expect(settleErrorFromTranscript([], "  ")).toBeNull();
  });

  it("message_end 成功会清掉粘性 503", () => {
    const afterFail = stickyErrorAfterMessageEnd(
      null,
      assistant("error", "Endpoint is unavailable"),
    );
    expect(afterFail).toBe("Endpoint is unavailable");
    expect(
      stickyErrorAfterMessageEnd(afterFail, assistant("stop")),
    ).toBeNull();
    expect(
      stickyErrorAfterMessageEnd(afterFail, assistant("toolUse")),
    ).toBeNull();
  });

  it("缺 finish_reason 不当失败", () => {
    expect(
      readAssistantError(
        assistant("error", "Stream ended without finish_reason"),
      ),
    ).toBeNull();
  });
});
