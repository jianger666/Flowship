/**
 * chat 流中途报错 / 断线时，已展示给用户的尾部回复要落盘（不能只活在内存 buffer 里）
 *
 * 缺口：assistant 正文 / thinking 是攒在 consumeChatRun 的 ctx 里的，遇到工具调用或流「正常走完」
 * 才 flush 成事件。流中途抛错直接跳进 catch——流后那两行 flush 没机会跑，ctx 随本次 consume 作废
 * （重连会起新 ctx），这段用户屏幕上早已看到的尾巴就再也落不了盘：刷新页面 / 回放就没了，
 * 而 sdk-error 的放弃文案还写着「已生成的内容保留在上方」。
 *
 * 修法：catch 入口先 flush 思考段 + 正文（先于重连 info / error / cancel 收尾，保持时序；幂等；best-effort）。
 *
 * 覆盖：
 *   1. 可重试网络错 → 重连放弃：thinking / assistant_message 落盘，且早于「重连中」info 与 error 事件；
 *   2. 不可重试错 → 常规 error 收尾：assistant_message 落盘且早于 error 事件；
 *   3. 幂等：流已正常走完（正文已 flush）、随后 run 以 error 终态收场 → assistant_message 只有一条；
 *   4. 用户 stop 后流以异常收场（abort 类）：半截回复同样落盘、状态归 idle、不落 error 事件。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 * 重连退避用真计时器（首次退避 2s），与 chat-runner-reconnect-giveup 同口径。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-stream-error-flush-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-stream-error-flush DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000003000_stream_error_flush";
const AGENT_ID = "agent_fake_stream_error_flush";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const THINKING_TEXT = "先想一想：用户要的是……";
const TAIL_TEXT = "已经展示给用户、但流断之前还没来得及落盘的尾巴。";

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `stream error flush ${id}`,
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

const thinkingMsg = (text: string) => ({
  type: "thinking" as const,
  text,
  thinking_duration_ms: 12,
});
const assistantMsg = (text: string) => ({
  type: "assistant" as const,
  message: { content: [{ type: "text", text }] },
});

const idxOf = (events: TaskEvent[], pred: (e: TaskEvent) => boolean): number =>
  events.findIndex(pred);
const isTail = (e: TaskEvent): boolean =>
  e.kind === "assistant_message" && e.text === TAIL_TEXT;
const isThinking = (e: TaskEvent): boolean =>
  e.kind === "thinking" && e.text === THINKING_TEXT;
const isReconnecting = (e: TaskEvent): boolean =>
  e.kind === "info" && e.meta?.kind === "reconnecting";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await sleep(30);
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 惰性触发：任务还是 idle 时先触发一次，之后用例里的 running 才不被它提前改
  await getTask(TASK_ID);
  // 自动重连读服务端凭据（readServerChatCreds）
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
  await sleep(30);
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await sleep(50);
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

/** 起一个 run：stream 先吐 prelude 再等 gate、然后以 throwAfter 抛错（或不抛、正常结束） */
const startRun = async (opts: {
  prelude: unknown[];
  /** gate 放行后抛的错；undefined = 正常结束流 */
  throwAfter?: Error;
  /** run.wait() 的终态（默认 finished） */
  waitResult?: { status: string; result?: string };
  /** 重连实例 R 的 send 行为（默认抛不可重试错 → 重连放弃） */
  reconnectSend?: ReturnType<typeof vi.fn>;
}): Promise<{
  releaseStream: () => void;
  agentRSend: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}> => {
  let releaseStream!: () => void;
  const streamGate = new Promise<void>((r) => {
    releaseStream = r;
  });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const run = {
    stream: async function* (): AsyncGenerator<unknown> {
      for (const m of opts.prelude) yield m;
      await streamGate;
      if (opts.throwAfter) throw opts.throwAfter;
    },
    wait: async () => opts.waitResult ?? { status: "finished" as const },
    cancel,
  };
  const agentRSend =
    opts.reconnectSend ??
    vi.fn().mockRejectedValue(new Error("invalid api key"));
  mockResume
    .mockResolvedValueOnce({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(run),
    })
    .mockResolvedValueOnce({ agentId: AGENT_ID, close: vi.fn(), send: agentRSend });
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, "触发这一轮的消息")).toBe("sent");
  return { releaseStream, agentRSend, cancel };
};

