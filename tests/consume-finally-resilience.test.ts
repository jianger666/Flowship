/**
 * R14 Q7b-02：consumeSessionRun 的 finally 不能被「收尾闭合未配对 tool」的抛错卡住
 *
 * 旧行为（修复前）：
 *   consume 的 finally 第一件事是 `await finalizeOpenToolCalls(...)`（读事件尾部 / 停后台 shell 跟踪；
 *   Windows 杀软 / 句柄占用 / EIO / ENOSPC 时会抛），而释放动作（runningTasks.delete / releaseTaskOpIf /
 *   刷新会话 lastActiveAt）全排在它后面。它一抛：
 *     ① finally 在这一行就退出 → runningTasks 永久占位：任务永远「运行中」，之后每次 send 都要先等 90s
 *        排空超时、再走强清；
 *     ② 调用方 `void consumeSessionRun(...)` 没有 catch → unhandledRejection。
 *
 * 修复后：
 *   闭合包进 try/catch（吞错只 warn），释放动作放进内层 finally——无论闭合成败都执行；
 *   仍只在「runningTasks 里还是自己那条 record」时才摘（失主保护：forceClear / abortStuck 后后继换了新号，
 *   旧 finally 不得抹掉后继）。sendToTaskSessionBody 末尾的 `void consumeSessionRun(...)` 另加了
 *   `.catch(console.error)` 兜底——consume 万一从别处抛出（例如失败收尾本身也抛），也只记日志、不变 unhandledRejection。
 *
 * 手法：
 *   - `@/lib/server/finalize-open-tools` 用 vi.mock 包一层：默认转发真实现，用例按需替换成「抛 EACCES」/「挂在 deferred 上」
 *     （不用 chmod 弄坏事件文件：Windows CI 上 chmod 无效）；
 *   - 经 `deliverAskReply` 起 run（假会话 + 假 run），与 task-runner-stream-error-flush 同口径；
 *   - 轮询一律「直到条件成立、上限 15s」，不用固定 sleep 等异步结果；
 *   - action 停在 awaiting_ack（已交卷待审阅）：自然结束后不触发「没交卷 → send 追问」，也不触发「action 终态 →
 *     即用即还关会话」，会话留在表里，lastActiveAt 才测得到。
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

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-consume-finally-resilience-"),
);
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
 * impl 缺省 null = 转发真实现（对照用例 / 其它用例的默认行为）；用例里替换成「抛错」或「挂在 deferred 上」。
 * calls 记录每次被调用的 taskId——既是「run 确实走到了收尾闭合」的正向信号，也防「没走到就断言」的空转。
 */
