/**
 * 第六轮 必修 2：后台子代理结果「暂存」只给自动重连——error / restart 摘会话一律作废并写「未送达」
 *
 * 背景：drainBackgroundResults 的「结果 steer 在飞」分支，只要 steerChatRun 返回 replaced 就把这批结果暂存。
 * 但 replaced 的来源有三种：reconnect / error / restart（markChatInstanceReplacedByReconnect 统一打标）。
 *   - reconnect：同一持久化 agent 的续接，结果对新实例仍有效 → 暂存、接回后送（既有行为，见
 *     chat-background-reconnect-window.test.ts）；
 *   - error / restart：没有「接回」这一步——暂存永远等不到出口，既不会送、也没有「未送达」提示，
 *     而用户在到达时只看到过「将转交」；更糟的是，之后任何同 agentId 的重连都会把这些陈旧结果
 *     投进一个与之无关的新会话（暂存按 agentId 绑定，而持久化 agent 的 id 是跨会话不变的）。
 *
 * 修法：按 rec.replacedReason 分流——只有 reconnect 暂存；其余走 noticeBackgroundResultsDropped（带原因）。
 * 另给暂存加 10 分钟时效（STASHED_BACKGROUND_RESULTS_TTL_MS）：重连链异常没走到收尾时的兜底出口。
 *
 * 全程真实 chat-runner + 真实 subagent link + 真实 finalize，假 SDK。
 * TTL 用例用 fake timers（只 fake setTimeout / clearTimeout），不真等 10 分钟。
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
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-bg-close-reason-"));
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
  STASHED_BACKGROUND_RESULTS_TTL_MS,
  STEER_TOTAL_TIMEOUT_MS,
  __stashBackgroundResultsForTest,
  __stashedBackgroundResultsSnapshotForTest,
  cancelChatRun,
  closeChatSessionUnconditional,
  discardStashedBackgroundResultsForDeletedTask,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { clearChatQueue } = await import("@/lib/server/chat-queue");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-background-result-close-reason DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000012000_bg_close_reason";
const PARENT_ID = "agent_fake_bg_close_reason";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `bg close reason ${id}`,
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

// ----------------- 假子代理（与 chat-background-reconnect-window.test.ts 同口径） -----------------

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

const childRuns: Array<ReturnType<typeof manualRun>> = [];
const installChildFactory = (): void => {
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

/** 立刻自然结束的 run */
const makeQuickRun = () => ({
  stream: async function* (): AsyncGenerator<never> {},
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/**
 * 父会话的一轮 run，steer 永远挂起（最坏形态：只能靠「实例被系统摘表」的信号落定）。
 *   - fail()：流抛不可重试错 → error 收尾
 *   - cancel()：放行流、wait 报 cancelled → 取消收尾（reason 取 cancelChatRun 登记的）
 */
const makeParentRunSteerHang = () => {
  let fail!: () => void;
  const failGate = new Promise<void>((r) => {
    fail = r;
  });
  let cancelled = false;
  const run = {
    stream: async function* (): AsyncGenerator<never> {
      await failGate;
      if (!cancelled) throw new Error("invalid api key");
    },
    wait: async () => {
      await failGate;
      return cancelled ? { status: "cancelled" as const } : { status: "finished" as const };
    },
    cancel: vi.fn(async () => {
      cancelled = true;
      fail();
    }),
    steer: vi.fn((prompt: string) => {
      void prompt; // 只为让 mock.calls 带上入参类型
      return new Promise<never>(() => {});
    }),
  };
  return { run, fail };
};

/** 一轮：流等 breakStream() 后抛网络错（进自动重连）；wait 永远挂起 */
const makeBreakableRun = () => {
  let breakStream!: () => void;
  const gate = new Promise<void>((r) => {
    breakStream = r;
  });
  const run = {
    stream: async function* (): AsyncGenerator<never> {
      await gate;
      throw new Error("fetch failed");
    },
    wait: () => new Promise<never>(() => {}),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return { run, breakStream };
};

type SubagentTool = {
  execute: (
    a: unknown,
    c: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

const startParent = async (parentRun: Record<string, unknown>) => {
  const parentAgent = {
    agentId: PARENT_ID,
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(parentRun),
  };
  mockResume.mockResolvedValueOnce(parentAgent);
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  const tool = (
    mockResume.mock.calls[0]?.[1] as {
      local: { customTools: Record<string, SubagentTool> };
    }
  ).local.customTools.subagent;
  expect(tool).toBeTruthy();
  expect(await sendChatMessage(task, "派后台子代理")).toBe("sent");
  expect(isChatRunActive(TASK_ID)).toBe(true);
  return { parentAgent, tool: tool!, task };
};

const dispatchBackground = async (
  tool: SubagentTool,
  description: string,
): Promise<void> => {
  const r = await tool.execute(
    { prompt: description, description, run_in_background: true },
    {},
  );
  expect(r.content.map((c) => c.text).join("\n")).toContain("已在后台启动");
};

const infoTexts = async (): Promise<string[]> =>
  (await readEvents(TASK_ID))
    .filter((e: TaskEvent) => e.kind === "info")
    .map((e) => (e.kind === "info" ? e.text : ""));

const noticesOf = async (needle: string): Promise<string[]> =>
  (await infoTexts()).filter((t) => t.includes(needle));

const settleTail = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/** 子代理做完 → 结果被 steer 进当前轮（挂起、未确认） */
const releaseAndAwaitSteer = async (
  parent: ReturnType<typeof makeParentRunSteerHang>,
  result: string,
): Promise<void> => {
  childRuns[0]!.release(result);
  await vi.waitFor(() => expect(parent.run.steer).toHaveBeenCalledTimes(1), {
    timeout: 5_000,
    interval: 20,
  });
  expect(String(parent.run.steer.mock.calls[0]?.[0] ?? "")).toContain(result);
};

beforeEach(async () => {
  mockResume.mockReset();
  mockCreate.mockReset();
  installChildFactory();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  await getTask(TASK_ID);
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
  vi.useRealTimers();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("结果 steer 在飞时会话被摘：只有 reconnect 暂存，error / restart 作废并写「未送达」", () => {
  it("error 收尾：这批结果不暂存，事件流写「未送达（对话出错收尾）」且只写一条", async () => {
    const parent = makeParentRunSteerHang();
    const { tool } = await startParent(parent.run);
    await dispatchBackground(tool, "出错前完成");
    await releaseAndAwaitSteer(parent, "出错前的结果：ERRSTASH-001");

    parent.fail(); // 不可重试错 → error 收尾（closeChatSession reason=error）→ steer 判 replaced
    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), {
      timeout: 8_000,
      interval: 30,
    });

    await vi.waitFor(
      async () => {
        expect(
          await noticesOf("1 条后台子代理的结果未送达主 AI（对话出错收尾）"),
        ).toHaveLength(1);
      },
      { timeout: 5_000, interval: 30 },
    );
    // 暂存必须是空的：留着就是永远没有出口的孤儿
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toBeUndefined();
    // 只写一条
    await settleTail(200);
    expect(await noticesOf("条后台子代理的结果未送达主 AI")).toHaveLength(1);
  }, 20_000);

  it("restart（cancelChatRun reason=restart）：同样不暂存，写「未送达（会话重启）」", async () => {
    const parent = makeParentRunSteerHang();
    const { tool } = await startParent(parent.run);
    await dispatchBackground(tool, "重启前完成");
    await releaseAndAwaitSteer(parent, "重启前的结果：RESTARTSTASH-002");

    expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);
    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), {
      timeout: 8_000,
      interval: 30,
    });

    await vi.waitFor(
      async () => {
        expect(
          await noticesOf("1 条后台子代理的结果未送达主 AI（会话重启）"),
        ).toHaveLength(1);
      },
      { timeout: 5_000, interval: 30 },
    );
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toBeUndefined();
    await settleTail(200);
    expect(await noticesOf("条后台子代理的结果未送达主 AI")).toHaveLength(1);
  }, 20_000);

  it("error 摘会话之后，同一 agentId 的新会话发生自动重连：旧结果不会被投进去（陈旧结果复活）", async () => {
    // ① 第一个会话 A：结果 steer 在飞时 error 收尾
    const parent = makeParentRunSteerHang();
    const { tool } = await startParent(parent.run);
    await dispatchBackground(tool, "陈旧结果");
    await releaseAndAwaitSteer(parent, "陈旧结果内容：STALE-RESULT-003");
    parent.fail();
    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), {
      timeout: 8_000,
      interval: 30,
    });
    // 让 steer 落定后的收尾（暂存 / 提示）走完——提示本身由上面两个用例断言，这里只看后果
    await settleTail(300);

    // ② 用户在同一任务上起了新会话 B（同持久化 agent）；B 的一轮断流 → 自动重连 → 接回的新实例 R
    const b = makeBreakableRun();
    const parentB = {
      agentId: PARENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(b.run),
    };
    const rSend = vi.fn().mockImplementation(async () => makeQuickRun());
    const reconnected = { agentId: PARENT_ID, close: vi.fn(), send: rSend };
    mockResume.mockResolvedValueOnce(parentB).mockResolvedValueOnce(reconnected);
    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "新一轮")).toBe("sent");
    b.breakStream();

    // 重连退避 2s（真计时器，同既有重连用例）→ resume R → 重连提示 send → 新 run 收尾 → drain
    await vi.waitFor(() => expect(rSend).toHaveBeenCalledTimes(1), {
      timeout: 12_000,
      interval: 50,
    });
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
    await settleTail(300);
    // R 上只有那一次重连提示：旧结果既不在里面、也没有被单独再送一次
    expect(rSend).toHaveBeenCalledTimes(1);
    expect(String(rSend.mock.calls[0]?.[0])).toContain("网络连接中断");
    expect(rSend.mock.calls.some((c) => String(c[0]).includes("STALE-RESULT-003"))).toBe(
      false,
    );
  }, 40_000);
});

