/**
 * advanceTask × expectedCurrentActionId（R14 Q7a-04）：真 runner 串行队列里的 CAS
 *
 * 背景：`runAdvanceExclusive` 只把同一任务的推进「串行化」，不拦「重复提交」——
 * 页面连点两下 / 两个窗口都点了推进，第二个请求排在第一个之后出队、照样往下走：
 * 再 appendAction 一条新 action，并把刚起的第一条标成 cancelled（一次意图被执行两遍、前一遍还被误杀）。
 *
 * 修法：请求带「我点推进时看到的当前 action」，advanceTask 出队后**第一件事**读盘上最新 meta 对照，
 * 不一致 → 抛 ADVANCE_STALE_MESSAGE（专用文案，不复用「请重发」那句）；
 * 必须发生在一切副作用之前（abortRunningCheck 会掐掉上一个 action 还在跑的后置检查）。
 *
 * 真调 advanceTask（SDK 用假 agent：stream 空、wait 即 finished），落盘走 TMP 数据目录。
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

import { ADVANCE_STALE_MESSAGE } from "@/lib/server/advance-expectation";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { ActionRecord } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-advance-cas-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
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
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { taskDir, writeMeta } = taskFsCore;
const {
  clearTaskStarting,
  pendingStopRequests,
  runningChecks,
  runningTasks,
  agentSessions,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { advanceTask } = await import("@/lib/server/task-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `advance-cas-concurrent DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitUntil = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil 超时 ${ms}ms`);
};

/** 一条已完成的 plan action（当作任务的「当前 action」） */
const doneAction = (id: string): ActionRecord => ({
  id,
  n: 1,
  type: "plan",
  status: "completed",
  userInstruction: "第一轮 plan",
  artifactPath: null,
  startedAt: Date.now() - 2_000,
  endedAt: Date.now() - 1_000,
});

