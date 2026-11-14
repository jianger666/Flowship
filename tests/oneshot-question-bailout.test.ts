/**
 * 属主的「问一问兜底」一次性 agent —— `startOneShotQuestion`
 *
 * 这条是**属主自己的**通道（任务页输入条、会话接不回时的兜底）：agent 能动手改小改动，
 * 而且它是这个 task 的一次 run——调用方先把 `runStatus` 写成 `running`、one-shot 登记
 * `runningTasks`、收尾负责归位。所以每条早退都必须自己收口，否则就是三重黑洞：
 * 事件流没回音、App 侧任务永远「运行中」、群侧回群登记一直挂着让下一轮 done 错 @ 人。
 *
 * 需求群里**非属主**的提问不走这里——那是完全解耦的只读旁路，由
 * `tests/restricted-group-question.test.ts` 钉住。
 *
 * 不 mock 被测本体：只把 `@cursor/sdk` 换成假 agent（禁止真起 agent / 真调飞书），
 * 受理段、prompt 组装、早退收口全跑真代码、task 落盘走真 fs。
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
import type { TaskStreamEvent } from "@/lib/server/task-stream";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-oneshot-bailout-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

// 需求群号：默认没绑（和以前一致）；聊天记忆那组用例里按需改，验证「两轮之间绑了群 → 接续提示补群能力」
let mockBoundChatId: string | null = null;
vi.mock("@/lib/server/feishu-group", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/feishu-group")>();
  return { ...actual, getBoundGroupChatId: async () => mockBoundChatId };
});

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

const { readEvents, readMetaV06, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  isTaskStarting,
  pendingStopRequests,
  revokeTaskOps,
  runningTasks,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const {
  CALLER_MISMATCH_ERROR,
  cleanupChatTaskState,
  getExpectedCallerToken,
  setOneShotCallerToken,
} = await import("@/lib/server/chat-pending");
const { installSessionIfCurrent, startOneShotQuestion } = await import("@/lib/server/task-runner");
const {
  __resetOneShotMemoryForTest,
  getOneShotMemoryEpoch,
  invalidateOneShotMemory,
  peekOneShotMemory,
} = await import("@/lib/server/oneshot-session-memory");
const { SCHEDULE_ONE_SHOT_BOUNDARY_LINES } = await import("@/lib/schedule");
const { getTask, setTaskRunStatus } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`oneshot-bailout DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };

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

/** 假 agent：send 立刻返回一个空流的 run（consumeSessionRun 只要这三个方法） */
const makeFakeAgent = (agentId: string) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const wait = vi.fn().mockResolvedValue({ status: "finished" as const });
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      /* 空流 */
    },
    wait,
    cancel,
  });
  return { agentId, close, send, wait, cancel };
};

/** 现场还原：action 刚交卷等审阅（awaiting_ack） */
const seedAckedTask = async (id: string): Promise<void> => {
  const meta = {
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
  } as unknown as TaskMetaV06;
  await writeMeta(meta);
};

