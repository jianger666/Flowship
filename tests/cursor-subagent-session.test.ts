/**
 * Cursor `subagent` 的真实依赖工厂（createCursorSubagentLinkForSession）：
 * 子 agent 到底以什么选项创建——这是「子代理不带系统工具 / 用户 MCP / 不能递归」这条边界的落点。
 *
 * SDK 用假的（只记录 Agent.create 的入参）；模型目录走真实的 model-catalog（它读 Cursor.models.list，也是假的）。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-cursor-subagent-session-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const makeRun = (result = "子任务结果") => ({
  stream: () => (async function* () {})(),
  wait: async () => ({ status: "finished", result }),
  cancel: vi.fn(async () => {}),
});
const childClose = vi.fn();
const childSend = vi.fn(async (prompt: string) => {
  void prompt;
  return makeRun();
});
const mockCreate = vi.fn(async (arg: unknown) => {
  void arg;
  return { send: childSend, close: childClose };
});
const mockList = vi.fn(async (arg: unknown) => {
  void arg;
  return [
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
    },
    {
      id: "claude-sonnet-5-5",
      displayName: "Claude Sonnet 5.5",
      parameters: [
        { id: "reasoning_effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
        { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
      ],
    },
  ];
});
const mockResume = vi.fn(async (id: string, arg: unknown) => {
  void id;
  void arg;
  return { agentId: id, send: childSend, close: childClose };
});
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (arg: unknown) => mockCreate(arg),
    resume: (id: string, arg: unknown) => mockResume(id, arg),
  },
  Cursor: { models: { list: (arg: unknown) => mockList(arg) } },
}));

const { createCursorSubagentLinkForSession, CURSOR_SUBAGENT_READONLY_TOOLS } = await import(
  "@/lib/server/cursor-subagent"
);

type Opts = Record<string, unknown>;
const lastCreate = (): Opts => mockCreate.mock.calls.at(-1)![0] as Opts;

const run = async (
  link: ReturnType<typeof createCursorSubagentLinkForSession>,
  args: Record<string, unknown>,
) => {
  const r = (await link.tool.execute(args as never, {} as never)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
};

afterEach(() => {
  vi.useRealTimers();
  mockCreate.mockClear();
  mockResume.mockClear();
  childSend.mockClear();
  childClose.mockClear();
});

describe("子 agent 的创建选项（边界）", () => {
  const mk = (apiKey = "sk-session-a") =>
    createCursorSubagentLinkForSession({
      apiKey,
      parentModel: {
        id: "claude-sonnet-5-5",
        params: [
          { id: "reasoning_effort", value: "high" },
          { id: "context", value: "1m" },
        ],
      },
      cwd: "/work/proj",
    });

  it("general：同 apiKey / cwd；沿用父模型（藏起来的 context 参数已剥）；去掉 task；没有 customTools / mcpServers / 系统工具", async () => {
    const out = await run(mk(), { prompt: "干活" });
    expect(out).toEqual({ text: "子任务结果", isError: false });
    const o = lastCreate();
    expect(o.apiKey).toBe("sk-session-a");
    expect(o.model).toEqual({
      id: "claude-sonnet-5-5",
      params: [{ id: "reasoning_effort", value: "high" }],
    });
    expect(o.disallowedTools).toEqual(["task"]);
    expect(o).not.toHaveProperty("tools");
    const local = o.local as Opts;
    expect(local.cwd).toBe("/work/proj");
    // 不加载 .cursor/（与父会话同口径），也不带父会话的 customTools（submit_work / ask_user / subagent 自己）
    expect(local.settingSources).toEqual([]);
    expect(local).not.toHaveProperty("customTools");
    expect(o).not.toHaveProperty("mcpServers");
    expect(o).not.toHaveProperty("agents");
    expect(childSend).toHaveBeenCalledWith("干活");
  });

  it("explore：只给读 / 搜白名单，且不再叠 disallowedTools", async () => {
    await run(mk(), { prompt: "只看不改", subagentType: "explore" });
    const o = lastCreate();
    expect(o.tools).toEqual([...CURSOR_SUBAGENT_READONLY_TOOLS]);
    expect(o.tools).toEqual(["read", "grep", "glob", "ls"]);
    expect(o).not.toHaveProperty("disallowedTools");
  });

  it("换模型 + effort：用目录里该模型的 effort 参数 id；不带父的 params、不带 context", async () => {
    await run(mk("sk-session-b"), { prompt: "x", model: "claude-sonnet-5-5", effort: "low" });
    expect(lastCreate().model).toEqual({
      id: "claude-sonnet-5-5",
      params: [{ id: "reasoning_effort", value: "low" }],
    });
    // 目录来自 Cursor.models.list（带着该账号的 apiKey）
    expect(mockList).toHaveBeenCalledWith({ apiKey: "sk-session-b" });
  });

  it("无效 model：报错并列出目录里的模型，不创建子 agent", async () => {
    const out = await run(mk("sk-session-c"), { prompt: "x", model: "gpt-9" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("claude-sonnet-5-5");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("目录拿不到：只换模型放行；写 effort 明确报错", async () => {
    mockList.mockRejectedValue(new Error("network down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const link = mk("sk-session-nocatalog");
      const ok = await run(link, { prompt: "x", model: "some-new-model" });
      expect(ok.isError).toBe(false);
      expect((lastCreate().model as { id: string }).id).toBe("some-new-model");
      mockCreate.mockClear();
      const bad = await run(link, { prompt: "x", effort: "low" });
      expect(bad.isError).toBe(true);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      mockList.mockReset();
      mockList.mockResolvedValue([] as never);
      warn.mockRestore();
    }
  });

  it("成功后关闭子 agent", async () => {
    await run(mk("sk-session-d"), { prompt: "x" });
    expect(childClose).toHaveBeenCalledTimes(1);
  });

  it("父会话没显式选模型：不替它编模型，create 里不带 model", async () => {
    const link = createCursorSubagentLinkForSession({ apiKey: "sk-session-e", cwd: "/w" });
    await run(link, { prompt: "x" });
    expect(lastCreate()).not.toHaveProperty("model");
  });
});

describe("受理超时（与父会话同口径的 SDK deadline）", () => {
  it("子 agent 的 send 挂死：到点报超时（带原因给模型）、并关掉子 agent", async () => {
    vi.useFakeTimers();
    childSend.mockImplementationOnce(() => new Promise(() => {}));
    const link = createCursorSubagentLinkForSession({
      apiKey: "sk-session-f",
      parentModel: { id: "composer-2.5" },
      cwd: "/w",
    });
    const p = run(link, { prompt: "x" });
    await vi.advanceTimersByTimeAsync(121_000);
    const out = await p;
    expect(out.isError).toBe(true);
    expect(out.text).toContain("子任务失败");
    expect(out.text).toContain("超时");
    expect(childClose).toHaveBeenCalled();
  });

  it("子 agent 创建挂死：到点报超时，不无限停在「子代理工作中」", async () => {
    vi.useFakeTimers();
    mockCreate.mockImplementationOnce(() => new Promise(() => {}));
    const link = createCursorSubagentLinkForSession({
      apiKey: "sk-session-g",
      parentModel: { id: "composer-2.5" },
      cwd: "/w",
    });
    const p = run(link, { prompt: "x" });
    await vi.advanceTimersByTimeAsync(181_000);
    const out = await p;
    expect(out.isError).toBe(true);
    expect(out.text).toContain("超时");
  });
});

describe("resume：真实 SDK 路径（Agent.resume）", () => {
  // 不依赖前面用例留下的 mockList 状态（「目录拿不到」那条会把它重置成空目录）
  beforeEach(() => {
    mockList.mockReset();
    mockList.mockResolvedValue([
      {
        id: "claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        parameters: [
          { id: "reasoning_effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
          { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
        ],
      },
    ] as never);
  });

  const mk = (apiKey: string) =>
    createCursorSubagentLinkForSession({
      apiKey,
      parentModel: {
        id: "claude-sonnet-5-5",
        params: [
          { id: "reasoning_effort", value: "high" },
          { id: "context", value: "1m" },
        ],
      },
      cwd: "/work/proj",
    });

  /** 让下一次 create 出来的子 agent 带 SDK 分配的 id（真实 SDK 一定有） */
  const nextChildId = (id: string) =>
    mockCreate.mockResolvedValueOnce({ agentId: id, send: childSend, close: childClose } as never);

  it("结果末尾给 id；resume 用 Agent.resume(该 id, 与 create 同一份选项)——tools / disallowedTools 不持久化，必须再传", async () => {
    const link = mk("sk-resume-a");
    nextChildId("sdk-child-1");
    const first = await run(link, { prompt: "干活" });
    expect(first.text.startsWith("子任务结果\n\n[子代理 sdk-child-1 · claude-sonnet-5-5 (reasoning_effort=high)]")).toBe(true);
    const createOpts = lastCreate();

    const second = await run(link, { prompt: "接着改", resume: "sdk-child-1" });
    expect(second.isError).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockResume.mock.calls[0][0]).toBe("sdk-child-1");
    const resumeOpts = mockResume.mock.calls[0][1] as Opts;
    // 与 create 同口径：apiKey / 模型（藏起来的 context 已剥）/ cwd / settingSources / 去掉 task
    expect(resumeOpts.apiKey).toBe(createOpts.apiKey);
    expect(resumeOpts.model).toEqual(createOpts.model);
    expect(resumeOpts.disallowedTools).toEqual(["task"]);
    expect(resumeOpts).not.toHaveProperty("tools");
    expect((resumeOpts.local as Opts).cwd).toBe("/work/proj");
    expect((resumeOpts.local as Opts).settingSources).toEqual([]);
    expect(resumeOpts.local).not.toHaveProperty("customTools");
    expect(resumeOpts).not.toHaveProperty("mcpServers");
    expect(childSend).toHaveBeenLastCalledWith("接着改");
    expect(childClose).toHaveBeenCalledTimes(2); // create 那次、resume 那次各关一次
  });

  it("explore：resume 时仍只给读 / 搜白名单（否则只读子代理接回来就拿到写权限）", async () => {
    const link = mk("sk-resume-b");
    nextChildId("sdk-child-ro");
    await run(link, { prompt: "只看", subagentType: "explore" });
    await run(link, { prompt: "再看", resume: "sdk-child-ro" });
    const resumeOpts = mockResume.mock.calls[0][1] as Opts;
    expect(resumeOpts.tools).toEqual([...CURSOR_SUBAGENT_READONLY_TOOLS]);
    expect(resumeOpts).not.toHaveProperty("disallowedTools");
  });

  it("换过模型 + effort 的子代理：resume 沿用当初那份（不回退到父模型）", async () => {
    const link = mk("sk-resume-c");
    nextChildId("sdk-child-m");
    await run(link, { prompt: "x", model: "claude-sonnet-5-5", effort: "low" });
    await run(link, { prompt: "y", resume: "sdk-child-m" });
    expect((mockResume.mock.calls[0][1] as Opts).model).toEqual({
      id: "claude-sonnet-5-5",
      params: [{ id: "reasoning_effort", value: "low" }],
    });
  });

  it("Agent.resume 抛错（会话记录被清了等）：给模型一句能照做的话，并忘掉这条登记", async () => {
    const link = mk("sk-resume-d");
    nextChildId("sdk-child-gone");
    await run(link, { prompt: "x" });
    mockResume.mockRejectedValueOnce(new Error("agent not found in store"));
    const out = await run(link, { prompt: "y", resume: "sdk-child-gone" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("agent not found in store");
    expect(out.text).toContain("另起");
    const again = await run(link, { prompt: "y", resume: "sdk-child-gone" });
    expect(again.text).toContain("找不到子代理");
    expect(mockResume).toHaveBeenCalledTimes(1);
  });

  it("Agent.resume 挂死：到点报超时（与 create 同口径），不无限停在「子代理工作中」", async () => {
    const link = mk("sk-resume-e");
    nextChildId("sdk-child-slow");
    await run(link, { prompt: "x" });
    vi.useFakeTimers();
    mockResume.mockImplementationOnce(() => new Promise(() => {}));
    const p = run(link, { prompt: "y", resume: "sdk-child-slow" });
    await vi.advanceTimersByTimeAsync(181_000);
    const out = await p;
    expect(out.isError).toBe(true);
    expect(out.text).toContain("超时");
  });
});

