/**
 * 非属主一轮的「按轮次标记」生命周期（task-runner：sendToTaskSession → consumeSessionRun）
 *
 * 真 deliverTaskQuestion + 假会话 / 假 run（同 consume-finally-resilience 的手法），钉死：
 * - guard 开：agent.send 那一刻标记已登记（系统工具闸此刻生效）、消息里有约束段；run 收尾后标记清掉
 * - guard 关：不登记标记、不加约束段（与属主同权）
 * - 属主紧随其后的 send：起点无条件清掉（即使上一轮的标记漏清），不会被拒系统工具
 * - agent.send 抛错 / 没交给 consume 的出口：标记也清（宁可多清）
 * - closeTaskSession：清标记
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-non-owner-turn-"));
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
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));
vi.mock("@/lib/server/chat-pending", async () => {
  // 真的 buildAgentMessage：要验消息里确有约束段
  const actual = await vi.importActual<
    typeof import("@/lib/server/chat-pending")
  >("@/lib/server/chat-pending");
  return {
    cleanupChatTaskState: vi.fn(),
    invalidateCallerToken: vi.fn(),
    buildAgentMessage: actual.buildAgentMessage,
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

const { taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  forkPendingTasks,
  pendingStopRequests,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { beginChatLifecycle, clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { closeTaskSession, deliverTaskQuestion } = await import(
  "@/lib/server/task-runner"
);
const { getTask } = await import("@/lib/server/task-fs");
const {
  __resetNonOwnerTurnGuardForTest,
  beginNonOwnerTurn,
  isNonOwnerTurnActive,
} = await import("@/lib/server/non-owner-turn-guard");
const { buildBotEtiquetteNote, buildNonOwnerGuardFootnote } = await import(
  "@/lib/group-non-owner-prompt"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`non-owner-turn-lifecycle DATA_DIR 未隔离：${taskDir("probe")}`);
}
(globalThis as unknown as Record<string, Promise<void>>)[
  "__flowshipBootRecoveryPromiseV2__"
] = Promise.resolve();

const AGENT_ID = "agent_no_turn";
const ACTION_ID = "act_no_turn";
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
    title: `non-owner-turn ${id}`,
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

type Probe = { activeAtSend: boolean[]; texts: string[] };
/** 假 agent：send 时记录「此刻标记是否已登记」+ 收到的消息；onSend 决定吐 run 还是抛错 */
const installSession = (
  id: string,
  probe: Probe,
  behavior: "ok" | "throw" | "stop-during-send" = "ok",
): void => {
  const send = vi.fn(async (text: string) => {
    probe.activeAtSend.push(isNonOwnerTurnActive(id));
    probe.texts.push(text);
    if (behavior === "throw") throw new Error("send boom（测试注入）");
    // 模拟 send 受理之后、交给 consume 之前，属主点了停止（lifecycle=stopping）：
    // entryLost() 为真但 op 仍是当前 → 走「run.cancel + return stale」出口，**不关会话**
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

describe("非属主一轮的按轮次标记生命周期", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_no_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };
  const newProbe = (): Probe => ({ activeAtSend: [], texts: [] });
  const deliver = async (
    id: string,
    groupNonOwner?: { name: string; guard: boolean; isBot?: boolean; openId?: string },
  ) =>
    deliverTaskQuestion(
      (await getTask(id))!,
      "[群消息·来自 李四（非任务所有者）]\n这个接口返回啥？",
      undefined,
      // 非属主不传 creds；属主对照传
      groupNonOwner ? undefined : CREDS,
      undefined,
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
    vi.restoreAllMocks();
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
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });
  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("guard 开：send 那一刻标记已登记 + 消息带约束段；run 收尾后标记清掉", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "李四", guard: true })).toBe("sent");
    expect(probe.activeAtSend).toEqual([true]);
    expect(probe.texts[0]!.endsWith(buildNonOwnerGuardFootnote("李四"))).toBe(true);
    // run 收尾（consume 最外层 finally）后清
    expect(
      await pollUntil(() => !isNonOwnerTurnActive(id)),
      "run 结束后非属主标记仍挂着（会拒属主自己的 submit_work）",
    ).toBe(true);
  });

  it("机器人发言人（guard:true + isBot）：标记已登记 + 消息带**机器人变体**约束段（必须自己 @ 它 / NO_REPLY）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "别家机器人", guard: true, isBot: true })).toBe("sent");
    expect(probe.activeAtSend).toEqual([true]);
    const text = probe.texts[0]!;
    expect(text.endsWith(buildNonOwnerGuardFootnote("别家机器人", { isBot: true }))).toBe(true);
    expect(text).toContain("必须在正文里 @ 它");
    // 与真人变体不同（不是同一段）
    expect(text.endsWith(buildNonOwnerGuardFootnote("别家机器人"))).toBe(false);
  });

  it("机器人发言人带 openId：约束段里给出 @ 标签的固定写法（agent 才写得出能 @ 到它的标签）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(
      await deliver(id, { name: "别家机器人", guard: true, isBot: true, openId: "ou_otherbot" }),
    ).toBe("sent");
    expect(probe.texts[0]!).toContain('<at user_id="ou_otherbot">别家机器人</at>');
  });

  it("机器人 + guard:false 带 openId：克制提示里同样给出标签写法", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(
      await deliver(id, { name: "别家机器人", guard: false, isBot: true, openId: "ou_otherbot" }),
    ).toBe("sent");
    expect(probe.texts[0]!).toContain('<at user_id="ou_otherbot">别家机器人</at>');
  });

  it("guard 关：不登记标记、不加约束段（群成员与属主同权）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "李四", guard: false })).toBe("sent");
    expect(probe.activeAtSend).toEqual([false]);
    expect(probe.texts[0]).not.toContain("非任务所有者「");
  });

  it("机器人 + guard:false（「机器人与真人同权」开着且提示词开关关着）：不登记标记、没有「只答疑」约束，但仍带防成环的克制提示", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "别家机器人", guard: false, isBot: true })).toBe("sent");
    expect(probe.activeAtSend).toEqual([false]);
    const text = probe.texts[0]!;
    // 同权：没有约束段、没有「不修改任何文件」
    expect(text).not.toContain("不修改任何文件");
    expect(text).not.toContain("本轮规则：");
    // 默认脚注保留（与真人 guard 关一致），后面追加克制提示（防互 @ 成环）
    expect(text).toContain("**修改要求**才动手改");
    expect(text.endsWith(buildBotEtiquetteNote("别家机器人"))).toBe(true);
    expect(text).toContain("必须在正文里 @ 它");
    expect(text).toContain("别回「收到」");
  });

  it("真人 + guard:false：不追加克制提示（只有机器人才需要）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);

    expect(await deliver(id, { name: "李四", guard: false })).toBe("sent");
    expect(probe.texts[0]).not.toContain("别回「收到」");
  });

  it("属主紧随其后的 send：起点无条件清掉上一轮漏下的标记（不会被拒系统工具）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe);
    // 模拟「上一轮非属主的标记漏清了」
    beginNonOwnerTurn(id);
    expect(isNonOwnerTurnActive(id)).toBe(true);

    expect(await deliver(id)).toBe("sent");
    expect(probe.activeAtSend).toEqual([false]);
  });

  it("agent.send 抛错：标记不残留（宁可多清）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe, "throw");

    await deliver(id, { name: "李四", guard: true }).catch(() => {});
    expect(probe.activeAtSend).toEqual([true]);
    expect(
      await pollUntil(() => !isNonOwnerTurnActive(id)),
      "send 抛错后非属主标记残留",
    ).toBe(true);
  });

  it("send 受理后、交给 consume 之前被停止（stale 出口、不关会话）：标记不残留——只有 sendToTaskSessionBody 的 finally 兜得住", async () => {
    // 第 20 轮评审 M2d：把 finally 里的 endNonOwnerTurn 删掉，原有用例全绿（它们的出口都另有 closeTaskSession 清）。
    // 这个出口不关会话，标记只能靠 finally 收；残留的后果是属主下一次 send 之前（或 45 分钟内）系统工具被误拒。
    const id = alloc();
    await writeMeta(makeMeta(id));
    const probe = newProbe();
    installSession(id, probe, "stop-during-send");

    const r = await deliver(id, { name: "李四", guard: true });

    expect(r).toBe("stale");
    expect(probe.activeAtSend).toEqual([true]); // send 那一刻确实登记过
    // 会话没被关（这是这个出口的特点；若哪天它改成关会话，这条断言会提醒该用例已不再覆盖 finally）
    expect(agentSessions.has(id)).toBe(true);
    expect(
      await pollUntil(() => !isNonOwnerTurnActive(id)),
      "stale 出口后非属主标记残留",
    ).toBe(true);
  });

  it("closeTaskSession 清标记（会话关了，这一轮不再存在）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    installSession(id, newProbe());
    beginNonOwnerTurn(id);
    await closeTaskSession(id);
    expect(isNonOwnerTurnActive(id)).toBe(false);
  });
});
