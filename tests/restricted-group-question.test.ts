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
 * 2. **prompt 真只读**：只有硬约束，一句允许改动的措辞都不注入（含 user_message 封装尾巴）。
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
const { handleTaskQuestionInject } = await import(
  "@/lib/server/task-question-inject"
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
  // 2. 受限 prompt 真只读（user_message 封装那段尾巴会让指令自相矛盾）
  // ─────────────────────────────────────────────────────────────
  it("prompt 只有硬约束、一句「可以改」的措辞都不注入", async () => {
    const id = alloc();
    await seedAckedTask(id);
    installOwnerSession(id);
    const bot = makeFakeAgent("agent_group_prompt");
    mockCreate.mockResolvedValue(bot);

    watch(id);
    await injectGroupQuestion(id);
    await waitUntil(() => bot.send.mock.calls.length === 1);

    const prompt = bot.send.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("只读答疑");
    expect(prompt).toContain("禁止新建 / 修改 / 删除任何文件");
    expect(prompt).toContain("有副作用的命令");
    // 属主版那几句放行措辞 + user_message 封装那段固定行为约束，一个字都不许漏进来
    expect(prompt).not.toContain("直接改");
    expect(prompt).not.toContain("直接动手");
    expect(prompt).not.toContain("才动手");
    expect(prompt).not.toContain("动手改");
    // 交卷 / 提 MR 这类推进语义同样不该出现在只读通道
    expect(prompt).not.toContain("submit_work");
    expect(prompt).not.toContain("submit_mr");

    // 「# 边界」必须是最后一段：硬约束后面不许再跟任何别的指令段
    const boundaryAt = prompt.lastIndexOf("\n# 边界");
    expect(boundaryAt).toBeGreaterThan(prompt.lastIndexOf("\n# 对方的话"));
    expect(prompt.slice(boundaryAt + 1)).not.toMatch(/\n# /);

    // 旁路 agent 不装 chat-tool / 用户 MCP（交卷、提 MR 这些工具压根不该出现）
    const createArg = mockCreate.mock.calls[0]?.[0] as {
      mcpServers?: unknown;
      local?: { settingSources?: unknown[] };
    };
    expect(createArg.mcpServers).toBeUndefined();
    expect(createArg.local?.settingSources).toEqual([]);

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
});
