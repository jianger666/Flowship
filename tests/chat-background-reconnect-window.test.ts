/**
 * 后台子代理 × 自动重连窗口（真实 chat-runner + 真实 subagent link，假 SDK）
 *
 * P0（结果丢失 + 假提示）：
 *   - 子代理在「自动重连退避窗口」内已完成：结果原先随 closeChatSession 清掉 pendingBackgroundResults 丢了，
 *     事件流却写了「结果已交给主 AI」。现在：重连摘实例前暂存、新实例接回后放回，由收尾 drain 送进 send，且只送一次；
 *   - 「结果 steer 在飞」时实例被重连替换（steerChatRun 返回 replaced）：这批结果原先直接丢弃，现在同样暂存、接回后送出；
 *   - 重连放弃 / 用户停止：不把结果远送给没有人的会话（也不复活送给之后的新会话），清掉并在事件流写真实的「未送达」。
 *
 * P1（静默取消）：
 *   - closeChatSession 带可选 reason；非用户主动的关闭（自动重连摘实例 / error 收尾 / 懒重启 / 编辑回退）
 *     在 agent.close() 触发取消之前读数，事件流里写「因 X，取消了 N 个后台子代理」；用户主动停止不额外写
 *     （stop 路径自己已写「用户停止了对话」）。
 *
 * 重连退避用真计时器（首次 2s），不用 fake timers——同 chat-steer-reconnect-replaced.test.ts。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-bg-reconnect-"));
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
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { clearChatQueue, enqueueChatMessage, isMessageHandedOff } = await import(
  "@/lib/server/chat-queue"
);
const { sendQueuedChatMessageNow } = await import(
  "@/lib/server/chat-queue-send-now"
);
const { getTask } = await import("@/lib/server/task-fs");
const { emitBackgroundSubagentSettled } = await import(
  "@/lib/server/subagent-background"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-background-reconnect-window DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000008000_bg_reconnect";
const PARENT_ID = "agent_fake_bg_reconnect";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `bg reconnect ${id}`,
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

// ----------------- 假子代理（与 chat-background-subagents.test.ts 同口径） -----------------

/** 手动结束的子 run：release(结果) 放行、cancel 即取消 */
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

type SteerOutcome = "complete_delivered" | "revert_to_followup";

/**
 * 父会话的旧实例 A 的一轮 run：stream 等 breakStream() 后抛网络错（进自动重连）。
 * wait 永远挂起——断流后真实 SDK 的 wait 怎样没验证过，取最坏形态。
 * 不给 steer = 忙时后台结果只能攒；给 steer = 结果会被 steer 进这一轮。
 */
const makeParentRun = (opts: { steer?: () => Promise<SteerOutcome> } = {}) => {
  let breakStream!: () => void;
  const gate = new Promise<void>((r) => {
    breakStream = r;
  });
  const run: Record<string, unknown> = {
    stream: async function* (): AsyncGenerator<never> {
      await gate;
      throw new Error("fetch failed");
    },
    wait: () => new Promise<never>(() => {}),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  if (opts.steer) run.steer = vi.fn(opts.steer);
  return { run, breakStream };
};

/** 一轮：流里等 finish() 后自然结束（空闲会话 / 手动收尾用） */
const makeFinishableRun = () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const run = {
    stream: async function* (): AsyncGenerator<never> {
      await gate;
    },
    wait: async () => {
      await gate;
      return { status: "finished" as const };
    },
    cancel: vi.fn().mockImplementation(async () => finish()),
  };
  return { run, finish };
};

