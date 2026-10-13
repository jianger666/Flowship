/**
 * pi 子代理：取消发生在「子会话创建期间」（createAgentSession 的 await 窗口）时必须真的停下。
 *
 * 旧写法：监听挂上后发现 `signal.aborted` 就调 `session.abort()`——但这时 `session.prompt()` 还没开始，
 * abort 是空操作；随后子代理照常把整轮跑完、最后才因 `signal.aborted` 丢掉结果（白烧 token，Stop 像没按）。
 * 现在：发现已取消就直接抛错、不进 prompt。
 *
 * 这条用 mock 的 createAgentSession 在「创建中途」触发 abort，确定性复现该窗口（真实端点测不出时序）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: hoisted.createAgentSession };
});

const { runPiSubagent } = await import("@/lib/server/custom-agent-backend");
type SubagentParent = import("@/lib/server/custom-agent-backend").SubagentParent;

const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-abort-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

/**
 * 假子会话：prompt() 一被调用就「跑完」（吐一段文本 + agent_end）。
 * 这样旧写法（取消后仍进 prompt）表现为「整轮跑完、最后才抛错」，断言能明确指出 prompt 被调用了，
 * 而不是卡到测试超时。
 */
const makeSession = (text = "CHILD-OK") => {
  let onEvent: ((ev: unknown) => void) | undefined;
  return {
    abort: vi.fn(async () => {}),
    prompt: vi.fn(async () => {
      onEvent?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: text },
      });
      onEvent?.({ type: "agent_end", willRetry: false });
    }),
    subscribe: vi.fn((cb: (ev: unknown) => void) => {
      onEvent = cb;
      return () => {};
    }),
    dispose: vi.fn(),
    state: { messages: [], errorMessage: null },
  };
};

/** 沿用父模型（不重建 runtime、不拉模型目录）所需的最小父会话上下文 */
const parent = {
  input: {
    kind: "custom",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1",
    format: "openai",
    model: { id: "m" },
    local: { cwd },
  },
  runtime: {},
  model: {},
  thinkingLevel: undefined,
} as unknown as SubagentParent;

const req = { prompt: "do child", subagentType: "explore" as const };

beforeEach(() => {
  hoisted.createAgentSession.mockReset();
});

describe("pi 子代理 · 创建期间被取消", () => {
  it("创建中途 abort → 直接抛「子任务已取消」，不进 prompt（不再白跑整轮）", async () => {
    const session = makeSession();
    const ac = new AbortController();
    hoisted.createAgentSession.mockImplementation(async () => {
      ac.abort(); // 正好落在「创建」这个 await 窗口里
      return { session };
    });

    await expect(
      runPiSubagent(req, ac.signal, { parent, cwd }),
    ).rejects.toThrow("子任务已取消");

    expect(session.prompt).not.toHaveBeenCalled();
    // 子会话要被释放，不能泄漏
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("创建前就已取消 → 同样抛错，且根本不创建子会话", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runPiSubagent(req, ac.signal, { parent, cwd }),
    ).rejects.toThrow("子任务已取消");
    expect(hoisted.createAgentSession).not.toHaveBeenCalled();
  });

  it("没取消：正常进 prompt 并返回文本（防止修成「一律不跑」）", async () => {
    const session = makeSession("CHILD-OK");
    hoisted.createAgentSession.mockResolvedValue({ session });

    const out = await runPiSubagent(req, new AbortController().signal, {
      parent,
      cwd,
    });
    expect(out).toBe("CHILD-OK");
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });
});
