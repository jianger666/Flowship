/**
 * 后台子代理结果「落定」的几个边角（真实 chat-runner + 真实 subagent link，假 SDK）。
 *
 * 与 chat-background-reconnect-window.test.ts（重连窗口主线）互补，只覆盖那边没碰的缝：
 *   1. 子代理收尾事件到达后、deliver 在「落提示」的 await 里，会话被关：
 *      结果不能被塞进一个没有会话的 key、之后复活送给新会话（与「按会话绑定」同一条约束）；
 *   2. steer 在飞（结果已 splice 出队、落过「将转交」提示）时用户停止：
 *      这批结果走 cancelled 分支作废，不能悄悄没了——事件流要有「未送达」；
 *   3. 跨重连的两条结果（一条在 steer 里被替换、一条在退避窗口到达）：先到的在前、各只送一次。
 *
 * 断言只认语义（数量 + 「未送达主 AI」），不绑死具体措辞。
 * 断流用假 run 模拟：stream 在 gate 放行后抛网络错（进自动重连）、wait 永远挂起（最坏形态）；
 * 重连退避用真计时器（首次 2s），不用 fake timers。并行隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import。
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
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-bg-settle-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

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
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { clearChatQueue } = await import("@/lib/server/chat-queue");
const { emitBackgroundSubagentSettled } = await import(
  "@/lib/server/subagent-background"
);
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-background-result-settle DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000009000_bg_settle";
const PARENT_ID = "agent_fake_bg_settle";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `bg settle ${id}`,
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

type ToolResult = { content: Array<{ text: string }> };
type SubagentTool = { execute: (a: unknown, c: unknown) => Promise<ToolResult> };

/** 手动结束的子 run：release 放行（带结果文本）、cancel 当作被取消 */
const manualRun = () => {
  let release!: (result?: string) => void;
  let result: string | undefined;
  const gate = new Promise<void>((r) => {
    release = (res) => {
      result = res;
      r();
    };
  });
  let cancelled = false;
  const run = {
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
  };
  return { run, release };
};

/** 子代理工厂：每次起子 agent 给一个手动控制的 run */
const childRuns: Array<ReturnType<typeof manualRun>> = [];
const installChildFactory = () => {
  childRuns.length = 0;
  let n = 0;
  mockCreate.mockImplementation(async () => {
    n += 1;
    const r = manualRun();
    childRuns.push(r);
    return {
      agentId: `child-${n}`,
      send: vi.fn().mockResolvedValue(r.run),
      close: vi.fn(),
    };
  });
};

/** 立刻自然结束的 run（重连提示 / 唤醒送结果的 run） */
const quickRun = () => ({
  stream: async function* (): AsyncGenerator<never> {},
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** 取 resume 时挂上的 subagent 工具（第 callIndex 次 resume） */
const subagentToolOf = (callIndex: number): SubagentTool => {
  const tool = (
    mockResume.mock.calls[callIndex]?.[1] as {
      local: { customTools: Record<string, SubagentTool> };
    }
  ).local.customTools.subagent;
  expect(tool).toBeTruthy();
  return tool!;
};

/** 派一个后台子代理（run_in_background）：立刻返回 */
const spawnBackground = async (tool: SubagentTool, description: string) => {
  const r = await tool.execute(
    { prompt: description, description, run_in_background: true },
    {},
  );
  expect(r.content.map((c) => c.text).join("")).toContain("已在后台启动");
};

const infosOf = async (): Promise<TaskEvent[]> =>
  (await readEvents(TASK_ID)).filter((e) => e.kind === "info");

/** 「N 条/个…结果未送达主 AI」：只认数量 + 语义，不绑措辞 */
const undeliveredRe = (n: number): RegExp =>
  new RegExp(`${n} [条个][^（。\\n]*结果未送达主 AI`);

const undeliveredInfos = async (n: number): Promise<TaskEvent[]> =>
  (await infosOf()).filter((e) => undeliveredRe(n).test(e.text));

const waitForUndelivered = (n: number, timeout: number) =>
  vi.waitFor(
    async () => expect((await undeliveredInfos(n)).length).toBeGreaterThan(0),
    { timeout, interval: 50 },
  );

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  mockResume.mockReset();
  mockCreate.mockReset();
  installChildFactory();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await settle();
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 惰性触发：在任务还是 idle 时先触发一次
  await getTask(TASK_ID);
  // 自动重连读服务端凭据（readServerChatCreds）：钉一份 config.json
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({
      apiKey: "server-key",
      defaultModel: { id: "gpt-test", params: [] },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await settle();
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await settle(50);
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("结果落定的边角：不复活、不悄悄没", () => {
  it("收尾事件到达后、deliver 在「落提示」的 await 里会话被关：结果不会复活送给之后的新会话", async () => {
    const parent = manualRun();
    const parentAgent = {
      agentId: PARENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(parent.run),
    };
    mockResume.mockResolvedValue(parentAgent);
    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "先干这个")).toBe("sent");
    parent.release("ok");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });

    // 收尾事件刚到（deliver 的同步段已过、卡在落提示的 await 里），会话紧跟着被关
    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_race01",
      parentAgentId: PARENT_ID,
      description: "赛跑的",
      status: "done",
      text: "旧会话的结果-RACE",
      durationMs: 10,
      detached: false,
    });
    closeChatSessionUnconditional(TASK_ID);
    await settle(100);

    // 之后同一任务起了新会话：旧会话的结果不能复活送给它
    const parent2 = manualRun();
    const second = {
      agentId: PARENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(parent2.run),
    };
    mockResume.mockResolvedValue(second);
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "新会话首条")).toBe("sent");
    parent2.release("ok");
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
    await settle(300);

    expect(second.send).toHaveBeenCalledTimes(1);
    expect(
      second.send.mock.calls.some((c) => String(c[0]).includes("RACE")),
    ).toBe(false);
    // 随会话作废的结果要说实话
    expect((await undeliveredInfos(1)).length).toBeGreaterThan(0);
  }, 20_000);

  it("steer 在飞（结果已出队、落过「将转交」提示）时用户停止：这批结果不会悄悄没了，事件流有「未送达」", async () => {
    // 停止型 run：cancel 放行流并让 wait 报 cancelled；关 agent 时 steer 才被拒绝（会话摘表）
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let stopped = false;
    let rejectSteer: (e: Error) => void = () => {};
    const steer = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectSteer = reject;
        }),
    );
    const run = {
      stream: async function* (): AsyncGenerator<never> {
        await gate;
      },
      wait: async () => {
        await gate;
        return { status: stopped ? ("cancelled" as const) : ("finished" as const) };
      },
      cancel: vi.fn(async () => {
        stopped = true;
        release();
      }),
      steer,
    };
    const send = vi.fn().mockResolvedValue(run);
    const close = vi.fn(() => rejectSteer(new Error("agent closed")));
    mockResume.mockResolvedValueOnce({ agentId: PARENT_ID, close, send });
    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    const tool = subagentToolOf(0);
    expect(await sendChatMessage(task, "派后台子代理")).toBe("sent");
    await spawnBackground(tool, "查资料");

    // 结果在主 AI 在忙且能 steer 时到达 → drain 把它 splice 出队、steer 进当前轮（挂着没落定）
    childRuns[0]!.release("资料内容：STEER-STOP");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
      interval: 30,
    });

    expect(cancelChatRun(TASK_ID)).toBe(true);
    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), {
      timeout: 8_000,
      interval: 30,
    });
    await waitForUndelivered(1, 8_000);
    // 只写一条、不重复；结果也没有被送去别处
    await settle(200);
    expect(await undeliveredInfos(1)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  }, 25_000);
});

