/**
 * task 型「自动压缩续接」（run 内水位触发的轮换）：「别人的内容在驱动」标记要跟着续上的那一轮走（第十四轮评审 P2，fail-open）
 *
 * 缺口：run 内水位超线 → fireMidRunRotation 取消旧 run → consume 的 cancelled 分支 closeMySession() 摘掉旧会话 → 再
 * `resumeCurrentActionWithMessage` 起新 agent 接力。这是第十三轮重连之外**第二条**「同一轮续接 + 摘会话」的链：
 *   · closeMySession → closeTaskSession 真正摘掉会话时无条件 clearNonOwnerTurn（「会话没了，这一轮不再存在」）；
 *   · 旧 consume 的 finally 按 token 收口（endNonOwnerTurn）/ 按名收口（endMidRunForeignContent），也会摘掉；
 *   · 新 agent 由 resumeCurrentActionWithMessage 起——没带 foreignContentTurn 就不会登记。
 * 结果：群里非属主（或别人写的内容）驱动的那一轮，中途水位超线续接后，新 agent 没有标记地跑——desktop_* / 写所有者备注 /
 * 新建定时 / 自动推进全放开。（只给 closeTaskSession 加 keepNonOwnerTurn 不够：旧 consume 的 finally 照样清。）
 *
 * 修法：摘会话之前读一次「此刻有没有活标记」（isGroupNonOwnerTurnActive / isNonOwnerTurnActive），有就给接力的 resumeCurrentActionWithMessage 带
 * foreignContentTurn: true 与旧标记的范围（foreignContentScope，第十五轮评审 P3-2：此前硬编码 desktop，旧标记是 all 时被降级）——
 * internalStartAgent 在新 agent 首次 send 之前重新登记，新一轮收尾后由 consume 摘掉。
 *
 * 新标记为什么不会被旧 run 的收尾清掉（第十五轮评审 P3-3 改写了这条理由；此前写的「新启动等旧 run 退出表之后才跑」并不准确——
 * 接力是 `void` 出去的，旧 consume 的 finally 与新启动并发）：旧 consume 的 finally 里清标记的两行（按旧 token / 按名）是接力分支 `return`
 * 之后**最先同步执行**的语句、排在 finalizeOpenToolCalls 与 runningTasks.delete 之前，而新启动要等旧 record 退表之后才走到登记；
 * 就算顺序反了也伤不到——按 token 清对不上、按名清只清 midRun 型。顺序由本文件末尾的源码契约钉。
 *
 * 可达性（如实，第十五轮评审 P3-2 ④ 补全第 4 条）：run 内轮换要同时满足——① 非问答 run；② FLOWSHIP_TOKEN_WATERMARK 总开关开着
 * （2026-10-08 起默认关，见 session-rotate.ts）；③ 堆占用 ≥ 0.5；④ 会话累计 input ≥ ROTATE_SESSION_INPUT_TOKENS（2,000,000）；
 * 另有同一 action 最多续接 3 次的上限。所以默认配置下这条链不会触发；本文件在开关开启（回滚路径）下钉行为。
 * chat 侧没有 run 内轮换（只在消息边界懒重启），不对称是设计、不是遗漏。
 *
 * 手法：假 Cursor SDK；A 的 run 流吐一句旁白就结束、wait 挂住直到被取消——此刻 consume 已登记水位触发器；
 * 用例调 maybeFireMidRunRotation（真入口，heapRatio 注入）触发；新 agent 的 send 那一刻记录标记状态并走**真咽喉**调一次 desktop_*。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import { blockAfter, enclosingIfConditions, readSource } from "./helpers/source-text";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-midrun-rotation-marker-"));
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

const { readEvents, readMetaV06, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
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
const { cancelTaskRun, resumeCurrentActionWithMessage } = await import("@/lib/server/task-runner");
const { clearFailpoints, setFailpoint } = await import("@/lib/server/failpoints");
const { getTask } = await import("@/lib/server/task-fs");
const { maybeFireMidRunRotation, ROTATE_SESSION_INPUT_TOKENS, TOKEN_WATERMARK_ENV } = await import(
  "@/lib/server/session-rotate"
);
const {
  __resetNonOwnerTurnGuardForTest,
  beginForeignContentMidRun,
  beginNonOwnerTurn,
  isGroupNonOwnerTurnActive,
  isNonOwnerTurnActive,
} = await import("@/lib/server/non-owner-turn-guard");
const { invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const { installedSessionToken } = await import("./helpers/session-token");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`task-midrun-rotation-keeps-marker DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

/**
 * 每个用例一个 action id：run 内轮换的计数（midRunRotationCounts）按 action id 记在模块级 Map 里、同一 action 最多续接 3 次——
 * 共用一个固定 id，用例一多第 4 次起就被「已达上限」挡掉、接力根本不起。
 */
