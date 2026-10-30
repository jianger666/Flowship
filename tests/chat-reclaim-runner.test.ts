/**
 * X3：热会话回收（真实 chat-runner + 假 SDK）
 *
 * 背景：chat 会话空闲 12 分钟才回收，但「两边接力」（定时 / 评审）都是每 10 分钟来一条，会话永远等不到空闲；
 * 一个长会话在进程堆里占约 2 GB，约 6~7 小时堆耗尽、server 崩溃。修法三件：
 *   (a) 定时触发的 run 自然结束 → 宽限后回收会话（keepPersisted，下条消息 Agent.resume 接回）；用户 run 保持 12 分钟 TTL；
 *   (b) 堆水位门：软水位先回收「空闲、守卫放行」的别的热会话（占用从大到小、不含目标会话）；
 *   (c) 遥测：热会话探针（run-perf 经它读）。
 *
 * 本文件覆盖的行为（简报要求的用例编号）：
 *   ① 定时 run 结束 → 会话被关且 keepPersisted     ② 用户 run 结束 → 仍热（到 TTL 才回收）
 *   ③ runActive / 后台子代理 / 队列非空 / 待答 ask_user（及 lifecycle / in-flight steer）各一条「不关」
 *   ④ 关后下一条定时能 resume 并继续               ⑤（runner 层）水位回收只挑空闲会话、不挑目标，按占用从大到小
 *   ⑦ soak：假 agent，2 个任务各 10 分钟接力 N 轮 → 稳态热会话数 ≤ 1、不随轮数增长（含「用户 run 接力 10 分钟永远热」对照）
 *   ⑥ 的探针一致性（热会话探针与 runningChats 一致）；⑤ 的路由级（0.7 / 0.85）在 chat-reclaim-heap-gate.test.ts。
 *
 * 新导出（sweepIdleChatSessions / __setScheduledReclaimGraceMsForTests / reclaimChatSessionsForWatermark）
 * 一律经「宽松访问 + 缺失降级」使用：这样本文件在基线源码上也能加载运行，红的是行为（会话没被回收），不是「找不到函数」。
 *
 * 分类：回归 = 改前会红；对照 = 改前改后都绿（防改过头）。
 * 并行隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import；每个用例独立任务 id。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-reclaim-runner-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockResume = vi.fn();
const mockCreate = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

// runChatSession（冷启动首包）的热路径：避免真探测拖慢 / 不稳定（与 chat-runner-start-lease.test.ts 同口径）
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({ servers, dropped: [] }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));

const { readMetaV06, taskDir, withTaskLock, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const runner = await import("@/lib/server/chat-runner");
const {
  closeChatSessionUnconditional,
  hasChatSession,
  isChatRunActive,
  registerInflightSteer,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
} = runner;
const { beginChatQueueInFlight, clearChatQueue, endChatQueueInFlight, enqueueChatMessage } =
  await import("@/lib/server/chat-queue");
const { __resetPendingAskStateForTest, clearPendingAsk, registerPendingAsk } = await import(
  "@/lib/server/chat-pending"
);
const { beginChatLifecycle, endChatLifecycle, endChatRewind, tryBeginChatRewind } = await import(
  "@/lib/server/chat-gate"
);
const {
  CHAT_WATERMARK_SOFT_RATIO,
  __resetChatReclaimForTests,
  getChatHotSessions,
  getChatReclaimCounts,
} = await import("@/lib/server/chat-reclaim");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`chat-reclaim-runner DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

/** 新导出的宽松访问：基线上缺失 → 降级成「什么都不做」，让断言去红在行为上 */
const newApi = runner as unknown as {
  sweepIdleChatSessions?: (now?: number) => number;
  __setScheduledReclaimGraceMsForTests?: (ms?: number) => void;
  reclaimChatSessionsForWatermark?: (opts: {
    exceptTaskId?: string;
    heapRatio: () => number;
    estimate?: (agentId: string) => Promise<number | undefined>;
  }) => Promise<number>;
};
const sweep = (now: number): number => newApi.sweepIdleChatSessions?.(now) ?? 0;
const setGrace = (ms?: number): void => newApi.__setScheduledReclaimGraceMsForTests?.(ms);
const reclaimForWatermark = (opts: {
  exceptTaskId?: string;
  heapRatio: () => number;
  estimate?: (agentId: string) => Promise<number | undefined>;
}): Promise<number> => newApi.reclaimChatSessionsForWatermark?.(opts) ?? Promise.resolve(0);

/**
 * 白盒：直接改 chat-runner 的进程级状态表（`globalThis["__flowshipChatRunnerStateV2__"]`）。
 * 为什么要白盒：真实流程里「正在 drain」「攒着的后台结果」「agent 还没挂上」这三个守卫输入，
 * 总会伴随别的守卫（队列数 / in-flight / run 在跑）一起命中，单独造不出来——
 * 于是「接线接错」会被另一个守卫掩护，只靠黑盒测不出。键名变了这里会**响亮地**抛，不会静默放过。
 */
