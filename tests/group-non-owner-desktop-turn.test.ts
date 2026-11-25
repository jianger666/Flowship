/**
 * 群里非属主触发的一轮 × 电脑操作：与「只答疑」提示词开关解耦（task-runner：deliverTaskQuestion → sendToTaskSession）
 *
 * 背景：电脑操作会看属主的屏幕、动键鼠、锁屏时用属主的开机密码解锁。以前它的「非属主不放行」只靠提示词开关开着时登记的
 * 标记——开关一关（群成员与属主同权），群里任何人都能让 AI 动属主的电脑。现在开关关着的群非属主轮也在 agent.send 之前登记
 * 一个 scope=desktop 的标记（只拦 desktop_*，其它系统工具照常放行）。
 *
 * 真 deliverTaskQuestion + 假会话 / 假 run（同 non-owner-turn-lifecycle 的手法），钉死：
 * - guard 关（同权）的真人 / 机器人轮：send 那一刻 isGroupNonOwnerTurnActive 已为真、isNonOwnerTurnActive 仍为假
 *   （系统工具不被整体硬拒、消息不加约束段）；这一轮里 agent 调 desktop_* 被拒、调别的系统工具放行；run 收尾后标记清掉
 * - guard 开：行为不变（scope=all，两者皆真，desktop_* 被拒）
 * - 属主的轮：没有标记，desktop_* 放行；属主紧随其后的 send 起点无条件清掉漏下的 scope=desktop 标记
 * - agent.send 抛错 / stale 出口 / closeTaskSession：标记不残留
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-group-desktop-turn-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
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
vi.mock("@/lib/server/kill-orphans", () => ({ reapTaskOrphans: vi.fn() }));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));
vi.mock("@/lib/server/chat-pending", async () => {
  // 真的 buildAgentMessage：要验消息里确有 / 没有约束段
  const actual = await vi.importActual<typeof import("@/lib/server/chat-pending")>("@/lib/server/chat-pending");
  return {
    cleanupChatTaskState: vi.fn(),
    invalidateCallerToken: vi.fn(),
    buildAgentMessage: actual.buildAgentMessage,
    // 过期会话闸（第十八轮）：咽喉（invokeFlowshipTool）用真的 token 核对——表是真的，下面 installSession 里按「当前会话」登记 "tok"；其余仍是桩
    matchExpectedCallerToken: actual.matchExpectedCallerToken,
    CALLER_MISMATCH_ERROR: actual.CALLER_MISMATCH_ERROR,
    cancelPending: vi.fn(),
    getPendingAsk: vi.fn(),
    setChatAwaitingNotifier: vi.fn(),
    setChatTaskActionHandler: vi.fn(),
    setOneShotCallerToken: vi.fn(),
    clearOneShotCallerTokenIf: vi.fn(),
    unsetChatAwaitingNotifierIf: vi.fn(),
    unsetChatTaskActionHandlerIf: vi.fn(),
  };
});

const { taskDir, withEventAppendChain, withTaskLock, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  forkPendingTasks,
  isTaskStarting,
  pendingStopRequests,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { beginChatLifecycle, clearChatGate, endChatLifecycle } = await import("@/lib/server/chat-gate");
const { closeTaskSession, deliverTaskQuestion } = await import("@/lib/server/task-runner");
const { getTask } = await import("@/lib/server/task-fs");
const { invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
// 真的 chat-pending（上面 mock 只透传了核对函数）：用它的 setOneShotCallerToken 给假会话登记「当前会话 token」
const actualPending = await vi.importActual<typeof import("@/lib/server/chat-pending")>("@/lib/server/chat-pending");
const {
  __resetNonOwnerTurnGuardForTest,
  beginNonOwnerTurn,
  isGroupNonOwnerTurnActive,
  isNonOwnerTurnActive,
} = await import("@/lib/server/non-owner-turn-guard");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`group-non-owner-desktop-turn DATA_DIR 未隔离：${taskDir("probe")}`);
}
(globalThis as unknown as Record<string, Promise<void>>)["__flowshipBootRecoveryPromiseV2__"] = Promise.resolve();

const AGENT_ID = "agent_gnd_turn";
const ACTION_ID = "act_gnd_turn";
const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
const POLL_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pollUntil = async (pred: () => boolean, ms = POLL_MS): Promise<boolean> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `group-desktop-turn ${id}`,
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
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    sessionAgentId: AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

/** 假 run：吐一条旁白后结束 */
const makeRun = () => ({
  id: `run_${Math.random().toString(36).slice(2, 8)}`,
  stream: async function* (): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "text", text: "答" }] } };
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

