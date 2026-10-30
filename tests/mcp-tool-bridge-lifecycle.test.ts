/**
 * MCP 桥（pi 路径）：工具调用的超时 / 中止 + 连上后失败要关连接（R14 Q11-05 / Q11-06）
 *
 * Q11-06：pi 路径的 MCP 工具调用改前 `client.callTool({name, arguments})` 什么选项都没传——
 *   ① SDK 默认 60 秒超时：跑 build / 抓取 / 导出这类 MCP 工具，超过 1 分钟必报 `Request timed out`；
 *   ② `execute` 把 pi 传来的第 3 参 signal 丢了：用户点停止、任务被停时，abort 到不了这次调用。
 *   改后：10 分钟没有响应 / 进度才超时；服务端报进度会让超时重新计时（总时长上限 30 分钟）；signal 往下传。
 * Q11-05（连接侧）：`connect` 成功后 `listTools()` 抛错，client 不关——stdio 子进程 / HTTP 连接没人收。
 *
 * 用真 SDK 的 `Client` + 真 SDK 的 `Server`，中间是 `InMemoryTransport`（同进程配对），
 * 所以 abort / 超时 / 进度 / 取消通知都是 SDK 真实语义；`connectMcpServerWithTransport` 是为这个新开的注入口。
 * 超时类用例用假时钟（SDK 与假服务端的 setTimeout 都在同一个进程里，一起走）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectMcpServerWithTransport,
  MCP_TOOL_CALL_MAX_TOTAL_MS,
  MCP_TOOL_CALL_TIMEOUT_MS,
} from "../src/lib/server/mcp-tool-bridge";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type CallResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};
type OnCall = (args: Record<string, unknown>, extra: Extra) => Promise<CallResult>;

const text = (t: string): CallResult => ({ content: [{ type: "text", text: t }] });

/** 起一个假 MCP server（真 SDK Server）+ 配对的 client 侧 transport */
const startFake = async (opts: { onCall?: OnCall; listThrows?: boolean } = {}) => {
  const server = new Server(
    { name: "fake", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  let callCount = 0;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (opts.listThrows) throw new Error("list boom");
    return {
      tools: [
        {
          name: "work",
          description: "do some work",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    callCount += 1;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    return (opts.onCall ?? (async () => text("done")))(args, extra);
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const clientClose = vi.spyOn(clientT, "close");
  await server.connect(serverT);
  return {
    server,
    clientT,
    clientClose,
    get callCount() {
      return callCount;
    },
  };
};

const connectWork = async (opts: Parameters<typeof startFake>[0] = {}) => {
  const fake = await startFake(opts);
  const bridged = await connectMcpServerWithTransport("fake", fake.clientT);
  const tool = bridged.tools[0]!;
  return { ...fake, bridged, tool };
};

/** 把一次调用的结局收成值，避免「先 reject、后挂 catch」被当成未处理的 rejection */
const settle = <T>(p: Promise<T>) => {
  const box: { state: "pending" | "ok" | "err"; value?: T; error?: unknown } = {
    state: "pending",
  };
  void p.then(
    (value) => {
      box.state = "ok";
      box.value = value;
    },
    (error) => {
      box.state = "err";
      box.error = error;
    },
  );
  return box;
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const MIN = 60_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("常量", () => {
  it("单次调用超时 10 分钟、进度续命的总上限 30 分钟（SDK 默认 60 秒）", () => {
    expect(MCP_TOOL_CALL_TIMEOUT_MS).toBe(10 * MIN);
    expect(MCP_TOOL_CALL_MAX_TOTAL_MS).toBe(30 * MIN);
  });
});

describe("对照：桥接与调用的原有行为不变", () => {
  it("枚举工具、调用转发、content 摊平成文本（image 块带类型标注）、isError 透传", async () => {
    const { bridged, tool, bridged: b } = await connectWork({
      onCall: async (args) => ({
        content: [
          { type: "text", text: `got ${JSON.stringify(args)}` },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        isError: true,
      }),
    });
    expect(bridged.serverName).toBe("fake");
    expect(tool.name).toBe("mcp__fake__work");
    expect(tool.description).toBe("MCP fake.work：do some work");
    const r = await tool.call({ q: 1 });
    expect(r.content).toEqual([{ type: "text", text: 'got {"q":1}\n[image:image/png]' }]);
    expect(r.isError).toBe(true);
    await b.close();
  });

  it("不传第二参（改前的调用形状）仍可用", async () => {
    const { tool, bridged } = await connectWork();
    const r = await tool.call({});
    expect(r.content[0]!.text).toBe("done");
    expect(r.isError).toBe(false);
    await bridged.close();
  });

  it("传了没 abort 的 signal → 正常返回", async () => {
    const { tool, bridged } = await connectWork();
    const ac = new AbortController();
    const r = await tool.call({}, { signal: ac.signal });
    expect(r.content[0]!.text).toBe("done");
    await bridged.close();
  });
});

describe("Q11-06 · abort（用户点停止）", { timeout: 10_000 }, () => {
  it("调用进行中 abort：立刻 reject（不等超时），服务端收到取消通知", async () => {
    let serverSawAbort = false;
    const { tool, bridged } = await connectWork({
      onCall: (_args, extra) =>
        new Promise<CallResult>((_resolve, reject) => {
          extra.signal.addEventListener("abort", () => {
            serverSawAbort = true;
            reject(new Error("server side aborted"));
          });
        }),
    });
    const ac = new AbortController();
    const box = settle(tool.call({}, { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 20));
    expect(box.state).toBe("pending");
    ac.abort();
    await vi.waitFor(() => expect(box.state).toBe("err"));
    expect(msg(box.error)).toMatch(/abort/i);
    await vi.waitFor(() => expect(serverSawAbort).toBe(true));
    await bridged.close();
  });

  it("调用前就已 abort：直接 reject，请求根本没发到服务端", async () => {
    const fake = await connectWork();
    const ac = new AbortController();
    ac.abort();
    const box = settle(fake.tool.call({}, { signal: ac.signal }));
    await vi.waitFor(() => expect(box.state).toBe("err"));
    expect(fake.callCount).toBe(0);
    await fake.bridged.close();
  });
});

describe("Q11-06 · 超时（假时钟）", () => {
  it("跑 90 秒的工具不再被 60 秒默认超时掐掉（改前：Request timed out）", async () => {
    vi.useFakeTimers();
    const { tool, bridged } = await connectWork({
      onCall: async () => {
        await new Promise((r) => setTimeout(r, 90_000));
        return text("slow but done");
      },
    });
    const box = settle(tool.call({}));
    await vi.advanceTimersByTimeAsync(89_000);
    expect(box.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(box.state).toBe("ok");
    expect(box.value!.content[0]!.text).toBe("slow but done");
    await bridged.close();
  });

  it("既不回应也不报进度：恰在 10 分钟超时（不是 60 秒）", async () => {
    vi.useFakeTimers();
    const { tool, bridged } = await connectWork({
      onCall: () => new Promise<CallResult>(() => {}),
    });
    const box = settle(tool.call({}));
    await vi.advanceTimersByTimeAsync(10 * MIN - 1_000);
    expect(box.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(box.state).toBe("err");
    expect(msg(box.error)).toMatch(/timed out/i);
    await bridged.close();
  });

  it("服务端每 5 分钟报一次进度：超时重新计时，25 分钟的调用正常完成（总上限 30 分钟之内）", async () => {
    vi.useFakeTimers();
    const { tool, bridged } = await connectWork({
      onCall: async (_args, extra) => {
        for (let i = 1; i <= 5; i++) {
          await new Promise((r) => setTimeout(r, 5 * MIN));
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: extra._meta!.progressToken!, progress: i },
          });
        }
        return text("long job done");
      },
    });
    const box = settle(tool.call({}));
    await vi.advanceTimersByTimeAsync(25 * MIN + 1_000);
    expect(box.state).toBe("ok");
    expect(box.value!.content[0]!.text).toBe("long job done");
    await bridged.close();
  });

  it("服务端永远在报进度：总时长到 30 分钟强制失败（不会挂到天荒地老）", async () => {
    vi.useFakeTimers();
    const { tool, bridged } = await connectWork({
      onCall: async (_args, extra) => {
        for (let i = 1; ; i++) {
          await new Promise((r) => setTimeout(r, 5 * MIN));
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: extra._meta!.progressToken!, progress: i },
          });
        }
      },
    });
    const box = settle(tool.call({}));
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(box.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(box.state).toBe("err");
    expect(msg(box.error)).toMatch(/maximum total timeout/i);
    await bridged.close();
  });
});

describe("Q11-05 · 连上之后枚举工具失败：client 要关", () => {
  // 数「桥自己调了几次 client.close()」用 Client.prototype 上的 spy；transport.close 在 InMemoryTransport 里
  // 会因为对端互关被调两次，所以对 transport 只断言「调过 / 没调过」
  it("listTools 抛错 → client 被关闭（恰好 1 次）、连接真的关了、原始错误抛出（改前：不关，stdio 子进程泄漏）", async () => {
    const clientCloseSpy = vi.spyOn(Client.prototype, "close");
    const fake = await startFake({ listThrows: true });
    await expect(connectMcpServerWithTransport("fake", fake.clientT)).rejects.toThrow(
      /list boom/,
    );
    expect(clientCloseSpy).toHaveBeenCalledTimes(1);
    expect(fake.clientClose).toHaveBeenCalled();
  });

  it("对照：枚举成功 → 不会被桥自己关掉，要等 bridged.close()", async () => {
    const clientCloseSpy = vi.spyOn(Client.prototype, "close");
    const fake = await startFake();
    const bridged = await connectMcpServerWithTransport("fake", fake.clientT);
    expect(clientCloseSpy).not.toHaveBeenCalled();
    expect(fake.clientClose).not.toHaveBeenCalled();
    await bridged.close();
    expect(clientCloseSpy).toHaveBeenCalledTimes(1);
    expect(fake.clientClose).toHaveBeenCalled();
  });

  it("bridged.close() 重复调用 / 关闭失败都不抛", async () => {
    const fake = await startFake();
    const bridged = await connectMcpServerWithTransport("fake", fake.clientT);
    await bridged.close();
    await expect(bridged.close()).resolves.toBeUndefined();
    // 真的让底层 client.close() reject 一次（旧版只测了重复调用，标题里的「关闭失败」没有被模拟）
    const fake2 = await startFake();
    const bridged2 = await connectMcpServerWithTransport("fake", fake2.clientT);
    vi.spyOn(Client.prototype, "close").mockRejectedValueOnce(new Error("close boom"));
    await expect(bridged2.close()).resolves.toBeUndefined();
  });

  it("listTools 抛错且 client.close() 也抛错 → 仍抛原始 list 错误（关闭失败不能盖掉真因）", async () => {
    vi.spyOn(Client.prototype, "close").mockRejectedValueOnce(new Error("close boom"));
    const fake = await startFake({ listThrows: true });
    await expect(connectMcpServerWithTransport("fake", fake.clientT)).rejects.toThrow(
      /list boom/,
    );
  });
});
