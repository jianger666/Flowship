/**
 * task 型自动重连：「非属主轮 / 外来内容」标记要跟着续上的那一轮走（第十三轮评审 P2-2，fail-open）
 *
 * 缺口：tryAutoReconnect 退避之后调 closeTaskSession 摘掉旧的坏会话，而 closeTaskSession 真正摘掉会话时**无条件**
 * clearNonOwnerTurn（「会话没了，这一轮不再存在」）。重连是同一轮的续接——resume 之后发一句「从断点继续」、递归 consumeSessionRun 接着消费，
 * 全程没有任何地方重新登记标记；consume 的 finally 按 token 收口、早被清掉了，是 no-op。结果：群里非属主（或别人写的内容）驱动的那一轮，
 * 流因网络类错误中断并自动重连后，续上的那一轮没有标记地跑——desktop_* / 写所有者备注 / 新建定时 / 自动推进全放开。
 * chat 侧早有明文「reconnect 是同一轮的续接，标记要留给续接的新实例」（只有 restart 才在摘表时清），task 侧不对称。
 *
 * 修法：closeTaskSession 加 keepNonOwnerTurn 选项（缺省仍是无条件清），自动重连链的三处调用都传 true；
 * 标记仍由 consumeSessionRun 最外层的 finally 收口（send 起点登记的按 token、中途补登的按名），重连放弃 / 用户停止也是走同一个 finally。
 *
 * 本文件的用例（真 task-runner + 假 Cursor SDK，退避用真计时器——和 task-reconnect-send-fail-closes-session 同口径）：
 *  · 同权群成员轮（scope=desktop，deliverAskReply 的 foreignContent）：重连续上的那一轮 send 时标记仍在，续上的那一轮收尾后被清；
 *  · 中途补登的标记（midRun，ask-inject / task-question-inject 的登记）：同上；
 *  · resume 成功但 reconnect send 失败、再来一轮（closeTaskSession 的**第三处**调用——第二处是「失主让位摘刚 resume 出的记录」，现实里几乎不可达，只有源码契约钉着）：两轮 send 时标记都在；
 *  · 退避窗口里标记还在、用户点停止后被清（不残留）——注意这条**不依赖修法**：停在首次 closeTaskSession 之前，cancelTaskRun 自己的默认 close 就清了标记（第十四轮评审 P3-5 ②，下一条才是修法新增的窗口）；
 *  · 首次 closeTaskSession 之后（旧坏会话已摘、resume 在飞）用户点停止：此时表里没有会话，cancelTaskRun 的 close 早返回碰不到标记，收口全靠 consume 的 finally；
 *  · 各种放弃的结局（第十四轮评审 P3-5 ③）：不可重试直接 give-up / resume 失败后下一轮 give-up / reconnect send 失败后递归一轮 give-up——标记都被 consume 的 finally 收走、不残留；
 *  · 默认行为不变：不带 keepNonOwnerTurn 的 closeTaskSession 照旧清（group-non-owner-desktop-turn 里另有一条钉着，这里再对照一次）；
 *  · 源码契约：tryAutoReconnect 里**每一处** closeTaskSession 都带 keepNonOwnerTurn: true（失主让位那一支现实里几乎不可达、没法用行为用例钉，靠这里），
 *    且 keepNonOwnerTurn 只出现在这条链里、closeTaskSession 里的清除受它守着。
 */
