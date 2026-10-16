/**
 * 后台子代理 × chat 会话（真实 chat-runner + 真实 subagent link，假 SDK）：
 *   - 主 AI 派了前台子代理、被卡在阻塞的工具调用里时，用户「立即发送」插话 →
 *     子代理自动转后台、工具调用立刻返回、插话被 steer 进当前这一轮；
 *   - 后台子代理收尾 → 结果作为一条消息送回主 AI（忙则 steer、攒着等收尾；闲则唤醒一轮），
 *     事件流里给用户留一行提示、不落用户气泡；
 *   - 停止 / 关会话 → 后台子代理一并取消、结果不再投递。
 *
 * 并行隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-bgsub-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockResume = vi.fn();
const mockCreate = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  detachChatForegroundSubagents,
  drainBackgroundResults,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { enqueueChatMessage, clearChatQueue } = await import(
  "@/lib/server/chat-queue"
);
const { sendQueuedChatMessageNow } = await import(
  "@/lib/server/chat-queue-send-now"
);
const { emitBackgroundSubagentSettled } = await import(
  "@/lib/server/subagent-background"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`chat-background DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const TASK_ID = "t_1700000005000_bgsub";
const PARENT_ID = "agent_fake_bgsub_parent";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `bgsub ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: PARENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;
const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

type SteerOutcome = "complete_delivered" | "revert_to_followup";

/** 手动结束的 run（父 / 子通用）：stream 与 wait 都挂到 release / cancel */
const manualRun = (opts?: {
  steer?: (text: string) => Promise<SteerOutcome>;
}) => {
  let release!: (result?: string) => void;
  let result: string | undefined;
  const gate = new Promise<void>((r) => {
    release = (res) => {
      result = res;
      r();
    };
  });
  let cancelled = false;
  const run: Record<string, unknown> = {
    stream: async function* () {
      await gate;
    },
    wait: async () => {
      await gate;
      return cancelled
        ? { status: "cancelled" as const }
        : { status: "finished" as const, result: result ?? "子代理结果" };
    },
    cancel: vi.fn(async () => {
      cancelled = true;
      release();
    }),
    cancelled: () => cancelled,
  };
  if (opts?.steer) run.steer = vi.fn(opts.steer);
  return { run, release };
};

/** 起父会话（resume）+ 发首条消息让一轮 run 在飞；返回父 agent 与 resume 时挂上的 subagent 工具 */
const startParentRun = async (parentRun: Record<string, unknown>) => {
  const parentAgent = {
    agentId: PARENT_ID,
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(parentRun),
  };
  mockResume.mockResolvedValue(parentAgent);
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  const subagentTool = (
    mockResume.mock.calls.at(-1)?.[1] as {
      local: {
        customTools: Record<
          string,
          {
            execute: (
              a: unknown,
              c: unknown,
            ) => Promise<{ content: Array<{ text: string }> }>;
          }
        >;
      };
    }
  ).local.customTools.subagent;
  expect(subagentTool).toBeTruthy();
  expect(await sendChatMessage(task, "派几个子代理")).toBe("sent");
  expect(isChatRunActive(TASK_ID)).toBe(true);
  return { parentAgent, subagentTool: subagentTool! };
};

const runTool = async (
  tool: { execute: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> },
  args: Record<string, unknown>,
): Promise<string> => {
  const r = await tool.execute(args, {});
  return r.content.map((c) => c.text).join("\n");
};

/** 每次起子 agent 给一个手动控制的 run，记下来 */
const childRuns: Array<ReturnType<typeof manualRun>> = [];
const childAgents: Array<{ close: ReturnType<typeof vi.fn> }> = [];
const installChildFactory = () => {
  childRuns.length = 0;
  childAgents.length = 0;
  let n = 0;
  mockCreate.mockImplementation(async () => {
    n += 1;
    const r = manualRun();
    childRuns.push(r);
    const close = vi.fn();
    childAgents.push({ close });
    return {
      agentId: `child-${n}`,
      send: vi.fn().mockResolvedValue(r.run),
      close,
    };
  });
};

