/**
 * 群里非属主真人撞上休眠会话时的唤醒（`wakeTaskSessionForGroup`）。
 *
 * 背景（2026-11-19 玉灵）：「限制群里非宿主成员」关了，机器人还是拒绝造线索——开关只管会话存活的 12~22 分钟，
 * 会话被空闲回收后群成员走只读旁路、旁路不读开关。修法：开关关时，群入向在送进去之前先把落盘会话接回来
 * （路由层的判定见 tests/group-same-session-route.test.ts「开关已关 + 休眠会话」）；本文件钉**唤醒函数本身**的边界。
 *
 * 钉死的语义：
 * - 只 resume：成功 = 表里有会话；绝不起新 agent（`Agent.create` 一次都不许调）；
 * - 任一条件不满足 / 任何一步失败 → false 且**不抛**（调用方落回只读旁路）：
 *   无落盘锚点 / 缺凭据 / 在跑（runningTasks 或 runStatus=running）/ chat 型 / 终态 / 堆内存高压 / Agent.resume 抛错；
 * - 并发唤醒、会话已在 → 不重复 resume；
 * - 资源与生命周期（评审后补）：resume 期间任务处于「启动中」（DELETE / 停止 / 收尾会等它）且任何出口都归零；
 *   已归档不唤醒；resume 只给 30s（群入向是全进程单链）、超时保留锚点并收尸迟到的 agent；失败后冷却 3 分钟不再试
 *   （早退 / 堆高压不算失败）；唤醒期间被 stop（opHandle 失效）→ 关掉刚 resume 出的 agent、不装表；
 * - 注入链对非属主「不带 creds、不唤醒」的契约不动（接线断言）。
 *
 * 不 mock 被测本体：只把 `@cursor/sdk` 换成假 agent，其余走真代码、task 落盘走真 fs。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

import { enclosingIfConditions, readSource } from "./helpers/source-text";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fe-group-wake-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

// 堆内存高压开关：默认放行（走真实 assertHeapOk），个别用例置 true 触发 HeapPressureError
let heapHigh = false;
vi.mock("@/lib/server/sdk-store-gc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/sdk-store-gc")>();
  return {
    ...actual,
    assertHeapOk: (where: string) => {
      if (heapHigh) throw new actual.HeapPressureError(where, 900, 1000);
      return actual.assertHeapOk(where);
    },
  };
});

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

const { writeMeta, taskDir } = await import("@/lib/server/task-fs-core");
const {
  agentSessions,
  clearTaskStarting,
  isTaskStarting,
  revokeTaskOps,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { cleanupChatTaskState } = await import("@/lib/server/chat-pending");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { __resetGroupWakeCooldownForTest, wakeTaskSessionForGroup } = await import(
  "@/lib/server/task-runner"
);
const { getTask, listTasks } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`group-wake DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}
await listTasks();

const CREDS = { apiKey: "fake-api-key", model: { id: "m", params: [] as never[] } };

let REPO = "";
beforeAll(() => {
  REPO = fs.mkdtempSync(path.join(os.tmpdir(), "group-wake-repo-"));
  execFileSync("git", ["init"], { cwd: REPO });
});
afterAll(() => {
  for (const dir of [REPO, TMP_ROOT]) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

const makeMeta = (id: string, over: Record<string, unknown> = {}): TaskMetaV06 =>
  ({
    id,
    title: `group-wake ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    // 持久化的会话锚点：有它才接得回（空闲回收后正是这个状态）
    sessionAgentId: "agent_persisted",
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
    repoPaths: [REPO],
    gitBranches: [{ repoPath: REPO, name: "feature/me/1-x", baseBranch: "master" }],
    repoTestBranches: { [REPO]: "test" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }) as unknown as TaskMetaV06;

describe("wakeTaskSessionForGroup：只 resume、失败不抛", () => {
  const ids: string[] = [];
  const seed = async (over: Record<string, unknown> = {}): Promise<string> => {
    const id = `t_gw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id, over));
    return id;
  };

  beforeEach(() => {
    heapHigh = false;
    __resetGroupWakeCooldownForTest();
    mockCreate.mockReset();
    mockResume.mockReset();
    mockResume.mockImplementation(async () => ({
      agentId: "agent_persisted",
      close: vi.fn(),
      send: vi.fn(),
    }));
  });

  afterEach(() => {
    for (const id of ids) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      cleanupChatTaskState(id);
      try {
        fs.rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    ids.length = 0;
  });

  it("休眠会话（有锚点、空闲）→ resume 成功：返回 true、表里有会话、用落盘的 agentId；绝不 create", async () => {
    const id = await seed();
    expect(agentSessions.has(id)).toBe(false);

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(true);

    expect(agentSessions.has(id)).toBe(true);
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockResume.mock.calls[0]?.[0]).toBe("agent_persisted");
    expect(mockCreate).not.toHaveBeenCalled();
    // 唤醒不改锚点（之后属主 / 群成员的消息都接这个会话）
    expect((await getTask(id))?.sessionAgentId).toBe("agent_persisted");
  });

  it("会话已在 → 直接 true，不再 resume", async () => {
    const id = await seed();
    agentSessions.set(id, {} as never);

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(true);

    expect(mockResume).not.toHaveBeenCalled();
  });

  it("并发两次唤醒（同一任务）→ 只 resume 一次，两次都 true（走 send 串行链，排到时会话已在）", async () => {
    const id = await seed();

    const [a, b] = await Promise.all([
      wakeTaskSessionForGroup(id, CREDS),
      wakeTaskSessionForGroup(id, CREDS),
    ]);

    expect([a, b]).toEqual([true, true]);
    expect(mockResume).toHaveBeenCalledTimes(1);
  });

  it("没有落盘锚点 → false：这不是休眠，没得接；不 resume、不 create", async () => {
    const id = await seed({ sessionAgentId: undefined });

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);

    expect(mockResume).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(agentSessions.has(id)).toBe(false);
  });

  it("缺凭据（没有 apiKey）→ false，不 resume", async () => {
    const id = await seed();

    await expect(
      wakeTaskSessionForGroup(id, { model: CREDS.model }),
    ).resolves.toBe(false);

    expect(mockResume).not.toHaveBeenCalled();
  });

  it("在跑（runningTasks 占着：一次性 agent / 启动中）→ false，不碰", async () => {
    const id = await seed();
    runningTasks.set(id, {} as never);

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);

    expect(mockResume).not.toHaveBeenCalled();
  });

  it("盘上 runStatus=running（没有内存会话的僵死态）→ false，不碰", async () => {
    const id = await seed({ runStatus: "running" });

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);

    expect(mockResume).not.toHaveBeenCalled();
  });

  it("chat 型任务 → false（chat 有自己的会话机制，群里非属主也进不来）", async () => {
    const id = await seed({ mode: "chat" });

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);

    expect(mockResume).not.toHaveBeenCalled();
  });

  it("任务已终态（merged）→ false：finalize 后不得复活会话", async () => {
    const id = await seed({ repoStatus: "merged" });

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);

    expect(mockResume).not.toHaveBeenCalled();
    expect(agentSessions.has(id)).toBe(false);
  });

  it("堆内存高压 → false，不 resume（与 send 入口同一道门：高压时不新增常驻 agent）", async () => {
    const id = await seed();
    heapHigh = true;

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);

    expect(mockResume).not.toHaveBeenCalled();
    expect(agentSessions.has(id)).toBe(false);
  });

  it("Agent.resume 抛错 → false 且不抛；表里不留半截会话（调用方落回只读旁路）", async () => {
    const id = await seed();
    mockResume.mockRejectedValueOnce(new Error("boom: session not found"));

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);

    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(agentSessions.has(id)).toBe(false);
  });

  it("任务不存在 → false，不抛", async () => {
    await expect(
      wakeTaskSessionForGroup("t_not_exist_xyz", CREDS),
    ).resolves.toBe(false);
    expect(mockResume).not.toHaveBeenCalled();
  });

  /** 让 Agent.resume 挂起：返回「已被调用」与「放行」两个把手（假 agent 由调用方给） */
  const hangResume = () => {
    let release!: (agent: unknown) => void;
    let resumeCalled!: () => void;
    const called = new Promise<void>((r) => (resumeCalled = r));
    mockResume.mockImplementation(() => {
      resumeCalled();
      return new Promise((r) => (release = r));
    });
    return { called, release: (agent: unknown) => release(agent) };
  };
  const fakeAgent = () => ({
    agentId: "agent_persisted",
    close: vi.fn(),
    send: vi.fn(),
  });

  it("resume 期间任务处于「启动中」（DELETE / 停止 / 收尾会等它落地再清工作区），结束后归零", async () => {
    const id = await seed();
    const { called, release } = hangResume();

    const p = wakeTaskSessionForGroup(id, CREDS);
    await called;
    expect(isTaskStarting(id), "resume 的 await 窗口里必须有「启动中」标记").toBe(true);

    release(fakeAgent());
    await expect(p).resolves.toBe(true);
    expect(isTaskStarting(id)).toBe(false);
  });

  it("任何出口之后「启动中」都归零（resume 抛错 / 无锚点早退）：计数泄漏会让 DELETE / 停止永远等", async () => {
    const id = await seed();
    mockResume.mockRejectedValueOnce(new Error("boom: session not found"));
    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);
    expect(isTaskStarting(id)).toBe(false);

    const none = await seed({ sessionAgentId: undefined });
    await expect(wakeTaskSessionForGroup(none, CREDS)).resolves.toBe(false);
    expect(isTaskStarting(none)).toBe(false);
  });

  it("已归档任务 → false，不 resume（归档的任务不该被群里的人拉起 agent）", async () => {
    const id = await seed({ archived: true });

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);

    expect(mockResume).not.toHaveBeenCalled();
    expect(agentSessions.has(id)).toBe(false);
  });

  it("唤醒期间被 stop / 重发（opHandle 失效）→ 刚 resume 出的 agent 被关掉、不装进会话表、返回 false", async () => {
    const id = await seed();
    const { called, release } = hangResume();

    const p = wakeTaskSessionForGroup(id, CREDS);
    await called;
    revokeTaskOps(id); // 模拟用户 stop / 重发：入场快照的 opHandle 作废
    const agent = fakeAgent();
    release(agent);

    await expect(p).resolves.toBe(false);
    expect(agent.close).toHaveBeenCalledTimes(1);
    expect(agentSessions.has(id)).toBe(false);
    expect(isTaskStarting(id)).toBe(false);
  });

  it("网络类失败：保留锚点；进入冷却——期间再来不 resume（直接 false）；冷却过后再试一次，成功后不再有冷却", async () => {
    const id = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mockResume.mockRejectedValueOnce(new Error("fetch failed: network unreachable"));
      await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);
      expect(mockResume).toHaveBeenCalledTimes(1);
      // 网络抖动不清锚点：之后属主自己说话 / 冷却过后还能接回
      expect((await getTask(id))?.sessionAgentId).toBe("agent_persisted");

      // 冷却期内：陌生人每发一条也不会再把入向链卡一轮
      vi.setSystemTime(Date.now() + 60_000);
      await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);
      expect(mockResume).toHaveBeenCalledTimes(1);

      // 冷却过后（3 分钟）：再试一次，这次成功
      vi.setSystemTime(Date.now() + 3 * 60_000);
      await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(true);
      expect(mockResume).toHaveBeenCalledTimes(2);

      // 成功之后没有残留冷却：会话再被回收后，下一次唤醒立刻可以试
      agentSessions.delete(id);
      await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(true);
      expect(mockResume).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("早退（堆高压 / 在跑 / …）不算失败、不进冷却：条件一恢复，下一条消息立刻能唤醒", async () => {
    const id = await seed();

    heapHigh = true;
    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);
    heapHigh = false;
    runningTasks.set(id, {} as never);
    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);
    runningTasks.delete(id);

    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(true);
    expect(mockResume).toHaveBeenCalledTimes(1);
  });

  it("Agent.resume 卡住 → 30s 就放弃（属主自己 send 是 180s）：返回 false、锚点保留、迟到的 agent 被收尸、进入冷却", async () => {
    const id = await seed();
    const { called, release } = hangResume();

    // 只假 setTimeout：fs / git 的真实 I/O 照常走，只有 SDK deadline 的计时器受控
    let result: boolean | undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      void wakeTaskSessionForGroup(id, CREDS).then((v) => {
        result = v;
      });
      await called;

      await vi.advanceTimersByTimeAsync(29_000);
      expect(result, "30s 以内还在等").toBeUndefined();
      expect(isTaskStarting(id), "等待期间一直处于「启动中」").toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }
    // 过了 30s 就该放弃。收尾改用真计时器 + 有界等待：回归成 180s 时本用例 2s 后干净地红，
    // 而不是卡到整体超时、还把假计时器留给后面的用例
    await vi.waitFor(
      () => expect(result, "过了 30s 就该放弃，而不是等满 180s").toBe(false),
      { timeout: 2_000 },
    );
    expect(isTaskStarting(id)).toBe(false);

    // 超时属网络类失败：锚点保留
    expect((await getTask(id))?.sessionAgentId).toBe("agent_persisted");
    // 迟到成功的 agent 被收尸，不留孤儿 agent
    const late = fakeAgent();
    release(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
    expect(agentSessions.has(id)).toBe(false);
    // 失败进入冷却：马上再来不再 resume
    await expect(wakeTaskSessionForGroup(id, CREDS)).resolves.toBe(false);
    expect(mockResume).toHaveBeenCalledTimes(1);
  });
});

