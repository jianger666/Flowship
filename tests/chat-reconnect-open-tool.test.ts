/**
 * chat 自动重连「成功」之后，立刻闭合断线那一刻还没配对的工具（R14 Q8-02）
 *
 * 场景：run 的流里已经发出了 tool_call(running)、还没收到完成帧，流就抛网络错（fetch failed）
 * → 自动重连：退避（首次 2s）→ resumeChatSession → 新实例 agent.send(reconnect prompt)
 * → 写「重连成功」info → 新 run 开始被消费。
 *
 * 新会话是从 reconnect prompt 重新开始的，旧 run 里没完成的工具再也不会有完成帧。
 * - 改前：什么都不做，旧工具一直没有 tool_result，直到「整轮结束」新 run 收尾的 finalizeOpenToolCalls
 *   才补一条「已中断」——重连成功之后、新 run 还在跑的这段时间（长任务可能几分钟到几小时），
 *   界面上那个工具一直转圈、被算成「运行中」，补写的那条「已中断」还落在流的最末尾、位置错乱；
 * - 改后：runReconnectAttempt 在写「重连成功」info **之前**调 finalizeOpenToolCalls（lease = 新实例仍是当前）：
 *   此刻就补 tool_result(status=interrupted)，并把后台 shell 的 running 标记收成 ended(run-ended)；
 *   该调用自己 try/catch，抛错只 warn、不影响续跑。
 *
 * 观测手段：新 run 用「门闸」挂住（stream / wait 都等同一个 gate），于是「重连成功、新 run 仍在跑」
 * 这个窗口可以稳定观察；窗口内读事件流，看旧工具是否已经被闭合。收尾后再放开门闸，看整轮结束时的终态。
 *
 * 分类说明（BF = 修复前原样源码）：
 *   【回归】= 修复前必红（钉住 bug）；【对照】= 修复前后都绿（钉住「不该变的行为」）。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 * 重连退避用真计时器（首次退避 2s），不用 fake timers——避免和落盘 / SDK deadline 的 setTimeout 互相干扰；
 * 所有「等异步结果」都是轮询到条件成立（上限给足），不用固定短 sleep。
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

import {
  buildShellBackgroundEvent,
  collectRunningBackgroundShells,
  shellBackgroundOf,
} from "@/lib/shell-background";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-reconnect-open-tool-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

/**
 * finalizeOpenToolCalls 的探针 + 故障注入（只对「重连成功那一次」生效）。
 *
 * 为什么不按「第 N 次调用」计数来决定抛不抛：修复前 runReconnectAttempt 根本不调它，
 * 整轮只有「新 run 收尾」那一次调用——按计数的话，修复前抛错会打在收尾那次上，
 * 红因变成「收尾崩了」而不是「重连路径没闭合」，红得不对症。
 * 这里改按**时机**：新 run 的流还没开始被消费（newRunStarted=false）= 重连成功路径上的调用
 * （它发生在 consumeChatRun(新 run) 之前）；新 run 开始消费之后的调用 = 整轮收尾，永远走原实现。
 * 修复前没有「重连路径上的调用」→ 注入次数恒为 0 → 断言 injected===1 红在断言上，不是挂死 / 崩溃。
 */
