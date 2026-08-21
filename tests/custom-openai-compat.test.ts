import { describe, expect, it } from "vitest";

import {
  OPENAI_STREAM_COMPAT,
  fatalAssistantError,
  isBenignOpenAiStreamEnd,
} from "@/lib/custom-openai-compat";

describe("custom-openai-compat", () => {
  it("OpenAI 兼容流不要求 finish_reason，避免残缺收尾被当失败", () => {
    expect(OPENAI_STREAM_COMPAT.supportsFinishReason).toBe(false);
    expect(OPENAI_STREAM_COMPAT.supportsUsageInStreaming).toBe(false);
    expect(OPENAI_STREAM_COMPAT.maxTokensField).toBe("max_tokens");
  });

  it("缺 finish_reason 不当致命错误，HTTP 400 仍算失败", () => {
    expect(isBenignOpenAiStreamEnd("Stream ended without finish_reason")).toBe(
      true,
    );
    expect(fatalAssistantError("Stream ended without finish_reason")).toBeNull();
    expect(fatalAssistantError("Invalid tool name: mcp:foo:bar")).toBe(
      "Invalid tool name: mcp:foo:bar",
    );
    expect(fatalAssistantError("  ")).toBeNull();
    expect(fatalAssistantError(undefined)).toBeNull();
  });
});
