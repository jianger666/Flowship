/**
 * 强清（forceClearStaleRunnerState）不碰「别人的内容在驱动」标记；属主的新启动在首次 send 之前才清（第十五轮评审 P3-1）
 *
 * 历史：第十四轮评审 P3-3 发现——旧 run 满 5 秒退不出来时，advance / `resumeCurrentActionCore` / `internalStartAgent` 走强清，
 * 强清自己 `agentSessions.delete` 就把会话摘了（不经 closeTaskSession），随后调用方的 `closeTaskSession(…)` 看不到会话、在函数前段早退，
 * 到不了清标记那一行——标记留在旧 run 身上，新启动的**属主自己**那一轮带着旧标记跑（desktop_* / 写所有者备注 / 建定时被白白拒）。
 * 第十四轮的修法是在强清里 `clearNonOwnerTurn`；
 *
 * 第十五轮评审 P3-1 指出那个修法引入了新窗口：强清只是把旧 run 摘出表，并**不让它停**——
 *   · 一次性前驱（oneshot / question run）不在 agentSessions，强清不会关它的 agent；
 *   · 电脑操作闸（`desktopDeniedInNonOwnerTurn`）只看 taskId 上的标记，不核对 callerToken；
 *   所以强清清了标记之后、后继 `Agent.create` / `send` 之前，这个被强清的活 run 仍能调 desktop_*（操作所有者的电脑）。
 *
 * 修法（本文件钉的）：
 *  · 强清**不碰标记**——被强清的旧 run 在后继真正起跑之前继续受限；
 *  · 属主自己的新启动在 `internalStartAgent` 里、首次 send 之前（与 `created.send` 之间无 await）清标记——与 task 型属主 send 起点
 *    （sendToTaskSessionBody 的 `if (!opts.nonOwnerTurn) clearNonOwnerTurn`）同口径；外来内容驱动的新启动（foreignContentTurn）在同一位置重新登记，没有空窗。
 *  · 三个强清调用点（advance / resumeCurrentActionCore / internalStartAgent 的前驱处理）各有一组用例，且都断言「确实走了强清」（agent.close 被调 + 强清日志）。
 *
 * 手法：真 task-runner + 假 Cursor SDK。A = 外来内容唤醒出来的一轮，流挂住、cancel 不放行（模拟 consume 卡住、5 秒退不出来）；
 * 随后属主唤醒 / 推进（等 5 秒强清）→ 观察新 agent 的 create（强清之后、登记之前的窗口）与 send（登记点）两个时刻的标记状态，
 * 并在 create 那一刻走**真咽喉**调一次 desktop_*（窗口里被强清的旧 run 能不能动电脑）。
 * internalStartAgent 的前驱处理那一点，用 failpoint 在 advance / resume 自己的收尾之后塞一条不退场的假前驱记录（连同一个旧标记）。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

import { blockAfter, readSource } from "./helpers/source-text";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-forceclear-marker-"));
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

// 跳过 task-fs 的惰性 boot-recovery（与 foreign-content-turn-runner 同手法）：fixture 的初始态要确定
(globalThis as unknown as Record<string, Promise<void>>)["__flowshipBootRecoveryPromiseV2__"] = Promise.resolve();

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const taskStream = await import("@/lib/server/task-stream");
const {
  agentSessions,
  clearTaskStarting,
  forceClearStaleRunnerState,
  forkPendingTasks,
  pendingStopRequests,
  revokeTaskOps,
  runningTasks,
} = taskStream;
const { clearChatGate, endChatLifecycle } = await import("@/lib/server/chat-gate");
const { CALLER_MISMATCH_ERROR, cleanupChatTaskState, getExpectedCallerToken, setOneShotCallerToken } = await import(
  "@/lib/server/chat-pending"
);
const { advanceTask, resumeCurrentActionWithMessage } = await import("@/lib/server/task-runner");
const { getTask } = await import("@/lib/server/task-fs");
const { clearFailpoints, setFailpoint } = await import("@/lib/server/failpoints");
const guard = await import("@/lib/server/non-owner-turn-guard");
const { invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const { bindSessionToken } = await import("./helpers/session-token");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`task-forceclear-keeps-marker DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const ACTION_ID = "act_forceclear";
const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pollUntil = async (pred: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `forceclear-marker ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: ACTION_ID,
    actions: [
      {
        id: ACTION_ID,
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
  }) as unknown as TaskMetaV06;

/** 卡住的 run：流挂在 gate 上，cancel 不放行（consume 5 秒内退不出来）；release() 才放它走 */
const makeStuckRun = () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const state = { streamed: false };
  const run = {
    id: `run_stuck_${Math.random().toString(36).slice(2, 8)}`,
    stream: async function* (): AsyncGenerator<unknown> {
      state.streamed = true;
      yield { type: "assistant", message: { content: [{ type: "text", text: "旁白" }] } };
      await gate;
    },
    wait: vi.fn(async () => {
      await gate;
      return { status: "cancelled" as const };
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return { run, state, release };
};

/** 正常的新 run：旁白后挂住，cancel 放行 */
const makeHangingRun = () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const state = { streamed: false };
  const run = {
    id: `run_new_${Math.random().toString(36).slice(2, 8)}`,
    stream: async function* (): AsyncGenerator<unknown> {
      state.streamed = true;
      yield { type: "assistant", message: { content: [{ type: "text", text: "旁白" }] } };
      await gate;
    },
    wait: vi.fn(async () => {
      await gate;
      return { status: "cancelled" as const };
    }),
    cancel: vi.fn(async () => {
      release();
    }),
  };
  return { run, state, release };
};

/** 假 agent：send 时记录标记状态（= agent 拿到内容那一刻标记是否已就位） */
const makeAgent = (id: string, agentId: string, atSend: boolean[], run: unknown) => ({
  agentId,
  close: vi.fn(),
  send: vi.fn(async () => {
    atSend.push(guard.isGroupNonOwnerTurnActive(id));
    return run;
  }),
});

const fakeTool = (name: string) => ({
  name,
  label: name,
  description: "",
  parameters: {} as never,
  handler: vi.fn(async () => ({ content: [{ type: "text" as const, text: `HANDLED:${name}` }] })),
});
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

/** 后继 Agent.create 被调用那一刻 = 强清之后、新启动登记 / 清除自己的标记之前：标记状态，以及真咽喉对 desktop_* 的裁决 */
type AtCreate = { marker: boolean[]; desktop: string[] };
const newAtCreate = (): AtCreate => ({ marker: [], desktop: [] });
const createObserving = (id: string, agent: unknown, seen: AtCreate) => async () => {
  seen.marker.push(guard.isGroupNonOwnerTurnActive(id));
  // 过期会话闸（第十八轮）：这里要观察的是**标记**对 desktop_* 的裁决——假定调用方是该任务当前会话（登记 "tok"）；
  // 否则「Agent.create 这一刻后继的 token 还没装、没有任何合法会话」也会被闸算成拒，盖掉要看的东西（那条路径由 stale-session-gate.test.ts 另测）
  bindSessionToken(id);
  seen.desktop.push(
    textOf(await invokeFlowshipTool(fakeTool("desktop_screenshot") as never, {}, "tok", { taskId: id } as never)),
  );
  return agent;
};

/**
 * 强清之后、后继 `Agent.create` 之前那个窗口的探针（第十九轮评审 R19-3）：在假 `Agent.create` 里调 `observe()`，记下
 *  · 表里此刻的期望 token——强清同步作废旧 token，所以应当是 null（没有任何合法会话）；
 *  · 旧 run 用它自己的旧 token 调 desktop_* 的裁决。窗口里标记本来还在、会先拒；这里先摘掉标记（`clearNonOwnerTurn`），
 *    单看 callerToken 这一道闸（= 属主的新启动清标记之后、后继装好 token 之前，旧 run 还剩的唯一一道限制）。
 * 修前（强清只摘 runner / 会话、不碰 token 表）：表里还是旧 token → 旧 run 的调用通过咽喉、handler 被调。
 * 每个探针只能在一次 `Agent.create` 里用（`expectBlocked` 断言恰好观察了一次）。
 */
const windowProbe = (id: string, staleToken: string) => {
  const seen = { table: [] as Array<string | null>, out: [] as string[], handled: 0 };
  return {
    observe: async () => {
      seen.table.push(getExpectedCallerToken(id));
      guard.clearNonOwnerTurn(id);
      const stale = fakeTool("desktop_screenshot");
      seen.out.push(textOf(await invokeFlowshipTool(stale as never, {}, staleToken, { taskId: id } as never)));
      seen.handled += stale.handler.mock.calls.length;
    },
    expectBlocked: (where: string) => {
      expect(seen.table, `${where}：强清之后、后继 Agent.create 之前（观察恰好一次），表里不该还有旧 token`).toEqual([null]);
      expect(seen.out, `${where}：窗口里旧 run 用旧 token 调 desktop_* 被放行——强清没有作废 token`).toEqual([CALLER_MISMATCH_ERROR]);
      expect(seen.handled, `${where}：旧 run 的 handler 被调了`).toBe(0);
    },
  };
};

/** 不退场的假前驱记录（internalStartAgent 的前驱处理：cancel 之后 5 秒还在表里 → 强清） */
const makeFakePredecessor = () => ({
  instanceId: 90_001,
  agentId: "agent_fake_predecessor",
  cancel: vi.fn(),
});

/** 旁听 beginNonOwnerTurn（调用穿透到真实现）：拿到每次登记返回的 token——用来分清「新启动重新登记了」和「旧标记原样留着」 */
const spyRegistrations = () => vi.spyOn(guard, "beginNonOwnerTurn");
/** 旁听到的登记里、此刻仍是这个 task 上活标记的 token（取最近一个）；一个都不活 → undefined */
const liveRegisteredToken = (spy: ReturnType<typeof spyRegistrations>, id: string): string | undefined => {
  const live = spy.mock.results
    .map((r) => r.value as string | undefined)
    .filter((t): t is string => typeof t === "string" && guard.isLiveMarkerToken(id, t));
  return live[live.length - 1];
};

describe("强清不碰标记、属主新启动在首次 send 前才清（第十五轮评审 P3-1）", () => {
  const ids: string[] = [];
  const releases: Array<() => void> = [];
  const pending: Array<Promise<unknown>> = [];
  /**
   * 记下每次 `forceClearStaleRunnerState` 调用（调用穿透到真实现）：用例据此断言「确实走了强清」。
   * 不能靠日志——resume 点的强清不打日志；也不能靠「旧 agent 的 close 被调」——旧会话被正常摘掉时 close 同样会被调
   */
  const forceClearCalls: string[] = [];
  const alloc = (): string => {
    const id = `t_fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };


  const startWake = async (id: string, foreignContentTurn?: boolean) => {
    const outcome = { error: null as unknown };
    pending.push(
      resumeCurrentActionWithMessage({
        task: (await getTask(id))!,
        userMessage: "按这个办",
        apiKey: CREDS.apiKey,
        fallbackModel: CREDS.model,
        ...(foreignContentTurn ? { foreignContentTurn: true } : {}),
      }).catch((err: unknown) => {
        outcome.error = err;
      }),
    );
    return outcome;
  };

  const startAdvance = async (id: string) => {
    const outcome = { error: null as unknown };
    pending.push(
      advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "推进一下",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }).catch((err: unknown) => {
        outcome.error = err;
      }),
    );
    return outcome;
  };

  /** 起 A（外来内容唤醒出来的一轮、流挂住、cancel 不放行）并等它被消费；返回 A 的探针 */
  const startStuckForeignA = async (id: string) => {
    const stuck = makeStuckRun();
    releases.push(stuck.release);
    const atSendA: boolean[] = [];
    const agentA = makeAgent(id, `agent_a_${id}`, atSendA, stuck.run);
    mockCreate.mockResolvedValueOnce(agentA);
    await startWake(id, true);
    expect(await pollUntil(() => stuck.state.streamed), "A 的 run 应已起来并被消费").toBe(true);
    expect(atSendA, "前置：A 是外来内容驱动的一轮、send 时标记在").toEqual([true]);
    expect(guard.isGroupNonOwnerTurnActive(id), "前置：A 在跑、标记在").toBe(true);
    return { stuck, agentA };
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    clearFailpoints();
    guard.__resetNonOwnerTurnGuardForTest();
    vi.spyOn(console, "log").mockImplementation(() => {});
    forceClearCalls.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(taskStream, "forceClearStaleRunnerState").mockImplementation((taskId: string) => {
      forceClearCalls.push(taskId);
      forceClearStaleRunnerState(taskId);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    clearFailpoints();
    vi.restoreAllMocks();
    for (const release of releases.splice(0)) release();
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      forkPendingTasks.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
      revokeTaskOps(id);
      cleanupChatTaskState(id);
    }
    await Promise.allSettled(pending.splice(0));
    guard.__resetNonOwnerTurnGuardForTest();
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("forceClearStaleRunnerState：runner / forkPending / pendingStop / 会话（含关 agent）一起清，**标记不碰**——被强清的旧 run 在后继真起跑之前继续受限", async () => {
    const id = alloc();
    guard.beginNonOwnerTurn(id, Date.now(), "desktop");
    runningTasks.set(id, { instanceId: 1 } as never);
    forkPendingTasks.add(id);
    pendingStopRequests.add(id);
    const close = vi.fn();
    agentSessions.set(id, { agent: { close }, agentId: "agent_old", instanceId: 1 } as never);
    expect(guard.isGroupNonOwnerTurnActive(id)).toBe(true);

    forceClearStaleRunnerState(id);

    expect(runningTasks.has(id)).toBe(false);
    expect(forkPendingTasks.has(id)).toBe(false);
    expect(pendingStopRequests.has(id)).toBe(false);
    expect(agentSessions.has(id)).toBe(false);
    expect(close, "强清要关会话里的 agent").toHaveBeenCalled();
    expect(
      guard.isGroupNonOwnerTurnActive(id),
      "强清清了标记：被强清的活 run（一次性前驱不在 agentSessions、agent 没被关）在后继起跑之前能调 desktop_*",
    ).toBe(true);
    // 真咽喉：这个窗口里 desktop_* 照样被拒
    const shot = fakeTool("desktop_screenshot");
    expect(textOf(await invokeFlowshipTool(shot as never, {}, "tok", { taskId: id } as never))).toContain("[DENIED]");
    expect(shot.handler).not.toHaveBeenCalled();
  });

  describe("resumeCurrentActionCore 的强清点（输入条唤醒）", () => {
    it(
      "属主唤醒撞上卡住的外来内容 run（5 秒没退、强清）：强清之后到后继 send 之前旧标记还在（desktop_* 被拒）、send 时才被属主的新启动清掉",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const { stuck, agentA } = await startStuckForeignA(id);
        const atSendB: boolean[] = [];
        const atCreateB = newAtCreate();
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        mockCreate.mockImplementation(createObserving(id, makeAgent(id, `agent_b_${id}`, atSendB, hangB.run), atCreateB));

        // 属主（不带 foreignContentTurn）唤醒：取消 A、等 5 秒 → A 卡住退不出来 → 强清 → 起 B
        const wake = await startWake(id);
        expect(await pollUntil(() => atSendB.length > 0, 20_000), "B 应在强清之后起来并 send").toBe(true);
        expect(wake.error, "唤醒不该抛错").toBeNull();
        expect(stuck.run.cancel, "前置：A 被取消过（走的是「取消 → 等 5 秒 → 强清」）").toHaveBeenCalled();
        expect(forceClearCalls, "前置：确实走了强清（不是 A 自己退出的）").toContain(id);
        expect(agentA.close, "前置：强清关了 A 的会话 agent").toHaveBeenCalled();

        // 窗口：强清之后、B 起跑之前，A 仍是活 run、仍受限——修前（强清清标记）这里是 [false] / HANDLED
        expect(atCreateB.marker, "强清清了标记：B create 时 A（活 run）已经不受限制").toEqual([true]);
        expect(atCreateB.desktop[0], "窗口里被强清的旧 run 能调 desktop_*").toContain("[DENIED]");
        // 属主这一轮：send 时标记没了（属主新启动在首次 send 前清）
        expect(atSendB, "属主自己的新启动 send 时还带着旧标记（desktop_* / 写所有者备注 / 建定时被白白拒）").toEqual([false]);
      },
      40_000,
    );

    it(
      "T2 收口（第十八轮，过期会话闸）：旧 run 被强清放弃但没停，属主新启动清掉标记之后，旧 run 的 desktop_* / 恒拒清单靠 callerToken 仍被拒、后继（属主这一轮）照常放行",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const { agentA } = await startStuckForeignA(id);
        // 真 installSessionIfCurrent 登记的 A 的会话 token（任务表 / chat-pending 共用的那一张）
        const tokenA = getExpectedCallerToken(id);
        expect(tokenA, "前置：A 的会话 token 已登记").toBeTruthy();
        const atSendB: boolean[] = [];
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        // 不用 createObserving：它会把 token 绑成 "tok"、盖掉真 token；这里要的是 runner 自己装的那个
        mockCreate.mockImplementation(async () => makeAgent(id, `agent_b_${id}`, atSendB, hangB.run));
        // R19-10 顺序钉子的探针：旁听 clearNonOwnerTurn（穿透到真实现），记下「清的时候标记还活着」的那几次里、表中当前的 token
        const clearsWhileLive: Array<string | null> = [];
        const realClear = guard.clearNonOwnerTurn;
        vi.spyOn(guard, "clearNonOwnerTurn").mockImplementation((taskId: string) => {
          if (taskId === id && guard.isGroupNonOwnerTurnActive(id)) clearsWhileLive.push(getExpectedCallerToken(id));
          return realClear(taskId);
        });

        // 属主（不带 foreignContentTurn）唤醒：取消 A、等 5 秒 → A 退不出来 → 强清 → 起 B；B send 之前属主新启动清标记
        const wake = await startWake(id);
        expect(await pollUntil(() => atSendB.length > 0, 20_000), "B 应在强清之后起来并 send").toBe(true);
        expect(wake.error, "唤醒不该抛错").toBeNull();
        expect(forceClearCalls, "前置：确实走了强清（A 没有自己退出）").toContain(id);
        expect(agentA.close, "前置：强清关了 A 的会话 agent（但一次性前驱 / 卡住的 run 未必真停）").toHaveBeenCalled();
        expect(atSendB, "前置：属主这一轮 send 时标记已清").toEqual([false]);
        expect(guard.isGroupNonOwnerTurnActive(id), "前置：标记确实没了——旧 run 此刻不再被标记限制，只剩 token 这一道").toBe(false);
        const tokenB = getExpectedCallerToken(id);
        expect(tokenB, "前置：B 装了自己的 token").toBeTruthy();
        expect(tokenB, "B 的 token 不该与 A 相同").not.toBe(tokenA);

        // R19-10 顺序钉子（第十九轮评审）：属主新启动清标记的那一刻，后继（B）的 token 已经装好——先 token、后标记。
        // 此前这条顺序没人钉，T2 真链路只在后继 send 之后采样（那时两样都已就位，顺序反了也看不出）
        expect(clearsWhileLive.length, "前置：属主新启动清掉了仍活着的外来标记（至少一次）").toBeGreaterThanOrEqual(1);
        expect(
          clearsWhileLive,
          "清标记的那一刻后继 token 还没装好（顺序反了：先清标记、后装 token——这个空窗里旧 run 只剩 token 一道、而它的 token 此刻是被强清作废后的空表）",
        ).toEqual(clearsWhileLive.map(() => tokenB));

        // R19-10 运行时接线：上面是手工拿 tokenA / tokenB 调咽喉；这里直接调**真 runner 交给 SDK 的工具闭包**（Agent.create 的 local.customTools）——
        // 闭包里带的 token 不是各自会话登记的那个（接线断了 / 取错 / 没带）这里会红。用 set_owner_note：受限、且 task_id 入参 + content 传空串 = 清空备注，无副作用
        type SdkTool = { execute: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };
        const closureTool = (createCall: number, name: string): SdkTool => {
          const opts = mockCreate.mock.calls[createCall]?.[0] as { local?: { customTools?: Record<string, SdkTool> } } | undefined;
          const t = opts?.local?.customTools?.[name];
          if (!t) throw new Error(`第 ${createCall} 次 Agent.create 没挂 ${name} 闭包——runner 没把系统工具交给 SDK？`);
          return t;
        };
        const staleViaClosure = await closureTool(0, "set_owner_note").execute({ task_id: id, content: "" });
        expect(staleViaClosure.isError, "A 的真闭包（带着 A 的 token）在 B 接管之后调受限工具：该被过期会话闸拒").toBe(true);
        expect(textOf(staleViaClosure)).toBe(JSON.stringify({ ok: false, error: CALLER_MISMATCH_ERROR }));
        const ownViaClosure = await closureTool(1, "set_owner_note").execute({ task_id: id, content: "" });
        expect(
          JSON.parse(textOf(ownViaClosure)),
          "B 的真闭包调受限工具被拒：runner 交给 SDK 的闭包里带的不是 B 登记的 token（接线断了）",
        ).toMatchObject({ ok: true });

        // A 仍是活 run：电脑操作 / 恒拒清单（browser_evaluate）被过期会话闸拒、handler 一次没调；B 同样的调用放行
        for (const [name, args] of [
          ["desktop_screenshot", {}],
          ["browser_evaluate", { expression: "1" }],
        ] as Array<[string, Record<string, unknown>]>) {
          const stale = fakeTool(name);
          expect(
            textOf(await invokeFlowshipTool(stale as never, args, tokenA!, { taskId: id } as never)),
            `标记没了之后旧 run（A）调 ${name} 被放行：过期会话闸没有拦住`,
          ).toBe(CALLER_MISMATCH_ERROR);
          expect(stale.handler).not.toHaveBeenCalled();
          const own = fakeTool(name);
          expect(textOf(await invokeFlowshipTool(own as never, args, tokenB!, { taskId: id } as never)), `B 调 ${name}`).toBe(
            `HANDLED:${name}`,
          );
        }
      },
      40_000,
    );

    it(
      "R19-3（第十九轮评审）：强清同步作废旧 token——强清之后、后继装好 token 之前，表里没有 A 的 token，旧 run（A）的受限调用已被过期会话闸拒（不等后继装好）",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const { stuck } = await startStuckForeignA(id);
        const tokenA = getExpectedCallerToken(id);
        expect(tokenA, "前置：A 的会话 token 已登记（强清前它是表里「当前」那个）").toBeTruthy();
        const atCreate = windowProbe(id, tokenA!);
        const atSendB: boolean[] = [];
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        mockCreate.mockImplementation(async () => {
          await atCreate.observe();
          return makeAgent(id, `agent_b_${id}`, atSendB, hangB.run);
        });

        const wake = await startWake(id);
        expect(await pollUntil(() => atSendB.length > 0, 20_000), "B 应在强清之后起来并 send").toBe(true);
        expect(wake.error, "唤醒不该抛错").toBeNull();
        expect(stuck.run.cancel, "前置：A 被取消过").toHaveBeenCalled();
        expect(forceClearCalls, "前置：确实走了强清（A 没有自己退出）").toContain(id);
        atCreate.expectBlocked("resumeCurrentActionCore 的强清点");
        // 后继装好后：表里是 B 自己的新 token，与 A 的不同
        const tokenB = getExpectedCallerToken(id);
        expect(tokenB, "B 装好自己的 token").toBeTruthy();
        expect(tokenB).not.toBe(tokenA);
      },
      40_000,
    );

    it(
      "R19-3：前驱处理点（internalStartAgent 的前驱强清）同样作废旧 token——前驱留在表里的 token（一次性问答登记的那种）在后继 Agent.create 之前已被摘",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const pred = makeFakePredecessor();
        const tokenP = "tok-predecessor-oneshot";
        // 与上面「前驱处理点」那条同一个插桩：resume 自己的收尾之后塞一条不退场的前驱；这次再给它登记一个一次性问答 token
        setFailpoint("resume.beforeStatusWrite", async () => {
          guard.beginNonOwnerTurn(id, Date.now(), "desktop");
          runningTasks.set(id, pred as never);
          setOneShotCallerToken(id, tokenP);
        });
        const atCreate = windowProbe(id, tokenP);
        const atSendB: boolean[] = [];
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        mockCreate.mockImplementation(async () => {
          await atCreate.observe();
          return makeAgent(id, `agent_b_${id}`, atSendB, hangB.run);
        });

        const wake = await startWake(id, true);
        expect(await pollUntil(() => atSendB.length > 0, 20_000), "B 应在强清前驱之后起来并 send").toBe(true);
        expect(wake.error).toBeNull();
        expect(pred.cancel, "前置：前驱被取消过").toHaveBeenCalled();
        expect(forceClearCalls, "前置：走了 internalStartAgent 的前驱强清").toContain(id);
        atCreate.expectBlocked("internalStartAgent 的前驱强清点");
      },
      40_000,
    );

    it(
      "外来内容驱动的新启动（foreignContentTurn）撞上卡住的旧 run、强清之后：旧标记一直在、新启动 send 时重新登记（同一位置、无空窗）；A 迟到的收尾不得清掉 B 的标记",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const registered = spyRegistrations();
        const { stuck } = await startStuckForeignA(id);
        const tokenA = liveRegisteredToken(registered, id);
        expect(tokenA, "前置：A 登记的标记此刻活着，且我们拿到了它的 token").toBeTruthy();
        const atSendB: boolean[] = [];
        const atCreateB = newAtCreate();
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        mockCreate.mockImplementation(createObserving(id, makeAgent(id, `agent_b_${id}`, atSendB, hangB.run), atCreateB));

        await startWake(id, true); // 新一轮同样是外来内容驱动
        expect(await pollUntil(() => atSendB.length > 0, 20_000), "B 应在强清之后起来并 send").toBe(true);
        expect(forceClearCalls, "前置：确实走了强清").toContain(id);
        expect(atCreateB.marker, "窗口里标记不断（强清不清、新启动还没登记）").toEqual([true]);
        expect(atCreateB.desktop[0]).toContain("[DENIED]");
        expect(atSendB, "外来内容驱动的新启动：send 时标记必须在").toEqual([true]);
        expect(guard.isGroupNonOwnerTurnActive(id), "B 在跑、标记在").toBe(true);
        // 光看「标记在」分不清是 B 重新登记了、还是 A 留下的旧标记原样留着（删掉 internalStartAgent 的登记分支，这几条照样绿）——
        // 所以对 token：此刻活着的是 B 登记的新标记，A 的旧 token 已被覆盖（第十六轮评审 P3-T3）
        const tokenB = liveRegisteredToken(registered, id);
        expect(tokenB, "B 在跑、标记在，而且是它自己登记的那一个").toBeTruthy();
        expect(tokenB, "B send 时活着的还是 A 的旧标记：外来内容驱动的新启动没有重新登记").not.toBe(tokenA);
        expect(guard.isLiveMarkerToken(id, tokenA), "A 的旧标记应已被 B 的登记覆盖").toBe(false);

        // A 迟到的收尾（按 token / 按名）不得清掉 B 的标记
        stuck.release();
        await sleep(200);
        expect(guard.isGroupNonOwnerTurnActive(id), "A 迟到收尾把 B 的标记清了").toBe(true);

        hangB.release();
        expect(await pollUntil(() => !runningTasks.has(id)), "B 应已收尾").toBe(true);
        expect(await pollUntil(() => !guard.isGroupNonOwnerTurnActive(id)), "B 收尾后标记没人摘").toBe(true);
      },
      40_000,
    );

    it(
      "对照：旧 run 正常响应取消（没走强清）：属主唤醒的新 agent create / send 时都没有标记（旧 run 的收尾按 token 清）",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const hangA = makeHangingRun(); // cancel 放行：旧 run 立刻退
        releases.push(hangA.release);
        const atSendA: boolean[] = [];
        mockCreate.mockResolvedValueOnce(makeAgent(id, `agent_a_${id}`, atSendA, hangA.run));
        await startWake(id, true);
        expect(await pollUntil(() => hangA.state.streamed)).toBe(true);
        expect(atSendA).toEqual([true]);

        const atSendB: boolean[] = [];
        const atCreateB = newAtCreate();
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        mockCreate.mockImplementation(createObserving(id, makeAgent(id, `agent_b_${id}`, atSendB, hangB.run), atCreateB));

        await startWake(id);
        expect(await pollUntil(() => atSendB.length > 0, 20_000)).toBe(true);
        expect(hangA.run.cancel).toHaveBeenCalled();
        expect(forceClearCalls, "对照：这一条不该走强清").not.toContain(id);
        expect(atCreateB.marker, "A 正常收尾已按 token 清了标记").toEqual([false]);
        expect(atCreateB.desktop[0]).toBe("HANDLED:desktop_screenshot");
        expect(atSendB).toEqual([false]);
      },
      40_000,
    );

    it(
      "internalStartAgent 的前驱处理点（经输入条唤醒：前驱 cancel 后 5 秒仍在表里 → 强清）：旧标记在窗口里保持、外来内容驱动的新启动 send 时重新登记",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const pred = makeFakePredecessor();
        // resume 自己的收尾（existingRecord 处理 / closeTaskSession）之后、internalStartAgent 之前塞一条不退场的前驱 + 它的旧标记
        let oldToken: string | undefined;
        setFailpoint("resume.beforeStatusWrite", async () => {
          oldToken = guard.beginNonOwnerTurn(id, Date.now(), "desktop");
          runningTasks.set(id, pred as never);
        });
        const atSendB: boolean[] = [];
        const atCreateB = newAtCreate();
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        mockCreate.mockImplementation(createObserving(id, makeAgent(id, `agent_b_${id}`, atSendB, hangB.run), atCreateB));

        const wake = await startWake(id, true);
        expect(await pollUntil(() => atSendB.length > 0, 20_000), "B 应在强清前驱之后起来并 send").toBe(true);
        expect(wake.error).toBeNull();
        expect(pred.cancel, "前置：前驱被取消过").toHaveBeenCalled();
        expect(forceClearCalls, "前置：走了 internalStartAgent 的前驱强清").toContain(id);
        expect(atCreateB.marker, "窗口里旧标记应还在").toEqual([true]);
        expect(atCreateB.desktop[0]).toContain("[DENIED]");
        expect(atSendB, "外来内容驱动的新启动 send 时标记必须在").toEqual([true]);
        // 「send 时标记在」既可能是新启动重新登记了，也可能是假前驱留下的旧标记原样留着——删掉 internalStartAgent 的登记分支这条用例照样绿。
        // 所以对 token：旧标记已被新启动的登记覆盖，而标记本身仍在（B 还挂着没收尾）（第十六轮评审 P3-T3）
        expect(oldToken, "前置：failpoint 里登记过旧标记").toBeTruthy();
        expect(guard.isLiveMarkerToken(id, oldToken), "假前驱的旧标记原样留着：外来内容驱动的新启动没有重新登记").toBe(false);
        expect(guard.isGroupNonOwnerTurnActive(id), "B 在跑、标记在（新登记的那一个）").toBe(true);
      },
      40_000,
    );
  });

  describe("advanceTaskCore 的强清点（推进）", () => {
    it(
      "属主推进撞上卡住的外来内容 run（5 秒没退、强清）：窗口里旧标记还在（desktop_* 被拒）、新 agent send 时才被属主的新启动清掉",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const { stuck, agentA } = await startStuckForeignA(id);
        const atSendB: boolean[] = [];
        const atCreateB = newAtCreate();
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        mockCreate.mockImplementation(createObserving(id, makeAgent(id, `agent_b_${id}`, atSendB, hangB.run), atCreateB));

        const adv = await startAdvance(id);
        expect(await pollUntil(() => atSendB.length > 0, 20_000), "B 应在强清之后起来并 send").toBe(true);
        expect(adv.error, "推进不该抛错").toBeNull();
        expect(stuck.run.cancel, "前置：A 被取消过").toHaveBeenCalled();
        expect(forceClearCalls, "前置：advance 走了「旧 agent 没在 5s 内停、强清」").toContain(id);
        expect(agentA.close, "前置：强清关了 A 的会话 agent").toHaveBeenCalled();
        expect(atCreateB.marker, "强清清了标记：B create 时 A（活 run）已经不受限制").toEqual([true]);
        expect(atCreateB.desktop[0], "窗口里被强清的旧 run 能调 desktop_*").toContain("[DENIED]");
        expect(atSendB, "属主推进的新 agent send 时还带着旧标记").toEqual([false]);
      },
      40_000,
    );

    it(
      "R19-3：advanceTask 的强清点同样同步作废旧 token——强清之后、后继 Agent.create 之前，A 的受限调用已被过期会话闸拒",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const { stuck } = await startStuckForeignA(id);
        const tokenA = getExpectedCallerToken(id);
        expect(tokenA, "前置：A 的会话 token 已登记").toBeTruthy();
        const atCreate = windowProbe(id, tokenA!);
        const atSendB: boolean[] = [];
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        mockCreate.mockImplementation(async () => {
          await atCreate.observe();
          return makeAgent(id, `agent_b_${id}`, atSendB, hangB.run);
        });

        const adv = await startAdvance(id);
        expect(await pollUntil(() => atSendB.length > 0, 20_000), "B 应在强清之后起来并 send").toBe(true);
        expect(adv.error, "推进不该抛错").toBeNull();
        expect(stuck.run.cancel, "前置：A 被取消过").toHaveBeenCalled();
        expect(forceClearCalls, "前置：advance 走了「旧 agent 没在 5s 内停、强清」").toContain(id);
        atCreate.expectBlocked("advanceTask 的强清点");
      },
      40_000,
    );

    it(
      "internalStartAgent 的前驱处理点（经推进：advance 自己没有活 run、前驱是之后冒出来的）：旧标记在窗口里保持、属主的新启动 send 时才清",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const pred = makeFakePredecessor();
        // advance 自己的收尾（closeTaskSession / supersede）之后、internalStartAgent 之前
        setFailpoint("advance.beforeHandoff", async () => {
          guard.beginNonOwnerTurn(id, Date.now(), "desktop");
          runningTasks.set(id, pred as never);
        });
        const atSendB: boolean[] = [];
        const atCreateB = newAtCreate();
        const hangB = makeHangingRun();
        releases.push(hangB.release);
        mockCreate.mockImplementation(createObserving(id, makeAgent(id, `agent_b_${id}`, atSendB, hangB.run), atCreateB));

        const adv = await startAdvance(id);
        expect(await pollUntil(() => atSendB.length > 0, 20_000), "B 应在强清前驱之后起来并 send").toBe(true);
        expect(adv.error).toBeNull();
        expect(pred.cancel, "前置：前驱被取消过").toHaveBeenCalled();
        expect(forceClearCalls, "前置：走了 internalStartAgent 的前驱强清").toContain(id);
        expect(atCreateB.marker, "窗口里旧标记应还在").toEqual([true]);
        expect(atCreateB.desktop[0]).toContain("[DENIED]");
        expect(atSendB, "属主推进的新 agent send 时还带着旧标记").toEqual([false]);
      },
      40_000,
    );
  });

  describe("internalStartAgent 的标记收口（第十六轮评审 P3-T3；第十五轮变异 TB6 存活）", () => {
    it(
      "外来内容驱动的新启动在 send 受理之后失主、会话也已被别人摘走（让位、不进 consume）：标记只能由 internalStartAgent 的 finally 按 token 收",
      async () => {
        const id = alloc();
        await writeMeta(makeMeta(id));
        const hang = makeHangingRun();
        releases.push(hang.release);
        const atSend: boolean[] = [];
        mockCreate.mockResolvedValueOnce(makeAgent(id, `agent_y_${id}`, atSend, hang.run));
        // `created.send` 返回之后、`isOpOwner` 复查之前：别路接管了本 task 的 op（revokeTaskOps），并把会话摘走了（强清就是这么摘的、不碰标记）。
        // 让位出口里 `sess?.agent !== created` → 只关本地对象、不走 closeTaskSession（它自带的 clearNonOwnerTurn 就不会替我们清）
        setFailpoint("start.afterSend", async () => {
          revokeTaskOps(id);
          agentSessions.delete(id);
        });

        const wake = await startWake(id, true);
        expect(await pollUntil(() => atSend.length > 0), "新启动应已 send").toBe(true);
        expect(atSend, "send 时标记在（外来内容驱动）").toEqual([true]);
        expect(
          await pollUntil(() => hang.run.cancel.mock.calls.length > 0),
          "前置：走的是「send 受理之后失主 → cancel 刚受理的 run」那个出口，不进 consumeSessionRun",
        ).toBe(true);
        expect(
          await pollUntil(() => !guard.isGroupNonOwnerTurnActive(id)),
          "让位出口没人收标记：internalStartAgent 的 finally 里按 token 收口那一行被删了（TB6）",
        ).toBe(true);
        expect(wake.error, "唤醒不该抛错").toBeNull();
      },
      40_000,
    );

    it("源码契约：标记收口块（外来 → 登记 / 属主 → 清）与 `created.send` 之间没有任何语句、没有 await；登记 token 只有这一处", () => {
      const src = readSource("src/lib/server/task-runner.ts");
      // 这个位置是新启动「接管 task 上标记」的唯一位置，与 created.send 之间不得有 await（有了就又多一个窗口：旧 run 受限的状态在这里
      // 要么被提前解除、要么外来内容先于标记到达 agent）。此前没有任何用例钉着（第十六轮评审 P3-T3）；读剥掉注释的源码，只能防回退
      expect(src).toMatch(
        /if \(input\.foreignContentTurn\) \{\s*foreignContentToken = beginNonOwnerTurn\(task\.id, Date\.now\(\), input\.foreignContentScope \?\? "desktop"\);\s*\} else \{\s*clearNonOwnerTurn\(task\.id\);\s*\}\s*const run = await withSdkDeadline\(\s*created\.send\(superPrompt,/,
      );
      expect(src.match(/foreignContentToken = beginNonOwnerTurn\(/g)?.length, "internalStartAgent 里登记 token 的位置").toBe(1);
      // 收尾：finally 里按同一个 token 收（TB6 的行为用例钉的是它的效果；这里钉它还在这个 finally 里、紧挨着 endTaskStarting）
      expect(src).toMatch(/\} finally \{\s*endNonOwnerTurn\(task\.id, foreignContentToken\);\s*endTaskStarting\(task\.id\);\s*\}/);
    });
  });

  describe("强清作废旧 token（第十九轮评审 R19-3）", () => {
    it("源码契约：`forceClearStaleRunnerState` 是同步函数、函数体里有 `invalidateCallerToken(taskId)`，且不碰标记（clearNonOwnerTurn / endNonOwnerTurn / rollback 都不出现）", () => {
      const src = readSource("src/lib/server/task-stream.ts");
      const head = "export const forceClearStaleRunnerState = (taskId: string): void => {";
      expect(src, "forceClearStaleRunnerState 必须是同步函数（有 async / await 就不再与摘表在同一个同步段里）").toContain(head);
      const body = blockAfter(src, head);
      expect(body).toContain("invalidateCallerToken(taskId);");
      expect(body, "同步段里不得有 await").not.toMatch(/\bawait\b/);
      expect(body, "强清不碰标记（P3-1 的前提：被强清的旧 run 在后继起跑之前继续受限）").not.toMatch(
        /clearNonOwnerTurn|endNonOwnerTurn|rollbackForeignContentMidRun|endMidRunForeignContent/,
      );
    });
  });
});