const runnerState = (): {
  runningChats: Map<string, { agent: unknown }>;
  drainingQueues: Set<string>;
  pendingBackgroundResults: Map<string, string[]>;
} => {
  const s = (globalThis as unknown as Record<string, unknown>)["__flowshipChatRunnerStateV2__"];
  if (!s) throw new Error("chat-runner 的进程级状态表不存在（键名变了？）");
  return s as ReturnType<typeof runnerState>;
};

const MIN = 60_000;
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};
const SCHEDULED_TEXT = "[SCHEDULE_FIRED id=sch_x3.1.1] 定时任务到点了。去看一眼 CI。";
const USER_TEXT = "帮我看看这个 bug";

let seq = 0;
const usedIds = new Set<string>();
const newId = (): string => {
  seq += 1;
  const id = `t_1700000007000_x3_${seq}`;
  usedIds.add(id);
  return id;
};
const agentIdOf = (taskId: string): string => `agent_fake_${taskId}`;

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `x3 ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: agentIdOf(id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;
const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

/** 立即结束的 run（stream 无事件、wait 返回 finished） */
const finishingRun = () => ({
  stream: async function* () {
    /* 空 */
  },
  wait: async () => ({ status: "finished" as const, result: "好的" }),
  cancel: vi.fn(async () => {}),
});

/** 手动结束的 run：release() 前一直在跑（stream / wait 都挂在 gate 上） */
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
  const run: Record<string, unknown> = {
    stream: async function* () {
      await gate;
    },
    wait: async () => {
      await gate;
      return cancelled
        ? { status: "cancelled" as const }
        : { status: "finished" as const, result: result ?? "好的" };
    },
    cancel: vi.fn(async () => {
      cancelled = true;
      release();
    }),
  };
  return { run, release };
};

const makeAgent = (agentId: string, sendImpl?: () => unknown) => ({
  agentId,
  close: vi.fn(),
  send: vi.fn(async () => (sendImpl ? sendImpl() : finishingRun())),
});
type FakeAgent = ReturnType<typeof makeAgent>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitRunDone = (id: string) =>
  vi.waitFor(() => expect(isChatRunActive(id)).toBe(false), {
    timeout: 5000,
    interval: 15,
  });

/** 把盘上已有的 meta 重写一份（回收后 keepPersisted 应保留 sessionAgentId；这里只负责初始化） */
const initTask = async (id: string): Promise<Task> => {
  await writeMeta(makeMeta(id));
  return asTask(makeMeta(id));
};

/**
 * 建一个热会话并发一条消息；等 run 自然结束（不等宽限回收）。
 * 会话已存在（热）则直接在它上面 send（真实链路里热会话就是这样续的）；不存在则 resume 一个新 agent。
 */
const startHot = async (
  id: string,
  text: string,
  opts: { agent?: FakeAgent } = {},
): Promise<FakeAgent> => {
  const task = asTask(makeMeta(id));
  let agent = opts.agent;
  if (!hasChatSession(id)) {
    agent = agent ?? makeAgent(agentIdOf(id));
    mockResume.mockResolvedValueOnce(agent);
    expect(await resumeChatSession(task, BOOT), `resume ${id}`).not.toBeNull();
  }
  expect(await sendChatMessage(task, text), `send ${id}`).toBe("sent");
  await waitRunDone(id);
  return agent as FakeAgent;
};

/** 建一个热会话并让 run 一直在跑（返回 release） */
const startRunning = async (id: string, text: string) => {
  const task = asTask(makeMeta(id));
  const m = manualRun();
  const agent = makeAgent(agentIdOf(id), () => m.run);
  mockResume.mockResolvedValueOnce(agent);
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, text)).toBe("sent");
  expect(isChatRunActive(id)).toBe(true);
  return { agent, release: m.release };
};

let logSpy: { mock: { calls: unknown[][] } };
const logged = (): string => logSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");

beforeEach(() => {
  mockResume.mockReset();
  mockCreate.mockReset();
  __resetChatReclaimForTests({ keepProbe: true });
  __resetPendingAskStateForTest();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  setGrace();
  for (const id of usedIds) {
    clearChatQueue(id);
    clearPendingAsk(id);
    endChatLifecycle(id);
    closeChatSessionUnconditional(id);
  }
  vi.restoreAllMocks();
  await sleep(30);
});

afterAll(async () => {
  for (const id of usedIds) closeChatSessionUnconditional(id);
  for (let i = 0; i < 3; i++) {
    await Promise.all([...usedIds].map((id) => withTaskLock(id, async () => undefined)));
    await sleep(40);
  }
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("① ② 定时 run 结束 → 宽限后回收；用户 run 结束 → 仍热", () => {
  it("回归 ①：定时触发的 run 自然结束 → 宽限后会话被关，agent.close 调一次，盘上 sessionAgentId 保留（keepPersisted）", async () => {
    setGrace(40);
    const id = newId();
    await initTask(id);
    const agent = await startHot(id, SCHEDULED_TEXT);

    await vi.waitFor(() => expect(hasChatSession(id), "改前：定时 run 结束后会话一直热着").toBe(false), {
      timeout: 3000,
      interval: 20,
    });
    expect(agent.close).toHaveBeenCalledTimes(1);
    const meta = await readMetaV06(id);
    expect(meta?.sessionAgentId, "keepPersisted：下条消息要靠它 resume 接回").toBe(agentIdOf(id));
    expect(getChatReclaimCounts()).toEqual({ idle: 0, scheduledEnd: 1, watermark: 0 });
  });

  it("对照 ②：用户 run 结束 → 过了宽限仍热；12 分钟 TTL 内清扫不回收，TTL 一过才回收（idle）", async () => {
    setGrace(40);
    const id = newId();
    await initTask(id);
    const agent = await startHot(id, USER_TEXT);

    await sleep(250); // 远大于宽限：若误把用户 run 当定时，这里早被回收了
    expect(hasChatSession(id), "用户 run 不走收尾回收").toBe(true);
    expect(agent.close).not.toHaveBeenCalled();

    expect(sweep(Date.now() + 5 * MIN), "5 分钟 < 12 分钟 TTL：不回收").toBe(0);
    expect(hasChatSession(id)).toBe(true);
  });

  it("对照 ②'：用户 run 空闲超过 TTL（13 分钟）→ 空闲清扫回收，计数记 idle", async () => {
    setGrace(40);
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);

    expect(sweep(Date.now() + 13 * MIN)).toBe(1);
    expect(hasChatSession(id)).toBe(false);
    expect(getChatReclaimCounts()).toEqual({ idle: 1, scheduledEnd: 0, watermark: 0 });
  });

  it("边界：恰好空闲 12 分钟整（== TTL）不回收，多 1 毫秒才回收（`<=` 的边界）", async () => {
    setGrace(40);
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);
    await sleep(60); // 用户 run 不走收尾回收；留点余量让 lastActiveAt 落定

    // 只冻结 Date（定时器仍是真的）：下面要用探针读「距最近活跃多久」再反推 lastActiveAt，
    // 两次 Date.now() 之间不能走字
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const hot = getChatHotSessions()?.find((s) => s.taskId === id);
      expect(hot, "热会话探针应能看到这个会话").toBeDefined();
      const lastActiveAt = Date.now() - (hot as { idleMs: number }).idleMs;
      expect(sweep(lastActiveAt + 12 * MIN), "恰好等于 TTL：还不算超过 → 不回收").toBe(0);
      expect(hasChatSession(id)).toBe(true);
      expect(sweep(lastActiveAt + 12 * MIN + 1), "超过 TTL 1 毫秒 → 回收").toBe(1);
      expect(hasChatSession(id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("回归：定时 run 之后用户在宽限内接了一句 → 到期不回收；用户这一轮结束后也不回收（回落 12 分钟 TTL）", async () => {
    setGrace(400);
    const id = newId();
    await initTask(id);
    const agent = await startHot(id, SCHEDULED_TEXT);
    // 宽限内（400ms）用户立刻回一句：新 run、scheduledRun 重算为 false
    await startHot(id, USER_TEXT);

    await sleep(900); // 越过第一个计时器的到期点，也越过「如果误当定时」的第二个
    expect(hasChatSession(id), "用户接话后不能被前一轮的宽限计时器误关").toBe(true);
    expect(agent.close).not.toHaveBeenCalled();
    expect(getChatReclaimCounts().scheduledEnd).toBe(0);
  });

  it("回归：宽限内又来了一条定时 run → 第一个计时器到期放弃；回收只发生一次（由第二轮自己的收尾做）", async () => {
    setGrace(250);
    const id = newId();
    await initTask(id);
    const agent = await startHot(id, SCHEDULED_TEXT);
    await startHot(id, SCHEDULED_TEXT.replace("1.1]", "1.2]"));

    await vi.waitFor(() => expect(hasChatSession(id)).toBe(false), { timeout: 3000, interval: 20 });
    await sleep(400); // 第一个计时器到期也不能再回收一次
    expect(getChatReclaimCounts().scheduledEnd).toBe(1);
    expect(agent.close).toHaveBeenCalledTimes(1);
  });

  it("回归：宽限期间实例被换掉（forceClear + 新实例）→ 旧计时器到期不能误关新实例（按 instanceId 门控）", async () => {
    setGrace(300);
    const id = newId();
    await initTask(id);
    await startHot(id, SCHEDULED_TEXT); // 挂上旧实例的宽限计时器
    closeChatSessionUnconditional(id);
    await sleep(20);
    const fresh = makeAgent(agentIdOf(id));
    await startHot(id, USER_TEXT, { agent: fresh }); // 新实例（用户 run）

    await sleep(700);
    expect(hasChatSession(id), "新实例不能被旧实例的计时器关掉").toBe(true);
    expect(fresh.close).not.toHaveBeenCalled();
  });
});

describe("① ②（冷启动）：首条消息走 runChatSession 冷启动，同样要认出定时文本", () => {
  // 本文件其余用例都走 resume + sendChatMessage；冷启动首包（runChatSession）是另一条「受理」路径，
  // 「受理后记序号并认定时文本」在那里要单独调一次——漏了，定时消息冷启动的会话就永远等 12 分钟 TTL
  it("回归 ①'：定时消息作首条消息冷启动 → run 自然结束后宽限到期回收，agent.close 调一次，计数记 scheduledEnd", async () => {
    setGrace(40);
    const id = newId();
    await initTask(id);
    const agent = makeAgent(agentIdOf(id));
    mockCreate.mockResolvedValueOnce(agent);

    const result = await runChatSession({
      task: asTask(makeMeta(id)),
      ...BOOT,
      firstMessage: { text: SCHEDULED_TEXT },
    });
    expect(result).toBe("started");
    expect(mockCreate, "冷启动走 Agent.create").toHaveBeenCalledTimes(1);

    await vi.waitFor(
      () => expect(hasChatSession(id), "冷启动的定时 run 结束后也要回收").toBe(false),
      { timeout: 3000 },
    );
    expect(agent.close).toHaveBeenCalledTimes(1);
    expect(getChatReclaimCounts().scheduledEnd).toBe(1);
  });

  it("对照 ②''：用户消息作首条消息冷启动 → 过了宽限仍热（用户 run 回落 12 分钟 TTL）", async () => {
    setGrace(40);
    const id = newId();
    await initTask(id);
    const agent = makeAgent(agentIdOf(id));
    mockCreate.mockResolvedValueOnce(agent);

    const result = await runChatSession({
      task: asTask(makeMeta(id)),
      ...BOOT,
      firstMessage: { text: USER_TEXT },
    });
    expect(result).toBe("started");

    await sleep(200); // 远大于 40ms 宽限
    expect(hasChatSession(id)).toBe(true);
    expect(agent.close).not.toHaveBeenCalled();
    expect(getChatReclaimCounts().scheduledEnd).toBe(0);
  });
});

describe("③' 守卫接线（runner 层）：快照里每个输入各自单独拦得住", () => {
  // 守卫函数本身的真值表在 chat-reclaim-guard.test.ts；这里钉的是「runner 把真实状态喂进守卫」的接线。
  // 某个输入漏接 / 接成常量时，真实流程里常有另一个同时命中的守卫掩护它，所以每个输入单独造一遍，
  // 再用「撤掉后同一个会话才被回收」做对照。

  it("回归：队里空、但 flush 刚 dequeue 的那条还没 send 成功（in-flight 槽）→ 清扫不回收", async () => {
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);

    beginChatQueueInFlight(id, "cq_inflight");
    try {
      expect(sweep(Date.now() + 13 * MIN), "队列里没有，但 flush 手里还攥着一条").toBe(0);
      expect(hasChatSession(id)).toBe(true);
    } finally {
      endChatQueueInFlight(id);
    }
    expect(sweep(Date.now() + 13 * MIN), "对照：in-flight 清掉后同一个会话才被回收").toBe(1);
    expect(hasChatSession(id)).toBe(false);
  });

  it("回归：检查点回退（rewind）进行中 → 清扫不回收", async () => {
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);

    expect(tryBeginChatRewind(id), "占到 rewind 门闩").toBe(true);
    try {
      expect(sweep(Date.now() + 13 * MIN), "rewind 在改这个会话的历史 → 守卫拦住").toBe(0);
      expect(hasChatSession(id)).toBe(true);
    } finally {
      endChatRewind(id);
    }
    expect(sweep(Date.now() + 13 * MIN), "对照：rewind 结束后同一个会话才被回收").toBe(1);
    expect(hasChatSession(id)).toBe(false);
  });

  it("回归（白盒）：flush 正在 drain（只有 draining 标记，队列 / in-flight 都空）→ 清扫不回收", async () => {
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);

    runnerState().drainingQueues.add(id);
    try {
      expect(sweep(Date.now() + 13 * MIN), "draining 标记在 → 守卫拦住").toBe(0);
      expect(hasChatSession(id)).toBe(true);
    } finally {
      runnerState().drainingQueues.delete(id);
    }
    expect(sweep(Date.now() + 13 * MIN), "对照：标记清掉后同一个会话才被回收").toBe(1);
    expect(hasChatSession(id)).toBe(false);
  });

  it("回归（白盒）：攒着还没送进主 AI 的后台结果 → 清扫不回收", async () => {
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);

    runnerState().pendingBackgroundResults.set(id, ["[后台子代理结果] 还没送进主 AI"]);
    try {
      expect(sweep(Date.now() + 13 * MIN), "攒着的结果会随会话一起作废 → 守卫拦住").toBe(0);
      expect(hasChatSession(id)).toBe(true);
    } finally {
      runnerState().pendingBackgroundResults.delete(id);
    }
    expect(sweep(Date.now() + 13 * MIN), "对照：清掉后同一个会话才被回收").toBe(1);
    expect(hasChatSession(id)).toBe(false);
  });

  it("回归（白盒）：会话占位还没挂上 agent（冷启动首包未受理）→ 清扫不回收", async () => {
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);

    const rec = runnerState().runningChats.get(id);
    expect(rec, "热会话记录在").toBeDefined();
    const agent = rec!.agent;
    rec!.agent = null;
    try {
      expect(sweep(Date.now() + 13 * MIN), "没有 agent 可关 → 守卫拦住（占位会话归启动流程管）").toBe(0);
      expect(hasChatSession(id)).toBe(true);
    } finally {
      rec!.agent = agent;
    }
    expect(sweep(Date.now() + 13 * MIN), "对照：agent 挂回后同一个会话才被回收").toBe(1);
    expect(hasChatSession(id)).toBe(false);
  });
});

describe("③ 守卫：该不关的时候不关", () => {
  it("回归：定时 run 结束时队列里有等着送的消息 → 到期不回收，日志写明原因；队列清空后空闲清扫才回收", async () => {
    setGrace(150);
    const id = newId();
    await initTask(id);
    await startHot(id, SCHEDULED_TEXT);
    // run 已结束、宽限计时器在走：用户这时排了一条（没有 drain 动作，队列保持非空）
    const q = enqueueChatMessage(id, {
      itemId: "cq_x3_1",
      agentText: "稍后处理",
      displayText: "稍后处理",
      enqueuedAt: Date.now(),
    });
    expect(q.ok).toBe(true);

    await sleep(450);
    expect(hasChatSession(id), "队列非空：关会话会丢掉这条消息的去向").toBe(true);
    expect(logged()).toContain(`定时 run 收尾后暂不回收 task=${id}（queued）`);
    expect(sweep(Date.now() + 13 * MIN), "清扫路径同口径：队列非空也不回收").toBe(0);
    expect(hasChatSession(id)).toBe(true);

    clearChatQueue(id);
    expect(sweep(Date.now() + 13 * MIN), "队列清空后才放行").toBe(1);
    expect(hasChatSession(id)).toBe(false);
  });

  it("回归：有挂起的 ask_user → 清扫与定时收尾都不回收（答案要回到同一会话）", async () => {
    setGrace(120);
    const id = newId();
    await initTask(id);
    await startHot(id, SCHEDULED_TEXT);
    registerPendingAsk(id, {
      askId: "ask_x3",
      questions: [{ id: "q1", question: "选哪个？", allowText: true }],
    });

    await sleep(400);
    expect(hasChatSession(id)).toBe(true);
    expect(logged()).toContain(`task=${id}（pending-ask）`);
    expect(sweep(Date.now() + 13 * MIN)).toBe(0);
    expect(hasChatSession(id)).toBe(true);

    clearPendingAsk(id);
    expect(sweep(Date.now() + 13 * MIN)).toBe(1);
  });

  it("回归：「立即发送」steer 在飞 → 清扫不回收；注销后放行", async () => {
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);
    const done = registerInflightSteer(id, { itemId: "cq_steer", displayText: "插个话" });

    expect(sweep(Date.now() + 13 * MIN), "改前清扫只看 runActive / 后台子代理，会把它关掉").toBe(0);
    expect(hasChatSession(id)).toBe(true);

    done();
    expect(sweep(Date.now() + 13 * MIN)).toBe(1);
  });

  it("回归：stopping / finalizing 等收尾窗口 → 清扫不回收（别的流程在管这个会话）", async () => {
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);
    expect(beginChatLifecycle(id, "stopping")).toBe(true);

    expect(sweep(Date.now() + 13 * MIN)).toBe(0);
    expect(hasChatSession(id)).toBe(true);

    endChatLifecycle(id);
    expect(sweep(Date.now() + 13 * MIN)).toBe(1);
  });

  it("对照：run 在跑 → 清扫不回收（哪怕 lastActiveAt 早就过了 TTL）", async () => {
    const id = newId();
    await initTask(id);
    const { release } = await startRunning(id, USER_TEXT);

    expect(sweep(Date.now() + 13 * MIN)).toBe(0);
    expect(hasChatSession(id)).toBe(true);
    release("好的");
    await waitRunDone(id);
  });

  it("回归：定时 run 收尾时还有后台子代理在跑 → 到期不回收，清扫也不回收（关会话会连它们一起取消）", async () => {
    setGrace(120);
    const id = newId();
    await initTask(id);
    const childReleasers: Array<() => void> = [];
    mockCreate.mockImplementation(async () => {
      const m = manualRun();
      childReleasers.push(() => m.release("子代理结果"));
      return {
        agentId: `child-${childReleasers.length}`,
        send: vi.fn().mockResolvedValue(m.run),
        close: vi.fn(),
      };
    });
    const parent = manualRun();
    const parentAgent = makeAgent(agentIdOf(id), () => parent.run);
    mockResume.mockResolvedValueOnce(parentAgent);
    const task = asTask(makeMeta(id));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    const subagentTool = (
      mockResume.mock.calls.at(-1)?.[1] as {
        local: {
          customTools: Record<
            string,
            { execute: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }
          >;
        };
      }
    ).local.customTools.subagent;
    expect(subagentTool).toBeTruthy();
    expect(await sendChatMessage(task, SCHEDULED_TEXT)).toBe("sent");
    await subagentTool!.execute(
      { prompt: "跑个长任务", description: "长任务", run_in_background: true },
      {},
    );
    expect(childReleasers).toHaveLength(1);

    parent.release("好的，我派了个后台子代理");
    await waitRunDone(id);
    await sleep(450);

    expect(hasChatSession(id), "后台子代理还在跑").toBe(true);
    expect(logged()).toContain(`task=${id}（background-subagent）`);
    expect(getChatReclaimCounts().scheduledEnd).toBe(0);
    expect(sweep(Date.now() + 13 * MIN)).toBe(0);
    expect(hasChatSession(id)).toBe(true);
  });
});

describe("④ 关后下一条定时消息能 resume 并继续", () => {
  it("回归：回收后再来一条定时消息 → 重新 resume（改前会话一直热、根本不 resume）→ 新 agent 收到消息 → 再被回收", async () => {
    setGrace(40);
    const id = newId();
    await initTask(id);
    await startHot(id, SCHEDULED_TEXT);
    await vi.waitFor(() => expect(hasChatSession(id)).toBe(false), { timeout: 3000, interval: 20 });
    expect(mockResume).toHaveBeenCalledTimes(1);

    // 下一次接力：会话已冷，经 resume 接回
    const second = makeAgent(agentIdOf(id));
    await startHot(id, SCHEDULED_TEXT.replace("1.1]", "1.2]"), { agent: second });
    expect(mockResume, "第二条定时消息必须重新 resume").toHaveBeenCalledTimes(2);
    expect(second.send).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(hasChatSession(id)).toBe(false), { timeout: 3000, interval: 20 });
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(getChatReclaimCounts().scheduledEnd).toBe(2);
  });
});

describe("⑤（runner 层）水位回收：只挑空闲会话、不挑目标，占用从大到小", () => {
  it("回归：目标 B；A、C 空闲 → 回收 A、C，不回收 B；计数记 watermark", async () => {
    const [A, B, C] = [newId(), newId(), newId()];
    for (const id of [A, B, C]) await initTask(id);
    const agents = {
      A: await startHot(A, USER_TEXT),
      B: await startHot(B, USER_TEXT),
      C: await startHot(C, USER_TEXT),
    };

    const n = await reclaimForWatermark({ exceptTaskId: B, heapRatio: () => 0.8 });
    expect(n, "改前没有水位回收").toBe(2);
    expect(hasChatSession(A)).toBe(false);
    expect(hasChatSession(C)).toBe(false);
    expect(hasChatSession(B), "目标会话永远不能被回收").toBe(true);
    expect(agents.A.close).toHaveBeenCalledTimes(1);
    expect(agents.C.close).toHaveBeenCalledTimes(1);
    expect(agents.B.close).not.toHaveBeenCalled();
    expect(getChatReclaimCounts()).toEqual({ idle: 0, scheduledEnd: 0, watermark: 2 });
    // keepPersisted：盘上锚点都在
    for (const id of [A, C]) expect((await readMetaV06(id))?.sessionAgentId).toBe(agentIdOf(id));
  });

  it("回归：占用从大到小回收；每回收一个就复读堆占用，降到软水位以下就停（只回收最大的那个）", async () => {
    const [A, B, C] = [newId(), newId(), newId()];
    for (const id of [A, B, C]) await initTask(id);
    for (const id of [A, B, C]) await startHot(id, USER_TEXT);
    const usage: Record<string, number> = { [agentIdOf(A)]: 100, [agentIdOf(C)]: 900 };
    const heapRatio = vi.fn().mockReturnValueOnce(0.8).mockReturnValueOnce(0.65).mockReturnValue(0.65);

    const n = await reclaimForWatermark({
      exceptTaskId: B,
      heapRatio,
      estimate: async (agentId) => usage[agentId],
    });
    expect(n).toBe(1);
    expect(hasChatSession(C), "占用最大的 C 先回收").toBe(false);
    expect(hasChatSession(A), "复读已降到 0.7 以下，A 不动").toBe(true);
    expect(hasChatSession(B)).toBe(true);
  });

  it("回归：run 在跑的会话不回收，其余空闲的照常回收", async () => {
    const [A, B, C] = [newId(), newId(), newId()];
    for (const id of [A, B, C]) await initTask(id);
    const running = await startRunning(A, USER_TEXT);
    await startHot(B, USER_TEXT);
    await startHot(C, USER_TEXT);

    const n = await reclaimForWatermark({ exceptTaskId: B, heapRatio: () => 0.9 });
    expect(n).toBe(1);
    expect(hasChatSession(A), "run 在跑").toBe(true);
    expect(isChatRunActive(A)).toBe(true);
    expect(hasChatSession(C)).toBe(false);
    running.release("好的");
    await waitRunDone(A);
  });

  it("回归：估算有 await，期间某候选刚好被用户排了一条消息 → 回收前同步复核，跳过它", async () => {
    const [A, B, C] = [newId(), newId(), newId()];
    for (const id of [A, B, C]) await initTask(id);
    for (const id of [A, B, C]) await startHot(id, USER_TEXT);

    const n = await reclaimForWatermark({
      exceptTaskId: B,
      heapRatio: () => 0.8,
      estimate: async (agentId) => {
        if (agentId === agentIdOf(C)) {
          // 估算 C 的占用时（最大、排第一），用户恰好给 C 排了一条
          enqueueChatMessage(C, {
            itemId: "cq_race",
            agentText: "刚排的",
            displayText: "刚排的",
            enqueuedAt: Date.now(),
          });
          return 900;
        }
        return 100;
      },
    });
    expect(n, "只回收了 A").toBe(1);
    expect(hasChatSession(C), "C 刚排了消息，不能关").toBe(true);
    expect(hasChatSession(A)).toBe(false);
  });

  it("对照：目标会话是唯一的热会话 → 一个都不回收（不能为了给它腾堆把它自己关了）", async () => {
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);
    const n = await reclaimForWatermark({ exceptTaskId: id, heapRatio: () => 0.95 });
    expect(n).toBe(0);
    expect(hasChatSession(id)).toBe(true);
  });

  it("对照：堆占用已在软水位以下 → 不回收", async () => {
    const [A, B] = [newId(), newId()];
    for (const id of [A, B]) await initTask(id);
    await startHot(A, USER_TEXT);
    await startHot(B, USER_TEXT);
    const n = await reclaimForWatermark({ exceptTaskId: B, heapRatio: () => 0.5 });
    expect(n).toBe(0);
    expect(hasChatSession(A)).toBe(true);
  });
});

describe("⑤'（runner 层）水位回收：软水位边界与占用估算容错", () => {
  it("边界：堆占用恰好等于软水位 → 仍回收（只有「低于」软水位才停）", async () => {
    const [A, B] = [newId(), newId()];
    for (const id of [A, B]) await initTask(id);
    await startHot(A, USER_TEXT);
    await startHot(B, USER_TEXT);

    const n = await reclaimForWatermark({
      exceptTaskId: B,
      heapRatio: () => CHAT_WATERMARK_SOFT_RATIO,
    });

    expect(n, "恰好等于软水位不算「已降下来」").toBe(1);
    expect(hasChatSession(A)).toBe(false);
    expect(hasChatSession(B)).toBe(true);
  });

  it("回归：占用估算抛错（取不到）→ 不拖垮整次回收，估算只用来排顺序，照常回收", async () => {
    const [A, B, C] = [newId(), newId(), newId()];
    for (const id of [A, B, C]) await initTask(id);
    for (const id of [A, B, C]) await startHot(id, USER_TEXT);

    const n = await reclaimForWatermark({
      exceptTaskId: B,
      heapRatio: () => 0.8,
      estimate: async () => {
        throw new Error("store 打不开");
      },
    });

    expect(n, "估算全抛错也要回收 A、C").toBe(2);
    expect(hasChatSession(A)).toBe(false);
    expect(hasChatSession(C)).toBe(false);
    expect(hasChatSession(B), "目标会话不动").toBe(true);
  });
});

describe("⑦ soak：2 个任务各接力 N 轮，稳态热会话数不增长", () => {
  const ROUNDS = 12;
  const hotOf = (ids: string[]): number => ids.filter((id) => hasChatSession(id)).length;

  /** 跑 ROUNDS 轮：每轮两个任务各来一条消息、等 run 结束、等宽限回收，再模拟「到下次接力前」清扫器跑一遍 */
  const relay = async (opts: { text: (round: number, id: string) => string; intervalMin: number }) => {
    const A = newId();
    const B = newId();
    await initTask(A);
    await initTask(B);
    const hotAfterRound: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      for (const id of [A, B]) await startHot(id, opts.text(round, id));
      await sleep(160); // 宽限（30ms）+ 收尾写盘裕量
      if (hotOf([A, B]) > 1) await sleep(400); // 机器忙时再给一次机会；真没回收的（改前）这里只是多等一会
      sweep(Date.now() + opts.intervalMin * MIN); // 模拟：下一条接力到来前，TTL 清扫器按间隔跑了一遍
      hotAfterRound.push(hotOf([A, B]));
    }
    return { hotAfterRound, ids: [A, B] };
  };

  it(
    "回归：定时 run 10 分钟接力 × 12 轮 → 每轮结束后热会话 ≤ 1，且不随轮数增长（改前恒为 2：10 分钟 < 12 分钟 TTL，永远热）",
    async () => {
      setGrace(30);
      const { hotAfterRound } = await relay({
        text: (round, id) => `[SCHEDULE_FIRED id=sch_${id}.${round}.1] 到点了`,
        intervalMin: 10,
      });
      expect(Math.max(...hotAfterRound), `各轮热会话数 ${JSON.stringify(hotAfterRound)}`).toBeLessThanOrEqual(1);
      expect(hotAfterRound.at(-1)!).toBeLessThanOrEqual(hotAfterRound[0]!);
      const counts = getChatReclaimCounts();
      expect(counts.scheduledEnd, "每轮每个任务回收一次").toBe(ROUNDS * 2);
      expect(counts.idle, "靠的是定时收尾回收，不是 TTL").toBe(0);
    },
    90_000,
  );

  it(
    "对照：用户 run 10 分钟接力 × 12 轮 → 会话永远热（这就是崩溃的成因；用户路径刻意不变，到 TTL 才回收）",
    async () => {
      setGrace(30);
      const { hotAfterRound } = await relay({
        text: (round) => `${USER_TEXT} ${round}`,
        intervalMin: 10,
      });
      expect(hotAfterRound, "用户 run 在 TTL 内一直热").toEqual(Array(ROUNDS).fill(2));
      expect(getChatReclaimCounts()).toEqual({ idle: 0, scheduledEnd: 0, watermark: 0 });
    },
    90_000,
  );

  it(
    "对照：用户 run 30 分钟接力 → 每次接力前 TTL 清扫器把两个会话都回收了（这就是「接力改 30 分钟后堆稳在 0.4~0.5 GB」的机制）",
    async () => {
      setGrace(30);
      const { hotAfterRound } = await relay({
        text: (round) => `${USER_TEXT} ${round}`,
        intervalMin: 30,
      });
      expect(hotAfterRound).toEqual(Array(ROUNDS).fill(0));
      expect(getChatReclaimCounts().idle).toBe(ROUNDS * 2);
    },
    90_000,
  );
});

describe("遥测：热会话探针与 runningChats 一致", () => {
  it("回归：一个空闲、一个 run 在跑 → 探针返回两条，runActive / agentId / idleMs 与真实状态一致（改前探针没登记）", async () => {
    const [A, C] = [newId(), newId()];
    for (const id of [A, C]) await initTask(id);
    await startHot(A, USER_TEXT);
    const running = await startRunning(C, USER_TEXT);

    const hot = getChatHotSessions();
    expect(hot, "chat-runner 加载时必须登记探针").toBeDefined();
    const byTask = Object.fromEntries((hot ?? []).map((h) => [h.taskId, h]));
    expect(Object.keys(byTask).sort()).toEqual([A, C].sort());
    expect(byTask[A]).toMatchObject({ agentId: agentIdOf(A), runActive: false, backgroundRunning: 0 });
    expect(byTask[C]).toMatchObject({ agentId: agentIdOf(C), runActive: true, backgroundRunning: 0 });
    for (const h of hot ?? []) expect(h.idleMs).toBeGreaterThanOrEqual(0);

    running.release("好的");
    await waitRunDone(C);
  });

  it("回归：会话被回收后探针里没有它（热会话数下降是回收生效的直接证据）", async () => {
    const id = newId();
    await initTask(id);
    await startHot(id, USER_TEXT);
    expect((getChatHotSessions() ?? []).map((h) => h.taskId)).toContain(id);
    expect(sweep(Date.now() + 13 * MIN)).toBe(1);
    expect((getChatHotSessions() ?? []).map((h) => h.taskId)).not.toContain(id);
  });
});

describe("接线契约：清扫器 interval 走统一守卫", () => {
  it("清扫器调用 sweepIdleChatSessions、拍点用 CHAT_SWEEP_INTERVAL_MS、回调有 try/catch（不能把 server 带崩）；旧的 V1 interval 会被清掉", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/lib/server/chat-runner.ts"),
      "utf-8",
    );
    const start = src.indexOf("g[CHAT_SWEEPER_KEY] = setInterval");
    expect(start, "找不到清扫器 interval").toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf("CHAT_SWEEP_INTERVAL_MS", start) + "CHAT_SWEEP_INTERVAL_MS".length);
    expect(block).toContain("sweepIdleChatSessions()");
    expect(block).toContain("try {");
    expect(block).toContain("catch (err)");
    expect(src).toContain('const LEGACY_CHAT_SWEEPER_KEY = "__flowshipChatSweeperV1__"');
    expect(src).toContain("clearInterval(legacy)");
    // TTL 数值不变（只改了拍点与守卫）
    expect(src).toContain("const CHAT_IDLE_TTL_MS = 12 * 60 * 1000;");
  });
});
