/**
 * 自动重连退避期间的实例代际门控（复审 H2/J1）
 *
 * 场景：Agent.resume 恢复的是同一个持久化 agent，两次 resume 返回**相同 agentId**。
 * reconnect prompt send 失败 → 坏实例摘表、带 staleInstanceId 进退避；退避窗口内
 * 用户 chat-reply 用同一 agentId resume 出新实例并启动自己的 run；旧 retry 醒来
 * 必须发现表内已是新实例（instanceId 不同）而让位——不得 close 用户 agent、
 * 不得 cancel 用户 run、不得把 reconnect prompt 塞进用户会话。
 *
 * J1 根因：门控若用 agentId，同持久化 agent 的新旧内存实例无法区分，旧 retry
 * 醒来会误关用户刚恢复的实例。本测试用「三次 resume 全部返回同一 AGENT_ID」钉死该场景。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；ESM 静态 import 会 hoist，
 * 必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-reconnect-race-"));
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

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-reconnect-race DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001000_reconnect_race";
// 三次 resume 全部返回同一个持久化 agentId——J1 的核心前提
const AGENT_ID = "agent_fake_same_persisted_id";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `reconnect race ${id}`,
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

/** 事件流里是否已有指定 attempt 的「重连中」info（meta.kind=reconnecting） */
const hasReconnectingEvent = (
  events: TaskEvent[],
  attempt: number,
): boolean =>
  events.some(
    (e) =>
      e.kind === "info" &&
      e.meta?.kind === "reconnecting" &&
      e.meta?.attempt === attempt,
  );