const fakeTool = (name: string) => ({
  name,
  label: name,
  description: "",
  parameters: {} as never,
  handler: vi.fn(async () => ({ content: [{ type: "text" as const, text: `HANDLED:${name}` }] })),
});
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

type Probe = {
  /** send 那一刻：系统工具整体硬拒的标记（scope=all）是否已登记 */
  allAtSend: boolean[];
  /** send 那一刻：「群非属主轮」标记（任一 scope）是否已登记 */
  groupAtSend: boolean[];
  texts: string[];
  /** send 那一刻，agent 调电脑操作 / 别的系统工具各得到的结果文本（模拟本轮里的工具调用） */
  desktopResults: string[];
  otherResults: string[];
  desktopHandler: ReturnType<typeof fakeTool>["handler"];
};
const newProbe = (): Probe => ({
  allAtSend: [],
  groupAtSend: [],
  texts: [],
  desktopResults: [],
  otherResults: [],
  desktopHandler: vi.fn(),
});

/** 假 agent：send 时记录标记状态 + 在「本轮」里调一次 desktop_screenshot 与 submit_work（走真咽喉 invokeFlowshipTool） */
const installSession = (
  id: string,
  probe: Probe,
  behavior: "ok" | "throw" | "stop-during-send" = "ok",
): void => {
  const send = vi.fn(async (text: string) => {
    probe.allAtSend.push(isNonOwnerTurnActive(id));
    probe.groupAtSend.push(isGroupNonOwnerTurnActive(id));
    probe.texts.push(text);
    // 过期会话闸（第十八轮）：直接塞进 agentSessions 的假会话没走 installSessionIfCurrent、没人登记 token——补登记 "tok"（= 本会话的 agent 在调工具）
    actualPending.setOneShotCallerToken(id, "tok");
    const desktop = fakeTool("desktop_screenshot");
    probe.desktopHandler = desktop.handler;
    probe.desktopResults.push(textOf(await invokeFlowshipTool(desktop as never, {}, "tok", { taskId: id } as never)));
    probe.otherResults.push(textOf(await invokeFlowshipTool(fakeTool("submit_work") as never, {}, "tok", { taskId: id } as never)));
    if (behavior === "throw") throw new Error("send boom（测试注入）");
    // 模拟 send 受理之后、交给 consume 之前属主点了停止：走「run.cancel + return stale」出口，**不关会话**
    if (behavior === "stop-during-send") beginChatLifecycle(id, "stopping");
    return makeRun();
  });
  agentSessions.set(id, {
    instanceId: allocTaskRunInstanceId(),
    agent: { agentId: AGENT_ID, close: vi.fn(), send } as never,
    agentId: AGENT_ID,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    startSnapshot: { title: `t ${id}` },
    repoPaths: [],
  });
};