describe("chat 流中途抛错：已缓冲的正文 / 思考要在错误 / 重连事件之前落盘", () => {
  it(
    "可重试网络错 → 重连放弃：thinking + 尾部正文已落盘，且早于「重连中」info 和 error 事件",
    async () => {
      const { releaseStream, agentRSend } = await startRun({
        prelude: [thinkingMsg(THINKING_TEXT), assistantMsg(TAIL_TEXT)],
        throwAfter: new Error("fetch failed"),
      });
      releaseStream();

      await vi.waitFor(
        async () => {
          expect(agentRSend).toHaveBeenCalledTimes(1);
          expect(hasChatSession(TASK_ID)).toBe(false);
          const evs = await readEvents(TASK_ID);
          expect(
            evs.some((e) => e.kind === "error" && e.text.includes("自动重连失败")),
          ).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );

      const events = await readEvents(TASK_ID);
      // 修复前：这两条都不在盘上（buffer 随 ctx 作废）
      const thinkingIdx = idxOf(events, isThinking);
      const tailIdx = idxOf(events, isTail);
      expect(thinkingIdx, "thinking 段没落盘").toBeGreaterThanOrEqual(0);
      expect(tailIdx, "尾部正文没落盘").toBeGreaterThanOrEqual(0);
      // 时序：先 thinking 再正文（对齐流内顺序），都在「重连中」之前、更在 error 之前
      const reconnectingIdx = idxOf(events, isReconnecting);
      const errorIdx = idxOf(
        events,
        (e) => e.kind === "error" && e.text.includes("自动重连失败"),
      );
      expect(thinkingIdx).toBeLessThan(tailIdx);
      expect(tailIdx).toBeLessThan(reconnectingIdx);
      expect(reconnectingIdx).toBeLessThan(errorIdx);
      // 只落一条（幂等、不重复）
      expect(events.filter(isTail)).toHaveLength(1);
      expect(events.filter(isThinking)).toHaveLength(1);
    },
    25_000,
  );

  it("不可重试错误 → 常规 error 收尾：尾部正文已落盘，且早于 error 事件", async () => {
    const { releaseStream } = await startRun({
      prelude: [assistantMsg(TAIL_TEXT)],
      throwAfter: new Error("invalid api key"),
    });
    releaseStream();

    await vi.waitFor(
      async () => {
        expect((await readMetaV06(TASK_ID))?.runStatus).toBe("error");
        expect(hasChatSession(TASK_ID)).toBe(false);
        const evs = await readEvents(TASK_ID);
        expect(evs.some((e) => e.kind === "error")).toBe(true);
      },
      { timeout: 5_000, interval: 50 },
    );

    const events = await readEvents(TASK_ID);
    const tailIdx = idxOf(events, isTail);
    const errorIdx = idxOf(events, (e) => e.kind === "error");
    expect(tailIdx, "尾部正文没落盘").toBeGreaterThanOrEqual(0);
    expect(tailIdx).toBeLessThan(errorIdx);
    expect(events.filter(isTail)).toHaveLength(1);
    expect(isChatRunActive(TASK_ID)).toBe(false);
  });

  it("幂等：流正常走完（正文已 flush）后 run 以 error 终态收场 → assistant_message 仍只有一条", async () => {
    // 流不抛错、正文在流后 flush 落盘；wait() 返回 status=error → 抛 buildRunNotFinishedError 进 catch。
    // catch 入口的 flush 此时必须是 no-op，不能把同一段正文再写一遍。
    // 用不可重试的诊断文案（result 非空 → 不命中「裸 error」），直接走常规 error 收尾
    const { releaseStream } = await startRun({
      prelude: [assistantMsg(TAIL_TEXT)],
      waitResult: { status: "error", result: "invalid api key" },
    });
    releaseStream();

    await vi.waitFor(
      async () => {
        expect((await readMetaV06(TASK_ID))?.runStatus).toBe("error");
        const evs = await readEvents(TASK_ID);
        expect(evs.some((e) => e.kind === "error")).toBe(true);
      },
      { timeout: 5_000, interval: 50 },
    );

    const events = await readEvents(TASK_ID);
    expect(events.filter(isTail)).toHaveLength(1);
  });

  it("用户 stop 后流以异常收场（abort 类）：半截回复同样落盘、状态归 idle、不落 error 事件", async () => {
    const { releaseStream, cancel } = await startRun({
      prelude: [assistantMsg(TAIL_TEXT)],
      throwAfter: new Error("The operation was aborted"),
    });
    // 等流里那段正文进了 buffer（assistant 分支同步攒 buffer、不落盘），再点停止
    await sleep(100);
    expect(cancelChatRun(TASK_ID)).toBe(true);
    // run.cancel 被运行时包了一层（联动取消后台子代理），转发到底层是异步的，不能同步断言
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 20,
    });
    releaseStream();

    await vi.waitFor(
      async () => {
        expect(hasChatSession(TASK_ID)).toBe(false);
        expect((await readMetaV06(TASK_ID))?.runStatus).toBe("idle");
        expect(
          (await readEvents(TASK_ID)).some(isTail),
          "stop 后抛错收场，半截回复也该落盘",
        ).toBe(true);
      },
      { timeout: 5_000, interval: 50 },
    );

    const events = await readEvents(TASK_ID);
    expect(events.filter(isTail)).toHaveLength(1);
    // stop 语义：绝不落 error 事件覆盖
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });
});
