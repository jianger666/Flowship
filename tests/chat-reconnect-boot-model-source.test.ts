/**
 * chat 自动重连的模型来源：必须跟窗口所选（task.model）走，不能悄悄换成设置页默认（review #8）
 *
 * 缺陷：readServerChatCreds 直接取设置页默认模型。窗口选的是 B、默认是 A 时，网络断线重连用 A 把
 * 会话接回来（runModel=A）；用户下一条消息的 bootArgs.model=B ≠ runModel → chat-inject 判「换了模型」
 * → 懒重启，上下文被压成 12 轮摘要。
 *
 * 既有重连测试的盲区：config.json 默认模型与 task 的模型永远同值（task 甚至没有 model），
 * 重连用谁的模型根本测不出来。这里刻意让两者 **不同值**，直接断言 Agent.resume 收到的 model
 * 与重连后会话绑定的 runModel。
 *
 * 重连退避用真计时器（首次退避 2s），不用 fake timers——同 chat-runner-reconnect-giveup。
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
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-reconnect-model-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  closeChatSessionUnconditional,
  getChatRunModel,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-reconnect-boot-model-source DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000020000_reconnect_model";
const AGENT_ID = "agent_fake_reconnect_model";
const DEFAULT_MODEL = { id: "default-model-A", params: [] as never[] };
const WINDOW_MODEL = {
  id: "window-model-B",
  params: [{ id: "reasoning", value: "high" }],
};

const makeMeta = (model: { id: string; params?: unknown[] } | undefined): TaskMetaV06 =>
  ({
    id: TASK_ID,
    title: "reconnect model source",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: AGENT_ID,
    ...(model ? { model } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

/**
 * 跑一遍「run 网络断 → 自动重连」，返回重连那次 Agent.resume 的 options 与重连后会话的 runModel。
 * 初始会话按 web 输入条的做法用窗口模型（bootArgsForTask）建；重连醒来时由服务端自己读 config.json 算模型。
 */
const runReconnectOnce = async (
  windowModel: { id: string; params?: unknown[] } | undefined,
): Promise<{
  resumeOpts: { model?: { id: string }; apiKey?: string };
  runModel: unknown;
}> => {
  await writeMeta(makeMeta(windowModel));
  await getTask(TASK_ID);

  const failingRun = {
    stream: async function* (): AsyncGenerator<never> {
      throw new Error("fetch failed"); // 网络类错 → 进自动重连（首次退避 2s）
    },
    wait: async () => ({ status: "finished" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  // 重连实例的 run 挂起，让会话在断言时仍在表内、runModel 可读
  let releaseRun!: () => void;
  const runGate = new Promise<void>((r) => {
    releaseRun = r;
  });
  const reconnectRun = {
    stream: async function* (): AsyncGenerator<never> {
      await runGate;
    },
    wait: async () => ({ status: "finished" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const reconnectSend = vi.fn().mockResolvedValue(reconnectRun);
  mockResume
    .mockResolvedValueOnce({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(failingRun),
    })
    .mockResolvedValueOnce({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: reconnectSend,
    });

  const task = asTask(makeMeta(windowModel));
  const initialModel = windowModel ?? DEFAULT_MODEL;
  expect(
    await resumeChatSession(task, { apiKey: "client-key", model: initialModel as never }),
  ).not.toBeNull();
  expect(await sendChatMessage(task, "触发网络失败的消息")).toBe("sent");

  try {
    await vi.waitFor(() => expect(reconnectSend).toHaveBeenCalledTimes(1), {
      timeout: 8_000,
      interval: 50,
    });
    expect(mockResume).toHaveBeenCalledTimes(2);
    return {
      resumeOpts: mockResume.mock.calls[1]?.[1] as {
        model?: { id: string };
        apiKey?: string;
      },
      runModel: getChatRunModel(TASK_ID),
    };
  } finally {
    releaseRun();
  }
};

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  // 设置页默认模型 = A；窗口模型在各用例里单独写进 meta
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({ apiKey: "server-key", defaultModel: DEFAULT_MODEL }),
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

describe("chat 自动重连的模型来源", () => {
  it(
    "窗口选 B、设置页默认 A → 重连用 B：Agent.resume 与重连后的 runModel 都是 B（下次发送不触发懒重启）",
    async () => {
      const { resumeOpts, runModel } = await runReconnectOnce(WINDOW_MODEL);

      expect(resumeOpts.model?.id).toBe("window-model-B");
      expect(resumeOpts.model?.id).not.toBe(DEFAULT_MODEL.id);
      // 凭据仍是服务端读 config.json 的那份（重连没有 client bootArgs）
      expect(resumeOpts.apiKey).toBe("server-key");
      // 会话绑定的 runModel = 窗口模型（含 params），chat-inject 的 modelEquals(runModel, bootArgs.model) 才会相等
      expect(runModel).toEqual(WINDOW_MODEL);
    },
    20_000,
  );

  it(
    "窗口没选模型 → 仍回落设置页默认模型（兼容旧窗口）",
    async () => {
      const { resumeOpts, runModel } = await runReconnectOnce(undefined);

      expect(resumeOpts.model?.id).toBe("default-model-A");
      expect(runModel).toEqual(DEFAULT_MODEL);
    },
    20_000,
  );
});
