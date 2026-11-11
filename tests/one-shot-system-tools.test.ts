/**
 * 属主「一次性 agent」（task 页还没有会话 / 任务没推进过时，输入条与定时到点落到的那条通道）的系统工具。
 *
 * 以前这条通道一个系统工具都没挂：任务没推进过就建不了定时（AI 还自称「临时助手」）。现在：
 * - 清单（`ONE_SHOT_SYSTEM_TOOL_NAMES`）只含不依赖 action / notifier 的 `schedule`、`wait`；
 * - 两条后端（Cursor `buildSdkCustomTools` / pi `buildCustomTools`）按 `systemToolNames` 收窄，不传 = 全挂（正式会话不受影响）；
 * - 一次性 agent 运行期间登记自己的 callerToken（`setOneShotCallerToken`），`schedule` 才认它；收尾只摘自己的；
 * - 端到端：一个从没推进过 action 的任务，用一次性 agent 的 token 能建 / 列 / 取消定时。
 *
 * - 能力面（R10-02，用户 2026-11-11 决定「保留」）：一次性 agent 随 callerToken 一并带**浏览器工具**（两条后端）与
 *   **`subagent`**（Cursor：同时关掉原生 `task`）——不受 `systemToolNames` 收窄；受限答疑 / 只读轮次（无 callerToken）什么都不挂。
 *   这条钉成测试，将来谁改门控条件（比如让清单也管浏览器 / 子代理）会红，要改先问用户。
 *
 * startOneShotQuestion 自身的接线（create 参数 / token 登记与摘除 / 失败路径）在 tests/oneshot-question-bailout.test.ts；
 * facade 把 systemToolNames 转给 pi 后端那一段在 tests/agent-backend-system-tool-names.test.ts。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-oneshot-tools-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

// schedule 创建 / 取消会往事件流写一条提示：这里只关心工具行为，不碰真事件流
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeEventAndPublish: vi.fn(async () => null) };
});

// 能力面一节走 Agent facade 的 Cursor 路：@cursor/sdk 换成只记录入参的假实现
const mockCursorCreate = vi.fn(async (arg: unknown) => {
  void arg;
  return { agentId: "agent-x", send: vi.fn(), close() {} };
});
const mockCursorResume = vi.fn(async (id: string, arg: unknown) => {
  void id;
  void arg;
  return { agentId: "agent-x", send: vi.fn(), close() {} };
});
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (arg: unknown) => mockCursorCreate(arg),
    resume: (id: string, arg: unknown) => mockCursorResume(id, arg),
  },
}));

const { buildSdkCustomTools, flowShipTools, pickSystemTools } = await import("@/lib/server/flowship-tools");
const { Agent } = await import("@/lib/server/agent-backend");
const { getBrowserTools } = await import("@/lib/server/browser/tools");
const { __resetBrowserSettingsForTest } = await import("@/lib/server/browser/settings");
const { installFakeBrowser } = await import("./helpers/browser-bridge-fake");
const { __buildCustomToolsForTest } = await import("@/lib/server/custom-agent-backend");
const { ONE_SHOT_SYSTEM_TOOL_NAMES } = await import("@/lib/server/one-shot-tools");
const {
  CALLER_MISMATCH_ERROR,
  clearOneShotCallerTokenIf,
  getExpectedCallerToken,
  matchExpectedCallerToken,
  setChatTaskActionHandler,
  setOneShotCallerToken,
  cleanupChatTaskState,
} = await import("@/lib/server/chat-pending");
const { readSchedules } = await import("@/lib/server/schedule-store");
const { taskDir } = await import("@/lib/server/task-fs-core");

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** 依赖 action / 待答提问 notifier 的系统工具：一次性 agent 不该有 */
const ACTION_BOUND = [
  "submit_work",
  "ask_user",
  "submit_mr",
  "set_feishu_testers",
  "set_plan_batches",
  "create_custom_action",
  "notify_group_testers",
  "advance_next",
];

interface SdkToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
const textOf = (r: SdkToolResult): string => r.content.map((c) => c.text ?? "").join("");

