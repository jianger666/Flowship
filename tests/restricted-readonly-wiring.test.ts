/**
 * 群答疑「旁路」只读接线（P0 硬化 ③）——真跑 pi 后端的 create / resume，看交给 pi `createAgentSession`
 * 的工具集到底是什么：
 *
 * - `readOnly:true` → customTools / tools 白名单**只剩 read / grep / glob**：没有 shell / write / edit /
 *   delete / task / merge_test_mr（pi 自带的 readOnly 集合里有 merge_test_mr——非属主能触发合 MR，必须过滤掉）；
 *   也不桥接用户 MCP（MCP 工具对 pi 来说都是可执行的外部副作用）。
 * - create 与 resume 两条路径都要过滤（resume 是 chat-inject 常态降级路径，漏一条就是后门）。
 * - 对照：不传 readOnly 时同一输入会桥接 MCP、工具集不受限（证明断言不是空转）。
 *
 * 假 pi `createAgentSession` + 假 `connectMcpServer`，模式同 custom-agent-mcp-lifecycle.test.ts。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = mkdtempSync(path.join(os.tmpdir(), "fe-restricted-ro-"));
process.env.FLOWSHIP_DATA_DIR = TMP;

const hoisted = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  sessionOpen: vi.fn(),
  connectMcpServer: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  const SessionManager = new Proxy(actual.SessionManager, {
    get(target, key, receiver) {
      if (key === "open") return hoisted.sessionOpen;
      return Reflect.get(target, key, receiver);
    },
  });
  return { ...actual, createAgentSession: hoisted.createAgentSession, SessionManager };
});

vi.mock("@/lib/server/mcp-tool-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/mcp-tool-bridge")>();
  return { ...actual, connectMcpServer: hoisted.connectMcpServer };
});

const {
  RESTRICTED_READONLY_TOOL_NAMES,
  buildRestrictedReadOnlyToolDefs,
  createCustomAgent,
  resumeCustomAgent,
} = await import("@/lib/server/custom-agent-backend");
const { seedModelsDevCatalogForTest } = await import("@/lib/server/models-dev-catalog");

const FORBIDDEN = [
  "merge_test_mr",
  "shell",
  "bash",
  "write",
  "edit",
  "delete",
  "task",
] as const;

const makeBridge = () => ({
  serverName: "a",
  tools: [
    {
      name: "mcp__a__do",
      description: "MCP a.do",
      inputSchema: { type: "object", properties: {} },
      call: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
    },
  ],
  close: vi.fn(async () => {}),
});

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
    mcpServers: { a: { command: "x" } },
    ...extra,
  }) as never;

const existingFile = (): string => {
  const f = path.join(TMP, `sess-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(f, "");
  return f;
};

type SessionOpts = { customTools: Array<{ name: string }>; tools?: string[] };
const sessionOpts = (): SessionOpts =>
  hoisted.createAgentSession.mock.calls[0]![0] as SessionOpts;

beforeEach(() => {
  seedModelsDevCatalogForTest({});
  hoisted.connectMcpServer.mockReset();
  hoisted.connectMcpServer.mockImplementation(async () => makeBridge());
  hoisted.createAgentSession.mockReset();
  hoisted.createAgentSession.mockResolvedValue({ session: makeSession() });
  hoisted.sessionOpen.mockReset();
  hoisted.sessionOpen.mockReturnValue({
    buildSessionContext: () => ({ messages: [{ role: "user" }] }),
  });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("受限只读工具集（纯函数层）", () => {
  it("RESTRICTED_READONLY_TOOL_NAMES 恰好 read / grep / glob：不含 merge_test_mr / shell / write / edit / delete / task", () => {
    expect([...RESTRICTED_READONLY_TOOL_NAMES].sort()).toEqual(["glob", "grep", "read"]);
    for (const n of FORBIDDEN) expect(RESTRICTED_READONLY_TOOL_NAMES).not.toContain(n);
  });

  it("buildRestrictedReadOnlyToolDefs 产出的工具定义名与白名单一致，且不含任何可写 / 可执行 / 合 MR 的工具", () => {
    const defs = buildRestrictedReadOnlyToolDefs(process.cwd());
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["glob", "grep", "read"]);
    for (const n of FORBIDDEN) expect(names).not.toContain(n);
  });
});

describe("createCustomAgent / resumeCustomAgent 传 readOnly:true", () => {
  it("create：customTools 与 tools 白名单都只剩 read / grep / glob；不桥接 MCP", async () => {
    await createCustomAgent(input({ readOnly: true }));
    expect(hoisted.connectMcpServer).not.toHaveBeenCalled();
    const opts = sessionOpts();
    expect(opts.customTools.map((t) => t.name).sort()).toEqual(["glob", "grep", "read"]);
    expect([...(opts.tools ?? [])].sort()).toEqual(["glob", "grep", "read"]);
    for (const n of FORBIDDEN) {
      expect(opts.customTools.map((t) => t.name)).not.toContain(n);
      expect(opts.tools ?? []).not.toContain(n);
    }
    expect(opts.customTools.some((t) => t.name.startsWith("mcp__"))).toBe(false);
  });

  it("resume：同样只剩 read / grep / glob；不桥接 MCP（resume 是 chat-inject 的常态降级路径）", async () => {
    await resumeCustomAgent(existingFile(), input({ readOnly: true }));
    expect(hoisted.connectMcpServer).not.toHaveBeenCalled();
    const opts = sessionOpts();
    expect(opts.customTools.map((t) => t.name).sort()).toEqual(["glob", "grep", "read"]);
    expect([...(opts.tools ?? [])].sort()).toEqual(["glob", "grep", "read"]);
    for (const n of FORBIDDEN) {
      expect(opts.customTools.map((t) => t.name)).not.toContain(n);
      expect(opts.tools ?? []).not.toContain(n);
    }
  });

  it("对照：不传 readOnly → 同样输入会桥接 MCP、工具集更大（证明上面的断言不是空转）", async () => {
    await createCustomAgent(input());
    expect(hoisted.connectMcpServer).toHaveBeenCalledTimes(1);
    const opts = sessionOpts();
    const names = opts.customTools.map((t) => t.name);
    expect(names).toContain("mcp__a__do");
    expect(names.length).toBeGreaterThan(3);
  });

  it("readOnly 不是严格 true（undefined / false / 'true'）一律不当只读——也就不会误以为受限（对照，防 truthy 误判被改松）", async () => {
    await createCustomAgent(input({ readOnly: "true" }));
    expect(hoisted.connectMcpServer).toHaveBeenCalledTimes(1);
  });
});