/** 把属主的活会话摆进表里（交卷后刻意保留的那个全权限 agent） */
const installOwnerSession = (id: string, agentId = "agent_owner") => {
  const owner = makeFakeAgent(agentId);
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

describe("属主一次性答疑 agent（startOneShotQuestion）", () => {
  const ids: string[] = [];
  /** 每个用例订阅到的流事件（断言 done ok / task 归位） */
  let seen: TaskStreamEvent[] = [];
  let unsub: (() => void) | null = null;

  const alloc = (): string => {
    const id = `t_os_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  /**
   * 走一遍调用方（task-question-inject）的真实时序：
   * 读快照 → 盘上写 running → fire-and-forget 起 one-shot。
   * 传进去的 task 快照带的是**提问前**的 runStatus（prevRunStatus 的来源）。
   */
  const startLikeRoute = async (
    id: string,
    text = "这个接口啥时候好？",
    opts: { creds?: typeof CREDS; scheduled?: boolean } = {},
  ) => {
    const snapshot = (await getTask(id))!;
    await setTaskRunStatus(id, "running");
    seen = [];
    unsub?.();
    unsub = subscribeTaskStream(id, (ev) => seen.push(ev));
    startOneShotQuestion(
      snapshot,
      text,
      undefined,
      opts.creds ?? CREDS,
      undefined,
      undefined,
      opts.scheduled,
    );
  };

  const lastDone = (): Extract<TaskStreamEvent, { kind: "done" }> | undefined =>
    [...seen].reverse().find((e) => e.kind === "done") as
      | Extract<TaskStreamEvent, { kind: "done" }>
      | undefined;

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockBoundChatId = null;
    __resetOneShotMemoryForTest();
    seen = [];
  });

  afterEach(async () => {
    unsub?.();
    unsub = null;
    for (const id of ids) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      endChatLifecycle(id);
      revokeTaskOps(id);
      cleanupChatTaskState(id);
    }
    // close 路径有 fire-and-forget 落盘，等一拍再删目录（同族测试的既定手法）
    await sleep(30);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("没有活会话 → 起 agent、prompt 是「疑问就答、要改就改」、答完 runStatus 归位", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const oneshot = makeFakeAgent("agent_oneshot_owner");
    mockCreate.mockResolvedValue(oneshot);

    await startLikeRoute(id);
    await waitUntil(() => !isTaskStarting(id));

    const prompt = oneshot.send.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("修改要求就直接动手");
    expect(prompt).toContain("是小改动要求 → 直接改");
    expect(prompt).not.toContain("只读答疑");
    expect(prompt).not.toContain("禁止新建 / 修改 / 删除任何文件");

    // 一次性 agent 不挂用户 MCP；系统工具只挂不依赖 action 的（定时 / 等待）：
    // 交卷、提问、提 MR、推进这些要靠 action 与 notifier 的工具压根不该出现
    const createArg = mockCreate.mock.calls[0]?.[0] as {
      mcpServers?: unknown;
      callerToken?: string;
      local?: { settingSources?: unknown[]; customTools?: Record<string, unknown> };
    };
    expect(createArg.mcpServers).toBeUndefined();
    // callerToken 是 facade 的额外字段、传给 SDK 前就剥掉了，所以这里读不到——工具有没有挂看 customTools
    expect(createArg.callerToken).toBeUndefined();
    expect(createArg.local?.settingSources).toEqual([]);
    const toolNames = Object.keys(createArg.local?.customTools ?? {});
    expect(toolNames).toContain("schedule");
    expect(toolNames).toContain("wait");
    for (const forbidden of [
      "submit_work",
      "ask_user",
      "submit_mr",
      "set_feishu_testers",
      "set_plan_batches",
      "create_custom_action",
      "notify_group_testers",
    ]) {
      expect(toolNames, `一次性 agent 不该有 ${forbidden}`).not.toContain(forbidden);
    }
    // 聊天里的 AI 和正式会话里的 AI 一样握有推进的主导权：带 advance_next，提示词里写明怎么用
    expect(toolNames).toContain("advance_next");
    expect(prompt).toContain("主导权在你");
    expect(prompt).toContain("`advance_next`");
    expect(prompt).toContain("用户随时也能自己点「推进」");
    expect(prompt).not.toContain("你没有任务链上下文");
    // 身份：不再自称「临时助手」
    expect(prompt).not.toContain("临时助手");

    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    expect(lastDone()?.ok).toBe(true);
    expect(runningTasks.has(id)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────
  // 聊天记忆：不是一句一句冷启动（oneshot-session-memory.ts）
  // 干净答完 → 记下 agentId 并 close；下一条消息 Agent.resume 接回同一段对话，只带新的一句
  // ─────────────────────────────────────────────────────────────

  /** 跑完一轮：起一个 agent（create 或 resume 由调用方先装好 mock），等到收尾 */
  const runTurn = async (
    id: string,
    text: string,
    opts: { creds?: typeof CREDS; scheduled?: boolean } = {},
  ): Promise<void> => {
    await startLikeRoute(id, text, opts);
    await waitUntil(() => !isTaskStarting(id));
  };

  it("第二条消息：Agent.resume 接回上一轮的 agent，只带新的一句（完整背景只在首轮）；工具面不变", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const first = makeFakeAgent("agent_chat_a");
    mockCreate.mockResolvedValueOnce(first);

    await runTurn(id, "先帮我看看登录页");
    const firstPrompt = first.send.mock.calls[0]?.[0] as string;
    expect(firstPrompt).toContain("# 任务背景");
    expect(firstPrompt).toContain("先帮我看看登录页");
    // 答完照旧关掉（不占内存），但记下了 agentId
    expect(first.close).toHaveBeenCalled();
    expect(peekOneShotMemory(id)).toMatchObject({ agentId: "agent_chat_a", turns: 1, boundChatId: null });

    const second = makeFakeAgent("agent_chat_a");
    mockResume.mockResolvedValueOnce(second);
    await runTurn(id, "那顺手把按钮改成蓝色");

    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockResume.mock.calls[0]?.[0]).toBe("agent_chat_a");
    expect(mockCreate).toHaveBeenCalledTimes(1); // 只有首轮 create
    const resumeArg = mockResume.mock.calls[0]?.[1] as {
      local?: { settingSources?: unknown[]; customTools?: Record<string, unknown> };
    };
    expect(resumeArg.local?.settingSources).toEqual([]);
    const tools = Object.keys(resumeArg.local?.customTools ?? {});
    for (const name of ["schedule", "wait", "advance_next"]) expect(tools).toContain(name);
    expect(tools).not.toContain("submit_work");

    const follow = second.send.mock.calls[0]?.[0] as string;
    expect(follow).toContain("那顺手把按钮改成蓝色");
    expect(follow).toContain("接着说了一句话");
    expect(follow).toContain("# 边界");
    expect(follow).toContain("主导权在你");
    expect(follow).not.toContain("# 任务背景");
    expect(follow).not.toContain("# 本任务的需求群");
    // 又干净答完：轮数累加、这一轮也关掉
    expect(second.close).toHaveBeenCalled();
    expect(peekOneShotMemory(id)).toMatchObject({ agentId: "agent_chat_a", turns: 2 });
    expect(lastDone()?.ok).toBe(true);
    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
  });

  it("接不回（resume 抛错：存储被清 / 会话文件没了）→ 新起一个、带完整背景；这条消息不丢、记忆换成新的", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const first = makeFakeAgent("agent_chat_a");
    const fresh = makeFakeAgent("agent_chat_b");
    mockCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(fresh);
    await runTurn(id, "先帮我看看登录页");

    mockResume.mockRejectedValueOnce(new Error("AgentNotFoundError"));
    await runTurn(id, "接着改一下");

    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const prompt = fresh.send.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("# 任务背景");
    expect(prompt).toContain("接着改一下");
    expect(peekOneShotMemory(id)).toMatchObject({ agentId: "agent_chat_b", turns: 1 });
    expect(lastDone()?.ok).toBe(true);
  });

  it("接回来了却送不进去（send 抛错）→ 关掉它、新起一个带完整背景重来；用户这条不丢", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const first = makeFakeAgent("agent_chat_a");
    const fresh = makeFakeAgent("agent_chat_c");
    mockCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(fresh);
    await runTurn(id, "先帮我看看登录页");

    const broken = makeFakeAgent("agent_chat_a");
    broken.send.mockRejectedValueOnce(new Error("session state broken"));
    mockResume.mockResolvedValueOnce(broken);
    await runTurn(id, "接着改一下");

    expect(broken.close).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const prompt = fresh.send.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("# 任务背景");
    expect(prompt).toContain("接着改一下");
    expect(peekOneShotMemory(id)).toMatchObject({ agentId: "agent_chat_c", turns: 1 });
    expect(lastDone()?.ok).toBe(true);
  });

  it("换了模型（会话模型锁死换不了）→ 不接，直接新起；记忆换成新模型的", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const first = makeFakeAgent("agent_chat_a");
    const other = makeFakeAgent("agent_chat_d");
    mockCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(other);
    await runTurn(id, "先帮我看看登录页");

    await runTurn(id, "换个模型继续", { creds: { apiKey: "k", model: { id: "m2", params: [] as never[] } } });

    expect(mockResume).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(other.send.mock.calls[0]?.[0] as string).toContain("# 任务背景");
    expect(peekOneShotMemory(id)).toMatchObject({ agentId: "agent_chat_d", turns: 1 });
  });

  it("这一轮没干净结束（run 报错）→ 记忆丢弃，下一条冷启动、不去 resume 一个可能坏掉的会话", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const first = makeFakeAgent("agent_chat_a");
    mockCreate.mockResolvedValueOnce(first);
    await runTurn(id, "先帮我看看登录页");
    expect(peekOneShotMemory(id)).not.toBeNull();

    const failing = makeFakeAgent("agent_chat_a");
    failing.wait.mockResolvedValue({ status: "error" as const });
    mockResume.mockResolvedValueOnce(failing);
    await runTurn(id, "接着改一下");
    expect(lastDone()?.ok).toBe(false);
    expect(peekOneShotMemory(id)).toBeNull();

    const fresh = makeFakeAgent("agent_chat_e");
    mockCreate.mockResolvedValueOnce(fresh);
    await runTurn(id, "再试一次");
    expect(mockResume).toHaveBeenCalledTimes(1); // 只有上面那次，这次没再去接
    expect(fresh.send.mock.calls[0]?.[0] as string).toContain("# 任务背景");
    expect(peekOneShotMemory(id)).toMatchObject({ agentId: "agent_chat_e", turns: 1 });
  });

  it("正式会话装进来（action 开始）→ 记忆作废；在飞的旧一轮晚收尾也写不回去", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const first = makeFakeAgent("agent_chat_a");
    mockCreate.mockResolvedValueOnce(first);
    await runTurn(id, "先帮我看看登录页");
    expect(peekOneShotMemory(id)).not.toBeNull();

    // 正式会话安装点：lease 通过 = 真装进去，聊天记忆随之作废
    const installed = installSessionIfCurrent(
      () => true,
      id,
      {
        instanceId: allocTaskRunInstanceId(),
        agent: makeFakeAgent("agent_formal") as never,
        agentId: "agent_formal",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: "登录优化" },
      } as never,
      {
        taskActionHandler: (async () => ({ ok: true })) as never,
        awaitingNotifier: (async () => {}) as never,
      } as never,
      "tok-formal",
    );
    expect(installed).toBe(true);
    expect(peekOneShotMemory(id)).toBeNull();
    // lease 不过 = 什么都没装，记忆也不动
    agentSessions.delete(id);
    cleanupChatTaskState(id);
    const again = makeFakeAgent("agent_chat_f");
    mockCreate.mockResolvedValueOnce(again);
    await runTurn(id, "回到聊天");
    expect(peekOneShotMemory(id)).toMatchObject({ agentId: "agent_chat_f" });
    expect(installSessionIfCurrent(() => false, id, {} as never, {} as never, "x")).toBe(false);
    expect(peekOneShotMemory(id)).toMatchObject({ agentId: "agent_chat_f" });

    // 竞态：这一轮还在飞时正式 action 开始了（invalidate），它晚一步干净收尾也不能把过期记忆写回去
    let release!: () => void;
    const gate = new Promise<{ status: "finished" }>((resolve) => {
      release = () => resolve({ status: "finished" });
    });
    const slow = makeFakeAgent("agent_chat_a");
    slow.wait.mockImplementation(() => gate);
    mockResume.mockResolvedValueOnce(slow);
    const epochAtEntry = getOneShotMemoryEpoch(id);
    await startLikeRoute(id, "慢一点的一轮");
    await waitUntil(() => slow.send.mock.calls.length > 0);
    invalidateOneShotMemory(id);
    expect(getOneShotMemoryEpoch(id)).toBe(epochAtEntry + 1);
    release();
    await waitUntil(() => !isTaskStarting(id));
    expect(lastDone()?.ok).toBe(true);
    expect(peekOneShotMemory(id)).toBeNull();
  });

  it("两轮之间绑了需求群 → 接续提示补发群能力那段；没变就不重复", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const first = makeFakeAgent("agent_chat_a");
    mockCreate.mockResolvedValueOnce(first);
    await runTurn(id, "先帮我看看登录页");
    expect(first.send.mock.calls[0]?.[0] as string).not.toContain("oc_chat_1");

    mockBoundChatId = "oc_chat_1";
    const second = makeFakeAgent("agent_chat_a");
    mockResume.mockResolvedValueOnce(second);
    await runTurn(id, "把群里的人叫上");
    const follow = second.send.mock.calls[0]?.[0] as string;
    expect(follow).toContain("# 本任务的需求群");
    expect(follow).toContain("oc_chat_1");
    expect(follow).not.toContain("# 任务背景");
    expect(peekOneShotMemory(id)).toMatchObject({ boundChatId: "oc_chat_1", turns: 2 });

    const third = makeFakeAgent("agent_chat_a");
    mockResume.mockResolvedValueOnce(third);
    await runTurn(id, "再说一句");
    expect(third.send.mock.calls[0]?.[0] as string).not.toContain("# 本任务的需求群");
  });

  it("定时到点的轮次也能接回同一段对话：接续提示用定时版措辞和边界；这一轮的工具里没有 advance_next（R19-01），用户的下一轮又有", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const first = makeFakeAgent("agent_chat_a");
    mockCreate.mockResolvedValueOnce(first);
    await runTurn(id, "明早提醒我看周报");

    const second = makeFakeAgent("agent_chat_a");
    mockResume.mockResolvedValueOnce(second);
    await runTurn(id, "[SCHEDULE_FIRED id=s1] 提醒用户看周报", { scheduled: true });
    const follow = second.send.mock.calls[0]?.[0] as string;
    expect(follow).toContain("系统又按会话里设过的定时自动触发了一条消息");
    expect(follow).toContain("# 定时触发的消息");
    expect(follow).toContain("这里没有 `advance_next`");
    for (const line of SCHEDULE_ONE_SHOT_BOUNDARY_LINES) expect(follow).toContain(line);
    expect(follow).not.toContain("# 任务背景");
    expect(mockResume).toHaveBeenCalledTimes(1);
    // 代码层面：resume 按本轮入参重建工具，定时轮次拿到的是「没有 advance_next」的清单
    const scheduledTools = Object.keys(
      (mockResume.mock.calls[0]?.[1] as { local?: { customTools?: Record<string, unknown> } }).local
        ?.customTools ?? {},
    );
    expect(scheduledTools).toContain("schedule");
    expect(scheduledTools).toContain("wait");
    expect(scheduledTools).not.toContain("advance_next");

    // 定时轮次之后用户接着说话：同一段会话，advance_next 又回来了（不会被上一轮的清单带偏）
    const third = makeFakeAgent("agent_chat_a");
    mockResume.mockResolvedValueOnce(third);
    await runTurn(id, "周报我看了，帮我出个方案吧");
    expect(mockResume).toHaveBeenCalledTimes(2);
    const userTools = Object.keys(
      (mockResume.mock.calls[1]?.[1] as { local?: { customTools?: Record<string, unknown> } }).local
        ?.customTools ?? {},
    );
    expect(userTools).toContain("advance_next");
  });

  it("定时到点是第一轮（没有可接回的记忆）→ 新起的 agent 也没有 advance_next", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const fresh = makeFakeAgent("agent_sched_first");
    mockCreate.mockResolvedValueOnce(fresh);
    await runTurn(id, "[SCHEDULE_FIRED id=s2] 看下 CI", { scheduled: true });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const tools = Object.keys(
      (mockCreate.mock.calls[0]?.[0] as { local?: { customTools?: Record<string, unknown> } }).local
        ?.customTools ?? {},
    );
    expect(tools).toContain("schedule");
    expect(tools).toContain("wait");
    expect(tools).not.toContain("advance_next");
    const prompt = fresh.send.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("这里没有 `advance_next`");
  });

  // ─────────────────────────────────────────────────────────────
  // 早退必须自己收口（调用方已置 running、one-shot 还没登记 runningTasks）
  // ─────────────────────────────────────────────────────────────
  it("活会话在场 → 让位，但恢复 runStatus + 写 error + 发 done(ok=false)", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const owner = installOwnerSession(id, "agent_owner_bail");
    mockCreate.mockResolvedValue(makeFakeAgent("agent_should_not_start"));

    await startLikeRoute(id);
    await waitUntil(() => !isTaskStarting(id));

    // 让位：不起 agent、不碰属主会话
    expect(mockCreate).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalled();

    // 收口三件套——少一件就是「事件流没回音 + App 侧永远运行中」
    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    const events = await readEvents(id);
    expect(
      events.some(
        (e) => e.kind === "error" && e.text.includes("答疑 agent 没启动"),
      ),
    ).toBe(true);
    // done(ok=false) 是群回流摘登记 + 回「这轮没跑成功」的唯一触发点
    expect(lastDone()?.ok).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────
  // S01-01：create / send 抛错时 runningTasks 还没登记本实例，状态必须仍能归位
  // ─────────────────────────────────────────────────────────────
  it("Agent.create 抛错 → 写 error 事件、runStatus 归位（不卡 running）", async () => {
    const id = alloc();
    await seedAckedTask(id);
    mockCreate.mockRejectedValue(new Error("create boom"));

    await startLikeRoute(id);
    await waitUntil(() => !isTaskStarting(id));

    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    const events = await readEvents(id);
    expect(
      events.some(
        (e) => e.kind === "error" && e.text.includes("答疑 agent 启动失败"),
      ),
    ).toBe(true);
    expect(runningTasks.has(id)).toBe(false);
    // R1-03：与 bailOutWithoutRun 对齐——启动失败必须发 done(ok=false)，
    // 群出向 tap 才会摘掉 rememberGroupReply 登记并回「这轮没跑成功」
    expect(lastDone()?.ok).toBe(false);
    expect(lastDone()?.task.runStatus).toBe("awaiting_user");
  });

  it("agent.send 抛错 → runStatus 归位、已起的 agent 被 close", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const oneshot = makeFakeAgent("agent_send_fail");
    oneshot.send.mockRejectedValue(new Error("send boom"));
    mockCreate.mockResolvedValue(oneshot);

    await startLikeRoute(id);
    await waitUntil(() => !isTaskStarting(id));

    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    expect(oneshot.close).toHaveBeenCalled();
    expect(runningTasks.has(id)).toBe(false);
    expect(lastDone()?.ok).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────
  // 没推进过 / 没会话的任务也要能建定时：一次性 agent 运行期间登记自己的 callerToken，
  // 交给 SDK 的 schedule 工具才过得了 matchExpectedCallerToken；收尾只摘自己的
  // ─────────────────────────────────────────────────────────────
  type SdkTool = { execute: (args: unknown, ctx?: unknown) => Promise<{ content: Array<{ text?: string }> }> };
  type CreateArg = { local: { customTools: Record<string, SdkTool> } };
  const toolText = async (tool: SdkTool, args: Record<string, unknown>): Promise<string> =>
    (await tool.execute(args, undefined)).content.map((c) => c.text ?? "").join("");
  const emptyRun = (agent: ReturnType<typeof makeFakeAgent>) => ({
    stream: async function* () {
      /* 空流 */
    },
    wait: agent.wait,
    cancel: agent.cancel,
  });

  it("运行期间 schedule 工具认一次性 agent 的 token（能建定时）；收尾摘掉后同一个工具被拒", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const oneshot = makeFakeAgent("agent_sched");
    let tokenAtCreate: string | null = null;
    let listedDuringRun = "";
    mockCreate.mockImplementation(async () => {
      tokenAtCreate = getExpectedCallerToken(id);
      return oneshot;
    });
    oneshot.send.mockImplementation(async () => {
      const tools = (mockCreate.mock.calls[0]?.[0] as CreateArg).local.customTools;
      // 真实调一次工具：不是 [CALLER_MISMATCH] 即认了这个 token
      listedDuringRun = await toolText(tools.schedule!, { action: "list" });
      return emptyRun(oneshot);
    });

    await startLikeRoute(id);
    await waitUntil(() => !isTaskStarting(id));

    // create 之前就登记好了（工具一挂上就可能被调）
    expect(tokenAtCreate).toBeTruthy();
    expect(listedDuringRun).not.toBe(CALLER_MISMATCH_ERROR);
    // 收尾：只摘自己的 → 槽清空、同一个工具再调被拒
    expect(getExpectedCallerToken(id)).toBeNull();
    const tools = (mockCreate.mock.calls[0]?.[0] as CreateArg).local.customTools;
    expect(await toolText(tools.schedule!, { action: "list" })).toBe(CALLER_MISMATCH_ERROR);
  });

  it("运行期间被正式会话接管（token 槽被换）→ 收尾不误删别人的 token", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const oneshot = makeFakeAgent("agent_takeover");
    mockCreate.mockResolvedValue(oneshot);
    oneshot.send.mockImplementation(async () => {
      setOneShotCallerToken(id, "formal-session-token");
      return emptyRun(oneshot);
    });

    await startLikeRoute(id);
    await waitUntil(() => !isTaskStarting(id));

    expect(getExpectedCallerToken(id)).toBe("formal-session-token");
  });

  it("Agent.create 抛错 / 让位给活会话：都不留下 token（让位的那条根本没登记过）", async () => {
    const failId = alloc();
    await seedAckedTask(failId);
    mockCreate.mockRejectedValue(new Error("create boom"));
    await startLikeRoute(failId);
    await waitUntil(() => !isTaskStarting(failId));
    expect(getExpectedCallerToken(failId)).toBeNull();

    mockCreate.mockReset();
    const yieldId = alloc();
    await seedAckedTask(yieldId);
    installOwnerSession(yieldId);
    await startLikeRoute(yieldId);
    await waitUntil(() => !isTaskStarting(yieldId));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(getExpectedCallerToken(yieldId)).toBeNull();
  });

  it("真 run 在飞时让位且绝不动 runStatus（那个 running 是后继的）", async () => {
    const id = alloc();
    await seedAckedTask(id);
    mockCreate.mockResolvedValue(makeFakeAgent("agent_should_not_start"));

    const snapshot = (await getTask(id))!;
    await setTaskRunStatus(id, "running");
    // 后继 B 已登记 runner——它会自己收尾 runStatus，one-shot 碰了就是踩后继
    runningTasks.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agentId: "agent_b",
      startedAt: Date.now(),
      startSnapshot: { title: "登录优化" },
      cancel: () => {},
    } as never);
    seen = [];
    unsub = subscribeTaskStream(id, (ev) => seen.push(ev));

    startOneShotQuestion(snapshot, "问一句", undefined, CREDS);
    await waitUntil(() => !isTaskStarting(id));

    expect(mockCreate).not.toHaveBeenCalled();
    expect((await readMetaV06(id))?.runStatus).toBe("running");
    expect(lastDone()).toBeUndefined();
  });
});
