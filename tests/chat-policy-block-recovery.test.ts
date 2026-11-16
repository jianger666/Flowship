/**
 * chat 被模型方使用政策拦截后「再也起不来」的接线（2026-11-16「接手重构马拉松视频」事故）
 *
 * 事故：run 被 `Request blocked by Anthropic … Usage Policy` 拦下 → 出错收尾保留落盘 sessionAgentId →
 * 下条消息 Agent.resume 接回同一个会话（~223k token 的历史里就躺着被拦的内容）→ 整份重发、3.9 秒再被拦，
 * 之后每条消息都这样，聊天永远起不来。
 *
 * 修法的两个接线点，这里用真 chat-runner + mock 掉的 SDK 锁行为：
 *   ① 出错收尾：识别到拦截 → error 事件带 meta.policyBlock、说清下一步、**清落盘锚点**（别的错误照旧保留）；
 *   ② resume 前：修复前就卡住的旧对话（锚点还在、事件尾最近一次失败是拦截）→ 不 resume、清锚点、返回 null
 *      让调用方降级起新会话；之后模型有过正常产出 / 没有拦截 → 照常 resume；
 *   ③ 起手 prompt：连续被拦到「一条历史都不带」时，起手段要交代清楚、不能说成窗口第一句。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
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
  path.join(os.tmpdir(), "fe-chat-policy-block-recovery-"),
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
  __buildChatInitialPromptForTest,
  closeChatSessionUnconditional,
  hasChatSession,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { appendEvent, getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-policy-block-recovery DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000005000_chat_policy_block";
const AGENT_ID = "agent_fake_policy_block";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

/** 事故现场的拦截原文（SDK stream error message 形态） */
const POLICY_BLOCKED_RAW =
  "agent run status=error\n--- SDK stream error message ---\nRequest blocked by Anthropic We are unable to complete this request because it was blocked under Anthropic's Usage Policy.\n--- SDK result dump ---\n{}";

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `chat policy block ${id}`,
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

/** stream 一上来就抛指定错误的 run */
const failingRun = (message: string) => ({
  stream: async function* (): AsyncGenerator<unknown> {
    throw new Error(message);
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

const fakeAgent = (run: unknown) => ({
  agentId: AGENT_ID,
  close: vi.fn(),
  send: vi.fn().mockResolvedValue(run),
});

const isRunError = (e: TaskEvent): boolean =>
  e.kind === "error" && !e.text.includes("[boot-recovery]");

/** 修复前落盘的旧形态：两条 error（SDK ERROR + Chat agent 异常），都没有 meta.policyBlock */
const seedOldPolicyBlock = async (id: string): Promise<void> => {
  await appendEvent(id, { kind: "user_reply", text: "接着重构视频" });
  await appendEvent(id, { kind: "assistant_message", text: "我先查一下进程" });
  await appendEvent(id, { kind: "tool_call", text: "调用 shell" });
  await appendEvent(id, { kind: "tool_result", text: "工具完成 shell" });
  await appendEvent(id, {
    kind: "error",
    text: "SDK ERROR：Request blocked by Anthropic We are unable to complete this request because it was blocked under Anthropic's Usage Policy.",
  });
  await appendEvent(id, {
    kind: "error",
    text: `Chat agent 异常：${POLICY_BLOCKED_RAW}`,
  });
  await appendEvent(id, { kind: "user_reply", text: "继续呢" });
};

/** 落盘锚点（清锚点是 fire-and-forget，轮询等它落定） */
const waitAnchor = async (expected: string | undefined): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBe(expected);
    },
    { timeout: 10_000, interval: 50 },
  );
};