import { mkdtempSync, promises as fs, readdirSync, readFileSync } from "node:fs";
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
import { blockAfter, readSource, stripComments } from "./helpers/source-text";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-reconnect-marker-"));
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
vi.mock("@/lib/server/chat-pending", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/chat-pending")>();
  return {
    // 第十九轮评审 R19-10：callerToken 表这一组（读 / 核对 / 登记 / 摘 / 拒绝文案）透传**真实现**——
    // 往本文件加「经咽喉调受限工具」的用例时，咽喉里的 matchExpectedCallerToken 与 tests/helpers/session-token.ts 才读写同一张真表
    // （此前整体空桩、没透传 matchExpectedCallerToken / CALLER_MISMATCH_ERROR，往里加这类用例会踩坑）。
    // 其余（notifier / handler / 问答等待 / 清理）仍是空桩：runner 在本文件里不会自己装 token，要用的用例自己 bindSessionToken
    CALLER_MISMATCH_ERROR: real.CALLER_MISMATCH_ERROR,
    getExpectedCallerToken: real.getExpectedCallerToken,
    matchExpectedCallerToken: real.matchExpectedCallerToken,
    setOneShotCallerToken: real.setOneShotCallerToken,
    clearOneShotCallerTokenIf: real.clearOneShotCallerTokenIf,
    invalidateCallerToken: real.invalidateCallerToken,
    cleanupChatTaskState: vi.fn(),
    buildAgentMessage: (opts: { text: string }) => opts.text,
    cancelPending: vi.fn(),
    getPendingAsk: vi.fn(),
    setChatAwaitingNotifier: vi.fn(),
    setChatTaskActionHandler: vi.fn(),
    unsetChatAwaitingNotifierIf: vi.fn(),
    unsetChatTaskActionHandlerIf: vi.fn(),
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  pendingStopRequests,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { cancelTaskRun, closeTaskSession, deliverAskReply } = await import(
  "@/lib/server/task-runner"
);
const { getTask } = await import("@/lib/server/task-fs");
const guard = await import("@/lib/server/non-owner-turn-guard");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `task-reconnect-keeps-marker DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
const PERSISTED_AGENT_ID = "agent_p22_persisted";

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `task-reconnect-marker ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act_shared",
    actions: [
      {
        id: "act_shared",
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    // 持久化会话锚点：重连靠它 Agent.resume
    sessionAgentId: PERSISTED_AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitUntil = async (
  pred: () => boolean | Promise<boolean>,
  ms = 5000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil 超时 ${ms}ms`);
};

/** 重连读服务端凭据（readServerCreds） */
const writeServerCreds = async (): Promise<void> => {
  const dataDir = process.env.FLOWSHIP_DATA_DIR!;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apiKey: CREDS.apiKey, defaultModel: CREDS.model }),
  );
};

/** 受理成功、流立即结束、wait 即 finished 的 run */
const goodRun = () => ({
  stream: async function* () {
    /* 空 */
  },
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** 受理成功、但 wait 抛错的 run（缺省是可重试网络错，consume 进自动重连；传别的错误可造「不可重试 / 只放行一次」的放弃路径） */
const brokenRun = (waitError: Error = new Error("fetch failed")) => ({
  stream: async function* () {
    /* 空 */
  },
  wait: vi.fn().mockRejectedValue(waitError),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** SDK 自己已经重试过多次才放弃的终态报错：isRetryableRunError 一律判否（不自动重连，直接 give-up） */
const SDK_GAVE_UP_ERROR = () => new Error("Connection failed repeatedly");
/**
 * 瞬时鉴权抖动：只在第 1 次失败时放行一次重连（attempt === 1），第 2 次起判否——
 * 用来在两三秒内造出「重连一轮之后放弃」的结局（真实的 5 次重连要退避 59 秒，测不起）
 */
const TRANSIENT_AUTH_ERROR = () => new Error("Authentication error: Unauthorized. Please try logging out and back in");

describe("task 自动重连：标记跟着续上的那一轮走（第十三轮评审 P2-2）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_p22_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  /**
   * 预装旧会话 S0：send 受理，随后 wait 抛错（缺省网络错）；send 那一刻记下标记是否在。
   * agentId 用落盘锚点同一个（PERSISTED_AGENT_ID）：生产里活会话的 agentId 就是 task.sessionAgentId，重连 resume 出来的也是它
   * （第十四轮评审 P3-5 ④：原先这里是另一个 agentId，续接 consume 拿到的会话实例号与生产的「同 agentId」分支对不上；两边结果一致，但夹具该贴生产）
   */
  const installBrokenSession = (id: string, sawMarker: boolean[], waitError?: Error) => {
    const agentA = {
      agentId: PERSISTED_AGENT_ID,
      close: vi.fn(),
      send: vi.fn().mockImplementation(async () => {
        sawMarker.push(guard.isGroupNonOwnerTurnActive(id));
        return brokenRun(waitError);
      }),
    };
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: agentA as never,
      agentId: agentA.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: `p22 ${id}` },
      repoPaths: [],
    });
    return agentA;
  };

  const reconnectedEvent = async (id: string, attempt: number): Promise<boolean> =>
    (await readEvents(id)).some(
      (e) =>
        e.kind === "info" &&
        e.meta?.kind === "reconnected" &&
        e.meta?.attempt === attempt,
    );

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    guard.__resetNonOwnerTurnGuardForTest();
  });

  afterEach(async () => {
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
    guard.__resetNonOwnerTurnGuardForTest();
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "同权群成员轮（scope=desktop）：重连摘掉旧会话后，续上的那一轮 send 时标记仍在；续上的那一轮收尾后标记被清（不泄漏）",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      const sawA: boolean[] = [];
      installBrokenSession(id, sawA);

      // 重连 resume 出的 R：send 那一刻记下标记是否还在，run 立刻 finished
      const sawR: boolean[] = [];
      const agentR = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockImplementation(async () => {
          sawR.push(guard.isGroupNonOwnerTurnActive(id));
          return goodRun();
        }),
      };
      mockResume.mockResolvedValueOnce(agentR);

      // 群里别人答了 agent 挂着的 ask_user：以 [ASK_USER_REPLY] 进属主会话，send 起点登记 scope=desktop 的标记
      const res = await deliverAskReply(
        (await getTask(id))!,
        "别人写的答案",
        undefined,
        "act_shared",
        { apiKey: CREDS.apiKey, model: CREDS.model },
        undefined,
        undefined,
        true,
      );
      expect(res).toBe("sent");
      // 对照：登记在位（send 起点）——这一轮靠它限制 desktop_*，不是 scope=all
      expect(sawA).toEqual([true]);
      expect(guard.isNonOwnerTurnActive(id)).toBe(false);

      // 退避窗口（首次 2 秒）里：旧会话还没摘，标记在
      await waitUntil(async () => {
        const evs = await readEvents(id);
        return evs.some((e) => e.kind === "info" && e.meta?.kind === "reconnecting" && e.meta?.attempt === 1);
      }, 8000);
      expect(guard.isGroupNonOwnerTurnActive(id)).toBe(true);

      // 退避结束 → closeTaskSession(旧会话) → resume → 发 reconnect prompt
      await waitUntil(() => agentR.send.mock.calls.length >= 1, 8000);
      expect(String(agentR.send.mock.calls[0]![0])).toContain("网络连接中断");
      // 修复前：closeTaskSession 无条件 clearNonOwnerTurn → 这里是 false，续上的那一轮没有标记地跑。
      // 用「每次 send 时标记都在」而不是「恰好一次」：run 结束后 task 型还会自动追发 submit_work 提醒（同一轮里的后续 send），次数不是本用例要钉的
      expect(sawR.length, "reconnect prompt 已发出").toBeGreaterThan(0);
      expect(
        sawR,
        "重连是同一轮的续接：摘旧会话不能把标记一起清掉",
      ).not.toContain(false);

      // 续上的那一轮跑完：consume 的 finally 按 token 收口，标记被清、run 表也空了
      await waitUntil(async () => await reconnectedEvent(id, 1), 8000);
      await waitUntil(() => !runningTasks.has(id), 8000);
      expect(guard.isGroupNonOwnerTurnActive(id)).toBe(false);
    },
    40_000,
  );

  it(
    "中途补登的标记（midRun：ask-inject / task-question-inject 的登记）：重连后续上的那一轮 send 时仍在，收尾后按名清掉",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      installBrokenSession(id, []);

      const sawR: boolean[] = [];
      const agentR = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockImplementation(async () => {
          sawR.push(guard.isGroupNonOwnerTurnActive(id));
          return goodRun();
        }),
      };
      mockResume.mockResolvedValueOnce(agentR);

      // 属主自己的一轮（owner send 起点会清掉残留标记）在跑，随后别人写的内容在这一轮中途补登标记
      const res = await deliverAskReply(
        (await getTask(id))!,
        "属主自己的答案",
        undefined,
        "act_shared",
        { apiKey: CREDS.apiKey, model: CREDS.model },
      );
      expect(res).toBe("sent");
      const token = guard.beginForeignContentMidRun(id);
      expect(token, "run 在跑、没有活标记：中途补登应拿到自己的 token").toBeDefined();

      await waitUntil(() => agentR.send.mock.calls.length >= 1, 8000);
      expect(sawR.length, "reconnect prompt 已发出").toBeGreaterThan(0);
      expect(sawR, "midRun 标记也不能被重连摘旧会话时清掉").not.toContain(false);

      await waitUntil(async () => await reconnectedEvent(id, 1), 8000);
      await waitUntil(() => !runningTasks.has(id), 8000);
      // consume 最外层 finally 按名清 midRun 标记（表里没有别的 run 占位）
      expect(guard.isGroupNonOwnerTurnActive(id)).toBe(false);
    },
    40_000,
  );

  it(
    "resume 成功但 reconnect send 失败、再来一轮（closeTaskSession 的第三处调用，摘 send 失败的 R1）：两轮 send 时标记都在，最终收尾后被清",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      installBrokenSession(id, []);

      const sawR1: boolean[] = [];
      const agentR1 = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockImplementation(async () => {
          sawR1.push(guard.isGroupNonOwnerTurnActive(id));
          throw new Error("fetch failed");
        }),
      };
      const sawR2: boolean[] = [];
      const agentR2 = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockImplementation(async () => {
          sawR2.push(guard.isGroupNonOwnerTurnActive(id));
          return goodRun();
        }),
      };
      mockResume.mockResolvedValueOnce(agentR1).mockResolvedValueOnce(agentR2);

      await deliverAskReply(
        (await getTask(id))!,
        "别人写的答案",
        undefined,
        "act_shared",
        { apiKey: CREDS.apiKey, model: CREDS.model },
        undefined,
        undefined,
        true,
      );

      // 第 1 轮：退避 2s → resume 成功（R1）→ send 失败 → 摘掉 R1（第三处 closeTaskSession）→ 第 2 轮退避 4s → R2
      await waitUntil(() => agentR1.send.mock.calls.length >= 1, 8000);
      expect(sawR1, "第 1 轮 reconnect send 时标记在").toEqual([true]);
      await waitUntil(() => agentR2.send.mock.calls.length >= 1, 12_000);
      expect(sawR2.length, "第 2 轮 reconnect prompt 已发出").toBeGreaterThan(0);
      expect(
        sawR2,
        "摘掉 send 失败的 R1 时也不能清标记：第 2 轮续上的那一轮标记仍在",
      ).not.toContain(false);
      expect(agentR1.close).toHaveBeenCalled();

      await waitUntil(async () => await reconnectedEvent(id, 2), 8000);
      await waitUntil(() => !runningTasks.has(id), 8000);
      expect(guard.isGroupNonOwnerTurnActive(id)).toBe(false);
    },
    50_000,
  );

  it(
    "退避窗口里标记还在；用户此刻点停止：重连链按「已取消」收尾，标记被清、不残留（不依赖修法：停在首次 closeTaskSession 之前，cancelTaskRun 自己的默认 close 就清了——修法新增的窗口见下一条）",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      installBrokenSession(id, []);
      mockResume.mockResolvedValue({
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockImplementation(async () => goodRun()),
      });

      await deliverAskReply(
        (await getTask(id))!,
        "别人写的答案",
        undefined,
        "act_shared",
        { apiKey: CREDS.apiKey, model: CREDS.model },
        undefined,
        undefined,
        true,
      );
      await waitUntil(async () => {
        const evs = await readEvents(id);
        return evs.some((e) => e.kind === "info" && e.meta?.kind === "reconnecting" && e.meta?.attempt === 1);
      }, 8000);
      // 退避窗口里（首次退避 2 秒，还没到 closeTaskSession）：标记在
      expect(guard.isGroupNonOwnerTurnActive(id)).toBe(true);

      cancelTaskRun(id);
      await waitUntil(() => !runningTasks.has(id), 8000);
      expect(guard.isGroupNonOwnerTurnActive(id), "停止后没有任何出口留下标记").toBe(false);
      // 用户停止是在退避里被消费的：没有走到 resume
      expect(mockResume).not.toHaveBeenCalled();
    },
    30_000,
  );

  /** 群里别人答了 agent 挂着的 ask_user：以 [ASK_USER_REPLY] 进属主会话，send 起点登记 scope=desktop 的标记（同上面几条的入口） */
  const deliverForeign = (id: string) =>
    getTask(id).then((task) =>
      deliverAskReply(
        task!,
        "别人写的答案",
        undefined,
        "act_shared",
        { apiKey: CREDS.apiKey, model: CREDS.model },
        undefined,
        undefined,
        true,
      ),
    );

  it(
    "首次 closeTaskSession 之后（旧坏会话已摘、Agent.resume 在飞）用户点停止：摘会话没清标记；此刻表里没有会话，cancelTaskRun 的 close 早返回碰不到它，收口全靠 consume 的 finally——链收尾后标记被清、run 表空、没有 error 事件（修法新增的窗口，第十四轮评审 P3-5 ②）",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      installBrokenSession(id, []);
      // resume 挂在这里：测试手动让它失败（网络还没好）
      let rejectResume!: (err: Error) => void;
      mockResume.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectResume = reject;
          }),
      );
      expect(await deliverForeign(id)).toBe("sent");

      // 退避 2 秒结束 → 第一处 closeTaskSession 摘旧坏会话 → readServerCreds → resumeTaskSession → Agent.resume 挂住
      await waitUntil(() => mockResume.mock.calls.length >= 1, 8000);
      expect(agentSessions.has(id), "前置：旧坏会话已摘、resume 的会话还没装").toBe(false);
      expect(
        guard.isGroupNonOwnerTurnActive(id),
        "摘旧坏会话（第一处 closeTaskSession）不能清标记——修复前这里已经是 false，后面的断言就没有意义了",
      ).toBe(true);

      // 用户在这一刻点停止：cancelTaskRun 自己的 closeTaskSession 默认路径在「没有会话」处早返回，碰不到标记
      cancelTaskRun(id);
      // resume 失败：链看到「已取消」就收尾，不再起下一轮
      rejectResume(new Error("fetch failed"));
      await waitUntil(() => !runningTasks.has(id), 10_000);
      expect(guard.isGroupNonOwnerTurnActive(id), "停止之后链收尾，标记不残留（只靠 consume 的 finally）").toBe(false);
      expect(mockResume, "已取消：不再起下一轮重连").toHaveBeenCalledTimes(1);
      expect((await readEvents(id)).filter((e) => e.kind === "error")).toEqual([]);
    },
    30_000,
  );

  it(
    "不可重试的错误（SDK 已放弃）：直接 give-up——不退避、不 resume、走失败收尾；标记在 run 收尾后被清，不残留（第十四轮评审 P3-5 ③）",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      const sawA: boolean[] = [];
      installBrokenSession(id, sawA, SDK_GAVE_UP_ERROR());
      expect(await deliverForeign(id)).toBe("sent");
      expect(sawA, "前置：这一轮是外来内容驱动的（send 起点登记了标记）").toEqual([true]);

      await waitUntil(() => !runningTasks.has(id), 8000);
      expect(mockResume, "不可重试：没有走重连").not.toHaveBeenCalled();
      expect(
        (await readEvents(id)).some((e) => e.kind === "info" && e.meta?.kind === "reconnecting"),
        "不可重试：没有写「重连中」",
      ).toBe(false);
      expect(guard.isGroupNonOwnerTurnActive(id), "give-up 的失败收尾也要把标记收走").toBe(false);
      expect(agentSessions.has(id), "失败收尾关了会话").toBe(false);
    },
    20_000,
  );

  it(
    "resume 失败后递归到下一轮、下一轮放弃（瞬时鉴权抖动只放行第 1 次）：摘旧坏会话时标记仍在，链放弃收尾后被清、没有会话残留（第十四轮评审 P3-5 ③）",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      installBrokenSession(id, [], TRANSIENT_AUTH_ERROR());
      const markerAtResume: boolean[] = [];
      mockResume.mockImplementation(async () => {
        markerAtResume.push(guard.isGroupNonOwnerTurnActive(id));
        throw new Error("resume 失败（测试注入）");
      });
      expect(await deliverForeign(id)).toBe("sent");

      await waitUntil(() => !runningTasks.has(id), 15_000);
      // 第 1 次：退避 2 秒 → 摘旧坏会话 → resume 失败 → 递归第 2 次 → 瞬时鉴权抖动不再放行 → give-up
      expect(mockResume).toHaveBeenCalledTimes(1);
      expect(markerAtResume, "resume 的那一刻（旧坏会话已摘）标记仍在").toEqual([true]);
      expect(guard.isGroupNonOwnerTurnActive(id), "放弃收尾后标记被清").toBe(false);
      expect(agentSessions.has(id)).toBe(false);
    },
    30_000,
  );

  it(
    "reconnect send 失败后递归一轮、下一轮放弃：刚装的 R1 被摘（第三处 closeTaskSession）、放弃收尾后标记被清（嵌套 give-up，第十四轮评审 P3-5 ③）",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await writeMeta(makeMeta(id));
      installBrokenSession(id, [], TRANSIENT_AUTH_ERROR());
      const sawR1: boolean[] = [];
      const agentR1 = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockImplementation(async () => {
          sawR1.push(guard.isGroupNonOwnerTurnActive(id));
          throw TRANSIENT_AUTH_ERROR();
        }),
      };
      mockResume.mockResolvedValueOnce(agentR1);
      expect(await deliverForeign(id)).toBe("sent");

      await waitUntil(() => !runningTasks.has(id), 15_000);
      expect(sawR1, "R1 的 reconnect send 时标记在").toEqual([true]);
      expect(agentR1.close, "send 失败的 R1 被摘").toHaveBeenCalled();
      expect(mockResume, "第 2 次不再放行：只 resume 了一次").toHaveBeenCalledTimes(1);
      expect(guard.isGroupNonOwnerTurnActive(id), "嵌套 give-up 收尾后标记被清").toBe(false);
      expect(agentSessions.has(id)).toBe(false);
    },
    30_000,
  );

  it("默认行为不变：不带 keepNonOwnerTurn 的 closeTaskSession 照旧无条件清标记；带了才保留", () => {
    const id = alloc();
    for (const keep of [false, true]) {
      guard.__resetNonOwnerTurnGuardForTest();
      const agent = { agentId: `agent_p22_close_${keep}`, close: vi.fn(), send: vi.fn() };
      const instanceId = allocTaskRunInstanceId();
      agentSessions.set(id, {
        instanceId,
        agent: agent as never,
        agentId: agent.agentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: "p22 close" },
        repoPaths: [],
      });
      guard.beginNonOwnerTurn(id, Date.now(), "desktop");
      expect(guard.isGroupNonOwnerTurnActive(id)).toBe(true);
      const closed = closeTaskSession(id, undefined, {
        reap: false,
        keepPersisted: true,
        expectedSessionInstanceId: instanceId,
        ...(keep ? { keepNonOwnerTurn: true } : {}),
      });
      expect(closed).toBe(true);
      expect(agent.close).toHaveBeenCalled();
      expect(guard.isGroupNonOwnerTurnActive(id), `keepNonOwnerTurn=${keep}`).toBe(keep);
    }
  });

  describe("源码契约", () => {
    // 这几条契约**刻意收得很紧**（数 return、数 clearNonOwnerTurn 调用点、钉具体写法）：这一族连续几轮的漏洞都是「新冒出一个清除源 / 一个绕过清除的出口」，
    // 数量或写法一变就该有人停下来核对。代价是合理的重构（拆函数、换写法）也会红——红了不是「测试坏了」，是提醒：先核对新增 / 改动的那处该不该清标记，
    // 再同步改这里的数字或正则。这是有意的取舍（第十五轮评审 P3-5 末条指出会误伤合理重构；选择保留，把取舍写明）。
    const src = readSource("src/lib/server/task-runner.ts");

    it("tryAutoReconnect 里每一处 closeTaskSession 都带 keepNonOwnerTurn: true（共 3 处：摘旧坏会话 / 失主摘刚 resume 的记录 / send 失败摘刚装的会话）", () => {
      const body = blockAfter(src, `Promise<"handled" | "cancelled" | "give-up"> => {`);
      const calls = body.split("closeTaskSession(").slice(1);
      expect(calls.length, "tryAutoReconnect 里的 closeTaskSession 调用数").toBe(3);
      for (const [i, rest] of calls.entries()) {
        const args = rest.slice(0, rest.indexOf(");"));
        expect(args, `第 ${i + 1} 处 closeTaskSession 的实参`).toMatch(/keepNonOwnerTurn:\s*true/);
        // 必须是无条件、独占一行的属性——`...(c ? { keepNonOwnerTurn: true } : {})` 这种条件展开也含上面那串字面量，但不是「每次都保留」
        // （第十四轮评审 P3-5 ⑤：原先只钉了字面量，条件展开也能过）
        expect(args, `第 ${i + 1} 处 closeTaskSession 的实参：keepNonOwnerTurn 要无条件、独占一行`).toMatch(/^\s*keepNonOwnerTurn:\s*true,?\s*$/m);
        expect(args, `第 ${i + 1} 处 closeTaskSession 的实参：不能是条件展开 / 三元对象`).not.toMatch(/\.\.\.|\?\s*\{/);
        // 同一处也得带实例号门控（fail-closed），别因为加了选项就把门控丢了
        expect(args, `第 ${i + 1} 处 closeTaskSession 的实参`).toMatch(/expectedSessionInstanceId:/);
      }
    });

    it("keepNonOwnerTurn 只有重连链在传；closeTaskSession 里的 clearNonOwnerTurn 只受它守着（缺省仍无条件清）", () => {
      const passes = [...src.matchAll(/keepNonOwnerTurn:\s*true/g)].length;
      expect(passes, "全文件传 keepNonOwnerTurn: true 的位置数（只有重连链的 3 处）").toBe(3);
      // 顶层箭头函数以「行首的 };」收尾：取 closeTaskSession 整个函数体
      const start = src.indexOf("export const closeTaskSession = (");
      expect(start, "找得到 closeTaskSession 的定义").toBeGreaterThan(-1);
      const closeBody = src.slice(start, src.indexOf("\n};\n", start));
      expect(closeBody).toMatch(/if\s*\(\s*!opts\.keepNonOwnerTurn\s*\)\s*clearNonOwnerTurn\(taskId\)/);
      // 清除之前的早返回只有已知的 4 处（无会话 ×2 / agentId 对不上 / 实例号对不上）：再多一处，就多一条绕过清除的路
      // （第十四轮评审 P3-5 ⑤：原先没钉；评审 P3-3 那类漏清就是「新的出口绕过了 closeTaskSession 的清除」）
      const beforeClear = closeBody.slice(0, closeBody.search(/if\s*\(\s*!opts\.keepNonOwnerTurn\s*\)\s*clearNonOwnerTurn\(taskId\)/));
      expect(beforeClear.match(/\breturn\b/g)?.length, "closeTaskSession 里清除之前的 return 数").toBe(4);
      // 全文件的 clearNonOwnerTurn 调用点共四处，数量钉死（再多一处 = 新的清除源，要有人逐个核对它该不该清）：
      //  ① closeTaskSession（上面那一处，受 keepNonOwnerTurn 守着）；
      //  ② task 型属主 send 起点（!opts.nonOwnerTurn）；
      //  ③ internalStartAgent 里属主自己的新启动（没带 foreignContentTurn、首次 send 之前）——第十五轮评审 P3-1：强清不再清标记，改成后继起跑时清；带了 foreignContentTurn 就是登记（覆盖旧标记）；
      //  ④ 一次性问答 startOneShotQuestion 的属主启动（没传 foreignContent、首次 send 之前）——第十六轮评审 P3-T1：此前只有外来内容那一支登记，属主这一支不清
      expect(src.match(/clearNonOwnerTurn\(/g)?.length, "clearNonOwnerTurn 调用点（closeTaskSession / 属主 send 起点 / internalStartAgent 的属主新启动 / 一次性问答的属主启动）").toBe(4);
      expect(src).toMatch(/if \(!opts\.nonOwnerTurn\) clearNonOwnerTurn\(task\.id\);/);
      expect(src).toMatch(
        /if \(input\.foreignContentTurn\) \{\s*foreignContentToken = beginNonOwnerTurn\(task\.id, Date\.now\(\), input\.foreignContentScope \?\? "desktop"\);\s*\} else \{\s*clearNonOwnerTurn\(task\.id\);\s*\}/,
      );
      // ④ 紧贴首次 send：语句与 `await sendTurn(` 之间只隔着 `let run` / `try {`，不得再插别的语句（尤其是 await——清得越晚，被强清放弃的旧 run 受限越久）；
      //   `sendTurn` 在被调用时同步执行到 `agent.send`，所以这就是「清除与首次 send 之间没有 await」
      expect(src).toMatch(
        /if \(!foreignContent\) clearNonOwnerTurn\(task\.id\);\s*let run: SessionRun;\s*try \{\s*run = await sendTurn\(created, resumedFrom \? followPrompt : fullPrompt\);/,
      );
      // 外来内容那一支是在 Agent.create 之前就登记的（begin 覆盖旧标记），不能被上面的属主清除误清自己的：清除必须带 `!foreignContent` 条件
      expect(src).toMatch(/if \(foreignContent\) oneshotForeignToken = beginNonOwnerTurn\(task\.id, Date\.now\(\), "desktop"\);/);
    });

    it(
      "closeTaskSession 调用点清单（按所在顶层函数对账，共 19 处）——缺省「清标记」是有意的决定（第十八轮：不反转成「缺省不清」）；新增 / 删除 / 挪动调用点会让这份清单红，红了要人工逐个核对再改",
      () => {
        // 决定与理由（用户 2026-11-24 09:51 授权「都按你推荐的来」；第十六轮评审把「缺省反转 / 引用计数」留给了用户）：
        //  · 缺省保持「清」、不反转：反转 = 把 19 个调用点的语义一起翻（16 个「这一轮确实结束」的点要逐个补显式清除，再改一批钉着「缺省清」的测试），
        //    换来的是把「续接点忘了声明保留」从 fail-open 变成 fail-safe。续接点本来就是少数且已枚举（自动重连 3 处显式 keepNonOwnerTurn: true，
        //    上面两条契约钉着；压缩续接靠 foreignContentTurn 重新登记），而「新增调用点忘了判断」正是下面这份清单要拦的。
        //    以后若再冒出「续接点忘了保留」的新漏洞，再回头考虑反转（这条测试的失败信息就是为那一刻写的）。
        //  · 不做引用计数：被强清放弃的旧 run 的越权窗口已由咽喉的过期会话闸（callerToken，见 stale-session-gate.test.ts）收口，标记的归属问题不再有「旧 run 拿到权限」的后果；
        //    剩下的只是「同一任务上先后两轮的标记谁清谁」的正确性（让位后标记多留一阵这类 fail-safe 残留），由 token / 按名 / 让位三套规则兜着，不值得再加一层所有权。
        // 这份清单**能做的**（第十九轮评审 R19-12 订正此前「19 处全部钉死 / 逐个」的说法）：按「文件 → 所在顶层函数 → 个数」对账（此前只到「文件 → 个数」，
        //   同一文件里一个函数多一个、另一个函数少一个会互相抵消），新增 / 删除 / 把调用挪进别的函数都会红。
        // **做不到的**：同一个函数内部的位置没钉（函数里一增一减、或挪到别的分支，清单照样绿）；也不是「机器证明每个点的语义正确」——
        //   每个点该不该清，靠上面两条契约 + 各自的行为用例 + 红了之后的人工核对。
        // 红了怎么办：新增了调用点 → 先判断它是不是「同一轮的续接」（是：传 keepNonOwnerTurn: true 并补用例；否：缺省即可），再更新下面的清单。
        const ROOT = path.resolve(import.meta.dirname, "..");
        const walk = (dir: string, out: string[] = []): string[] => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (e.name === "node_modules" || e.name === ".next") continue;
              walk(p, out);
            } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
          }
          return out;
        };
        /** 调用点所在的顶层声明名（向前找最近一行以 const / function / let 起头、顶格的声明；源码已去注释） */
        const topLevelNameAt = (src: string, index: number): string => {
          const lines = src.slice(0, index).split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const m = /^(?:export\s+)?(?:async\s+)?(?:const|function|let)\s+([A-Za-z0-9_$]+)/.exec(lines[i]!);
            if (m) return m[1]!;
          }
          return "(文件顶部)";
        };
        const found: Record<string, Record<string, number>> = {};
        for (const file of walk(path.join(ROOT, "src"))) {
          const src = stripComments(readFileSync(file, "utf-8"));
          for (const m of src.matchAll(/\bcloseTaskSession\(/g)) {
            const rel = path.relative(ROOT, file);
            const fn = topLevelNameAt(src, m.index!);
            (found[rel] ??= {})[fn] = ((found[rel] ?? {})[fn] ?? 0) + 1;
          }
        }
        expect(found, "closeTaskSession 调用点（文件 → 所在顶层函数 → 个数；注释不算）").toEqual({
          "src/app/api/tasks/[id]/route.ts": { PATCH: 1 }, // 任务的仓库绑定变了（reposChanged）：锁外关内存会话
          "src/lib/server/task-fs.ts": { setTaskProvider: 1 }, // 切家（provider 变了）：动态 import 关旧会话
          "src/lib/server/task-runner.ts": {
            SESSION_SWEEPER_KEY: 1, // 空闲会话回收（定时器回调）
            cancelTaskRun: 1,
            closeIdleTaskSessionForArchive: 1,
            advanceTaskCore: 2,
            resumeCurrentActionCore: 1,
            internalStartAgent: 2,
            tryAutoReconnect: 3, // 三处都带 keepNonOwnerTurn: true（上面那条契约钉着个数）
            closeStartChainResourcesForStop: 1,
            consumeSessionRun: 1,
            sendToTaskSessionBody: 4,
          },
        });
      },
    );
  });

  describe("callerToken 表透传（第十九轮评审 R19-10）", () => {
    it("token 表这一组透传真实现：helper 登记的 token 咽喉认得、别的 token 拒——往本文件加经咽喉调受限工具的用例不会踩 mock 的坑", async () => {
      const { invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
      const { bindSessionToken, releaseSessionToken } = await import("./helpers/session-token");
      const id = "t_mock_passthrough";
      const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "HANDLED" }] }));
      const tool = { name: "desktop_screenshot", label: "x", description: "", parameters: {} as never, handler };
      bindSessionToken(id, "tokX");
      try {
        const ok = await invokeFlowshipTool(tool as never, {}, "tokX", { taskId: id } as never);
        expect(ok.content[0]).toMatchObject({ text: "HANDLED" });
        const bad = await invokeFlowshipTool(tool as never, {}, "other", { taskId: id } as never);
        expect(bad.isError).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        releaseSessionToken(id, "tokX");
      }
    });
  });
});
