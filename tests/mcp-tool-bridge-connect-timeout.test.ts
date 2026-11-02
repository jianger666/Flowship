/**
 * MCP 桥：建连 / 枚举工具的显式超时（P3）
 *
 * 改前 `client.connect(transport)` 与 `client.listTools()` 都没有显式超时：
 * SDK 只给「请求」默认 60 秒，`transport.start()`（SSE 等一个永远不来的 endpoint 事件、HTTP 连接建不起来）不在其内，
 * server 不吭声就把整轮 agent 创建挂住。现在：建连整段有硬上限（超时关 client 再抛），listTools 带显式超时。
 * 调用方（bridgeUserMcpServers）本来就 catch 后跳过单个 server，所以只需「会抛、且资源收干净」。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import {
  connectMcpServerWithTransport,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_LIST_TOOLS_TIMEOUT_MS,
} from "../src/lib/server/mcp-tool-bridge";

describe("MCP 桥超时常量", () => {
  it("保守取值：建连 60s（stdio 首次 npx 下包慢）、listTools 30s", () => {
    expect(MCP_CONNECT_TIMEOUT_MS).toBe(60_000);
    expect(MCP_LIST_TOOLS_TIMEOUT_MS).toBe(30_000);
  });
});

describe("建连超时", () => {
  it("transport.start() 永远不返回 → 超时抛错，并关掉 transport（不留悬挂连接）", async () => {
    const close = vi.fn(async () => {});
    const hanging: Transport = {
      start: () => new Promise<void>(() => {}),
      send: async () => {},
      close,
    };
    const t0 = Date.now();
    await expect(
      connectMcpServerWithTransport("stuck", hanging, { connectMs: 60 }),
    ).rejects.toThrow(/连接超时/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(close).toHaveBeenCalled();
  });

  it("正常 server 不受影响：在超时内建连成功、工具照常枚举", async () => {
    const server = new Server(
      { name: "fake", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "ping",
          description: "ping",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    }));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const bridged = await connectMcpServerWithTransport("ok", clientT, {
      connectMs: 5_000,
      listToolsMs: 5_000,
    });
    expect(bridged.tools.map((t) => t.name)).toEqual(["mcp__ok__ping"]);
    await bridged.close();
  });
});

describe("listTools 超时", () => {
  it("server 握手后永不回应 tools/list → 超时抛错，并关掉 client（transport.close 被调用）", async () => {
    const server = new Server(
      { name: "slow", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(
      ListToolsRequestSchema,
      () => new Promise<never>(() => {}),
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const clientClose = vi.spyOn(clientT, "close");
    await server.connect(serverT);

    const t0 = Date.now();
    await expect(
      connectMcpServerWithTransport("slow", clientT, {
        connectMs: 5_000,
        listToolsMs: 80,
      }),
    ).rejects.toThrow(/timed out|超时/i);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(clientClose).toHaveBeenCalled();
  });
});