const makeMeta = (id: string, extras?: Partial<TaskMetaV06>): TaskMetaV06 =>
  ({
    id,
    title: `advance-cas ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    // 不绑真仓：避免 worktree / git 依赖
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extras,
  }) as unknown as TaskMetaV06;

/** 能让 consumeSessionRun 平稳走完的假 agent（stream 空、wait 即 finished） */
const makeFakeAgent = (agentId: string) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      /* 空 */
    },
    wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
    cancel,
  });
  return { agentId, close, send, cancel };
};

describe("advanceTask × expectedCurrentActionId：串行队列里的 CAS", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_adv_cas_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  const baseInput = (task: NonNullable<Awaited<ReturnType<typeof getTask>>>) => ({
    task,
    actionType: "plan" as const,
    userInstruction: "推进一下",
    apiKey: CREDS.apiKey,
    model: CREDS.model,
  });

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockCreate.mockImplementation(async () =>
      makeFakeAgent(`agent_${Math.random().toString(36).slice(2, 8)}`),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    // 后台 run 收敛后再清理，避免对已删目录落盘
    await waitUntil(() => ids.every((id) => !runningTasks.has(id)), 8000).catch(
      () => {},
    );
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      runningChecks.delete(id);
      agentSessions.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("重复提交（同一期望、并发两次）：只落一条 action，后到的被陈旧文案拒绝，先到的不被标 cancelled", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    // 两个请求拿着同一份「点推进时」的快照：当时没有当前 action
    const input = { ...baseInput(task), expectedCurrentActionId: null };

    const results = await Promise.allSettled([
      advanceTask({ ...input }),
      advanceTask({ ...input }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    )!;
    expect((rejected.reason as Error).message).toBe(
      ADVANCE_STALE_MESSAGE,
    );

    const after = (await getTask(id))!;
    // 修复前：第二个出队后照样 appendAction，这里是 2 条、且第一条被标成 cancelled
    expect(after.actions).toHaveLength(1);
    expect(after.actions[0]!.status).not.toBe("cancelled");
    // 先到的那个请求的 agent 是后台异步起的；后到的请求在出队第一步就被拒、不会再起第二个
    await waitUntil(() => mockCreate.mock.calls.length > 0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("排队期间被抢先推进（两个请求带的都是同一个旧 action id）：先到的起新 action，后到的让位", async () => {
    const id = alloc();
    await writeMeta(
      makeMeta(id, {
        currentActionId: "act_cur",
        actions: [doneAction("act_cur")],
      }),
    );
    const task = (await getTask(id))!;
    const input = { ...baseInput(task), expectedCurrentActionId: "act_cur" };

    const results = await Promise.allSettled([
      advanceTask({ ...input }),
      advanceTask({ ...input }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    )!;
    expect((rejected.reason as Error).message).toBe(
      ADVANCE_STALE_MESSAGE,
    );

    const after = (await getTask(id))!;
    // 旧的 + 先到的新起的 = 2 条；后到的没有再追加，先到的也没被取消
    expect(after.actions).toHaveLength(2);
    const fresh = after.actions.find((a) => a.id !== "act_cur")!;
    expect(fresh.status).not.toBe("cancelled");
    expect(after.currentActionId).toBe(fresh.id);
  });

  it("【对照】没带期望（飞书群路径 / 老客户端）：不做 CAS，后到的请求不会被陈旧文案拒绝", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    const input = baseInput(task);

    const results = await Promise.allSettled([
      advanceTask({ ...input }),
      advanceTask({ ...input }),
    ]);

    // 旧行为保留（这条只钉「没带 = 不校验」，不为旧的重复执行语义背书）
    for (const r of results) {
      if (r.status === "rejected") {
        expect((r.reason as Error).message).not.toBe(
          ADVANCE_STALE_MESSAGE,
        );
      }
    }
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });

  it("期望与盘上当前 action 不符（页面陈旧）：让位，且零副作用——不起 agent、不动 action、不掐上一个 action 还在跑的后置检查", async () => {
    const id = alloc();
    await writeMeta(
      makeMeta(id, {
        currentActionId: "act_cur",
        actions: [doneAction("act_cur")],
      }),
    );
    const task = (await getTask(id))!;
    // 上一个 action 的后置检查还在后台跑
    const controller = new AbortController();
    const entry = { actionId: "act_cur", controller };
    runningChecks.set(id, entry);

    await expect(
      advanceTask({ ...baseInput(task), expectedCurrentActionId: "act_old" }),
    ).rejects.toThrow(ADVANCE_STALE_MESSAGE);

    // 没有任何副作用
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(runningChecks.get(id)).toBe(entry);
    const after = (await getTask(id))!;
    expect(after.actions).toHaveLength(1);
    expect(after.actions[0]!.status).toBe("completed");
    expect(after.currentActionId).toBe("act_cur");
    expect(after.runStatus).toBe("idle");
  });

  it("【对照】期望与盘上一致：照常推进，并且会掐掉上一个 action 还在跑的后置检查（CAS 在 abortRunningCheck 之前）", async () => {
    const id = alloc();
    await writeMeta(
      makeMeta(id, {
        currentActionId: "act_cur",
        actions: [doneAction("act_cur")],
      }),
    );
    const task = (await getTask(id))!;
    const controller = new AbortController();
    runningChecks.set(id, { actionId: "act_cur", controller });

    const { action } = await advanceTask({
      ...baseInput(task),
      expectedCurrentActionId: "act_cur",
    });

    expect(action.id).not.toBe("act_cur");
    expect(controller.signal.aborted).toBe(true);
    const after = (await getTask(id))!;
    expect(after.actions).toHaveLength(2);
  });

  it("读的是盘上最新 meta、不是入场快照：快照里还是旧 action、盘上已被别人推进 → 让位", async () => {
    const id = alloc();
    await writeMeta(
      makeMeta(id, {
        currentActionId: "act_cur",
        actions: [doneAction("act_cur")],
      }),
    );
    const staleSnapshot = (await getTask(id))!; // 快照：当前 action = act_cur
    // 快照之后另一个请求已经把任务推进到了 act_next
    await writeMeta(
      makeMeta(id, {
        currentActionId: "act_next",
        actions: [doneAction("act_cur"), { ...doneAction("act_next"), n: 2 }],
      }),
    );

    await expect(
      advanceTask({
        ...baseInput(staleSnapshot),
        expectedCurrentActionId: "act_cur",
      }),
    ).rejects.toThrow(ADVANCE_STALE_MESSAGE);
    expect(mockCreate).not.toHaveBeenCalled();
    expect((await getTask(id))!.actions).toHaveLength(2);
  });

  it("任务已被删（盘上读不到 meta）：按「已变更」让位，不是 TypeError 崩", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    await fs.rm(taskDir(id), { recursive: true, force: true });

    await expect(
      advanceTask({ ...baseInput(task), expectedCurrentActionId: null }),
    ).rejects.toThrow(ADVANCE_STALE_MESSAGE);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