/** 一轮：等 fail() 后抛「不可重试」错（走 error 收尾，不进自动重连） */
const makeFatalRun = () => {
  let fail!: () => void;
  const gate = new Promise<void>((r) => {
    fail = r;
  });
  const run = {
    stream: async function* (): AsyncGenerator<never> {
      await gate;
      throw new Error("invalid api key");
    },
    wait: () => new Promise<never>(() => {}),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return { run, fail };
};

/** 立刻自然结束的 run（重连 run / 后续 flush / 唤醒的 run） */
const makeQuickRun = () => ({
  stream: async function* (): AsyncGenerator<never> {},
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** 重连接回的新实例 R：每次 send 都给一个立刻结束的 run */
const makeReconnectAgent = (sendImpl?: () => Promise<unknown>) => {
  const send = vi.fn().mockImplementation(sendImpl ?? (async () => makeQuickRun()));
  return { agent: { agentId: PARENT_ID, close: vi.fn(), send }, send };
};

type SubagentTool = {
  execute: (
    a: unknown,
    c: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

/** 起父会话（resume）并发首条消息让一轮 run 在飞；重连 resume 要的第二个实例由调用方先备好 */
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

const hasInfo = async (needle: string): Promise<boolean> =>
  (await infoTexts()).some((t) => t.includes(needle));

/** 进入重连退避窗口：事件流已有「正在自动重连」、旧实例仍在表内 */
const waitInBackoffWindow = async (): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect(await hasInfo("正在自动重连")).toBe(true);
    },
    { timeout: 5_000, interval: 30 },
  );
  expect(hasChatSession(TASK_ID)).toBe(true);
};

const settleTail = (ms = 60) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  mockResume.mockReset();
  mockCreate.mockReset();
  installChildFactory();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
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
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

// =====================================================================
// P0：结果在重连窗口里不丢
// =====================================================================

describe("P0：后台结果在自动重连窗口里不丢", () => {
  it("子代理在退避窗口内已完成：结果在重连接回的新实例的 send 里送达一次；事件流提示不撒谎", async () => {
    const a = makeParentRun(); // 无 steer：忙时后台结果只能攒
    const r = makeReconnectAgent();
    const { tool } = await startParent(a.run);
    mockResume.mockResolvedValueOnce(r.agent);
    await dispatchBackground(tool, "窗口内完成");

    a.breakStream();
    await waitInBackoffWindow();
    expect(mockResume).toHaveBeenCalledTimes(1); // 还没开始重连 resume

    // 窗口内子代理做完：旧实例仍在表内、但不能 steer（run 已断）→ 结果攒在 pending 里
    childRuns[0]!.release("窗口内的结果：WIN-001");
    await vi.waitFor(
      async () => {
        expect(await hasInfo("后台子代理「窗口内完成」已完成")).toBe(true);
      },
      { timeout: 1_500, interval: 20 },
    );
    expect(mockResume).toHaveBeenCalledTimes(1); // 确认这一切发生在退避窗口内

    // 重连接回新实例：第 1 次 send 是重连提示，第 2 次才是后台结果
    await vi.waitFor(() => expect(r.send).toHaveBeenCalledTimes(2), {
      timeout: 12_000,
      interval: 50,
    });
    const sends = r.send.mock.calls.map((c) => String(c[0]));
    expect(sends[0]).toContain("网络连接中断");
    expect(sends[1]).toContain("[BACKGROUND_SUBAGENT_RESULT]");
    expect(sends[1]).toContain("WIN-001");

    // 一条结果只送一次，之后也不会再有第 3 次 send
    await settleTail(300);
    expect(r.send).toHaveBeenCalledTimes(2);
    expect(sends.filter((s) => s.includes("WIN-001"))).toHaveLength(1);

    // 子代理结果不冒充用户说话、不报错
    const events = await readEvents(TASK_ID);
    expect(events.filter((e) => e.kind === "user_reply")).toHaveLength(0);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    // ③ 到达时的那一行不能谎称「已交给主 AI」（此刻结果还没进任何 send）
    expect((await infoTexts()).some((t) => t.includes("已交给主 AI"))).toBe(false);
    // 暂存已被消费：没有「未送达」提示
    expect(await hasInfo("未送达")).toBe(false);
  }, 30_000);

  it("结果 steer 在飞时实例被重连替换（replaced）：这批结果暂存、新实例接回后送出，不丢也不重复", async () => {
    // steer 永远挂起（最坏形态）：只能靠「实例被重连替换」的信号落定
    const a = makeParentRun({ steer: () => new Promise<SteerOutcome>(() => {}) });
    const r = makeReconnectAgent();
    const { tool } = await startParent(a.run);
    mockResume.mockResolvedValueOnce(r.agent);
    await dispatchBackground(tool, "steer 在飞");

    // 流还活着时子代理做完 → 结果被 steer 进这一轮（挂起、未确认）
    childRuns[0]!.release("steer 在飞的结果：STEER-002");
    await vi.waitFor(
      () => expect(a.run.steer as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1),
      { timeout: 3_000, interval: 20 },
    );
    expect(String((a.run.steer as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain(
      "STEER-002",
    );

    // 断流 → 退避 → 摘旧实例（steer 被判 replaced）→ resume → 重连 run 收尾后 drain
    a.breakStream();
    await vi.waitFor(() => expect(r.send).toHaveBeenCalledTimes(2), {
      timeout: 12_000,
      interval: 50,
    });
    const sends = r.send.mock.calls.map((c) => String(c[0]));
    expect(sends[0]).toContain("网络连接中断");
    expect(sends[1]).toContain("STEER-002");

    await settleTail(300);
    expect(r.send).toHaveBeenCalledTimes(2);
    expect(sends.filter((s) => s.includes("STEER-002"))).toHaveLength(1);
    // 旧实例上只 steer 过一次，没被再次 steer
    expect(a.run.steer as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(await hasInfo("未送达")).toBe(false);
  }, 30_000);

  it("与「立即发送」steer 的重排共存：用户插话与后台结果同时被重连替换，两者都在新实例上各送达一次", async () => {
    const a = makeParentRun({ steer: () => new Promise<SteerOutcome>(() => {}) });
    const r = makeReconnectAgent();
    const { tool } = await startParent(a.run);
    mockResume.mockResolvedValueOnce(r.agent);
    await dispatchBackground(tool, "与插话共存");

    // ① 后台结果 steer 在飞
    childRuns[0]!.release("共存的结果：BOTH-003");
    const steer = a.run.steer as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
      interval: 20,
    });

    // ② 用户又排了一句、点「立即发送」→ steer 同样在飞
    const ITEM_ID = "cq_bg_reconnect_both";
    expect(
      enqueueChatMessage(TASK_ID, {
        itemId: ITEM_ID,
        agentText: "用户插话：BOTH-USER",
        displayText: "用户插话：BOTH-USER",
        enqueuedAt: Date.now(),
      }),
    ).toMatchObject({ ok: true });
    const res = await sendQueuedChatMessageNow(TASK_ID, ITEM_ID, BOOT);
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
      interval: 20,
    });

    // 断流 → 两个 steer 都判 replaced：用户消息重排队、后台结果暂存；新实例上各发一次
    a.breakStream();
    await vi.waitFor(
      () => {
        expect(r.send).toHaveBeenCalledTimes(3);
        expect(isMessageHandedOff(TASK_ID, ITEM_ID)).toBe(true);
      },
      { timeout: 15_000, interval: 50 },
    );
    const sends = r.send.mock.calls.map((c) => String(c[0]));
    expect(sends[0]).toContain("网络连接中断");
    expect(sends.filter((s) => s.includes("BOTH-USER"))).toHaveLength(1);
    expect(sends.filter((s) => s.includes("BOTH-003"))).toHaveLength(1);

    await settleTail(300);
    expect(r.send).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("重连最终放弃：结果不送给之后的新会话，清掉并在事件流写真实的「未送达」", async () => {
    const a = makeParentRun();
    // 重连实例 R：reconnect prompt send 抛「不可重试」错 → 重连链放弃
    const r = makeReconnectAgent(async () => {
      throw new Error("invalid api key");
    });
    const { tool } = await startParent(a.run);
    mockResume.mockResolvedValueOnce(r.agent);
    await dispatchBackground(tool, "放弃前完成");

    a.breakStream();
    await waitInBackoffWindow();
    childRuns[0]!.release("放弃前的结果：GAVEUP-004");
    await vi.waitFor(
      async () => {
        expect(await hasInfo("后台子代理「放弃前完成」已完成")).toBe(true);
      },
      { timeout: 1_500, interval: 20 },
    );

    // 重连链放弃：error 事件 + 无会话残留
    await vi.waitFor(
      async () => {
        expect(r.send).toHaveBeenCalledTimes(1);
        expect(hasChatSession(TASK_ID)).toBe(false);
        expect((await readEvents(TASK_ID)).some((e) => e.kind === "error")).toBe(true);
      },
      { timeout: 12_000, interval: 50 },
    );
    // 真实的「结果未送达」提示（1 条）
    await vi.waitFor(
      async () => {
        expect(await hasInfo("1 条后台子代理的结果未送达主 AI")).toBe(true);
      },
      { timeout: 3_000, interval: 30 },
    );
    expect(r.send.mock.calls.some((c) => String(c[0]).includes("GAVEUP-004"))).toBe(false);

    // 用户之后在同一任务上起了新会话（同持久化 agent 恢复）：旧结果绝不能复活送给它
    const fin = makeFinishableRun();
    const parentB = {
      agentId: PARENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(fin.run),
    };
    mockResume.mockResolvedValueOnce(parentB);
    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "新对话")).toBe("sent");
    fin.finish();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
    await settleTail(300);
    expect(parentB.send).toHaveBeenCalledTimes(1);
    expect(String(parentB.send.mock.calls[0]![0])).not.toContain("GAVEUP-004");
  }, 30_000);

  it("用户在退避窗口里停止：不重连、不送结果，清掉并写「未送达」", async () => {
    const a = makeParentRun();
    const r = makeReconnectAgent();
    const { tool } = await startParent(a.run);
    mockResume.mockResolvedValueOnce(r.agent);
    await dispatchBackground(tool, "停止前完成");

    a.breakStream();
    await waitInBackoffWindow();
    childRuns[0]!.release("停止前的结果：STOP-005");
    await vi.waitFor(
      async () => {
        expect(await hasInfo("后台子代理「停止前完成」已完成")).toBe(true);
      },
      { timeout: 1_500, interval: 20 },
    );

    expect(cancelChatRun(TASK_ID)).toBe(true);
    await vi.waitFor(
      async () => {
        expect(hasChatSession(TASK_ID)).toBe(false);
        expect(await hasInfo("1 条后台子代理的结果未送达主 AI")).toBe(true);
      },
      { timeout: 5_000, interval: 30 },
    );
    // 没有重连、没有往任何实例送过结果
    await settleTail(300);
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(r.send).not.toHaveBeenCalled();
  }, 30_000);

  it("摘实例后、resume 还没回来时用户停止：暂存的结果清掉并写「未送达」，新实例不会被发结果", async () => {
    const a = makeParentRun();
    const r = makeReconnectAgent();
    const { tool } = await startParent(a.run);
    // 第二次 resume（重连）停在半路，由测试放行
    let resolveReconnect!: (agent: unknown) => void;
    mockResume.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveReconnect = res;
        }),
    );
    await dispatchBackground(tool, "resume 途中停止");

    a.breakStream();
    await waitInBackoffWindow();
    childRuns[0]!.release("resume 途中的结果：MID-006");
    await vi.waitFor(
      async () => {
        expect(await hasInfo("后台子代理「resume 途中停止」已完成")).toBe(true);
      },
      { timeout: 1_500, interval: 20 },
    );

    // 退避结束：旧实例已摘、重连 resume 在飞（表里没有会话）
    await vi.waitFor(() => expect(mockResume).toHaveBeenCalledTimes(2), {
      timeout: 8_000,
      interval: 30,
    });
    expect(hasChatSession(TASK_ID)).toBe(false);

    // 用户此刻停止：表里没有 record，只能靠重连的停止闭包
    expect(cancelChatRun(TASK_ID)).toBe(true);
    resolveReconnect(r.agent);

    await vi.waitFor(
      async () => {
        expect(await hasInfo("1 条后台子代理的结果未送达主 AI")).toBe(true);
      },
      { timeout: 5_000, interval: 30 },
    );
    await settleTail(300);
    // 僵尸实例被关、重连提示都没发、更没有送结果
    expect(r.send).not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
  }, 30_000);
});

