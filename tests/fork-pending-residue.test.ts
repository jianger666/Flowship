/**
 * R14 Q7b-04：forkPendingTasks 标志不得在旧 run 自然结束的收尾期残留
 *
 * 背景：
 *   `forkPendingTasks`（task-stream）是「B 等 A」的 force-new 交接标志：advance 起新 agent / 输入条唤醒当前 action 时，
 *   发现旧 run 还占着 runningTasks，就先 add 标志、再 cancel 旧 record、再等它清表；旧 run 的 cancelled 分支看到标志
 *   就知道「自己是被换掉的」，只让位（写一句过渡 info 后直接 return），不做「普通停止」那套收尾（收 action / 写 idle / 发 done / 关会话）。
 *
 * 旧行为（修复前）：
 *   标志只在 cancelled 分支里清。旧 run 若是**自然结束**、正卡在 finally 的 `finalizeOpenToolCalls`（收尾期）时被唤醒 / 推进
 *   add 了标志，它走不进 cancelled 分支，标志就永久残留。之后新 agent 的 run2 被任何「不经 stop-task」的 cancel
 *   （abortStuckRunForSend / 24h 硬超时 / mid-run 轮换）取消时，run2 的 cancelled 分支撞见这个残留标志，误当成
 *   「旧 agent 已收尾」：不收 action、不写 idle、不发 done，直接 return——task 僵在 running，可是已经没有 run 了。
 *
 * 修复后：
 *   consume 的 finally 里，仅当 `iOwnRunner()`（runningTasks 里仍是自己那条 record）时顺带 `forkPendingTasks.delete`，
 *   和摘 runningTasks 同门——旧 run 一退出，它那一轮的标志就没了；失主（后继已换号）时绝不碰后继的标志。
 *
 * 手法（不用固定 sleep，状态都是确定的）：
 *   - `@/lib/server/finalize-open-tools` 用 vi.mock 包一层：让「第一次」闭合挂在手动 resolve 的 deferred 上——
 *     「旧 run 已自然结束、正卡在 finally」是确定状态，放行时机由用例说了算；
 *   - 唤醒走真实入口 `resumeCurrentActionWithMessage`（claim → add 标志 + cancel 旧 record → waitForTaskToStop →
 *     internalStartAgent → Agent.create（mock）→ run2）；
 *   - 轮询一律「直到条件成立、上限 15s」。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，先钉 FLOWSHIP_DATA_DIR 再动态 import。
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
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-fork-pending-residue-"));
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

/**
 * finalizeOpenToolCalls 的可控替身（vi.hoisted：vi.mock 工厂提升到文件顶部，引用的变量必须同样提升）。
 * hook 返回 Promise = 用它顶替真实现（本文件只用来「挂住」）；返回 null / 未设置 = 转发真实现。
 * calls 记录每次被调用的 taskId——既是「run 确实走到了 finally 的闭合」的正向信号，也防「没走到就断言」的空转。
 */
