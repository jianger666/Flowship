/**
 * compactChatSession 前置门闩（复审 F2）
 *
 * 验证：not_found / not_chat / no_session 在占 compact 位之前或同步清位后抛出，
 * 调用后 isChatCompactInProgress 为 false——避免注定失败的 compact 窗口里
 * chat-reply 白白入队再被 flush 静默清掉。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；ESM 静态 import 会 hoist，
 * 必须先钉 FE_AI_FLOW_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

// OS 保证唯一；必须在动态 import 之前钉死 env
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-compact-gate-"));
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

// @cursor/sdk 在 vitest 里可能拖进原生/重依赖；门闩测试不需要真实 Agent
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: vi.fn(),
  },
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { taskDir, writeMeta } = taskFsCore;
const {
  compactChatSession,
  CompactChatError,
  isChatCompactInProgress,
} = await import("@/lib/server/chat-runner");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-compact-gate DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const CHAT_ID = "t_1700000000888_compact_gate";
const NON_CHAT_ID = "t_1700000000889_compact_gate_task";

const makeMeta = (
  id: string,
  mode: "chat" | "task" = "chat",
): TaskMetaV06 =>
  ({
    id,
    title: `compact gate ${id}`,
    mode,
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

beforeEach(async () => {
  await fs.rm(taskDir(CHAT_ID), { recursive: true, force: true }).catch(() => {});
  await fs
    .rm(taskDir(NON_CHAT_ID), { recursive: true, force: true })
    .catch(() => {});
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("compactChatSession 前置门闩（F2）", () => {
  it("不存在的 task → not_found，且调用前后 compact 标记均为 false", async () => {
    const missing = "t_missing_compact_gate_zzzz";
    expect(isChatCompactInProgress(missing)).toBe(false);

    // await 窗口探针：注定失败路径不应置位（前置校验在占位之前）
    let sawInProgress = false;
    const probe = setInterval(() => {
      if (isChatCompactInProgress(missing)) sawInProgress = true;
    }, 0);

    let err: unknown;
    try {
      await compactChatSession(missing);
    } catch (e) {
      err = e;
    } finally {
      clearInterval(probe);
    }

    expect(err).toBeInstanceOf(CompactChatError);
    expect((err as InstanceType<typeof CompactChatError>).code).toBe(
      "not_found",
    );
    expect(isChatCompactInProgress(missing)).toBe(false);
    expect(sawInProgress).toBe(false);
  });

  it("mode!==chat → not_chat，compact 标记不置位", async () => {
    await writeMeta(makeMeta(NON_CHAT_ID, "task"));
    expect(isChatCompactInProgress(NON_CHAT_ID)).toBe(false);

    let sawInProgress = false;
    const probe = setInterval(() => {
      if (isChatCompactInProgress(NON_CHAT_ID)) sawInProgress = true;
    }, 0);

    let err: unknown;
    try {
      await compactChatSession(NON_CHAT_ID);
    } catch (e) {
      err = e;
    } finally {
      clearInterval(probe);
    }

    expect(err).toBeInstanceOf(CompactChatError);
    expect((err as InstanceType<typeof CompactChatError>).code).toBe(
      "not_chat",
    );
    expect(isChatCompactInProgress(NON_CHAT_ID)).toBe(false);
    expect(sawInProgress).toBe(false);
  });

  it("chat task 但无内存会话 → no_session，调用后标记为 false", async () => {
    await writeMeta(makeMeta(CHAT_ID, "chat"));
    expect(isChatCompactInProgress(CHAT_ID)).toBe(false);

    let err: unknown;
    try {
      await compactChatSession(CHAT_ID);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(CompactChatError);
    expect((err as InstanceType<typeof CompactChatError>).code).toBe(
      "no_session",
    );
    // 此路径走同步临界区：置位又清位；最终必须为 false
    expect(isChatCompactInProgress(CHAT_ID)).toBe(false);
  });
});