describe("接线契约：唤醒只在群入向、注入链的「非属主不唤醒」不动", () => {
  // 读的是**剥掉注释**的源码（注释里照抄一遍被检查的那句不算数），条件按结构对账（含取反）——
  // 以前只 toContain("deps.isGroupNonOwnerGuardEnabled()")，把 `!(await …)` 写成 `(await …)`（开关开着反而唤醒）也能过（第三轮评审 P1-4）。
  // 各条件项的行为另有 tests/group-same-session-route.test.ts 的路由用例；这里钉的是「整串条件一个都不少、一个都没反」。

  it("注入链对非属主 / 关联回执仍不带 creds（deliver 内「有 creds → resume」不会被陌生人触发）", () => {
    const src = readSource("src/lib/server/task-question-inject.ts");
    // 「只送活会话」的总开关（第四轮评审后从单纯的 nonOwner 扩成含关联回执）：非属主必须一直在里面——
    // 有人把它改成只剩关联回执，非属主就能重新触发唤醒；关联回执只在非只读旁路时才算
    expect(src).toMatch(/const liveSessionOnly = nonOwner \|\|/);
    const at = src.indexOf("deliverTaskQuestion(");
    expect(at, "找不到 deliverTaskQuestion 调用").toBeGreaterThan(-1);
    const call = src.slice(at, at + 1200);
    expect(call).toMatch(/liveSessionOnly\s*\?\s*undefined\s*:\s*\{/);
    // 且「没有活会话 → 409」的竞态兜底、「没送进去 → 409」的收尾都还在
    expect(src).toMatch(/liveSessionOnly && !agentSessions\.has\(task\.id\)/);
    expect(src).toMatch(/liveSessionOnly && !sent/);
  });

  it("唤醒段在准入闸之后（被拒的发件人不能顺手拉起 agent）", () => {
    const src = readSource("src/lib/server/feishu-bridge/group-route.ts");
    const gate = src.indexOf("const denied = await restrictedQaDenial();");
    const wake = src.indexOf("deps.wakeTaskSessionForGroup(taskId");
    expect(gate, "找不到准入闸调用").toBeGreaterThan(-1);
    expect(wake, "找不到唤醒调用").toBeGreaterThan(-1);
    expect(wake).toBeGreaterThan(gate);
    // 准入闸拒绝就地返回：唤醒不可能在「被拒」之后还执行
    expect(src.slice(gate, gate + 200)).toMatch(/if \(denied\) return denyRestrictedQa\(denied\);/);
  });

  it("唤醒调用只在这一整串条件同时成立时才会发生（逐项对账、含取反）", () => {
    const src = readSource("src/lib/server/feishu-bridge/group-route.ts");
    const conditions = enclosingIfConditions(src, "deps.wakeTaskSessionForGroup(taskId");
    // 集合对账（顺序无关）：少一项 / 多一项 / 某项被取反或改写，都会让这里红
    expect([...conditions].sort()).toEqual(
      [
        "!sameSessionNonOwner", // 已经并入活会话：不用再唤醒
        "!isOwner", // 属主的休眠会话由注入链带 creds 自己接回
        "!args.fromPump", // 排队回放不在那条链上再阻塞一次 resume
        "args.requesterIsBot !== true", // 机器人（含同权）不唤醒：防两个机器人互 @ 把唤醒放大
        'task.mode !== "chat"', // chat 型有自己的会话机制
        "!hasPendingAsk", // 这条是在答提问，走 injectPendingAskText
        "!correlated", // 关联回执走活会话里的数据通道
        "!!task.sessionAgentId", // 没有落盘锚点不是「休眠」
        'task.runStatus !== "running"',
        "!runningTasks.has(taskId)", // 一次性 agent / 启动中
        "!(await deps.isGroupNonOwnerGuardEnabled())", // 开关开着（默认）不唤醒、不读凭据
      ].sort(),
    );
  });
});