describe("跨重连的多条结果：保序、各只送一次", () => {
  it("一条在 steer 里被替换、一条在退避窗口到达：新实例按到达先后收到，每条恰好一次", async () => {
    // 断流的 run：steer 永远挂起（最坏形态）、wait 永远挂起
    let breakStream!: () => void;
    const gate = new Promise<void>((r) => {
      breakStream = r;
    });
    const steer = vi.fn(() => new Promise<never>(() => {}));
    const aRun = {
      stream: async function* (): AsyncGenerator<never> {
        await gate;
        throw new Error("fetch failed");
      },
      wait: () => new Promise<never>(() => {}),
      cancel: vi.fn().mockResolvedValue(undefined),
      steer,
    };
    const aSend = vi.fn().mockResolvedValue(aRun);
    const rSend = vi
      .fn()
      .mockResolvedValueOnce(quickRun())
      .mockResolvedValueOnce(quickRun());
    mockResume
      .mockResolvedValueOnce({ agentId: PARENT_ID, close: vi.fn(), send: aSend })
      .mockResolvedValueOnce({ agentId: PARENT_ID, close: vi.fn(), send: rSend });
    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    const tool = subagentToolOf(0);
    expect(await sendChatMessage(task, "派后台子代理")).toBe("sent");
    await spawnBackground(tool, "任务一");
    await spawnBackground(tool, "任务二");

    childRuns[0]!.release("结果一-AAA");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
      interval: 30,
    });

    breakStream();
    await vi.waitFor(
      async () =>
        expect(
          (await infosOf()).some(
            (e) => e.meta?.kind === "reconnecting" && e.meta?.attempt === 1,
          ),
        ).toBe(true),
      { timeout: 5_000, interval: 30 },
    );
    // 第二个结果在退避窗口内到达（断流的 run 已不能 steer，只能攒着）
    childRuns[1]!.release("结果二-BBB");
    await vi.waitFor(
      async () =>
        expect(
          (await infosOf()).some((e) => e.text.includes("后台子代理「任务二」已完成")),
        ).toBe(true),
      { timeout: 5_000, interval: 30 },
    );

    await vi.waitFor(() => expect(rSend).toHaveBeenCalledTimes(2), {
      timeout: 15_000,
      interval: 50,
    });
    const woke = String(rSend.mock.calls[1]?.[0]);
    expect(woke).toContain("结果一-AAA");
    expect(woke).toContain("结果二-BBB");
    expect(woke.indexOf("结果一-AAA")).toBeLessThan(woke.indexOf("结果二-BBB"));

    await settle(300);
    const all = [...aSend.mock.calls, ...rSend.mock.calls].map((c) => String(c[0]));
    expect(all.filter((t) => t.includes("结果一-AAA"))).toHaveLength(1);
    expect(all.filter((t) => t.includes("结果二-BBB"))).toHaveLength(1);
    expect(rSend).toHaveBeenCalledTimes(2);
    // 没有「未送达」的假警报
    expect((await infosOf()).some((e) => /未送达主 AI/.test(e.text))).toBe(false);
  }, 30_000);
});
