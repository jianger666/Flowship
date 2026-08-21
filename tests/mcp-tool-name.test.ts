import { describe, expect, it } from "vitest";

import {
  API_TOOL_NAME_MAX,
  isMcpToolName,
  mcpApiToolName,
  mcpDisplayName,
  toApiSafeToolName,
} from "../src/lib/mcp-tool-name";

describe("mcp-tool-name", () => {
  it("把冒号名压成 Anthropic/OpenAI 合法名", () => {
    const api = mcpApiToolName("feishu", "add_comment");
    expect(api).toBe("mcp__feishu__add_comment");
    expect(api).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(api.length).toBeLessThanOrEqual(API_TOOL_NAME_MAX);
    expect(mcpDisplayName(api)).toBe("mcp:feishu:add_comment");
  });

  it("非法字符换成下划线", () => {
    expect(toApiSafeToolName("mcp:server:tool")).toBe("mcp_server_tool");
    expect(toApiSafeToolName("foo.bar/baz")).toBe("foo_bar_baz");
    const api = mcpApiToolName("chrome-devtools", "take.screenshot");
    expect(api).toBe("mcp__chrome-devtools__take_screenshot");
    expect(api).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("超长名字截断仍合法", () => {
    const long = "a".repeat(80);
    const api = mcpApiToolName(long, long);
    expect(api.length).toBeLessThanOrEqual(API_TOOL_NAME_MAX);
    expect(api).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(api.startsWith("mcp__")).toBe(true);
  });

  it("isMcpToolName 两种前缀都认", () => {
    expect(isMcpToolName("mcp:feishu:x")).toBe(true);
    expect(isMcpToolName("mcp__feishu__x")).toBe(true);
    expect(isMcpToolName("shell")).toBe(false);
  });
});
