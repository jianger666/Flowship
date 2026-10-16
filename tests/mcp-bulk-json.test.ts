/**
 * MCP「高级：整体 JSON」草稿校验（S13-09）：只校验、不落盘；非法 / 保留名 / 非对象一律拒绝
 */
import { describe, expect, it } from "vitest";

import { parseBulkMcpJson } from "@/lib/mcp-config";

describe("parseBulkMcpJson", () => {
  it("合法 → ok + servers", () => {
    const r = parseBulkMcpJson(
      JSON.stringify({ mcpServers: { gh: { type: "http", url: "https://x" } } }),
    );
    expect(r).toEqual({
      ok: true,
      servers: { gh: { type: "http", url: "https://x" } },
    });
  });

  it("空 mcpServers 合法（但由用户点保存才会清空——校验层不替用户拦）", () => {
    expect(parseBulkMcpJson('{"mcpServers":{}}')).toEqual({ ok: true, servers: {} });
  });

  it("非法 JSON（编辑中途）→ 带原因的错误", () => {
    const r = parseBulkMcpJson('{"mcpServers": {');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不是合法 JSON");
  });

  it("顶层缺 mcpServers / 是数组 / 不是对象 → 拒绝", () => {
    expect(parseBulkMcpJson("{}").ok).toBe(false);
    expect(parseBulkMcpJson('{"mcpServers":[]}').ok).toBe(false);
    expect(parseBulkMcpJson("[]").ok).toBe(false);
    expect(parseBulkMcpJson("null").ok).toBe(false);
  });

  it("内置保留名 / 空名 / server 非对象 → 拒绝", () => {
    const reserved = parseBulkMcpJson('{"mcpServers":{"flowshipChat":{}}}');
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.error).toContain("flowshipChat");
    expect(parseBulkMcpJson('{"mcpServers":{"":{}}}').ok).toBe(false);
    expect(parseBulkMcpJson('{"mcpServers":{"a":"x"}}').ok).toBe(false);
    expect(parseBulkMcpJson('{"mcpServers":{"a":null}}').ok).toBe(false);
    expect(parseBulkMcpJson('{"mcpServers":{"a":[]}}').ok).toBe(false);
  });
});
