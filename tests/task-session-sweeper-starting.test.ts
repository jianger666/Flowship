/**
 * 会话空闲回收 sweeper 不碰「启动飞行窗」里的会话（第十四轮评审 P3-7）；豁免有上限（第十五轮评审 P3-2 ③）
 *
 * 缺口：sweeper（每 10 分钟扫一次）只用 `runningTasks.has(taskId)` 判「run 在跑不算空闲」。但续接 send（sendToTaskSession）从
 * beginTaskStarting 起、到 consumeSessionRun 占上 runningTasks 之前，有一段「已受理、run 还没登记」的飞行窗（agent.send 本身最长 120 秒），
 * 而 session.lastActiveAt 要等 send resolve 之后才刷新——闲置超过 12 分钟的会话收到一条消息（常见：隔了一阵再追问），
 * 若恰好撞上 sweeper 的整点，会话在 send 进行中被关掉：这一次 send 失败降级（多一次 resume / 新起 agent），
 * 外来内容那一轮的标记（closeTaskSession 默认无条件清）也跟着没了。窗口很窄（几秒 / 600 秒），但不是零。
 * 修法：与 DELETE / 停止 / 群唤醒一样，把「启动中」（isTaskStarting）也算「不空闲」。
 *
 * 第十五轮评审 P3-2 ③：`isTaskStarting` 是没有时间戳的引用计数——启动链若挂死、计数永不归零，这个会话就永远不被回收。
 * 所以豁免有上限：sweeper 自己记「第一次看到这个 task 在启动中」的时刻，连续看到超过 30 分钟（3 个扫描间隔）就不再豁免、照常按空闲 TTL 回收；
 * 一次 sweep 里没看到「启动中」（启动结束 / run 已占上 runningTasks / 会话已经不在表里）就重新起算。
 *
 * 手法：模块顶层的 sweeper 是 setInterval——先 fake timers、清掉 globalThis 上的单例键，再 import task-runner，
 * 这样装进去的就是 fake 的 interval，`advanceTimersByTime` 能真触发一次 sweep。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-sweeper-starting-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({ Agent: { create: vi.fn(), resume: vi.fn() } }));
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

(globalThis as unknown as Record<string, Promise<void>>)["__flowshipBootRecoveryPromiseV2__"] = Promise.resolve();

// 先 fake、再 import：sweeper 的 setInterval 在 task-runner 模块顶层装（globalThis 单例键，热更新只装一次）
delete (globalThis as unknown as Record<string, unknown>)["__flowshipSessionSweeperV1__"];
vi.useFakeTimers();
const { agentSessions, beginTaskStarting, clearTaskStarting, runningTasks } = await import("@/lib/server/task-stream");
await import("@/lib/server/task-runner");
const guard = await import("@/lib/server/non-owner-turn-guard");

const SWEEP_MS = 10 * 60 * 1000;
const IDLE_MS = 20 * 60 * 1000; // 超过 12 分钟 TTL

const mkSession = (agentId: string, instanceId: number, close: () => void) =>
  ({
    instanceId,
    agent: { agentId, send: vi.fn(), close },
    agentId,
    createdAt: Date.now() - 60 * 60 * 1000,
    lastActiveAt: Date.now() - IDLE_MS,
    startSnapshot: {} as never,
  }) as never;

describe("会话空闲回收 sweeper 与启动飞行窗（第十四轮评审 P3-7）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_sweep_${ids.length}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    guard.__resetNonOwnerTurnGuardForTest();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const id of ids.splice(0)) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      clearTaskStarting(id);
    }
    guard.__resetNonOwnerTurnGuardForTest();
    vi.restoreAllMocks();
  });

  it("对照：闲置超 TTL、既没在跑也没在启动 → 被回收（会话摘掉、agent.close 调到、标记按 closeTaskSession 默认一并清）", () => {
    const id = alloc();
    const close = vi.fn();
    agentSessions.set(id, mkSession("agent_idle", 11, close));
    guard.beginNonOwnerTurn(id, Date.now(), "desktop");

    vi.advanceTimersByTime(SWEEP_MS + 1);

    expect(agentSessions.has(id), "空闲会话应被回收").toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(guard.isGroupNonOwnerTurnActive(id)).toBe(false);
  });

  it("启动飞行窗内（sendToTaskSession 已受理、run 还没占上 runningTasks）：同样闲置超 TTL 也不回收——会话和标记都留着", () => {
    const id = alloc();
    const close = vi.fn();
    agentSessions.set(id, mkSession("agent_starting", 12, close));
    guard.beginNonOwnerTurn(id, Date.now(), "desktop");
    beginTaskStarting(id);

    vi.advanceTimersByTime(SWEEP_MS + 1);

    expect(agentSessions.has(id), "启动飞行窗里的会话被 sweeper 关掉了：这一次 send 会在进行中失败降级").toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(guard.isGroupNonOwnerTurnActive(id), "外来内容那一轮的标记被 sweeper 顺手清了").toBe(true);
  });

  it("飞行窗结束之后的下一次 sweep：照常回收（跳过只管飞行窗那一刻，不是永久豁免）", () => {
    const id = alloc();
    const close = vi.fn();
    agentSessions.set(id, mkSession("agent_later", 13, close));
    beginTaskStarting(id);
    vi.advanceTimersByTime(SWEEP_MS + 1);
    expect(agentSessions.has(id)).toBe(true);

    clearTaskStarting(id);
    vi.advanceTimersByTime(SWEEP_MS);

    expect(agentSessions.has(id), "飞行窗结束后仍闲置，下一次 sweep 应回收").toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("启动链悬挂（isTaskStarting 计数一直不归零）：豁免有上限——连续看到「启动中」不超过 30 分钟都不回收，超过后下一次 sweep 照常回收（第十五轮评审 P3-2 ③）", () => {
    const id = alloc();
    const close = vi.fn();
    agentSessions.set(id, mkSession("agent_hung", 16, close));
    beginTaskStarting(id); // 永不 clear：模拟启动链悬挂

    // 第 1 次 sweep 起算（距首次看到 0 分钟）；第 2、3、4 次是 10 / 20 / 30 分钟——都还在 30 分钟上限内（含边界）
    for (let i = 1; i <= 4; i += 1) {
      vi.advanceTimersByTime(SWEEP_MS);
      expect(agentSessions.has(id), `第 ${i} 次 sweep（距首次看到 ${(i - 1) * 10} 分钟）仍在豁免上限内，不该回收`).toBe(true);
    }
    expect(close).not.toHaveBeenCalled();

    // 第 5 次 sweep：距首次看到 40 分钟 > 30 分钟上限，不再豁免；会话闲置早已超 TTL → 回收
    vi.advanceTimersByTime(SWEEP_MS);
    expect(agentSessions.has(id), "启动链悬挂超过上限：会话应被回收，否则泄漏（子进程 / 内存）").toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("疑似启动链悬挂"));
  });

  it("豁免的计时只算「连续看到」：中间有一次 sweep 没看到启动中（启动真的结束过），之后再来的启动从头起算", () => {
    const id = alloc();
    const close = vi.fn();
    const session = mkSession("agent_restart", 17, close) as unknown as { lastActiveAt: number };
    agentSessions.set(id, session as never);

    // 第一段启动：撞上 3 次 sweep（距首次看到 0 / 10 / 20 分钟）
    beginTaskStarting(id);
    for (let i = 0; i < 3; i += 1) vi.advanceTimersByTime(SWEEP_MS);
    expect(agentSessions.has(id)).toBe(true);

    // 启动结束（send 完成会刷新 lastActiveAt），下一次 sweep 没看到启动中 → 起算点清掉；会话刚活跃过，不到空闲 TTL，不回收
    clearTaskStarting(id);
    session.lastActiveAt = Date.now();
    vi.advanceTimersByTime(SWEEP_MS);
    expect(agentSessions.has(id), "前置：刚活跃过的会话不回收").toBe(true);

    // 第二段启动：之后连续 4 次 sweep（0 / 10 / 20 / 30 分钟）都在上限内。若起算点没清（接着第一段的首次看到算），
    // 第二段第一次 sweep 就已距它 40 分钟、早被回收
    beginTaskStarting(id);
    for (let i = 1; i <= 4; i += 1) {
      vi.advanceTimersByTime(SWEEP_MS);
      expect(agentSessions.has(id), `第二段启动的第 ${i} 次 sweep 仍应在豁免内（计时从头起算）`).toBe(true);
    }
    expect(close).not.toHaveBeenCalled();
  });

  it("起算点在「启动成功、run 占上 runningTasks」时也清：run 跑完之后再来的启动从头起算（不接着旧的首次看到算）", () => {
    const id = alloc();
    const close = vi.fn();
    const session = mkSession("agent_started_then_ran", 18, close) as unknown as { lastActiveAt: number };
    agentSessions.set(id, session as never);

    // 第一段启动：撞上 3 次 sweep（距首次看到 0 / 10 / 20 分钟）
    beginTaskStarting(id);
    for (let i = 0; i < 3; i += 1) vi.advanceTimersByTime(SWEEP_MS);
    expect(agentSessions.has(id)).toBe(true);

    // 启动成功：run 占上 runningTasks（启动中结束）；下一次 sweep 看到 run 在跑 → 起算点清掉
    clearTaskStarting(id);
    runningTasks.set(id, { instanceId: 19 } as never);
    vi.advanceTimersByTime(SWEEP_MS);
    expect(agentSessions.has(id), "前置：run 在跑不回收").toBe(true);

    // run 跑完，会话又闲置了很久，这时来了第二段启动（常见：隔了一阵再追问）：之后连续 4 次 sweep（0 / 10 / 20 / 30 分钟）都在上限内。
    // 若 run 在跑那一次 sweep 没清起算点（接着第一段的首次看到算），第二段第一次 sweep 就已距它 40 分钟、早被回收
    runningTasks.delete(id);
    session.lastActiveAt = Date.now() - IDLE_MS;
    beginTaskStarting(id);
    for (let i = 1; i <= 4; i += 1) {
      vi.advanceTimersByTime(SWEEP_MS);
      expect(agentSessions.has(id), `第二段启动的第 ${i} 次 sweep 仍应在豁免内（run 在跑时已把起算点清掉）`).toBe(true);
    }
    expect(close).not.toHaveBeenCalled();
  });

  it("会话被摘之后起算点不残留：同一个 task 之后新起的会话再遇启动飞行窗，从头起算", () => {
    const id = alloc();
    const close = vi.fn();
    agentSessions.set(id, mkSession("agent_gone", 20, close));

    // 第一个会话：启动飞行窗里撞上 3 次 sweep（距首次看到 0 / 10 / 20 分钟）
    beginTaskStarting(id);
    for (let i = 0; i < 3; i += 1) vi.advanceTimersByTime(SWEEP_MS);
    expect(agentSessions.has(id)).toBe(true);

    // 会话被摘（比如用户停止 / 切提供方）、启动也结束；下一次 sweep 表里已经没有这个 task——起算点要在这时清掉（它不会再被主循环碰到）
    agentSessions.delete(id);
    clearTaskStarting(id);
    vi.advanceTimersByTime(SWEEP_MS);

    // 之后同一个 task 新起了会话、又进了启动飞行窗：连续 4 次 sweep（0 / 10 / 20 / 30 分钟）都在上限内。
    // 若起算点残留（还是第一个会话的首次看到），新窗口第一次 sweep 就已距它 40 分钟、早被回收
    agentSessions.set(id, mkSession("agent_new", 21, close));
    beginTaskStarting(id);
    for (let i = 1; i <= 4; i += 1) {
      vi.advanceTimersByTime(SWEEP_MS);
      expect(agentSessions.has(id), `新会话启动窗口的第 ${i} 次 sweep 仍应在豁免内（旧会话的起算点已清）`).toBe(true);
    }
    expect(close).not.toHaveBeenCalled();
  });

  it("run 在跑（runningTasks 有）：既有行为不变——不回收", () => {
    const id = alloc();
    const close = vi.fn();
    agentSessions.set(id, mkSession("agent_running", 14, close));
    runningTasks.set(id, { instanceId: 15 } as never);

    vi.advanceTimersByTime(SWEEP_MS + 1);

    expect(agentSessions.has(id)).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });
});