beforeEach(async () => {
  mockResume.mockReset();
  // 先关会话再 rm：避免上一轮 void setTaskSessionAgentId 与删目录竞态
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
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

describe("自动重连退避 × 用户同 agentId resume 并发（H2/J1）", () => {
  it(
    "reconnect send 失败进退避；用户同 agentId 恢复新实例并起 run；旧 retry 醒来让位不误关",
    async () => {
      // 实例 A（初始会话）：run stream 立抛网络错 → consumeChatRun 进自动重连
      const failingRun = {
        stream: async function* (): AsyncGenerator<never> {
          throw new Error("fetch failed");
        },
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn(),
      };
      const agentASend = vi.fn().mockResolvedValue(failingRun);

      // 实例 R（重连第 1 次醒来恢复的）：reconnect prompt send 直接网络错 →
      // R 被摘表、带 R 的 instanceId 进第 2 次退避（4s）
      const agentRClose = vi.fn();
      const agentRSend = vi.fn().mockRejectedValue(new Error("fetch failed"));

      // 实例 U（用户在退避窗口内恢复的）：run 挂起直到测试放行，模拟「用户 run 正在跑」
      let releaseUserRun!: () => void;
      const userRunGate = new Promise<void>((r) => {
        releaseUserRun = r;
      });
      const userRun = {
        stream: async function* (): AsyncGenerator<never> {
          await userRunGate;
        },
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn(),
      };
      const agentUClose = vi.fn();
      const agentUSend = vi.fn().mockResolvedValue(userRun);

      mockResume
        .mockResolvedValueOnce({ agentId: AGENT_ID, close: vi.fn(), send: agentASend })
        .mockResolvedValueOnce({ agentId: AGENT_ID, close: agentRClose, send: agentRSend })
        .mockResolvedValueOnce({ agentId: AGENT_ID, close: agentUClose, send: agentUSend });

      const task = asTask(makeMeta(TASK_ID));

      // 会话 A 就位、发消息 → run 网络失败 → 进自动重连（第 1 次退避 2s）
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发网络失败的消息")).toBe("sent");

      // 等到：重连第 1 次醒来 resume 出 R → R.send(reconnect prompt) 失败 → R 已摘表
      //（此刻 retry 带着 R 的 instanceId 进入第 2 次退避；R29-4：map 空时 attempt≥2
      // preamble 不落盘，故以「R.send 已失败 + map 空」作进入 4s 退避的信号，不弱化）
      await vi.waitFor(
        () => {
          expect(agentRSend).toHaveBeenCalledTimes(1);
          expect(hasChatSession(TASK_ID)).toBe(false);
        },
        { timeout: 8_000, interval: 50 },
      );
      const secondBackoffAt = Date.now();
      // R29-4 回归：第 1 次持槽仍落盘；第 2 次 map 空不落盘（防污染 B 时间线）
      {
        const events = await readEvents(TASK_ID);
        expect(hasReconnectingEvent(events, 1)).toBe(true);
        expect(hasReconnectingEvent(events, 2)).toBe(false);
      }

      // 退避窗口内：用户 chat-reply 用同一持久化 agentId resume 出新实例 U 并启动自己的 run
      //（chat-reply 的 owner 姿势：claimRun + ownerInstanceId）
      const userInstanceId = await resumeChatSession(task, BOOT, {
        claimRun: true,
      });
      expect(userInstanceId).not.toBeNull();
      expect(
        await sendChatMessage(task, "用户在退避期间发的消息", undefined, undefined, {
          ownerInstanceId: userInstanceId!,
        }),
      ).toBe("sent");
      expect(isChatRunActive(TASK_ID)).toBe(true);

      // 等旧 retry 第 2 次退避（4s）醒来并做完让位：越过窗口 + 状态稳定，不得再 resume
      await vi.waitFor(
        () => {
          if (Date.now() - secondBackoffAt < 4_500) {
            throw new Error("仍在第 2 次退避窗口内");
          }
          expect(mockResume).toHaveBeenCalledTimes(3);
          expect(agentUClose).not.toHaveBeenCalled();
          expect(userRun.cancel).not.toHaveBeenCalled();
          expect(hasChatSession(TASK_ID)).toBe(true);
          expect(isChatRunActive(TASK_ID)).toBe(true);
        },
        { timeout: 15_000, interval: 100 },
      );

      // 用户实例未被误关：agent 未 close、run 未 cancel、会话仍在跑
      expect(agentUClose).not.toHaveBeenCalled();
      expect(userRun.cancel).not.toHaveBeenCalled();
      expect(hasChatSession(TASK_ID)).toBe(true);
      expect(isChatRunActive(TASK_ID)).toBe(true);

      // reconnect prompt 没被塞进用户会话：U.send 只收到用户消息这一次
      expect(agentUSend).toHaveBeenCalledTimes(1);
      expect(String(agentUSend.mock.calls[0]?.[0] ?? "")).toContain(
        "用户在退避期间发的消息",
      );
      // 让位后旧 retry 不再 resume 第 4 个实例
      expect(mockResume).toHaveBeenCalledTimes(3);

      // 收尾：放行用户 run，自然 finished 归位
      releaseUserRun();
      await vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), {
        timeout: 5_000,
        interval: 50,
      });
    },
    35_000,
  );

  it(
    "M1 延伸：重连退避期间用户 stop → 不再 resume 复活会话、不落 error",
    async () => {
      // run stream 立抛网络错 → consumeChatRun 进自动重连（第 1 次退避 2s）
      const failingRun = {
        stream: async function* (): AsyncGenerator<never> {
          throw new Error("fetch failed");
        },
        wait: async () => ({ status: "finished" as const }),
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      mockResume.mockResolvedValue({
        agentId: AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockResolvedValue(failingRun),
      });

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "触发网络失败的消息")).toBe("sent");

      // 等「重连中」info 真正写入：此时 RECONNECT_STOPS 已注册、stop 才能打进退避窗口
      //（固定 sleep 在高负载下可能早于注册 → stop 落空 → 醒来二次 resume）
      await vi.waitFor(
        async () => {
          const events = await readEvents(TASK_ID);
          expect(hasReconnectingEvent(events, 1)).toBe(true);
        },
        { timeout: 8_000, interval: 50 },
      );
      const firstBackoffAt = Date.now();

      cancelChatRun(TASK_ID);

      // 越过第 1 次退避（2s）+ 余量：重连醒来必须让位，不得再 Agent.resume
      await vi.waitFor(
        () => {
          if (Date.now() - firstBackoffAt < 3_500) {
            throw new Error("尚未越过第 1 次退避窗口");
          }
          expect(mockResume).toHaveBeenCalledTimes(1);
          expect(hasChatSession(TASK_ID)).toBe(false);
        },
        { timeout: 12_000, interval: 100 },
      );
      // stop 接管收尾：不得走 handleChatRunFailure 落 error 状态
      const meta = await readMetaV06(TASK_ID);
      expect(meta?.runStatus).not.toBe("error");
    },
    25_000,
  );
});