const finalizeCtl = vi.hoisted(() => ({
  hook: null as null | ((taskId: string) => Promise<number> | null),
  calls: [] as string[],
}));
vi.mock("@/lib/server/finalize-open-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/finalize-open-tools")>();
  return {
    ...actual,
    finalizeOpenToolCalls: (
      taskId: string,
      lease: () => boolean,
    ): Promise<number> => {
      finalizeCtl.calls.push(taskId);
      return (
        finalizeCtl.hook?.(taskId) ??
        actual.finalizeOpenToolCalls(taskId, lease)
      );
    },
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  forkPendingTasks,
  pendingStopRequests,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { deliverAskReply, resumeCurrentActionWithMessage } = await import(
  "@/lib/server/task-runner"
);
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `fork-pending-residue DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

// 跳过 task-fs 的惰性 boot-recovery：它会把 fixture 里 runStatus=running 的任务标成 error 并往事件流补
// 「[boot-recovery]」——本文件的 fixture 就是 running，不跳过会让初始态不确定（与 ownership-r34 同手法）。
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
(globalThis as unknown as Record<string, Promise<void>>)[RECOVERY_FLAG] =
  Promise.resolve();

const PERSISTED_AGENT_ID = "agent_fork_persisted";
const ACTION_ID = "act_fork";
const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
/** 轮询上限：机器高负载时也要有余量；条件成立即返回，通过路径不会真等这么久。 */
const POLL_MS = 15_000;
/** 被「吞」掉的那句过渡 info（cancelled 分支撞见 fork 标志时写的） */
const FORK_INFO_TEXT = "旧 agent 已收尾、正在为推进起新 agent...";

/**
 * fixture：runStatus=running、sessionAgentId 在盘上。
 * actionStatus：
 *   - awaiting_ack（已交卷待审阅）：run 自然结束后不触发「没交卷 → send 追问」，也不触发「action 终态 → 即用即还关会话」；
 *   - running：用来看「普通停止收尾」会不会把它收成 cancelled。
 */
const makeMeta = (
  id: string,
  actionStatus: "awaiting_ack" | "running",
): TaskMetaV06 =>
  ({
    id,
    title: `fork-pending ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: ACTION_ID,
    actions: [
      {
        id: ACTION_ID,
        n: 1,
        type: "plan",
        status: actionStatus,
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    sessionAgentId: PERSISTED_AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 轮询直到条件成立，返回是否在上限内成立（不抛：由调用方用带说明的 expect 断言，
 * 这样「改前」的失败信息是一句人话，而不是一个裸的超时）。
 */
const pollUntil = async (
  pred: () => boolean | Promise<boolean>,
  ms = POLL_MS,
): Promise<boolean> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
};

/**
 * 让出若干个宏任务：finally 放行后剩下的部分全是同步 + 微任务，让出两拍就能确定它们都已走完
 * （不依赖任何墙钟时长）。
 */
const settleMacrotasks = async (): Promise<void> => {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
};

const makeDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const assistantMsg = (text: string) => ({
  type: "assistant" as const,
  message: { content: [{ type: "text", text }] },
});

/**
 * 假 run：
 *   - 默认：流里吐一条旁白后自然结束，wait 回 finished（「旧 agent 已干完、在收尾」）；
 *   - hangUntilCancel：流在旁白后挂住，直到 cancel() 被调才结束，wait 回 cancelled（「在跑的 run 被取消」）。
 * state.streamed = 流已被 consume 开始消费；state.cancelCalls = run.cancel() 被调的次数。
 */
const makeRun = (opts: { hangUntilCancel?: boolean } = {}) => {
  const state = { streamed: false, cancelCalls: 0 };
  const gate = makeDeferred();
  const run = {
    id: `run_${Math.random().toString(36).slice(2, 8)}`,
    stream: async function* (): AsyncGenerator<unknown> {
      state.streamed = true;
      yield assistantMsg("旁白");
      if (opts.hangUntilCancel) await gate.promise;
    },
    wait: opts.hangUntilCancel
      ? vi.fn(async () => {
          await gate.promise;
          return { status: "cancelled" as const };
        })
      : vi.fn().mockResolvedValue({ status: "finished" as const }),
    cancel: vi.fn(async () => {
      state.cancelCalls += 1;
      gate.resolve();
    }),
  };
  return { run, state, release: gate.resolve };
};

type FakeAgent = {
  agentId: string;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

const makeAgent = (agentId: string, runs: Array<{ run: unknown }>): FakeAgent => {
  const send = vi.fn();
  for (const r of runs) send.mockResolvedValueOnce(r.run);
  return { agentId, close: vi.fn(), send };
};

const installSession = (id: string, agent: FakeAgent): void => {
  agentSessions.set(id, {
    instanceId: allocTaskRunInstanceId(),
    agent: agent as never,
    agentId: agent.agentId,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    startSnapshot: { title: `fork ${id}` },
    repoPaths: [],
  });
};

const isForkInfo = (e: TaskEvent): boolean =>
  e.kind === "info" && String(e.text ?? "").includes(FORK_INFO_TEXT);

describe("R14 Q7b-04 forkPendingTasks：旧 run 自然结束的收尾期被唤醒，标志不得残留", () => {
  const ids: string[] = [];
  /** 不 await 的在飞 promise（唤醒流程）：afterEach 统一收，防它们在目录被删后才落盘 */
  const pending: Array<Promise<unknown>> = [];
  /** 用例里造的 gate / deferred：afterEach 统一放行，别留悬空的 consume */
  const gates: Array<() => void> = [];

  const alloc = (): string => {
    const id = `t_fork_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  const deliver = async (id: string) =>
    deliverAskReply((await getTask(id))!, "触发这一轮", undefined, ACTION_ID, {
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    });

  /** 让 id 的**第一次**闭合挂在 hold 上（run1 卡在 finally）；之后的调用（如 run2 的 finally）走真实现 */
  const holdFirstFinalize = (
    id: string,
    hold: { promise: Promise<void> },
  ): void => {
    let taken = false;
    finalizeCtl.hook = (taskId) => {
      if (taskId !== id || taken) return null;
      taken = true;
      return hold.promise.then(() => 0);
    };
  };

  /**
   * 输入条唤醒当前 action（真实入口）。不 await：它会在 waitForTaskToStop 里等旧 run 清表。
   * 返回的 outcome 供用例轮询「唤醒流程是否走完」以及有没有抛错。
   */
  const startWake = async (id: string) => {
    const outcome = { settled: false, error: null as unknown };
    pending.push(
      resumeCurrentActionWithMessage({
        task: (await getTask(id))!,
        userMessage: "继续（输入条唤醒当前阶段）",
        apiKey: CREDS.apiKey,
        fallbackModel: CREDS.model,
      })
        .catch((err: unknown) => {
          outcome.error = err;
        })
        .finally(() => {
          outcome.settled = true;
        }),
    );
    return outcome;
  };

  /**
   * 搭场景：run1（热会话）自然结束并卡在 finally 的闭合 → 输入条唤醒（add 标志 + cancel 旧 record）→ 放行 →
   * 唤醒流程走完、新 agent 的 run2 起来并在流（挂住等取消）。
   * 返回时：run1 的 consume 已退出，run2 在跑。用例在此基础上断言 / 继续操作。
   */
  const driveWakeWhileRun1StuckInFinally = async (id: string) => {
    await writeMeta(makeMeta(id, "awaiting_ack"));
    const hold = makeDeferred();
    gates.push(hold.resolve);
    holdFirstFinalize(id, hold);

    const r1 = makeRun();
    installSession(id, makeAgent(PERSISTED_AGENT_ID, [r1]));
    const r2 = makeRun({ hangUntilCancel: true });
    gates.push(r2.release);
    const agent2 = makeAgent("agent_fork_new", [r2]);
    mockCreate.mockResolvedValue(agent2);

    expect(await deliver(id)).toBe("sent");
    // run1 自然结束、业务收尾已过，正卡在 finally 的闭合——确定状态
    expect(
      await pollUntil(() => finalizeCtl.calls.includes(id)),
      "run1 应已自然结束并走到 finally 的闭合",
    ).toBe(true);
    expect(runningTasks.has(id), "run1 卡在 finally 期间仍占位").toBe(true);
    expect(forkPendingTasks.has(id), "前置：此刻还没有 fork 标志").toBe(false);

    // 唤醒：claim → add 标志 + cancel run1 的 record → 等 run1 清表
    const wake = await startWake(id);
    expect(
      await pollUntil(() => forkPendingTasks.has(id)),
      "唤醒应已 add fork 标志",
    ).toBe(true);
    expect(r1.state.cancelCalls, "唤醒应已 cancel 旧 record").toBe(1);
    expect(wake.settled, "run1 还卡在 finally，唤醒应在等它清表").toBe(false);

    // 放行：run1 的 consume 退出 → 唤醒继续 → 新 agent 起 run2
    hold.resolve();
    expect(
      await pollUntil(() => wake.settled),
      "放行后唤醒流程应走完",
    ).toBe(true);
    expect(wake.error, "唤醒不该抛错").toBeNull();
    expect(
      await pollUntil(() => r2.state.streamed),
      "新 agent 的 run2 应已起来并被消费",
    ).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    return { r1, r2, agent2 };
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    finalizeCtl.hook = null;
    finalizeCtl.calls.length = 0;
    // 静音被测代码的 log / warn / error，避免淹没测试输出
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    finalizeCtl.hook = null;
    for (const release of gates.splice(0)) release();
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      forkPendingTasks.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    await Promise.allSettled(pending.splice(0));
    // 沿用现有测试的收尾手法：先让 fire-and-forget 的落盘（会话锚点等）走完再删目录，免得 ENOENT 噪音
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // 回归 1：标志在旧 run 退出后不残留
  // ---------------------------------------------------------------------------
  it(
    "回归：旧 run 自然结束、卡在 finally 时被唤醒（add 标志 + cancel）→ 放行、run1 的 consume 退出后 forkPendingTasks 不残留",
    async () => {
      // 保护：标志的生命周期 = 它所指的那个旧 run。改前：标志只在 cancelled 分支清，自然结束的旧 run 走不进去，
      // add 之后永久残留（唤醒流程本身也不清它）。
      const id = alloc();
      const { r1 } = await driveWakeWhileRun1StuckInFinally(id);
      expect(r1.state.streamed).toBe(true);

      expect(
        forkPendingTasks.has(id),
        "fork 标志残留：旧 run 自然结束的 finally 没清它（改前行为）",
      ).toBe(false);

      // 收尾（非断言）：让 run2 退出，免得 consume 悬到 afterEach
      runningTasks.get(id)?.cancel();
      await pollUntil(() => !runningTasks.has(id));
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 回归 2：残留标志的后果——run2 被非 stop-task 的 cancel 时不得被「吞掉」
  // ---------------------------------------------------------------------------
  it(
    "回归：随后 run2 被一次「非 stop-task」的 cancel → task 正常收尾（idle、action=cancelled、占位释放），不被当成「旧 agent 已收尾」吞掉",
    async () => {
      // 保护：标志残留的真实危害。改前：run2 的 cancelled 分支撞见残留标志，当成「旧 agent 已收尾」：写那句过渡 info 后直接 return，
      // 不收 action、不写 idle、不发 done——task 僵在 running，可 runningTasks 已空（没有 run 了）。
      // 这里用 runningTasks.get(id).cancel() 代表 abortStuckRunForSend / 24h 硬超时 / mid-run 轮换这类不经 stop-task 的取消。
      const id = alloc();
      await driveWakeWhileRun1StuckInFinally(id);
      expect(runningTasks.has(id), "run2 应在跑").toBe(true);

      runningTasks.get(id)!.cancel();

      expect(
        await pollUntil(() => !runningTasks.has(id)),
        "run2 的 consume 应退出并释放占位",
      ).toBe(true);
      // 普通 cancel 收尾：idle + action 收成 cancelled（先 action 后 idle，轮询 idle 即可等到两者）
      expect(
        await pollUntil(
          async () => (await readMetaV06(id))?.runStatus === "idle",
        ),
        "task 应被收成 idle（改前：僵在 running、而 run 已经没了）",
      ).toBe(true);
      const meta = await readMetaV06(id);
      expect(
        meta?.actions.find((a) => a.id === ACTION_ID)?.status,
        "当前 action 应被收成 cancelled",
      ).toBe("cancelled");
      expect(runningTasks.has(id)).toBe(false);
      expect(
        (await readEvents(id)).filter(isForkInfo),
        "run2 被当成「旧 agent 已收尾」吞掉了（事件流里出现过渡 info）",
      ).toEqual([]);
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 对照 3：fork 取消仍在流的旧 run → cancelled 分支照常消费标志
  // ---------------------------------------------------------------------------
  it(
    "对照：被 fork 取消、还在流的旧 run → cancelled 分支照常消费标志：清标志、写过渡 info、不写 cancelled 收尾、不关会话",
    async () => {
      // 保护：标志原有的消费路径没被改坏——「旧 run 还在流时被换掉」仍走 cancelled 分支的 fork 让位：
      // 标志清掉、写一句过渡 info，然后直接 return（不收 action、不写 idle、不关会话，这些归新 agent）。BF 里同样绿。
      // 为什么不走真实唤醒入口：唤醒先 claim 再 add 标志，旧 run 的 observer handle 此刻已失效（isTaskOpCurrent=false），
      // 过渡 info 按设计不会写（「失主不写」）；这里直接做 handoff 的两步（add 标志 + cancel 旧 record），
      // 不 claim，旧 run 的 handle 仍有效，才能把「写过渡 info」这一支一并钉住。
      const id = alloc();
      await writeMeta(makeMeta(id, "running"));
      const r1 = makeRun({ hangUntilCancel: true });
      gates.push(r1.release);
      const agent = makeAgent(PERSISTED_AGENT_ID, [r1]);
      installSession(id, agent);

      expect(await deliver(id)).toBe("sent");
      expect(
        await pollUntil(() => r1.state.streamed),
        "旧 run 应在流（挂住）",
      ).toBe(true);
      expect(runningTasks.has(id)).toBe(true);

      forkPendingTasks.add(id);
      runningTasks.get(id)!.cancel();

      expect(
        await pollUntil(() => !runningTasks.has(id)),
        "旧 run 应被取消并退出",
      ).toBe(true);
      expect(r1.state.cancelCalls).toBe(1);
      expect(
        forkPendingTasks.has(id),
        "标志应被 cancelled 分支消费掉",
      ).toBe(false);
      expect(
        (await readEvents(id)).filter(isForkInfo),
        "应写且只写一句过渡 info",
      ).toHaveLength(1);
      // 不做「普通停止」那套：action 仍是 running（没被收成 cancelled）、runStatus 仍是 running（没被写成 idle）
      const meta = await readMetaV06(id);
      expect(meta?.actions.find((a) => a.id === ACTION_ID)?.status).toBe(
        "running",
      );
      expect(meta?.runStatus).toBe("running");
      // 会话归新 agent 管，旧 consume 不关
      expect(agent.close).not.toHaveBeenCalled();
      expect(agentSessions.has(id)).toBe(true);
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 对照 4：失主（iOwnRunner()=false）→ 旧 finally 不碰后继的标志
  // ---------------------------------------------------------------------------
  it(
    "对照：旧 run 的 finally 失主（runningTasks 已是后继的 record）→ 不清后继登记的 forkPendingTasks 标志，也不摘后继的 record",
    async () => {
      // 保护：finally 里清标志与摘 runningTasks 同门（iOwnRunner）。forceClear / abortStuck 之后后继 B 换了新号，
      // 并可能已为自己的交接 add 了标志；旧 run 迟到收尾若无条件 delete，会把 B 的标志抹掉，
      // B 的 run 随后被 cancel 时就看不见「我是被换掉的」。改前 finally 根本不碰标志，所以 BF 里同样绿；
      // 它钉的是「修复不能写成无条件 delete」。
      const id = alloc();
      await writeMeta(makeMeta(id, "awaiting_ack"));
      const hold = makeDeferred();
      gates.push(hold.resolve);
      holdFirstFinalize(id, hold);
      installSession(id, makeAgent(PERSISTED_AGENT_ID, [makeRun()]));

      expect(await deliver(id)).toBe("sent");
      expect(
        await pollUntil(() => finalizeCtl.calls.includes(id)),
        "旧 run 应已自然结束并走到 finally 的闭合",
      ).toBe(true);

      // 此刻后继接管：换成一条新号的 record，并登记它自己的 fork 标志
      const successor = {
        instanceId: allocTaskRunInstanceId(),
        agentId: "agent_successor",
        startedAt: Date.now(),
        startSnapshot: { title: "successor" },
        cancel: vi.fn(),
      };
      runningTasks.set(id, successor);
      forkPendingTasks.add(id);
      const SENTINEL = 1;
      agentSessions.get(id)!.lastActiveAt = SENTINEL;

      try {
        hold.resolve();
        // 放行后 finally 剩下的部分全是同步 + 微任务：让出宏任务即走完
        await settleMacrotasks();

        // 正向信号：旧 finally 确实跑完了（会话 lastActiveAt 被刷新）——否则下面的「没清」可能只是「还没跑到」
        expect(
          agentSessions.get(id)!.lastActiveAt,
          "旧 run 的 finally 应已跑完",
        ).not.toBe(SENTINEL);
        expect(
          forkPendingTasks.has(id),
          "旧 run 的 finally 清掉了后继的 fork 标志",
        ).toBe(true);
        expect(
          runningTasks.get(id),
          "旧 run 的 finally 摘掉了后继的 record",
        ).toBe(successor);
      } finally {
        runningTasks.delete(id);
        forkPendingTasks.delete(id);
      }
    },
    60_000,
  );
});