describe("暂存的时效：10 分钟没人接就作废并写「未送达」", () => {
  it("到期前保留、到期写一条「未送达（暂存超时）」并清空；之后不再重复写", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    __stashBackgroundResultsForTest(TASK_ID, PARENT_ID, ["结果一", "结果二"]);
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)?.results).toEqual([
      "结果一",
      "结果二",
    ]);

    await vi.advanceTimersByTimeAsync(STASHED_BACKGROUND_RESULTS_TTL_MS - 1_000);
    // 没到期：原样保留（给重连链留足时间）
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)?.results).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toBeUndefined();

    vi.useRealTimers();
    await vi.waitFor(
      async () => {
        expect(
          await noticesOf("2 条后台子代理的结果未送达主 AI（暂存超时"),
        ).toHaveLength(1);
      },
      { timeout: 5_000, interval: 30 },
    );
  }, 20_000);

  it("到期前被清掉（如回退）：定时器随之取消，不会在之后再补写一条", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timersBefore = vi.getTimerCount();
    __stashBackgroundResultsForTest(TASK_ID, PARENT_ID, ["结果一"]);
    // 暂存时挂了一个时效计时器
    expect(vi.getTimerCount()).toBe(timersBefore + 1);

    // 回退 → closeChatSessionUnconditional 清暂存并写「未送达（回退对话）」
    closeChatSessionUnconditional(TASK_ID);
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toBeUndefined();
    // 计时器随之取消（不是靠「到期时发现已不在」才作罢——那样闭包与结果文本会白白多留 10 分钟）
    expect(vi.getTimerCount()).toBe(timersBefore);

    await vi.advanceTimersByTimeAsync(STASHED_BACKGROUND_RESULTS_TTL_MS + 5_000);
    vi.useRealTimers();
    await vi.waitFor(
      async () => {
        expect(await noticesOf("1 条后台子代理的结果未送达主 AI（回退对话）")).toHaveLength(1);
      },
      { timeout: 5_000, interval: 30 },
    );
    await settleTail(200);
    // 只有回退那一条，没有「暂存超时」的第二条
    expect(await noticesOf("条后台子代理的结果未送达主 AI")).toHaveLength(1);
    expect(await noticesOf("暂存超时")).toHaveLength(0);
  }, 20_000);
});