const finalizeCtl = vi.hoisted(() => ({
  impl: null as
    | null
    | ((taskId: string, lease: () => boolean) => Promise<number>),
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
      return finalizeCtl.impl
        ? finalizeCtl.impl(taskId, lease)
        : actual.finalizeOpenToolCalls(taskId, lease);
    },
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  forkPendingTasks,
  pendingStopRequests,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { clearFailpoints, setFailpoint } = await import(
  "@/lib/server/failpoints"
);
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { deliverAskReply, resumeCurrentActionWithMessage } = await import(
  "@/lib/server/task-runner"
);
const { snapshotTaskOp } = await import("@/lib/server/task-op");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `consume-finally-resilience DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

// 跳过 task-fs 的惰性 boot-recovery：它会把 fixture 里 runStatus=running 的任务标成 error 并往事件流补
// 「[boot-recovery]」——本文件的 fixture 就是 running，不跳过会让初始态不确定（与 ownership-r34 同手法）。
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
(globalThis as unknown as Record<string, Promise<void>>)[RECOVERY_FLAG] =
  Promise.resolve();

const PERSISTED_AGENT_ID = "agent_fin_persisted";
const ACTION_ID = "act_fin";
const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
/** 轮询上限：机器高负载时也要有余量；条件成立即返回，通过路径不会真等这么久。 */
const POLL_MS = 15_000;

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `consume-finally ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: ACTION_ID,
    actions: [
      {
        id: ACTION_ID,
        n: 1,
        type: "plan",
        // awaiting_ack：见文件头——不追问、不关会话
        status: "awaiting_ack",
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
 * 让出若干个宏任务：Node 在每个宏任务的微任务队列清空之后才派发 unhandledRejection，
 * 而 finally 里放行 / 摘表那一段全是同步 + 微任务——让出两拍就能确定它们都已走完（不依赖任何墙钟时长）。
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

/** 假 run：流里吐一条旁白（可选再挂在 gate 上）、wait 回 finished。state.streamed = 流已被 consume 开始消费。 */
const makeRun = (gate?: Promise<void>) => {
  const state = { streamed: false };
  const run = {
    id: `run_${Math.random().toString(36).slice(2, 8)}`,
    stream: async function* (): AsyncGenerator<unknown> {
      state.streamed = true;
      yield assistantMsg("收尾旁白");
      if (gate) await gate;
    },
    wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return { run, state };
};

/**
 * 假 run（可取消版）：流在旁白后挂住，直到 cancel() 被调才结束，wait 回 cancelled——「在跑的 run 被取消」。
 * 与 makeRun 分开：makeRun 的 cancel 是空操作、wait 回 finished，改它会牵动其它用例的语义。
 */
const makeCancellableRun = () => {
  const state = { streamed: false };
  const gate = makeDeferred();
  const run = {
    id: `run_${Math.random().toString(36).slice(2, 8)}`,
    stream: async function* (): AsyncGenerator<unknown> {
      state.streamed = true;
      yield assistantMsg("旁白");
      await gate.promise;
    },
    wait: vi.fn(async () => {
      await gate.promise;
      return { status: "cancelled" as const };
    }),
    cancel: vi.fn(async () => {
      gate.resolve();
    }),
  };
  return { run, state, release: gate.resolve };
};

/** 假 agent：按顺序每次 send 吐一个 run */
const makeAgent = (runs: Array<{ run: unknown }>) => {
  const send = vi.fn();
  for (const r of runs) send.mockResolvedValueOnce(r.run);
  return { agentId: PERSISTED_AGENT_ID, close: vi.fn(), send };
};

const installSession = (
  id: string,
  agent: { agentId: string; close: () => void; send: unknown },
): void => {
  agentSessions.set(id, {
    instanceId: allocTaskRunInstanceId(),
    agent: agent as never,
    agentId: agent.agentId,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    startSnapshot: { title: `fin ${id}` },
    repoPaths: [],
  });
};

/** 模拟事件文件被杀软 / 句柄占用锁住时 open 抛的错 */
const injectedEacces = (): Error =>
  Object.assign(
    new Error("EACCES: permission denied, open 'events.jsonl'（测试注入）"),
    { code: "EACCES" },
  );

/** 收集 unhandledRejection（只在调用 stop 之前有效）。vitest 自己也会把它们报成 Unhandled Errors。 */
const collectUnhandled = () => {
  const list: unknown[] = [];
  const handler = (reason: unknown): void => {
    list.push(reason);
  };
  process.on("unhandledRejection", handler);
  return { list, stop: () => process.off("unhandledRejection", handler) };
};

const isDrainWaitInfo = (e: TaskEvent): boolean =>
  e.kind === "info" && String(e.text ?? "").includes("上一轮尚未结束");

/** 被测日志：用例里要断言 warn / error 内容，同时把它们挡在终端输出之外 */
const logs = { warn: [] as unknown[][], error: [] as unknown[][] };

describe("R14 Q7b-02 consume finally：收尾闭合抛错不得挡住占位释放", () => {
  const ids: string[] = [];
  /** 不 await 的在飞 promise：afterEach 统一收，防它们在目录被删后才落盘 */
  const pending: Array<Promise<unknown>> = [];
  /** 用例里造的 gate：afterEach 统一放行，别留悬空的 consume */
  const gates: Array<() => void> = [];

  const alloc = (): string => {
    const id = `t_fin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  const deliver = async (id: string) =>
    deliverAskReply((await getTask(id))!, "触发这一轮", undefined, ACTION_ID, {
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    });

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    finalizeCtl.impl = null;
    finalizeCtl.calls.length = 0;
    logs.warn.length = 0;
    logs.error.length = 0;
    clearFailpoints();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logs.warn.push(args);
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.error.push(args);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearFailpoints();
    finalizeCtl.impl = null;
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
  // 回归：占位释放 + 没有 unhandledRejection
  // ---------------------------------------------------------------------------
  it(
    "回归：finalizeOpenToolCalls 抛 EACCES → run 结束后 runningTasks 照常释放，且闭合的错不会冒成 unhandledRejection",
    async () => {
      // 保护：闭合抛错不能让 runningTasks 永久占位（任务永远「运行中」）、也不能把错甩给没 catch 的调用方。
      // 改前：finally 在 finalize 那行退出 → runningTasks 永不释放 + consume 的 promise 以 EACCES reject → unhandledRejection。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const injected = injectedEacces();
      finalizeCtl.impl = async () => {
        throw injected;
      };
      installSession(id, makeAgent([makeRun()]));

      const unhandled = collectUnhandled();
      try {
        expect(await deliver(id)).toBe("sent");
        // 正向信号：consume 确实走到了 finally 并调了（被注入抛错的）闭合，下面的「已释放」才不是空转
        expect(
          await pollUntil(() => finalizeCtl.calls.includes(id)),
          "run 应走到收尾闭合",
        ).toBe(true);
        expect(
          await pollUntil(() => !runningTasks.has(id)),
          "闭合抛错后 runningTasks 仍永久占位（改前行为）",
        ).toBe(true);
        await settleMacrotasks();
      } finally {
        unhandled.stop();
      }
      expect(
        unhandled.list.filter((e) => e === injected),
        "闭合的错冒成了 unhandledRejection（改前行为）",
      ).toEqual([]);
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 回归：吞错只告警（记日志、带原始错误），不当成 consume 异常往外冒
  // ---------------------------------------------------------------------------
  it(
    "回归：闭合抛错只记 warn（含「收尾闭合未配对 tool 失败」与原始错误），不往外冒成「consume 异常退出」",
    async () => {
      // 保护：吞错必须留下可检索的告警（运维靠它定位杀软 / 句柄占用），而且是在源头吞掉——
      // 不能靠外层 `.catch(console.error)` 兜（那是另一层保险）。改前：没有这条告警，错直接冒出去。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const injected = injectedEacces();
      finalizeCtl.impl = async () => {
        throw injected;
      };
      installSession(id, makeAgent([makeRun()]));

      expect(await deliver(id)).toBe("sent");
      expect(
        await pollUntil(() => finalizeCtl.calls.includes(id)),
        "run 应走到收尾闭合",
      ).toBe(true);
      // warn 与闭合抛错在同一条微任务链上：让出宏任务即可确定已记
      await settleMacrotasks();

      const warned = logs.warn.find((args) =>
        String(args[0]).includes("收尾闭合未配对 tool 失败"),
      );
      expect(warned, "应记「收尾闭合未配对 tool 失败」告警").toBeDefined();
      expect(String(warned![0])).toContain(id);
      expect(warned![1], "告警应带上原始错误").toBe(injected);
      expect(
        logs.error.some((args) => String(args[0]).includes("consume 异常退出")),
        "闭合的错应在源头被吞，不该冒到外层兜底",
      ).toBe(false);
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 回归：释放后任务不被卡死
  // ---------------------------------------------------------------------------
  it(
    "回归：闭合抛错后任务不被卡死——随后再发一次 deliverAskReply 能被受理、流被消费，且不用先等「上一轮尚未结束」",
    async () => {
      // 保护：占位释放是端到端的——下一次 send 不必先走「排空等待 → 假死恢复」。
      // 改前：runningTasks 永久占位，第二次 send 在入场写「上一轮尚未结束、正在等待…」后卡在 90s 排空等待里，
      // 15s 内根本到不了 agent.send。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const injected = injectedEacces();
      // 只有第一轮的闭合抛错；之后恢复正常
      let firstCall = true;
      finalizeCtl.impl = async () => {
        if (firstCall) {
          firstCall = false;
          throw injected;
        }
        return 0;
      };
      const r1 = makeRun();
      const r2 = makeRun();
      const agent = makeAgent([r1, r2]);
      installSession(id, agent);

      expect(await deliver(id)).toBe("sent");
      expect(
        await pollUntil(() => finalizeCtl.calls.length >= 1),
        "第一轮应走到收尾闭合",
      ).toBe(true);

      // 第二次 send 不 await：改前它会卡在排空等待里，afterEach 清占位后才放它走，统一收
      const second = deliver(id);
      pending.push(second.catch(() => undefined));
      expect(
        await pollUntil(() => r2.state.streamed),
        "第二次 send 应在 15s 内被受理并开始消费（改前卡在「上一轮尚未结束」的排空等待里）",
      ).toBe(true);
      expect(await second).toBe("sent");
      expect(agent.send).toHaveBeenCalledTimes(2);

      expect(
        await pollUntil(() => !runningTasks.has(id)),
        "第二轮结束后占位应释放",
      ).toBe(true);
      expect(
        (await readEvents(id)).filter(isDrainWaitInfo),
        "第二次 send 不该经过「上一轮尚未结束」的排空等待",
      ).toHaveLength(0);
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 回归：owner 句柄的 run 在闭合抛错时也释放 owner 句柄
  // ---------------------------------------------------------------------------
  it(
    "回归：输入条唤醒起的 run（owner 句柄）被取消、收尾闭合抛错 → 占位释放，且 owner 句柄也被释放（task-op 回到无主）",
    async () => {
      // 保护：内层 finally 里的 `releaseTaskOpIf(opts.opHandle)` 同样不因闭合抛错被跳过。
      // 为什么不用 deliverAskReply：它起的 consume 持有的是 observer 句柄，release 对 observer 是 no-op、看不出区别；
      // 输入条唤醒（resumeCurrentActionWithMessage）起的 run 持有 claimTaskOp 拿到的 owner 句柄，release 漏了，
      // task-op 就永远挂着一个已死的 op 当 owner（违反「owner 要么属活 op、要么 null」的不变量）——可观测点是
      // snapshotTaskOp(id).opId 回到 null。
      // 改前：闭合抛错连 runningTasks 都不释放，release 更是走不到。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const injected = injectedEacces();
      finalizeCtl.impl = async () => {
        throw injected;
      };
      // 唤醒会 Agent.create 一个新 agent，它的 run 挂住等取消
      const r2 = makeCancellableRun();
      gates.push(r2.release);
      mockCreate.mockResolvedValue(makeAgent([r2]));

      const wake = { error: null as unknown };
      pending.push(
        resumeCurrentActionWithMessage({
          task: (await getTask(id))!,
          userMessage: "继续（输入条唤醒当前阶段）",
          apiKey: CREDS.apiKey,
          fallbackModel: CREDS.model,
        }).catch((err: unknown) => {
          wake.error = err;
        }),
      );
      expect(
        await pollUntil(() => r2.state.streamed),
        "唤醒应起出新 agent 的 run 并被消费",
      ).toBe(true);
      expect(wake.error, "唤醒不该抛错").toBeNull();
      expect(runningTasks.has(id), "run 期间应占位").toBe(true);
      expect(
        snapshotTaskOp(id).opId,
        "前置：唤醒起的 run 应由 owner 句柄持有",
      ).not.toBeNull();

      // 唤醒起的 run 被取消（stop / 硬超时 / mid-run 轮换都是这类）：consume 走普通 cancel 收尾，再进 finally
      runningTasks.get(id)!.cancel();

      expect(
        await pollUntil(() => finalizeCtl.calls.includes(id)),
        "run 应走到（抛错的）收尾闭合",
      ).toBe(true);
      expect(
        await pollUntil(() => !runningTasks.has(id)),
        "闭合抛错后 runningTasks 仍永久占位（改前行为）",
      ).toBe(true);
      // 摘 runningTasks 与 release 在 finally 里是相邻的同步语句：占位一释放，owner 句柄必已释放
      expect(
        snapshotTaskOp(id).opId,
        "owner 句柄没释放：task-op 仍挂着已死的 op 当 owner",
      ).toBeNull();
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 对照：闭合正常 → 同样释放（改前改后都成立）
  // ---------------------------------------------------------------------------
  it(
    "对照：闭合正常（真实现）→ run 结束后占位释放、会话 lastActiveAt 被刷新，且没有闭合失败告警",
    async () => {
      // 保护：修复没有改坏正常路径——闭合成功时仍然释放占位、刷新 lastActiveAt。BF 里也绿。
      // 同时验证 lastActiveAt 的观测手法本身是对的（下一条回归用例在抛错路径上用同一手法）。
      const id = alloc();
      await writeMeta(makeMeta(id));
      // impl 保持 null → finalizeCtl 转发给真实现
      const gate = makeDeferred();
      gates.push(gate.resolve);
      const r1 = makeRun(gate.promise);
      installSession(id, makeAgent([r1]));

      expect(await deliver(id)).toBe("sent");
      expect(
        await pollUntil(() => r1.state.streamed),
        "consume 应已开始消费流",
      ).toBe(true);
      expect(runningTasks.has(id), "run 期间应占位").toBe(true);

      // 把 lastActiveAt 压成明显过期的值，再放行让 run 自然结束
      const SENTINEL = 1;
      agentSessions.get(id)!.lastActiveAt = SENTINEL;
      const beforeRelease = Date.now();
      gate.resolve();

      expect(
        await pollUntil(() => !runningTasks.has(id)),
        "run 结束后应释放占位",
      ).toBe(true);
      expect(finalizeCtl.calls, "闭合应被真实调用过").toContain(id);
      expect(
        await pollUntil(
          () => (agentSessions.get(id)?.lastActiveAt ?? SENTINEL) !== SENTINEL,
        ),
        "lastActiveAt 应被刷新",
      ).toBe(true);
      expect(agentSessions.get(id)!.lastActiveAt).toBeGreaterThanOrEqual(
        beforeRelease,
      );
      expect(
        logs.warn.some((args) =>
          String(args[0]).includes("收尾闭合未配对 tool 失败"),
        ),
        "闭合正常时不该有失败告警",
      ).toBe(false);
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 回归：抛错路径仍然刷新 lastActiveAt
  // ---------------------------------------------------------------------------
  it(
    "回归：闭合抛错的路径上仍刷新会话 lastActiveAt（空闲回收 TTL 从「最后一个 run 结束」起算）",
    async () => {
      // 保护：lastActiveAt 的刷新在内层 finally 里，不因闭合抛错被跳过。
      // 改前：刷新排在 finalize 之后，抛错时永远走不到——空闲回收 TTL 会从上一次 send 起算，
      // 一个刚跑完的会话可能被当成「久未活跃」提前回收。
      // 观测：run 进行中把 lastActiveAt 压成哨兵值，放行后只要它变回一个 ≥ 放行时刻的真实时间戳，就说明刷新发生了
      // （比较前后值，不依赖墙钟比值）。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const injected = injectedEacces();
      finalizeCtl.impl = async () => {
        throw injected;
      };
      const gate = makeDeferred();
      gates.push(gate.resolve);
      const r1 = makeRun(gate.promise);
      installSession(id, makeAgent([r1]));

      expect(await deliver(id)).toBe("sent");
      expect(
        await pollUntil(() => r1.state.streamed),
        "consume 应已开始消费流",
      ).toBe(true);

      const SENTINEL = 1;
      agentSessions.get(id)!.lastActiveAt = SENTINEL;
      const beforeRelease = Date.now();
      gate.resolve();

      expect(
        await pollUntil(() => finalizeCtl.calls.includes(id)),
        "run 应走到（抛错的）收尾闭合",
      ).toBe(true);
      expect(
        await pollUntil(
          () => (agentSessions.get(id)?.lastActiveAt ?? SENTINEL) !== SENTINEL,
        ),
        "闭合抛错后 lastActiveAt 没被刷新（改前行为）",
      ).toBe(true);
      expect(agentSessions.get(id)!.lastActiveAt).toBeGreaterThanOrEqual(
        beforeRelease,
      );
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 对照：失主保护（两条收尾路径：闭合正常 / 闭合抛错）
  // ---------------------------------------------------------------------------
  it.each([["正常"], ["抛错"]] as const)(
    "对照：失主保护（闭合%s）——旧 run 的 finally 不得抹掉后继已登记的 runningTasks 记录",
    async (mode) => {
      // 保护：释放只在「runningTasks 里仍是自己那条 record」时才摘（按 instanceId）。forceClear / abortStuck 之后
      // 后继 B 换了新号，旧 consume 迟到收尾若无条件 delete，会把 B 的占位抹掉（B 随后被当成「没在跑」并发起第二个 run）。
      // 内层 finally 改造后「抛错路径」也必须保留这道门（只有在闭合挂起期间换主才构造得出来）；
      // 「正常路径」是原有语义。两条路径 BF 里都绿（改前抛错路径根本走不到 delete，正常路径有同款 iOwnRunner 门）。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const injected = injectedEacces();
      // 闭合挂在 deferred 上：「旧 run 已自然结束、卡在 finally」是确定的状态
      const hold = makeDeferred();
      gates.push(hold.resolve);
      let entered = false;
      finalizeCtl.impl = async () => {
        entered = true;
        await hold.promise;
        if (mode === "抛错") throw injected;
        return 0;
      };
      installSession(id, makeAgent([makeRun()]));

      const unhandled = collectUnhandled();
      try {
        expect(await deliver(id)).toBe("sent");
        expect(
          await pollUntil(() => entered),
          "旧 run 应已走到 finally 的闭合并挂住",
        ).toBe(true);

        // 旧 run 的 record 还在（它卡在 finally、尚未摘）；此刻后继接管：换成一条新号的 record
        const successor = {
          instanceId: allocTaskRunInstanceId(),
          agentId: "agent_successor",
          startedAt: Date.now(),
          startSnapshot: { title: "successor" },
          cancel: vi.fn(),
        };
        runningTasks.set(id, successor);
        const SENTINEL = 1;
        agentSessions.get(id)!.lastActiveAt = SENTINEL;

        hold.resolve();
        // 放行后 finally 剩下的部分全是同步 + 微任务：让出宏任务即走完
        await settleMacrotasks();

        expect(
          runningTasks.get(id),
          "旧 run 的 finally 抹掉了后继的 record",
        ).toBe(successor);
        if (mode === "正常") {
          // 正向信号：旧 finally 确实跑完了（会话 lastActiveAt 按会话实例刷新，与 runner 归属无关）
          expect(
            agentSessions.get(id)!.lastActiveAt,
            "旧 finally 应已跑完",
          ).not.toBe(SENTINEL);
        }
      } finally {
        unhandled.stop();
        runningTasks.delete(id);
      }
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 回归：send 路径的 `.catch(console.error)` 兜底
  // ---------------------------------------------------------------------------
  it(
    "回归：consume 自身异常退出（失败收尾也抛）→ 不冒 unhandledRejection，console.error 记日志，占位照常释放",
    async () => {
      // 保护：sendToTaskSessionBody 末尾 `void consumeSessionRun(...)` 带 `.catch(console.error)` 兜底。
      // 构造：consume.afterWait 插桩抛错（进 catch 块）+ failure.beforePrepare 插桩抛错（失败收尾 handleRunFailure 也抛）
      // → 异常从 catch 块逃出 consume。改前：无人接，unhandledRejection；改后：记一条「consume 异常退出」。
      // finally 里的闭合是正常的（占位照常释放，BF 里同样释放——本用例钉的只是「不冒 unhandledRejection」+ 日志）。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const bodyErr = new Error("injected: consume 主体失败");
      const failureErr = new Error("injected: 失败收尾也失败");
      setFailpoint("consume.afterWait", () => {
        throw bodyErr;
      });
      setFailpoint("failure.beforePrepare", () => {
        throw failureErr;
      });
      installSession(id, makeAgent([makeRun()]));

      const unhandled = collectUnhandled();
      try {
        expect(await deliver(id)).toBe("sent");
        expect(
          await pollUntil(() => finalizeCtl.calls.includes(id)),
          "run 应走到 finally",
        ).toBe(true);
        expect(
          await pollUntil(() => !runningTasks.has(id)),
          "占位应释放",
        ).toBe(true);
        await settleMacrotasks();
      } finally {
        unhandled.stop();
      }
      expect(
        unhandled.list.filter((e) => e === failureErr),
        "consume 的异常冒成了 unhandledRejection（改前行为）",
      ).toEqual([]);
      const logged = logs.error.find((args) =>
        String(args[0]).includes("consume 异常退出"),
      );
      expect(logged, "应记「consume 异常退出」").toBeDefined();
      expect(String(logged![0])).toContain(id);
      expect(logged![1]).toBe(failureErr);
    },
    60_000,
  );
});
