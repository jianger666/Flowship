/**
 * R10-03：facade 对 `systemToolNames` 的透传契约
 *
 * 链路：task-runner.startOneShotQuestion → Agent.create / resume（facade）→ createCustomAgent / resumeCustomAgent（pi）。
 * 其它两段各有测试，唯独中间这一跳（facade → pi 后端入参）此前没人测：
 *   - 后端内部按清单收窄：tests/one-shot-system-tools.test.ts（直接给 `buildCustomTools` 清单）；
 *   - task-runner 调 `Agent.create` 时带了清单：tests/oneshot-question-bailout.test.ts；
 *   - **本文件**：`Agent.create` / `Agent.resume` 真的把清单转给 pi 后端（转丢了，pi 用户的一次性 agent 会悄悄回到
 *     「系统工具全挂」——`submit_work` / `ask_user` 又出现、让模型以为自己在 action 里）。
 * 写法照 tests/agent-backend-omit-git-token.test.ts（同一跳、`omitGitToken` 那条）。
 *
 * Cursor 路径的清单消费（收窄 customTools）在 tests/one-shot-system-tools.test.ts「能力面」；这里只补一条：
 * 清单是 facade 自己的入参，不能漏进 @cursor/sdk 的入参。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-agent-system-tool-names-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(
  path.join(DATA_DIR, "config.json"),
  JSON.stringify({
    customProviders: [
      {
        id: "cp-test",
        name: "fake",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "fake-key",
        format: "openai",
      },
    ],
  }),
);

const mockCursorCreate = vi.fn(async (arg: unknown) => {
  void arg;
  return { close() {} };
});
const mockCursorResume = vi.fn(async (id: string, arg: unknown) => {
  void id;
  void arg;
  return { close() {} };
});
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (arg: unknown) => mockCursorCreate(arg),
    resume: (id: string, arg: unknown) => mockCursorResume(id, arg),
  },
}));

const mockCreateCustom = vi.fn(async (arg: unknown) => {
  void arg;
  return { close() {} };
});
const mockResumeCustom = vi.fn(async (id: string, arg: unknown) => {
  void id;
  void arg;
  return { close() {} };
});
vi.mock("@/lib/server/custom-agent-backend", () => ({
  createCustomAgent: (arg: unknown) => mockCreateCustom(arg),
  resumeCustomAgent: (id: string, arg: unknown) => mockResumeCustom(id, arg),
  promptOnceCustom: vi.fn(),
}));

const { Agent } = await import("@/lib/server/agent-backend");
const { ONE_SHOT_SYSTEM_TOOL_NAMES } = await import("@/lib/server/one-shot-tools");

const baseInput = {
  apiKey: "sk-test",
  model: { id: "m1" },
  local: { cwd: "/tmp", settingSources: [] },
};

beforeEach(() => {
  mockCursorCreate.mockClear();
  mockCursorResume.mockClear();
  mockCreateCustom.mockClear();
  mockResumeCustom.mockClear();
});

describe("pi（自定义 provider）：systemToolNames 转给后端", () => {
  it("create：传了清单 → 后端入参里带同一份清单（同时带 callerToken，其余键不丢）", async () => {
    await Agent.create({
      ...baseInput,
      providerId: "cp-test",
      callerToken: "tok-1",
      taskId: "t1",
      systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES,
    } as never);
    expect(mockCreateCustom).toHaveBeenCalledTimes(1);
    const arg = mockCreateCustom.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.systemToolNames).toEqual(ONE_SHOT_SYSTEM_TOOL_NAMES);
    expect(arg.callerToken).toBe("tok-1");
    expect(arg.taskId).toBe("t1");
  });

  it("create：没传 → 键都不存在（正式会话 = 系统工具全挂，不能被一个空清单 / undefined 键误收窄）", async () => {
    await Agent.create({ ...baseInput, providerId: "cp-test", callerToken: "tok-1" } as never);
    const arg = mockCreateCustom.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("systemToolNames");
  });

  it("create：传了空清单也照样转（空清单 = 一个系统工具都不挂，和「不传 = 全挂」是两回事）", async () => {
    await Agent.create({
      ...baseInput,
      providerId: "cp-test",
      callerToken: "tok-1",
      systemToolNames: [],
    } as never);
    const arg = mockCreateCustom.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.systemToolNames).toEqual([]);
  });

  it("resume：传了清单同样转；没传则没有这个键", async () => {
    await Agent.resume("agent-1", {
      ...baseInput,
      providerId: "cp-test",
      callerToken: "tok-1",
      systemToolNames: ["schedule"],
    } as never);
    expect(mockResumeCustom).toHaveBeenCalledTimes(1);
    expect((mockResumeCustom.mock.calls[0]![1] as Record<string, unknown>).systemToolNames).toEqual(["schedule"]);

    await Agent.resume("agent-1", { ...baseInput, providerId: "cp-test", callerToken: "tok-1" } as never);
    expect(mockResumeCustom.mock.calls[1]![1]).not.toHaveProperty("systemToolNames");
  });
});

describe("Cursor provider：清单是 facade 自己的入参，不漏进 SDK", () => {
  it("create / resume：传了清单，@cursor/sdk 的入参里都没有 systemToolNames 键", async () => {
    await Agent.create({ ...baseInput, callerToken: "tok-1", systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES } as never);
    await Agent.resume("agent-1", {
      ...baseInput,
      callerToken: "tok-1",
      systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES,
    } as never);
    expect(mockCursorCreate.mock.calls[0]![0]).not.toHaveProperty("systemToolNames");
    expect(mockCursorResume.mock.calls[0]![1]).not.toHaveProperty("systemToolNames");
    expect(mockCreateCustom).not.toHaveBeenCalled();
    expect(mockResumeCustom).not.toHaveBeenCalled();
  });
});
