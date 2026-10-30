/**
 * chat 自动重连预算：「重连真的恢复了」之后必须归零 + 单链总次数硬上限（R14 Q8-04）
 *
 * 缺口：task 侧早有 S1b-04（见 task-reconnect-budget-reset.test.ts / reconnect-budget.ts）——重连恢复、
 * 新 run 收到真产出后预算归零。chat 侧 consumeChatRun 却一直拿「递归带进来的已用次数 + 1」当本次断线的序号：
 * 一个跑了几小时、中途断过几次网的 chat 会话，累计第 6 次断线（即便前几次都已恢复、聊了很久）直接「自动重连放弃」标 error；
 * sdk-error 里「瞬时鉴权只放行 attempt<=1」也被旧计数污染。
 *
 * 修法（与 task 侧同口径，共用 reconnect-budget.ts）：
 *  - consumeChatRun 里 createReconnectBudget(reconnectAttempt)，流里收到「真有产出」的消息（assistant 正文 / thinking /
 *    tool_call / usage；system / status 不算）预算归零，下一次断线从「第 1/5 次」重新计；
 *  - 另有不归零的单链总次数硬上限 RECONNECT_TOTAL_MAX，兜底「每圈都先吐一点再断」的无限环。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 * 重连退避用真计时器（首次退避 2s），不用 fake timers——避免和落盘 / SDK deadline 的 setTimeout 互相干扰
 * （与 chat-runner-reconnect-giveup.test.ts 同口径）。总次数上限压到 2（vi.mock），3 圈就能撞上、不必真等 20 圈。
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

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-chat-reconnect-budget-"),
);
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

// 单链总次数硬上限压到 2：「每圈都先吐一点再断」3 圈就撞上。其余导出（createReconnectBudget 等）用原实现
vi.mock("@/lib/server/reconnect-budget", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/reconnect-budget")>();
  return { ...actual, RECONNECT_TOTAL_MAX: 2 };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  hasChatSession,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-reconnect-budget-reset DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000003000_chat_reconnect_budget";
const AGENT_ID = "agent_fake_chat_budget";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `chat reconnect budget ${id}`,
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

const assistantMsg = (text: string) => ({
  type: "assistant" as const,
  message: { content: [{ type: "text", text }] },
});

/** 先吐 prelude、再以网络错抛断的 run（stream 中途断线） */
const droppingRun = (prelude: unknown[]) => ({
  stream: async function* (): AsyncGenerator<unknown> {
    for (const m of prelude) yield m;
    throw new Error("fetch failed");
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** 吐 prelude 后正常收尾的 run */
const finishingRun = (prelude: unknown[]) => ({
  stream: async function* (): AsyncGenerator<unknown> {
    for (const m of prelude) yield m;
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

const fakeAgent = (run: unknown) => ({
  agentId: AGENT_ID,
  close: vi.fn(),
  send: vi.fn().mockResolvedValue(run),
});

const isReconnecting = (e: TaskEvent): boolean =>
  e.kind === "info" && e.meta?.kind === "reconnecting";
const isReconnected = (e: TaskEvent): boolean =>
  e.kind === "info" && e.meta?.kind === "reconnected";
const reconnectAttempts = (events: TaskEvent[]): number[] =>
  events.filter(isReconnecting).map((e) => Number(e.meta?.attempt));
const isRunError = (e: TaskEvent): boolean =>
  e.kind === "error" && !e.text.includes("[boot-recovery]");

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 是惰性的（首次 getTask 才跑），会把「当时是 running」的任务标成 error；
  // 任务还是 idle 时先触发一次，之后用例里的 running 才不会被它提前改成中间状态
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
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("chat 自动重连预算：恢复后归零（R14 Q8-04）", () => {
  it(
    "【回归】重连后的新 run 收到正文才又断线 → 新一次断线重新从「第 1/5 次」起算（修复前是第 2 次）",
    async () => {
      // S0：初始会话，吐一句正文后断线 → 第 1 次重连
      const agent0 = fakeAgent(droppingRun([assistantMsg("断线前的话")]));
      // R1：恢复了、吐了真正的正文，然后又断一次（全新的一次断线）
      const agentR1 = fakeAgent(droppingRun([assistantMsg("重连后的第一句")]));
      // R2：send 以不可重试错失败 → 放弃（让测试收口、不再退避）
      const agentR2 = {
        agentId: AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockRejectedValue(new Error("invalid api key")),
      };
      mockResume
        .mockResolvedValueOnce(agent0)
        .mockResolvedValueOnce(agentR1)
        .mockResolvedValueOnce(agentR2);

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发这一轮")).toBe("sent");

      await vi.waitFor(
        async () => {
          expect(agentR2.send).toHaveBeenCalledTimes(1);
          expect((await readEvents(TASK_ID)).some(isRunError)).toBe(true);
        },
        { timeout: 20_000, interval: 50 },
      );

      // 修复前 [1, 2]：旧 run 的已用次数带进了恢复后的新 run，第二次断线被记成「第 2 次」
      expect(reconnectAttempts(await readEvents(TASK_ID))).toEqual([1, 1]);
    },
    40_000,
  );

  it(
    "【对照】重连后只来了 system / status 这类「还没证明通了」的消息就又断 → 预算不归零（防「resume ok、send ok、立刻又断」无限环）",
    async () => {
      const agent0 = fakeAgent(droppingRun([assistantMsg("断线前的话")]));
      // R1：只有 system init / status RUNNING（不算产出）就又断
      const agentR1 = fakeAgent(
        droppingRun([
          { type: "system", subtype: "init", agent_id: "a", run_id: "r" },
          { type: "status", status: "RUNNING", agent_id: "a", run_id: "r" },
        ]),
      );
      const agentR2 = {
        agentId: AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockRejectedValue(new Error("invalid api key")),
      };
      mockResume
        .mockResolvedValueOnce(agent0)
        .mockResolvedValueOnce(agentR1)
        .mockResolvedValueOnce(agentR2);

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发这一轮")).toBe("sent");

      await vi.waitFor(
        async () => {
          expect(agentR2.send).toHaveBeenCalledTimes(1);
          expect((await readEvents(TASK_ID)).some(isRunError)).toBe(true);
        },
        { timeout: 30_000, interval: 50 },
      );

      // 没产出就不归零：两次断线连着计「第 1、第 2 次」
      expect(reconnectAttempts(await readEvents(TASK_ID))).toEqual([1, 2]);
    },
    50_000,
  );
});

describe("chat 自动重连：单链总次数硬上限（R14 Q8-04，测试里上限 = 2）", () => {
  it(
    "【回归】每圈都先吐正文再断（预算次次归零）→ 第 3 次重连超过总上限即放弃：落 error、不再 resume",
    async () => {
      // S0 → R1 → R2 都是「吐一句正文再断」：预算每圈归零，attempt 永远是 1，只有总上限能拦住
      const agent0 = fakeAgent(droppingRun([assistantMsg("第 0 圈")]));
      const agentR1 = fakeAgent(droppingRun([assistantMsg("第 1 圈")]));
      const agentR2 = fakeAgent(droppingRun([assistantMsg("第 2 圈")]));
      mockResume
        .mockResolvedValueOnce(agent0)
        .mockResolvedValueOnce(agentR1)
        .mockResolvedValueOnce(agentR2)
        // 修复前没有总上限、会接着 resume 第 4 次：给一个确定性失败让旧代码也能收口（只会更慢、不会挂死）
        .mockRejectedValue(new Error("invalid api key"));

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发这一轮")).toBe("sent");

      await vi.waitFor(
        async () => {
          expect(agentR2.send).toHaveBeenCalledTimes(1);
          expect((await readEvents(TASK_ID)).some(isRunError)).toBe(true);
        },
        { timeout: 20_000, interval: 50 },
      );

      // 总上限 = 2：S0 断（第 1 次重连、总 1）→ R1 断（第 2 次、总 2）→ R2 断（第 3 次、总 3 > 2）放弃，
      // 所以 resume 只发生 3 次（初始 + 2 次重连）、从未第 4 次
      expect(mockResume).toHaveBeenCalledTimes(3);
      expect(reconnectAttempts(await readEvents(TASK_ID))).toEqual([1, 1]);
      // error 事件与 runStatus=error 的落盘不是原子的（先事件、后状态）：轮询等状态收尾，别一次性断言
      await vi.waitFor(
        async () => {
          expect((await readMetaV06(TASK_ID))?.runStatus).toBe("error");
          expect(hasChatSession(TASK_ID)).toBe(false);
        },
        { timeout: 10_000, interval: 50 },
      );
    },
    40_000,
  );

  it(
    "【对照】总上限不误伤正常长会话：恢复一次再断一次（共 2 次重连）后仍能正常收尾，无 error",
    async () => {
      const agent0 = fakeAgent(droppingRun([assistantMsg("第 0 圈")]));
      const agentR1 = fakeAgent(droppingRun([assistantMsg("第 1 圈")]));
      const agentR2 = fakeAgent(finishingRun([assistantMsg("这回说完了")]));
      mockResume
        .mockResolvedValueOnce(agent0)
        .mockResolvedValueOnce(agentR1)
        .mockResolvedValueOnce(agentR2);

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发这一轮")).toBe("sent");

      await vi.waitFor(
        async () => {
          expect(agentR2.send).toHaveBeenCalledTimes(1);
          const evs = await readEvents(TASK_ID);
          expect(evs.filter(isReconnected)).toHaveLength(2);
          expect((await readMetaV06(TASK_ID))?.runStatus).toBe("awaiting_user");
        },
        { timeout: 20_000, interval: 50 },
      );

      const events = await readEvents(TASK_ID);
      expect(events.some(isRunError)).toBe(false);
      // 初始 + 2 次重连 = 3 次 resume（刚好踩在上限 2 上、不被误伤）
      expect(mockResume).toHaveBeenCalledTimes(3);
    },
    40_000,
  );

  it(
    "【回归】resume 连续网络类失败也计入总次数：第 1、2 次 resume 失败后第 3 次不再尝试、直接放弃（不等把 5 次退避用完）",
    async () => {
      // 链：S0 断（第 1 次重连、总 1）→ resume 网络类失败 → 递归（第 2 次、总 2）→ resume 又失败 → 递归（第 3 次、总 3 > 2）放弃。
      // 总次数要沿着「resume 失败 → 递归」一路带下去；递归时把它清零的话上限永远撞不到、要一路退避到第 5 次（2+4+8+15+30 ≈ 59 秒）。
      // 改前（没有总上限）同理：本用例的 20 秒等待里等不到 error。
      const agent0 = fakeAgent(droppingRun([assistantMsg("断线前的话")]));
      mockResume
        .mockResolvedValueOnce(agent0)
        // 之后每次 resume 都是网络类失败（可重试、非确定性——不会触发「立刻放弃」）
        .mockRejectedValue(new Error("fetch failed"));

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发这一轮")).toBe("sent");

      await vi.waitFor(
        async () => {
          expect((await readEvents(TASK_ID)).some(isRunError)).toBe(true);
        },
        { timeout: 20_000, interval: 50 },
      );

      // 初始 1 次 + 2 次失败的重连 resume = 3 次；第 3 次重连在 resume 之前就被总上限拦下
      expect(mockResume).toHaveBeenCalledTimes(3);
      await vi.waitFor(
        async () => {
          expect((await readMetaV06(TASK_ID))?.runStatus).toBe("error");
          expect(hasChatSession(TASK_ID)).toBe(false);
        },
        { timeout: 10_000, interval: 50 },
      );
    },
    40_000,
  );

  it(
    "【回归】send 连续网络类失败也计入总次数：resume 成功但 send 两次失败后第 3 次不再尝试、直接放弃（不等把 5 次退避用完）",
    async () => {
      // 链：S0 断（第 1 次重连、总 1）→ resume 成功、send 网络类失败 → 递归（第 2 次、总 2）→ resume 成功、send 又失败 → 递归（第 3 次、总 3 > 2）放弃。
      // 与上一条是同一个上限的另一条递归出口（send 失败）：这里清零同样会漏。
      const agent0 = fakeAgent(droppingRun([assistantMsg("断线前的话")]));
      const sendFailsAgent = () => ({
        agentId: AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockRejectedValue(new Error("fetch failed")),
      });
      const agentR1 = sendFailsAgent();
      const agentR2 = sendFailsAgent();
      mockResume
        .mockResolvedValueOnce(agent0)
        .mockResolvedValueOnce(agentR1)
        .mockResolvedValueOnce(agentR2)
        // 上限若没拦住会接着 resume 第 4 次：给个同样失败的 agent，别让旧代码挂死（只会更慢）
        .mockResolvedValue(sendFailsAgent());

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发这一轮")).toBe("sent");

      await vi.waitFor(
        async () => {
          expect((await readEvents(TASK_ID)).some(isRunError)).toBe(true);
        },
        { timeout: 20_000, interval: 50 },
      );

      // 初始 1 次 + 2 次重连 resume = 3 次，两次重连的 send 各发生 1 次（都失败）；第 3 次重连被总上限拦下
      expect(mockResume).toHaveBeenCalledTimes(3);
      expect(agentR1.send).toHaveBeenCalledTimes(1);
      expect(agentR2.send).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        async () => {
          expect((await readMetaV06(TASK_ID))?.runStatus).toBe("error");
          expect(hasChatSession(TASK_ID)).toBe(false);
        },
        { timeout: 10_000, interval: 50 },
      );
    },
    40_000,
  );
});
