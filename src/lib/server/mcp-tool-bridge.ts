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
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "@cursor/sdk";

import { API_TOOL_NAME_MAX, mcpApiToolName } from "@/lib/mcp-tool-name";

/**
 * 单次 MCP 工具调用的超时（R14 Q11-06）：10 分钟没有任何响应 / 进度才算超时。
 * SDK 默认只有 60 秒（`DEFAULT_REQUEST_TIMEOUT_MSEC`），而 pi 路径之前没传任何选项——
 * 跑 build / 抓取 / 数据导出这类 MCP 工具，超过 1 分钟必报 `Request timed out`。
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 10 * 60_000;
/**
 * 服务端持续发进度时，单次调用的总时长上限（R14 Q11-06）：进度会让上面的超时重新计时，
 * 没有总上限的话，一个永远在报进度的 server 能把这次调用挂到天荒地老（用户只能点停止）。
 */
export const MCP_TOOL_CALL_MAX_TOTAL_MS = 30 * 60_000;

export interface McpCallOptions {
  /**
   * 用户点停止 / 任务被停时 abort：`callTool` 立即 reject，并向 server 发 `notifications/cancelled`。
   * 之前 `execute` 把 pi 传来的 signal 丢了，点停止后这次调用要一直等到超时。
   */
  signal?: AbortSignal;
}

export interface BridgedMcpTool {
  /** 送给模型的 API 名：`mcp__server__tool` */
  name: string;
  description: string;
  /** MCP 返回的 JSON Schema（工具入参描述、给 LLM function-calling 用） */
  inputSchema: unknown;
  call: (
    args: Record<string, unknown>,
    opts?: McpCallOptions,
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
): Promise<BridgedMcpServer> =>
  connectMcpServerWithTransport(serverName, buildMcpTransport(cfg));

/** 按配置造 transport：有 url → HTTP / SSE，否则 stdio 本地进程 */
const buildMcpTransport = (cfg: McpServerConfig): Transport => {
  let transport: Transport;
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
  return transport;
};

/**
 * 用造好的 transport 连接并桥接。单独导出：单测用 `InMemoryTransport` 配真 SDK server 对，
 * 能测到真实的 abort / 超时语义，不必起子进程或 HTTP 服务。
 * 连上之后任何一步失败（枚举工具抛错等）都要把 client 关掉再抛——否则 stdio 子进程 / HTTP 连接没人收
 * （R14 Q11-05；`connect` 自己失败时 SDK 会自行关闭）。
 */
export const connectMcpServerWithTransport = async (
  serverName: string,
  transport: Transport,
): Promise<BridgedMcpServer> => {
  const client = new Client({ name: "flowship", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await bridgeConnectedClient(serverName, client);
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
};

const bridgeConnectedClient = async (
  serverName: string,
  client: Client,
): Promise<BridgedMcpServer> => {
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
    call: async (args: Record<string, unknown>, opts?: McpCallOptions) => {
      const result = await client.callTool(
        { name: t.name, arguments: args },
        undefined,
        {
          signal: opts?.signal,
          timeout: MCP_TOOL_CALL_TIMEOUT_MS,
          maxTotalTimeout: MCP_TOOL_CALL_MAX_TOTAL_MS,
          // resetTimeoutOnProgress 只在请求带了进度处理器（SDK 据此才发 progressToken）时才有意义：
          // 空函数就够——我们不展示进度，只要 server 一报进度就重新计超时
          onprogress: () => {},
          resetTimeoutOnProgress: true,
        },
      );
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
