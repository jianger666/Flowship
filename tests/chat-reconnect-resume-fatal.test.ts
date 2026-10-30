/**
 * chat 自动重连：resume 遇「确定性」错误立即放弃，并报 resume 的真因（R14 Q8-05）
 *
 * 缺口：runReconnectAttempt 里 `resumeChatSession(...).catch(() => null)`——resumeChatSession 的 catch 里分得清
 * 「网络类失败（保留锚点、可重试）」和「确定性失败（agent 不存在 / 凭据失效 / 模型下线…，条件清锚点）」，
 * 但两者都只返回 null，调用方分不清，于是对「再试也不会好」的确定性失败照样退避重试 5 次（2+4+8+15+30 ≈ 59 秒），
 * 最后 give-up 报的还是**最初的网络错**（fetch failed），真因只留在 console。
 *
 * 修法：resumeChatSession 新增 opts.onFatalError（确定性失败时同步回调一次、参数是那个错误）；
 * runReconnectAttempt 据此立即放弃（不再 tryChatAutoReconnect 递归）并把 resume 的错误记进 outcome.giveUpErr，
 * consumeChatRun 的放弃收尾用它（finalizeReconnectGaveUp / handleChatRunFailure），error 事件报 resume 的真因。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 * 重连退避用真计时器（首次退避 2s），不用 fake timers（与 chat-runner-reconnect-giveup.test.ts 同口径）。
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
  path.join(os.tmpdir(), "fe-chat-reconnect-resume-fatal-"),
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
    `chat-reconnect-resume-fatal DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000004000_chat_resume_fatal";
const AGENT_ID = "agent_fake_resume_fatal";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `chat resume fatal ${id}`,
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

/** 一上来就以网络错抛断的 run（stream 立刻断线 → 进自动重连） */
const droppingRun = () => ({
  stream: async function* (): AsyncGenerator<unknown> {
    throw new Error("fetch failed");
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** 吐一句正文后正常收尾的 run */
const finishingRun = () => ({
  stream: async function* (): AsyncGenerator<unknown> {
    yield assistantMsg("重连后说完了");
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

const fakeAgent = (run: unknown) => ({
  agentId: AGENT_ID,
  close: vi.fn(),
  send: vi.fn().mockResolvedValue(run),
});

const isReconnected = (e: TaskEvent): boolean =>
  e.kind === "info" && e.meta?.kind === "reconnected";
const isRunError = (e: TaskEvent): boolean =>
  e.kind === "error" && !e.text.includes("[boot-recovery]");

/** resume 抛的「确定性」错误：不匹配 isRetryableRunError 的任何网络类关键字 */
const fatalResumeError = (): Error =>
  new Error("Agent not found: agent_fake_resume_fatal");

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 是惰性的（首次 getTask 才跑）：任务还是 idle 时先触发一次
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

describe("chat 自动重连：resume 遇确定性错误立即放弃（R14 Q8-05）", () => {
  it(
    "【回归】重连时 resume 抛「agent 不存在」→ 只 resume 这 1 次、不退避重试；error 事件报 resume 的真因，而不是最初的网络错",
    async () => {
      const agent0 = fakeAgent(droppingRun());
      mockResume
        .mockResolvedValueOnce(agent0)
        // 重连的那次 resume：确定性失败。修复前之后每次都被当成可重试（返回 null → 退避 4s / 8s / 15s / 30s 再试）
        .mockRejectedValue(fatalResumeError());

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发网络失败的消息")).toBe("sent");

      // 修复后：首次退避 2s + 一次 resume 失败即放弃；修复前这里要等 ≈59 秒才会放弃，15s 内等不到 error
      await vi.waitFor(
        async () => {
          expect((await readEvents(TASK_ID)).some(isRunError)).toBe(true);
        },
        { timeout: 15_000, interval: 50 },
      );

      // 初始 resume + 重连 resume，一共 2 次；没有第 3 次
      expect(mockResume).toHaveBeenCalledTimes(2);
      const events = await readEvents(TASK_ID);
      const errorEvent = events.find(isRunError);
      // 报真因：resume 的错误，而不是最初的 fetch failed
      expect(errorEvent?.text).toContain("Agent not found");
      expect(errorEvent?.text).not.toContain("fetch failed");
      // error 事件与 runStatus=error 的落盘顺序是实现细节：轮询等状态收尾，别一次性断言
      await vi.waitFor(
        async () => {
          expect((await readMetaV06(TASK_ID))?.runStatus).toBe("error");
          expect(hasChatSession(TASK_ID)).toBe(false);
        },
        { timeout: 10_000, interval: 50 },
      );
    },
    30_000,
  );

  it(
    "【对照】重连时 resume 抛网络类错（fetch failed）→ 仍按原样退避重试，下一次 resume 成功即重连成功",
    async () => {
      const agent0 = fakeAgent(droppingRun());
      const agentR = fakeAgent(finishingRun());
      mockResume
        .mockResolvedValueOnce(agent0)
        // 第 1 次重连的 resume：网络类失败（保留锚点、可重试）
        .mockRejectedValueOnce(new Error("fetch failed"))
        // 第 2 次重连（退避 4s 后）：成功
        .mockResolvedValueOnce(agentR);

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发网络失败的消息")).toBe("sent");

      await vi.waitFor(
        async () => {
          expect(agentR.send).toHaveBeenCalledTimes(1);
          const evs = await readEvents(TASK_ID);
          expect(evs.some(isReconnected)).toBe(true);
          expect((await readMetaV06(TASK_ID))?.runStatus).toBe("awaiting_user");
        },
        { timeout: 25_000, interval: 50 },
      );

      const events = await readEvents(TASK_ID);
      expect(events.some(isRunError)).toBe(false);
      // 初始 + 失败的第 1 次重连 + 成功的第 2 次重连 = 3 次 resume
      // （重连提示 info 只在「表内仍是坏实例」时落盘，第 2 次起坏实例已摘表、只打日志，所以这里不数 info 条数）
      expect(mockResume).toHaveBeenCalledTimes(3);
    },
    40_000,
  );
});

describe("resumeChatSession 的 onFatalError 回调契约（R14 Q8-05）", () => {
  it("【回归】确定性错误：回调恰好一次、参数就是那个错误；返回值仍是 null", async () => {
    const err = fatalResumeError();
    mockResume.mockRejectedValueOnce(err);
    const seen: unknown[] = [];

    const task = asTask(makeMeta(TASK_ID));
    const result = await resumeChatSession(task, BOOT, {
      onFatalError: (e) => {
        seen.push(e);
      },
    });

    expect(result).toBeNull();
    expect(seen).toEqual([err]);
    expect(seen[0]).toBe(err);
  });

  it("【对照】网络类错误：不回调（保留锚点、可重试），返回 null", async () => {
    mockResume.mockRejectedValueOnce(new Error("fetch failed"));
    const seen: unknown[] = [];

    const task = asTask(makeMeta(TASK_ID));
    const result = await resumeChatSession(task, BOOT, {
      onFatalError: (e) => {
        seen.push(e);
      },
    });

    expect(result).toBeNull();
    expect(seen).toEqual([]);
  });

  it("【对照】回调自己抛错：不影响 resumeChatSession 的收尾（不抛、仍返回 null）", async () => {
    mockResume.mockRejectedValueOnce(fatalResumeError());

    const task = asTask(makeMeta(TASK_ID));
    await expect(
      resumeChatSession(task, BOOT, {
        onFatalError: () => {
          throw new Error("回调炸了");
        },
      }),
    ).resolves.toBeNull();
    // 没有残留的启动预约 / 会话：之后还能正常 resume（预约在 finally 里释放）
    expect(hasChatSession(TASK_ID)).toBe(false);
    mockResume.mockResolvedValueOnce(fakeAgent(finishingRun()));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  });
});
