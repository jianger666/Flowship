/**
 * MCP 工具名跨 server 撞名（pi 路径）
 *
 * 症状：server 名经 `toApiSafeToolName` 清洗 / 截 24 位后可能相同（`my.server` 与 `my_server`），
 * 两个 server 的同名工具得到同一个 API 名；pi 按名字注册 customTools，后注册的覆盖先注册的，
 * 调用悄悄路由到最后一个 server。单 server 内撞名早有 hash 拆开，跨 server 没人查。
 *
 * `dedupeBridgedToolNames`：先到先得（先注册的保留原名＝向后兼容）、后到者确定性改名 + warn。
 * 注意：它在注册侧（custom-agent-backend 的 bridgeUserMcpServers）调用才生效——本文件只钉住函数本身的行为。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_TOOL_NAME_MAX, mcpApiToolName } from "../src/lib/mcp-tool-name";
import {
  dedupeBridgedToolNames,
  type BridgedMcpServer,
  type BridgedMcpTool,
} from "../src/lib/server/mcp-tool-bridge";

const tool = (serverName: string, inner: string): BridgedMcpTool => ({
  name: mcpApiToolName(serverName, inner),
  description: `MCP ${serverName}.${inner}`,
  inputSchema: {},
  call: async () => ({ content: [{ type: "text", text: `${serverName}:${inner}` }] }),
});

const bridge = (serverName: string, inners: string[]): BridgedMcpServer => ({
  serverName,
  tools: inners.map((i) => tool(serverName, i)),
  close: async () => {},
});

const names = (bs: readonly BridgedMcpServer[]): string[] =>
  bs.flatMap((b) => b.tools.map((t) => t.name));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("前提：确实会撞", () => {
  it("清洗后相同的 server 名 + 同名工具 → 同一个 API 名（这是 bug 的来源）", () => {
    expect(mcpApiToolName("my.server", "run")).toBe(mcpApiToolName("my_server", "run"));
    const long1 = `${"a".repeat(24)}-one`;
    const long2 = `${"a".repeat(24)}-two`;
    expect(mcpApiToolName(long1, "run")).toBe(mcpApiToolName(long2, "run"));
  });
});

describe("dedupeBridgedToolNames", () => {
  it("撞名：先注册的保留原名（向后兼容），后到的改名、不再重复", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = bridge("my.server", ["run", "stop"]);
    const b = bridge("my_server", ["run", "other"]);
    const out = dedupeBridgedToolNames([a, b]);

    const all = names(out);
    expect(new Set(all).size).toBe(all.length);
    // 先注册者原样
    expect(out[0]!.tools.map((t) => t.name)).toEqual(a.tools.map((t) => t.name));
    // 后到者：不撞的不动，撞的改名
    expect(out[1]!.tools[1]!.name).toBe(b.tools[1]!.name);
    expect(out[1]!.tools[0]!.name).not.toBe(b.tools[0]!.name);
    expect(out[1]!.tools[0]!.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(out[1]!.tools[0]!.name.length).toBeLessThanOrEqual(API_TOOL_NAME_MAX);
    // 改名后仍是后到者自己的工具（call 没串）
    expect(out[1]!.tools[0]!.call).toBe(b.tools[0]!.call);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("my_server");
  });

  it("确定性：同样的输入每次得到同样的名字（与调用次数 / 其它无关 server 无关）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mk = () => [bridge("my.server", ["run"]), bridge("my_server", ["run"])];
    expect(names(dedupeBridgedToolNames(mk()))).toEqual(names(dedupeBridgedToolNames(mk())));
  });

  it("没有撞名：名字原样、不 warn、对象原样返回", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = bridge("feishu", ["add_comment", "list"]);
    const b = bridge("github", ["add_comment", "list"]);
    const out = dedupeBridgedToolNames([a, b]);
    expect(names(out)).toEqual(names([a, b]));
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
    expect(warn).not.toHaveBeenCalled();
  });

  it("三方撞名：两个后到者拿到互不相同的新名", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = dedupeBridgedToolNames([
      bridge("a.b", ["run"]),
      bridge("a_b", ["run"]),
      bridge("a b", ["run"]),
    ]);
    const all = names(out);
    expect(new Set(all).size).toBe(3);
  });

  it("名字顶满上限时改名后仍不超 64 位", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = "x".repeat(60);
    const out = dedupeBridgedToolNames([bridge("p.q", [inner]), bridge("p_q", [inner])]);
    for (const n of names(out)) expect(n.length).toBeLessThanOrEqual(API_TOOL_NAME_MAX);
    expect(new Set(names(out)).size).toBe(2);
  });

  it("不改传入对象", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = bridge("my.server", ["run"]);
    const b = bridge("my_server", ["run"]);
    const before = names([a, b]);
    dedupeBridgedToolNames([a, b]);
    expect(names([a, b])).toEqual(before);
  });
});
