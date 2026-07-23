/**
 * V1 / V2 / W1–W3 / X1–X3 / R18-1～3：task operation generation + 串行启动 + run owner 门控
 *
 * W1：进程单调 token、DELETE 后保留 tombstone（旧 snap=0 恒 stale）
 * W2：admission 在进串行队列前捕获——S2 排队后 stop，出队不得 send
 * W3：stale one-shot 不写 runStatus——后继 B 的 running 不被覆盖
 * X1：send 返 "stale"（非 false）——调用方不得当无会话 fallback
 * X2：one-shot create 占串行链时，后继 runWithTaskSendSerial 不得并行执行
 * X3：forceClear 后旧 cancelled 收尾不得 finalize 后继 B 的 action
 * R18-1：op-fresh / run-owner 锁内条件事务（task-fs helpers）
 * R18-2：前驱 cancelled 只 patch 自己 action；fork handoff；restore 按 owner
 * R18-3：session.instanceId 贯穿 close；同 agentId resume 不误关 B
 * R19-1：opFresh + 结构条件（currentActionId / actionStatus）——同 epoch 并发 advance 不抢回
 * R19-2：handleRunFailure 启动失败门控——currentActionId 已是 B 时不写 task error
 * R19-3→R20-3：prepare/复查/commit——prepare 挂起期间换主，meta.json 从未出现新值
 * R19-4：closeTaskSession fail-closed——无精确实例号不关 B、不清锚点
 * R20-1：同 action 双启动 + startToken——旧失败不伤共用 action / task 状态
 * R20-4：失去 owner 不发 task 级 done(false)/error envelope
 *
 * 取舍：/question route 级 deferred（mock 存图）成本高——X1 在 runner 层钉
 * deliverAskReply/"stale" + isTaskOpStale 复查契约；X2 在串行链互斥层钉。
 * R18-2 全量 advanceTask 调用链 mock 面过大——在 consumeSessionRun 层经
 * deliverAskReply 钉「只 patch 自己 action + fork 让位 + 同 agentId 不误关」。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-op-gen-"));
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
// R21-1 全链测试要走 internalStartAgent 的 prompt 素材段——meegle CLI 探测在测试环境
// 可能慢/挂，mock 成秒回空串（task-runner / chat-runner 只用这一个导出）
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));
vi.mock("@/lib/server/chat-pending", () => ({
  cleanupChatTaskState: vi.fn(),
  invalidateCallerToken: vi.fn(),
  buildAgentMessage: (opts: { text: string }) => opts.text,
  cancelPending: vi.fn(),
  getPendingAsk: vi.fn(),
  setChatAwaitingNotifier: vi.fn(),
  setChatTaskActionHandler: vi.fn(),
  unsetChatAwaitingNotifierIf: vi.fn(),
  unsetChatTaskActionHandlerIf: vi.fn(),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  beginTaskStarting,
  claimTaskOp,
  clearTaskStarting,
  endTaskStarting,
  forceClearStaleRunnerState,
  getTaskOpGeneration,
  isTaskOpCurrent,
  isTaskStarting,
  pendingStopRequests,
  revokeTaskOps,
  runningTasks,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { getPendingAsk } = await import("@/lib/server/chat-pending");
const { clearChatGate, endChatLifecycle, getChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const {
  closeTaskSession,
  deliverAskReply,
  handleRunFailure,
  isTaskOpStale,
  resumeCurrentActionWithMessage,
  runWithTaskSendSerial,
  startOneShotQuestion,
} = await import("@/lib/server/task-runner");
const {
  setTaskRunStatus,
  getTask,
  setTaskRunStatusIfCurrentAction,
  patchActionAndRunStatusIfOpFresh,
  setTaskRunStatusIfRunOwner,
} = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `task-op-generation DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `op-gen ${id}`,
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

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

const makePendingCreateAgent = (agentId: string) => {
  let resolveCreate!: (agent: unknown) => void;
  const gate = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  const close = vi.fn();
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      /* 空 */
    },
    wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
  });
  const agent = { agentId, close, send };
  mockCreate.mockImplementation(() => gate.then(() => agent));
  return {
    releaseCreate: () => resolveCreate(agent),
    close,
    send,
    agentId,
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("V1/V2/W1–W3 taskOpGenerations + startingTasks + one-shot", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_opgen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(async () => {
    mockCreate.mockReset();
  });

  afterEach(async () => {
    // 先清进程态、等一拍再 rm：用例里 close 路径的 `void setTaskSessionAgentId`
    // 是 fire-and-forget 落盘，立刻删目录会撞出 ENOENT unhandled rejection
    //（同 chat-runner 系测试的既定手法）
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      // W1：不再 clear generation（tombstone 有意保留）；测完只清其它进程态
      clearChatGate(id);
      endChatLifecycle(id);
    }
    await new Promise((r) => setTimeout(r, 30));
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  describe("协议层（W1）", () => {
    it("snap=0 → bump → 模拟 DELETE 完成（不 clear）→ 旧 snap 恒 stale；两次 bump 严格递增", () => {
      const id = alloc();
      expect(getTaskOpGeneration(id)).toBe(0);
      const snap = getTaskOpGeneration(id); // 0
      revokeTaskOps(id);
      const afterFirst = getTaskOpGeneration(id);
      expect(afterFirst).toBeGreaterThan(0);
      expect(afterFirst).not.toBe(snap);
      // W1：DELETE 成功后不再 clear——tombstone 保留，旧 snap 永远 stale
      expect(isTaskOpStale(id, snap)).toBe(true);
      revokeTaskOps(id);
      const afterSecond = getTaskOpGeneration(id);
      expect(afterSecond).toBeGreaterThan(afterFirst);
      expect(afterSecond).not.toBe(afterFirst);
      expect(isTaskOpStale(id, snap)).toBe(true);
      expect(isTaskOpStale(id, afterFirst)).toBe(true);
    });

    it("startingTasks refcount：两次 begin、一次 end 后仍 isTaskStarting", () => {
      const id = alloc();
      beginTaskStarting(id);
      beginTaskStarting(id);
      endTaskStarting(id);
      expect(isTaskStarting(id)).toBe(true);
      endTaskStarting(id);
      expect(isTaskStarting(id)).toBe(false);
    });

    it("stopTaskAgent 会 bump generation（进程单调、≠ 入场快照）", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      const before = getTaskOpGeneration(id);
      await stopTaskAgent(asTask(makeMeta(id)));
      const after = getTaskOpGeneration(id);
      expect(after).not.toBe(before);
      expect(after).toBeGreaterThan(0);
      expect(getChatLifecycle(id)).toBeNull();
      expect(isTaskOpStale(id, before)).toBe(true);
    });
  });

  describe("startOneShotQuestion（W3）", () => {
    it("create 挂起 → stop → B 置 running → resolve → 不 send、close、B 的 running 不被覆盖", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      await setTaskRunStatus(id, "running");
      const { releaseCreate, close, send } = makePendingCreateAgent(
        "agent_oneshot_w3",
      );

      const task = (await getTask(id))!;
      startOneShotQuestion(task, "这是什么？", undefined, {
        apiKey: "k",
        model: { id: "m", params: [] as never[] },
      });

      const deadline = Date.now() + 5000;
      while (mockCreate.mock.calls.length === 0 && Date.now() < deadline) {
        await sleep(20);
      }
      expect(mockCreate).toHaveBeenCalled();
      expect(isTaskStarting(id)).toBe(true);

      await stopTaskAgent(task);
      // 后继 B 已接管并置 running（W3 时序）
      await setTaskRunStatus(id, "running");
      expect((await readMetaV06(id))?.runStatus).toBe("running");

      releaseCreate();

      const doneDeadline = Date.now() + 5000;
      while (isTaskStarting(id) && Date.now() < doneDeadline) {
        await sleep(30);
      }
      expect(isTaskStarting(id)).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();

      // W3：旧 one-shot 不得把 B 打回 idle
      const fresh = await readMetaV06(id);
      expect(fresh?.runStatus).toBe("running");
    });
  });

  describe("send 串行化 + W2 deferred", () => {
    it("第二个 fn 在第一个 resolve 前永不执行", async () => {
      const id = alloc();
      let release1!: () => void;
      const gate1 = new Promise<void>((r) => {
        release1 = r;
      });
      let secondStarted = false;
      const order: string[] = [];

      const p1 = runWithTaskSendSerial(id, async () => {
        order.push("1-enter");
        await gate1;
        order.push("1-exit");
        return "a";
      });
      const p2 = runWithTaskSendSerial(id, async () => {
        secondStarted = true;
        order.push("2");
        return "b";
      });

      await sleep(20);
      expect(secondStarted).toBe(false);
      expect(order).toEqual(["1-enter"]);

      release1();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe("a");
      expect(r2).toBe("b");
      expect(order).toEqual(["1-enter", "1-exit", "2"]);
      expect(secondStarted).toBe(true);
    });

    it("W2：S1 send 挂起、S2 已排队 → stop → 放行 S1 → S2 不得 send、不注册 runningTasks", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      const task = (await getTask(id))!;

      let resolveSend!: (run: unknown) => void;
      const sendGate = new Promise((resolve) => {
        resolveSend = resolve;
      });
      const send = vi.fn().mockImplementation(() => sendGate);
      const close = vi.fn();
      const mockRun = {
        stream: async function* () {
          /* 空 */
        },
        wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: { agentId: "agent_w2_send", send, close },
        agentId: "agent_w2_send",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: task.title },
      });

      const creds = {
        apiKey: "k",
        model: { id: "m", params: [] as never[] },
      };
      const p1 = deliverAskReply(task, "s1", undefined, undefined, creds);

      const sendDeadline = Date.now() + 5000;
      while (send.mock.calls.length === 0 && Date.now() < sendDeadline) {
        await sleep(20);
      }
      expect(send).toHaveBeenCalledTimes(1);

      // S2 入队（同步 chain），尚未执行 body
      const p2 = deliverAskReply(task, "s2", undefined, undefined, creds);
      await sleep(30);
      expect(send).toHaveBeenCalledTimes(1);

      await stopTaskAgent(task);
      resolveSend(mockRun);

      const [r1, r2] = await Promise.all([p1, p2]);
      // X1：stale 显式返 "stale"；S2 不得再 send
      expect(r1).toBe("stale");
      expect(r2).toBe("stale");
      expect(send).toHaveBeenCalledTimes(1);
      expect(runningTasks.has(id)).toBe(false);
    });
  });

  describe("X1 send 结构化返回", () => {
    it("入场 opGen 被 bump 后 deliverAskReply 返 stale、不调 agent.send", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      const task = (await getTask(id))!;
      const send = vi.fn();
      const close = vi.fn();
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: { agentId: "agent_x1", send, close },
        agentId: "agent_x1",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: task.title },
      });
      const opGen = getTaskOpGeneration(id);
      revokeTaskOps(id);
      const result = await deliverAskReply(
        task,
        "answer",
        undefined,
        undefined,
        { apiKey: "k", model: { id: "m", params: [] as never[] } },
        opGen,
      );
      expect(result).toBe("stale");
      expect(send).not.toHaveBeenCalled();
      expect(isTaskOpStale(id, opGen)).toBe(true);
    });
  });

  describe("X2 串行链互斥（one-shot 受理占链）", () => {
    it("one-shot Agent.create 挂起时，第二个 runWithTaskSendSerial 不执行直到放行", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      await setTaskRunStatus(id, "running");
      const { releaseCreate, send } = makePendingCreateAgent("agent_x2_oneshot");

      const task = (await getTask(id))!;
      startOneShotQuestion(task, "问啥？", undefined, {
        apiKey: "k",
        model: { id: "m", params: [] as never[] },
      });

      const createDeadline = Date.now() + 5000;
      while (mockCreate.mock.calls.length === 0 && Date.now() < createDeadline) {
        await sleep(20);
      }
      expect(mockCreate).toHaveBeenCalledTimes(1);

      let secondEntered = false;
      const p2 = runWithTaskSendSerial(id, async () => {
        secondEntered = true;
        return "advance-admit";
      });
      await sleep(40);
      // X2：one-shot 仍占 create→send 受理链，advance 侧不得进入
      expect(secondEntered).toBe(false);
      expect(send).not.toHaveBeenCalled();

      releaseCreate();
      // create 返回后 one-shot 会 send（mock 立即 resolve）并出链
      const r2 = await p2;
      expect(r2).toBe("advance-admit");
      expect(secondEntered).toBe(true);

      const doneDeadline = Date.now() + 5000;
      while (isTaskStarting(id) && Date.now() < doneDeadline) {
        await sleep(30);
      }
    });
  });

  describe("X3 forceClear 后旧 cancelled 不得伤 B", () => {
    it("A wait 挂起 → 强清 → B 登记 → 放行 A cancelled → B action/runStatus/runningTasks 完好", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_a";
      meta.actions = [
        {
          id: "act_a",
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

      let resolveWait!: (v: { status: "cancelled" }) => void;
      const waitGate = new Promise<{ status: "cancelled" }>((r) => {
        resolveWait = r;
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空流，立刻进 wait */
        },
        wait: () => waitGate,
        cancel,
      });
      const close = vi.fn();
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: { agentId: "agent_a", send, close },
        agentId: "agent_a",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      });

      const task = (await getTask(id))!;
      // 启动 A 的 consume（send 立即 resolve、挂在 wait）
      const pA = deliverAskReply(
        task,
        "s1",
        undefined,
        "act_a",
        { apiKey: "k", model: { id: "m", params: [] as never[] } },
      );
      const sendDeadline = Date.now() + 5000;
      while (send.mock.calls.length === 0 && Date.now() < sendDeadline) {
        await sleep(20);
      }
      expect(send).toHaveBeenCalledTimes(1);
      // 等 consume 登记 runningTasks
      const regDeadline = Date.now() + 5000;
      while (!runningTasks.has(id) && Date.now() < regDeadline) {
        await sleep(20);
      }
      const aRec = runningTasks.get(id)!;
      expect(aRec.agentId).toBe("agent_a");
      expect(typeof aRec.instanceId).toBe("number");

      // 模拟 stop：cancel + 超 5s 强清
      aRec.cancel();
      forceClearStaleRunnerState(id);
      expect(runningTasks.has(id)).toBe(false);

      // B 接管：新 action + 新 runningTasks record + 新会话
      meta.actions = [
        ...meta.actions!,
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      meta.currentActionId = "act_b";
      // act_a 仍 running 会被 finalize 误伤——保持 running 以验证 X3
      await writeMeta(meta);
      await setTaskRunStatus(id, "running", "act_b");

      const bInstanceId = allocTaskRunInstanceId();
      const bCancel = vi.fn();
      runningTasks.set(id, {
        instanceId: bInstanceId,
        agentId: "agent_b",
        startedAt: Date.now(),
        startSnapshot: { title: meta.title },
        cancel: bCancel,
      });
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: {
          agentId: "agent_b",
          send: vi.fn(),
          close: vi.fn(),
        },
        agentId: "agent_b",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      });

      // deliverAskReply 在 send 受理后即 resolve；consume 仍挂在 wait
      await expect(pA).resolves.toBe("sent");
      // 放行 A 的 cancelled 收尾，等 consume 让位退出
      resolveWait({ status: "cancelled" });
      const settleDeadline = Date.now() + 5000;
      while (Date.now() < settleDeadline) {
        // B 的 record 仍在且未被旧 finally 删掉即视为收尾完成
        if (runningTasks.get(id)?.instanceId === bInstanceId) break;
        await sleep(20);
      }
      await sleep(50);

      // X3 断言：B 完好
      expect(runningTasks.get(id)?.instanceId).toBe(bInstanceId);
      expect(runningTasks.get(id)?.agentId).toBe("agent_b");
      expect(agentSessions.get(id)?.agentId).toBe("agent_b");
      const fresh = await readMetaV06(id);
      expect(fresh?.runStatus).toBe("running");
      expect(fresh?.currentActionId).toBe("act_b");
      const actB = fresh?.actions.find((a) => a.id === "act_b");
      expect(actB?.status).toBe("running");
      // act_a 也不该被旧 A 的 finalize 打成 cancelled（B 接管后旧 owner 应让位）
      const actA = fresh?.actions.find((a) => a.id === "act_a");
      expect(actA?.status).toBe("running");
      expect(bCancel).not.toHaveBeenCalled();
    });
  });

  describe("R18-1 / R19-1 op-fresh / run-owner 条件事务", () => {
    it("patchActionAndRunStatusIfOpFresh：isFresh=false 时一把都不写", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "idle";
      meta.currentActionId = "act_1";
      meta.actions = [
        {
          id: "act_1",
          n: 1,
          type: "plan",
          status: "awaiting_ack",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);
      const skipped = await patchActionAndRunStatusIfOpFresh(
        id,
        "act_1",
        "running",
        "running",
        () => false,
      );
      expect(skipped).toBeNull();
      const fresh = await readMetaV06(id);
      expect(fresh?.runStatus).toBe("idle");
      expect(fresh?.actions[0]?.status).toBe("awaiting_ack");
    });

    it("R19-1：isFresh=true 但 currentActionId 已变 → 不写", async () => {
      // 同 epoch 并发 advance：A 已 completed、指针到 B；旧 Q 的 isFresh 仍 true
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_b";
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "completed",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);
      const skipped = await patchActionAndRunStatusIfOpFresh(
        id,
        "act_a",
        "running",
        "running",
        () => true,
        { currentActionId: "act_a", actionStatus: "awaiting_ack" },
      );
      expect(skipped).toBeNull();
      const fresh = await readMetaV06(id);
      expect(fresh?.currentActionId).toBe("act_b");
      expect(fresh?.runStatus).toBe("running");
      expect(fresh?.actions.find((a) => a.id === "act_a")?.status).toBe(
        "completed",
      );
      expect(fresh?.actions.find((a) => a.id === "act_b")?.status).toBe(
        "running",
      );
    });

    it("R19-1：isFresh=true 但 action 已 completed → 不写", async () => {
      // currentActionId 仍指 A，但 advance 已把 A 标 completed（指针尚未推到 B 的窗口）
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "idle";
      meta.currentActionId = "act_a";
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "completed",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);
      const skipped = await patchActionAndRunStatusIfOpFresh(
        id,
        "act_a",
        "running",
        "running",
        () => true,
        { currentActionId: "act_a", actionStatus: "awaiting_ack" },
      );
      expect(skipped).toBeNull();
      const fresh = await readMetaV06(id);
      expect(fresh?.runStatus).toBe("idle");
      expect(fresh?.actions[0]?.status).toBe("completed");
    });

    it("setTaskRunStatusIfRunOwner：同 action 指针下非 owner 不写 idle", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_same";
      meta.actions = [
        {
          id: "act_same",
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
      // 模拟 B 已接管（同 currentActionId）——旧 Q 的 isOwner 失败
      const skipped = await setTaskRunStatusIfRunOwner(
        id,
        "idle",
        () => false,
      );
      expect(skipped).toBeNull();
      expect((await readMetaV06(id))?.runStatus).toBe("running");
    });
  });

  describe("R18-2 前驱收尾不伤后继 action", () => {
    it("A 仍是 owner 时 cancelled → 只 patch act_a，盘上已有的 act_b 保持 running", async () => {
      // 时序：B 已 append act_b 但尚未换 runningTasks（或 A 收尾跑在换主之前）
      // 旧代码 finalizeStaleActions 全表扫会把 act_b 一并 cancelled
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_a";
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);

      let resolveWait!: (v: { status: "cancelled" }) => void;
      const waitGate = new Promise<{ status: "cancelled" }>((r) => {
        resolveWait = r;
      });
      const send = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空流 */
        },
        wait: () => waitGate,
        cancel: vi.fn().mockResolvedValue(undefined),
      });
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: { agentId: "agent_a", send, close: vi.fn() },
        agentId: "agent_a",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      });

      const task = (await getTask(id))!;
      const pA = deliverAskReply(
        task,
        "s1",
        undefined,
        "act_a",
        { apiKey: "k", model: { id: "m", params: [] as never[] } },
      );
      const regDeadline = Date.now() + 5000;
      while (!runningTasks.has(id) && Date.now() < regDeadline) {
        await sleep(20);
      }
      expect(runningTasks.get(id)?.agentId).toBe("agent_a");

      await expect(pA).resolves.toBe("sent");
      // A 仍是唯一 owner：普通停止收尾（无 fork / 无 forceClear）
      runningTasks.get(id)!.cancel();
      resolveWait({ status: "cancelled" });
      const settleDeadline = Date.now() + 5000;
      while (runningTasks.has(id) && Date.now() < settleDeadline) {
        await sleep(20);
      }
      await sleep(40);

      const fresh = await readMetaV06(id);
      expect(fresh?.actions.find((a) => a.id === "act_a")?.status).toBe(
        "cancelled",
      );
      // R18-2 关键：不得全表扫伤及 act_b
      expect(fresh?.actions.find((a) => a.id === "act_b")?.status).toBe(
        "running",
      );
    });
  });

  describe("R18-3 session instanceId（同 agentId resume）", () => {
    it("A/B 同 agentId：旧 A cancelled 不得关 B 的会话", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_a";
      meta.actions = [
        {
          id: "act_a",
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

      let resolveWait!: (v: { status: "cancelled" }) => void;
      const waitGate = new Promise<{ status: "cancelled" }>((r) => {
        resolveWait = r;
      });
      const sharedAgentId = "agent_resumed_same";
      const aClose = vi.fn();
      const bClose = vi.fn();
      const send = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: () => waitGate,
        cancel: vi.fn().mockResolvedValue(undefined),
      });
      const aSessionId = allocTaskRunInstanceId();
      agentSessions.set(id, {
        instanceId: aSessionId,
        agent: { agentId: sharedAgentId, send, close: aClose },
        agentId: sharedAgentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      });

      const task = (await getTask(id))!;
      const pA = deliverAskReply(
        task,
        "s1",
        undefined,
        "act_a",
        { apiKey: "k", model: { id: "m", params: [] as never[] } },
      );
      const regDeadline = Date.now() + 5000;
      while (!runningTasks.has(id) && Date.now() < regDeadline) {
        await sleep(20);
      }
      const aRec = runningTasks.get(id)!;
      aRec.cancel();
      forceClearStaleRunnerState(id);

      // B：resume 同持久化 agentId，新内存实例 + 新 session instanceId
      meta.actions = [
        ...meta.actions!,
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      meta.currentActionId = "act_b";
      await writeMeta(meta);
      await setTaskRunStatus(id, "running", "act_b");
      const bInstanceId = allocTaskRunInstanceId();
      const bSessionId = allocTaskRunInstanceId();
      runningTasks.set(id, {
        instanceId: bInstanceId,
        agentId: sharedAgentId,
        startedAt: Date.now(),
        startSnapshot: { title: meta.title },
        cancel: vi.fn(),
      });
      agentSessions.set(id, {
        instanceId: bSessionId,
        agent: {
          agentId: sharedAgentId,
          send: vi.fn(),
          close: bClose,
        },
        agentId: sharedAgentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      });

      await expect(pA).resolves.toBe("sent");
      resolveWait({ status: "cancelled" });
      await sleep(80);

      expect(agentSessions.get(id)?.instanceId).toBe(bSessionId);
      expect(agentSessions.get(id)?.agentId).toBe(sharedAgentId);
      expect(bClose).not.toHaveBeenCalled();
      expect(runningTasks.get(id)?.instanceId).toBe(bInstanceId);
      const fresh = await readMetaV06(id);
      expect(fresh?.runStatus).toBe("running");
      expect(fresh?.actions.find((a) => a.id === "act_b")?.status).toBe(
        "running",
      );
    });

    it("abortStuck 保留共享 session：旧 A yield 不得 close 后继占用的同 instance", async () => {
      // P0：假死恢复只删 runner、保留 session；旧 consume supersede 后若仍 closeMySession，
      // expectedSessionInstanceId 仍匹配 → 误关后继。yield 只 cancel run、禁止关共享 session。
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_a";
      meta.actions = [
        {
          id: "act_a",
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

      let resolveWait!: (v: { status: "cancelled" }) => void;
      const waitGate = new Promise<{ status: "cancelled" }>((r) => {
        resolveWait = r;
      });
      const sharedAgentId = "agent_stuck_shared_session";
      const sessionClose = vi.fn();
      const send = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: () => waitGate,
        cancel: vi.fn().mockResolvedValue(undefined),
      });
      const sharedSessionId = allocTaskRunInstanceId();
      agentSessions.set(id, {
        instanceId: sharedSessionId,
        agent: { agentId: sharedAgentId, send, close: sessionClose },
        agentId: sharedAgentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      });

      const task = (await getTask(id))!;
      const pA = deliverAskReply(
        task,
        "s1",
        undefined,
        "act_a",
        { apiKey: "k", model: { id: "m", params: [] as never[] } },
      );
      const regDeadline = Date.now() + 5000;
      while (!runningTasks.has(id) && Date.now() < regDeadline) {
        await sleep(20);
      }
      const aRec = runningTasks.get(id)!;
      const aInstanceId = aRec.instanceId;
      aRec.cancel();

      // 模拟 abortStuckRunForSend：CAS 只删 stuck runner，刻意保留同一 session
      if (runningTasks.get(id)?.instanceId === aInstanceId) {
        runningTasks.delete(id);
      }
      // 后继 B 登记新 runner，复用同一 agentSessions instance
      const bInstanceId = allocTaskRunInstanceId();
      runningTasks.set(id, {
        instanceId: bInstanceId,
        agentId: sharedAgentId,
        startedAt: Date.now(),
        startSnapshot: { title: meta.title },
        cancel: vi.fn(),
      });

      await expect(pA).resolves.toBe("sent");
      resolveWait({ status: "cancelled" });
      await sleep(80);

      // 共享 session 仍在、close 不得被旧 A 的 yield 触发
      expect(agentSessions.get(id)?.instanceId).toBe(sharedSessionId);
      expect(agentSessions.get(id)?.agentId).toBe(sharedAgentId);
      expect(sessionClose).not.toHaveBeenCalled();
      expect(runningTasks.get(id)?.instanceId).toBe(bInstanceId);
    });

    it("旧 A 在 setTaskRunStatusIfRunOwner 锁内已非 owner → 不覆盖 B 的 running", async () => {
      // R18-3c：收尾 helper 的 await 窗口内 B 已接管——锁内 isOwner 失败则不写
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_b";
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "cancelled",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);
      const aInstanceId = allocTaskRunInstanceId();
      const bInstanceId = allocTaskRunInstanceId();
      runningTasks.set(id, {
        instanceId: bInstanceId,
        agentId: "agent_b",
        startedAt: Date.now(),
        startSnapshot: { title: meta.title },
        cancel: vi.fn(),
      });
      // 旧 A 收尾：闭包验 instanceId，已被 B 顶掉 → 不写
      const skipped = await setTaskRunStatusIfRunOwner(
        id,
        "idle",
        () => runningTasks.get(id)?.instanceId === aInstanceId,
      );
      expect(skipped).toBeNull();
      expect((await readMetaV06(id))?.runStatus).toBe("running");
      expect((await readMetaV06(id))?.currentActionId).toBe("act_b");
      expect(runningTasks.get(id)?.instanceId).toBe(bInstanceId);
    });
  });

  describe("R19-2 启动失败收尾不覆盖后继 B", () => {
    it("A send 失败时 currentActionId 已是 B → 只标 A error、task 仍指向 B", async () => {
      // 时序：advance A 的 create/send 排在串行链、A 已释放 advance 互斥 →
      // advance B append（currentActionId=B）→ A 的 send reject → handleRunFailure
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_b";
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);

      await handleRunFailure(id, "act_a", new Error("send deferred reject"));

      const fresh = await readMetaV06(id);
      expect(fresh?.currentActionId).toBe("act_b");
      expect(fresh?.runStatus).toBe("running");
      expect(fresh?.actions.find((a) => a.id === "act_a")?.status).toBe("error");
      expect(fresh?.actions.find((a) => a.id === "act_b")?.status).toBe(
        "running",
      );
    });
  });

  describe("R20-1 / R20-4 同 action 双启动 startToken 门控", () => {
    it("同 actionId：A send reject、B 已 claim → A 不伤 action/task，且无 done/error envelope", async () => {
      // R20-1：resume 复用同一 action——opGen/currentActionId/errorActionId 全相同；
      // 旧门禁 currentActionId===errorActionId 对 B 恒真。必须靠 startToken。
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_shared";
      meta.actions = [
        {
          id: "act_shared",
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

      const handleA = claimTaskOp(id, getTaskOpGeneration(id))!;
      // B 接管：后继 claim 覆盖 A 的 op
      const handleB = claimTaskOp(id, getTaskOpGeneration(id))!;
      expect(handleA.opId).not.toBe(handleB.opId);

      const envelopes: Array<{ kind: string; ok?: boolean }> = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "done" || ev.kind === "error") {
          envelopes.push({
            kind: ev.kind,
            ok: ev.kind === "done" ? ev.ok : undefined,
          });
        }
      });

      try {
        await handleRunFailure(id, "act_shared", new Error("send deferred reject"), {
          opHandle: handleA,
        });

        const fresh = await readMetaV06(id);
        expect(fresh?.runStatus).toBe("running");
        expect(fresh?.currentActionId).toBe("act_shared");
        expect(fresh?.actions.find((a) => a.id === "act_shared")?.status).toBe(
          "running",
        );

        const events = await readEvents(id);
        const errorEvents = events.filter((e) => e.kind === "error");
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0]?.actionId).toBe("act_shared");

        // R20-4：失去 start owner → 不发 task 级 done(false)/error
        expect(envelopes.filter((e) => e.kind === "done")).toHaveLength(0);
        expect(envelopes.filter((e) => e.kind === "error")).toHaveLength(0);
      } finally {
        unsub();
      }
    });
  });

  describe("R20-3 prepare/复查/commit（无锁读者隔离）", () => {
    it("setTaskRunStatusIfRunOwner：prepare 挂起期间换主 → 返 null、meta 从未出现新值", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_a";
      meta.actions = [
        {
          id: "act_a",
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

      const aInstanceId = allocTaskRunInstanceId();
      const bInstanceId = allocTaskRunInstanceId();
      runningTasks.set(id, {
        instanceId: aInstanceId,
        agentId: "agent_a",
        startedAt: Date.now(),
        startSnapshot: { title: meta.title },
        cancel: vi.fn(),
      });

      // R20-3：卡住 prepare（tmp 写前）——挂起期间 meta.json 仍是旧值
      let releasePrepare!: () => void;
      const prepareGate = new Promise<void>((r) => {
        releasePrepare = r;
      });
      let midReadRunStatus: string | undefined;
      const origPrepare = taskFsCore.prepareMetaWrite;
      const spy = vi
        .spyOn(taskFsCore, "prepareMetaWrite")
        .mockImplementation(async (m) => {
          // 挂起期间同步换主 + 无锁读者读盘
          runningTasks.set(id, {
            instanceId: bInstanceId,
            agentId: "agent_b",
            startedAt: Date.now(),
            startSnapshot: { title: meta.title },
            cancel: vi.fn(),
          });
          midReadRunStatus = (await getTask(id))?.runStatus;
          await prepareGate;
          return origPrepare(m);
        });

      try {
        const p = setTaskRunStatusIfRunOwner(
          id,
          "idle",
          () => runningTasks.get(id)?.instanceId === aInstanceId,
        );
        await sleep(30);
        // 挂起期间无锁读者看到的仍是旧值
        expect(midReadRunStatus).toBe("running");
        releasePrepare();
        const result = await p;
        expect(result).toBeNull();
        const fresh = await readMetaV06(id);
        expect(fresh?.runStatus).toBe("running");
        expect(fresh?.currentActionId).toBe("act_a");
        expect(runningTasks.get(id)?.instanceId).toBe(bInstanceId);
      } finally {
        spy.mockRestore();
      }
    });

    it("patchActionAndRunStatusIfOpFresh：prepare 挂起期间 isFresh→false → abort、盘上不变", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "idle";
      meta.currentActionId = "act_a";
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "awaiting_ack",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);

      let freshFlag = true;
      let releasePrepare!: () => void;
      const prepareGate = new Promise<void>((r) => {
        releasePrepare = r;
      });
      let midReadStatus: string | undefined;
      const origPrepare = taskFsCore.prepareMetaWrite;
      const spy = vi
        .spyOn(taskFsCore, "prepareMetaWrite")
        .mockImplementation(async (m) => {
          freshFlag = false; // 模拟 stop bump / 换主
          midReadStatus = (await getTask(id))?.actions[0]?.status;
          await prepareGate;
          return origPrepare(m);
        });

      try {
        const p = patchActionAndRunStatusIfOpFresh(
          id,
          "act_a",
          "running",
          "running",
          () => freshFlag,
          { currentActionId: "act_a", actionStatus: "awaiting_ack" },
        );
        await sleep(30);
        expect(midReadStatus).toBe("awaiting_ack");
        releasePrepare();
        expect(await p).toBeNull();
        const fresh = await readMetaV06(id);
        expect(fresh?.runStatus).toBe("idle");
        expect(fresh?.actions[0]?.status).toBe("awaiting_ack");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("R19-4 session close fail-closed", () => {
    it("无内存 session 但带 expectedSessionInstanceId → 不清 sessionAgentId", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.sessionAgentId = "agent_alive";
      await writeMeta(meta);

      const closed = closeTaskSession(id, "agent_alive", {
        expectedSessionInstanceId: 99,
      });
      expect(closed).toBe(false);
      // fire-and-forget 落盘，等一拍
      await sleep(40);
      const fresh = await readMetaV06(id);
      expect(fresh?.sessionAgentId).toBe("agent_alive");
    });

    it("catch 时当前 session 已是 B（同 agentId）→ 不关 B、不清锚点", async () => {
      // 模拟 internalStartAgent catch：failedAgent=A，Map 里已是 resume 出的 B
      const id = alloc();
      const meta = makeMeta(id);
      meta.sessionAgentId = "shared_agent";
      await writeMeta(meta);

      const sharedAgentId = "shared_agent";
      const aClose = vi.fn();
      const bClose = vi.fn();
      const agentA = {
        agentId: sharedAgentId,
        close: aClose,
        send: vi.fn(),
      };
      const agentB = {
        agentId: sharedAgentId,
        close: bClose,
        send: vi.fn(),
      };
      const bSessionId = allocTaskRunInstanceId();
      agentSessions.set(id, {
        instanceId: bSessionId,
        agent: agentB as never,
        agentId: sharedAgentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      });

      // R19-4a 契约：当前 session.agent !== failedAgent → 只关本地 A，不调 closeTaskSession
      const failedSess = agentSessions.get(id);
      if (failedSess?.agent === (agentA as never)) {
        closeTaskSession(id, agentA.agentId, {
          expectedSessionInstanceId: failedSess.instanceId,
        });
      } else {
        try {
          agentA.close();
        } catch {
          /* noop */
        }
      }

      expect(aClose).toHaveBeenCalled();
      expect(bClose).not.toHaveBeenCalled();
      expect(agentSessions.get(id)?.instanceId).toBe(bSessionId);
      expect(agentSessions.get(id)?.agent).toBe(agentB);
      await sleep(40);
      expect((await readMetaV06(id))?.sessionAgentId).toBe("shared_agent");
    });

    it("closeTaskSession：expected 不匹配 → 不关、不清锚点", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.sessionAgentId = "shared_agent";
      await writeMeta(meta);
      const close = vi.fn();
      const sessionId = allocTaskRunInstanceId();
      agentSessions.set(id, {
        instanceId: sessionId,
        agent: { agentId: "shared_agent", close, send: vi.fn() } as never,
        agentId: "shared_agent",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      });

      const closed = closeTaskSession(id, "shared_agent", {
        expectedSessionInstanceId: sessionId + 1,
      });
      expect(closed).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(agentSessions.has(id)).toBe(true);
      await sleep(40);
      expect((await readMetaV06(id))?.sessionAgentId).toBe("shared_agent");
    });
  });

  describe("R21-1 start token 在接管副作用之前 claim（真实同 action 双唤醒链）", () => {
    it("双 resume 同 action：A create 挂起期间 B 接管 → A 让位不 send、B 状态不被写 error", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "error";
      meta.currentActionId = "act_shared";
      meta.actions = [
        {
          id: "act_shared",
          n: 1,
          type: "plan",
          status: "error",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);

      const { releaseCreate, close, send } = makePendingCreateAgent(
        "agent_r21_shared",
      );
      // B 的 consume 走「agent 已提问」正常出口，避免 mock run 触发交卷追问级联
      vi.mocked(getPendingAsk).mockReturnValue({
        askId: "ask_r21",
      } as never);

      try {
        const task = (await getTask(id))!;
        const creds = {
          apiKey: "k",
          fallbackModel: { id: "m", params: [] as never[] },
        };
        // A：唤醒同一 action、create 挂起（admission 占住串行链）
        const pA = resumeCurrentActionWithMessage({
          task,
          userMessage: "第一次唤醒",
          ...creds,
        });
        const deadline = Date.now() + 5000;
        while (mockCreate.mock.calls.length === 0 && Date.now() < deadline) {
          await sleep(20);
        }
        expect(mockCreate).toHaveBeenCalledTimes(1);

        // B：同 action 第二次唤醒——R21-1 修复后 B 在第一个接管副作用前就 claim，
        // A 的 create resolve 后必然发现失主让位
        const pB = resumeCurrentActionWithMessage({
          task: (await getTask(id))!,
          userMessage: "第二次唤醒",
          ...creds,
        });
        // 确定性等待「B 已 claim」：claim 在 B 的 inner 入口（唤醒事件之前）、
        // 看到第二条「已唤醒」事件即 B 必然已接管——此时才放行 A 的 create
        const bDeadline = Date.now() + 5000;
        while (Date.now() < bDeadline) {
          const events = await readEvents(id);
          const wakeCount = events.filter((e) =>
            (e.text ?? "").includes("已唤醒当前"),
          ).length;
          if (wakeCount >= 2) break;
          await sleep(20);
        }
        expect(
          (await readEvents(id)).filter((e) =>
            (e.text ?? "").includes("已唤醒当前"),
          ).length,
        ).toBeGreaterThanOrEqual(2);
        expect((await readMetaV06(id))?.runStatus).toBe("running");

        // 放行 create：A 的 admission 先出队（发现失主让位）、B 的随后正常受理
        releaseCreate();
        await Promise.all([pA, pB]);
        const settleDeadline = Date.now() + 5000;
        while (
          (isTaskStarting(id) || runningTasks.has(id)) &&
          Date.now() < settleDeadline
        ) {
          await sleep(30);
        }

        // A 从未 send（让位在 send 之前）；只有 B 送出 super prompt
        expect(send).toHaveBeenCalledTimes(1);
        // A 让位时关了自己的本地 agent
        expect(close).toHaveBeenCalled();
        // B 的共用 action / task 状态没有被 A 的任何收尾写成 error
        const fresh = await readMetaV06(id);
        expect(fresh?.runStatus).toBe("running");
        expect(fresh?.currentActionId).toBe("act_shared");
        expect(
          fresh?.actions.find((a) => a.id === "act_shared")?.status,
        ).toBe("running");
        const events = await readEvents(id);
        expect(events.filter((e) => e.kind === "error")).toHaveLength(0);
      } finally {
        vi.mocked(getPendingAsk).mockReset();
      }
    });
  });

  describe("R21-2 handleRunFailure 函数内换主（deferred claim）", () => {
    it("helper prepare 挂起期间 B claim → 不提交 error、不 finalize 共享 action、无全局 envelope", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_shared";
      meta.actions = [
        {
          id: "act_shared",
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

      const handleA = claimTaskOp(id, getTaskOpGeneration(id))!;

      // R21-2 验收点名：B 的 claim 发生在 helper 的 prepare await 期间、
      // 而不是调用 handleRunFailure 之前——入口检查会通过、锁内复查才拦得住
      let claimedDuringPrepare = false;
      const origPrepare = taskFsCore.prepareMetaWrite;
      const spy = vi
        .spyOn(taskFsCore, "prepareMetaWrite")
        .mockImplementation(async (m) => {
          if (!claimedDuringPrepare) {
            claimedDuringPrepare = true;
            claimTaskOp(id, getTaskOpGeneration(id)); // B 接管
          }
          return origPrepare(m);
        });

      const envelopes: Array<{ kind: string }> = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "done" || ev.kind === "error") {
          envelopes.push({ kind: ev.kind });
        }
      });

      try {
        await handleRunFailure(id, "act_shared", new Error("mid-flight boom"), {
          opHandle: handleA,
        });

        expect(claimedDuringPrepare).toBe(true);
        expect(isTaskOpCurrent(handleA)).toBe(false);
        const fresh = await readMetaV06(id);
        // 共享 action / task 状态未被 A 提交
        expect(fresh?.runStatus).toBe("running");
        expect(
          fresh?.actions.find((a) => a.id === "act_shared")?.status,
        ).toBe("running");
        // 事件只挂 actionId；无 task 级 done/error envelope
        const events = await readEvents(id);
        const errorEvents = events.filter((e) => e.kind === "error");
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0]?.actionId).toBe("act_shared");
        expect(envelopes).toHaveLength(0);
      } finally {
        unsub();
        spy.mockRestore();
      }
    });

    it("不同 action 接管（token 仍有效）→ 仍精确标自己 act_a error、不碰 B（回归 R19-2）", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_b";
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);

      const handleA = claimTaskOp(id, getTaskOpGeneration(id))!;
      await handleRunFailure(id, "act_a", new Error("boom"), {
        opHandle: handleA,
      });

      const fresh = await readMetaV06(id);
      // A 独占的旧 action 收成 error；B 的指针 / 状态不动
      expect(fresh?.actions.find((a) => a.id === "act_a")?.status).toBe(
        "error",
      );
      expect(fresh?.currentActionId).toBe("act_b");
      expect(fresh?.runStatus).toBe("running");
      expect(fresh?.actions.find((a) => a.id === "act_b")?.status).toBe(
        "running",
      );
    });
  });

  describe("R21-4 ask 僵尸兜底的结构条件（expectedRunStatus）", () => {
    it("盘上已被后继写成 running → expectedRunStatus=awaiting_user 拒写", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running"; // 并发唤醒 B 已接管（尚未 Agent.create、无 session）
      await writeMeta(meta);

      const skipped = await setTaskRunStatusIfRunOwner(
        id,
        "error",
        () => true, // gen 未 stale、无 session——旧 owner 闭包全过
        undefined,
        "awaiting_user",
      );
      expect(skipped).toBeNull();
      expect((await readMetaV06(id))?.runStatus).toBe("running");
    });

    it("盘上仍是 awaiting_user（真僵尸）→ 正常标 error", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "awaiting_user";
      await writeMeta(meta);

      const updated = await setTaskRunStatusIfRunOwner(
        id,
        "error",
        () => true,
        undefined,
        "awaiting_user",
      );
      expect(updated).not.toBeNull();
      expect((await readMetaV06(id))?.runStatus).toBe("error");
    });
  });

  describe("R21-5 consume 只认自己绑定的 action（不误绑后继）", () => {
    it("B 已 append、A 自然 finished → A 不追问、不收尾 B、只收自己的 action", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_b"; // advance B 已 append、尚未 cancel A
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);

      // A 的存活会话：send 返回「立即 finished」的 run——模拟 A 在窗口内自然结束
      const close = vi.fn();
      const send = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
        cancel: vi.fn().mockResolvedValue(undefined),
      });
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: { agentId: "agent_a_r21_5", close, send } as never,
        agentId: "agent_a_r21_5",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      });

      const task = (await getTask(id))!;
      // A 的 run 绑定自己的 act_a（ask 答案送回 A 的旧会话）
      const result = await deliverAskReply(
        task,
        "答案",
        undefined,
        "act_a",
      );
      expect(result).toBe("sent");

      // 等 fire-and-forget consume 收尾
      const deadline = Date.now() + 5000;
      while (runningTasks.has(id) && Date.now() < deadline) {
        await sleep(20);
      }

      // 旧逻辑：A 把全局最新 act_b 当自己的 lastAction → send 追问「为 B 交卷」、
      // 失败还 patchAction(B, error)。新逻辑：让位——send 只有 1 次（答案本身）
      expect(send).toHaveBeenCalledTimes(1);
      const fresh = await readMetaV06(id);
      // B 不被伤：指针 / 状态 / action 全部保持
      expect(fresh?.currentActionId).toBe("act_b");
      expect(fresh?.runStatus).toBe("running");
      expect(fresh?.actions.find((a) => a.id === "act_b")?.status).toBe(
        "running",
      );
      // A 自己的 action 收成 cancelled（不留僵尸 running）
      expect(fresh?.actions.find((a) => a.id === "act_a")?.status).toBe(
        "cancelled",
      );
      // 不发 task 级失败、不写 error 事件
      const events = await readEvents(id);
      expect(events.filter((e) => e.kind === "error")).toHaveLength(0);
    });
  });

  describe("W3 CAS helper", () => {
    it("setTaskRunStatusIfCurrentAction：指针已变则不写", async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.currentActionId = "act_old";
      meta.runStatus = "running";
      meta.actions = [
        {
          id: "act_old",
          n: 1,
          type: "plan",
          status: "cancelled",
          userInstruction: "",
          artifactPath: null,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);
      // 后继 B 已改指针
      await setTaskRunStatus(id, "running", "act_new");
      const skipped = await setTaskRunStatusIfCurrentAction(
        id,
        "act_old",
        "idle",
      );
      expect(skipped).toBeNull();
      expect((await readMetaV06(id))?.runStatus).toBe("running");
      expect((await readMetaV06(id))?.currentActionId).toBe("act_new");
    });
  });
});