const finalizeProbe = vi.hoisted(() => ({
  /** true = 新 run 开始被消费之前的 finalizeOpenToolCalls 调用要抛错（即重连成功路径那一次） */
  throwBeforeNewRun: false,
  /** 新 run 的流是否已开始被消费（run2.stream 被迭代时置 true） */
  newRunStarted: false,
  /** 被调用总次数（原实现 + 注入抛错都算） */
  calls: 0,
  /** 注入过的抛错次数 */
  injected: 0,
  /** 「重连成功路径上那一次」调用（新 run 开始被消费之前）收到的 lease；用例里直接调它看真值 */
  reconnectLeases: [] as Array<() => boolean>,
}));
vi.mock("@/lib/server/finalize-open-tools", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/server/finalize-open-tools")>();
  return {
    ...original,
    finalizeOpenToolCalls: async (taskId: string, lease: () => boolean) => {
      finalizeProbe.calls += 1;
      if (!finalizeProbe.newRunStarted) finalizeProbe.reconnectLeases.push(lease);
      if (finalizeProbe.throwBeforeNewRun && !finalizeProbe.newRunStarted) {
        finalizeProbe.injected += 1;
        throw new Error("injected finalize failure");
      }
      return original.finalizeOpenToolCalls(taskId, lease);
    },
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { appendEvent, getTask } = await import("@/lib/server/task-fs");
const { __resetToolCallRunningSeenForTest } = await import(
  "@/lib/server/sdk-message-handler"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-reconnect-open-tool DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000003001_reconnect_open_tool";
const AGENT_ID = "agent_fake_reconnect_open_tool";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `reconnect open tool ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

// ----------------- 事件断言小工具 -----------------

type EventPred = (e: TaskEvent) => boolean;

const isInfoKind =
  (kind: string): EventPred =>
  (e) =>
    e.kind === "info" && e.meta?.kind === kind;
const isReconnecting = isInfoKind("reconnecting");
const isReconnected = isInfoKind("reconnected");
/** 补写的「已中断」tool_result；不传 callId = 任意工具 */
const isInterrupted =
  (callId?: string): EventPred =>
  (e) =>
    e.kind === "tool_result" &&
    e.meta?.status === "interrupted" &&
    (callId === undefined || e.meta?.callId === callId);
const isToolCallOf =
  (callId: string): EventPred =>
  (e) =>
    e.kind === "tool_call" && e.meta?.callId === callId;
/** 某工具的非 interrupted 结果（正常完成帧落的 tool_result） */
const isRealResultOf =
  (callId: string): EventPred =>
  (e) =>
    e.kind === "tool_result" &&
    e.meta?.callId === callId &&
    e.meta?.status !== "interrupted";

const countOf = (events: TaskEvent[], pred: EventPred): number =>
  events.filter(pred).length;
const interruptedCallIds = (events: TaskEvent[]): string[] =>
  events
    .filter(isInterrupted())
    .map((e) => String(e.meta?.callId))
    .sort();

/** 等某条事件出现在事件流里（轮询到条件成立）；重连有真实退避（首次 2s）→ 上限给足 */
const waitForEvent = async (
  pred: EventPred,
  timeoutMs = 30_000,
): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect((await readEvents(TASK_ID)).some(pred)).toBe(true);
    },
    { timeout: timeoutMs, interval: 100 },
  );
};

const waitForRunStatus = async (
  status: string,
  timeoutMs = 20_000,
): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect((await readMetaV06(TASK_ID))?.runStatus).toBe(status);
    },
    { timeout: timeoutMs, interval: 100 },
  );
};

// ----------------- 假 SDK 场景 -----------------

/** SDK 流里的 tool_call 帧（shell；status=running 是发出调用，completed 是完成帧） */
const toolFrame = (
  callId: string,
  status: "running" | "completed",
): Record<string, unknown> => ({
  type: "tool_call",
  agent_id: AGENT_ID,
  run_id: "r1",
  call_id: callId,
  name: "shell",
  status,
  args: { command: "echo hi" },
  ...(status === "completed"
    ? {
        result: {
          status: "success",
          value: { stdout: "hi\n", stderr: "", exitCode: 0 },
        },
      }
    : {}),
});

type FakeAgent = {
  agentId: string;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

type Scenario = {
  /** 首个实例（run1 的流在它上面断线） */
  agent1: FakeAgent;
  /** 重连后 resume 出来的新实例 */
  agent2: FakeAgent;
  /** 放开新 run 的门闸：新 run 正常 finished */
  releaseRun2: () => void;
};

/** afterEach 统一放开本用例造出的所有门闸：BF 里红在半路的用例也不留挂死的 promise */
const pendingReleases: Array<() => void> = [];

/**
 * 起一个「流里先吐 frames、（可选）再做点事、然后抛网络错」的会话，并让重连后的新 run 挂在门闸上。
 * 返回时 run1 已经开始消费（sendChatMessage 返 sent）；后续由用例自己等 reconnected。
 */
const startScenario = async (
  frames: Array<Record<string, unknown>>,
  beforeThrow?: () => Promise<void>,
): Promise<Scenario> => {
  const run1 = {
    stream: async function* () {
      for (const frame of frames) yield frame;
      if (beforeThrow) await beforeThrow();
      throw new Error("fetch failed");
    },
    wait: () => new Promise<never>(() => {}),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  let releaseRun2!: () => void;
  const gate2 = new Promise<void>((r) => {
    releaseRun2 = r;
  });
  pendingReleases.push(releaseRun2);
  const run2 = {
    stream: async function* (): AsyncGenerator<never> {
      // 新 run 的流开始被消费：此后的 finalizeOpenToolCalls 调用都属于「整轮收尾」（见 finalizeProbe 的说明）
      finalizeProbe.newRunStarted = true;
      await gate2;
    },
    wait: async () => {
      await gate2;
      return { status: "finished" as const };
    },
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const agent1: FakeAgent = {
    agentId: AGENT_ID,
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(run1),
  };
  const agent2: FakeAgent = {
    agentId: AGENT_ID,
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(run2),
  };
  mockResume.mockResolvedValueOnce(agent1).mockResolvedValueOnce(agent2);

  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, "跑个长命令")).toBe("sent");
  return { agent1, agent2, releaseRun2 };
};

/** 放开新 run 并等整轮收尾（runStatus 回到 awaiting_user） */
const settleRun2 = async (s: Scenario): Promise<void> => {
  s.releaseRun2();
  await waitForRunStatus("awaiting_user");
};

beforeEach(async () => {
  mockResume.mockReset();
  // sdk-message-handler 对「同 callId 的二次 running 帧」做进程级去重（防止 SDK 流式补 args 时出双工具块）：
  // 各用例都用同一个 callId（c_old），不清的话后面的用例的 tool_call 会被当成重复帧丢掉、事件流里根本没有这条调用
  __resetToolCallRunningSeenForTest();
  finalizeProbe.throwBeforeNewRun = false;
  finalizeProbe.newRunStarted = false;
  finalizeProbe.calls = 0;
  finalizeProbe.injected = 0;
  finalizeProbe.reconnectLeases = [];
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 是惰性的（首次 getTask 才跑），会把「当时是 running」的任务标成 error。
  // 在任务还是 idle 时先触发一次，之后用例里的 running 才不会被它提前改成中间状态
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
  // 先摘会话（让还挂着的新 run 的收尾 CAS 落空、no-op），再放开门闸，不留悬挂的 promise
  closeChatSessionUnconditional(TASK_ID);
  for (const release of pendingReleases.splice(0)) release();
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("重连成功后闭合断线时未配对的工具（Q8-02）", () => {
  it(
    "【回归】重连成功当下（新 run 还挂着没结束）：旧工具 c_old 已补 interrupted 的 tool_result",
    async () => {
      // 保护：重连成功后新 run 仍在跑期间，旧工具就不该继续「转圈 / 计入运行中」。
      // 改前：此窗口内事件流里没有 c_old 的 tool_result，要等整轮结束（新 run 收尾）才补 → 本用例红在断言上
      const s = await startScenario([toolFrame("c_old", "running")]);
      await waitForEvent(isReconnected);

      // 前提：窗口真实存在——新 run 的 send 已受理、此刻还挂在门闸上没结束
      expect(s.agent2.send).toHaveBeenCalledTimes(1);
      expect(isChatRunActive(TASK_ID)).toBe(true);
      expect((await readMetaV06(TASK_ID))?.runStatus).toBe("running");

      // 窗口内（门闸还没放）旧工具已被闭合；轮询到条件成立，改前会一直等到上限后断言失败
      await vi.waitFor(
        async () => {
          expect(countOf(await readEvents(TASK_ID), isInterrupted("c_old"))).toBe(1);
        },
        { timeout: 5_000, interval: 100 },
      );
      const interrupted = (await readEvents(TASK_ID)).find(isInterrupted("c_old"));
      expect(interrupted?.meta).toMatchObject({
        callId: "c_old",
        name: "shell",
        status: "interrupted",
      });
      // 此刻新 run 仍没结束（是「重连成功当下」闭合的，不是被整轮收尾顺带补的）
      expect((await readMetaV06(TASK_ID))?.runStatus).toBe("running");

      await settleRun2(s);
    },
    90_000,
  );

  it(
    "【回归】事件顺序：tool_call(c_old) → 重连中 → interrupted → 重连成功（闭合发生在「重连成功」info 之前）",
    async () => {
      // 保护：补写的 interrupted 落在「重连成功」之前、紧跟在它所属的 tool_call 附近，
      // 而不是等整轮结束后落在流的最末尾（位置错乱）。
      // 改前：窗口内没有 interrupted（findIndex=-1），放开后它也排在 reconnected 之后 → 本用例红在断言上
      const s = await startScenario([toolFrame("c_old", "running")]);
      await waitForEvent(isReconnected);
      // 不放门闸，直接在窗口内按事件流落盘顺序断言（改前这里还没有 interrupted）
      const events = await readEvents(TASK_ID);
      const iCall = events.findIndex(isToolCallOf("c_old"));
      const iReconnecting = events.findIndex(isReconnecting);
      const iInterrupted = events.findIndex(isInterrupted("c_old"));
      const iReconnected = events.findIndex(isReconnected);

      expect(iCall).toBeGreaterThanOrEqual(0);
      expect(iReconnecting).toBeGreaterThanOrEqual(0);
      expect(iInterrupted).toBeGreaterThanOrEqual(0);
      expect(iReconnected).toBeGreaterThanOrEqual(0);
      expect(iCall).toBeLessThan(iReconnecting);
      expect(iReconnecting).toBeLessThan(iInterrupted);
      expect(iInterrupted).toBeLessThan(iReconnected);
      // 若事件带 seq（per-task 单调序号），次序与落盘下标一致
      const seqOf = (i: number): number => events[i]?.seq ?? i;
      expect(seqOf(iInterrupted)).toBeLessThan(seqOf(iReconnected));

      await settleRun2(s);
    },
    90_000,
  );

  it(
    "【对照】只闭合一次：新 run 收尾后 c_old 的 interrupted 恰 1 条（收尾那次 finalize 不重复补写）",
    async () => {
      // 保护：闭合靠 callId 配对——重连成功路径补过之后，新 run 收尾时的 finalizeOpenToolCalls
      // 看到 c_old 已配对，不能再补第二条（否则界面出两个「已中断」块）。
      // 改前：只有收尾那一次补，也是 1 条 → 修复前后都绿（对照，防止修复引入重复补写）
      const s = await startScenario([toolFrame("c_old", "running")]);
      await waitForEvent(isReconnected);
      await settleRun2(s);

      const events = await readEvents(TASK_ID);
      expect(countOf(events, isToolCallOf("c_old"))).toBe(1);
      expect(countOf(events, isInterrupted("c_old"))).toBe(1);
      expect(interruptedCallIds(events)).toEqual(["c_old"]);
      // 整轮正常收尾：会话保留、没有再次重连
      expect(hasChatSession(TASK_ID)).toBe(true);
      expect(countOf(events, isReconnecting)).toBe(1);
      expect(countOf(events, isReconnected)).toBe(1);
    },
    90_000,
  );
});

describe("不误补：已配对的工具不被闭合", () => {
  it(
    "【对照】断线时所有工具都已配对（tool_call + tool_result）→ 重连成功全程不写任何 interrupted",
    async () => {
      // 保护：重连成功路径的闭合只补「未配对」的，已经有完成帧的工具原样不动。
      // 修复前后都绿（对照）：防止闭合逻辑误伤已完成的工具
      const s = await startScenario([
        toolFrame("c_ok", "running"),
        toolFrame("c_ok", "completed"),
      ]);
      await waitForEvent(isReconnected);

      // 前提：断线前 c_ok 确实已配对（1 条 tool_call + 1 条非 interrupted 的 tool_result）
      let events = await readEvents(TASK_ID);
      expect(countOf(events, isToolCallOf("c_ok"))).toBe(1);
      expect(countOf(events, isRealResultOf("c_ok"))).toBe(1);
      // 重连成功窗口内：没有任何 interrupted
      expect(countOf(events, isInterrupted())).toBe(0);

      await settleRun2(s);
      // 整轮收尾后依然没有（收尾那次 finalize 同样不误补）
      events = await readEvents(TASK_ID);
      expect(countOf(events, isInterrupted())).toBe(0);
      expect(countOf(events, isRealResultOf("c_ok"))).toBe(1);
    },
    90_000,
  );

  it(
    "【回归】混合：1 个已配对 + 2 个未配对 → 重连成功当下恰好补那 2 个未配对的，已配对的不被误补",
    async () => {
      // 保护：多个未配对工具逐个补齐（一个都不漏），且已配对的 c_done 不被误补。
      // 改前：重连成功当下一个都还没补（窗口内 interrupted 集合为空）→ 本用例红在断言上
      const s = await startScenario([
        toolFrame("c_done", "running"),
        toolFrame("c_done", "completed"),
        toolFrame("c_open_a", "running"),
        toolFrame("c_open_b", "running"),
      ]);
      await waitForEvent(isReconnected);

      // 窗口内：轮询到 interrupted 集合恰为两个未配对工具（改前一直是空集 → 到上限后断言失败）
      await vi.waitFor(
        async () => {
          expect(interruptedCallIds(await readEvents(TASK_ID))).toEqual([
            "c_open_a",
            "c_open_b",
          ]);
        },
        { timeout: 5_000, interval: 100 },
      );
      const events = await readEvents(TASK_ID);
      expect(countOf(events, isInterrupted("c_done"))).toBe(0);
      expect(countOf(events, isRealResultOf("c_done"))).toBe(1);
      // 窗口真实存在：此刻新 run 仍没结束
      expect((await readMetaV06(TASK_ID))?.runStatus).toBe("running");

      await settleRun2(s);
      // 收尾后集合不变（不重复补、不多补）
      expect(interruptedCallIds(await readEvents(TASK_ID))).toEqual([
        "c_open_a",
        "c_open_b",
      ]);
    },
    90_000,
  );
});

describe("闭合自己抛错不影响续跑", () => {
  it(
    "【回归】重连那一次 finalizeOpenToolCalls 抛错 → 只 warn：重连成功 info 仍写、新实例没被关、新 run 跑到 awaiting_user",
    async () => {
      // 保护：重连成功路径上的闭合调用在 runReconnectAttempt 的 try 块内，必须自己 try/catch——
      // 抛出去会被外层 catch 当成「send 失败」：关掉刚接上的实例、再退避重连，
      // 「重连成功」info 也因此不会写——一次无关紧要的「补写已中断」失败就把刚接上的重连拖垮了。
      // 改前：重连路径根本不调 finalizeOpenToolCalls → 注入点从未触发（injected=0）→ 红在 injected 断言上（对症：
      // 钉住了「重连成功路径确实调了它」+「它抛错被吞」两件事；修复后绿）。
      finalizeProbe.throwBeforeNewRun = true;
      const s = await startScenario([toolFrame("c_old", "running")]);
      await waitForEvent(isReconnected);

      // 注入的抛错确实在重连路径上被触发过恰 1 次（改前 0 次）
      expect(finalizeProbe.injected).toBe(1);
      // 抛错没有把重连拖垮：新实例没被关、新 run 的 send 恰 1 次、新 run 正被消费、没有第 2 次重连
      expect(s.agent2.send).toHaveBeenCalledTimes(1);
      expect(s.agent2.close).not.toHaveBeenCalled();
      expect(hasChatSession(TASK_ID)).toBe(true);
      expect(isChatRunActive(TASK_ID)).toBe(true);
      expect(mockResume).toHaveBeenCalledTimes(2);
      // 闭合失败了（抛错点在写任何东西之前）→ 窗口内 c_old 还没被补，这是预期的降级
      expect(countOf(await readEvents(TASK_ID), isInterrupted("c_old"))).toBe(0);

      // 新 run 正常跑完：整轮收尾回到 awaiting_user；收尾那次 finalize 走原实现，兜底把 c_old 补成 interrupted
      await settleRun2(s);
      const events = await readEvents(TASK_ID);
      expect(countOf(events, isReconnecting)).toBe(1);
      expect(countOf(events, isReconnected)).toBe(1);
      expect(countOf(events, isInterrupted("c_old"))).toBe(1);
      expect(s.agent2.close).not.toHaveBeenCalled();
      expect(mockResume).toHaveBeenCalledTimes(2);
      // 重连路径 1 次（抛错）+ 整轮收尾 1 次（原实现）
      expect(finalizeProbe.calls).toBe(2);
    },
    90_000,
  );
});

describe("闭合的 lease 绑「接上的那个新实例仍是当前会话」（失主即停）", () => {
  it(
    "【回归】重连成功路径上传给 finalizeOpenToolCalls 的 lease：新实例在位时为 true；会话被摘掉后为 false；表内换成另一个实例后仍为 false",
    async () => {
      // 保护：lease 决定「失主即停」——重连成功当下若会话已被停止 / 关闭 / 顶替，闭合就不能再往事件流里补写
      // （补写会落在已不属于这条 run 的会话、或新会话的时间线上）。lease 被写成恒真、或只看「表内有没有实例」都会红。
      // 为什么直接调 lease 看真值、而不是构造「闭合进行到一半会话被换掉」的竞态：后者要卡在 finalizeOpenToolCalls
      // 内部的某个 await 上，既依赖实现细节、也容易偶发；lease 是纯函数式的所有权判据，直接问它最稳。
      // 改前：重连路径根本不调 finalizeOpenToolCalls → reconnectLeases 为空 → 红在长度断言上。
      const s = await startScenario([toolFrame("c_old", "running")]);
      await waitForEvent(isReconnected);

      expect(finalizeProbe.reconnectLeases).toHaveLength(1);
      const lease = finalizeProbe.reconnectLeases[0]!;
      // 新 run 还挂在门闸上：接上的新实例就是表内当前会话
      expect(hasChatSession(TASK_ID)).toBe(true);
      expect(lease(), "新实例仍是当前会话时 lease 应为 true").toBe(true);

      // 会话被摘掉（用户停止 / 关闭）：失主
      closeChatSessionUnconditional(TASK_ID);
      expect(hasChatSession(TASK_ID)).toBe(false);
      expect(lease(), "会话被摘掉后 lease 应为 false").toBe(false);

      // 表内换成了另一个实例（同一个持久化 agent、不同 instanceId）：仍然失主——只认「接上的那个」
      const agent3 = { agentId: AGENT_ID, close: vi.fn(), send: vi.fn() };
      mockResume.mockResolvedValueOnce(agent3);
      expect(await resumeChatSession(asTask(makeMeta(TASK_ID)), BOOT)).not.toBeNull();
      expect(hasChatSession(TASK_ID)).toBe(true);
      expect(lease(), "表内换成另一个实例后 lease 仍应为 false").toBe(false);

      // 收尾：放开旧 run 的门闸（afterEach 也会兜底），不留挂着的 promise
      s.releaseRun2();
    },
    90_000,
  );
});

describe("后台 shell 的 running 标记也在重连成功时收掉", () => {
  /** 在 run1 断线前把后台 shell 的 running 标记写进事件流（真实里由 shell 追踪器落；这里手写等价事件） */
  const writeRunningMarker = (callId: string) => async (): Promise<void> => {
    await appendEvent(
      TASK_ID,
      buildShellBackgroundEvent({ callId, phase: "running", pid: 4242 }),
    );
  };
  const isMarker =
    (callId: string, phase: "running" | "ended"): EventPred =>
    (e) => {
      const m = shellBackgroundOf(e);
      return m?.callId === callId && m.phase === phase;
    };

  it(
    "【回归】断线时有 running 标记 → 重连成功当下已补 ended(run-ended)，且落在「重连成功」之前",
    async () => {
      // 保护：shell 转后台后 tool_call 早已完成、不归「未配对 tool_call」管，但它的 running 标记会让界面继续转圈；
      // 新会话不会再关心旧会话的后台 shell → 重连成功时就要收成 ended(run-ended)（只收标记、不杀进程）。
      // 改前：窗口内只有 running 标记、没有 ended（要等整轮结束才收）→ 本用例红在断言上
      const s = await startScenario([], writeRunningMarker("c_bg"));
      await waitForEvent(isReconnected);
      expect(isChatRunActive(TASK_ID)).toBe(true);

      await vi.waitFor(
        async () => {
          expect(
            countOf(await readEvents(TASK_ID), isMarker("c_bg", "ended")),
          ).toBe(1);
        },
        { timeout: 5_000, interval: 100 },
      );
      const events = await readEvents(TASK_ID);
      const ended = events.find(isMarker("c_bg", "ended"));
      expect(shellBackgroundOf(ended as TaskEvent)).toMatchObject({
        callId: "c_bg",
        phase: "ended",
        reason: "run-ended",
      });
      // 顺序：running 标记 → ended 标记 → 重连成功
      const iRunning = events.findIndex(isMarker("c_bg", "running"));
      const iEnded = events.findIndex(isMarker("c_bg", "ended"));
      const iReconnected = events.findIndex(isReconnected);
      expect(iRunning).toBeGreaterThanOrEqual(0);
      expect(iRunning).toBeLessThan(iEnded);
      expect(iEnded).toBeLessThan(iReconnected);
      // 此刻已没有「仍在后台运行」的 shell（渲染层据此不再转圈）
      expect(collectRunningBackgroundShells(events)).toEqual([]);

      await settleRun2(s);
      // 收尾后依然只有 1 条 ended（不重复补）
      expect(
        countOf(await readEvents(TASK_ID), isMarker("c_bg", "ended")),
      ).toBe(1);
    },
    90_000,
  );

  it(
    "【对照】标记早已是 ended(exited)（进程自己结束了）→ 重连成功不再补 run-ended",
    async () => {
      // 保护：只收「最新标记仍是 running」的 shell；已经自己结束的不被重复收尾、不被改写原因。
      // 修复前后都绿（对照）
      const s = await startScenario([], async () => {
        await writeRunningMarker("c_bg2")();
        await appendEvent(
          TASK_ID,
          buildShellBackgroundEvent({
            callId: "c_bg2",
            phase: "ended",
            reason: "exited",
          }),
        );
      });
      await waitForEvent(isReconnected);
      await settleRun2(s);

      const events = await readEvents(TASK_ID);
      const endedMarkers = events
        .filter(isMarker("c_bg2", "ended"))
        .map((e) => shellBackgroundOf(e)?.reason);
      expect(endedMarkers).toEqual(["exited"]);
      expect(collectRunningBackgroundShells(events)).toEqual([]);
    },
    90_000,
  );
});
