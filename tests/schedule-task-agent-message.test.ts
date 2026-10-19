/**
 * 定时到点消息在 **task 模式**下「最终发给 agent 的那段文本」（review 🔴3）。
 *
 * 之前脚注永远是「这是任务过程中用户的插话 … 先判断纯疑问还是修改要求」，
 * 而 prompts/_super.md 同时教「定时消息不是用户插话、别走二分类、不要当成改需求」——模型收到的是两条互相矛盾的指令。
 * 这里走真实调用方 `handleTaskQuestionInject(..., { scheduledTrigger: true })`，只把 `@cursor/sdk` 换成假 agent，
 * 断言 agent.send 收到的字面文本（chat-pending / task-runner / task-question-inject 全跑真代码）：
 *  - 属主会话还活着（deliverTaskQuestion → agent.send）
 *  - 没有会话（定时消息不唤醒阶段 → 一次性 agent，startOneShotQuestion）
 *  - 对照组：普通用户消息的脚注原样不变（别把用户插话也改坏）
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-task-msg-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: vi.fn(),
  },
}));
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({ servers, dropped: [] }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({ reapTaskOrphans: vi.fn() }));
vi.mock("@/lib/server/meegle-cli", () => ({ resolveUserIdentityForPrompt: async () => "" }));

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  pendingStopRequests,
  revokeTaskOps,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import("@/lib/server/chat-gate");
const { handleTaskQuestionInject } = await import("@/lib/server/task-question-inject");
const { buildAgentMessage } = await import("@/lib/server/chat-pending");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil 超时 ${ms}ms`);
};

const makeFakeAgent = (agentId: string) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const wait = vi.fn().mockResolvedValue({ status: "finished" as const });
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {},
    wait,
    cancel,
  });
  return { agentId, close, send, wait, cancel };
};

/** action 刚交卷等审阅（awaiting_ack）——这正是 ackContext 脚注会生效的现场，用来证明定时消息不会掉进那个脚注 */
const seedAckedTask = async (id: string): Promise<void> => {
  await writeMeta({
    id,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: "act_1",
    actions: [
      {
        id: "act_1",
        n: 1,
        type: "plan",
        status: "awaiting_ack",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
    ],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06);
};

const installOwnerSession = (id: string) => {
  const owner = makeFakeAgent("agent_owner");
  agentSessions.set(id, {
    instanceId: allocTaskRunInstanceId(),
    agent: owner as never,
    agentId: owner.agentId,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    startSnapshot: { title: "登录优化" },
  } as never);
  return owner;
};

const SCHEDULE_TEXT = "[SCHEDULE_FIRED id=sch_x]\n标题：看 CI\n去看 CI 结果";
const body = (text: string) => ({ text, bootArgs: { apiKey: "k", model: { id: "m" } } });
const sentText = (agent: ReturnType<typeof makeFakeAgent>): string => String(agent.send.mock.calls[0]?.[0] ?? "");

describe("task 模式：定时消息最终发给 agent 的文本", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_schmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
  });

  afterEach(async () => {
    for (const id of ids) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      endChatLifecycle(id);
      revokeTaskOps(id);
    }
    await sleep(30);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("属主会话还活着（等审阅中）：send 的文本保留 [USER_MESSAGE] 抬头 + 定时脚注；不含「用户的插话」二分类 / 〈产出审阅中〉交卷指令", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const owner = installOwnerSession(id);

    const resp = await handleTaskQuestionInject(id, body(SCHEDULE_TEXT), {
      scheduledTrigger: true,
      userReplyMetaExtra: { source: "schedule", scheduleId: "sch_x" },
    });
    expect(resp.status).toBe(200);
    await waitUntil(() => owner.send.mock.calls.length === 1);

    const text = sentText(owner);
    expect(text.startsWith("[USER_MESSAGE]")).toBe(true);
    expect(text).toContain("[SCHEDULE_FIRED id=sch_x]");
    expect(text).toContain("定时自动触发");
    expect(text).toContain("不是用户的插话");
    // 旧脚注的二分类与「重新交卷」指令不得出现——它们和 _super.md 的定时约定直接矛盾
    expect(text).not.toContain("这是任务过程中用户的插话");
    expect(text).not.toContain("先判断性质");
    expect(text).not.toContain("〈产出审阅中〉");
    expect(text).not.toContain("先调 submit_work（同 action_id）重新交卷");
    // 仍然明确禁止推进任务链
    expect(text).toContain("不要调 submit_work / submit_mr");
  });

  it("没有会话（定时消息不唤醒阶段）→ 一次性 agent：prompt 开头 / 段标题 / 脚注都是定时口径，不说「用户在任务页说了句话」", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const bot = makeFakeAgent("agent_oneshot");
    mockCreate.mockResolvedValue(bot);

    const resp = await handleTaskQuestionInject(id, body(SCHEDULE_TEXT), {
      scheduledTrigger: true,
      userReplyMetaExtra: { source: "schedule", scheduleId: "sch_x" },
    });
    expect(resp.status).toBe(200);
    await waitUntil(() => bot.send.mock.calls.length === 1);

    const prompt = sentText(bot);
    expect(prompt).toContain("系统按会话里设过的定时自动触发");
    expect(prompt).toContain("# 定时触发的消息");
    expect(prompt).toContain("[SCHEDULE_FIRED id=sch_x]");
    expect(prompt).toContain("不是用户的插话");
    expect(prompt).not.toContain("# 用户的话");
    expect(prompt).not.toContain("用户在任务页说了句话");
    expect(prompt).not.toContain("这是任务过程中用户的插话");
    // 「# 边界」段也是定时口径：没有「疑问 / 小改动」二分类；明说这条通道没有 schedule 工具、取消要提醒用户去定时任务页
    const boundary = prompt.slice(prompt.indexOf("# 边界"));
    expect(boundary).toContain("没有 `schedule` 工具");
    expect(boundary).toContain("定时任务」页取消");
    expect(boundary).not.toContain("是疑问 → 直接回答");
    expect(boundary).not.toContain("是小改动要求 → 直接改");
    // 其余边界不丢：不提交 / 不提 MR、需要授权的操作先问用户
    expect(boundary).toContain("不要提交 commit / 提 MR");
    expect(boundary).toContain("先问用户");
  });

  it("对照组：普通用户消息（无会话 → 一次性 agent）的 prompt / 脚注原样不变", async () => {
    const id = alloc();
    // 对照组需要「没有 action 可唤醒」才能走 one-shot
    await writeMeta({
      id,
      title: "登录优化",
      mode: "task",
      repoStatus: "developing",
      runStatus: "idle",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as unknown as TaskMetaV06);
    const bot = makeFakeAgent("agent_oneshot_user");
    mockCreate.mockResolvedValue(bot);

    const resp = await handleTaskQuestionInject(id, body("这个接口怎么调？"), {});
    expect(resp.status).toBe(200);
    await waitUntil(() => bot.send.mock.calls.length === 1);

    const prompt = sentText(bot);
    expect(prompt).toContain("# 用户的话");
    expect(prompt).toContain("用户在任务页说了句话");
    expect(prompt).toContain("这是任务过程中用户的插话");
    expect(prompt).not.toContain("# 定时触发的消息");
    expect(prompt).not.toContain("定时自动触发");
    // 常规边界原样（含二分类），不带定时版的 schedule 工具说明
    const boundary = prompt.slice(prompt.indexOf("# 边界"));
    expect(boundary).toContain("是疑问 → 直接回答；是小改动要求 → 直接改");
    expect(boundary).not.toContain("schedule");
  });
});