beforeEach(async () => {
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 是惰性的（首次 getTask 才跑）：任务还是 idle 时先触发一次
  await getTask(TASK_ID);
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

describe("① 出错收尾：被使用政策拦截 → 清落盘锚点", () => {
  it(
    "【回归】run 被拦 → error 事件带 policyBlock + 下一步说明、不自动重连、内存会话已关、落盘锚点被清",
    async () => {
      mockResume.mockResolvedValueOnce(fakeAgent(failingRun(POLICY_BLOCKED_RAW)));

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "会被拦的那条")).toBe("sent");

      await vi.waitFor(
        async () => {
          expect((await readEvents(TASK_ID)).some(isRunError)).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );

      const err = (await readEvents(TASK_ID)).find(isRunError);
      expect(err?.meta?.policyBlock).toBe(true);
      // 记下是哪个会话被拦：之后 resume 前据此分辨「毒会话」与「被拦后新起的健康会话」
      expect(err?.meta?.policyBlockAgentId).toBe(AGENT_ID);
      // 友好文案 + 下一步；原始拦截串留在 meta.detail（错误卡可展开）
      expect(err?.text).toContain("使用政策");
      expect(err?.text).toContain("再发一条消息");
      expect(err?.text).not.toContain("SDK result dump");
      expect(String(err?.meta?.detail)).toContain("Request blocked by Anthropic");

      await vi.waitFor(
        async () => {
          expect((await readMetaV06(TASK_ID))?.runStatus).toBe("error");
          expect(hasChatSession(TASK_ID)).toBe(false);
        },
        { timeout: 10_000, interval: 50 },
      );
      // 核心：锚点没了——下条消息不会再 Agent.resume 接回那个毒会话
      await waitAnchor(undefined);
      // 不自动重连：只有最初那 1 次 resume
      expect(mockResume).toHaveBeenCalledTimes(1);
    },
    30_000,
  );

  it(
    "【对照】别的确定性失败（非网络、非拦截）→ 照旧保留落盘锚点（不是每个错误都丢会话）",
    async () => {
      mockResume.mockResolvedValueOnce(
        fakeAgent(failingRun("Cannot read properties of undefined (reading 'foo')")),
      );

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(await sendChatMessage(task, "会失败的那条")).toBe("sent");

      await vi.waitFor(
        async () => {
          expect((await readEvents(TASK_ID)).some(isRunError)).toBe(true);
          expect((await readMetaV06(TASK_ID))?.runStatus).toBe("error");
          expect(hasChatSession(TASK_ID)).toBe(false);
        },
        { timeout: 10_000, interval: 50 },
      );
      const err = (await readEvents(TASK_ID)).find(isRunError);
      expect(err?.meta?.policyBlock).toBeUndefined();
      // 给清锚点的 fire-and-forget 留足时间——它不该发生
      await new Promise((r) => setTimeout(r, 300));
      expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBe(AGENT_ID);
    },
    30_000,
  );
});

describe("② resume 前：修复前就卡住的旧对话 → 跳过 resume、清锚点、让调用方起新会话", () => {
  it("【回归】锚点还在 + 事件尾最近一次失败是拦截 → 不调 Agent.resume、返回 null、清锚点", async () => {
    await seedOldPolicyBlock(TASK_ID);
    const task = asTask(makeMeta(TASK_ID));

    const result = await resumeChatSession(task, BOOT);

    expect(result).toBeNull();
    // 要害：没去接回那个毒会话（修复前这里会 resume 成功、再被整份重发 → 秒被拦）
    expect(mockResume).not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
    await waitAnchor(undefined);
  });

  it("【回归】新版事件记了被拦的就是现锚点 → 同样不调 Agent.resume、返回 null、清锚点", async () => {
    await appendEvent(TASK_ID, { kind: "user_reply", text: "接着重构视频" });
    await appendEvent(TASK_ID, { kind: "tool_call", text: "调用 shell" });
    await appendEvent(TASK_ID, {
      kind: "error",
      text: "Chat agent 异常：本轮请求被模型方…",
      meta: { policyBlock: true, policyBlockAgentId: AGENT_ID, detail: POLICY_BLOCKED_RAW },
    });
    await appendEvent(TASK_ID, { kind: "user_reply", text: "继续呢" });

    expect(await resumeChatSession(asTask(makeMeta(TASK_ID)), BOOT)).toBeNull();
    expect(mockResume).not.toHaveBeenCalled();
    await waitAnchor(undefined);
  });

  it("【回归】被拦的是旧会话、之后已起新会话（锚点是新的）且还没产出 → 照常 resume，不丢健康会话（自动重连 / 停止后再发 / 等问答都会撞上）", async () => {
    await appendEvent(TASK_ID, { kind: "user_reply", text: "接着重构视频" });
    await appendEvent(TASK_ID, { kind: "tool_call", text: "调用 shell" });
    await appendEvent(TASK_ID, {
      kind: "error",
      text: "Chat agent 异常：本轮请求被模型方…",
      meta: {
        policyBlock: true,
        policyBlockAgentId: "agent_old_poisoned",
        detail: POLICY_BLOCKED_RAW,
      },
    });
    await appendEvent(TASK_ID, { kind: "user_reply", text: "继续呢" });
    await appendEvent(TASK_ID, { kind: "info", text: "会话已重建：AI 保留了最近 1 轮对话文字" });
    mockResume.mockResolvedValueOnce(fakeAgent(failingRun("unused")));

    // 锚点 = AGENT_ID（新会话），与被拦的 agent_old_poisoned 不同
    expect(await resumeChatSession(asTask(makeMeta(TASK_ID)), BOOT)).not.toBeNull();
    expect(mockResume).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 300));
    expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBe(AGENT_ID);
  });

  it("【对照】被拦之后模型在新会话里有过正常产出（assistant_message）→ 历史没毒，照常 resume", async () => {
    await seedOldPolicyBlock(TASK_ID);
    await appendEvent(TASK_ID, { kind: "assistant_message", text: "好，接着来" });
    mockResume.mockResolvedValueOnce(fakeAgent(failingRun("unused")));
    const task = asTask(makeMeta(TASK_ID));

    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBe(AGENT_ID);
  });

  it("【对照】事件尾上最近一次失败不是拦截（网络断）→ 照常 resume", async () => {
    await seedOldPolicyBlock(TASK_ID);
    await appendEvent(TASK_ID, {
      kind: "error",
      text: "Chat agent 异常：fetch failed",
    });
    mockResume.mockResolvedValueOnce(fakeAgent(failingRun("unused")));
    const task = asTask(makeMeta(TASK_ID));

    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(mockResume).toHaveBeenCalledTimes(1);
  });

  it("【对照】从没被拦过的普通对话 → 照常 resume、锚点保留", async () => {
    await appendEvent(TASK_ID, { kind: "user_reply", text: "你好" });
    await appendEvent(TASK_ID, { kind: "assistant_message", text: "你好呀" });
    mockResume.mockResolvedValueOnce(fakeAgent(failingRun("unused")));
    const task = asTask(makeMeta(TASK_ID));

    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect((await readMetaV06(TASK_ID))?.sessionAgentId).toBe(AGENT_ID);
  });
});

