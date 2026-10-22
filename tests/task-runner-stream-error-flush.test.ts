/**
 * task 流中途报错 / 断线时，已展示给用户的尾部回复要落盘（与 chat 版 chat-runner-stream-error-flush 对称）
 *
 * 缺口：consumeSessionRun 的 assistant 正文 / thinking 攒在 try 里的 assistantCtx 里，
 * 流「正常走完」才 flush 成事件。流中途抛错直接跳进 catch——流后的 flush 没机会跑，
 * 自动重连递归又会起新 ctx，这段用户屏幕上早已看到的尾巴就再也落不了盘（刷新 / 回放就丢），
 * 而 sdk-error 的放弃文案还写着「已生成的内容保留在上方」。
 *
 * 修法：catch 入口先 flush 思考 + 正文（先于问一问失败 error / 重连 info / 放弃 error / cancel 收尾；
 * 幂等；best-effort；失主跳过）。
 *
 * 覆盖：
 *   1. 不可重试错误（invalid api key）→ 常规 error 收尾：thinking / 正文已落盘且早于 error 事件；
 *   2. 可重试网络错 → 重连 → 重连 send 失败放弃：正文早于「重连中」info，更早于最终 error；
 *   3. 幂等：流已正常走完（正文已 flush）、随后 wait 抛错进 catch → assistant_message 仍只一条。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，先钉 FLOWSHIP_DATA_DIR 再动态 import。
 * 重连退避用真计时器（首次 2s），与 task-reconnect-send-fail-closes-session 同口径。
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
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-stream-error-flush-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({
    servers,
    dropped: [],
  }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));
vi.mock("@/lib/server/chat-pending", () => ({
  cleanupChatTaskState: vi.fn(),
  invalidateCallerToken: vi.fn(),
  buildAgentMessage: (opts: { text: string }) => opts.text,
  cancelPending: vi.fn(),
  getPendingAsk: vi.fn(),
  setChatAwaitingNotifier: vi.fn(),
  setChatTaskActionHandler: vi.fn(),
  unsetChatAwaitingNotifierIf: vi.fn(),
  unsetChatTaskActionHandlerIf: vi.fn(),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  pendingStopRequests,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { deliverAskReply } = await import("@/lib/server/task-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `task-stream-error-flush DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
const PERSISTED_AGENT_ID = "agent_t4_persisted";
const THINKING_TEXT = "先想一想：这一步该怎么做……";
const TAIL_TEXT = "已经展示给用户、但流断之前还没来得及落盘的尾巴。";

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `task-stream-error-flush ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act_shared",
    actions: [
      {
        id: "act_shared",
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    sessionAgentId: PERSISTED_AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitUntil = async (
  pred: () => boolean | Promise<boolean>,
  ms = 5000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil 超时 ${ms}ms`);
};

/** 重连读服务端凭据（readServerCreds） */
const writeServerCreds = async (): Promise<void> => {
  const dataDir = process.env.FLOWSHIP_DATA_DIR!;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apiKey: CREDS.apiKey, defaultModel: CREDS.model }),
  );
};

const thinkingMsg = (text: string) => ({
  type: "thinking" as const,
  text,
  thinking_duration_ms: 12,
});
const assistantMsg = (text: string) => ({
  type: "assistant" as const,
  message: { content: [{ type: "text", text }] },
});

const isTail = (e: TaskEvent): boolean =>
  e.kind === "assistant_message" && e.text === TAIL_TEXT;
const isThinking = (e: TaskEvent): boolean =>
  e.kind === "thinking" && e.text === THINKING_TEXT;
/**
 * 本 run 自己收尾写的 error 事件。
 * 排除 boot-recovery：meta 起手是 running，task-fs 的惰性 boot recovery 在进程内首次
 * getTask 时会往事件流最前面补一条「[boot-recovery] …」error，不是被测的收尾。
 */
const isRunError = (e: TaskEvent): boolean =>
  e.kind === "error" && !e.text.includes("[boot-recovery]");
const isReconnecting = (e: TaskEvent): boolean =>
  e.kind === "info" && e.meta?.kind === "reconnecting";
const idxOf = (events: TaskEvent[], pred: (e: TaskEvent) => boolean): number =>
  events.findIndex(pred);