describe("清单与收窄（纯函数）", () => {
  it("一次性 agent 的系统工具只有 schedule / wait，且都真实存在于 flowShipTools", () => {
    expect([...ONE_SHOT_SYSTEM_TOOL_NAMES].sort()).toEqual(["schedule", "wait"]);
    const all = flowShipTools.map((t) => t.name);
    for (const n of ONE_SHOT_SYSTEM_TOOL_NAMES) expect(all, n).toContain(n);
    for (const n of ACTION_BOUND) expect(ONE_SHOT_SYSTEM_TOOL_NAMES, n).not.toContain(n);
  });

  it("pickSystemTools：不传 = 全挂（正式会话）；传了只留清单里的并保持原顺序；未知名字忽略", () => {
    expect(pickSystemTools(undefined)).toBe(flowShipTools);
    expect(pickSystemTools().map((t) => t.name)).toEqual(flowShipTools.map((t) => t.name));

    const picked = pickSystemTools(ONE_SHOT_SYSTEM_TOOL_NAMES).map((t) => t.name);
    expect(picked.sort()).toEqual(["schedule", "wait"]);
    // 原顺序：flowShipTools 里 wait 在 schedule 前面
    const order = flowShipTools.map((t) => t.name).filter((n) => n === "wait" || n === "schedule");
    expect(pickSystemTools(["schedule", "wait"]).map((t) => t.name)).toEqual(order);

    expect(pickSystemTools(["no_such_tool"])).toEqual([]);
    expect(pickSystemTools([])).toEqual([]);
  });
});

describe("两条后端都按 systemToolNames 收窄", () => {
  it("Cursor：不传 = 全部系统工具；传一次性清单 = 只有 schedule / wait", () => {
    const full = Object.keys(buildSdkCustomTools("tok", { taskId: "tA" }));
    for (const n of ["schedule", "wait", ...ACTION_BOUND]) expect(full, n).toContain(n);

    const narrow = Object.keys(
      buildSdkCustomTools("tok", { taskId: "tA", systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES }),
    );
    expect(narrow.sort()).toEqual(["schedule", "wait"]);
  });

  it("pi：不传 = 全部系统工具；传一次性清单 = 只有 schedule / wait，编码工具照常在", () => {
    const names = (input: Record<string, unknown>): string[] =>
      (
        __buildCustomToolsForTest("tok", TMP_ROOT, { input } as never, [], "tB") as unknown as Array<{
          name: string;
        }>
      ).map((d) => d.name);

    const full = names({});
    for (const n of ["schedule", "wait", ...ACTION_BOUND]) expect(full, n).toContain(n);

    const narrow = names({ systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES });
    expect(narrow).toEqual(expect.arrayContaining(["schedule", "wait"]));
    for (const n of ACTION_BOUND) expect(narrow, n).not.toContain(n);
    // 收窄只管 Flowship 系统工具，不影响 pi 的编码工具
    expect(narrow).toContain("shell");
  });

  it("没有 callerToken（受限答疑等）时，两条后端都不挂任何系统工具——收窄参数不会让它多出东西", () => {
    const pi = __buildCustomToolsForTest(
      undefined,
      TMP_ROOT,
      { input: { systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES } } as never,
      [],
      "tC",
    ) as unknown as Array<{ name: string }>;
    const piNames = pi.map((d) => d.name);
    expect(piNames).not.toContain("schedule");
    expect(piNames).not.toContain("wait");
  });
});

