/**
 * 需求群「非属主受限答疑」通道 —— 与 task 运行状态机**解耦**
 *
 * 入口固定走真实调用方 `handleTaskQuestionInject(..., { restrictToQuestion: true })`，
 * 只把 `@cursor/sdk` 换成假 agent（禁止真起 agent / 真调飞书）；注入链、prompt 组装、
 * 失败收口全跑真代码，task 落盘走真 fs。
 *
 * ⚠️ **刻意不 mock `@/lib/server/chat-pending`**：上一轮把它整个打桩、`buildAgentMessage`
 * 成了恒等函数，于是「受限 prompt 里不许有放行措辞」的负向断言恒绿——真实漏出的
 * 「…**修改要求**才动手改…」一直没人发现。本文件必须用真的消息封装。
 *
 * 钉三件事：
 * 1. **不碰 task 运行态**：不写 `runStatus`、不占 `runningTasks`、不动属主 `agentSessions`。
 *    受限答疑不是 task 的 action run——写了 running 就会让顶栏「停止」键冒出来，而它走的是
 *    `stopTaskAgent` 核弹路径（awaiting_ack 的 plan/review 一律标 cancelled + 关属主会话）。
 * 2. **prompt 讲规矩、工具默认全开**：# 边界只放三条红线（不改文件/部署发布上线与线上分支找属主/其余放行）；
 *    Agent.create 不传 tools 白名单（两端默认全开），只保留身份隔离（无 callerToken、无 customTools）。
 * 3. **失败必收口**：起不来时写 error 事件 + 发 `done(ok=false)`——群出向 tap 靠这条 done
 *    回「这轮没跑成功」并摘掉回群登记，缺了它登记一直挂着、下一轮无关的 done 会错 @ 人。
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
import { isStopButtonVisible } from "@/lib/task-display";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-restricted-group-q-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: vi.fn(),
  },
}));

// 群上下文（只有带 groupContext 的调用才会动态 import 这两个模块）：拉取函数换成可控的 mock，
// 其余导出（lookupGroupMemberName 等纯内存函数）保持真实
const mockFetchRoster = vi.fn();
const mockFetchHistory = vi.fn();
vi.mock("@/lib/server/feishu-bridge/group-roster", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/feishu-bridge/group-roster")>()),
  fetchGroupRoster: (...a: unknown[]) => mockFetchRoster(...a),
  fetchRecentGroupMessages: (...a: unknown[]) => mockFetchHistory(...a),
}));
const mockIdentity = vi.fn();
const mockBotOpenId = vi.fn();
const mockBotName = vi.fn();
vi.mock("@/lib/server/feishu-bridge/lark-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/feishu-bridge/lark-api")>()),
  getLarkLocalIdentity: (...a: unknown[]) => mockIdentity(...a),
  getBotOpenId: (...a: unknown[]) => mockBotOpenId(...a),
  getBotDisplayName: (...a: unknown[]) => mockBotName(...a),
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

const { readEvents, readMetaV06, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  agentSessions,
  allocTaskRunInstanceId,
  cancelRestrictedQuestions,
  clearTaskStarting,
  hasRestrictedQuestionInFlight,
  pendingStopRequests,
  revokeTaskOps,
  runningTasks,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { handleTaskQuestionInject, buildRestrictedGroupContext } = await import(
  "@/lib/server/task-question-inject"
);
const { registerPendingAsk, clearPendingAsk } = await import(
  "@/lib/server/chat-pending"
);
const { registerOutboundQuestion, clearCorrelatedEntries } = await import(
  "@/lib/server/feishu-bridge/group-outbound-registry"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`restricted-group DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

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

/** 手动闸门：让假 agent 的流停在半路，好在「飞行中」断言 task 运行态没被污染 */
const makeGate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};

