/**
 * pi 后端 create / resume 与 MCP 桥的生命周期（R14 Q11-05 / Q11-06）
 *
 * Q11-05：改前 `createCustomAgent` / `resumeCustomAgent` 先桥接用户 MCP（每个 stdio server 起一个子进程），
 *   `closeAll` 只挂在「成功返回的 adapter」上——之后任何一步抛错（建会话失败、resume 的「会话文件缺失 / 为空」
 *   这种设计内的确定性失败），已经连上的 MCP 子进程都没人关，一直活到 app 退出。
 *   resume 降级新会话是常态路径（chat-inject 靠 E_SESSION_MISSING / E_SESSION_EMPTY 降级），所以会反复泄漏。
 *   改后：resume 的缺文件 / 空会话检查排在桥接**之前**（根本不连）；桥接之后的失败由 create / resume 自己关。
 * Q11-06（接线侧）：MCP 工具的 `execute` 第 3 参（pi 传来的 AbortSignal）原样传给桥，点停止才能中止这次调用。
 *
 * 假 pi `createAgentSession` + 假 `connectMcpServer`（计数 connect / close）；SessionManager.open 可替换
 * （其余成员走真实现）。真 SDK 语义的超时 / 中止在 mcp-tool-bridge-lifecycle.test.ts。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP = mkdtempSync(path.join(os.tmpdir(), "fe-custom-agent-mcp-"));
process.env.FLOWSHIP_DATA_DIR = TMP;

const hoisted = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  sessionOpen: vi.fn(),
  connectMcpServer: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  // SessionManager 是带静态方法的类：只替换 open，其余（create / inMemory…）透传真实现
  const SessionManager = new Proxy(actual.SessionManager, {
    get(target, key, receiver) {
      if (key === "open") return hoisted.sessionOpen;
      return Reflect.get(target, key, receiver);
    },
  });
  return { ...actual, createAgentSession: hoisted.createAgentSession, SessionManager };
});

vi.mock("@/lib/server/mcp-tool-bridge", () => ({
  connectMcpServer: hoisted.connectMcpServer,
}));

const { createCustomAgent, resumeCustomAgent } = await import(
  "@/lib/server/custom-agent-backend"
);
const { seedModelsDevCatalogForTest } = await import("@/lib/server/models-dev-catalog");

type FakeBridge = ReturnType<typeof makeBridge>;
const makeBridge = (name: string) => {
  const close = vi.fn(async () => {});
  const call = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
  return {
    serverName: name,
    tools: [
      {
        name: `mcp__${name}__do`,
        description: `MCP ${name}.do`,
        inputSchema: { type: "object", properties: {} },
        call,
      },
    ],
    close,
    call,
  };
};

let bridges: Record<string, FakeBridge> = {};

const makeSession = () => ({
  sessionFile: "fake-session-file",
  sessionId: "fake-session",
  abort: vi.fn(async () => {}),
  dispose: vi.fn(),
  state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
  subscribe: vi.fn(() => () => {}),
  prompt: vi.fn(async () => {}),
});

const input = (extra: Record<string, unknown> = {}) =>
  ({
    kind: "custom",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1",
    format: "openai",
    model: { id: "m" },
    local: { cwd: process.cwd() },
    mcpServers: { a: { command: "x" }, b: { command: "y" } },
    ...extra,
  }) as never;

/** 一个真实存在的（空）文件：让 resume 的「文件存在」检查通过，空会话由 sessionOpen 的假返回值表达 */
const existingFile = (): string => {
  const f = path.join(TMP, `sess-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(f, "");
  return f;
};

beforeEach(() => {
  seedModelsDevCatalogForTest({});
  bridges = { a: makeBridge("a"), b: makeBridge("b") };
  hoisted.connectMcpServer.mockReset();
  hoisted.connectMcpServer.mockImplementation(async (name: string) => bridges[name]);
  hoisted.createAgentSession.mockReset();
  hoisted.sessionOpen.mockReset();
  hoisted.sessionOpen.mockReturnValue({
    buildSessionContext: () => ({ messages: [{ role: "user" }] }),
  });
});

const closeCounts = () => [bridges.a!.close.mock.calls.length, bridges.b!.close.mock.calls.length];

describe("createCustomAgent · 建会话失败要关 MCP（Q11-05）", { timeout: 5000 }, () => {
  it("createAgentSession 抛错 → 两个 MCP 各被关 1 次，原始错误原样抛出（改前：连了 2 个、关 0 个）", async () => {
    hoisted.createAgentSession.mockRejectedValue(new Error("session boom"));
    await expect(createCustomAgent(input())).rejects.toThrow("session boom");
    expect(hoisted.connectMcpServer).toHaveBeenCalledTimes(2);
    expect(closeCounts()).toEqual([1, 1]);
  });

  it("对照：成功 → 创建期间不关；agent.close() 才关（各 1 次）", async () => {
    hoisted.createAgentSession.mockResolvedValue({ session: makeSession() });
    const agent = await createCustomAgent(input());
    expect(closeCounts()).toEqual([0, 0]);
    agent.close();
    expect(closeCounts()).toEqual([1, 1]);
  });

  it("MCP 的 close 自己 reject 也不盖掉原始错误、不产生未处理的 rejection", async () => {
    bridges.a!.close.mockRejectedValue(new Error("close boom"));
    hoisted.createAgentSession.mockRejectedValue(new Error("session boom"));
    await expect(createCustomAgent(input())).rejects.toThrow("session boom");
    await new Promise((r) => setTimeout(r, 10));
    expect(closeCounts()).toEqual([1, 1]);
  });

  it("MCP 的 close 同步抛错（不是 reject）也不盖掉原始错误（清理本身绝不能吞掉真因）", async () => {
    bridges.a!.close.mockImplementation(() => {
      throw new Error("sync close boom");
    });
    hoisted.createAgentSession.mockRejectedValue(new Error("session boom"));
    await expect(createCustomAgent(input())).rejects.toThrow("session boom");
    expect(bridges.a!.close).toHaveBeenCalledTimes(1);
  });

  it("没配 MCP 时失败路径照常抛原始错误（对照）", async () => {
    hoisted.createAgentSession.mockRejectedValue(new Error("session boom"));
    await expect(createCustomAgent(input({ mcpServers: undefined }))).rejects.toThrow(
      "session boom",
    );
    expect(hoisted.connectMcpServer).not.toHaveBeenCalled();
  });
});

describe("resumeCustomAgent · 确定性失败不连 MCP、桥接后失败要关（Q11-05）", { timeout: 5000 }, () => {
  it("会话文件缺失 → E_SESSION_MISSING，且一个 MCP 都没连（改前：连 2 个、关 0 个）", async () => {
    await expect(
      resumeCustomAgent(path.join(TMP, "no-such-session.jsonl"), input()),
    ).rejects.toMatchObject({ code: "E_SESSION_MISSING" });
    expect(hoisted.connectMcpServer).not.toHaveBeenCalled();
    expect(hoisted.createAgentSession).not.toHaveBeenCalled();
  });

  it("会话为空 → E_SESSION_EMPTY，同样一个 MCP 都没连", async () => {
    hoisted.sessionOpen.mockReturnValue({ buildSessionContext: () => ({ messages: [] }) });
    await expect(resumeCustomAgent(existingFile(), input())).rejects.toMatchObject({
      code: "E_SESSION_EMPTY",
    });
    expect(hoisted.connectMcpServer).not.toHaveBeenCalled();
    expect(hoisted.createAgentSession).not.toHaveBeenCalled();
  });

  it("检查通过但 createAgentSession 抛错 → 两个 MCP 各被关 1 次，原始错误抛出", async () => {
    hoisted.createAgentSession.mockRejectedValue(new Error("resume boom"));
    await expect(resumeCustomAgent(existingFile(), input())).rejects.toThrow("resume boom");
    expect(hoisted.connectMcpServer).toHaveBeenCalledTimes(2);
    expect(closeCounts()).toEqual([1, 1]);
  });

  it("对照：resume 成功 → 创建期间不关；agent.close() 才关（各 1 次）", async () => {
    hoisted.createAgentSession.mockResolvedValue({ session: makeSession() });
    const agent = await resumeCustomAgent(existingFile(), input());
    expect(closeCounts()).toEqual([0, 0]);
    agent.close();
    expect(closeCounts()).toEqual([1, 1]);
  });

  it("没配 MCP 的 resume 缺文件 → 照常抛 E_SESSION_MISSING（对照，降级路径不受影响）", async () => {
    await expect(
      resumeCustomAgent(path.join(TMP, "gone.jsonl"), input({ mcpServers: undefined })),
    ).rejects.toMatchObject({ code: "E_SESSION_MISSING" });
  });
});

describe("MCP 工具的 execute 把 pi 传来的 signal 往下传（Q11-06 接线）", { timeout: 5000 }, () => {
  type ToolDef = {
    name: string;
    execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  };
  const mcpToolFromCreate = async (): Promise<ToolDef> => {
    hoisted.createAgentSession.mockResolvedValue({ session: makeSession() });
    await createCustomAgent(input());
    const opts = hoisted.createAgentSession.mock.calls[0]![0] as { customTools: ToolDef[] };
    return opts.customTools.find((t) => t.name === "mcp__a__do")!;
  };

  it("有 signal → 原样（同一个对象）传给桥的 call", async () => {
    const tool = await mcpToolFromCreate();
    const ac = new AbortController();
    await tool.execute("call-1", { x: 1 }, ac.signal);
    expect(bridges.a!.call).toHaveBeenCalledTimes(1);
    const [args, opts] = bridges.a!.call.mock.calls[0] as unknown as [
      unknown,
      { signal?: AbortSignal },
    ];
    expect(args).toEqual({ x: 1 });
    expect(opts.signal).toBe(ac.signal);
  });

  it("没有 signal（旧调用形状）→ 照常调用，signal 为 undefined", async () => {
    const tool = await mcpToolFromCreate();
    await tool.execute("call-2", { y: 2 });
    const [, opts] = bridges.a!.call.mock.calls[0] as unknown as [
      unknown,
      { signal?: AbortSignal },
    ];
    expect(opts.signal).toBeUndefined();
  });

  it("工具返回的 content 与 isError 标记仍原样转出（对照）", async () => {
    bridges.a!.call.mockResolvedValueOnce({
      content: [{ type: "text" as const, text: "boom" }],
      isError: true,
    } as never);
    const tool = await mcpToolFromCreate();
    const r = (await tool.execute("call-3", {})) as {
      content: unknown;
      details?: { isError?: boolean };
    };
    expect(r.content).toEqual([{ type: "text", text: "boom" }]);
    expect(r.details).toEqual({ isError: true });
  });
});
