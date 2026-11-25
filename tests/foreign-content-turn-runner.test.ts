/**
 * 「别人写的内容在驱动」的一轮（foreignContentTurn）——runner 层的登记 / 收口。
 *
 * group-route 判出这一轮的指令性内容出自别人（所有者空 @ 引用了陌生人的消息 / 关联回执喂会话）后，
 * 经注入链把 `foreignContentTurn` 带到 task-runner。三条送达分支各自要在 agent 起跑（send）**之前**登记
 * scope=desktop 标记、整轮 run 结束后摘掉；否则这一轮就是一次无标记的所有者轮——
 * desktop_* / 写所有者备注 / 新建定时 / 自动推进全放行，等于陌生人借所有者的空 @ 操作了所有者的电脑。
 *
 * - 送活会话（deliverTaskQuestion + markerOnly）：tests/group-non-owner-desktop-turn.test.ts；
 * - 一次性 agent（startOneShotQuestion 第 8 参）：本文件；
 * - 唤醒（resumeCurrentActionWithMessage.foreignContentTurn → internalStartAgent）：本文件。
 *
 * 手法：Agent 换成假的，send 那一刻记录标记状态并走**真咽喉** invokeFlowshipTool 调一次 desktop_*（模拟本轮里的工具调用）；
 * run 的流挂住直到用例放行——「run 进行期间标记还在、结束后才摘」是确定状态，不靠固定 sleep。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-foreign-turn-"));
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

// 跳过 task-fs 的惰性 boot-recovery（与 fork-pending-residue 同手法）：fixture 的初始态要确定
(globalThis as unknown as Record<string, Promise<void>>)["__flowshipBootRecoveryPromiseV2__"] = Promise.resolve();

const { readMetaV06, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  agentSessions,
  clearTaskStarting,
  forkPendingTasks,
  isTaskStarting,
  pendingStopRequests,
  revokeTaskOps,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import("@/lib/server/chat-gate");
const { cleanupChatTaskState } = await import("@/lib/server/chat-pending");
const { resumeCurrentActionWithMessage, startOneShotQuestion } = await import("@/lib/server/task-runner");
const { getTask, setTaskRunStatus } = await import("@/lib/server/task-fs");
const { __resetOneShotMemoryForTest } = await import("@/lib/server/oneshot-session-memory");
const {
  __resetNonOwnerTurnGuardForTest,
  beginForeignContentMidRun,
  beginNonOwnerTurn,
  isGroupNonOwnerTurnActive,
  isLiveMarkerToken,
  isNonOwnerTurnActive,
} = await import("@/lib/server/non-owner-turn-guard");
const { invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const { installedSessionToken } = await import("./helpers/session-token");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`foreign-content-turn DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const ACTION_ID = "act_foreign";
const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
const POLL_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pollUntil = async (pred: () => boolean | Promise<boolean>, ms = POLL_MS): Promise<boolean> => {
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
    title: `foreign-turn ${id}`,
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

const fakeTool = (name: string) => ({
  name,
  label: name,
  description: "",
  parameters: {} as never,
  handler: vi.fn(async () => ({ content: [{ type: "text" as const, text: `HANDLED:${name}` }] })),
});
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

type Probe = {
  /** send 那一刻：「群成员触发」标记（任一 scope）是否已登记 */
  groupAtSend: boolean[];
  /** send 那一刻：系统工具整体硬拒的标记（scope=all）是否已登记 */
  allAtSend: boolean[];
  desktopResults: string[];
  otherResults: string[];
};
const newProbe = (): Probe => ({ groupAtSend: [], allAtSend: [], desktopResults: [], otherResults: [] });