describe("P0 补充：到达时只说「将转交」，之后没送成必须有一句「未送达」", () => {
  it("空闲唤醒送不出去（send 抛错、会话被关）：结果不复活，事件流写「未送达」", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fin = makeFinishableRun();
      const { parentAgent } = await startParent(fin.run);
      fin.finish();
      await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
        timeout: 5_000,
        interval: 30,
      });
      parentAgent.send.mockRejectedValueOnce(new Error("send boom"));

      emitBackgroundSubagentSettled(TASK_ID, {
        jobId: "bg_lost_notice",
        parentAgentId: PARENT_ID,
        description: "送不出去",
        status: "done",
        text: "旧会话的结果：LOST-007",
        durationMs: 10,
        detached: false,
      });
      await vi.waitFor(
        async () => {
          expect(parentAgent.send).toHaveBeenCalledTimes(2);
          expect(hasChatSession(TASK_ID)).toBe(false);
          expect(await hasInfo("1 条后台子代理的结果未送达主 AI")).toBe(true);
        },
        { timeout: 5_000, interval: 30 },
      );
      // 到达那一行只说「将转交」，不说「已交给」
      expect(await hasInfo("后台子代理「送不出去」已完成")).toBe(true);
      expect((await infoTexts()).some((t) => t.includes("已交给主 AI"))).toBe(false);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }, 20_000);

  it("到达提示落盘的 await 期间会话被关：结果不复活、不送给之后同 agentId 的新会话，并写「未送达」", async () => {
    // 为什么：deliver 在「落到达提示」处 await，期间会话被关（用户停止 / 回退 / 重启）时，
    // closeChatSession 清的是「此刻」的 pending——这条结果还没入队，清不到；await 返回后若无条件入队，
    // 它就成了无主的孤儿，被同一持久化 agent（agentId 相同，按 agentId 拦不住）的下一个新会话收尾时送出。
    // 所以入队前必须按 instanceId 复核发起它的实例还在。
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fin = makeFinishableRun();
      const { parentAgent } = await startParent(fin.run);
      fin.finish();
      await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
        timeout: 5_000,
        interval: 30,
      });
      expect(parentAgent.send).toHaveBeenCalledTimes(1);

      // 收尾事件刚到（deliver 同步段已过、卡在落提示的 await 里），会话紧跟着被关
      emitBackgroundSubagentSettled(TASK_ID, {
        jobId: "bg_race_open",
        parentAgentId: PARENT_ID,
        description: "赛跑的",
        status: "done",
        text: "旧会话的结果：RACE-009",
        durationMs: 10,
        detached: false,
      });
      closeChatSessionUnconditional(TASK_ID);
      await settleTail(150);

      // 同一任务、同一持久化 agent（agentId 不变）起了新会话：旧结果不能复活送给它
      const fin2 = makeFinishableRun();
      const second = {
        agentId: PARENT_ID,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(fin2.run),
      };
      mockResume.mockResolvedValueOnce(second);
      expect(await resumeChatSession(asTask(makeMeta(TASK_ID)), BOOT)).not.toBeNull();
      expect(await sendChatMessage(asTask(makeMeta(TASK_ID)), "新会话首条")).toBe("sent");
      fin2.finish();
      await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
        timeout: 5_000,
        interval: 30,
      });
      await settleTail(300);

      const secondTexts = second.send.mock.calls.map((c) => String(c[0]));
      expect(second.send).toHaveBeenCalledTimes(1);
      expect(secondTexts.some((t) => t.includes("RACE-009"))).toBe(false);
      // 到达那行已经落过「将转交」，被关作废的这条要说实话
      expect(await hasInfo("1 条后台子代理的结果未送达主 AI")).toBe(true);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }, 20_000);

  it("steer 在飞（结果已出队、落过「将转交」）时用户停止：这批结果走 cancelled 作废，事件流写且只写一条「未送达」", async () => {
    // 为什么：忙分支把结果 splice 出队后 await steer；这时用户停止，steer 被拒、outcome=cancelled。
    // 这批只有 drain 手里拿着（closeChatSession 清的 pending 里没有它），到达时又已落过「将转交」——
    // 不在这里补一句，用户就以为结果交给了主 AI，实际悄悄没了。
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
    const { parentAgent, tool } = await startParent(run);
    // 关 agent 时才让挂起的 steer 被拒绝（与真实 SDK「会话摘表后 steer 失败」同形）
    parentAgent.close.mockImplementation(() => rejectSteer(new Error("agent closed")));
    await dispatchBackground(tool, "查资料");

    // 主 AI 在忙且能 steer 时结果到达 → drain 把它 splice 出队、steer 进当前轮（挂着没落定）
    childRuns[0]!.release("资料内容：STEER-STOP-010");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
      interval: 30,
    });

    expect(cancelChatRun(TASK_ID)).toBe(true);
    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), {
      timeout: 8_000,
      interval: 30,
    });
    await vi.waitFor(
      async () => {
        expect(await hasInfo("1 条后台子代理的结果未送达主 AI")).toBe(true);
      },
      { timeout: 8_000, interval: 30 },
    );
    // 只写一条、不重复；结果也没有被送去别处
    await settleTail(200);
    const notices = (await infoTexts()).filter((t) =>
      t.includes("条后台子代理的结果未送达主 AI"),
    );
    expect(notices).toHaveLength(1);
    expect(parentAgent.send).toHaveBeenCalledTimes(1);
  }, 25_000);
});