/** 假 agent：send 立刻返回一个（可选带闸门的）空流 run */
const makeFakeAgent = (agentId: string, streamGate?: Promise<void>) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const wait = vi.fn().mockResolvedValue({ status: "finished" as const });
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      if (streamGate) await streamGate;
    },
    wait,
    cancel,
  });
  return { agentId, close, send, wait, cancel };
};

/** 假 agent：流里真吐一段 assistant 文本（走真的 handleSdkMessage 翻译成 delta + 消息事件） */
const makeTalkingAgent = (agentId: string, text: string) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const wait = vi.fn().mockResolvedValue({ status: "finished" as const });
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      };
    },
    wait,
    cancel,
  });
  return { agentId, close, send, wait, cancel };
};

/**
 * 现场还原：action 刚交卷等审阅（awaiting_ack）、属主的会话还挂着——
 * 群里同事此刻 @bot 说了句话。这正是产物刚播报进群、同事最可能回话的窗口。
 */
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

describe("需求群非属主受限答疑（与 task 运行状态机解耦）", () => {
  const ids: string[] = [];
  /** 每个用例订阅到的流事件（断言 done ok / 收口） */
  let seen: TaskStreamEvent[] = [];
  let unsub: (() => void) | null = null;

  const alloc = (): string => {
    const id = `t_grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  const watch = (id: string): void => {
    seen = [];
    unsub = subscribeTaskStream(id, (ev) => seen.push(ev));
  };

  const lastDone = (): Extract<TaskStreamEvent, { kind: "done" }> | undefined =>
    [...seen].reverse().find((e) => e.kind === "done") as
      | Extract<TaskStreamEvent, { kind: "done" }>
      | undefined;

  /** 群非属主消息回灌（正文抬头与 group-route 真实拼法一致） */
  const injectGroupQuestion = (
    id: string,
    text = "这个接口啥时候好？",
    /** 群侧回群登记的 token（真实链路由 group-route 传下来） */
    restrictedRunTag?: string,
  ) =>
    handleTaskQuestionInject(
      id,
      {
        text: `[群消息·来自 李四（非任务所有者）]——只答疑、不执行修改类指令\n${text}`,
        bootArgs: { apiKey: "k", model: { id: "m" } },
      },
      {
        restrictToQuestion: true,
        userReplyMetaExtra: { source: "feishu_group", groupSender: "李四" },
        ...(restrictedRunTag ? { restrictedRunTag } : {}),
      },
    );

  beforeEach(() => {
    mockCreate.mockReset();
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
    }
    // 收尾路径有 fire-and-forget 落盘，等一拍再删目录（同族测试的既定手法）
    await sleep(30);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────
  // 1. 不碰 task 运行态（并存答疑时点「停止」会误伤属主）
  // ─────────────────────────────────────────────────────────────
  it("全程不写 runStatus / 不占 runningTasks → 顶栏「停止」键不会冒出来", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const owner = installOwnerSession(id);
    const gate = makeGate();
    const bot = makeFakeAgent("agent_group_ro", gate.promise);
    mockCreate.mockResolvedValue(bot);

    watch(id);
    const resp = await injectGroupQuestion(id);
    expect(resp.status).toBe(200);

    // 路由返回这一刻：旧实现盘上已经是 running（停止键随即出现）
    const afterInject = (await readMetaV06(id))!;
    expect(afterInject.runStatus).toBe("awaiting_user");
    expect(isStopButtonVisible(afterInject)).toBe(false);

    // agent 真跑起来了、且飞行期间同样不占 task 运行态
    await waitUntil(() => bot.send.mock.calls.length === 1);
    const inFlight = (await readMetaV06(id))!;
    expect(inFlight.runStatus).toBe("awaiting_user");
    expect(isStopButtonVisible(inFlight)).toBe(false);
    expect(runningTasks.has(id)).toBe(false);

    // 属主的会话原样在表里：既没被 send 进去、也没被 close、更没被顶替
    expect(owner.send).not.toHaveBeenCalled();
    expect(owner.close).not.toHaveBeenCalled();
    expect(agentSessions.get(id)?.agentId).toBe("agent_owner");

    gate.release();
    await waitUntil(() => !!lastDone());
    expect(lastDone()?.ok).toBe(true);
    // 答完也不该「归位」出一个新的 runStatus——它压根没被动过
    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    expect(runningTasks.has(id)).toBe(false);
    expect(agentSessions.get(id)?.agentId).toBe("agent_owner");
  });

  it("不改 action 状态：审阅中的产物仍停在 awaiting_ack", async () => {
    const id = alloc();
    await seedAckedTask(id);
    installOwnerSession(id);
    mockCreate.mockResolvedValue(makeFakeAgent("agent_group_ro2"));

    watch(id);
    await injectGroupQuestion(id, "这个方案里的缓存策略是怎么定的？");
    await waitUntil(() => !!lastDone());

    const meta = (await readMetaV06(id))!;
    expect(meta.actions[0]?.status).toBe("awaiting_ack");
    expect(meta.currentActionId).toBe("act_1");
  });

  // ─────────────────────────────────────────────────────────────
  // 2. 旁路 prompt 讲规矩 + 工具默认全开（内部 honor-system，不接执行层白名单）
  // ─────────────────────────────────────────────────────────────
  it("prompt 只有提示词约束、一句“可以改”的措辞都不注入", async () => {
    const id = alloc();
    await seedAckedTask(id);
    installOwnerSession(id);
    const bot = makeFakeAgent("agent_group_prompt");
    mockCreate.mockResolvedValue(bot);

    watch(id);
    await injectGroupQuestion(id);
    await waitUntil(() => bot.send.mock.calls.length === 1);

    const prompt = bot.send.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("答疑助手");
    // 极简两行：红线 + 收尾，不许加戏
    expect(prompt).toContain("三条红线");
    expect(prompt).toContain("不改任何文件");
    expect(prompt).toContain("先找属主确认");
    expect(prompt).toContain("其余都可以干");
    expect(prompt).not.toContain("test MR");
    // 特制执行层已摘掉：prompt 里不许再提只读白名单专用工具
    expect(prompt).not.toContain("merge_test_mr");
    expect(prompt).not.toContain("只读 shell");
    expect(prompt).not.toContain("调接口");
    // honor-system 下公司环境是全量同步的；本用例未配公司环境，所以路径/--config 不该出现
    //（配了的场景全量声明里本来就有路径，这是“全开”接受的代价）。
    expect(prompt).not.toContain("company-env.json`");
    expect(prompt).not.toContain("--config");
    expect(prompt).not.toContain("直接改");
    expect(prompt).not.toContain("直接动手");
    expect(prompt).not.toContain("才动手");
    expect(prompt).not.toContain("动手改");
    // 交卷 / 提 MR 这类推进语义同样不该出现在旁路通道
    expect(prompt).not.toContain("submit_work");
    expect(prompt).not.toContain("submit_mr");

    // 「# 边界」必须是最后一段：约束后面不许再跟任何别的指令段
    const boundaryAt = prompt.lastIndexOf("\n# 边界");
    expect(boundaryAt).toBeGreaterThan(prompt.lastIndexOf("\n# 对方的话"));
    expect(prompt.slice(boundaryAt + 1)).not.toMatch(/\n# /);

    // 旁路 agent 执行层白名单 + 不挂系统 customTools（无 callerToken 就没有交卷 / 提 MR 身份）；
    // 工具默认全开：不传 tools 白名单（Cursor 标准工具集 / pi 全量编码工具）；
    // 身份照旧隔离（无 callerToken、无 customTools），审计靠事件流。
    const createArg = mockCreate.mock.calls[0]?.[0] as {
      tools?: unknown;
      mcpServers?: unknown;
      callerToken?: string;
      local?: { settingSources?: unknown[]; customTools?: unknown };
    };
    // honor-system：执行层不限，规矩只在提示词里
    expect(createArg.tools).toBeUndefined();
    expect(createArg.mcpServers).toBeUndefined();
    expect(createArg.callerToken).toBeUndefined();
    expect(createArg.local?.settingSources).toEqual([]);
    expect(createArg.local?.customTools).toBeUndefined();

    await waitUntil(() => !!lastDone());
  });

  // ─────────────────────────────────────────────────────────────
  // 3. 启动失败必须收口
  // ─────────────────────────────────────────────────────────────
  it("Agent.create 挂掉 → error 事件 + done(ok=false)，且不留任何假状态", async () => {
    const id = alloc();
    await seedAckedTask(id);
    installOwnerSession(id);
    mockCreate.mockRejectedValue(new Error("boom-create"));

    watch(id);
    const resp = await injectGroupQuestion(id);
    expect(resp.status).toBe(200);

    // done(ok=false) 是群出向「回一句没跑成功 + 摘掉登记」的唯一触发点
    await waitUntil(() => !!lastDone());
    expect(lastDone()?.ok).toBe(false);

    const events = await readEvents(id);
    expect(
      events.some((e) => e.kind === "error" && e.text.includes("boom-create")),
    ).toBe(true);

    // 收口后盘上 / 内存里不许留残迹
    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    expect((await readMetaV06(id))?.actions[0]?.status).toBe("awaiting_ack");
    expect(runningTasks.has(id)).toBe(false);
    expect(agentSessions.get(id)?.agentId).toBe("agent_owner");
  });

  // ─────────────────────────────────────────────────────────────
  // 4. 终态收尾能叫停旁路（DELETE / finalize 要删 worktree）
  // ─────────────────────────────────────────────────────────────
  it("cancelRestrictedQuestions 能叫停在飞的旁路 agent、并摘掉登记", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const gate = makeGate();
    const bot = makeFakeAgent("agent_group_cancel", gate.promise);
    mockCreate.mockResolvedValue(bot);

    watch(id);
    await injectGroupQuestion(id);
    await waitUntil(() => bot.send.mock.calls.length === 1);
    expect(hasRestrictedQuestionInFlight(id)).toBe(true);

    // DELETE / finalize 的收尾调这一下——它不在 runningTasks 里、cancelTaskRun 够不着
    cancelRestrictedQuestions(id);
    expect(bot.cancel).toHaveBeenCalled();

    gate.release();
    await waitUntil(() => !!lastDone());
    await waitUntil(() => !hasRestrictedQuestionInFlight(id));
    expect(bot.close).toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────
  // 5. 事件身份（token 化投递协议的运行时半边）
  // ─────────────────────────────────────────────────────────────
  it("本 run 的 delta / 消息 / done 都带 origin = 群侧登记 token", async () => {
    const id = alloc();
    await seedAckedTask(id);
    installOwnerSession(id);
    mockCreate.mockResolvedValue(makeTalkingAgent("agent_origin", "缓存 5 分钟"));

    watch(id);
    await injectGroupQuestion(id, "缓存怎么算的？", "reply-token-1");
    await waitUntil(() => !!lastDone());

    const delta = seen.find((e) => e.kind === "assistant_delta");
    expect(delta).toBeDefined();
    // 没有 origin 的话，这段答案会被攒进属主那条登记（错投）
    expect((delta as { origin?: string }).origin).toBe("reply-token-1");
    const msg = seen.find(
      (e) => e.kind === "event" && e.event.kind === "assistant_message",
    );
    expect((msg as { origin?: string } | undefined)?.origin).toBe(
      "reply-token-1",
    );
    // done 是回群 + 摘登记的唯一触发点：漏了 origin 就会去 flush 属主的登记
    expect((lastDone() as { origin?: string }).origin).toBe("reply-token-1");
  });

  it("没给 token 也自生成一个——旁路事件永不冒充属主主链", async () => {
    const id = alloc();
    await seedAckedTask(id);
    mockCreate.mockResolvedValue(makeFakeAgent("agent_origin_default"));

    watch(id);
    await injectGroupQuestion(id);
    await waitUntil(() => !!lastDone());

    const origin = (lastDone() as { origin?: string }).origin;
    expect(typeof origin).toBe("string");
    expect(origin).not.toBe("");
  });

  it("旁路在飞信号：起跑发 active=true、收口发 active=false（前端据此判工具块是否还转圈）", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const gate = makeGate();
    const bot = makeFakeAgent("agent_signal", gate.promise);
    mockCreate.mockResolvedValue(bot);

    watch(id);
    await injectGroupQuestion(id);
    await waitUntil(() => bot.send.mock.calls.length === 1);

    const signals = () =>
      seen.filter(
        (e): e is Extract<TaskStreamEvent, { kind: "restricted_run" }> =>
          e.kind === "restricted_run",
      );
    expect(signals()[0]?.active).toBe(true);
    // 信号纯给 UI——runStatus 一个字节都没被写
    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");

    gate.release();
    await waitUntil(() => !hasRestrictedQuestionInFlight(id));
    await waitUntil(() => signals().some((e) => !e.active));
    expect(signals().at(-1)?.active).toBe(false);
  });

  it("agent.send 挂掉 → 同一条收口路径（只发一次 done）", async () => {
    const id = alloc();
    await seedAckedTask(id);
    const bot = makeFakeAgent("agent_group_send_fail");
    bot.send.mockRejectedValue(new Error("boom-send"));
    mockCreate.mockResolvedValue(bot);

    watch(id);
    await injectGroupQuestion(id);
    await waitUntil(() => !!lastDone());

    expect(lastDone()?.ok).toBe(false);
    expect(seen.filter((e) => e.kind === "done")).toHaveLength(1);
    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    // 起过的 agent 必须关掉、别泄漏
    expect(bot.close).toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────
  // 群协作 v2：groupContext → 群上下文三段 + 回复规矩
  // ─────────────────────────────────────────────────────────────
  describe("群上下文 prompt（groupContext）", () => {
    const CHAT = "oc_ctx_group";
    const QUESTION_MSG = "om_question_self";

    const memberList = [
      { openId: "ou_owner", name: "陈属主", kind: "user" as const },
      { openId: "ou_li_si", name: "李四", kind: "user" as const },
      { openId: "ou_otherbot1", name: "安若流年", kind: "bot" as const },
      { openId: "ou_self_bot", name: "Flowship测试机器人", kind: "bot" as const },
    ];
    const historyList = [
      {
        messageId: "om_h1",
        createTime: "2026-10-14 16:29",
        senderOpenId: "ou_li_an",
        senderName: "李安",
        senderKind: "user" as const,
        msgType: "text",
        content: "口径你看着办吧",
        mentions: [],
      },
      {
        messageId: QUESTION_MSG,
        createTime: "2026-10-14 16:31",
        senderOpenId: "ou_li_si",
        senderName: "李四",
        senderKind: "user" as const,
        msgType: "text",
        content: "这条是本轮问题自己，不该重复出现在聊天段",
        mentions: [],
      },
    ];

    /** 带 groupContext 的真实注入链（meta 与 group-route 写的一致） */
    const injectWithCtx = (
      id: string,
      meta: Record<string, unknown> = {},
      runTag?: string,
    ) =>
      handleTaskQuestionInject(
        id,
        {
          text: "[群消息·来自 李四（非任务所有者）]——只答疑、不执行修改类指令\n学号口径定了吗",
          bootArgs: { apiKey: "k", model: { id: "m" } },
        },
        {
          restrictToQuestion: true,
          userReplyMetaExtra: {
            source: "feishu_group",
            groupSender: "李四",
            groupChatId: CHAT,
            groupSenderOpenId: "ou_li_si",
            feishuMessageId: QUESTION_MSG,
            ...meta,
          },
          ...(runTag ? { restrictedRunTag: runTag } : {}),
        },
      );

    beforeEach(() => {
      mockFetchRoster.mockReset().mockResolvedValue({
        chatId: CHAT,
        members: memberList,
        fetchedAt: Date.now(),
        source: "api",
      });
      mockFetchHistory.mockReset().mockResolvedValue(historyList);
      mockIdentity
        .mockReset()
        .mockResolvedValue({ appId: "cli_x", openId: "ou_owner", userName: "陈属主" });
      mockBotOpenId.mockReset().mockResolvedValue("ou_self_bot");
      mockBotName.mockReset().mockResolvedValue("Flowship测试机器人");
    });

    const startAndGetPrompt = async (
      id: string,
      meta: Record<string, unknown> = {},
    ): Promise<string> => {
      const bot = makeFakeAgent(`agent_ctx_${Math.random().toString(36).slice(2, 6)}`);
      mockCreate.mockResolvedValue(bot);
      watch(id);
      await injectWithCtx(id, meta);
      await waitUntil(() => bot.send.mock.calls.length === 1);
      const prompt = bot.send.mock.calls[0]?.[0] as string;
      await waitUntil(() => !!lastDone());
      return prompt;
    };

    it("段落顺序：身份 → 群里有谁 → 任务状态 → 最近聊天 → 任务背景 → 对方的话 → 回复规矩 → 边界（仍是最后一段）", async () => {
      const id = alloc();
      await seedAckedTask(id);
      const prompt = await startAndGetPrompt(id);

      // 身份一句话换成「宿主的分身」
      expect(prompt).toContain("宿主（任务属主）在需求群里的分身");
      expect(prompt).not.toContain("答疑助手");

      const order = [
        "\n# 你是谁、群里有谁",
        "\n# 任务当前状态（快照；要细节再去读下面的文件）",
        "\n# 群里最近的聊天（旧→新）",
        "\n# 任务背景（按需查、先查再答）",
        "\n# 对方的话",
        "\n# 回复规矩",
        "\n# 边界",
      ].map((h) => prompt.indexOf(h));
      expect(order.every((i) => i > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      // 「边界」后面不许再跟任何 `# ` 段；三条红线原样 + 追加的「转属主」一句
      const boundaryAt = prompt.lastIndexOf("\n# 边界");
      const boundary = prompt.slice(boundaryAt + 1);
      expect(boundary).not.toMatch(/\n# /);
      expect(boundary).toContain("非属主答疑，三条红线");
      expect(boundary).toContain("答完自然结束回复");
      expect(boundary).toContain("需属主确认");
    });

    it("内容：roster（名字 + 真人/机器人 + 宿主/本轮对话方）、任务快照、最近聊天（排除本轮问题自己）", async () => {
      const id = alloc();
      await seedAckedTask(id);
      const prompt = await startAndGetPrompt(id);

      // roster
      expect(prompt).toContain("陈属主（真人、宿主）");
      expect(prompt).toContain("李四（真人、本轮对话方）");
      expect(prompt).toContain("安若流年（机器人）");
      expect(prompt).toContain("Flowship测试机器人（机器人、你自己）");
      expect(prompt).toContain("可能是其它团队自研的");
      // 任务快照：标题 / 当前 action 与状态
      expect(prompt).toContain("任务：「登录优化」");
      expect(prompt).toContain("当前阶段：#1 出方案（已交卷、等属主审阅");
      // 最近聊天：李安那句（没 @ 本机 bot，只有这里看得到）在；本轮问题自己被排除
      expect(prompt).toContain("[16:29] 李安：口径你看着办吧");
      expect(prompt).not.toContain("这条是本轮问题自己");
      // 回复规矩（真人提问人版本）
      expect(prompt).toContain("NO_REPLY");
      expect(prompt).toContain("提问方是真人");
    });

    it("提问人是机器人 → roster 标机器人、回复规矩走机器人版", async () => {
      const id = alloc();
      await seedAckedTask(id);
      const prompt = await startAndGetPrompt(id, {
        groupSender: "安若流年",
        groupSenderOpenId: "ou_otherbot1",
        groupSenderIsBot: true,
      });

      expect(prompt).toContain("安若流年（机器人、本轮对话方）");
      expect(prompt).toContain("提问方是机器人");
      expect(prompt).not.toContain("提问方是真人");
    });

    it("任务状态快照带上：等属主确认的提问 / 在等群里谁回话", async () => {
      const id = alloc();
      await seedAckedTask(id);
      registerPendingAsk(id, {
        askId: "ask_ctx_1",
        questions: [{ id: "q1", question: "学号口径用 A 还是 B？", allowText: true }],
      });
      const reg = registerOutboundQuestion({
        taskId: id,
        chatId: CHAT,
        messageId: "om_out_1",
        target: "ou_otherbot1",
        about: "学号字段口径",
      });
      expect(reg.ok).toBe(true);
      try {
        const prompt = await startAndGetPrompt(id);
        expect(prompt).toContain("正在等属主确认的提问：学号口径用 A 还是 B？");
        expect(prompt).toContain("任务在群里等 安若流年 回话（学号字段口径）");
      } finally {
        clearPendingAsk(id);
        clearCorrelatedEntries(id);
      }
    });

    it("拉取全挂（roster / 历史 / 身份都永不返回）→ 整体最多等 3 秒就起 agent，段落降级、不抛错", async () => {
      const id = alloc();
      await seedAckedTask(id);
      const never = () => new Promise<never>(() => {});
      mockFetchRoster.mockReset().mockImplementation(never);
      mockFetchHistory.mockReset().mockImplementation(never);
      mockIdentity.mockReset().mockImplementation(never);
      mockBotOpenId.mockReset().mockImplementation(never);
      mockBotName.mockReset().mockImplementation(never);

      const t0 = Date.now();
      const prompt = await startAndGetPrompt(id);
      const elapsed = Date.now() - t0;

      // 并行起跑、各自 3 秒硬超时 → 总共 ≈3 秒，绝不是 5 项叠加
      expect(elapsed).toBeGreaterThanOrEqual(2800);
      expect(elapsed).toBeLessThan(4800);
      expect(prompt).toContain("群成员名单暂时拿不到");
      expect(prompt).toContain("本轮对话方：「李四」"); // 本轮对话方仍在（来自入向 meta，不依赖拉取）
      expect(prompt).not.toContain("\n# 群里最近的聊天");
      // 任务快照是本地数据，不受影响
      expect(prompt).toContain("任务：「登录优化」");
      expect(prompt.slice(prompt.lastIndexOf("\n# 边界") + 1)).not.toMatch(/\n# /);
    }, 10_000);

    it("拉取抛错 → 同样降级、agent 照常起", async () => {
      const id = alloc();
      await seedAckedTask(id);
      mockFetchRoster.mockReset().mockRejectedValue(new Error("lark 挂了"));
      mockFetchHistory.mockReset().mockRejectedValue(new Error("lark 挂了"));
      mockIdentity.mockReset().mockRejectedValue(new Error("lark 挂了"));

      const prompt = await startAndGetPrompt(id);

      expect(prompt).toContain("群成员名单暂时拿不到");
      expect(prompt).not.toContain("\n# 群里最近的聊天");
      expect(lastDone()?.ok).toBe(true);
    });

    it("meta 里没有 groupChatId → 不带群上下文：prompt 与旧版一致、不去拉任何东西", async () => {
      const id = alloc();
      await seedAckedTask(id);
      const bot = makeFakeAgent("agent_ctx_none");
      mockCreate.mockResolvedValue(bot);
      watch(id);
      await injectGroupQuestion(id);
      await waitUntil(() => bot.send.mock.calls.length === 1);
      const prompt = bot.send.mock.calls[0]?.[0] as string;

      expect(prompt).toContain("答疑助手");
      expect(prompt).not.toContain("# 你是谁、群里有谁");
      expect(prompt).not.toContain("# 回复规矩");
      expect(prompt).not.toContain("需属主确认");
      expect(mockFetchRoster).not.toHaveBeenCalled();
      expect(mockFetchHistory).not.toHaveBeenCalled();
      await waitUntil(() => !!lastDone());
    });

    it("答疑 run 的每一类事件落盘都带 meta.groupRun（含 thinking / tool_call / tool_result / assistant_message / info / error）", async () => {
      const id = alloc();
      await seedAckedTask(id);
      const close = vi.fn();
      const wait = vi.fn().mockResolvedValue({ status: "finished" as const });
      const bot = {
        agentId: "agent_ctx_events",
        close,
        wait,
        cancel: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({
          stream: async function* () {
            yield { type: "thinking", text: "先看看产物" };
            yield {
              type: "tool_call",
              call_id: "c1",
              name: "read",
              status: "running",
              args: { path: "/tmp/x.md" },
            };
            yield {
              type: "tool_call",
              call_id: "c1",
              name: "read",
              status: "completed",
              args: { path: "/tmp/x.md" },
              result: "ok",
            };
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "已经定了" }] },
            };
          },
          wait,
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      };
      mockCreate.mockResolvedValue(bot);
      watch(id);
      await injectWithCtx(id, {}, "tag-ctx-1");
      await waitUntil(() => !!lastDone());

      const events = await readEvents(id);
      const byKind = (k: string) => events.filter((e) => e.kind === k);
      for (const kind of ["thinking", "tool_call", "tool_result", "assistant_message"]) {
        const list = byKind(kind);
        expect(list.length, `缺 ${kind} 事件`).toBeGreaterThan(0);
        for (const e of list) expect(e.meta?.groupRun, `${kind}`).toBe("tag-ctx-1");
      }
      // run 自己写的 info（准备工作区 / 启动 agent）也要打标；
      // 注入链「受理即可见」那条（未带 origin、发生在 run 之前）不打
      const runInfos = byKind("info").filter((e) => e.text.startsWith("群答疑："));
      expect(runInfos.length).toBeGreaterThan(0);
      for (const e of runInfos) expect(e.meta?.groupRun).toBe("tag-ctx-1");
      const acceptInfo = byKind("info").find((e) => e.text.includes("正在启动答疑 agent（群里"));
      expect(acceptInfo?.meta?.groupRun).toBeUndefined();
    });

    it("失败路径的 error 事件同样带 groupRun", async () => {
      const id = alloc();
      await seedAckedTask(id);
      mockCreate.mockRejectedValue(new Error("boom-create"));
      watch(id);
      await injectWithCtx(id, {}, "tag-ctx-err");
      await waitUntil(() => !!lastDone());

      const errs = (await readEvents(id)).filter((e) => e.kind === "error");
      expect(errs.length).toBeGreaterThan(0);
      for (const e of errs) expect(e.meta?.groupRun).toBe("tag-ctx-err");
    });
  });

  it("buildRestrictedGroupContext：meta → groupContext；缺 chatId 不传", () => {
    expect(buildRestrictedGroupContext(undefined)).toBeUndefined();
    expect(buildRestrictedGroupContext({ source: "feishu_group" })).toBeUndefined();
    expect(
      buildRestrictedGroupContext({
        groupChatId: "oc_1",
        groupSenderOpenId: "ou_a",
        groupSender: "李四",
        groupSenderIsBot: true,
        feishuMessageId: "om_q",
      }),
    ).toEqual({
      chatId: "oc_1",
      requester: { openId: "ou_a", name: "李四", isBot: true },
      questionMessageId: "om_q",
    });
    // 真人（groupSenderIsBot 缺省）+ 没有 message id
    expect(
      buildRestrictedGroupContext({ groupChatId: "oc_1", groupSender: "王五" }),
    ).toEqual({
      chatId: "oc_1",
      requester: { openId: "", name: "王五", isBot: false },
    });
  });
});