describe("展示用：默认 effort 从真实模型目录缓存里偷看（peekCatalog）", () => {
  // 形状同 2026-10-19 真实 Cursor 清单：每个带档位的模型有一个 isDefault 预设
  const listWithDefaults = [
    {
      id: "claude-sonnet-5-5",
      displayName: "Claude Sonnet 5.5",
      parameters: [
        { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
        { id: "reasoning_effort", values: ["low", "medium", "high"].map((value) => ({ value })) },
      ],
      variants: [
        { displayName: "Low", params: [{ id: "reasoning_effort", value: "low" }] },
        {
          displayName: "High",
          isDefault: true,
          params: [
            { id: "context", value: "1m" },
            { id: "reasoning_effort", value: "high" },
          ],
        },
      ],
    },
  ];
  const parentAgent = (id: string) => ({ agentId: id, send: vi.fn(), close: vi.fn() });
  const mkLink = (apiKey: string) =>
    createCursorSubagentLinkForSession({
      apiKey,
      parentModel: { id: "gemini-4-argon", params: [{ id: "reasoning_effort", value: "high" }] },
      cwd: "/w",
    });

  beforeEach(() => {
    mockList.mockReset();
    mockList.mockResolvedValue(listWithDefaults as never);
  });

  it("同 apiKey 之前拉过目录（进程缓存里有）：新 link 不用再拉就查得到默认档；没缓存的 apiKey 查不到、也不发请求", async () => {
    const { getSubagentDisplayLookup } = await import("@/lib/server/subagent-parent-model");
    // 预热缓存：显式选模型的调用会拉一次目录
    await run(mkLink("sk-peek-warm"), { prompt: "x", model: "claude-sonnet-5-5" });
    expect(mockList).toHaveBeenCalledTimes(1);

    const warm = getSubagentDisplayLookup(mkLink("sk-peek-warm").attach(parentAgent("P-warm")))!;
    expect(warm.defaultEffortOf!("claude-sonnet-5-5")).toBe("high");
    expect(mockList).toHaveBeenCalledTimes(1); // 偷看缓存，不是再拉一次

    const cold = getSubagentDisplayLookup(mkLink("sk-peek-cold").attach(parentAgent("P-cold")))!;
    expect(cold.defaultEffortOf!("claude-sonnet-5-5")).toBeUndefined();
    expect(mockList).toHaveBeenCalledTimes(1); // 冷的 apiKey 也没有因为展示去发网络请求
  });

  it("显式换模型不写 effort：真实创建选项里仍不替它传 effort（默认档只用于显示，不改子代理实际行为）", async () => {
    await run(mkLink("sk-peek-create"), { prompt: "x", model: "claude-sonnet-5-5" });
    expect(lastCreate().model).toEqual({ id: "claude-sonnet-5-5" });
  });
});