describe("能力面（R10-02）：一次性 agent 带浏览器工具；Cursor 路径带 subagent 且关原生 task", () => {
  type FakeBrowserHandle = ReturnType<typeof installFakeBrowser>;
  let fake: FakeBrowserHandle | null = null;
  beforeEach(() => {
    __resetBrowserSettingsForTest();
    mockCursorCreate.mockClear();
    mockCursorResume.mockClear();
    fake = installFakeBrowser(); // 桌面壳在（bridge 可用）：浏览器工具才会注册
  });
  afterEach(() => {
    fake?.cleanup();
    fake = null;
  });

  const TASK = "tCap";
  /** 当前会话该有的浏览器工具名（只看 getBrowserTools 自己的注册条件：bridge + taskId + 非只读） */
  const browserNames = (): string[] => getBrowserTools({ taskId: TASK, readOnly: false }).map((t) => t.name);

  type Tools = Record<string, unknown>;
  const customToolsOf = (arg: unknown): Tools | undefined =>
    (arg as { local?: { customTools?: Tools } }).local?.customTools;
  const baseInput = {
    apiKey: "sk-test",
    model: { id: "composer-2.5" },
    local: { cwd: "/tmp/proj", settingSources: [] },
  };
  /** 一次性 agent 的 Agent.create 入参（与 task-runner.startOneShotQuestion 同形：callerToken + taskId + 收窄清单） */
  const oneShotInput = {
    ...baseInput,
    callerToken: "oneshot-tok",
    taskId: TASK,
    systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES,
  };

  it("前提：假桌面壳在时 getBrowserTools 真的有东西（否则下面的断言是空转）", () => {
    const names = browserNames();
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_ask_user_to_act");
    // 没有 taskId / 只读 → 没有：这是 getBrowserTools 自己的门，不是本文件要改的
    expect(getBrowserTools({ readOnly: false })).toEqual([]);
    expect(getBrowserTools({ taskId: TASK, readOnly: true })).toEqual([]);
  });

  it("Cursor（buildSdkCustomTools）：schedule / wait + 全部浏览器工具，恰好这些；action 绑定的系统工具一个都没有", () => {
    const names = Object.keys(
      buildSdkCustomTools("oneshot-tok", { taskId: TASK, systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES }),
    );
    expect([...names].sort()).toEqual([...ONE_SHOT_SYSTEM_TOOL_NAMES, ...browserNames()].sort());
    for (const n of ACTION_BOUND) expect(names, n).not.toContain(n);
  });

  it("pi（buildCustomTools）：schedule / wait + 全部浏览器工具 + 编码工具；action 绑定的系统工具一个都没有", () => {
    const names = (
      __buildCustomToolsForTest(
        "oneshot-tok",
        TMP_ROOT,
        { input: { systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES } } as never,
        [],
        TASK,
      ) as unknown as Array<{ name: string }>
    ).map((d) => d.name);
    for (const n of [...ONE_SHOT_SYSTEM_TOOL_NAMES, ...browserNames()]) expect(names, n).toContain(n);
    expect(names).toContain("shell");
    for (const n of ACTION_BOUND) expect(names, n).not.toContain(n);
  });

  it("Cursor facade（Agent.create）：customTools = schedule / wait + 浏览器工具 + subagent，原生 task 被关；清单不漏进 SDK 入参", async () => {
    await Agent.create(oneShotInput as never);
    const arg = mockCursorCreate.mock.calls[0]![0] as Record<string, unknown>;
    const tools = customToolsOf(arg);
    expect(tools).toBeDefined();
    expect(Object.keys(tools!).sort()).toEqual(
      [...ONE_SHOT_SYSTEM_TOOL_NAMES, ...browserNames(), "subagent"].sort(),
    );
    expect(typeof (tools!.subagent as { execute?: unknown }).execute).toBe("function");
    for (const n of ACTION_BOUND) expect(tools, n).not.toHaveProperty(n);
    // 挂了 subagent 就关掉原生 task（原生 task 选不了模型）——一次性 agent 与正式会话同一条规则
    expect(arg.disallowedTools).toEqual(["task"]);
    // systemToolNames / callerToken / taskId 是 facade 自己的入参，不该原样给 SDK
    expect(arg).not.toHaveProperty("systemToolNames");
    expect(arg).not.toHaveProperty("callerToken");
  });

  it("Cursor facade（Agent.resume）：同样带，且重新关掉原生 task（disallowedTools 不持久化）", async () => {
    await Agent.resume("agent-x", oneShotInput as never);
    const arg = mockCursorResume.mock.calls[0]![1] as Record<string, unknown>;
    const tools = customToolsOf(arg);
    expect(Object.keys(tools!).sort()).toEqual(
      [...ONE_SHOT_SYSTEM_TOOL_NAMES, ...browserNames(), "subagent"].sort(),
    );
    expect(arg.disallowedTools).toEqual(["task"]);
  });

  it("反向：没有 callerToken（受限答疑）/ 只读轮次——Cursor 什么都不挂、原生 task 不动；pi 没有 schedule / wait / 浏览器工具", async () => {
    await Agent.create({ ...oneShotInput, callerToken: undefined } as never);
    await Agent.create({ ...oneShotInput, readOnly: true } as never);
    for (const [i, args] of mockCursorCreate.mock.calls.entries()) {
      const arg = args[0] as Record<string, unknown>;
      expect(customToolsOf(arg), `create#${i}`).toBeUndefined();
      expect(arg, `create#${i}`).not.toHaveProperty("disallowedTools");
    }

    const piNames = (
      __buildCustomToolsForTest(
        undefined,
        TMP_ROOT,
        { input: { systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES } } as never,
        [],
        TASK,
      ) as unknown as Array<{ name: string }>
    ).map((d) => d.name);
    for (const n of [...ONE_SHOT_SYSTEM_TOOL_NAMES, ...browserNames()]) expect(piNames, n).not.toContain(n);
  });
});

