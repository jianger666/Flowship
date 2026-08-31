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
const { startOneShotQuestion } = await import("@/lib/server/task-runner");
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
  const startLikeRoute = async (id: string) => {
    const snapshot = (await getTask(id))!;
    await setTaskRunStatus(id, "running");
    seen = [];
    unsub = subscribeTaskStream(id, (ev) => seen.push(ev));
    startOneShotQuestion(snapshot, "这个接口啥时候好？", undefined, CREDS);
  };

  const lastDone = (): Extract<TaskStreamEvent, { kind: "done" }> | undefined =>
    [...seen].reverse().find((e) => e.kind === "done") as
      | Extract<TaskStreamEvent, { kind: "done" }>
      | undefined;

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

    // 一次性 agent 不挂系统 customTools / 用户 MCP（交卷、提 MR 这些工具压根不该出现）
    const createArg = mockCreate.mock.calls[0]?.[0] as {
      mcpServers?: unknown;
      callerToken?: string;
      local?: { settingSources?: unknown[]; customTools?: unknown };
    };
    expect(createArg.mcpServers).toBeUndefined();
    expect(createArg.callerToken).toBeUndefined();
    expect(createArg.local?.settingSources).toEqual([]);
    expect(createArg.local?.customTools).toBeUndefined();

    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    expect(lastDone()?.ok).toBe(true);
    expect(runningTasks.has(id)).toBe(false);
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