const eventsOfKind = async (kind: string) =>
  (await readEvents(TASK_ID)).filter((e) => e.kind === kind);

const settleTail = () => new Promise((r) => setTimeout(r, 30));

beforeEach(async () => {
  mockResume.mockReset();
  mockCreate.mockReset();
  installChildFactory();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
});

afterEach(async () => {
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("chat 会话里的 subagent 工具带后台运行", () => {
  it("resume 挂上的工具 schema 有 run_in_background", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { subagentTool } = await startParentRun(parent.run);
    const tool = subagentTool as unknown as { inputSchema?: { properties: object } };
    // 通过 customTools 暴露给 SDK 的就是 link.tool：schema 里要有后台参数
    expect(Object.keys((tool.inputSchema ?? { properties: {} }).properties)).toContain(
      "run_in_background",
    );
  });

  it("新建会话（Agent.create 路径）的 subagent 工具同样带后台参数", async () => {
    const parent = manualRun();
    const parentAgent = {
      agentId: "agent_created_bgsub",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(parent.run),
    };
    mockCreate.mockImplementationOnce(async () => parentAgent);
    const started = runChatSession({
      task: asTask({ ...makeMeta(TASK_ID), sessionAgentId: undefined } as TaskMetaV06),
      ...BOOT,
      firstMessage: { text: "新会话首条" },
    });
    await vi.waitFor(() => expect(parentAgent.send).toHaveBeenCalledTimes(1), {
      timeout: 5000,
      interval: 30,
    });
    const created = mockCreate.mock.calls[0]?.[0] as {
      local: {
        customTools: Record<string, { inputSchema?: { properties: object } }>;
      };
    };
    const props = Object.keys(
      created.local.customTools.subagent?.inputSchema?.properties ?? {},
    );
    expect(props).toContain("run_in_background");
    parent.release("ok");
    await started;
  });
});

describe("用户插话 → 前台子代理自动转后台", () => {
  it("主 AI 卡在 3 个前台子代理里：「立即发送」后工具调用立刻返回、插话被 steer 进当前这一轮", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { subagentTool } = await startParentRun(parent.run);

    // 模型同一步并行发了 3 个前台子代理调用，工具回调都阻塞着
    const calls = [1, 2, 3].map((i) =>
      runTool(subagentTool, { prompt: `任务${i}`, description: `干活${i}` }),
    );
    await vi.waitFor(() => expect(childRuns).toHaveLength(3), { timeout: 3000 });
    let anyReturned = false;
    void Promise.race(calls).then(() => {
      anyReturned = true;
    });
    await settleTail();
    expect(anyReturned).toBe(false); // 主 AI 此刻确实被卡住

    // 用户在队列里排了一条，点「立即发送」
    enqueueChatMessage(TASK_ID, {
      itemId: "cq_interject",
      agentText: "先别管它们，帮我看个别的",
      displayText: "先别管它们，帮我看个别的",
      enqueuedAt: Date.now(),
    });
    const res = await sendQueuedChatMessageNow(TASK_ID, "cq_interject", BOOT);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { steered?: boolean }).steered).toBe(true);

    // 三个阻塞的工具调用立刻返回（不用等子代理跑完），并告诉模型「已转后台、先回应用户」
    const texts = await Promise.all(calls);
    for (const t of texts) {
      expect(t).toContain("已转到后台");
      expect(t).toContain("先回应用户");
    }
    // 子代理没被取消，继续在后台干
    expect(childRuns.every((r) => !(r.run.cancelled as () => boolean)())).toBe(true);
    // 用户的话被 steer 进了当前这一轮（没停、没重开）
    await vi.waitFor(
      () => {
        const steer = parent.run.steer as ReturnType<typeof vi.fn>;
        expect(steer).toHaveBeenCalled();
        expect(steer.mock.calls.some((c) => String(c[0]).includes("先别管它们"))).toBe(
          true,
        );
      },
      { timeout: 3000 },
    );
    expect((parent.run.cancel as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(isChatRunActive(TASK_ID)).toBe(true);
  });

  it("转后台的子代理做完 → 结果作为一条消息 steer 回主 AI；事件流只留一行提示、不落用户气泡", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { subagentTool } = await startParentRun(parent.run);
    const call = runTool(subagentTool, { prompt: "查资料", description: "查资料" });
    await vi.waitFor(() => expect(childRuns).toHaveLength(1), { timeout: 3000 });

    enqueueChatMessage(TASK_ID, {
      itemId: "cq_i2",
      agentText: "插个话",
      displayText: "插个话",
      enqueuedAt: Date.now(),
    });
    await sendQueuedChatMessageNow(TASK_ID, "cq_i2", BOOT);
    await call;
    const steer = parent.run.steer as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), { timeout: 3000 });

    childRuns[0]!.release("资料内容：ABC-123");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2), { timeout: 3000 });

    const delivered = String(steer.mock.calls[1]![0]);
    expect(delivered).toContain("[BACKGROUND_SUBAGENT_RESULT]");
    expect(delivered).toContain("资料内容：ABC-123");
    expect(delivered).toContain("不是用户的指令");

    const infos = (await eventsOfKind("info")) as Array<{ text?: string }>;
    expect(infos.some((e) => e.text?.includes("后台子代理「查资料」已完成"))).toBe(true);
    // 用户气泡只有那一条插话——子代理结果不冒充用户说话
    const replies = (await eventsOfKind("user_reply")) as Array<{ text?: string }>;
    expect(replies.map((e) => e.text)).toEqual(["插个话"]);
  });
});

