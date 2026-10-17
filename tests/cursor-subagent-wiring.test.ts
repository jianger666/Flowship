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

  it("挂了 subagent 就关掉 SDK 原生 task（原生 task 本地固定 composer 系、选不了模型）；不动 tools 白名单", async () => {
    mockCreate.mockClear();
    await Agent.create({ ...baseInput, callerToken: "tok" } as never);
    const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.disallowedTools).toEqual(["task"]);
    expect(arg).not.toHaveProperty("tools");
  });

  it("resume 也要关（disallowedTools 不持久化：只在 create 传、恢复的会话就会重新长出原生 task）", async () => {
    mockResume.mockClear();
    await Agent.resume("agent-x", { ...baseInput, callerToken: "tok" } as never);
    const arg = mockResume.mock.calls[0][1] as Record<string, unknown>;
    expect(arg.disallowedTools).toEqual(["task"]);
  });

  it("调用方已有的 disallowedTools 保留、只补 task；已含 task 不重复", async () => {
    mockCreate.mockClear();
    await Agent.create({
      ...baseInput,
      callerToken: "tok",
      disallowedTools: ["shell"],
    } as never);
    await Agent.create({
      ...baseInput,
      callerToken: "tok",
      disallowedTools: ["task", "shell"],
    } as never);
    expect((mockCreate.mock.calls[0][0] as Record<string, unknown>).disallowedTools).toEqual([
      "shell",
      "task",
    ]);
    expect((mockCreate.mock.calls[1][0] as Record<string, unknown>).disallowedTools).toEqual([
      "task",
      "shell",
    ]);
  });

  it("没挂 subagent 的会话（无 callerToken / 只读）：原生 task 不动——没有替代品就不能去掉", async () => {
    mockCreate.mockClear();
    mockResume.mockClear();
    await Agent.create({ ...baseInput } as never);
    await Agent.create({ ...baseInput, callerToken: "tok", readOnly: true } as never);
    await Agent.resume("agent-x", { ...baseInput } as never);
    await Agent.resume("agent-x", { ...baseInput, callerToken: "tok", readOnly: true } as never);
    for (const arg of [
      mockCreate.mock.calls[0][0],
      mockCreate.mock.calls[1][0],
      mockResume.mock.calls[0][1],
      mockResume.mock.calls[1][1],
    ] as Array<Record<string, unknown>>) {
      expect(arg).not.toHaveProperty("disallowedTools");
    }
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

  it("包装后的父 agent 能查到父模型（事件流卡片徽标用）；没挂 subagent 的查不到", async () => {
    const { getSubagentParentModel } = await import("@/lib/server/subagent-parent-model");
    const wrapped = await Agent.create({ ...baseInput, callerToken: "tok" } as never);
    expect(getSubagentParentModel(wrapped)).toEqual({ id: "composer-2.5" });
    const resumed = await Agent.resume("agent-x", { ...baseInput, callerToken: "tok" } as never);
    expect(getSubagentParentModel(resumed)).toEqual({ id: "composer-2.5" });
    const bare = await Agent.create({ ...baseInput } as never);
    expect(getSubagentParentModel(bare)).toBeUndefined();
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

describe("Agent.create / resume：run 被取消 / 会话被关时，在睡的 wait 同步叫醒（回调拿不到取消信号）", () => {
  type WaitTool = { execute: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
  const waitOf = (arg: unknown): WaitTool =>
    (customToolsOf(arg) as unknown as Record<string, WaitTool>).wait!;
  const textOf = (r: { content: Array<{ text: string }> }): string =>
    r.content.map((c) => c.text).join("");

  it("run.cancel()：本实例睡着的 wait 立刻 [WAIT_CANCELLED]，不再睡到自己的定时器", async () => {
    const { activeWaitCount } = await import("@/lib/server/session-wait");
    mockCreate.mockClear();
    const agent = await Agent.create({
      ...baseInput,
      callerToken: "tok",
      taskId: "t-wire-cancel",
    } as never);
    const sleeping = waitOf(mockCreate.mock.calls[0][0]).execute({ seconds: 600 }, {});
    expect(activeWaitCount("t-wire-cancel")).toBe(1);

    await (await agent.send("hi")).cancel();

    expect(textOf(await sleeping)).toMatch(/^\[WAIT_CANCELLED\]/);
    expect(activeWaitCount("t-wire-cancel")).toBe(0);
  });

  it("agent.close()：同样叫醒", async () => {
    const { activeWaitCount } = await import("@/lib/server/session-wait");
    mockCreate.mockClear();
    const agent = await Agent.create({
      ...baseInput,
      callerToken: "tok",
      taskId: "t-wire-close",
    } as never);
    const sleeping = waitOf(mockCreate.mock.calls[0][0]).execute({ seconds: 600 }, {});
    expect(activeWaitCount("t-wire-close")).toBe(1);

    agent.close();

    expect(textOf(await sleeping)).toMatch(/^\[WAIT_CANCELLED\]/);
    expect(activeWaitCount("t-wire-close")).toBe(0);
  });

  it("resume 回来的实例同样接上", async () => {
    const { activeWaitCount } = await import("@/lib/server/session-wait");
    mockResume.mockClear();
    const agent = await Agent.resume("agent-x", {
      ...baseInput,
      callerToken: "tok",
      taskId: "t-wire-resume",
    } as never);
    const sleeping = waitOf(mockResume.mock.calls[0][1]).execute({ seconds: 600 }, {});
    expect(activeWaitCount("t-wire-resume")).toBe(1);
    await (await agent.send("hi")).cancel();
    expect(textOf(await sleeping)).toMatch(/^\[WAIT_CANCELLED\]/);
  });

  it("同一任务的新旧实例：取消旧实例只叫醒旧实例的 wait，新实例的不受影响（懒重启 / 重连换实例）", async () => {
    const { activeWaitCount, interruptWaits } = await import("@/lib/server/session-wait");
    mockCreate.mockClear();
    const oldAgent = await Agent.create({
      ...baseInput,
      callerToken: "tok-old",
      taskId: "t-wire-two",
    } as never);
    await Agent.create({
      ...baseInput,
      callerToken: "tok-new",
      taskId: "t-wire-two",
    } as never);
    const oldSleep = waitOf(mockCreate.mock.calls[0][0]).execute({ seconds: 600 }, {});
    const newSleep = waitOf(mockCreate.mock.calls[1][0]).execute({ seconds: 600 }, {});
    expect(activeWaitCount("t-wire-two")).toBe(2);

    await (await oldAgent.send("hi")).cancel();

    expect(textOf(await oldSleep)).toMatch(/^\[WAIT_CANCELLED\]/);
    expect(activeWaitCount("t-wire-two")).toBe(1);

    // 清场：新实例那个由用户侧「跳过」叫醒
    interruptWaits("t-wire-two", "skip");
    expect(textOf(await newSleep)).toMatch(/^\[WAIT_SKIPPED\]/);
  });

  it("没有睡着的 wait 时 cancel / close 照常（不抛、不影响父 cancel）", async () => {
    parentCancel.mockClear();
    const agent = await Agent.create({
      ...baseInput,
      callerToken: "tok",
      taskId: "t-wire-idle",
    } as never);
    await (await agent.send("hi")).cancel();
    expect(parentCancel).toHaveBeenCalledTimes(1);
    expect(() => agent.close()).not.toThrow();
  });
});