describe("③ 起手 prompt：连续被拦、一条历史都没带", () => {
  const build = (history: {
    turns: Array<{ kind: "user_reply" | "assistant_message"; text: string }>;
    truncated: boolean;
    omittedForPolicyBlock?: number;
  }): string =>
    __buildChatInitialPromptForTest(
      { ...asTask(makeMeta(TASK_ID)), events: [] } as unknown as Task,
      [],
      "（用户规则占位）",
      { text: "继续呢" },
      "",
      "",
      "",
      "",
      false,
      history,
    );

  it("【回归】omittedForPolicyBlock → 带交代段 + 「用户的新消息」，不再说成「用户的第一条消息」", () => {
    const p = build({ turns: [], truncated: true, omittedForPolicyBlock: 3 });
    expect(p).toContain("## 本窗口此前的请求被安全策略连续拦截");
    expect(p).toContain("连续 3 次");
    expect(p).toContain("## 用户的新消息");
    expect(p).not.toContain("## 用户的第一条消息");
    // 当前这句仍原样交给模型
    expect(p).toContain("继续呢");
  });

  it("【对照】没有历史也没被拦（真·新对话首条）→ 仍是「用户的第一条消息」，没有拦截交代段", () => {
    const p = build({ turns: [], truncated: false });
    expect(p).toContain("## 用户的第一条消息");
    expect(p).not.toContain("被安全策略连续拦截");
  });

  it("【对照】有历史（正常接续 / 减带）→ 仍是「本窗口已有对话」段，没有拦截交代段", () => {
    const p = build({
      turns: [{ kind: "user_reply", text: "上一句" }],
      truncated: true,
    });
    expect(p).toContain("## 本窗口已有对话（接续，不是新开）");
    expect(p).not.toContain("被安全策略连续拦截");
  });
});
