/**
 * 后台子代理结果的「外来来源」继承标记（第十八轮；第十六轮评审 P3-C1 / F3 的收口，用户授权「都按你推荐的来」）
 *
 * 背景：后台子代理（只在 chat 会话里开）做完后，结果以一条「用户身份」的消息回到主 AI。如果这个子代理是在**外来内容驱动的一轮**
 * （群里陌生人的话 / 所有者空 @ 引用别人，会话上有中途标记）里派出的，它的任务书、读到的材料都可能带着陌生人写的内容，输出就是外来来源的数据——
 * 而结果回来时那一轮早已收尾、标记早清了，空闲时唤醒的新一轮是**无标记**的：陌生人的话借子代理的手换了个身份，进了不受限的一轮
 * （desktop_* / 写所有者备注 / 建定时 / 浏览器登录态…都不再被拒）。
 *
 * 修法（决定：继承标记，不丢结果、不降级成纯文本）：
 *  · link 在**派出那一刻**同步读「此刻有没有活标记」（isGroupNonOwnerTurnActive），记在 job 上，收尾事件带 foreignOrigin: true；
 *  · chat-runner 入队时给外来来源的结果加队内前缀（队列 / 重连暂存 / putBack 这套管道照旧是纯字符串）；
 *  · 送出：空闲 = 唤醒的那一轮 foreignContentTurn（agent.send 前一刻同步登记标记、没送达自己回滚）；
 *    忙 = 这一轮已有活标记才 steer（并加入它，置 shared）；没有（属主自己的一轮）就**不 steer**、攒到收尾按空闲那一支带标记送——
 *    与 sendQueuedChatMessageNow 对外来内容「不 steer」同一把尺子；属主来源的结果不受影响，照常 steer；
 *  · 前缀在送进 agent 之前一定剥掉（joinResultsForAgent 是唯一的拼接出口，下面有源码断言）。
 *
 * 真 chat-runner + 真 subagent link + 假 SDK（骨架抄 chat-background-subagents.test.ts）。
 * 「标记」用 beginForeignContentMidRun 造（与 chat-inject / 排队外来内容在 chat 里登记的是同一种中途标记）。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task, TaskEvent } from "@/lib/types";

import { blockAfter, enclosingIfConditions, readSource } from "./helpers/source-text";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-bg-foreign-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockResume = vi.fn();
const mockCreate = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

// getTask 闸门（只给 B4「空闲 busy」用）：drain 的空闲分支在 `await getTask` 处让出事件循环，
// 测试要在这个 await 窗口里让别的消息抢先占上 runActive，才能确定性地造出 sendChatMessage 的 busy。
// 平时 gate 为 null，纯透传到真实实现，不影响别的用例。
const taskFsGate = vi.hoisted(() => ({
  // error：放行（promise resolve）之后让这一次 getTask 抛这个错——造「读任务抛错（meta 半写 / EIO）」；闸门在调用那一刻就被这次调用捕获，之后把 gate 置 null 也不影响它
  gate: null as null | { calls: number; promise: Promise<void>; error?: Error },
}));
vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    getTask: async (...args: Parameters<typeof actual.getTask>) => {
      const g = taskFsGate.gate;
      if (g) {
        g.calls += 1;
        await g.promise;
        if (g.error) throw g.error;
      }
      return actual.getTask(...args);
    },
  };
});

const { readEvents, taskDir, withTaskLock, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  __stashBackgroundResultsForTest,
  __stashedBackgroundResultsSnapshotForTest,
  canSteerChatRun,
  cancelChatRun,
  closeChatSessionUnconditional,
  discardStashedBackgroundResultsForDeletedTask,
  drainBackgroundResults,
  forceClearChatRun,
  getPendingBackgroundResultCount,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { clearChatQueue } = await import("@/lib/server/chat-queue");
const {
  emitBackgroundSubagentSettled,
  FOREIGN_ORIGIN_ARRIVAL_HINT,
  FOREIGN_ORIGIN_PREFIX,
  markForeignOriginResult,
  FOREIGN_ORIGIN_NOTICE,
} = await import("@/lib/server/subagent-background");
const guard = await import("@/lib/server/non-owner-turn-guard");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`chat-background-foreign-origin DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

/** 每个用例一个独立任务 id（迟到的收尾写盘落在自己的目录里，不碰下一个用例） */
let TASK_ID = "t_1700000006000_bgforeign";
let taskSeq = 0;
const usedTaskIds = new Set<string>();
const PARENT_ID = "agent_fake_bgforeign_parent";
const BOOT = { apiKey: "test-key", model: { id: "gpt-test", params: [] as never[] } };

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `bgforeign ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: PARENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;
const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

type SteerOutcome = "complete_delivered" | "revert_to_followup";

/** 手动结束的 run（父 / 子通用）：stream 与 wait 都挂到 release / cancel */
const manualRun = (opts?: { steer?: (text: string) => Promise<SteerOutcome> }) => {
  let release!: (result?: string) => void;
  let result: string | undefined;
  const gate = new Promise<void>((r) => {
    release = (res) => {
      result = res;
      r();
    };
  });
  let cancelled = false;
  const run: Record<string, unknown> = {
    stream: async function* () {
      await gate;
    },
    wait: async () => {
      await gate;
      return cancelled
        ? { status: "cancelled" as const }
        : { status: "finished" as const, result: result ?? "子代理结果" };
    },
    cancel: vi.fn(async () => {
      cancelled = true;
      release();
    }),
    cancelled: () => cancelled,
  };
  if (opts?.steer) run.steer = vi.fn(opts.steer);
  return { run, release };
};

type Tool = { execute: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };

/** 起父会话（resume）+ 发首条消息让一轮 run 在飞；返回父 agent 与 resume 时挂上的 subagent 工具 */
const startParentRun = async (parentRun: Record<string, unknown>) => {
  const parentAgent = {
    agentId: PARENT_ID,
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(parentRun),
  };
  mockResume.mockResolvedValue(parentAgent);
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  const subagentTool = (
    mockResume.mock.calls.at(-1)?.[1] as { local: { customTools: Record<string, Tool> } }
  ).local.customTools.subagent;
  expect(subagentTool).toBeTruthy();
  expect(await sendChatMessage(task, "派几个子代理")).toBe("sent");
  expect(isChatRunActive(TASK_ID)).toBe(true);
  return { parentAgent, subagentTool: subagentTool!, task };
};

const runTool = async (tool: Tool, args: Record<string, unknown>): Promise<string> => {
  const r = await tool.execute(args, {});
  return r.content.map((c) => c.text).join("\n");
};

const childRuns: Array<ReturnType<typeof manualRun>> = [];
const installChildFactory = () => {
  childRuns.length = 0;
  let n = 0;
  mockCreate.mockImplementation(async () => {
    n += 1;
    const r = manualRun();
    childRuns.push(r);
    return { agentId: `child-${n}`, send: vi.fn().mockResolvedValue(r.run), close: vi.fn() };
  });
};

/** 记录父 agent 每次 send：内容 + 「send 被调用那一刻」标记是否已就位；返回本次要给的 run 由 `nextRun` 决定 */
const recordSends = (parentAgent: { send: ReturnType<typeof vi.fn> }, nextRun: () => Record<string, unknown>) => {
  const sends: Array<{ text: string; marker: boolean }> = [];
  parentAgent.send.mockImplementation(async (text: string) => {
    sends.push({ text: String(text), marker: guard.isGroupNonOwnerTurnActive(TASK_ID) });
    return nextRun();
  });
  return sends;
};

const waitQueued = (n: number) =>
  vi.waitFor(() => expect(getPendingBackgroundResultCount(TASK_ID)).toBe(n), { timeout: 5000, interval: 20 });
const waitIdle = () =>
  vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), { timeout: 5000, interval: 30 });
const settleTail = () => new Promise((r) => setTimeout(r, 40));

const quiesceTask = async (taskId: string): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await withTaskLock(taskId, async () => undefined);
    await new Promise((r) => setTimeout(r, 40));
  }
};

beforeEach(async () => {
  taskSeq += 1;
  TASK_ID = `t_1700000006000_bgforeign_${taskSeq}`;
  usedTaskIds.add(TASK_ID);
  mockResume.mockReset();
  mockCreate.mockReset();
  installChildFactory();
  guard.__resetNonOwnerTurnGuardForTest();
  await writeMeta(makeMeta(TASK_ID));
});

afterEach(async () => {
  taskFsGate.gate = null; // 防某个用例中途失败后闸门残留、卡死下一个用例
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  guard.__resetNonOwnerTurnGuardForTest();
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await Promise.all([...usedTaskIds].map((id) => quiesceTask(id)));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

/** 在「有活标记」的状态下派一个后台子代理（= 外来内容驱动的一轮里派的）；返回派出后的工具返回文 */
const dispatchInForeignTurn = async (tool: Tool, description: string) => {
  expect(guard.beginForeignContentMidRun(TASK_ID), "前置：别人的内容送进这一轮、新建中途标记").toBeDefined();
  const out = await runTool(tool, { prompt: `任务：${description}`, description, run_in_background: true });
  expect(out).toContain("已在后台启动");
  return out;
};

// ----------------- 事件流读取（R19-4 的到达提示 / 扣留提示 / 未送达提示都是 info 行） -----------------

const infoTexts = async (): Promise<string[]> =>
  (await readEvents(TASK_ID))
    .filter((e: TaskEvent) => e.kind === "info")
    .map((e) => (e.kind === "info" ? e.text : ""));
/** 扣留提示（noticeForeignBackgroundResultsHeld）：「N 条后台子代理的结果来自群里他人触发的一轮…」 */
const HELD_MARK = "条后台子代理的结果来自群里他人触发的一轮";
const heldNotices = async (): Promise<string[]> => (await infoTexts()).filter((t) => t.includes(HELD_MARK));
/** 「未送达」提示（noticeBackgroundResultsDropped）：「N 条后台子代理的结果未送达主 AI（原因）」 */
const DROPPED_MARK = "条后台子代理的结果未送达主 AI";
const droppedNotices = async (): Promise<string[]> => (await infoTexts()).filter((t) => t.includes(DROPPED_MARK));
/** 等某个数量的扣留提示落盘（fire-and-forget 异步落盘，要轮询） */
const waitHeldNotices = (n: number) =>
  vi.waitFor(async () => expect(await heldNotices()).toHaveLength(n), { timeout: 5000, interval: 30 });
/** 让已发起的事件写盘落定（用于「没有多落一行」这类否定断言：先 flush 再读） */
const flushEvents = () => quiesceTask(TASK_ID);

/**
 * 造「属主自己的一轮在跑（无标记）+ 一个外来来源的结果被扣留」：
 * 第 1 轮外来内容驱动、派 1 个子代理后收尾 → 第 2 轮属主说话（ownerRun，无标记）→ 子代理在第 2 轮里做完 → 被扣留（入队 1 条、落一行扣留提示）。
 */
const setupOwnerTurnWithHeldForeign = async (ownerRun: Record<string, unknown>) => {
  const run1 = manualRun({ steer: async () => "complete_delivered" });
  const { parentAgent, subagentTool, task } = await startParentRun(run1.run);
  await dispatchInForeignTurn(subagentTool, "外来轮派的");
  run1.release("第一轮说完");
  await waitIdle();
  await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "前置：外来的那一轮收尾后标记应已清").toBe(false), {
    timeout: 4000,
  });
  let nextRun: Record<string, unknown> = ownerRun;
  const sends = recordSends(parentAgent, () => nextRun);
  expect(await sendChatMessage(task, "属主又说话")).toBe("sent");
  expect(isChatRunActive(TASK_ID)).toBe(true);
  expect(sends[0]!.marker, "前置：属主这一轮没有标记").toBe(false);
  childRuns[0]!.release("外来来源的结论：HELD-1");
  await waitQueued(1);
  await waitHeldNotices(1);
  return {
    parentAgent,
    task,
    sends,
    setNextRun: (r: Record<string, unknown>) => {
      nextRun = r;
    },
  };
};

/** 不可重试错的 owner 一轮：fail() 后 stream 抛错（走 error 收尾、不进自动重连）；带 steer 才会走到「扣留」分支 */
const fatalOwnerRun = () => {
  let fail!: () => void;
  const gate = new Promise<void>((r) => {
    fail = r;
  });
  const run: Record<string, unknown> = {
    stream: async function* () {
      await gate;
      throw new Error("invalid api key");
    },
    wait: () => new Promise<never>(() => {}),
    cancel: vi.fn(async () => {}),
    steer: vi.fn(async () => "complete_delivered" as const),
  };
  return { run, fail };
};

/** 被作废的结果之后不能被送给同一持久化 agent 的新会话：起新会话发一句，确认 send 里没有这批结果 */
const expectNoLeakToNewSession = async (task: Task, forbidden: string) => {
  const fresh = manualRun();
  const parentB = {
    agentId: PARENT_ID,
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(fresh.run),
  };
  mockResume.mockResolvedValue(parentB);
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, "新对话")).toBe("sent");
  fresh.release();
  await waitIdle();
  await settleTail();
  expect(parentB.send).toHaveBeenCalledTimes(1);
  expect(String(parentB.send.mock.calls[0]![0])).not.toContain(forbidden);
  expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
};

describe("到达提示（R19-4）：外来来源的结果在事件流那一行里多带一句", () => {
  it("A2：外来内容轮里派的子代理收尾 → 「…已完成」那一行以 FOREIGN_ORIGIN_ARRIVAL_HINT 结尾；同一轮里属主来源派的那一行不含（删掉 foreignHint 赋值 / 无条件带都会红）", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { subagentTool } = await startParentRun(parent.run);
    // 甲：属主来源（派出那一刻无标记）；乙：外来内容驱动的轮里派的（有标记）
    expect(
      await runTool(subagentTool, { prompt: "a", description: "属主派的甲", run_in_background: true }),
    ).toContain("已在后台启动");
    await dispatchInForeignTurn(subagentTool, "外来派的乙");
    expect(childRuns).toHaveLength(2);

    childRuns[0]!.release("甲的结论");
    childRuns[1]!.release("乙的结论");
    const lineOf = async (desc: string): Promise<string | undefined> =>
      (await infoTexts()).find((t) => t.includes(`后台子代理「${desc}」已完成`));
    await vi.waitFor(
      async () => {
        expect(await lineOf("属主派的甲")).toBeDefined();
        expect(await lineOf("外来派的乙")).toBeDefined();
      },
      { timeout: 5000, interval: 30 },
    );
    const owner = (await lineOf("属主派的甲"))!;
    const foreign = (await lineOf("外来派的乙"))!;
    expect(foreign.endsWith(FOREIGN_ORIGIN_ARRIVAL_HINT), "外来来源的到达行应以提示结尾").toBe(true);
    expect(foreign).toContain("结果将转交主 AI");
    expect(owner, "属主来源的到达行不该带外来来源的提示").not.toContain(FOREIGN_ORIGIN_ARRIVAL_HINT);
    expect(owner.endsWith("结果将转交主 AI")).toBe(true);
  });
});

describe("空闲时结果回来：外来来源的唤醒带标记", () => {
  it("外来内容驱动的一轮里派的 → 那一轮收尾（标记清了）后结果回来：唤醒的新一轮 send 时标记已就位；正文不带队内前缀、带限制说明；这一轮收尾后标记清掉", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    await dispatchInForeignTurn(subagentTool, "外来轮派的");

    // 那一轮收尾：标记随之清掉（consume 的 finally）——这正是 F3 说的「结果回来时标记早没了」
    const wake = manualRun({ steer: async () => "complete_delivered" });
    const sends = recordSends(parentAgent, () => wake.run);
    parent.release("好的");
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "前置：那一轮收尾后标记应已清").toBe(false), {
      timeout: 4000,
    });
    expect(sends).toHaveLength(0);

    childRuns[0]!.release("子代理的结论：XYZ（可能夹着陌生人的话）");
    await vi.waitFor(() => expect(sends).toHaveLength(1), { timeout: 5000, interval: 30 });
    expect(sends[0]!.text).toContain("[BACKGROUND_SUBAGENT_RESULT]");
    expect(sends[0]!.text).toContain("XYZ");
    expect(sends[0]!.text).toContain(FOREIGN_ORIGIN_NOTICE);
    expect(sends[0]!.text, "队内前缀绝不能进 agent").not.toContain("\u0001");
    expect(
      sends[0]!.marker,
      "外来来源的结果唤醒了一轮、但 send 时没有标记：陌生人的内容借子代理换了身份、进了不受限的一轮",
    ).toBe(true);

    // 这一轮是 foreignContentTurn：收尾时由 consume 的 finally 清标记，不残留给属主下一轮
    wake.release("收到结论");
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "唤醒的那一轮收尾后标记没清").toBe(false), {
      timeout: 4000,
    });
  });

  it("对照：属主自己的一轮里派的 → 唤醒的新一轮没有标记、正文与以前一致（不带限制说明）", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    expect(await runTool(subagentTool, { prompt: "跑长任务", description: "属主轮派的", run_in_background: true })).toContain("已在后台启动");

    const wake = manualRun();
    const sends = recordSends(parentAgent, () => wake.run);
    parent.release("好的");
    await waitIdle();
    childRuns[0]!.release("长任务的结论");
    await vi.waitFor(() => expect(sends).toHaveLength(1), { timeout: 5000, interval: 30 });
    expect(sends[0]!.marker, "属主来源的结果被无故加了标记（会拒属主自己的电脑操作 / 备注 / 定时）").toBe(false);
    expect(sends[0]!.text).toContain("长任务的结论");
    expect(sends[0]!.text).not.toContain(FOREIGN_ORIGIN_NOTICE);
    expect(sends[0]!.text).not.toContain("\u0001");
    wake.release();
  });

  it("失败的外来来源结果同样继承标记（事件直接投递：failed 也是子代理的产出，带着原因回到主 AI）", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent } = await startParentRun(parent.run);
    parent.release("ok");
    await waitIdle();
    const wake = manualRun();
    const sends = recordSends(parentAgent, () => wake.run);

    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_fail_foreign",
      parentAgentId: PARENT_ID,
      description: "会失败的",
      status: "failed",
      text: "rate limited",
      durationMs: 1500,
      detached: false,
      foreignOrigin: true,
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1), { timeout: 5000, interval: 30 });
    expect(sends[0]!.text).toContain("失败了");
    expect(sends[0]!.text).toContain("rate limited");
    expect(sends[0]!.marker).toBe(true);
    wake.release();
  });

  it("被取消的外来来源结果照旧不投递（没有人要，也就没有标记问题）", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent } = await startParentRun(parent.run);
    parent.release("ok");
    await waitIdle();
    const sends = recordSends(parentAgent, () => manualRun().run);
    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_cancel_foreign",
      parentAgentId: PARENT_ID,
      description: "被取消",
      status: "cancelled",
      text: "",
      durationMs: 10,
      detached: false,
      foreignOrigin: true,
    });
    await settleTail();
    expect(sends).toHaveLength(0);
    expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
  });
});

describe("忙时结果回来：外来来源的只进「已有标记」的一轮", () => {
  it("这一轮就是那一轮外来内容驱动的（标记还在）：照常 steer 进去（正文剥掉前缀），标记不动", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { subagentTool } = await startParentRun(parent.run);
    await dispatchInForeignTurn(subagentTool, "外来轮派的");
    const steer = parent.run.steer as ReturnType<typeof vi.fn>;

    childRuns[0]!.release("资料内容：ABC-123");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 30 });
    const delivered = String(steer.mock.calls[0]![0]);
    expect(delivered).toContain("资料内容：ABC-123");
    expect(delivered).toContain(FOREIGN_ORIGIN_NOTICE);
    expect(delivered, "队内前缀绝不能进 agent").not.toContain("\u0001");
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "steer 进已有标记的一轮：标记应仍在").toBe(true);
    expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
  });

  it("steer 进已有标记的一轮时「加入」它（置 shared）：登记者之后回滚（直送没送达等）让位，不把外来来源的结果靠着的标记清掉", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { subagentTool } = await startParentRun(parent.run);
    // 登记者（比如 chat-inject 的直送路径）自己登记了这一轮的标记、拿着 token；子代理在这一轮里派出
    const registrantToken = guard.beginForeignContentMidRun(TASK_ID);
    expect(registrantToken, "前置：新建标记、拿到 token").toBeDefined();
    expect(await runTool(subagentTool, { prompt: "a", description: "外来轮派的", run_in_background: true })).toContain("已在后台启动");
    const steer = parent.run.steer as ReturnType<typeof vi.fn>;
    childRuns[0]!.release("外来来源的结果");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 30 });

    // 登记者的回滚（它那条消息没送出去）：标记已被外来来源的 steer 加入过（shared）且这一轮还在跑 → 让位、不清
    guard.rollbackForeignContentMidRun(TASK_ID, registrantToken);
    expect(
      guard.isGroupNonOwnerTurnActive(TASK_ID),
      "登记者的回滚把外来来源的结果靠着的标记清了：这一轮后半程（含读到那批结果之后）没有标记",
    ).toBe(true);
  });

  it("属主自己的新一轮在跑、没有标记：外来来源的不 steer（等于无标记送达），攒着；这一轮收尾后按空闲那一支带标记唤醒", async () => {
    // 第 1 轮：外来内容驱动、派了后台子代理；收尾后标记清掉
    const run1 = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool, task } = await startParentRun(run1.run);
    await dispatchInForeignTurn(subagentTool, "外来轮派的");
    run1.release("第一轮说完");
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4000 });

    // 第 2 轮：属主自己说话（无标记、能 steer）
    const run2 = manualRun({ steer: async () => "complete_delivered" });
    const run3 = manualRun();
    let nextRun: Record<string, unknown> = run2.run;
    const sends = recordSends(parentAgent, () => nextRun);
    expect(await sendChatMessage(task, "属主又说话")).toBe("sent");
    expect(isChatRunActive(TASK_ID)).toBe(true);
    expect(sends[0]!.marker, "前置：属主这一轮没有标记").toBe(false);

    // 外来来源的结果在属主这一轮里回来：不能 steer
    childRuns[0]!.release("外来来源的结论");
    await waitQueued(1);
    const steer = run2.run.steer as ReturnType<typeof vi.fn>;
    expect(steer, "外来来源的结果被 steer 进了无标记的属主轮").not.toHaveBeenCalled();
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "属主这一轮不该被硬加上标记").toBe(false);

    // 属主这一轮收尾 → 攒着的外来来源结果按「空闲唤醒」带标记送出
    nextRun = run3.run;
    run2.release("属主这一轮说完");
    await vi.waitFor(() => expect(sends).toHaveLength(2), { timeout: 5000, interval: 30 });
    expect(sends[1]!.text).toContain("外来来源的结论");
    expect(sends[1]!.text).not.toContain("\u0001");
    expect(sends[1]!.marker, "攒到收尾后唤醒的那一轮没有标记").toBe(true);
    run3.release();
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4000 });
  });

  it("混着来：属主来源的照常 steer 进属主这一轮，外来来源的留着、收尾后带标记唤醒（两批互不拖累）", async () => {
    const run1 = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool, task } = await startParentRun(run1.run);
    // A：属主轮里派的（无标记）；B：外来内容驱动的轮里派的（有标记）
    expect(await runTool(subagentTool, { prompt: "a", description: "属主派的A", run_in_background: true })).toContain("已在后台启动");
    await dispatchInForeignTurn(subagentTool, "外来派的B");
    expect(childRuns).toHaveLength(2);
    run1.release("第一轮说完");
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4000 });

    const run2 = manualRun({ steer: async () => "complete_delivered" });
    const run3 = manualRun();
    let nextRun: Record<string, unknown> = run2.run;
    const sends = recordSends(parentAgent, () => nextRun);
    expect(await sendChatMessage(task, "属主又说话")).toBe("sent");
    const steer = run2.run.steer as ReturnType<typeof vi.fn>;

    childRuns[0]!.release("A 的结果（属主来源）");
    childRuns[1]!.release("B 的结果（外来来源）");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 30 });
    const steered = String(steer.mock.calls[0]![0]);
    expect(steered).toContain("A 的结果");
    expect(steered, "外来来源的结果混进了无标记的 steer").not.toContain("B 的结果");
    await waitQueued(1); // B 留在队里
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
    // A4：混着来时扣留提示恰好一行，且只数外来来源的（「1 条」，不是队里总共的 2 条、也不是 A+B）
    await waitHeldNotices(1);
    expect((await heldNotices())[0]!.startsWith("1 条"), "扣留提示只数外来来源的").toBe(true);

    nextRun = run3.run;
    run2.release("属主这一轮说完");
    await vi.waitFor(() => expect(sends).toHaveLength(2), { timeout: 5000, interval: 30 });
    expect(sends[1]!.text).toContain("B 的结果");
    expect(sends[1]!.text).not.toContain("A 的结果");
    expect(sends[1]!.marker).toBe(true);
    run3.release();
    await waitIdle();
    await flushEvents();
    expect(await heldNotices(), "混着来：整个过程扣留提示仍只有一行").toHaveLength(1);
  });

  it("对照：属主来源的结果在属主这一轮里照常 steer（没有被外来来源的规则误伤）", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { subagentTool } = await startParentRun(parent.run);
    expect(await runTool(subagentTool, { prompt: "a", description: "属主派的", run_in_background: true })).toContain("已在后台启动");
    const steer = parent.run.steer as ReturnType<typeof vi.fn>;
    childRuns[0]!.release("属主来源的结果");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 30 });
    expect(String(steer.mock.calls[0]![0])).toContain("属主来源的结果");
    expect(String(steer.mock.calls[0]![0])).not.toContain(FOREIGN_ORIGIN_NOTICE);
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
    // A4 对照：属主来源的 steer 进属主一轮，不属于「扣留」——事件流里没有扣留提示（到达那行先落、扣留提示若有会排在它之后）
    await vi.waitFor(async () => expect((await infoTexts()).some((t) => t.includes("后台子代理「属主派的」已完成"))).toBe(true), {
      timeout: 5000,
      interval: 30,
    });
    await flushEvents();
    expect(await heldNotices(), "属主来源的结果被误报成「扣留」").toHaveLength(0);
  });
});

describe("扣留提示（R19-4 noticeForeignBackgroundResultsHeld）：落一行、按条数去重、送出后清零", () => {
  it("A3：属主一轮里外来来源的结果被扣留 → 恰好一行「1 条…」；重复 drain 不重复落；第二个到达再落「2 条…」（累计）；带标记送出后清零、再扣留会再提示（删掉调用 / 去重条件改 true / 清零删掉都会红）", async () => {
    const run1 = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool, task } = await startParentRun(run1.run);
    // 外来内容轮里派两个外来来源的子代理：第一个走 dispatchInForeignTurn（内含「新建标记」断言，只能调一次）；
    // 第二个在标记还活着时直接 runTool（派出那一刻读到活标记 → foreignOrigin）
    await dispatchInForeignTurn(subagentTool, "外来派的甲");
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "前置：标记还活着").toBe(true);
    expect(
      await runTool(subagentTool, { prompt: "b", description: "外来派的乙", run_in_background: true }),
    ).toContain("已在后台启动");
    expect(childRuns).toHaveLength(2);
    run1.release("第一轮说完");
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "前置：外来的那一轮收尾后标记应已清").toBe(false), {
      timeout: 4000,
    });

    // 第 2 轮：属主自己说话（无标记、能 steer）
    const run2 = manualRun({ steer: async () => "complete_delivered" });
    const run3 = manualRun();
    let nextRun: Record<string, unknown> = run2.run;
    const sends = recordSends(parentAgent, () => nextRun);
    expect(await sendChatMessage(task, "属主说话")).toBe("sent");
    expect(sends[0]!.marker).toBe(false);
    const steer2 = run2.run.steer as ReturnType<typeof vi.fn>;

    // 第一个外来来源的结果到达 → 被扣留 → 恰好一行「1 条」
    childRuns[0]!.release("甲的结论：AAA");
    await waitQueued(1);
    await waitHeldNotices(1);
    expect((await heldNotices())[0]!.startsWith("1 条")).toBe(true);
    expect((await heldNotices())[0], "扣留提示要说清「已暂存、待这一轮结束后转交」").toContain("已暂存");

    // 同一批：再调两次 drain（等同于别处顺带触发的 drain）不重复落
    await drainBackgroundResults(TASK_ID);
    await drainBackgroundResults(TASK_ID);
    expect(getPendingBackgroundResultCount(TASK_ID), "扣留的仍在队里").toBe(1);
    expect(steer2, "外来来源的不能 steer 进属主的一轮").not.toHaveBeenCalled();

    // 第二个外来来源的结果到达 → 累计 2 条，再落一行「2 条」（不是「1 条」重复）
    childRuns[1]!.release("乙的结论：BBB");
    await waitQueued(2);
    await waitHeldNotices(2);
    await flushEvents();
    const held = await heldNotices();
    expect(held, "到此为止应恰好两行：1 条、2 条（重复 drain 的那两次没有多落）").toHaveLength(2);
    expect(held[0]!.startsWith("1 条")).toBe(true);
    expect(held[1]!.startsWith("2 条")).toBe(true);
    expect(steer2).not.toHaveBeenCalled();

    // 这一轮收尾 → 扣留的两条合并、带标记唤醒送出
    nextRun = run3.run;
    run2.release("属主这一轮说完");
    await vi.waitFor(() => expect(sends).toHaveLength(2), { timeout: 5000, interval: 30 });
    expect(sends[1]!.text).toContain("AAA");
    expect(sends[1]!.text).toContain("BBB");
    expect(sends[1]!.text).not.toContain("\u0001");
    expect(sends[1]!.marker, "扣留的外来来源结果必须带标记送出").toBe(true);
    run3.release();
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4000 });

    // 送出后 foreignHeldNoticed 清零：再造一轮扣留（属主第三轮 + 一个新的外来来源结果）→ 提示会再次出现，且是「1 条」
    const run4 = manualRun({ steer: async () => "complete_delivered" });
    const run5 = manualRun();
    nextRun = run4.run;
    expect(await sendChatMessage(task, "属主第三次说话")).toBe("sent");
    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_foreign_again",
      parentAgentId: PARENT_ID,
      description: "外来派的丙",
      status: "done",
      text: "丙的结论：CCC",
      durationMs: 20,
      detached: false,
      foreignOrigin: true,
    });
    await waitQueued(1);
    await waitHeldNotices(3);
    expect((await heldNotices())[2]!.startsWith("1 条"), "清零后再扣留应重新从「1 条」起提示").toBe(true);

    // 收尾：扣留的丙带标记送出，别留悬空的 run
    nextRun = run5.run;
    run4.release("属主第三轮说完");
    await vi.waitFor(() => expect(sends).toHaveLength(4), { timeout: 5000, interval: 30 });
    expect(sends[3]!.text).toContain("CCC");
    expect(sends[3]!.marker).toBe(true);
    run5.release();
    await waitIdle();
  });

  it("A3 补：扣留后「这一轮有了标记」被 steer 并入（忙分支的清零）→ 之后新一轮再扣留会再次提示（删掉忙分支里的 foreignHeldNoticed = 0 会红）", async () => {
    const run2 = manualRun({ steer: async () => "complete_delivered" });
    const { task, sends, setNextRun } = await setupOwnerTurnWithHeldForeign(run2.run);
    expect((await heldNotices())[0]!.startsWith("1 条")).toBe(true);

    // 别路的外来内容中途进了属主这一轮（chat-inject 直送等登记同一种中途标记）→ 这一轮有标记了：
    // 再 drain 时扣留的那条按「标记活着」steer 进去（并入有标记的一轮），清零 foreignHeldNoticed
    expect(guard.beginForeignContentMidRun(TASK_ID), "前置：这一轮没有标记、新建一个").toBeDefined();
    await drainBackgroundResults(TASK_ID);
    const steer2 = run2.run.steer as ReturnType<typeof vi.fn>;
    expect(steer2).toHaveBeenCalledTimes(1);
    expect(String(steer2.mock.calls[0]![0])).toContain("HELD-1");
    expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);

    // 这一轮收尾（标记随之清掉）；新的属主一轮里又来一个外来来源的结果 → 被扣留，应再提示一次「1 条」
    run2.release("属主这一轮说完");
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4000 });
    expect(sends, "没有额外唤醒（那条已经 steer 进去了）").toHaveLength(1);
    const run4 = manualRun({ steer: async () => "complete_delivered" });
    const run5 = manualRun();
    setNextRun(run4.run);
    expect(await sendChatMessage(task, "属主又说话")).toBe("sent");
    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_foreign_after_merge",
      parentAgentId: PARENT_ID,
      description: "又一个外来派的",
      status: "done",
      text: "新的外来结论：NEW-1",
      durationMs: 20,
      detached: false,
      foreignOrigin: true,
    });
    await waitQueued(1);
    await waitHeldNotices(2);
    expect((await heldNotices())[1]!.startsWith("1 条"), "并入有标记的一轮后计数应清零").toBe(true);

    setNextRun(run5.run);
    run4.release("说完");
    await vi.waitFor(() => expect(sends).toHaveLength(3), { timeout: 5000, interval: 30 });
    expect(sends[2]!.marker).toBe(true);
    run5.release();
    await waitIdle();
  });
});

describe("F3 管道的盲点（R19-11）：空闲 / 退回 / 失败 / busy 各出口上的标记与结果去向", () => {
  it("B1：混批在空闲时到达（属主来源 + 外来来源都在这一轮收尾前入队，这一轮不能 steer）→ 收尾后只唤醒一次、send 时标记在、正文含两条且无前缀（`some`→`every` 会红）", async () => {
    const parent = manualRun(); // 没有 steer：canSteerChatRun 为假，结果只能攒着
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    // 甲：属主来源（无标记时派）；乙：外来内容驱动的轮里派的（有标记）
    expect(
      await runTool(subagentTool, { prompt: "a", description: "属主派的甲", run_in_background: true }),
    ).toContain("已在后台启动");
    await dispatchInForeignTurn(subagentTool, "外来派的乙");
    expect(childRuns).toHaveLength(2);

    childRuns[0]!.release("甲的结果（属主来源）：MIX-A");
    childRuns[1]!.release("乙的结果（外来来源）：MIX-B");
    await waitQueued(2);
    expect(isChatRunActive(TASK_ID)).toBe(true);
    // R20-3 对照：这一轮不能 steer、但此刻有活标记（它本来就是带标记的一轮，收尾后照常带标记送出）→ 不算「所有者自己的一轮里被扣留」，不该落扣留提示
    expect(canSteerChatRun(TASK_ID), "前置：这一轮确实不能 steer").toBe(false);
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "前置：标记活着").toBe(true);
    await flushEvents();
    expect(await heldNotices(), "有活标记的一轮不是「所有者自己的一轮」，不该落扣留提示").toHaveLength(0);

    const wake = manualRun();
    const sends = recordSends(parentAgent, () => wake.run);
    parent.release("这一轮说完");
    await vi.waitFor(() => expect(sends).toHaveLength(1), { timeout: 5000, interval: 30 });
    expect(sends[0]!.text).toContain("MIX-A");
    expect(sends[0]!.text).toContain("MIX-B");
    expect(sends[0]!.text.match(/\[BACKGROUND_SUBAGENT_RESULT\]/g)).toHaveLength(2);
    expect(sends[0]!.text, "队内前缀绝不能进 agent").not.toContain("\u0001");
    expect(
      sends[0]!.marker,
      "混批里有外来来源的、却无标记唤醒：外来来源的结果借着同批属主来源的结果进了不受限的一轮",
    ).toBe(true);
    // 只唤醒一次（两条合并），不是各唤醒一次
    await settleTail();
    expect(sends).toHaveLength(1);
    wake.release();
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "唤醒的那一轮收尾后标记没清").toBe(false), {
      timeout: 4000,
    });
  });

  it("B2：steer 返回 revert_to_followup（标记活着）→ 结果放回队首 → 这一轮收尾后带标记唤醒送出，只送一次、无前缀泄漏（删掉 putBack / putBack 剥前缀会红）", async () => {
    const parent = manualRun({ steer: async () => "revert_to_followup" });
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    await dispatchInForeignTurn(subagentTool, "外来轮派的");
    const steer = parent.run.steer as ReturnType<typeof vi.fn>;
    const wake = manualRun();
    const sends = recordSends(parentAgent, () => wake.run);

    childRuns[0]!.release("退回的结果：REVERT-1");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 30 });
    // steer 被退回：放回队首（这一轮还在跑，不会立刻再 drain）
    await waitQueued(1);
    expect(sends, "这一轮还在跑，不该另起一轮").toHaveLength(0);

    parent.release("这一轮说完");
    await vi.waitFor(() => expect(sends).toHaveLength(1), { timeout: 5000, interval: 30 });
    expect(sends[0]!.text).toContain("REVERT-1");
    expect(sends[0]!.text.match(/REVERT-1/g), "同一条结果只送一次").toHaveLength(1);
    expect(sends[0]!.text, "putBack 放回的字符串仍是带前缀的、送出前必须剥掉").not.toContain("\u0001");
    expect(sends[0]!.marker, "放回后唤醒的外来来源结果没带标记").toBe(true);
    expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
    await settleTail();
    expect(sends, "没有再送第二次").toHaveLength(1);
    expect(steer, "退回之后没有再 steer").toHaveBeenCalledTimes(1);
    wake.release();
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4000 });
  });

  it("B3：空闲唤醒时 agent.send 抛错（sendChatMessage 关会话、回 send_failed）→ 结果作废并写「未送达（会话已关闭）」、不复活；外来内容轮登记的标记已回滚不残留（删掉 putBack / 回滚会红）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parent = manualRun({ steer: async () => "complete_delivered" });
      const { parentAgent, subagentTool, task } = await startParentRun(parent.run);
      await dispatchInForeignTurn(subagentTool, "外来轮派的");
      parent.release("第一轮说完");
      await waitIdle();
      await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "前置：标记已清").toBe(false), { timeout: 4000 });

      // 唤醒送出时 agent.send 抛错：记录「抛错那一刻标记是否已登记」
      const sends: Array<{ text: string; marker: boolean }> = [];
      parentAgent.send.mockImplementation(async (text: string) => {
        sends.push({ text: String(text), marker: guard.isGroupNonOwnerTurnActive(TASK_ID) });
        throw new Error("send boom");
      });
      childRuns[0]!.release("送不出去的结果：LOST-1");

      await vi.waitFor(() => expect(sends).toHaveLength(1), { timeout: 5000, interval: 30 });
      expect(sends[0]!.marker, "外来来源的唤醒应在 agent.send 前一刻登记标记").toBe(true);
      expect(sends[0]!.text).toContain("LOST-1");
      expect(sends[0]!.text).not.toContain("\u0001");

      // sendChatMessage 的 send 抛错分支：关会话（reason=error）返回 send_failed；drain 的 putBack 见会话已换 → 如实写「未送达」
      await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), { timeout: 5000, interval: 30 });
      await vi.waitFor(
        async () => {
          const dropped = await droppedNotices();
          expect(dropped).toHaveLength(1);
          expect(dropped[0]).toContain("1 条后台子代理的结果未送达主 AI（会话已关闭）");
        },
        { timeout: 5000, interval: 30 },
      );
      expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "没送出去：唤醒时登记的标记必须回滚、不能挡属主的下一轮").toBe(false);
      expect(getPendingBackgroundResultCount(TASK_ID), "作废、不留在队里").toBe(0);
      await settleTail();
      expect(sends, "没有重试 / 复活再送").toHaveLength(1);
      expect(await droppedNotices(), "只写一条").toHaveLength(1);
      await expectNoLeakToNewSession(task, "LOST-1");
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("B4：空闲唤醒在 `await getTask` 的窗口里被别的消息抢先占上 runActive（sendChatMessage 回 busy）→ 结果放回、不丢不重；抢先的那一轮收尾后才带标记送出（删掉 busy 的 putBack 会红）", async () => {
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool, task } = await startParentRun(parent.run);
    await dispatchInForeignTurn(subagentTool, "外来轮派的");
    parent.release("第一轮说完");
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "前置：标记已清").toBe(false), { timeout: 4000 });

    const racer = manualRun(); // 抢先的用户消息的那一轮
    const afterRacer = manualRun();
    let nextRun: Record<string, unknown> = racer.run;
    const sends = recordSends(parentAgent, () => nextRun);

    // 闸住 drain 空闲分支里的 getTask：结果出队后卡在这个 await 里
    let openGate!: () => void;
    const gate = { calls: 0, promise: new Promise<void>((r) => (openGate = r)) };
    taskFsGate.gate = gate;
    childRuns[0]!.release("被抢跑的结果：BUSY-1");
    await vi.waitFor(() => expect(gate.calls, "drain 应已走到空闲分支的 getTask").toBeGreaterThan(0), {
      timeout: 5000,
      interval: 10,
    });
    expect(getPendingBackgroundResultCount(TASK_ID), "前置：结果已 splice 出队、只在 drain 手里").toBe(0);

    // 此刻别的消息抢先送出：占上 runActive
    expect(await sendChatMessage(task, "用户抢先说话")).toBe("sent");
    expect(isChatRunActive(TASK_ID)).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toBe("用户抢先说话");

    // 放行 drain：sendChatMessage 回 busy → putBack
    taskFsGate.gate = null;
    openGate();
    await waitQueued(1);
    expect(sends, "busy：没有往 agent 送").toHaveLength(1);
    expect(await droppedNotices(), "busy 是放回、不是作废").toHaveLength(0);

    // 抢先那一轮收尾 → drain 再送：这次空闲、带标记
    nextRun = afterRacer.run;
    racer.release("抢先那一轮说完");
    await vi.waitFor(() => expect(sends).toHaveLength(2), { timeout: 5000, interval: 30 });
    expect(sends[1]!.text).toContain("BUSY-1");
    expect(sends[1]!.text.match(/BUSY-1/g)).toHaveLength(1);
    expect(sends[1]!.text).not.toContain("\u0001");
    expect(sends[1]!.marker, "busy 放回后唤醒的外来来源结果没带标记").toBe(true);
    expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
    afterRacer.release();
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4000 });
  });

  it("B6：标记活着 → steer 外来来源的结果这一支上，照样 interruptWaits：主 AI 睡着的 wait 被提前叫醒（[WAIT_INTERRUPTED]），结果随即 steer 进去（删掉 interruptWaits 会红）", async () => {
    const { activeWaitCount, interruptWaits } = await import("@/lib/server/session-wait");
    const parent = manualRun({ steer: async () => "complete_delivered" });
    const { subagentTool } = await startParentRun(parent.run);
    const waitTool = (mockResume.mock.calls.at(-1)?.[1] as { local: { customTools: Record<string, Tool> } }).local
      .customTools.wait!;
    expect(waitTool).toBeTruthy();

    await dispatchInForeignTurn(subagentTool, "外来轮派的");
    const sleeping = runTool(waitTool, { seconds: 600, reason: "等后台子代理" });
    expect(activeWaitCount(TASK_ID)).toBe(1);
    const steer = parent.run.steer as ReturnType<typeof vi.fn>;

    try {
      childRuns[0]!.release("外来来源的资料：WAKE-1");
      // 没叫醒就会一直睡到测试超时：用带上限的竞速把「没醒」变成明确的断言失败
      const wakeText = await Promise.race([
        sleeping,
        new Promise<string>((r) => setTimeout(() => r("TIMEOUT：wait 没被叫醒"), 8000)),
      ]);
      expect(wakeText, "外来来源的 steer 分支漏了 interruptWaits：睡着的 wait 压住了结果").toMatch(/^\[WAIT_INTERRUPTED\]/);
      expect(activeWaitCount(TASK_ID)).toBe(0);
      await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1), { timeout: 3000 });
      const delivered = String(steer.mock.calls[0]![0]);
      expect(delivered).toContain("WAKE-1");
      expect(delivered).not.toContain("\u0001");
      expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "steer 进已有标记的一轮：标记应仍在").toBe(true);
    } finally {
      interruptWaits(TASK_ID, "cancel"); // 失败时也别留着 600 秒的睡眠
      await sleeping.catch(() => undefined);
    }
  });
});

describe("B7：被扣留的外来来源结果遇到 stop / error → 作废并写「未送达」，之后不会被送出", () => {
  it("B7a 用户停止（cancelChatRun）：属主一轮被停 → 会话关闭、扣留的结果作废并写「1 条…未送达（会话已关闭）」；不另起唤醒、不泄给之后的新会话（删掉 closeChatSession 的作废提示 / 清队会红）", async () => {
    const ownerRun = manualRun({ steer: async () => "complete_delivered" });
    const { task, sends } = await setupOwnerTurnWithHeldForeign(ownerRun.run);
    expect(await droppedNotices(), "前置：扣留阶段还没有「未送达」").toHaveLength(0);

    expect(cancelChatRun(TASK_ID)).toBe(true);
    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), { timeout: 8000, interval: 30 });
    await vi.waitFor(
      async () => {
        const dropped = await droppedNotices();
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain("1 条后台子代理的结果未送达主 AI（会话已关闭）");
      },
      { timeout: 8000, interval: 30 },
    );
    expect(getPendingBackgroundResultCount(TASK_ID), "扣留的批随会话作废").toBe(0);
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
    await settleTail();
    expect(sends, "停止后不再有任何送达（没有带标记的唤醒）").toHaveLength(1);
    expect(await droppedNotices(), "只写一条").toHaveLength(1);
    await expectNoLeakToNewSession(task, "HELD-1");
  });

  it("B7b 这一轮出错收尾（不可重试错）：扣留的结果作废并写「1 条…未送达（对话出错收尾）」；不另起唤醒、不泄给之后的新会话（删掉 closeChatSession 的作废提示会红）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fatal = fatalOwnerRun();
      const { task, sends } = await setupOwnerTurnWithHeldForeign(fatal.run);
      expect(await droppedNotices(), "前置：扣留阶段还没有「未送达」").toHaveLength(0);

      fatal.fail();
      await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), { timeout: 8000, interval: 30 });
      await vi.waitFor(
        async () => {
          const dropped = await droppedNotices();
          expect(dropped).toHaveLength(1);
          expect(dropped[0]).toContain("1 条后台子代理的结果未送达主 AI（对话出错收尾）");
        },
        { timeout: 8000, interval: 30 },
      );
      expect((await readEvents(TASK_ID)).some((e) => e.kind === "error"), "前置：确实走了 error 收尾").toBe(true);
      expect(getPendingBackgroundResultCount(TASK_ID), "扣留的批随会话作废").toBe(0);
      expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
      await settleTail();
      expect(sends, "出错后不再有任何送达（没有带标记的唤醒）").toHaveLength(1);
      expect(await droppedNotices(), "只写一条").toHaveLength(1);
      await expectNoLeakToNewSession(task, "HELD-1");
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("R20-3：不能 steer 的一轮里，外来来源的结果同样落扣留提示（早退不再无声）", () => {
  it("B8：属主一轮不能 steer → 外来来源的结果入队即落一行「1 条…」；重复 drain 不重复；第二个到达累计「2 条…」；这一轮收尾后带标记送出、无「未送达」（早退改回无提示 / 去重失效 / 条数口径错都会红）", async () => {
    const ownerRun = manualRun(); // 没有 steer：canSteerChatRun 为假 → 整批只能等这一轮收尾
    // setupOwnerTurnWithHeldForeign 自己会等「入队 1 条 + 落 1 行扣留提示」：早退分支不落提示时，这里就超时红
    const { sends, setNextRun } = await setupOwnerTurnWithHeldForeign(ownerRun.run);
    expect(canSteerChatRun(TASK_ID), "前置：属主这一轮确实不能 steer（走的是早退分支，不是 steer 分支）").toBe(false);
    expect((await heldNotices())[0]!.startsWith("1 条")).toBe(true);
    expect((await heldNotices())[0], "扣留提示要说清「已暂存、待这一轮结束后转交」").toContain("已暂存");

    // 同一批：重复 drain（等同别处顺带触发）不重复落
    await drainBackgroundResults(TASK_ID);
    await drainBackgroundResults(TASK_ID);
    await flushEvents();
    expect(await heldNotices(), "重复 drain 不该重复提示").toHaveLength(1);
    expect(getPendingBackgroundResultCount(TASK_ID), "扣留的仍在队里").toBe(1);

    // 第二个外来来源的结果到达 → 累计「2 条」（不是「1 条」重复）
    emitBackgroundSubagentSettled(TASK_ID, {
      jobId: "bg_foreign_nosteer_2",
      parentAgentId: PARENT_ID,
      description: "外来派的丁",
      status: "done",
      text: "丁的结论：HELD-2",
      durationMs: 20,
      detached: false,
      foreignOrigin: true,
    });
    await waitQueued(2);
    await waitHeldNotices(2);
    await flushEvents();
    const held = await heldNotices();
    expect(held, "到此为止应恰好两行：1 条、2 条").toHaveLength(2);
    expect(held[1]!.startsWith("2 条"), "累计条数").toBe(true);

    // 这一轮收尾 → 扣留的两条合并、带标记唤醒送出
    const wake = manualRun();
    setNextRun(wake.run);
    ownerRun.release("属主这一轮说完");
    await vi.waitFor(() => expect(sends).toHaveLength(2), { timeout: 5000, interval: 30 });
    expect(sends[1]!.text).toContain("HELD-1");
    expect(sends[1]!.text).toContain("HELD-2");
    expect(sends[1]!.text, "队内前缀绝不能进 agent").not.toContain("\u0001");
    expect(sends[1]!.marker, "扣留的外来来源结果必须带标记送出").toBe(true);
    wake.release();
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4000 });
    await flushEvents();
    expect(await droppedNotices(), "送出了，不该有「未送达」").toHaveLength(0);
    expect(await heldNotices(), "送出过程没有再多落扣留提示").toHaveLength(2);
  });

  it("B9 对照：不能 steer 的属主一轮里，属主来源的结果照旧只等收尾——不落扣留提示（条数口径只数外来来源的）、收尾后无标记唤醒送出", async () => {
    const parent = manualRun(); // 没有 steer
    const { parentAgent, subagentTool } = await startParentRun(parent.run);
    expect(
      await runTool(subagentTool, { prompt: "a", description: "属主派的", run_in_background: true }),
    ).toContain("已在后台启动");
    const wake = manualRun();
    const sends = recordSends(parentAgent, () => wake.run);

    childRuns[0]!.release("属主来源的结果：OWN-1");
    await waitQueued(1);
    expect(canSteerChatRun(TASK_ID), "前置：这一轮不能 steer").toBe(false);
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "前置：没有标记").toBe(false);
    await flushEvents();
    expect(await heldNotices(), "属主来源的结果不是外来来源、不算扣留").toHaveLength(0);

    parent.release("这一轮说完");
    await vi.waitFor(() => expect(sends).toHaveLength(1), { timeout: 5000, interval: 30 });
    expect(sends[0]!.text).toContain("OWN-1");
    expect(sends[0]!.marker, "属主来源的不该被当成外来来源带标记").toBe(false);
    wake.release();
    await waitIdle();
    await flushEvents();
    expect(await heldNotices()).toHaveLength(0);
    expect(await droppedNotices()).toHaveLength(0);
  });
});

describe("R20-4：空闲唤醒（drain 空闲分支）的四个「作废」出口都如实写「未送达」（B10 cancelled / B11 owner_invalid / B12 no_session / B13 读任务失败）", () => {
  const DROPPED_TEXT = "1 条后台子代理的结果未送达主 AI（会话已关闭或被停止）";

  /** 会话空闲 + 第 1 轮（外来内容驱动、已收尾、标记已清）里派的外来来源子代理还没做完 */
  const setupIdleWithForeignChild = async () => {
    const run1 = manualRun({ steer: async () => "complete_delivered" });
    const { parentAgent, subagentTool, task } = await startParentRun(run1.run);
    await dispatchInForeignTurn(subagentTool, "外来轮派的");
    run1.release("第一轮说完");
    await waitIdle();
    await vi.waitFor(() => expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "前置：外来的那一轮收尾后标记应已清").toBe(false), {
      timeout: 4000,
    });
    return { parentAgent, task };
  };

  /** 让下一次 agent.send 挂起——由测试决定何时受理（resolve）；用来在「send 在飞」的窗口里插入 stop / 强清 */
  const pendingSend = (parentAgent: { send: ReturnType<typeof vi.fn> }) => {
    const sends: Array<{ text: string; marker: boolean }> = [];
    let accept: ((run: Record<string, unknown>) => void) | undefined;
    parentAgent.send.mockImplementation((text: string) => {
      sends.push({ text: String(text), marker: guard.isGroupNonOwnerTurnActive(TASK_ID) });
      return new Promise<Record<string, unknown>>((resolve) => {
        accept = resolve;
      });
    });
    return {
      sends,
      accept: (run: Record<string, unknown>) => {
        if (!accept) throw new Error("agent.send 还没被调用、没有可受理的挂起");
        accept(run);
      },
    };
  };

  const expectDroppedOnce = () =>
    vi.waitFor(
      async () => {
        const dropped = await droppedNotices();
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain(DROPPED_TEXT);
      },
      { timeout: 8000, interval: 30 },
    );

  it("B10 cancelled：唤醒的 agent.send 在飞时用户停止 → 会话关闭、sendChatMessage 回 cancelled → 写「1 条…未送达（会话已关闭或被停止）」；外来来源登记的标记已回滚；迟到 run 被 cancel；不复活、不泄给新会话", async () => {
    const { parentAgent, task } = await setupIdleWithForeignChild();
    const send = pendingSend(parentAgent);
    const late = manualRun();

    childRuns[0]!.release("在飞时被停的结果：CANCEL-1");
    await vi.waitFor(() => expect(send.sends).toHaveLength(1), { timeout: 5000, interval: 30 });
    expect(send.sends[0]!.text).toContain("CANCEL-1");
    expect(send.sends[0]!.marker, "外来来源的唤醒应在 agent.send 前一刻登记标记").toBe(true);
    expect(getPendingBackgroundResultCount(TASK_ID), "前置：结果已出队、只在 drain 手里").toBe(0);

    // 此刻 send 在飞：用户停止，然后 send 才受理
    expect(cancelChatRun(TASK_ID)).toBe(true);
    send.accept(late.run);

    await vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), { timeout: 8000, interval: 30 });
    await expectDroppedOnce();
    expect(late.run.cancel as ReturnType<typeof vi.fn>, "迟到受理的 run 要被取消").toHaveBeenCalled();
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "没送达：唤醒时登记的标记必须回滚、不能挡属主的下一轮").toBe(false);
    expect(getPendingBackgroundResultCount(TASK_ID), "作废、不留在队里").toBe(0);
    await settleTail();
    expect(send.sends, "没有重试 / 复活再送").toHaveLength(1);
    expect(await droppedNotices(), "只写一条").toHaveLength(1);
    await expectNoLeakToNewSession(task, "CANCEL-1");
  });

  it("B11 owner_invalid：唤醒的 agent.send 在飞时实例被强清（懒重启，用户没停）→ 回 owner_invalid → 同样写「1 条…未送达（会话已关闭或被停止）」；标记不残留；迟到 run 被 cancel", async () => {
    const { parentAgent, task } = await setupIdleWithForeignChild();
    const send = pendingSend(parentAgent);
    const late = manualRun();

    childRuns[0]!.release("在飞时被换掉的结果：INVALID-1");
    await vi.waitFor(() => expect(send.sends).toHaveLength(1), { timeout: 5000, interval: 30 });
    expect(send.sends[0]!.marker, "外来来源的唤醒应在 agent.send 前一刻登记标记").toBe(true);

    // 强清不是用户停止：不会把 cancelledDuringSend 置位，迟到的 send 只能按「实例被替换」收敛成 owner_invalid
    forceClearChatRun(TASK_ID);
    expect(hasChatSession(TASK_ID)).toBe(false);
    send.accept(late.run);

    await expectDroppedOnce();
    expect(late.run.cancel as ReturnType<typeof vi.fn>, "迟到受理的 run 要被取消").toHaveBeenCalled();
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "强清 / 回滚之后标记不能残留").toBe(false);
    expect(getPendingBackgroundResultCount(TASK_ID), "作废、不留在队里").toBe(0);
    await settleTail();
    expect(send.sends, "没有重试 / 复活再送").toHaveLength(1);
    expect(await droppedNotices(), "只写一条").toHaveLength(1);
    await expectNoLeakToNewSession(task, "INVALID-1");
  });

  it("B12 no_session：唤醒在 `await getTask` 的窗口里会话被关（回退等）→ sendChatMessage 回 no_session → 写「1 条…未送达（会话已关闭或被停止）」，不是悄悄没了；不往 agent 送", async () => {
    const { parentAgent, task } = await setupIdleWithForeignChild();
    const sends = recordSends(parentAgent, () => manualRun().run);

    let openGate!: () => void;
    const gate = { calls: 0, promise: new Promise<void>((r) => (openGate = r)) };
    taskFsGate.gate = gate;
    childRuns[0]!.release("会话没了的结果：GONE-1");
    await vi.waitFor(() => expect(gate.calls, "drain 应已走到空闲分支的 getTask").toBeGreaterThan(0), {
      timeout: 5000,
      interval: 10,
    });
    expect(getPendingBackgroundResultCount(TASK_ID), "前置：结果已出队、只在 drain 手里（closeChatSession 的作废提示数不到它）").toBe(0);

    // getTask 这个 await 里会话被无条件关掉（回退走的就是这个入口）
    closeChatSessionUnconditional(TASK_ID);
    expect(hasChatSession(TASK_ID)).toBe(false);
    taskFsGate.gate = null;
    openGate();

    await expectDroppedOnce();
    expect(sends, "会话没了，没有往 agent 送").toHaveLength(0);
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "没登记过标记").toBe(false);
    await settleTail();
    expect(await droppedNotices(), "只写一条").toHaveLength(1);
    await expectNoLeakToNewSession(task, "GONE-1");
  });

  it("B13 读任务失败：唤醒在 `await getTask` 里读任务抛错（meta 半写 / EIO）→ 这批已出队、只有 drain 手里还拿着——不能让异常把它悄悄带走：写「1 条…未送达（读取任务失败）」；不往 agent 送、没登记标记、不复活", async () => {
    const { parentAgent, task } = await setupIdleWithForeignChild();
    const sends = recordSends(parentAgent, () => manualRun().run);

    let openGate!: () => void;
    const gate = { calls: 0, promise: new Promise<void>((r) => (openGate = r)), error: new Error("EIO: 读 meta.json 失败（测试注入）") };
    taskFsGate.gate = gate;
    childRuns[0]!.release("读任务失败的结果：EIO-1");
    await vi.waitFor(() => expect(gate.calls, "drain 应已走到空闲分支的 getTask").toBeGreaterThan(0), {
      timeout: 5000,
      interval: 10,
    });
    expect(getPendingBackgroundResultCount(TASK_ID), "前置：结果已出队、只在 drain 手里").toBe(0);

    // 只让这一次 getTask 抛：闸门置空（后面落提示等路径照常读任务），已在等的那次调用仍会抛
    taskFsGate.gate = null;
    openGate();

    await vi.waitFor(
      async () => {
        const dropped = await droppedNotices();
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain("读取任务失败");
        expect(dropped[0]).toContain("1 条后台子代理的结果未送达主 AI");
      },
      { timeout: 8000, interval: 30 },
    );
    expect(sends, "读不到任务，没有往 agent 送").toHaveLength(0);
    expect(guard.isGroupNonOwnerTurnActive(TASK_ID), "没登记过标记").toBe(false);
    expect(getPendingBackgroundResultCount(TASK_ID), "作废、不留在队里").toBe(0);
    await settleTail();
    expect(await droppedNotices(), "只写一条").toHaveLength(1);
    // 与 B10~B12 不同：读任务失败不关会话（会话仍空闲在着）——作废的那批不会混进之后用户正常说的话
    expect(hasChatSession(TASK_ID), "读任务失败不关会话").toBe(true);
    expect(await sendChatMessage(task, "之后用户正常说一句")).toBe("sent");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain("之后用户正常说一句");
    expect(sends[0]!.text, "作废的结果不能事后混进别的一轮").not.toContain("EIO-1");
  });
});

describe("队内前缀跟着字符串走完整条管道", () => {
  it("重连暂存按字符串原样存 / 取（带前缀的仍带前缀）——放回待送队列后照样被认成外来来源", () => {
    const tagged = markForeignOriginResult("[BACKGROUND_SUBAGENT_RESULT] x");
    const plain = "[BACKGROUND_SUBAGENT_RESULT] y";
    __stashBackgroundResultsForTest(TASK_ID, PARENT_ID, [tagged, plain]);
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toEqual({ agentId: PARENT_ID, results: [tagged, plain] });
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)!.results[0]!.startsWith(FOREIGN_ORIGIN_PREFIX)).toBe(true);
    discardStashedBackgroundResultsForDeletedTask(TASK_ID); // 暂存带时效计时器：用完清掉
    expect(__stashedBackgroundResultsSnapshotForTest(TASK_ID)).toBeUndefined();
  });
});

describe("源码结构（接线）", () => {
  const chat = readSource("src/lib/server/chat-runner.ts");
  const drainStart = chat.indexOf("export const drainBackgroundResults = async (");
  const drain = chat.slice(drainStart, chat.indexOf("\n};\n", drainStart));

  it("drainBackgroundResults 里送进 agent 的正文只经 joinResultsForAgent 拼（steer 与唤醒各一处），没有裸的 batch.join / queued.join", () => {
    expect(drainStart).toBeGreaterThan(-1);
    expect(drain.match(/joinResultsForAgent\(batch, SEP\)/g)?.length, "steer 与唤醒各一处").toBe(2);
    const withoutHelper = drain.replace(/joinResultsForAgent\(/g, "");
    expect(withoutHelper, "出现了绕开 joinResultsForAgent 的拼接——队内前缀会泄漏给 agent").not.toMatch(/\.join\(/);
  });

  it("入队处按 evt.foreignOrigin 加前缀；唤醒带 foreignContentTurn 的条件是「批里有外来来源」；steer 前的分流条件含「没有活标记」", () => {
    expect(chat).toMatch(
      /evt\.foreignOrigin === true \? markForeignOriginResult\(message\) : message/,
    );
    expect(drain).toMatch(/batch\.some\(isForeignOriginResult\) \? \{ foreignContentTurn: true \} : undefined/);
    expect(drain).toMatch(/const markerLive = isGroupNonOwnerTurnActive\(taskId\);/);
    expect(drain).toMatch(/if \(!markerLive && queued\.some\(isForeignOriginResult\)\)/);
    // 加入已有标记：批里有外来来源且标记活着时登记（置 shared），不是新建
    expect(drain).toMatch(/if \(batch\.some\(isForeignOriginResult\)\) beginForeignContentMidRun\(taskId\);/);
  });

  it("R20-3：不能 steer 的早退分支在 return 之前、且仅「无活标记」时落扣留提示；steer 分支与早退分支共用 noteForeignResultsHeld，去重比较只在它里面", () => {
    const early = blockAfter(drain, "if (!canSteerChatRun(taskId)) {");
    const callAt = early.indexOf("noteForeignResultsHeld(taskId, rec, queued.filter(isForeignOriginResult).length);");
    expect(callAt, "早退分支必须带块、且块里落扣留提示（不是裸 `return;`）").toBeGreaterThan(-1);
    expect(early.indexOf("return;"), "return 必须在提示之后").toBeGreaterThan(callAt);
    expect(
      enclosingIfConditions(drain, "noteForeignResultsHeld(taskId, rec, queued.filter(isForeignOriginResult).length);"),
      "只在没有活标记时落提示（有活标记 = 这一轮本来就是带标记的、不算扣留）",
    ).toEqual(["!isGroupNonOwnerTurnActive(taskId)"]);
    expect(drain.match(/noteForeignResultsHeld\(/g)?.length, "steer 分支 + 早退分支各一处").toBe(2);
    expect(drain, "去重比较只能在 noteForeignResultsHeld 里，drain 里不许再手写一份").not.toMatch(/foreignHeldNoticed \?\? 0/);
    const helper = blockAfter(chat, "const noteForeignResultsHeld = (");
    expect(helper).toMatch(/if \(heldCount > \(rec\.foreignHeldNoticed \?\? 0\)\) \{/);
    expect(helper).toMatch(/rec\.foreignHeldNoticed = heldCount;\s*noticeForeignBackgroundResultsHeld\(taskId, rec, heldCount\);/);
  });

  it("link 装配：真实依赖里 isForeignTurn 读的是这个任务的活标记", () => {
    const sub = readSource("src/lib/server/cursor-subagent.ts");
    expect(sub).toMatch(/isForeignTurn: \(\) => isGroupNonOwnerTurnActive\(backgroundTaskId\)/);
    // 派出那一刻、同步、任何 await 之前读：runSubagent 里 readForeignTurn() 出现在第一个 await 之前
    const run = sub.slice(sub.indexOf("const runSubagent = async ("));
    const readAt = run.indexOf("const foreignOrigin = readForeignTurn();");
    const firstAwait = run.indexOf("await ");
    expect(readAt).toBeGreaterThan(-1);
    expect(readAt, "读标记必须在 runSubagent 的第一个 await 之前（建子 agent 期间那一轮可能已收尾）").toBeLessThan(firstAwait);
  });
});
