/**
 * Cursor 路径 `subagent` 的接线（Agent facade）：谁有、谁没有、取消联动有没有装上。
 *
 * 正式会话（有 callerToken、非只读）才挂；oneshot / 受限答疑 / 只读轮次没有 callerToken 或被拦，
 * 子代理能写文件 / 跑命令，不能出现在这些受限通道里。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-cursor-subagent-wiring-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const parentCancel = vi.fn(async () => {});
const makeRun = () => ({ cancel: parentCancel, id: "run-1" });
const makeAgent = () => ({
  agentId: "agent-x",
  send: vi.fn(async () => makeRun()),
  close: vi.fn(),
});

const mockCreate = vi.fn(async (arg: unknown) => {
  void arg;
  return makeAgent();
});
const mockResume = vi.fn(async (id: string, arg: unknown) => {
  void id;
  void arg;
  return makeAgent();
});
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (arg: unknown) => mockCreate(arg),
    resume: (id: string, arg: unknown) => mockResume(id, arg),
  },
}));

const { Agent } = await import("@/lib/server/agent-backend");
const { flowShipTools } = await import("@/lib/server/flowship-tools");

const baseInput = {
  apiKey: "sk-test",
  model: { id: "composer-2.5" },
  local: { cwd: "/tmp/proj", settingSources: [] },
};

type Tools = Record<string, { description?: string; execute?: unknown; inputSchema?: unknown }>;
const customToolsOf = (arg: unknown): Tools | undefined =>
  (arg as { local?: { customTools?: Tools } }).local?.customTools;

describe("Agent.create / resume（Cursor 路）：subagent 的挂载范围", () => {
  it("正式会话（有 callerToken、非只读）：系统工具照旧 + 多一个 subagent", async () => {
    mockCreate.mockClear();
    await Agent.create({ ...baseInput, callerToken: "tok" } as never);
    const tools = customToolsOf(mockCreate.mock.calls[0][0]);
    expect(tools).toBeDefined();
    for (const t of flowShipTools) expect(tools).toHaveProperty(t.name);
    expect(tools).toHaveProperty("subagent");
    expect(typeof tools?.subagent?.execute).toBe("function");
    expect(tools?.subagent?.description).toContain("effort");
  });

  it("没有 callerToken（oneshot / 受限答疑）：不挂任何 customTools，也就没有 subagent", async () => {
    mockCreate.mockClear();
    await Agent.create({ ...baseInput } as never);
    expect(customToolsOf(mockCreate.mock.calls[0][0])).toBeUndefined();
  });

  it("只读轮次：即便带 callerToken 也不挂 subagent", async () => {
    mockCreate.mockClear();
    await Agent.create({ ...baseInput, callerToken: "tok", readOnly: true } as never);
    expect(customToolsOf(mockCreate.mock.calls[0][0])).toBeUndefined();
  });

  it("resume 同样挂（恢复的会话不能掉了子代理）", async () => {
    mockResume.mockClear();
    await Agent.resume("agent-x", { ...baseInput, callerToken: "tok" } as never);
    const tools = customToolsOf(mockResume.mock.calls[0][1]);
    expect(tools).toHaveProperty("subagent");
    expect(tools).toHaveProperty("submit_work");
  });

  it("resume + 只读 / 无 callerToken：不挂", async () => {
    mockResume.mockClear();
    await Agent.resume("agent-x", { ...baseInput, callerToken: "tok", readOnly: true } as never);
    await Agent.resume("agent-x", { ...baseInput } as never);
    expect(customToolsOf(mockResume.mock.calls[0][1])).toBeUndefined();
    expect(customToolsOf(mockResume.mock.calls[1][1])).toBeUndefined();
  });

  it("不碰父会话原有的内置工具配置：不加 disallowedTools（原生 task 照旧并存）", async () => {
    mockCreate.mockClear();
    await Agent.create({ ...baseInput, callerToken: "tok" } as never);
    const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("disallowedTools");
    expect(arg).not.toHaveProperty("tools");
  });
});

describe("Agent.create / resume：取消联动已装到返回的 agent 上", () => {
  it("send 返回的 run 仍是可 cancel 的、并且父 cancel 照常触发", async () => {
    parentCancel.mockClear();
    const agent = await Agent.create({ ...baseInput, callerToken: "tok" } as never);
    const run = await agent.send("hi");
    await run.cancel();
    expect(parentCancel).toHaveBeenCalledTimes(1);
  });

  it("没有 callerToken 的 agent 不被包装（返回的就是 SDK 给的那个对象）", async () => {
    const raw = makeAgent();
    mockCreate.mockResolvedValueOnce(raw);
    const agent = await Agent.create({ ...baseInput } as never);
    expect(agent).toBe(raw);
  });

  it("有 callerToken 的 agent 被包装、且原对象的方法没被改（spy 仍是 spy）", async () => {
    const raw = makeAgent();
    const origSend = raw.send;
    const origClose = raw.close;
    mockCreate.mockResolvedValueOnce(raw);
    const agent = await Agent.create({ ...baseInput, callerToken: "tok" } as never);
    expect(agent).not.toBe(raw);
    expect(raw.send).toBe(origSend);
    expect(raw.close).toBe(origClose);
    expect(agent.agentId).toBe("agent-x");
    await agent.send("hi");
    expect(origSend).toHaveBeenCalledWith("hi");
    agent.close();
    expect(origClose).toHaveBeenCalledTimes(1);
  });

  it("resume 回来的 agent 同样装了联动（恢复的会话停掉时子代理也要停）", async () => {
    const raw = makeAgent();
    mockResume.mockResolvedValueOnce(raw);
    const agent = await Agent.resume("agent-x", { ...baseInput, callerToken: "tok" } as never);
    expect(agent).not.toBe(raw);
    parentCancel.mockClear();
    await (await agent.send("hi")).cancel();
    expect(parentCancel).toHaveBeenCalledTimes(1);
  });

  it("resume 没有 callerToken / 只读：不被包装", async () => {
    for (const extra of [{}, { callerToken: "tok", readOnly: true }]) {
      const raw = makeAgent();
      mockResume.mockResolvedValueOnce(raw);
      const agent = await Agent.resume("agent-x", { ...baseInput, ...extra } as never);
      expect(agent).toBe(raw);
    }
  });
});