describe("后台结果的投递时机", () => {
  it("主 AI 这一轮已自然结束（空闲）：后台子代理做完 → 唤醒新一轮，把结果发给它", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool } = await startParentRun(parent.run);

    const out = await runTool(subagentTool, {
      prompt: "跑个长任务",
      description: "长任务",
      run_in_background: true,
    });
    expect(out).toContain("已在后台启动");
    expect(childRuns).toHaveLength(1);

    // 主 AI 说完这一轮，会话空闲；后台子代理还在跑
    parent.release("好的，我派了个后台子代理");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5000,
      interval: 30,
    });
    expect(hasChatSession(TASK_ID)).toBe(true);
    expect(parentAgent.send).toHaveBeenCalledTimes(1);
    expect((childRuns[0]!.run.cancel as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      0,
    );

    // 第二轮要给一个新的 run
    const wakeRun = manualRun({ steer: async () => "complete_delivered" });
    parentAgent.send.mockResolvedValue(wakeRun.run);

    childRuns[0]!.release("长任务的结论：XYZ");

    await vi.waitFor(() => expect(parentAgent.send).toHaveBeenCalledTimes(2), {
      timeout: 5000,
      interval: 30,
    });
    const woke = String(parentAgent.send.mock.calls[1]![0]);
    expect(woke).toContain("[BACKGROUND_SUBAGENT_RESULT]");
    expect(woke).toContain("长任务的结论：XYZ");
    expect(isChatRunActive(TASK_ID)).toBe(true);
    // 唤醒不落用户气泡
    expect((await eventsOfKind("user_reply")).length).toBe(0);
    wakeRun.release("收到结论");
  });

  it("主 AI 在忙且这一轮不能 steer：结果先攒着，这一轮收尾时再送；多个合并成一条", async () => {
    // 没有 steer 的 run（pi 形态）：忙时只能攒
    const parent = manualRun();
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    await runTool(subagentTool, { prompt: "a", description: "任务A", run_in_background: true });
    await runTool(subagentTool, { prompt: "b", description: "任务B", run_in_background: true });
    expect(childRuns).toHaveLength(2);

    childRuns[0]!.release("A 的结果");
    childRuns[1]!.release("B 的结果");
    await settleTail();
    // 还在忙：没有往里送、也没有另起一轮
    expect(parentAgent.send).toHaveBeenCalledTimes(1);

    const wakeRun = manualRun();
    parentAgent.send.mockResolvedValue(wakeRun.run);
    parent.release("这一轮说完了");

    await vi.waitFor(() => expect(parentAgent.send).toHaveBeenCalledTimes(2), {
      timeout: 5000,
      interval: 30,
    });
    const merged = String(parentAgent.send.mock.calls[1]![0]);
    expect(merged).toContain("A 的结果");
    expect(merged).toContain("B 的结果");
    expect(merged.match(/\[BACKGROUND_SUBAGENT_RESULT\]/g)).toHaveLength(2);
    wakeRun.release();
  });

  it("steer 被退回（revert_to_followup）：不丢，这一轮收尾后送出", async () => {
    const parent = manualRun({ steer: async () => "revert_to_followup" });
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    await runTool(subagentTool, { prompt: "a", description: "任务A", run_in_background: true });

    childRuns[0]!.release("A 的结果");
    await vi.waitFor(
      () => expect(parent.run.steer as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
      { timeout: 3000 },
    );
    await settleTail();
    expect(parentAgent.send).toHaveBeenCalledTimes(1); // 还在忙、没另起

    const wakeRun = manualRun();
    parentAgent.send.mockResolvedValue(wakeRun.run);
    parent.release("这一轮说完了");
    await vi.waitFor(() => expect(parentAgent.send).toHaveBeenCalledTimes(2), {
      timeout: 5000,
      interval: 30,
    });
    expect(String(parentAgent.send.mock.calls[1]![0])).toContain("A 的结果");
    wakeRun.release();
  });

  it("后台子代理失败：也告诉主 AI（带失败原因）", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    await runTool(subagentTool, { prompt: "a", description: "会失败的", run_in_background: true });
    parent.release("ok");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5000,
      interval: 30,
    });
    const wakeRun = manualRun();
    parentAgent.send.mockResolvedValue(wakeRun.run);

    // 模拟后台子代理以失败收场（真实 link 的失败映射在 cursor-subagent-background 里测过）
    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_fail01",
      parentAgentId: PARENT_ID,
      description: "会失败的",
      status: "failed",
      text: "rate limited",
      durationMs: 1500,
      detached: false,
    });

    await vi.waitFor(() => expect(parentAgent.send).toHaveBeenCalledTimes(2), {
      timeout: 5000,
      interval: 30,
    });
    const msg = String(parentAgent.send.mock.calls[1]![0]);
    expect(msg).toContain("失败了");
    expect(msg).toContain("rate limited");
    const infos = (await eventsOfKind("info")) as Array<{ text?: string }>;
    expect(infos.some((e) => e.text?.includes("失败"))).toBe(true);
    wakeRun.release();
  });
});

