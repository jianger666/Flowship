/**
 * ask_user accepted 后软停 stream（防 Please continue 续跑）回归
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ask-soft-stop-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: vi.fn(),
  },
}));

vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T,>(servers: T) => servers,
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

const { readMetaV06, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  runningTasks,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { clearFailpoints } = await import("@/lib/server/failpoints");
const {
  cleanupChatTaskState,
  getPendingAsk,
  registerPendingAsk,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { buildSessionBridges, resumeCurrentActionWithMessage } = await import(
  "@/lib/server/task-runner"
);
const { getTask, setTaskRunStatus } = await import("@/lib/server/task-fs");

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
  fallbackModel: { id: "m", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ask-soft-stop ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const seedRunningAction = async (id: string): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus = "running";
  meta.currentActionId = "act_ask";
  meta.actions = [
    {
      id: "act_ask",
      n: 1,
      type: "plan",
      status: "running",
      userInstruction: "",
      artifactPath: null,
      startedAt: Date.now(),
      endedAt: null,
    },
  ] as TaskMetaV06["actions"];
  await writeMeta(meta);
};

const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(r));

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

describe("ask soft stop", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_ask_soft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    clearFailpoints();
  });

  afterEach(async () => {
    clearFailpoints();
    for (const id of ids.splice(0)) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      clearTaskStarting(id);
      cleanupChatTaskState(id);
      try {
        rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });

  it("awaitingNotifier accepted 后 queueMicrotask 调 softCancelStream", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    const callerToken = String(allocTaskRunInstanceId());
    const bridges = buildSessionBridges(task, { callerToken });
    setChatTaskActionHandler(id, bridges.taskActionHandler, callerToken);
    setChatAwaitingNotifier(id, bridges.awaitingNotifier, callerToken);

    const softCancel = vi.fn();
    runningTasks.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agentId: "agent_ask",
      startedAt: Date.now(),
      startSnapshot: { title: task.title },
      cancel: vi.fn(),
      softCancelStream: softCancel,
    });

    registerPendingAsk(id, {
      askId: "ask_soft_1",
      questions: [{ question: "Q?" }] as never,
    });

    const outcome = await bridges.awaitingNotifier(
      {
        kind: "ask_user_request",
        askId: "ask_soft_1",
        token: "tok_1",
        questions: [{ question: "Q?" }] as never,
      } as never,
      { callerStillValid: () => true },
    );

    expect(outcome).toBe("accepted");
    await flushMicrotasks();
    expect(softCancel).toHaveBeenCalledTimes(1);
    expect(getPendingAsk(id)?.askId).toBe("ask_soft_1");
  });

  it("consume cancelled + pendingAsk → 不 finalize action、不关 session、保持 awaiting_user", async () => {
    const id = alloc();
    await seedRunningAction(id);

    let releaseWait!: () => void;
    const waitGate = new Promise<void>((r) => {
      releaseWait = r;
    });
    const close = vi.fn();
    const cancel = vi.fn().mockImplementation(async () => {
      releaseWait();
    });
    const send = vi.fn().mockResolvedValue({
      stream: async function* () {
        /* 空 */
      },
      wait: async () => {
        await waitGate;
        return { status: "cancelled" as const };
      },
      cancel,
    });
    mockCreate.mockResolvedValue({
      agentId: "agent_consume_ask",
      close,
      send,
    });

    const dones: unknown[] = [];
    const unsub = subscribeTaskStream(id, (ev) => {
      if (ev.kind === "done") dones.push(ev);
    });

    const p = resumeCurrentActionWithMessage({
      task: (await getTask(id))!,
      userMessage: "唤醒",
      apiKey: CREDS.apiKey,
      fallbackModel: CREDS.fallbackModel,
    });

    await waitUntil(() => runningTasks.has(id));
    registerPendingAsk(id, {
      askId: "ask_cancel_soft",
      questions: [{ question: "等答?" }] as never,
    });
    await setTaskRunStatus(id, "awaiting_user", "act_ask");

    runningTasks.get(id)?.softCancelStream?.();
    await p;
    await sleep(50);
    unsub();

    const fresh = await readMetaV06(id);
    expect(fresh?.runStatus).toBe("awaiting_user");
    expect(fresh?.actions.find((a) => a.id === "act_ask")?.status).toBe(
      "running",
    );
    expect(close).not.toHaveBeenCalled();
    expect(getPendingAsk(id)?.askId).toBe("ask_cancel_soft");
    expect(dones).toHaveLength(1);
    expect((dones[0] as { ok?: boolean }).ok).toBe(true);
  });
});