const actionIdOf = (taskId: string): string => `act_${taskId}`;
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

/** 续接读服务端凭据（readServerCreds：本路径没有 client bootArgs，同自动重连） */
const writeServerCreds = async (): Promise<void> => {
  const dataDir = process.env.FLOWSHIP_DATA_DIR!;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apiKey: CREDS.apiKey, defaultModel: CREDS.model }),
  );
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `midrun-rotation ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: actionIdOf(id),
    actions: [
      {
        id: actionIdOf(id),
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
};
const newProbe = (): Probe => ({ groupAtSend: [], allAtSend: [], desktopResults: [] });

/**
 * A 的 run：流吐一句旁白就结束（consume 随即登记水位触发器、进入 run.wait），wait 挂住——
 * cancel()（水位触发器取消 run）→ 回 cancelled；finish() → 回 finished。
 */
const makeWaitingRun = () => {
  let settle!: (r: { status: "cancelled" | "finished" }) => void;
  const done = new Promise<{ status: "cancelled" | "finished" }>((r) => {
    settle = r;
  });
  const run = {
    id: `run_wait_${Math.random().toString(36).slice(2, 8)}`,
    stream: async function* (): AsyncGenerator<unknown> {
      yield { type: "assistant", message: { content: [{ type: "text", text: "旁白" }] } };
    },
    wait: vi.fn(() => done),
    cancel: vi.fn(async () => {
      settle({ status: "cancelled" });
    }),
  };
  return { run, finish: () => settle({ status: "finished" }) };
};

/**
 * B 的 run（续接出来的新一轮）：旁白后挂住，放行后「交卷」（action → awaiting_ack）并自然结束——
 * consume 既不追问、也不关会话，标记只能靠 consumeSessionRun 自己摘（不能指望「关会话」顺带清）。
 */
const makeSubmittingRun = (id: string) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const state = { streamed: false };
  const run = {
    id: `run_b_${Math.random().toString(36).slice(2, 8)}`,
    stream: async function* (): AsyncGenerator<unknown> {
      state.streamed = true;
      yield { type: "assistant", message: { content: [{ type: "text", text: "旁白" }] } };
      await gate;
      const meta = (await readMetaV06(id))!;
      await writeMeta({
        ...meta,
        runStatus: "awaiting_user",
        actions: meta.actions.map((a) =>
          a.id === actionIdOf(id) ? { ...a, status: "awaiting_ack" as const, endedAt: Date.now() } : a,
        ),
      } as TaskMetaV06);
    },
    wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return { run, state, release };
};

/** 假 agent：send 时记录标记状态、并走真咽喉调一次 desktop_screenshot */
const makeAgent = (id: string, agentId: string, probe: Probe | null, run: unknown) => {
  const send = vi.fn(async () => {
    if (probe) {
      probe.groupAtSend.push(isGroupNonOwnerTurnActive(id));
      probe.allAtSend.push(isNonOwnerTurnActive(id));
      probe.desktopResults.push(
        // 过期会话闸（第十八轮）：用本会话（**runner 自己刚装好的**）callerToken 调——模拟「本会话的 agent 在调工具」。
        // installedSessionToken 在 runner 没装 token 时直接抛错（不补登记 fallback）：runner 漏装 token 这里会红（第十九轮评审 R19-10）
        textOf(await invokeFlowshipTool(fakeTool("desktop_screenshot") as never, {}, installedSessionToken(id), { taskId: id } as never)),
      );
    }
    return run;
  });
  return { agentId, close: vi.fn(), send };
};

describe("task 自动压缩续接：别人的内容在驱动的那一轮，标记跟着续上的新 agent 走（第十四轮评审 P2）", () => {
  const ids: string[] = [];
  const releases: Array<() => void> = [];
  const pending: Array<Promise<unknown>> = [];

  const alloc = (): string => {
    const id = `t_rot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  /** 输入条唤醒当前 action（真实入口）；不 await */
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

  /** 水位超线 + 堆过半：走真入口（记账点 task-fs.recordTurnUsage 调的就是它） */
  const fireRotation = (id: string): void =>
    maybeFireMidRunRotation(id, { sessionInputTokens: ROTATE_SESSION_INPUT_TOKENS + 1 }, 0.9);

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    __resetNonOwnerTurnGuardForTest();
    // 水位总开关默认关（2026-10-08）：本文件钉的是开启（回滚路径）下的行为
    vi.stubEnv(TOKEN_WATERMARK_ENV, "1");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    clearFailpoints();
    vi.unstubAllEnvs();
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

  /**
   * 起 A（可带标记）→ 等到 consume 登记好水位触发器（run.wait 已被调用）→ 触发轮换 → 返回 B 的探针。
   * marker：触发前给 A 这一轮补登的标记——`midRun`（别人的答案送进了还在跑的这一轮）/ `all`（提示词「只答疑」开关开着的群非属主轮，
   * 系统工具整体硬拒；真实链路里是 sendToTaskSession 的 beginNonOwnerTurn 默认范围）。
   */
  const rotateOnce = async (id: string, foreignWake: boolean, marker: "none" | "midRun" | "all" = "none") => {
    await writeServerCreds();
    await writeMeta(makeMeta(id));
    const probeA = newProbe();
    const probeB = newProbe();
    const a = makeWaitingRun();
    releases.push(a.finish);
    const b = makeSubmittingRun(id);
    releases.push(b.release);
    const agentA = makeAgent(id, `agent_a_${id}`, probeA, a.run);
    const agentB = makeAgent(id, `agent_b_${id}`, probeB, b.run);
    // 新 agent 走 create 还是 resume 取决于持久化锚点是否被清；两条路都指向 B，用例不依赖这个细节
    mockCreate.mockResolvedValueOnce(agentA).mockResolvedValue(agentB);
    mockResume.mockResolvedValue(agentB);

    const wake = await startWake(id, foreignWake);
    expect(await pollUntil(() => a.run.wait.mock.calls.length > 0), "A 的 consume 应已进入 run.wait（水位触发器已登记）").toBe(true);
    expect(wake.error, "起 A 不该抛错").toBeNull();
    expect(probeA.groupAtSend, "前置：A 起点的标记状态（外来内容轮有、属主轮没有）").toEqual([foreignWake]);
    if (marker === "midRun") {
      expect(beginForeignContentMidRun(id), "前置：中途补登应成功（此刻没有活标记）").toBeDefined();
    } else if (marker === "all") {
      expect(beginNonOwnerTurn(id, Date.now(), "all"), "前置：补登 scope=all 的标记").toBeTruthy();
      expect(isNonOwnerTurnActive(id), "前置：scope=all 的标记已生效").toBe(true);
    }
    expect(isGroupNonOwnerTurnActive(id), "前置：触发轮换前标记状态").toBe(foreignWake || marker !== "none");

    fireRotation(id);
    expect(await pollUntil(() => a.run.cancel.mock.calls.length > 0), "水位触发器应取消 A 的 run").toBe(true);
    expect(await pollUntil(() => agentB.send.mock.calls.length > 0), "接力的新 agent 应已起来并 send").toBe(true);
    return { a, b, agentA, agentB, probeB };
  };

  it("外来内容轮（scope=desktop）：续接出的新 agent 首次 send 之前标记已登记；desktop_* 被拒；新一轮进行期间一直在、收尾后摘掉", async () => {
    const id = alloc();
    const { agentA, b, probeB } = await rotateOnce(id, true);

    // 前置：确实走了「摘旧会话 + 起新 agent」的续接（不是别的出口把 B 起出来的）
    expect(agentA.close, "旧会话应已被 closeMySession 摘掉").toHaveBeenCalled();
    expect(
      (await readEvents(id)).some((e) => e.kind === "info" && String(e.text ?? "").includes("压缩")),
      "应落了「自动压缩续接」灰线",
    ).toBe(true);

    // 修复前：旧会话摘除 / 旧 consume 收尾都把标记清了，新 agent 没有标记地跑——这里是 [false]
    expect(probeB.groupAtSend, "续接出的新一轮 send 时标记必须在（别人的内容仍在驱动这一轮）").toEqual([true]);
    expect(probeB.allAtSend, "沿用的是 scope=desktop，不是系统工具整体硬拒").toEqual([false]);
    expect(probeB.desktopResults[0]).toContain("[DENIED]");
    expect(isGroupNonOwnerTurnActive(id), "新一轮进行期间标记应一直在").toBe(true);

    b.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "新一轮应已收尾").toBe(true);
    // 前置：确实是「会话保留」的出口（关会话会无条件清标记，那样证明不了 consumeSessionRun 自己的收口）
    expect(agentSessions.has(id), "前置：交卷后热会话应保留").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "新一轮收尾后标记仍挂着（会拒属主下一轮的电脑操作）").toBe(false);
  });

  it("中途补登的标记（midRun：别人的答案 / 内容送进了还在跑的这一轮）：续接后新 agent 同样带标记；新一轮收尾后摘掉", async () => {
    const id = alloc();
    const { b, probeB } = await rotateOnce(id, false, "midRun");

    expect(probeB.groupAtSend, "midRun 标记也不能在续接里丢（旧 consume 的按名收口 / 摘会话都会清它）").toEqual([true]);
    expect(probeB.desktopResults[0]).toContain("[DENIED]");

    b.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "新一轮应已收尾").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "新一轮收尾后标记仍挂着").toBe(false);
  });

  it("对照：属主自己的一轮（没有任何标记）续接后仍没有标记、desktop_* 放行——续接不凭空造标记", async () => {
    const id = alloc();
    const { b, probeB } = await rotateOnce(id, false);

    expect(probeB.groupAtSend).toEqual([false]);
    expect(probeB.desktopResults[0]).toBe("HANDLED:desktop_screenshot");

    b.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "新一轮应已收尾").toBe(true);
    expect(isGroupNonOwnerTurnActive(id)).toBe(false);
  });

  it("scope=all（提示词「只答疑」开关开着的群非属主轮）：续接出的新 agent 沿用 all（系统工具整体硬拒），不降成只拒电脑操作的 desktop（第十五轮评审 P3-2 ①）", async () => {
    const id = alloc();
    const { b, probeB } = await rotateOnce(id, false, "all");

    expect(probeB.groupAtSend).toEqual([true]);
    // 修复前：internalStartAgent 硬编码 "desktop"——旧标记是 all 的一轮续接后，submit_work / schedule / share_to_group 等在新一轮全被放行
    expect(probeB.allAtSend, "旧标记是 scope=all，续接必须沿用 all（不是降成 desktop）").toEqual([true]);
    expect(probeB.desktopResults[0]).toContain("[DENIED]");

    b.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "新一轮应已收尾").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "新一轮收尾后标记仍挂着").toBe(false);
  });

  it("连续两跳（A→B→C，旧标记是 scope=all）：每一跳的新 agent send 时标记都在、范围都沿用 all；收尾后摘干净（第十五轮评审 P3-5）", async () => {
    const id = alloc();
    await writeServerCreds();
    await writeMeta(makeMeta(id));
    const probes = { a: newProbe(), b: newProbe(), c: newProbe() };
    const runA = makeWaitingRun();
    const runB = makeWaitingRun(); // B 也停在 run.wait：它的 consume 登记了自己的水位触发器，才能被再触发一次
    const runC = makeSubmittingRun(id);
    releases.push(runA.finish, runB.finish, runC.release);
    const agentA = makeAgent(id, `agent_a_${id}`, probes.a, runA.run);
    const agentB = makeAgent(id, `agent_b_${id}`, probes.b, runB.run);
    const agentC = makeAgent(id, `agent_c_${id}`, probes.c, runC.run);
    // 新 agent 走 create 还是 resume 取决于持久化锚点是否被清；两条路都按出场顺序给下一个，用例不依赖这个细节
    const successors = [agentB, agentC];
    mockCreate.mockResolvedValueOnce(agentA).mockImplementation(async () => successors.shift());
    mockResume.mockImplementation(async () => successors.shift());

    const wake = await startWake(id, false);
    expect(await pollUntil(() => runA.run.wait.mock.calls.length > 0), "A 的 consume 应已进入 run.wait").toBe(true);
    expect(wake.error).toBeNull();
    expect(beginNonOwnerTurn(id, Date.now(), "all"), "前置：补登 scope=all 的标记").toBeTruthy();

    fireRotation(id);
    expect(
      await pollUntil(() => agentB.send.mock.calls.length > 0 && runB.run.wait.mock.calls.length > 0),
      "第一跳：B 应已起来、send、并进入 run.wait（它的水位触发器已登记）",
    ).toBe(true);
    fireRotation(id);
    expect(await pollUntil(() => agentC.send.mock.calls.length > 0), "第二跳：C 应已起来并 send").toBe(true);

    expect(probes.b.groupAtSend, "第一跳新 agent send 时标记在").toEqual([true]);
    expect(probes.b.allAtSend, "第一跳沿用 all").toEqual([true]);
    expect(probes.c.groupAtSend, "第二跳新 agent send 时标记在（B 的 finally 按 B 自己的 token 收，伤不到 C 的）").toEqual([true]);
    expect(probes.c.allAtSend, "第二跳仍沿用 all（不是被第一跳降成 desktop）").toEqual([true]);
    expect(probes.c.desktopResults[0]).toContain("[DENIED]");
    expect(agentA.close, "A 的会话应已被摘").toHaveBeenCalled();
    expect(agentB.close, "B 的会话应已被摘").toHaveBeenCalled();

    runC.release();
    expect(await pollUntil(() => !isTaskStarting(id) && !runningTasks.has(id)), "第三轮应已收尾").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "两跳之后收尾标记仍挂着").toBe(false);
  });

  it("接力的新 agent 起不来（B 的 send 抛错）：send 之前登记的标记不留残留、任务不卡在运行中（第十五轮评审 P3-5 负例）", async () => {
    // 谁收的标记（如实，第十五轮变异实验 TB6）：这条路径是 internalStartAgent 的 catch → closeTaskSession（缺省清标记）清掉的。
    // 把 internalStartAgent 的 finally 里 `endNonOwnerTurn(task.id, foreignContentToken)` 那一行去掉，这条用例**仍然全绿**——那一行兜的是不进 catch 的出口
    // （受理未成 / 失主让位 `return null` / stale），本文件没有用例走它们；所以这里断言的是「结果」（标记不残留、不卡运行中），不是「由哪一行收的」。
    const id = alloc();
    await writeServerCreds();
    await writeMeta(makeMeta(id));
    const a = makeWaitingRun();
    releases.push(a.finish);
    const agentA = makeAgent(id, `agent_a_${id}`, newProbe(), a.run);
    const markerAtFailingSend: boolean[] = [];
    const agentB = {
      agentId: `agent_b_${id}`,
      close: vi.fn(),
      send: vi.fn(async () => {
        markerAtFailingSend.push(isGroupNonOwnerTurnActive(id));
        throw new Error("send boom");
      }),
    };
    mockCreate.mockResolvedValueOnce(agentA).mockResolvedValue(agentB);
    mockResume.mockResolvedValue(agentB);

    const wake = await startWake(id, true);
    expect(await pollUntil(() => a.run.wait.mock.calls.length > 0), "A 的 consume 应已进入 run.wait").toBe(true);
    expect(wake.error).toBeNull();

    fireRotation(id);
    expect(await pollUntil(() => agentB.send.mock.calls.length > 0), "接力应已走到 B 的 send").toBe(true);
    expect(markerAtFailingSend, "前置：失败的 send 之前标记已登记（所以才要看它有没有被收回）").toEqual([true]);

    expect(await pollUntil(() => !runningTasks.has(id) && !isTaskStarting(id)), "新启动失败后应已释放").toBe(true);
    expect(isGroupNonOwnerTurnActive(id), "新一轮没起来，标记不得残留（会一直拒属主下一轮的电脑操作）").toBe(false);
    expect(runningTasks.has(id), "任务不得卡在「运行中」").toBe(false);
  });

  it("准备期间用户点停止（读凭据 / 写灰线 / 读 meta 三个 await 之后、起接力之前）：不再起接力、按普通 cancel 收尾——新 agent 没起、标记不残留（第十五轮评审 P3-2 ②）", async () => {
    const id = alloc();
    await writeServerCreds();
    await writeMeta(makeMeta(id));
    const a = makeWaitingRun();
    releases.push(a.finish);
    const b = makeSubmittingRun(id);
    releases.push(b.release);
    const agentA = makeAgent(id, `agent_a_${id}`, newProbe(), a.run);
    const probeB = newProbe();
    const agentB = makeAgent(id, `agent_b_${id}`, probeB, b.run);
    mockCreate.mockResolvedValueOnce(agentA).mockResolvedValue(agentB);
    mockResume.mockResolvedValue(agentB);
    // 在「三个 await 刚结束、复查之前」模拟用户点停止：旧 record 还在表里，cancelTaskRun 走 rec.cancel()（置 cancelled）
    const stopped = { count: 0 };
    setFailpoint("consume.rotation.beforeRelay", () => {
      stopped.count += 1;
      cancelTaskRun(id);
    });

    const wake = await startWake(id, true);
    expect(await pollUntil(() => a.run.wait.mock.calls.length > 0), "A 的 consume 应已进入 run.wait").toBe(true);
    expect(wake.error).toBeNull();
    expect(isGroupNonOwnerTurnActive(id), "前置：外来内容轮的标记在").toBe(true);

    fireRotation(id);
    expect(await pollUntil(() => stopped.count > 0), "前置：应走到复查之前的插桩点（灰线已写、会话已摘）").toBe(true);
    expect(await pollUntil(() => !runningTasks.has(id) && !isTaskStarting(id)), "旧 run 应已按普通 cancel 收尾").toBe(true);
    await sleep(200); // 给「误起的接力」一点出现的时间：它若起来，B 的 send 会被调

    // 修复前：三个 await 之后不复查——无视停止照样起新 agent（还带着标记）
    expect(agentB.send, "用户已点停止：不得再起新 agent").not.toHaveBeenCalled();
    expect(mockCreate, "只有 A 的那一次 create").toHaveBeenCalledTimes(1);
    expect(mockResume).not.toHaveBeenCalled();
    expect(agentA.close, "旧会话已被 closeMySession 摘掉").toHaveBeenCalled();
    expect(isGroupNonOwnerTurnActive(id), "停止收尾后标记不得残留").toBe(false);
    expect((await readMetaV06(id))!.runStatus, "按普通 cancel 收尾落 idle").toBe("idle");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("不再起接力"));
  });

  describe("源码契约（行为用例是主证据；这里钉住「摘会话之前读标记、把它带给接力」这条顺序）", () => {
    const src = readSource("src/lib/server/task-runner.ts"); // readSource 已剥注释
    const branch = blockAfter(src, "if (rotationRequested && !cancelled && !hardTimedOut) {");

    it("rotation 分支在 closeMySession() 之前读 isGroupNonOwnerTurnActive，并把结果以 foreignContentTurn: true 带给 resumeCurrentActionWithMessage", () => {
      const readAt = branch.indexOf("isGroupNonOwnerTurnActive(task.id)");
      const closeAt = branch.indexOf("closeMySession()");
      const resumeAt = branch.indexOf("resumeCurrentActionWithMessage(");
      expect(readAt, "分支里读标记").toBeGreaterThan(-1);
      expect(closeAt, "分支里摘会话").toBeGreaterThan(-1);
      expect(resumeAt, "分支里起接力").toBeGreaterThan(-1);
      expect(readAt, "必须先读标记、再摘会话（摘会话会无条件清标记）").toBeLessThan(closeAt);
      expect(closeAt).toBeLessThan(resumeAt);
      const resumeArgs = branch.slice(resumeAt, branch.indexOf(".catch(", resumeAt));
      expect(resumeArgs, "接力调用要带 foreignContentTurn: true（条件展开）").toMatch(/foreignContentTurn:\s*true/);
      expect(resumeArgs, "接力调用要带旧标记的范围（第十五轮评审 P3-2：不硬编码 desktop）").toMatch(/foreignContentScope:\s*foreignScope/);
    });

    it("最后一个 await 之后、起接力之前复查 lostStartOwner()；起接力本身被 !cancelled && !hardTimedOut 包着（第十五轮评审 P3-2 ②）", () => {
      const resumeAt = branch.indexOf("resumeCurrentActionWithMessage(");
      const awaits = [...branch.slice(0, resumeAt).matchAll(/\bawait\b/g)];
      expect(awaits.length, "分支里应有 await（读凭据 / 写灰线 / 读 meta / 插桩点）").toBeGreaterThanOrEqual(4);
      const lastAwait = awaits[awaits.length - 1]!.index!;
      expect(branch.slice(lastAwait, resumeAt), "最后一个 await 与起接力之间要复查是否失主").toMatch(/if \(lostStartOwner\(\)\) return;/);
      expect(
        enclosingIfConditions(branch, "resumeCurrentActionWithMessage("),
        "起接力要在「用户没停止、没硬超时」的条件里",
      ).toEqual(["!cancelled", "!hardTimedOut"]);
    });

    it("顺序钉：旧 consume 的 finally 里清标记的两行是最先同步执行的语句，排在 finalizeOpenToolCalls 与 runningTasks.delete 之前（接力的新标记一定晚于它们；第十五轮评审 P3-3 / P3-5）", () => {
      const tokenClear = "endNonOwnerTurn(task.id, opts.nonOwnerTurnToken)";
      const at = src.indexOf(tokenClear);
      expect(at, "consumeSessionRun 的最外层 finally 里按旧 token 清标记").toBeGreaterThan(-1);
      const finAt = src.lastIndexOf("} finally {", at);
      const fin = blockAfter(src.slice(finAt), "} finally {");
      const tokenAt = fin.indexOf(tokenClear);
      const nameAt = fin.indexOf("endMidRunForeignContent(task.id)");
      const finalizeAt = fin.indexOf("finalizeOpenToolCalls(");
      const deleteAt = fin.indexOf("runningTasks.delete(");
      for (const [name, idx] of [["按 token 清", tokenAt], ["按名清", nameAt], ["闭合未配对 tool", finalizeAt], ["退表", deleteAt]] as const) {
        expect(idx, `finally 里应有：${name}`).toBeGreaterThan(-1);
      }
      expect(tokenAt).toBeLessThan(nameAt);
      expect(nameAt).toBeLessThan(finalizeAt);
      expect(finalizeAt).toBeLessThan(deleteAt);
      expect(fin.slice(0, nameAt), "两行清标记之前不得有 await（同步执行，才排得在接力的新登记之前）").not.toMatch(/\bawait\b/);
    });
  });
});
