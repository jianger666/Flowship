/**
 * pi 后端：非属主并入同会话的那一轮，工具集按轮次收窄到 read / grep / glob + wait。
 *
 * 假 pi `createAgentSession`（同 restricted-readonly-wiring 的手法），钉死：
 * - 非属主标记在 → send 前 setActiveToolsByName(read/grep/glob/wait)，并记下收窄前的完整集
 * - 标记不在的下一次 send → 按记下的完整集切回（惰性恢复，不依赖「轮次结束」钩子）
 * - 没标记的普通 send 不碰工具集（对照：证明不是每次 send 都在切）
 * - 切换抛错只告警、不挡这一轮（best-effort，兜底仍有提示词 + 系统工具硬拒）
 * - readOnly 旁路 / 无 taskId 的会话不参与
 *
 * 注：这里验证的是 Flowship 侧的调用时机与名单；pi 内部「下一轮 prompt 生效、重建系统提示词」
 * 来自对 pi 0.84.2 源码（agent-session.js setActiveToolsByName）的阅读，没有真跑 pi 会话。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = mkdtempSync(path.join(os.tmpdir(), "fe-pi-non-owner-tools-"));
process.env.FLOWSHIP_DATA_DIR = TMP;

const hoisted = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: hoisted.createAgentSession };
});

const {
  NON_OWNER_TURN_PI_TOOL_NAMES,
  RESTRICTED_READONLY_TOOL_NAMES,
  createCustomAgent,
} = await import("@/lib/server/custom-agent-backend");
const { seedModelsDevCatalogForTest } = await import("@/lib/server/models-dev-catalog");
const {
  __resetNonOwnerTurnGuardForTest,
  beginNonOwnerTurn,
  clearNonOwnerTurn,
} = await import("@/lib/server/non-owner-turn-guard");

const FULL = ["read", "edit", "write", "grep", "shell", "glob", "wait", "submit_work"];

const makeSession = () => {
  let active = [...FULL];
  const setActiveToolsByName = vi.fn((names: string[]) => {
    active = [...names];
  });
  return {
    sessionFile: "fake-session-file",
    sessionId: "fake-session",
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {}),
    getActiveToolNames: vi.fn(() => [...active]),
    setActiveToolsByName,
    activeNow: () => [...active],
  };
};

const input = (extra: Record<string, unknown> = {}) =>
  ({
    kind: "custom",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1",
    format: "openai",
    model: { id: "m" },
    local: { cwd: process.cwd() },
    taskId: "t1",
    ...extra,
  }) as never;

const sendOpts = {} as never;

let session: ReturnType<typeof makeSession>;
beforeEach(() => {
  __resetNonOwnerTurnGuardForTest();
  seedModelsDevCatalogForTest({});
  session = makeSession();
  hoisted.createAgentSession.mockReset();
  hoisted.createAgentSession.mockResolvedValue({ session });
});
afterEach(() => __resetNonOwnerTurnGuardForTest());
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("非属主一轮的 pi 工具集收窄", () => {
  it("名单恰好 read / grep / glob + wait：没有写 / shell / 删除 / 子代理 / MCP / 系统工具", () => {
    expect([...NON_OWNER_TURN_PI_TOOL_NAMES].sort()).toEqual(
      [...RESTRICTED_READONLY_TOOL_NAMES, "wait"].sort(),
    );
    for (const n of ["write", "edit", "shell", "bash", "delete", "task", "submit_work", "ask_user", "merge_test_mr"]) {
      expect(NON_OWNER_TURN_PI_TOOL_NAMES).not.toContain(n);
    }
  });

  it("标记在：send 前收窄；标记不在的下一次 send：切回收窄前的完整集", async () => {
    const agent = await createCustomAgent(input());
    beginNonOwnerTurn("t1");
    await agent.send("陌生人的问题", sendOpts);
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    expect(session.activeNow().sort()).toEqual([...NON_OWNER_TURN_PI_TOOL_NAMES].sort());
    expect(session.prompt).toHaveBeenCalledTimes(1);

    // 同一轮内再 send（标记仍在）：不重复切、不把「收窄后的集」当成完整集记下来
    await agent.send("追问", sendOpts);
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);

    // 一轮结束、属主的下一次 send：切回完整集
    clearNonOwnerTurn("t1");
    await agent.send("属主的话", sendOpts);
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(2);
    expect(session.activeNow().sort()).toEqual([...FULL].sort());
  });

  it("对照：从没有非属主标记的会话，send 不碰工具集", async () => {
    const agent = await createCustomAgent(input());
    await agent.send("属主的话", sendOpts);
    await agent.send("又一句", sendOpts);
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(session.getActiveToolNames).not.toHaveBeenCalled();
  });

  it("别的任务的非属主标记不波及本会话", async () => {
    const agent = await createCustomAgent(input());
    beginNonOwnerTurn("t2");
    await agent.send("属主的话", sendOpts);
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("切换抛错：只告警、这一轮照常发出（best-effort）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    session.setActiveToolsByName.mockImplementation(() => {
      throw new Error("boom");
    });
    const agent = await createCustomAgent(input());
    beginNonOwnerTurn("t1");
    await expect(agent.send("陌生人的问题", sendOpts)).resolves.toBeTruthy();
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("readOnly 旁路 / 无 taskId 的会话不参与收窄", async () => {
    const ro = await createCustomAgent(input({ readOnly: true }));
    beginNonOwnerTurn("t1");
    await ro.send("q", sendOpts);
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();

    const noTask = await createCustomAgent(input({ taskId: undefined }));
    await noTask.send("q", sendOpts);
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});