describe("第七轮 K1-05：删任务时静默清掉暂存", () => {
  it("暂存连同时效计时器一起清掉，到点不会往已删任务的目录里写「暂存超时」", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timersBefore = vi.getTimerCount();
    __stashBackgroundResultsForTest(TASK_ID, PARENT_ID, ["结果一", "结果二"]);
    expect(vi.getTimerCount()).toBe(timersBefore + 1);

    // DELETE /api/tasks/[id]：此刻没有会话、没有重连链收尾，只剩暂存本身
    discardStashedBackgroundResultsForDeletedTask(TASK_ID);
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(timersBefore);

    await vi.advanceTimersByTimeAsync(STASHED_BACKGROUND_RESULTS_TTL_MS + 5_000);
    vi.useRealTimers();
    await settleTail(200);
    // 任务已删、没人看事件流：静默清，既不写「暂存超时」也不写别的「未送达」
    expect(await noticesOf("条后台子代理的结果未送达主 AI")).toHaveLength(0);
  }, 20_000);

  it("没有暂存时是幂等 no-op", () => {
    expect(() => discardStashedBackgroundResultsForDeletedTask(TASK_ID)).not.toThrow();
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toBeUndefined();
  });
});

describe("第七轮 K1-06：结果 steer 超过总期限——措辞如实，与「会话被停止或关闭」区分", () => {
  it("会话与这一轮都还在、steer 一直没落定：写「等了 N 分钟…会话还在」，不写「已被停止或关闭」、不借用「一条插话」", async () => {
    const parent = makeParentRunSteerHang();
    const { tool } = await startParent(parent.run);
    await dispatchBackground(tool, "超时批");

    // steer 的总期限计时器必须是 fake 的：在结果被 steer 之前就装上（计时器创建时才决定用哪个 setTimeout）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    childRuns[0]!.release("超时批的结果：STEERTIMEOUT-001");
    await vi.waitFor(() => expect(parent.run.steer).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
      interval: 20,
    });
    await vi.advanceTimersByTimeAsync(STEER_TOTAL_TIMEOUT_MS + 1_000);
    vi.useRealTimers();

    const minutes = Math.round(STEER_TOTAL_TIMEOUT_MS / 60_000);
    await vi.waitFor(
      async () => {
        expect(
          await noticesOf(
            `1 条后台子代理的结果未送达主 AI（等了 ${minutes} 分钟仍没被这一轮收下`,
          ),
        ).toHaveLength(1);
      },
      { timeout: 5_000, interval: 30 },
    );
    await settleTail(200);
    // 超时不是会话出事：会话与这一轮都还在，SDK 之后仍可能读到
    expect(hasChatSession(TASK_ID)).toBe(true);
    expect(isChatRunActive(TASK_ID)).toBe(true);
    const timeoutNotice = (await noticesOf("等了")).join("\n");
    expect(timeoutNotice).toContain("会话还在");
    expect(timeoutNotice).toContain("若 AI 稍后仍读到会照常使用");
    // 只此一条；不再叠一条「会话已被停止或关闭」，也不借用面向用户插话的「一条插话…」
    expect(await noticesOf("条后台子代理的结果未送达主 AI")).toHaveLength(1);
    expect(await noticesOf("会话已被停止或关闭")).toHaveLength(0);
    expect(await noticesOf("一条插话")).toHaveLength(0);

    // 收尾：别把挂着的这一轮留给后面的用例
    closeChatSessionUnconditional(TASK_ID);
    parent.fail();
  }, 30_000);
});