describe("该丢的结果就丢", () => {
  it("被取消的后台子代理（停止 / 关会话）→ 不投递、不唤醒", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    await runTool(subagentTool, { prompt: "a", description: "后台", run_in_background: true });
    parent.release("ok");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5000,
      interval: 30,
    });

    // 用户停止（空闲会话 → 直接关）：agent.close 联动取消后台子代理
    expect(cancelChatRun(TASK_ID)).toBe(true);
    await vi.waitFor(
      () =>
        expect(
          (childRuns[0]!.run.cancel as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThan(0),
      { timeout: 3000 },
    );
    await settleTail();
    expect(parentAgent.send).toHaveBeenCalledTimes(1);
    expect(hasChatSession(TASK_ID)).toBe(false);
  });

  it("cancelled 事件即使会话还在也不投递、不落提示行（没人要被取消的结果）", async () => {
    const parent = manualRun();
    const { parentAgent } = await startParentRun(parent.run);
    parent.release("ok");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5000,
      interval: 30,
    });
    expect(hasChatSession(TASK_ID)).toBe(true);

    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_cancelled",
      parentAgentId: PARENT_ID,
      description: "被取消的",
      status: "cancelled",
      text: "",
      durationMs: 10,
      detached: false,
    });
    await settleTail();

    expect(parentAgent.send).toHaveBeenCalledTimes(1);
    const infos = await eventsOfKind("info");
    expect(infos.some((e) => JSON.stringify(e).includes("被取消的"))).toBe(false);
  });

  it("会话已不是发起它的那个（agentId 对不上）→ 丢弃，不打扰当前会话", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent } = await startParentRun(parent.run);
    parent.release("ok");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5000,
      interval: 30,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_old",
      parentAgentId: "some_other_agent",
      description: "老会话派的",
      status: "done",
      text: "不该送进来",
      durationMs: 1000,
      detached: false,
    });
    await settleTail();

    expect(parentAgent.send).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("没有会话 → 丢弃；drainBackgroundResults 对没东西 / 没会话幂等", async () => {
    emitBackgroundSubagentSettled("t_no_such_task", {
      jobId: "bg_x",
      parentAgentId: PARENT_ID,
      description: "x",
      status: "done",
      text: "y",
      durationMs: 1,
      detached: false,
    });
    await settleTail();
    await expect(drainBackgroundResults("t_no_such_task")).resolves.toBeUndefined();
    expect(detachChatForegroundSubagents("t_no_such_task")).toBe(0);
  });

  it("关会话后攒着的结果作废，不会在之后复活", async () => {
    const parent = manualRun();
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    await runTool(subagentTool, { prompt: "a", description: "A", run_in_background: true });
    childRuns[0]!.release("A 的结果");
    await settleTail();

    closeChatSessionUnconditional(TASK_ID);
    parent.release("x");
    await settleTail();

    expect(parentAgent.send).toHaveBeenCalledTimes(1);
    expect(hasChatSession(TASK_ID)).toBe(false);

    // 之后同一任务起了新会话：旧会话攒着的结果不能「复活」送给它
    const parent2 = manualRun();
    const second = await startParentRun(parent2.run);
    parent2.release("ok");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5000,
      interval: 30,
    });
    await settleTail();
    expect(second.parentAgent.send).toHaveBeenCalledTimes(1);
  });

  it("唤醒送不出去（send 抛错、会话随之被关）→ 结果作废，不会复活送给之后的新会话", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parent = manualRun();
    const { parentAgent } = await startParentRun(parent.run);
    parent.release("ok");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5000,
      interval: 30,
    });
    parentAgent.send.mockRejectedValueOnce(new Error("send boom"));

    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_lost",
      parentAgentId: PARENT_ID,
      description: "送不出去",
      status: "done",
      text: "旧会话的结果",
      durationMs: 10,
      detached: false,
    });
    await vi.waitFor(() => expect(parentAgent.send).toHaveBeenCalledTimes(2), {
      timeout: 3000,
      interval: 30,
    });
    await settleTail();
    // sendChatMessage 失败会关掉这个会话
    expect(hasChatSession(TASK_ID)).toBe(false);

    const parent2 = manualRun();
    const second = await startParentRun(parent2.run);
    parent2.release("ok");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5000,
      interval: 30,
    });
    await settleTail();
    expect(second.parentAgent.send).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("空闲回收不能把还有后台子代理的会话回收掉", () => {
  it("回收循环里按 backgroundRunning() 放过（源码契约：关会话会连后台子代理一起取消）", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/lib/server/chat-runner.ts"),
      "utf-8",
    );
    const start = src.indexOf("g[CHAT_SWEEPER_KEY] = setInterval");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf("}, 10 * 60 * 1000)", start));
    expect(block).toContain("backgroundRunning()");
    expect(block.indexOf("backgroundRunning()")).toBeLessThan(
      block.indexOf("closeChatSession"),
    );
  });
});
