/**
 * 「立即发送」steer 不能打到已经死掉的 run 上（第三轮审查 N5 核实）
 *
 * rec.currentRun 的约定是「本轮在消费的 run 句柄，流结束就清」。但只有流**正常**走完才会清；
 * 流抛错（网络断）走 catch → 自动重连时没清：坏实例在首次退避（2s）里仍挂在表内、
 * runActive=true、currentRun 还指着那个流已断的 run → canSteerChatRun 为真。
 * 此时点「立即发送」会走 steer，把消息塞给一个流已死的 run：
 * steer 要么挂着、要么在重连摘掉坏实例之后才落定（会被判「会话被摘除」静默记 stopped）。
 * 正确做法：流一断这一轮就不能再插话，调用方回退到「打断重发」，消息一定送得出去。
 *
 * 重连退避用真计时器（首次退避 2s），不用 fake timers——同 chat-runner-reconnect-giveup.test.ts。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-steer-dead-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  canSteerChatRun,
  cancelChatRun,
  closeChatSessionUnconditional,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
  steerChatRun,
} = await import("@/lib/server/chat-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-steer-dead-run DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000006000_steer_dead";
const AGENT_ID = "agent_fake_steer_dead";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `steer dead ${id}`,
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

const hasReconnectingEvent = (events: TaskEvent[], attempt: number): boolean =>
  events.some(
    (e) =>
      e.kind === "info" &&
      e.meta?.kind === "reconnecting" &&
      e.meta?.attempt === attempt,
  );

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 惰性触发：在任务还是 idle 时先触发一次
  await getTask(TASK_ID);
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

describe("流异常中断后这一轮不能再被 steer", () => {
  it("网络断进入自动重连退避：坏实例仍在表内，但 canSteerChatRun=false、steerChatRun 不碰那个死 run", async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((r) => {
      releaseStream = r;
    });
    const steer = vi.fn(async () => "complete_delivered" as const);
    const brokenRun = {
      stream: async function* (): AsyncGenerator<never> {
        await streamGate;
        throw new Error("fetch failed");
      },
      wait: async () => ({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
      steer,
    };
    const send = vi.fn().mockResolvedValue(brokenRun);
    mockResume.mockResolvedValueOnce({
      agentId: AGENT_ID,
      close: vi.fn(),
      send,
    });

    const task = asTask(makeMeta(TASK_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(await sendChatMessage(task, "触发网络失败的消息")).toBe("sent");
    // 流还活着时能插话（对照：说明下面的 false 是「流断了」造成的、不是别的条件）
    expect(canSteerChatRun(TASK_ID)).toBe(true);

    releaseStream();
    // 进入首次退避（2s）：preamble「连接中断、正在自动重连」已落盘
    await vi.waitFor(
      async () => {
        expect(hasReconnectingEvent(await readEvents(TASK_ID), 1)).toBe(true);
      },
      { timeout: 5_000, interval: 30 },
    );

    // 退避窗口内：坏实例还挂在表里、runActive 仍为 true，但它的流已经死了
    expect(hasChatSession(TASK_ID)).toBe(true);
    expect(isChatRunActive(TASK_ID)).toBe(true);
    expect(canSteerChatRun(TASK_ID)).toBe(false);
    // 直接调 steerChatRun 也不能把消息塞给死 run（落到 followup、由调用方排队）
    expect(await steerChatRun(TASK_ID, "插话")).toBe("followup");
    expect(steer).not.toHaveBeenCalled();

    // 收尾：用户 stop 让重连链停下（表内坏实例随之摘除）
    expect(cancelChatRun(TASK_ID)).toBe(true);
    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), {
      timeout: 5_000,
      interval: 50,
    });
  });
});