// =====================================================================
// P1：非用户主动的关闭要让用户看见「取消了 N 个后台子代理」
// =====================================================================

describe("P1：非用户主动关会话时，事件流留一句「取消了 N 个后台子代理」", () => {
  it("自动重连摘实例：仍在跑的后台子代理被取消，事件流写原因与数量（取消事件仍不投递）", async () => {
    const a = makeParentRun();
    const r = makeReconnectAgent();
    const { tool } = await startParent(a.run);
    mockResume.mockResolvedValueOnce(r.agent);
    await dispatchBackground(tool, "重连时在跑");
    await dispatchBackground(tool, "重连时也在跑");
    expect(childRuns).toHaveLength(2);

    a.breakStream();
    await vi.waitFor(
      async () => {
        expect(await hasInfo("因自动重连替换会话，取消了 2 个后台子代理")).toBe(true);
      },
      { timeout: 8_000, interval: 30 },
    );
    // 真的被取消了；且只写一条
    for (const c of childRuns) expect(c.run.cancel).toHaveBeenCalled();
    expect(
      (await infoTexts()).filter((t) => t.includes("个后台子代理")),
    ).toHaveLength(1);

    // 重连照常完成；被取消的不投递（既有设计）、也不是「未送达」
    await vi.waitFor(() => expect(r.send).toHaveBeenCalledTimes(1), {
      timeout: 12_000,
      interval: 50,
    });
    await settleTail(300);
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(await hasInfo("未送达")).toBe(false);
  }, 30_000);

  it("用户主动停止（空闲会话）：后台子代理被取消，但不额外写「取消了 N 个」（stop 路径自己会写停止提示）", async () => {
    const fin = makeFinishableRun();
    const { tool } = await startParent(fin.run);
    await dispatchBackground(tool, "用户停止时在跑");
    fin.finish();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
    expect(hasChatSession(TASK_ID)).toBe(true);

    expect(cancelChatRun(TASK_ID)).toBe(true);
    await vi.waitFor(
      () => expect(childRuns[0]!.run.cancel).toHaveBeenCalled(),
      { timeout: 3_000, interval: 30 },
    );
    await settleTail(200);
    expect(hasChatSession(TASK_ID)).toBe(false);
    expect((await infoTexts()).some((t) => t.includes("个后台子代理"))).toBe(false);
  }, 20_000);

  it("error 收尾（不可重试错）：写「因对话出错收尾，取消了 1 个后台子代理」", async () => {
    const fatal = makeFatalRun();
    const { tool } = await startParent(fatal.run);
    await dispatchBackground(tool, "出错时在跑");

    fatal.fail();
    await vi.waitFor(
      async () => {
        expect(await hasInfo("因对话出错收尾，取消了 1 个后台子代理")).toBe(true);
      },
      { timeout: 8_000, interval: 30 },
    );
    expect(childRuns[0]!.run.cancel).toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
  }, 20_000);

  it("懒重启 forceClear：写「因会话重启，取消了 1 个后台子代理」", async () => {
    const fin = makeFinishableRun();
    const { tool } = await startParent(fin.run);
    await dispatchBackground(tool, "重启时在跑");
    fin.finish();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });

    forceClearChatRun(TASK_ID, { keepPersisted: true });
    await vi.waitFor(
      async () => {
        expect(await hasInfo("因会话重启，取消了 1 个后台子代理")).toBe(true);
      },
      { timeout: 3_000, interval: 30 },
    );
    expect(childRuns[0]!.run.cancel).toHaveBeenCalled();
  }, 20_000);

  it("编辑回退 closeChatSessionUnconditional：写「因回退对话，取消了 1 个后台子代理」", async () => {
    const fin = makeFinishableRun();
    const { tool } = await startParent(fin.run);
    await dispatchBackground(tool, "回退时在跑");
    fin.finish();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });

    closeChatSessionUnconditional(TASK_ID);
    await vi.waitFor(
      async () => {
        expect(await hasInfo("因回退对话，取消了 1 个后台子代理")).toBe(true);
      },
      { timeout: 3_000, interval: 30 },
    );
    expect(childRuns[0]!.run.cancel).toHaveBeenCalled();
  }, 20_000);

  it("没有在跑的后台子代理时：任何原因的关闭都不写这句（不制造噪音）", async () => {
    const fin = makeFinishableRun();
    await startParent(fin.run);
    fin.finish();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });

    forceClearChatRun(TASK_ID, { keepPersisted: true });
    await settleTail(200);
    expect((await infoTexts()).some((t) => t.includes("个后台子代理"))).toBe(false);
  }, 20_000);
});

