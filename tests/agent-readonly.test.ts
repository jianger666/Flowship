/**
 * 只读门禁接线用例（review P0-1 的回归护栏）。
 *
 * readOnly 必须双收敛：Cursor 走 `tools` 白名单 + 不挂系统 customTools；
 * pi 走 `buildReadOnlyToolDefs` 只留读包装。以后有人把任一半改松，用例先红。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-agent-readonly-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn(async (arg: unknown) => {
  void arg;
  return { close() {} };
});
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (arg: unknown) => mockCreate(arg),
    resume: async () => ({ close() {} }),
  },
}));

const { Agent } = await import("@/lib/server/agent-backend");

const baseInput = {
  apiKey: "sk-test",
  model: { id: "m1" },
  local: { cwd: "/tmp", settingSources: [] },
};

describe("Agent.create readOnly（Cursor 路）", () => {
  it("readOnly + callerToken → 白名单只有读类，且不挂系统 customTools", async () => {
    mockCreate.mockClear();
    await Agent.create({
      ...baseInput,
      readOnly: true,
      callerToken: "tok-1",
    } as never);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    // 白名单
    expect(arg.tools).toEqual(["read", "grep"]);
    // 系统 customTools 没挂（submit_work 这类能落盘的拿不到）
    const customTools = (arg.local as { customTools?: unknown })?.customTools;
    expect(customTools).toBeUndefined();
    // facade 字段已剥干净，不漏进 SDK
    expect(arg).not.toHaveProperty("readOnly");
    expect(arg).not.toHaveProperty("providerId");
    expect(arg).not.toHaveProperty("callerToken");
  });

  it("非只读 + callerToken → 系统 customTools 照常挂（防改过头）", async () => {
    mockCreate.mockClear();
    await Agent.create({ ...baseInput, callerToken: "tok-1" } as never);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(arg).not.toHaveProperty("tools");
    const customTools = (arg.local as { customTools?: unknown })?.customTools;
    expect(customTools).toBeDefined();
  });
});

describe("pi buildReadOnlyToolDefs", () => {
  it("只留 read/grep，无 shell/写类/子代理/MCP", async () => {
    const { buildReadOnlyToolDefs } = await import(
      "@/lib/server/pi-coding-tools"
    );
    const defs = buildReadOnlyToolDefs("/tmp");
    const names = defs
      .map((d) => (d as { name?: unknown }).name)
      .filter((n) => typeof n === "string")
      .sort();
    expect(names).toEqual(["grep", "read"]);
  });
});