/** 流在旁白后挂住，直到 release / cancel（wait 回 cancelled）——「run 进行中」是个可停留的确定状态 */
const makeHangingRun = () => {
  const state = { streamed: false };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const run = {
    id: `run_${Math.random().toString(36).slice(2, 8)}`,
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

/** 假 agent：send 时记录标记状态、并走真咽喉调一次 desktop_screenshot 与 submit_work；behavior=throw 时 send 抛错 */
const makeAgent = (id: string, probe: Probe, behavior: "ok" | "throw", run?: unknown) => {
  const send = vi.fn(async () => {
    probe.groupAtSend.push(isGroupNonOwnerTurnActive(id));
    probe.allAtSend.push(isNonOwnerTurnActive(id));
    probe.desktopResults.push(
      // 过期会话闸（第十八轮）：用本会话（**runner 自己刚装好的**）callerToken 调——模拟「本会话的 agent 在调工具」。
      // installedSessionToken 在 runner 没装 token 时直接抛错（不补登记 fallback）：runner 漏装 token 这里会红（第十九轮评审 R19-10）
      textOf(await invokeFlowshipTool(fakeTool("desktop_screenshot") as never, {}, installedSessionToken(id), { taskId: id } as never)),
    );
    probe.otherResults.push(
      textOf(await invokeFlowshipTool(fakeTool("submit_work") as never, {}, installedSessionToken(id), { taskId: id } as never)),
    );
    if (behavior === "throw") throw new Error("send boom（测试注入）");
    return run;
  });
  return { agentId: `agent_${id}`, close: vi.fn(), send };
};

describe("foreignContentTurn：一次性 agent / 唤醒两条分支登记「群成员触发」标记（scope=desktop）", () => {
  const ids: string[] = [];
  const releases: Array<() => void> = [];
  const pending: Array<Promise<unknown>> = [];

  const alloc = (): string => {
    const id = `t_fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  /** 走调用方（task-question-inject）的真实时序：读快照 → 盘上写 running → fire-and-forget 起 one-shot */
  const startOneShot = async (id: string, foreignContent?: boolean, scheduled?: boolean) => {
    const snapshot = (await getTask(id))!;
    await setTaskRunStatus(id, "running");
    startOneShotQuestion(snapshot, "按这个办", undefined, CREDS, undefined, undefined, scheduled, foreignContent);
  };

  /** 输入条唤醒当前 action（真实入口）；不 await——返回 outcome 供轮询 */
  const startWake = async (id: string, foreignContentTurn?: boolean) => {
    const outcome = { settled: false, error: null as unknown };
    pending.push(
      resumeCurrentActionWithMessage({
        task: (await getTask(id))!,
        userMessage: "按这个办",
        apiKey: CREDS.apiKey,
        fallbackModel: CREDS.model,
        ...(foreignContentTurn ? { foreignContentTurn: true } : {}),
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

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    __resetOneShotMemoryForTest();
    __resetNonOwnerTurnGuardForTest();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
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
    __resetNonOwnerTurnGuardForTest();
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ───────────────────────── 一次性 agent ─────────────────────────

  it("一次性 agent（foreignContent=true）：send 之前标记已登记（scope=desktop、不是系统工具硬拒）；desktop_* 被拒、别的系统工具放行；run 进行期间一直在、结束后摘掉", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    const hang = makeHangingRun();
    releases.push(hang.release);
    mockCreate.mockResolvedValue(makeAgent(id, probe, "ok", hang.run));

    await startOneShot(id, true);

    expect(await pollUntil(() => hang.state.streamed), "run 应已起来并被消费").toBe(true);
    expect(probe.groupAtSend).toEqual([true]);
    expect(probe.allAtSend).toEqual([false]);
    expect(probe.desktopResults[0]).toContain("[DENIED]");
    expect(probe.desktopResults[0]).toContain("电脑操作");
    expect(probe.otherResults[0]).toBe("HANDLED:submit_work");
    // run 进行期间标记一直在（不是只在 send 那一刻）
    expect(isGroupNonOwnerTurnActive(id), "run 进行期间标记应还在").toBe(true);

    hang.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "run 应已收尾").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "run 结束后标记仍挂着（会拒所有者自己的电脑操作）").toBe(false);
  });

  it("一次性 agent（没传 foreignContent）：没有任何标记，desktop_* 放行", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    const hang = makeHangingRun();
    releases.push(hang.release);
    mockCreate.mockResolvedValue(makeAgent(id, probe, "ok", hang.run));

    await startOneShot(id);

    expect(await pollUntil(() => hang.state.streamed)).toBe(true);
    expect(probe.groupAtSend).toEqual([false]);
    expect(probe.desktopResults[0]).toBe("HANDLED:desktop_screenshot");
    hang.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id))).toBe(true);
  });

  it("一次性 agent（foreignContent=true）：agent.send 抛错 → 标记不残留（宁可多清）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    mockCreate.mockResolvedValue(makeAgent(id, probe, "throw"));

    await startOneShot(id, true);

    expect(await pollUntil(() => probe.groupAtSend.length > 0), "send 应被调用过").toBe(true);
    expect(probe.groupAtSend).toEqual([true]);
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "失败路径也应收尾").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "send 抛错后标记残留").toBe(false);
  });

  // ───────── 属主自己的一次性 agent：启动时清掉前一轮遗留的旧标记（第十六轮评审 P3-T1） ─────────
  // internalStartAgent（属主新启动）与 sendToTaskSessionBody（属主 send 起点）都在首次 send 之前清标记；一次性 agent 原先只有「外来内容」这一支登记、
  // 属主这一支什么都不做——task 上若挂着前一轮遗留的标记（外来内容轮没收口、被强清放弃的旧 run 的残留……），属主这次问答（含定时到点那一轮）的
  // desktop_* / 写所有者备注 / 建定时会被一个不属于这一轮的旧标记拒掉——标记的寿命跟着 run 走：过了 45 分钟 TTL 时探针答「run 还活着」就续期，这一轮自己就是那个活 run，所以会一直拒到这一轮结束
  // （只有 run 不在了才按 45 分钟兜底，绝对上限 25 小时；第十七轮评审 N2 订正此前「直到 TTL（45 分钟）」的说法）——多限制、不是漏保护，但与另外两个属主起点不对称。
  // 清的位置紧贴首次 send（与 internalStartAgent 同一条纪律：清得越晚，被放弃的旧 run 受限的时间越长）；让位的 one-shot（正式 run / 活会话占位）不是这一轮的主人，不碰标记。

  it("一次性 agent（属主、没传 foreignContent）：task 上遗留的旧标记（scope=desktop），Agent.create 时还在（不早清）、send 时已清掉（desktop_* 放行）、收尾后也没有标记", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    const hang = makeHangingRun();
    releases.push(hang.release);
    const agent = makeAgent(id, probe, "ok", hang.run);
    const atCreate: boolean[] = [];
    mockCreate.mockImplementation(async () => {
      atCreate.push(isGroupNonOwnerTurnActive(id));
      return agent;
    });
    const stale = beginNonOwnerTurn(id, Date.now(), "desktop"); // 前一轮遗留的标记（没人会来收口）

    await startOneShot(id);

    expect(await pollUntil(() => hang.state.streamed), "run 应已起来并被消费").toBe(true);
    expect(atCreate, "前置：Agent.create 那一刻旧标记还在——清除要紧贴 send，不能早到 create 之前（被放弃的旧 run 没停时早清 = 提前放开）").toEqual([true]);
    expect(probe.groupAtSend, "属主这一轮 send 时还带着前一轮遗留的旧标记（desktop_* / 写所有者备注 / 建定时被白白拒）").toEqual([false]);
    expect(probe.desktopResults[0]).toBe("HANDLED:desktop_screenshot");
    expect(isLiveMarkerToken(id, stale), "旧标记应已被清掉").toBe(false);

    hang.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "run 应已收尾").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "属主的一轮不该凭空造出标记").toBe(false);
  });

  it("一次性 agent（属主）：遗留的旧标记是 scope=all（系统工具整体硬拒）时同样清掉——submit_work 之类放行；定时到点那一轮（scheduled）走同一支", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    const hang = makeHangingRun();
    releases.push(hang.release);
    mockCreate.mockResolvedValue(makeAgent(id, probe, "ok", hang.run));
    beginNonOwnerTurn(id, Date.now(), "all");
    expect(isNonOwnerTurnActive(id), "前置：旧标记是系统工具整体硬拒的那种").toBe(true);

    await startOneShot(id, undefined, true);

    expect(await pollUntil(() => hang.state.streamed), "run 应已起来并被消费").toBe(true);
    expect(probe.allAtSend, "定时到点那一轮 send 时还带着旧的整体硬拒标记").toEqual([false]);
    expect(probe.groupAtSend).toEqual([false]);
    expect(probe.otherResults[0], "整体硬拒的旧标记没清：属主这一轮的系统工具被拒").toBe("HANDLED:submit_work");
    expect(probe.desktopResults[0]).toBe("HANDLED:desktop_screenshot");
    hang.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "run 应已收尾").toBe(true);
  });

  it("一次性 agent（属主）撞上在飞的正式 run → 让位：不 create、旧标记原样不动（清除只发生在真要起跑那一刻，让位的 one-shot 不是这一轮的主人）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    mockCreate.mockResolvedValue(makeAgent(id, probe, "ok"));
    const stale = beginNonOwnerTurn(id, Date.now(), "desktop");
    // 后继的正式 run 已登记（它的标记就是这个；让位的 one-shot 碰它就是替别人放开保护）
    runningTasks.set(id, {
      instanceId: 90_002,
      agentId: "agent_formal",
      startedAt: Date.now(),
      startSnapshot: { title: "t" },
      cancel: () => {},
    } as never);

    await startOneShot(id);
    expect(await pollUntil(() => !isTaskStarting(id)), "one-shot 应已让位收尾").toBe(true);

    expect(mockCreate, "前置：让位的 one-shot 不起 agent").not.toHaveBeenCalled();
    expect(isLiveMarkerToken(id, stale), "让位的 one-shot 把别人的标记清了").toBe(true);
    expect(isGroupNonOwnerTurnActive(id)).toBe(true);
  });

  // ───────────────────────── 唤醒 ─────────────────────────

  it("唤醒（foreignContentTurn=true）：send 之前标记已登记；desktop_* 被拒、别的系统工具放行；run 进行期间一直在、结束后摘掉", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    const hang = makeHangingRun();
    releases.push(hang.release);
    mockCreate.mockResolvedValue(makeAgent(id, probe, "ok", hang.run));

    const wake = await startWake(id, true);

    expect(await pollUntil(() => hang.state.streamed), "唤醒应起出新 agent 的 run 并被消费").toBe(true);
    expect(wake.error, "唤醒不该抛错").toBeNull();
    expect(probe.groupAtSend).toEqual([true]);
    expect(probe.allAtSend).toEqual([false]);
    expect(probe.desktopResults[0]).toContain("[DENIED]");
    expect(probe.otherResults[0]).toBe("HANDLED:submit_work");
    expect(isGroupNonOwnerTurnActive(id), "run 进行期间标记应还在").toBe(true);

    hang.release();
    expect(await pollUntil(() => !runningTasks.has(id)), "run 应已收尾").toBe(true);
    expect(await pollUntil(() => !isGroupNonOwnerTurnActive(id)), "run 结束后标记仍挂着").toBe(true);
  });

  it("唤醒（foreignContentTurn=true）：agent 交卷、run 自然结束且会话刻意保留 → 标记照样摘掉（不能指望「关会话」顺带清它）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    // 假 run：吐一句旁白后「交卷」（action → awaiting_ack），随后自然结束——此时 consume 既不追问、也不关会话
    const run = {
      id: "run_submit",
      stream: async function* (): AsyncGenerator<unknown> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "旁白" }] } };
        const meta = (await readMetaV06(id))!;
        await writeMeta({
          ...meta,
          runStatus: "awaiting_user",
          actions: meta.actions.map((a) =>
            a.id === ACTION_ID ? { ...a, status: "awaiting_ack" as const, endedAt: Date.now() } : a,
          ),
        } as TaskMetaV06);
      },
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(makeAgent(id, probe, "ok", run));

    await startWake(id, true);

    expect(await pollUntil(() => probe.groupAtSend.length > 0), "send 应被调用过").toBe(true);
    expect(probe.groupAtSend).toEqual([true]);
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "run 应已收尾").toBe(true);
    // 前置：确实是「会话保留」的出口（否则这条用例就退化成「关会话清标记」那条）
    expect(agentSessions.has(id), "前置：交卷后热会话应保留").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "会话还在、标记却没人摘（会拒所有者后续的电脑操作）").toBe(false);
  });

  it("唤醒（没传 foreignContentTurn）：没有任何标记，desktop_* 放行", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    const hang = makeHangingRun();
    releases.push(hang.release);
    mockCreate.mockResolvedValue(makeAgent(id, probe, "ok", hang.run));

    await startWake(id);

    expect(await pollUntil(() => hang.state.streamed)).toBe(true);
    expect(probe.groupAtSend).toEqual([false]);
    expect(probe.desktopResults[0]).toBe("HANDLED:desktop_screenshot");
    hang.release();
    expect(await pollUntil(() => !runningTasks.has(id))).toBe(true);
  });

  it("唤醒（foreignContentTurn=true）：首次 send 抛错 → 标记不残留", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    mockCreate.mockResolvedValue(makeAgent(id, probe, "throw"));

    await startWake(id, true);

    expect(await pollUntil(() => probe.groupAtSend.length > 0), "send 应被调用过").toBe(true);
    expect(probe.groupAtSend).toEqual([true]);
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "失败路径也应收尾").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "send 抛错后标记残留").toBe(false);
    // 收尾后任务状态也别僵在 running（顺带确认失败路径照常走完）
    expect(await pollUntil(async () => (await readMetaV06(id))?.runStatus !== "running")).toBe(true);
  });

  // ───────────────────────── 中途补登（答案送进还在跑的这一轮） ─────────────────────────
  // 非属主答了 agent 挂着的 ask_user、答案由 fulfillAskWait 送回**同一轮继续**：没有新的 send，这一轮的标记只能在 run 进行中途补登
  // （beginForeignContentMidRun）。它没有 send 起点的 token，唯一的摘除点是 consumeSessionRun 收尾时的 endMidRunForeignContent——
  // 以前这条只被「源码正则」和「测试里手动调 endMidRunForeignContent」间接证明（第三轮评审 P1-4：自证）。
  // 这里走真实的 run 收尾：删掉那行，标记挂到 45 分钟 TTL，属主下一轮的 desktop_* / 写所有者备注被误拒。

  it("一次性 agent：run 进行中途补登的标记，run 收尾时被 consumeSessionRun 摘掉；进行期间在、属主轮（没传 foreignContent）本来没有标记", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    const hang = makeHangingRun();
    releases.push(hang.release);
    mockCreate.mockResolvedValue(makeAgent(id, probe, "ok", hang.run));

    await startOneShot(id); // 属主轮：起点没有标记
    expect(await pollUntil(() => hang.state.streamed)).toBe(true);
    expect(probe.groupAtSend, "前置：属主轮起点没有标记").toEqual([false]);

    // 模拟 fulfillAskWait 把别人的答案送进这一轮：此刻才补登
    expect(beginForeignContentMidRun(id), "前置：补登应成功（此刻没有任何标记）").toBeDefined();
    expect(isGroupNonOwnerTurnActive(id)).toBe(true);
    expect(isNonOwnerTurnActive(id), "补登的是 scope=desktop，不该变成系统工具硬拒").toBe(false);

    hang.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "run 应已收尾").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "run 收尾后中途补登的标记没人摘（会拒属主下一轮的电脑操作）").toBe(false);
  });

  it("唤醒：run 进行中途补登的标记，run 自然结束且会话刻意保留（交卷）时也被 consumeSessionRun 摘掉——不能指望「关会话」顺带清它", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    // 假 run：旁白后挂住（供中途补登）；放行后「交卷」（action → awaiting_ack）并自然结束——consume 既不追问、也不关会话
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    releases.push(release);
    const state = { streamed: false };
    const run = {
      id: "run_midrun_submit",
      stream: async function* (): AsyncGenerator<unknown> {
        state.streamed = true;
        yield { type: "assistant", message: { content: [{ type: "text", text: "旁白" }] } };
        await gate;
        const meta = (await readMetaV06(id))!;
        await writeMeta({
          ...meta,
          runStatus: "awaiting_user",
          actions: meta.actions.map((a) =>
            a.id === ACTION_ID ? { ...a, status: "awaiting_ack" as const, endedAt: Date.now() } : a,
          ),
        } as TaskMetaV06);
      },
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(makeAgent(id, probe, "ok", run));

    await startWake(id); // 属主轮：起点没有标记
    expect(await pollUntil(() => state.streamed)).toBe(true);
    expect(probe.groupAtSend).toEqual([false]);

    expect(beginForeignContentMidRun(id)).toBeDefined();
    expect(isGroupNonOwnerTurnActive(id)).toBe(true);

    release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "run 应已收尾").toBe(true);
    // 前置：确实是「会话保留」的出口（关会话会无条件清标记，那样这条用例就证明不了 consumeSessionRun 的清理）
    expect(agentSessions.has(id), "前置：交卷后热会话应保留").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "会话还在、中途补登的标记却没人摘（会拒属主下一轮的电脑操作）").toBe(false);
  });
});