describe("callerToken 登记 / 摘除（chat-pending）", () => {
  it("登记后 matchExpectedCallerToken 认它；不登记 / 别的 token 一律不认（fail-closed）", () => {
    const id = "t_tok_1";
    expect(matchExpectedCallerToken(id, "tok-1")).toBe(false);
    setOneShotCallerToken(id, "tok-1");
    expect(getExpectedCallerToken(id)).toBe("tok-1");
    expect(matchExpectedCallerToken(id, "tok-1")).toBe(true);
    expect(matchExpectedCallerToken(id, "tok-2")).toBe(false);
    expect(matchExpectedCallerToken(id, undefined)).toBe(false);
    cleanupChatTaskState(id);
  });

  it("只摘自己的：摘自己 → true 并清掉；token 已被换成别人的 → false 且不动", () => {
    const id = "t_tok_2";
    setOneShotCallerToken(id, "mine");
    expect(clearOneShotCallerTokenIf(id, "mine")).toBe(true);
    expect(getExpectedCallerToken(id)).toBeNull();
    // 已经没有了：再摘是 no-op
    expect(clearOneShotCallerTokenIf(id, "mine")).toBe(false);

    // 期间被正式会话接管（它注册自己的 token 把槽换了）：一次性 agent 收尾不能把别人的 token 误删
    setOneShotCallerToken(id, "mine");
    setChatTaskActionHandler(id, (async () => ({ ok: true })) as never, "formal-session");
    expect(clearOneShotCallerTokenIf(id, "mine")).toBe(false);
    expect(getExpectedCallerToken(id)).toBe("formal-session");
    cleanupChatTaskState(id);
  });

  it("stop / 清理（cleanupChatTaskState）摘掉 token 后，一次性 agent 里还在飞的调用被拒", () => {
    const id = "t_tok_3";
    setOneShotCallerToken(id, "mine");
    cleanupChatTaskState(id);
    expect(matchExpectedCallerToken(id, "mine")).toBe(false);
  });
});

describe("端到端：从没推进过 action 的任务，用一次性 agent 的 token 能建定时", () => {
  let seq = 0;
  /** 一个「没推进过」的任务：只有任务目录、没有任何 action / 正式会话 */
  const freshNeverAdvancedTask = async (): Promise<string> => {
    seq += 1;
    const id = `t_never_advanced_${seq}`;
    await fs.mkdir(taskDir(id), { recursive: true });
    return id;
  };
  const call = async (
    tools: ReturnType<typeof buildSdkCustomTools>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> =>
    textOf((await tools[name]!.execute(args as never, undefined as never)) as unknown as SdkToolResult);

  it("登记了 token：create / list / cancel 都成功，落盘的定时属于这个任务", async () => {
    const id = await freshNeverAdvancedTask();
    setOneShotCallerToken(id, "oneshot-tok");
    const tools = buildSdkCustomTools("oneshot-tok", { taskId: id, systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES });

    const created = await call(tools, "schedule", {
      action: "create",
      title: "明早提醒",
      message: "提醒用户看周报",
      delay_minutes: 30,
    });
    expect(created).toContain("[SCHEDULED id=");
    expect(created).not.toContain(CALLER_MISMATCH_ERROR);
    const [rec] = await readSchedules(id);
    expect(rec).toMatchObject({ title: "明早提醒", message: "提醒用户看周报", status: "active" });

    expect(await call(tools, "schedule", { action: "list" })).toContain("明早提醒");

    const cancelled = await call(tools, "schedule", { action: "cancel", id: rec!.id });
    expect(cancelled).toContain("[CANCELLED");
    cleanupChatTaskState(id);
  });

  it("对照：没登记 token（以前的一次性 agent 就是这样）/ 收尾摘掉之后，建定时被拒、什么都没落盘", async () => {
    const id = await freshNeverAdvancedTask();
    const tools = buildSdkCustomTools("oneshot-tok", { taskId: id, systemToolNames: ONE_SHOT_SYSTEM_TOOL_NAMES });
    const args = { action: "create", title: "x", message: "y", delay_minutes: 30 };

    expect(await call(tools, "schedule", args)).toBe(CALLER_MISMATCH_ERROR);
    expect(await readSchedules(id)).toEqual([]);

    setOneShotCallerToken(id, "oneshot-tok");
    expect(await call(tools, "schedule", args)).toContain("[SCHEDULED id=");
    clearOneShotCallerTokenIf(id, "oneshot-tok");
    expect(await call(tools, "schedule", { ...args, title: "x2", message: "y2" })).toBe(CALLER_MISMATCH_ERROR);
    expect(await readSchedules(id)).toHaveLength(1);
    cleanupChatTaskState(id);
  });
});