// =====================================================================
// F4-03：懒重启主路径（cancelChatRun → 收尾 cancelled → 摘会话）原先不带原因，仍然静默
// =====================================================================

describe("F4-03：懒重启主路径 cancelChatRun(reason=restart) 也要留「取消了 N 个后台子代理」", () => {
  it("run 在跑时懒重启取消：收尾 cancelled 摘会话，写「因会话重启，取消了 1 个后台子代理」", async () => {
    const fin = makeFinishableRun();
    const { tool } = await startParent(fin.run);
    await dispatchBackground(tool, "懒重启时在跑");
    expect(isChatRunActive(TASK_ID)).toBe(true);

    expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);

    await vi.waitFor(
      async () => {
        expect(await hasInfo("因会话重启，取消了 1 个后台子代理")).toBe(true);
      },
      { timeout: 5_000, interval: 30 },
    );
    expect(childRuns[0]!.run.cancel).toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
    expect(
      (await infoTexts()).filter((t) => t.includes("个后台子代理")),
    ).toHaveLength(1);
  }, 20_000);

  it("会话空闲时懒重启取消：同样写「因会话重启，取消了 1 个后台子代理」", async () => {
    const fin = makeFinishableRun();
    const { tool } = await startParent(fin.run);
    await dispatchBackground(tool, "空闲时懒重启");
    fin.finish();
    await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });

    expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);

    await vi.waitFor(
      async () => {
        expect(await hasInfo("因会话重启，取消了 1 个后台子代理")).toBe(true);
      },
      { timeout: 3_000, interval: 30 },
    );
    expect(hasChatSession(TASK_ID)).toBe(false);
  }, 20_000);

  it("对照：run 在跑时用户停止（不带 reason）仍不额外写「取消了 N 个」", async () => {
    const fin = makeFinishableRun();
    const { tool } = await startParent(fin.run);
    await dispatchBackground(tool, "用户停止时在跑");

    expect(cancelChatRun(TASK_ID)).toBe(true);

    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
    expect(childRuns[0]!.run.cancel).toHaveBeenCalled();
    await settleTail(200);
    expect((await infoTexts()).some((t) => t.includes("个后台子代理"))).toBe(false);
  }, 20_000);

  it("用户意图优先：懒重启取消登记后、收尾前用户又点了停止，不再按「会话重启」提示", async () => {
    const fin = makeFinishableRun();
    const { tool } = await startParent(fin.run);
    await dispatchBackground(tool, "先重启后停止");

    // 同一同步段内两次取消：收尾（异步）读到的原因必须是后一次（用户）的
    expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);
    expect(cancelChatRun(TASK_ID)).toBe(true);

    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 30,
    });
    await settleTail(200);
    expect((await infoTexts()).some((t) => t.includes("个后台子代理"))).toBe(false);
  }, 20_000);
});