describe("buildAgentMessage(user_message)：scheduled 脚注（纯函数）", () => {
  const base = { kind: "user_message" as const, text: SCHEDULE_TEXT };

  it("scheduled：保留 [USER_MESSAGE] 抬头与正文，脚注改成「系统定时触发」", () => {
    const t = buildAgentMessage({ ...base, scheduled: true });
    expect(t.split("\n")[0]).toBe("[USER_MESSAGE]");
    expect(t).toContain(SCHEDULE_TEXT);
    expect(t).toContain("不是用户的插话");
    expect(t).not.toContain("先判断性质");
  });

  it("scheduled 优先于 ackContext：等审阅时也不要求「先 submit_work 重新交卷」（与不得调 submit_work 的约定一致）", () => {
    const t = buildAgentMessage({ ...base, scheduled: true, ackContext: { actionId: "act_1", artifactPath: "/x.md" } });
    expect(t).not.toContain("〈产出审阅中〉");
    expect(t).not.toContain("重新交卷");
    expect(t).toContain("不要调 submit_work / submit_mr");
  });

  it("非 scheduled：脚注原样（用户插话 / 产出审阅中）", () => {
    const plain = buildAgentMessage({ ...base, text: "改下标题" });
    expect(plain).toContain("这是任务过程中用户的插话");
    expect(plain).not.toContain("定时自动触发");
    const acked = buildAgentMessage({ ...base, text: "改下标题", ackContext: { actionId: "act_1" } });
    expect(acked).toContain("〈产出审阅中〉");
    expect(acked).toContain("act_1");
  });

  it("scheduled 只改 user_message 分支：user_reply / next_action 不受影响", () => {
    const reply = buildAgentMessage({ kind: "user_reply", text: "好的", scheduled: true });
    expect(reply.startsWith("[USER_REPLY]")).toBe(true);
    expect(reply).not.toContain("定时自动触发");
  });
});
