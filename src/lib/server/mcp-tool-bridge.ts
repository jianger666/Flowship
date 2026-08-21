/**
 * 用户 MCP server → pi customTools 的桥接（pi 无 MCP、这里用官方 MCP SDK client 起连接）
 *
 * 每个 MCP server 起一个 Client、listTools 枚举工具、callTool 转发调用。
 * 送给模型的名字是 `mcp__server__tool`（Anthropic / OpenAI 工具名不允许冒号；
 * DeepSeek Anthropic 面对 `mcp:server:tool` 直接 400）。call 时仍用 MCP 原始名。
 *
 * 连接在 agent 创建时建立、agent 关闭时 close（生命周期随会话）。
 * 单个 server 连不上 / 列工具失败只 warn、不拖垮整轮（对应 cursor 侧 filterHealthyMcp 已剔除过一轮、这里再兜一层）。
 */

import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "@cursor/sdk";

import { API_TOOL_NAME_MAX, mcpApiToolName } from "@/lib/mcp-tool-name";

export interface BridgedMcpTool {
  /** 送给模型的 API 名：`mcp__server__tool` */
  name: string;
  description: string;
  /** MCP 返回的 JSON Schema（工具入参描述、给 LLM function-calling 用） */
  inputSchema: unknown;
  call: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

export interface BridgedMcpServer {
  serverName: string;
  tools: BridgedMcpTool[];
  close(): Promise<void>;
}

/** MCP callTool 返回的 content 摊成纯文本（image/其它块 JSON 化、附类型标注） */
const flattenContent = (
  content: unknown,
): Array<{ type: "text"; text: string }> => {
  const items = Array.isArray(content) ? content : [];
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      parts.push(String(item));
      continue;
    }
    const c = item as { type?: string; text?: string; mimeType?: string };
    if (c.type === "text" && typeof c.text === "string") {
      parts.push(c.text);
    } else {
      parts.push(`[${c.type ?? "block"}${c.mimeType ? `:${c.mimeType}` : ""}]`);
    }
  }
  return [{ type: "text", text: parts.join("\n") }];
};

/**
 * 连接一个用户 MCP server 并枚举其工具。
 * 连不上 / 初始化失败会 throw、由调用方 catch 后跳过该 server。
 */
export const connectMcpServer = async (
  serverName: string,
  cfg: McpServerConfig,
): Promise<BridgedMcpServer> => {
  const client = new Client({ name: "flowship", version: "0.1.0" });

  let transport;
  if ("url" in cfg) {
    const url = new URL(cfg.url);
    const headers = cfg.headers as Record<string, string> | undefined;
    const requestInit = headers ? { headers } : undefined;
    // 显式 sse / 老式 SSE 端点走 SSEClientTransport；否则 Streamable HTTP
    if (cfg.type === "sse") {
      transport = new SSEClientTransport(url, { requestInit });
    } else {
      transport = new StreamableHTTPClientTransport(url, { requestInit });
    }
  } else {
    // stdio 本地进程
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
    });
  }

  await client.connect(transport);
  const listResult = await client.listTools();
  // 同一 server 下两个工具 sanitize 后可能撞名，短 hash 拆开
  const usedNames = new Set<string>();
  const uniqueApiName = (innerName: string): string => {
    const base = mcpApiToolName(serverName, innerName);
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    const hash = createHash("sha1")
      .update(`${serverName}\0${innerName}`)
      .digest("hex")
      .slice(0, 6);
    const trimmed = base.slice(0, Math.max(1, API_TOOL_NAME_MAX - 1 - hash.length));
    const name = `${trimmed}_${hash}`;
    usedNames.add(name);
    return name;
  };
  const tools: BridgedMcpTool[] = (listResult.tools ?? []).map((t) => ({
    name: uniqueApiName(t.name),
    // description 带原始名，模型仍能对上 MCP 文档里的工具
    description: t.description
      ? `MCP ${serverName}.${t.name}：${t.description}`
      : `MCP 工具 ${serverName}.${t.name}`,
    inputSchema: t.inputSchema ?? {},
    call: async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: t.name, arguments: args });
      return {
        content: flattenContent(result.content),
        isError: result.isError === true,
      };
    },
  }));

  return {
    serverName,
    tools,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* noop */
      }
    },
  };
};