describe("群里非属主的一轮：电脑操作与「只答疑」提示词开关解耦", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_gd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };
  type GroupNonOwnerArg = { name: string; guard: boolean; isBot?: boolean; openId?: string; markerOnly?: boolean };
  const deliver = async (id: string, groupNonOwner?: GroupNonOwnerArg) =>
    deliverTaskQuestion(
      (await getTask(id))!,
      "[群消息·来自 李四（非任务所有者）]\n帮我在电脑上看一眼",
      undefined,
      // 非属主不传 creds；属主对照传（markerOnly 是「属主语义、内容出自别人」，同样带 creds）
      groupNonOwner && !groupNonOwner.markerOnly ? undefined : CREDS,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      groupNonOwner,
    );
  /** action 在等审阅时的送达（inject 层带 ackContext 的那条分支） */
  const deliverWithAck = async (id: string, groupNonOwner?: GroupNonOwnerArg) =>
    deliverTaskQuestion(
      (await getTask(id))!,
      "按这个办",
      undefined,
      CREDS,
      { actionId: ACTION_ID },
      undefined,
      undefined,
      undefined,
      false,
      groupNonOwner,
    );

  beforeEach(() => {
    __resetNonOwnerTurnGuardForTest();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    // 先等后台 run / 启动链真收尾，再清：它们的尾巴里有 fire-and-forget 的 meta / 事件写盘，
    // 目录一删就落在已删目录上。超时只是兜底、不抛。
    await pollUntil(
      () => ids.every((id) => !isTaskStarting(id) && !runningTasks.has(id)),
      5000,
    );
    __resetNonOwnerTurnGuardForTest();
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      forkPendingTasks.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    // 排空每个任务的两条写盘链（meta 锁 + 事件追加链）再清目录——替换原来的 sleep(60)（时间裕量、不是同步点）。
    // 交替两轮：锁里的写可能再排事件、反之亦然
    // 带 3s 上限：万一哪个用例失败时没放行、把锁占住，清场不能卡死、更不能连累后面的用例（只是兜底，正常毫秒级完成；
    // 与上面的 5s 等待加起来 < vitest 默认 hookTimeout 10s）
    await Promise.race([
      (async () => {
        for (let round = 0; round < 2; round++) {
          for (const id of ids) {
            await withEventAppendChain(id, async () => undefined);
            await withTaskLock(id, async () => undefined);
          }
        }
      })(),
      sleep(3000),
    ]);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
    // console 间谍留到清完目录之后才还原：收尾里万一还有 console 输出，不会落到文件收尾之后的真 console 上
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("guard 关（同权）真人：send 那一刻登记了「群非属主轮」标记，但不是系统工具硬拒那种；本轮里 desktop_* 被拒、别的系统工具放行；run 收尾后清掉", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "李四", guard: false })).toBe("sent");
    expect(probe.groupAtSend).toEqual([true]);
    expect(probe.allAtSend).toEqual([false]);
    // 同权：没有「只答疑」约束段
    expect(probe.texts[0]).not.toContain("本轮规则：");
    // 电脑操作被拒：handler 没被执行；文案是电脑操作专用那条
    expect(probe.desktopResults[0]).toContain("[DENIED]");
    expect(probe.desktopResults[0]).toContain("电脑操作");
    expect(probe.desktopHandler).not.toHaveBeenCalled();
    // 同权的本意：别的系统工具照常放行
    expect(probe.otherResults[0]).toBe("HANDLED:submit_work");
    expect(
      await pollUntil(() => !isGroupNonOwnerTurnActive(id)),
      "run 结束后「群非属主轮」标记仍挂着（会拒属主自己的电脑操作）",
    ).toBe(true);
  });

  it("guard 关 + 机器人发言人（「机器人与真人同权」开着）：同样登记，desktop_* 被拒", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "别家机器人", guard: false, isBot: true, openId: "ou_otherbot" })).toBe("sent");
    expect(probe.groupAtSend).toEqual([true]);
    expect(probe.allAtSend).toEqual([false]);
    expect(probe.desktopResults[0]).toContain("[DENIED]");
    expect(probe.desktopHandler).not.toHaveBeenCalled();
    expect(probe.otherResults[0]).toBe("HANDLED:submit_work");
  });

  it("guard 开：行为不变——标记是系统工具硬拒那种，desktop_* 与别的系统工具都被拒", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "李四", guard: true })).toBe("sent");
    expect(probe.groupAtSend).toEqual([true]);
    expect(probe.allAtSend).toEqual([true]);
    expect(probe.desktopResults[0]).toContain("[DENIED]");
    expect(probe.otherResults[0]).toContain("[DENIED]");
    expect(probe.desktopHandler).not.toHaveBeenCalled();
    expect(await pollUntil(() => !isGroupNonOwnerTurnActive(id))).toBe(true);
  });

  it("markerOnly（属主语义、内容出自别人：所有者空 @ 引用陌生人 / 关联回执喂会话）：send 那一刻登记 scope=desktop 标记；提示词一个字不改；desktop_* 被拒、别的系统工具放行；收尾后清掉", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "", guard: false, markerOnly: true })).toBe("sent");
    expect(probe.groupAtSend).toEqual([true]);
    expect(probe.allAtSend).toEqual([false]);
    // 提示词不动：既没有「只答疑」约束段，也没有给「同权的群成员」那段「限制已关闭」声明（这不是群成员轮）
    expect(probe.texts[0]).not.toContain("本轮规则：");
    expect(probe.texts[0]).not.toContain("任务所有者已在设置里关掉了");
    expect(probe.texts[0]).not.toContain("群成员「");
    expect(probe.desktopResults[0]).toContain("[DENIED]");
    expect(probe.desktopResults[0]).toContain("电脑操作");
    expect(probe.desktopHandler).not.toHaveBeenCalled();
    expect(probe.otherResults[0]).toBe("HANDLED:submit_work");
    expect(
      await pollUntil(() => !isGroupNonOwnerTurnActive(id)),
      "run 结束后标记仍挂着（会拒所有者自己的电脑操作）",
    ).toBe(true);
  });

  it("markerOnly + ackContext（action 在等审阅的那条分支）：同样登记标记", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliverWithAck(id, { name: "", guard: false, markerOnly: true })).toBe("sent");
    expect(probe.groupAtSend).toEqual([true]);
    expect(probe.allAtSend).toEqual([false]);
    expect(probe.desktopResults[0]).toContain("[DENIED]");
    expect(probe.desktopHandler).not.toHaveBeenCalled();
    expect(probe.otherResults[0]).toBe("HANDLED:submit_work");
    expect(await pollUntil(() => !isGroupNonOwnerTurnActive(id))).toBe(true);
  });

  it("对照：ackContext 分支、属主自己的轮（没传 groupNonOwner）：没有任何标记，desktop_* 放行", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliverWithAck(id)).toBe("sent");
    expect(probe.groupAtSend).toEqual([false]);
    expect(probe.desktopResults[0]).toBe("HANDLED:desktop_screenshot");
  });

  it("属主自己的轮（没传 groupNonOwner）：没有任何标记，desktop_* 放行", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id)).toBe("sent");
    expect(probe.groupAtSend).toEqual([false]);
    expect(probe.allAtSend).toEqual([false]);
    expect(probe.desktopResults[0]).toBe("HANDLED:desktop_screenshot");
    expect(probe.desktopHandler).toHaveBeenCalledTimes(1);
  });

  it("属主紧随其后的 send：起点无条件清掉上一轮漏下的 scope=desktop 标记（不会被拒电脑操作）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);
    // 模拟「上一轮同权非属主的标记漏清了」
    beginNonOwnerTurn(id, Date.now(), "desktop");
    expect(isGroupNonOwnerTurnActive(id)).toBe(true);

    expect(await deliver(id)).toBe("sent");
    expect(probe.groupAtSend).toEqual([false]);
    expect(probe.desktopResults[0]).toBe("HANDLED:desktop_screenshot");
  });

  it("同一个任务里：同权非属主轮结束之后属主马上说话，电脑操作恢复可用（标记不串轮）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "李四", guard: false })).toBe("sent");
    expect(await pollUntil(() => !isGroupNonOwnerTurnActive(id))).toBe(true);
    installSession(id, probe); // consume 收尾后会话被摘 / 复用的细节不是本用例关心的：重新挂一个假会话
    expect(await deliver(id)).toBe("sent");
    expect(probe.desktopResults[0]).toContain("[DENIED]");
    expect(probe.desktopResults[1]).toBe("HANDLED:desktop_screenshot");
  });

  it("agent.send 抛错：scope=desktop 的标记不残留（宁可多清）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe, "throw");

    await deliver(id, { name: "李四", guard: false }).catch(() => {});
    expect(probe.groupAtSend).toEqual([true]);
    expect(
      await pollUntil(() => !isGroupNonOwnerTurnActive(id)),
      "send 抛错后「群非属主轮」标记残留",
    ).toBe(true);
  });

  it("send 受理后、交给 consume 之前被停止（stale 出口、不关会话）：scope=desktop 的标记不残留", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe, "stop-during-send");

    const r = await deliver(id, { name: "李四", guard: false });
    expect(r).toBe("stale");
    expect(probe.groupAtSend).toEqual([true]);
    expect(agentSessions.has(id)).toBe(true);
    expect(
      await pollUntil(() => !isGroupNonOwnerTurnActive(id)),
      "stale 出口后「群非属主轮」标记残留",
    ).toBe(true);
  });

  it("closeTaskSession 清 scope=desktop 的标记（会话关了，这一轮不再存在）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    installSession(id, newProbe());
    beginNonOwnerTurn(id, Date.now(), "desktop");
    await closeTaskSession(id);
    expect(isGroupNonOwnerTurnActive(id)).toBe(false);
  });
});
