/**
 * N3-01：facade 对 `omitGitToken` 的透传契约
 *
 * 链路：restricted-question → Agent.create / resume（facade）→ createCustomAgent / resumeCustomAgent（pi）。
 * 这里钉 facade 这一段（真实的 shell / 子代理 bash 摘除见 tests/pi-omit-git-token.test.ts；
 * restricted-question 必须传 true 见 tests/restricted-group-question.test.ts）：
 *   - pi（自定义 provider）：create / resume 传了 true 才下发；没传就**没有这个键**（属主会话默认带 token）；
 *   - Cursor：标记不下发给 SDK——SDK 继承 server env、摘不掉，这里只保证它不漏进 SDK 入参（空操作）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-agent-omit-token-"));
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

describe("pi（自定义 provider）", () => {
  it("create：传 omitGitToken:true → 下发给 createCustomAgent（旁路：同时没有 callerToken）", async () => {
    await Agent.create({
      ...baseInput,
      providerId: "cp-test",
      omitGitToken: true,
    } as never);
    expect(mockCreateCustom).toHaveBeenCalledTimes(1);
    const arg = mockCreateCustom.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.omitGitToken).toBe(true);
    expect(arg.callerToken).toBeUndefined();
  });

  it("create：没传 → 键都不存在（属主会话 / 属主 one-shot 默认照常带 token）", async () => {
    await Agent.create({ ...baseInput, providerId: "cp-test" } as never);
    const arg = mockCreateCustom.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("omitGitToken");
  });

  it("create：属主正式会话（有 callerToken、没传标记）→ 带 callerToken、不摘 token", async () => {
    await Agent.create({
      ...baseInput,
      providerId: "cp-test",
      callerToken: "tok-1",
    } as never);
    const arg = mockCreateCustom.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.callerToken).toBe("tok-1");
    expect(arg).not.toHaveProperty("omitGitToken");
  });

  it("resume：传 omitGitToken:true 同样下发", async () => {
    await Agent.resume("agent-1", {
      ...baseInput,
      providerId: "cp-test",
      omitGitToken: true,
    } as never);
    expect(mockResumeCustom).toHaveBeenCalledTimes(1);
    const arg = mockResumeCustom.mock.calls[0]![1] as Record<string, unknown>;
    expect(arg.omitGitToken).toBe(true);
  });

  it("resume：没传 → 键不存在", async () => {
    await Agent.resume("agent-1", { ...baseInput, providerId: "cp-test" } as never);
    const arg = mockResumeCustom.mock.calls[0]![1] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("omitGitToken");
  });
});

describe("Cursor provider：标记是空操作、且不漏进 SDK 入参", () => {
  it("create：传了也不下发给 @cursor/sdk（SDK 继承 server env，摘不掉）", async () => {
    await Agent.create({ ...baseInput, omitGitToken: true } as never);
    expect(mockCursorCreate).toHaveBeenCalledTimes(1);
    const arg = mockCursorCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("omitGitToken");
    expect(mockCreateCustom).not.toHaveBeenCalled();
  });

  it("resume：同样不漏进 SDK", async () => {
    await Agent.resume("agent-1", { ...baseInput, omitGitToken: true } as never);
    expect(mockCursorResume).toHaveBeenCalledTimes(1);
    const arg = mockCursorResume.mock.calls[0]![1] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("omitGitToken");
  });
});