/** 装一个 session：send 受理后吐 prelude，再按 mode 收场 */
const installSession = (
  id: string,
  opts: {
    prelude: unknown[];
    /** 流中途抛的错；undefined = 流正常结束 */
    streamThrows?: Error;
    /** 流正常结束后 wait() 抛的错 */
    waitThrows?: Error;
  },
): void => {
  const agent = {
    agentId: "agent_t4_a",
    close: vi.fn(),
    send: vi.fn().mockResolvedValue({
      stream: async function* (): AsyncGenerator<unknown> {
        for (const m of opts.prelude) yield m;
        if (opts.streamThrows) throw opts.streamThrows;
      },
      wait: opts.waitThrows
        ? vi.fn().mockRejectedValue(opts.waitThrows)
        : vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    }),
  };
  agentSessions.set(id, {
    instanceId: allocTaskRunInstanceId(),
    agent: agent as never,
    agentId: agent.agentId,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    startSnapshot: { title: `t4 ${id}` },
    repoPaths: [],
  });
};

describe("task 流中途抛错：已缓冲的正文 / 思考要在错误 / 重连事件之前落盘", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_t4_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
  });

  afterEach(async () => {
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const deliver = async (id: string) =>
    deliverAskReply(
      (await getTask(id))!,
      "触发这一轮",
      undefined,
      "act_shared",
      { apiKey: CREDS.apiKey, model: CREDS.model },
    );

  it("不可重试错误 → 常规 error 收尾：thinking + 尾部正文已落盘，且早于 error 事件", async () => {
    const id = alloc();
    await writeServerCreds();
    await writeMeta(makeMeta(id));
    installSession(id, {
      prelude: [thinkingMsg(THINKING_TEXT), assistantMsg(TAIL_TEXT)],
      streamThrows: new Error("invalid api key"),
    });

    const p = await deliver(id);
    void p;

    await waitUntil(async () => (await readEvents(id)).some(isRunError));

    const events = await readEvents(id);
    const thinkingIdx = idxOf(events, isThinking);
    const tailIdx = idxOf(events, isTail);
    const errorIdx = idxOf(events, isRunError);
    // 修复前：这两条都不在盘上（buffer 随 consume 退出作废）
    expect(thinkingIdx, "thinking 段没落盘").toBeGreaterThanOrEqual(0);
    expect(tailIdx, "尾部正文没落盘").toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeLessThan(tailIdx);
    expect(tailIdx).toBeLessThan(errorIdx);
    expect(events.filter(isTail)).toHaveLength(1);
    expect(events.filter(isThinking)).toHaveLength(1);
  });

  it(
    "可重试网络错 → 重连 send 失败放弃：正文早于「重连中」info，更早于最终 error",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      installSession(id, {
        prelude: [assistantMsg(TAIL_TEXT)],
        streamThrows: new Error("fetch failed"),
      });
      // 第 1 轮重连：resume 成功、send 以不可重试错误失败 → 放弃
      const agentR1 = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockRejectedValue(new Error("invalid api key")),
      };
      mockResume.mockResolvedValueOnce(agentR1);

      const p = await deliver(id);
      void p;

      await waitUntil(async () => {
        const evs = await readEvents(id);
        return agentR1.send.mock.calls.length >= 1 && evs.some(isRunError);
      }, 10_000);

      const events = await readEvents(id);
      const tailIdx = idxOf(events, isTail);
      const reconnectingIdx = idxOf(events, isReconnecting);
      const errorIdx = idxOf(events, isRunError);
      expect(tailIdx, "尾部正文没落盘").toBeGreaterThanOrEqual(0);
      expect(reconnectingIdx, "应有「重连中」info").toBeGreaterThanOrEqual(0);
      expect(tailIdx).toBeLessThan(reconnectingIdx);
      expect(reconnectingIdx).toBeLessThan(errorIdx);
      expect(events.filter(isTail)).toHaveLength(1);
    },
    25_000,
  );

  it("幂等：流正常走完（正文已 flush）后 wait 抛错进 catch → assistant_message 仍只有一条", async () => {
    const id = alloc();
    await writeServerCreds();
    await writeMeta(makeMeta(id));
    installSession(id, {
      prelude: [assistantMsg(TAIL_TEXT)],
      // 不可重试：直接走常规 error 收尾，不进重连
      waitThrows: new Error("invalid api key"),
    });

    const p = await deliver(id);
    void p;

    await waitUntil(async () => (await readEvents(id)).some(isRunError));

    const events = await readEvents(id);
    expect(events.filter(isTail)).toHaveLength(1);
  });
});
