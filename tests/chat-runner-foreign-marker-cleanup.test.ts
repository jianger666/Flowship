/**
 * chat 型任务：中途登记的「群成员触发」标记（midRun，scope=desktop）在 runChatSession 的各出口都要摘掉（第三轮评审 P1-1 / P2 标记泄漏）
 *
 * 背景：chat-inject / ask-inject 在把别人写的内容交给 chat 会话之前补登一个中途标记（beginForeignContentMidRun）。
 * 正常收尾由 consumeChatRun 的 finally 清；可 runChatSession 在走到 consumeChatRun 之前有一串出口——lease 失效、
 * Agent.create 抛错、首包 send 期间被停止——这些出口 consume 根本没跑，标记没人摘：
 * 之后所有者自己的下一轮会被误拒 desktop_* / 写所有者备注（直到 45 分钟 TTL）。
 * 修后 runChatSession 在 lease 失效出口与主 try 的 finally 里、consumeChatRun 的 finally 里都按名清一次——
 * **前提是表里没有别的实例在占**（isChatSlotHeldByOtherInstance）：按名清不看归属，表里已是别人时那个标记多半是它登记的，
 * 清了就是外来内容无保护。这条例外先后在第七轮评审 N1（强清 restart）、第八轮评审 N2 / P3-2 / P3-3（重连让位 / error 收尾空窗 / lease 失效早退）里补全，
 * 对应「强清（restart 摘表）之后旧 run 迟到的收尾」（第七轮）与「别的实例占着表时，收尾 / 早退不按名清它的标记」（第八轮）两组 describe；
 * 前面各 describe 测的是「表里没有别人」时的常规清除（旧会话自己收尾，必须清干净）。
 *
 * 本文件按评审轮次往后追加的 describe 一览（自上而下）：
 *  · 第七轮 N1「强清（restart 摘表）之后旧 run 迟到的收尾」；
 *  · 第八轮 N2 / P3-2 / P3-3「别的实例占着表时，收尾 / 早退不按名清它的标记」；
 *  · 第八轮 P3-5「consumeChatRun 的入口复查」（让出点期间实例被停止 / 替换，迟到 run 不再被消费）；
 *  · 第八轮 P3-1「非属主答 ask 送 chat」（真 ask-inject → 真 deliverChatAskReply）：非属主答 agent 挂着的 ask_user、答案送进 chat 会话——
 *    标记紧贴 agent.send 登记（deliverChatAskReply 的 foreignContentTurn），不再在 ask-inject 入口早登记；
 *  · 第十轮 N1「ask 答案在 ask-wait 窗口里、别路外来内容沿用了它的标记」：ask-inject 在 await fulfillAskWait（最长 15 秒）之前就登记了标记，
 *    窗口里所有者空 @ 引用别人的那一路沿用了它；窗口到点后 ask-inject 自己的回滚（收回 / 抛错 / 没送达）不能把沿用者这一轮的保护清掉
 *    （真 ask-inject → 真 deliverChatAskReply → 真 sendChatMessage；守卫层与 ask-inject 层的对照在 non-owner-turn-run-alive / ask-inject-foreign-content 里）；
 *    这个 describe（第十轮 N1）后面还追加了两条**用例**（不是独立的 describe，都在同一个 describe 里、共用它的 ask-wait 窗口脚手架）：
 *    · 第十一轮 P3-1「沿用者没送达」：让位的前提是沿用者那一轮真的在跑（会为标记收尾）。同样的窗口里别路沿用了标记、可它直送 agent.send 抛错 / 会话被关、
 *      没有 run 在跑——窗口到点登记者的回滚照清，不留没人收尾的孤儿标记（让位判据本身的三态在 non-owner-turn-run-alive）。
 *      「沿用者登记时它的 run 已经算在跑」这条前提由 non-owner-turn-run-alive 里的源码顺序断言钉着，这里没有覆盖 resume 路径的沿用者。
 *    · 第十二轮 P2-1「重连空窗」：沿用者那一轮断流进了自动重连，登记者的窗口恰好在表空的空窗里到点——chat 探针只看 runActive 时答「没在跑」、回滚照清，
 *      重连接上后那一轮无标记地继续；修后探针算上重连链在飞（真重连链 + 真 ask-inject / sendChatMessage；用例里用 cancelAskWait 在 resume 回调里精确收窗）。
 *
 * 骨架抄 chat-runner-start-lease.test.ts（真 chat-runner + 假 Cursor SDK）；non-owner-turn-guard 用真实的。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueuedChatMsg } from "@/lib/server/chat-queue";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";
import { readSource } from "./helpers/source-text";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-foreign-cleanup-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

// ask-wait 的「等 curl 挂上」窗口线上是 15 秒（ASK_WAIT_ATTACH_MS）：用例要走它时把这里设成几百毫秒，其余用例（没有 ask-wait 槽、立刻返回 false）不受影响
const askWaitTest = vi.hoisted(() => ({ attachWaitMs: undefined as number | undefined }));
const mockCreate = vi.fn();
const mockResume = vi.fn();
vi.mock("@/lib/server/ask-wait", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/ask-wait")>("@/lib/server/ask-wait");
  return {
    ...actual,
    fulfillAskWait: (taskId: string, askId: string, replyText: string, opts?: { attachWaitMs?: number }) =>
      actual.fulfillAskWait(
        taskId,
        askId,
        replyText,
        askWaitTest.attachWaitMs === undefined ? opts : { ...opts, attachWaitMs: askWaitTest.attachWaitMs },
      ),
  };
});
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

const { readEvents, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { getTask } = await import("@/lib/server/task-fs");
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  forceClearChatRun,
  hasChatSession,
  runChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { cancelChatStart, clearChatGate, tryReserveChatStart } = await import("@/lib/server/chat-gate");
const { cleanupChatQueueState, drainRemainingChatQueue, enqueueChatMessage, getChatQueueCount } = await import(
  "@/lib/server/chat-queue"
);
const { startChatFromQueuedMessage } = await import("@/lib/server/chat-queue-send-now");
const { handleChatReplyInject } = await import("@/lib/server/chat-inject");
const {
  __resetNonOwnerTurnGuardForTest,
  beginForeignContentMidRun,
  beginNonOwnerTurn,
  endMidRunForeignContent,
  isGroupNonOwnerTurnActive,
  isLiveMarkerToken,
} = await import("@/lib/server/non-owner-turn-guard");
const { __resetPendingAskStateForTest, CALLER_MISMATCH_ERROR, getExpectedCallerToken, registerPendingAsk } = await import(
  "@/lib/server/chat-pending"
);
const { invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const { cancelAskWait, openAskWait, resetAskWaitForTest } = await import("@/lib/server/ask-wait");
const { injectPendingAskText } = await import("@/lib/server/feishu-bridge/ask-inject");
const { clearFailpoints, setFailpoint } = await import("@/lib/server/failpoints");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`chat-runner-foreign-marker-cleanup DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

// 每个用例一个新 task id（beforeEach 里换）：同一个 id 会让上一个用例迟到的收尾落进下一个用例——
// 它的 flush 把排队消息塞回队首（requeueIfSameGen）、consume 的 finally 按名清标记。2026-11-23 压力下复现过：
// 上一个用例的「普通排队的话」在下个用例清理之后被迟到 flush 复活到队首，占掉本该是外来内容的 agent.send #3。
// 不能靠 cleanupChatQueueState 兜：它要求「活跃 drain 已退出」才能调（只有删任务那一处满足），这里没法保证；靠隔离，迟到事件只会落在旧 id 上。
let TASK_ID = "t_1700000001200_foreign_cleanup_0";
let taskSeq = 0;
/** 本文件用过的全部 task id（afterAll 逐个关会话） */
const usedTaskIds = new Set<string>();
const AGENT_A = "agent_fake_foreign_A";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `foreign cleanup ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;
const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

/** 可手动放行的挂起 send */
const makePendingSendAgent = (agentId: string) => {
  let resolveSend!: (run: unknown) => void;
  const gate = new Promise((resolve) => {
    resolveSend = resolve;
  });
  const fakeRun = {
    stream: vi.fn(async function* (): AsyncGenerator<never> {
      /* 空 */
    }),
    wait: vi.fn().mockResolvedValue({ status: "cancelled" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const send = vi.fn().mockImplementation(() => gate);
  return { agentId, close: vi.fn().mockResolvedValue(undefined), send, resolveSend, fakeRun };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 过期会话闸用例的工具桩：handler 被调用 = 咽喉放行了这次调用 */
const fakeTool = (name: string) => ({
  name,
  label: name,
  description: "",
  parameters: {} as never,
  handler: vi.fn(async () => ({ content: [{ type: "text" as const, text: `HANDLED:${name}` }] })),
});
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

beforeEach(async () => {
  taskSeq += 1;
  TASK_ID = `t_1700000001200_foreign_cleanup_${taskSeq}`;
  usedTaskIds.add(TASK_ID);
  mockCreate.mockReset();
  mockResume.mockReset();
  __resetNonOwnerTurnGuardForTest();
  closeChatSessionUnconditional(TASK_ID);
  clearChatGate(TASK_ID);
  cleanupChatQueueState(TASK_ID);
  await sleep(30);
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearFailpoints();
  closeChatSessionUnconditional(TASK_ID);
  clearChatGate(TASK_ID);
  cleanupChatQueueState(TASK_ID);
  __resetNonOwnerTurnGuardForTest();
  await sleep(30);
});

afterAll(async () => {
  for (const id of usedTaskIds) closeChatSessionUnconditional(id);
  await sleep(100);
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("runChatSession 没走到 consumeChatRun 的出口：中途标记不残留", () => {
  it("lease 失效（cancelChatStart 之后带旧 token 起会话）→ lease_cancelled，标记已摘", async () => {
    const token = tryReserveChatStart(TASK_ID);
    expect(token).not.toBeNull();
    cancelChatStart(TASK_ID);
    expect(beginForeignContentMidRun(TASK_ID)).toBeDefined();
    expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：标记应已登记").toBe(true);

    const result = await runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "别人写的内容" },
      startToken: token!,
    });

    expect(result).toBe("lease_cancelled");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(isGroupNonOwnerTurnActive(TASK_ID), "lease 失效出口没摘标记（会拒属主下一轮的电脑操作）").toBe(false);
  });

  it("Agent.create 抛错（建会话失败）→ 标记已摘", async () => {
    mockCreate.mockRejectedValue(new Error("create boom（测试注入）"));
    expect(beginForeignContentMidRun(TASK_ID)).toBeDefined();

    await runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "别人写的内容" },
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(hasChatSession(TASK_ID)).toBe(false);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "建会话失败后标记残留（会拒属主下一轮的电脑操作）").toBe(false);
  });

  it("首包 send 期间被停止（cancelled）→ 标记已摘", async () => {
    const pending = makePendingSendAgent(AGENT_A);
    mockCreate.mockResolvedValue({ agentId: AGENT_A, close: pending.close, send: pending.send });
    expect(beginForeignContentMidRun(TASK_ID)).toBeDefined();

    const start = runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "会被停止的首包" },
    });
    for (let i = 0; i < 50 && pending.send.mock.calls.length === 0; i++) await sleep(20);
    expect(pending.send).toHaveBeenCalledTimes(1);
    // 停止发生在 send 受理之前：此刻标记应还在（这一轮「已经开始」）
    expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(true);

    expect(cancelChatRun(TASK_ID)).toBe(true);
    pending.resolveSend(pending.fakeRun);
    await start;

    expect(hasChatSession(TASK_ID)).toBe(false);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "停止出口后标记残留").toBe(false);
  });

  it("首包 run 正常跑完 → 标记已摘（对照：这条出口 consumeChatRun 自己就会清）", async () => {
    const run = {
      stream: vi.fn(async function* (): AsyncGenerator<unknown> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "答" }] } };
      }),
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue({
      agentId: AGENT_A,
      close: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(run),
    });
    expect(beginForeignContentMidRun(TASK_ID)).toBeDefined();

    await runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "别人写的内容" },
    });

    expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
  });
});

describe("热路径（sendChatMessage 续接存活会话，不经 runChatSession）", () => {
  // chat-inject 对「别人写的内容」在 sendChatMessage 之前补登标记；热路径的 run 由 consumeChatRun fire-and-forget 消费，
  // 它自己的 finally 是唯一的摘除点。以前这条只被源码正则和「测试里手动调 endMidRunForeignContent」间接证明（第三轮评审 P1-4：自证）。
  // 这里走真实的 sendChatMessage → consumeChatRun：删掉 consumeChatRun finally 里那行，标记挂到 45 分钟 TTL。
  const startLiveSessionWithGatedSecondRun = async () => {
    const finished = {
      stream: vi.fn(async function* (): AsyncGenerator<unknown> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "第一轮答" }] } };
      }),
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    let releaseStream!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const gated = {
      stream: vi.fn(async function* (): AsyncGenerator<unknown> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "第二轮答（在跑）" }] } };
        await gate;
      }),
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockImplementation(async () => {
        releaseStream();
      }),
    };
    const send = vi.fn().mockResolvedValueOnce(finished).mockResolvedValueOnce(gated);
    mockCreate.mockResolvedValue({ agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send });
    // 第一轮：属主自己的话，正常跑完，会话留着
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(hasChatSession(TASK_ID), "前置：第一轮跑完后会话应保留").toBe(true);
    return { send, releaseStream };
  };

  it("别人的内容走 sendChatMessage 进已有会话：这一轮跑着标记在（run 探针让它不因 TTL 过期）、跑完被 consumeChatRun 摘掉", async () => {
    const { send, releaseStream } = await startLiveSessionWithGatedSecondRun();
    try {
      // chat-inject 的时序：送进会话之前先补登
      expect(beginForeignContentMidRun(TASK_ID)).toBeDefined();
      const sent = await sendChatMessage(asTask(makeMeta(TASK_ID)), "别人写的内容");
      expect(sent).toBe("sent");
      expect(send).toHaveBeenCalledTimes(2);
      expect(isGroupNonOwnerTurnActive(TASK_ID), "run 在跑：标记应还在").toBe(true);

      // 这一轮跑得比 45 分钟 TTL 还久：chat 的 run 探针（runActive）让标记续命，不会半路失效
      const realNow = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(realNow + 50 * 60_000);
        expect(isGroupNonOwnerTurnActive(TASK_ID), "run 还活着，标记不该因 TTL 过期（否则长跑的 run 后半段 desktop_* 全放行）").toBe(true);
      } finally {
        vi.useRealTimers();
      }

      releaseStream();
      await vi.waitFor(
        () => expect(isGroupNonOwnerTurnActive(TASK_ID), "run 收尾后中途补登的标记没人摘（会拒属主下一轮的电脑操作）").toBe(false),
        { timeout: 4_000 },
      );
    } finally {
      releaseStream();
    }
  });

  it("对照：属主自己的话走 sendChatMessage：全程没有标记", async () => {
    const { releaseStream } = await startLiveSessionWithGatedSecondRun();
    try {
      expect(await sendChatMessage(asTask(makeMeta(TASK_ID)), "属主第二句")).toBe("sent");
      expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
    } finally {
      releaseStream();
    }
    await sleep(50);
    expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
  });
});

describe("只清「中途补登」的那种标记", () => {
  it("非 midRun 的标记（scope=desktop，send 起点登记那种）不被 runChatSession 的收尾误清", async () => {
    mockCreate.mockRejectedValue(new Error("create boom（测试注入）"));
    beginNonOwnerTurn(TASK_ID, Date.now(), "desktop");

    await runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "x" },
    });

    expect(isGroupNonOwnerTurnActive(TASK_ID), "收尾按名清只该清 midRun 标记").toBe(true);
  });

  it("属主自己的会话（没登记过任何标记）：跑完后依旧没有标记（不凭空多出来）", async () => {
    mockCreate.mockRejectedValue(new Error("create boom（测试注入）"));

    await runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "属主自己的话" },
    });

    expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
  });
});

// ───────────────────────── 第五轮评审 N1：排队的外来内容（foreignContentTurn）——真链路 ─────────────────────────
//
// 背景：所有者在需求群里空 @ / 一句话再引用别人，agent 正忙时第四轮回 409「请稍后再 @ 我一次」，所有者的话就丢了（回归）。
// 修后这条照常排队，队列项带 foreignContentTurn；中途标记**不在入队时登记**（它是任务级的：早登记会去限制属主此刻正在跑的那一轮，
// 而那一轮的收尾又会按名把它清掉），而是等它出队、真正送达的那一刻（flush → sendChatMessage / runChatSession，agent.send 之前、同步）才登记。
// 这里走真实的 flushChatQueue → sendChatMessage → consumeChatRun / runChatSession，假 agent 在 send 被调用那一刻记录标记是否已就位。

type ScriptedTurn = "finished" | "gated" | "throw" | "disconnect";

/**
 * 按轮次脚本化的假 agent：第 n 次 send → turns[n-1]（缺省 finished）。
 * finished = 立即跑完；gated = 吐一条回复后挂住、直到 releaseRound(n)；throw = send 本身抛错；
 * disconnect = 吐一条回复后挂住、releaseRound(n) 时流抛网络类错误（「fetch failed」，consumeChatRun 走自动重连；第十二轮评审 P2-1 用）。
 * atSend[n-1] = 第 n 次 send 被调用那一刻、scope=desktop 的标记是否已就位（= agent 拿到内容那一刻是否受限）。
 */
const makeScriptedAgent = (turns: ScriptedTurn[]) => {
  const atSend: boolean[] = [];
  const releases = new Map<number, () => void>();
  let n = 0;
  const send = vi.fn().mockImplementation(async () => {
    const round = ++n;
    const turn: ScriptedTurn = turns[round - 1] ?? "finished";
    atSend.push(isGroupNonOwnerTurnActive(TASK_ID));
    if (turn === "throw") throw new Error("send boom（测试注入）");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.set(round, release);
    return {
      stream: vi.fn(async function* (): AsyncGenerator<unknown> {
        yield { type: "assistant", message: { content: [{ type: "text", text: `第 ${round} 轮答` }] } };
        if (turn === "gated" || turn === "disconnect") await gate;
        if (turn === "disconnect") throw new Error("fetch failed");
      }),
      wait: vi.fn().mockResolvedValue({ status: turn === "disconnect" ? ("error" as const) : ("finished" as const) }),
      cancel: vi.fn().mockImplementation(async () => {
        release();
      }),
    };
  });
  mockCreate.mockResolvedValue({ agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send });
  return { send, atSend, releaseRound: (round: number) => releases.get(round)?.() };
};

const FOREIGN_TEXT = "别人写的内容（所有者空 @ 引用）";
const enqueueQueued = (foreign: boolean) =>
  enqueueChatMessage(TASK_ID, {
    agentText: foreign ? FOREIGN_TEXT : "普通排队的话",
    displayText: foreign ? FOREIGN_TEXT : "普通排队的话",
    imageAbsPaths: [],
    enqueuedAt: Date.now(),
    ...(foreign ? { foreignContentTurn: true } : {}),
  });

/** 第一轮：属主自己的话、正常跑完、会话保留；第二句进来、这一轮挂着（= 会话忙，可以排队）。前两轮都没有标记 */
const startBusyLiveSession = async (turns: ScriptedTurn[]) => {
  const agent = makeScriptedAgent(turns);
  await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
  expect(hasChatSession(TASK_ID), "前置：第一轮跑完后会话应保留").toBe(true);
  expect(await sendChatMessage(asTask(makeMeta(TASK_ID)), "属主第二句")).toBe("sent");
  expect(agent.atSend, "前置：属主自己的两轮都没有标记").toEqual([false, false]);
  return agent;
};

describe("排队的外来内容（第五轮评审 N1）：入队不登记，出队送达那一刻才登记", () => {
  it("会话忙时排进队里的外来内容：入队不登记（属主此刻这一轮不受限）→ 前一轮收尾后出队，agent 拿到它那一刻标记已就位 → 跑着一直在 → 跑完被清", async () => {
    const agent = await startBusyLiveSession(["finished", "gated", "gated"]);
    try {
      expect(enqueueQueued(true).ok).toBe(true);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "入队就登记了标记：属主此刻正在跑的这一轮会被误拒 desktop_*，且这一轮收尾又会把它按名清掉",
      ).toBe(false);
      expect(getChatQueueCount(TASK_ID)).toBe(1);

      agent.releaseRound(2); // 属主第二轮收尾 → finalize → flush → 出队送达外来内容
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(3), { timeout: 4_000 });
      expect(
        agent.atSend,
        "外来内容出队送达时、agent.send 之前标记必须已就位——否则它就是一次无标记送达",
      ).toEqual([false, false, true]);

      // 这一轮跑着：前一轮收尾的清理不能把它误清（登记之后又被按名清掉 = 这一轮后半段无标记）
      await sleep(150);
      expect(isGroupNonOwnerTurnActive(TASK_ID), "外来内容这一轮还在跑，标记不该已经没了").toBe(true);

      agent.releaseRound(3);
      await vi.waitFor(
        () => expect(isGroupNonOwnerTurnActive(TASK_ID), "这一轮收尾后标记没人摘（会拒属主下一轮的电脑操作）").toBe(false),
        { timeout: 4_000 },
      );
    } finally {
      agent.releaseRound(2);
      agent.releaseRound(3);
    }
  });

  it("对照：排队的普通消息出队送达：全程没有标记", async () => {
    const agent = await startBusyLiveSession(["finished", "gated", "gated"]);
    try {
      expect(enqueueQueued(false).ok).toBe(true);
      agent.releaseRound(2);
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(3), { timeout: 4_000 });
      // 让第 3 轮把「置 running」走完再收尾：否则用例结束时与 afterEach 的关会话交叠，只会多一行「丢弃迟到 run」的噪声日志
      await sleep(100);
      expect(agent.atSend).toEqual([false, false, false]);
      expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
    } finally {
      agent.releaseRound(2);
      agent.releaseRound(3);
    }
  });

  it("队列里先外来、后普通：外来那条送达时有标记；它收尾后普通那条送达时没有（上一条的标记不遗留到下一条）", async () => {
    const agent = await startBusyLiveSession(["finished", "gated", "gated", "gated"]);
    try {
      enqueueQueued(true);
      enqueueQueued(false);
      agent.releaseRound(2);
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(3), { timeout: 4_000 });
      agent.releaseRound(3); // 外来那一轮收尾 → flush → 普通那条
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(4), { timeout: 4_000 });
      expect(
        agent.atSend,
        "普通消息送达时不该带着上一条外来内容的标记（会误拒属主自己的电脑操作）",
      ).toEqual([false, false, true, false]);
    } finally {
      agent.releaseRound(2);
      agent.releaseRound(3);
      agent.releaseRound(4);
    }
  });

  it("两条外来内容连续排队：前一条收尾清掉自己的标记、后一条送达时重新登记（两轮之间既不能遗留、也不能后一条没标记），后一条跑着标记一直在", async () => {
    const agent = await startBusyLiveSession(["finished", "gated", "gated", "gated"]);
    try {
      enqueueQueued(true);
      enqueueQueued(true);
      agent.releaseRound(2);
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(3), { timeout: 4_000 });
      agent.releaseRound(3);
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(4), { timeout: 4_000 });
      expect(agent.atSend).toEqual([false, false, true, true]);

      await sleep(150);
      expect(isGroupNonOwnerTurnActive(TASK_ID), "第二条外来内容这一轮在跑，标记不该被前一轮的收尾误清").toBe(true);

      agent.releaseRound(4);
      await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4_000 });
    } finally {
      agent.releaseRound(2);
      agent.releaseRound(3);
      agent.releaseRound(4);
    }
  });

  it("出队送达时 agent.send 抛错：登记的标记已回滚、不残留（不去拒属主下一轮的电脑操作）", async () => {
    const agent = await startBusyLiveSession(["finished", "gated", "throw"]);
    try {
      enqueueQueued(true);
      agent.releaseRound(2);
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(3), { timeout: 4_000 });
      expect(agent.atSend, "send 被调用那一刻标记应已登记（才有回滚可言）").toEqual([false, false, true]);
      // flush 对 send_failed 的善后（重排 / 关会话）是异步的：等它跑完再看
      await sleep(250);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "送达失败后标记残留（会拒属主下一轮的电脑操作，直到 45 分钟 TTL）",
      ).toBe(false);
    } finally {
      agent.releaseRound(2);
    }
  });

  it("sendChatMessage 直接带 foreignContentTurn、会话在跑（busy 早退）：不登记标记——没送达就不该去限制属主此刻这一轮", async () => {
    const agent = await startBusyLiveSession(["finished", "gated"]);
    try {
      const sent = await sendChatMessage(asTask(makeMeta(TASK_ID)), FOREIGN_TEXT, undefined, undefined, {
        foreignContentTurn: true,
      });
      expect(sent).toBe("busy");
      expect(agent.send).toHaveBeenCalledTimes(2);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "busy 早退也登记了标记：属主此刻正在跑的这一轮被误限制",
      ).toBe(false);
    } finally {
      agent.releaseRound(2);
    }
  });

  it("sendChatMessage 直接带 foreignContentTurn、会话空闲（send-now 续接 / flush 的落点）：agent.send 那一刻标记已就位，这一轮跑完被清", async () => {
    const agent = makeScriptedAgent(["finished", "gated"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(hasChatSession(TASK_ID)).toBe(true);
    try {
      const sent = await sendChatMessage(asTask(makeMeta(TASK_ID)), FOREIGN_TEXT, undefined, undefined, {
        foreignContentTurn: true,
      });
      expect(sent).toBe("sent");
      expect(agent.atSend, "外来内容 agent.send 之前标记必须已就位").toEqual([false, true]);
      expect(isGroupNonOwnerTurnActive(TASK_ID), "这一轮在跑").toBe(true);
      agent.releaseRound(2);
      await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4_000 });
    } finally {
      agent.releaseRound(2);
    }
  });

  it("sendChatMessage 带 foreignContentTurn、agent.send 挂起期间被停止（迟到 run 被丢弃、没有 consume 来收尾）：登记的标记已回滚，返回 cancelled", async () => {
    // 第一轮：属主自己的话、跑完、会话留着。第二轮（外来内容）的 agent.send 挂起不决——停止在 send 受理之前到达
    const finished = {
      stream: vi.fn(async function* (): AsyncGenerator<unknown> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "第一轮答" }] } };
      }),
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const lateRun = {
      stream: vi.fn(async function* (): AsyncGenerator<never> {
        /* 迟到 run：被丢弃，不会被消费 */
      }),
      wait: vi.fn().mockResolvedValue({ status: "cancelled" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    let resolveSecond!: (run: unknown) => void;
    const secondGate = new Promise<unknown>((resolve) => {
      resolveSecond = resolve;
    });
    const atSend: boolean[] = [];
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        atSend.push(isGroupNonOwnerTurnActive(TASK_ID));
        return finished;
      })
      .mockImplementationOnce(() => {
        atSend.push(isGroupNonOwnerTurnActive(TASK_ID));
        return secondGate;
      });
    mockCreate.mockResolvedValue({ agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send });
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(hasChatSession(TASK_ID), "前置：第一轮跑完后会话应保留").toBe(true);

    const second = sendChatMessage(asTask(makeMeta(TASK_ID)), FOREIGN_TEXT, undefined, undefined, {
      foreignContentTurn: true,
    });
    for (let i = 0; i < 50 && send.mock.calls.length < 2; i++) await sleep(20);
    expect(send).toHaveBeenCalledTimes(2);
    expect(atSend, "外来内容 agent.send 之前标记必须已就位").toEqual([false, true]);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "send 挂起中：登记的标记在").toBe(true);

    expect(cancelChatRun(TASK_ID)).toBe(true);
    resolveSecond(lateRun);

    expect(await second).toBe("cancelled");
    expect(lateRun.cancel, "迟到 run 应被丢弃（cancel）").toHaveBeenCalled();
    expect(
      isGroupNonOwnerTurnActive(TASK_ID),
      "send 期间被停止的出口没回滚标记：没有 run 来清，标记会一直去拒属主的下一轮电脑操作",
    ).toBe(false);
  });
});

describe("runChatSession 带 foreignContentTurn（队列优先启动 / send-now 起会话 / 并发首条）", () => {
  it("首包 agent.send 那一刻标记已就位；这一轮跑完被清", async () => {
    const agent = makeScriptedAgent(["finished"]);

    await runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: FOREIGN_TEXT },
      foreignContentTurn: true,
    });

    expect(agent.atSend, "首包送出时标记必须已就位（agent 一拿到内容就可能调工具）").toEqual([true]);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "这一轮跑完标记没人摘").toBe(false);
  });

  it("对照：不带 foreignContentTurn → 首包 send 那一刻没有标记", async () => {
    const agent = makeScriptedAgent(["finished"]);

    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主自己的话" } });

    expect(agent.atSend).toEqual([false]);
  });

  it("首包 send 期间被停止：runner 自己登记的标记已清（不残留）", async () => {
    const pending = makePendingSendAgent(AGENT_A);
    mockCreate.mockResolvedValue({ agentId: AGENT_A, close: pending.close, send: pending.send });

    const start = runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: FOREIGN_TEXT },
      foreignContentTurn: true,
    });
    for (let i = 0; i < 50 && pending.send.mock.calls.length === 0; i++) await sleep(20);
    expect(pending.send).toHaveBeenCalledTimes(1);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "首包已发出、这一轮已经开始：标记应在").toBe(true);

    expect(cancelChatRun(TASK_ID)).toBe(true);
    pending.resolveSend(pending.fakeRun);
    await start;

    expect(isGroupNonOwnerTurnActive(TASK_ID), "停止出口后 runner 登记的标记残留").toBe(false);
  });

  it("并发首条（已有会话在跑）带 foreignContentTurn：首条改入队、队列项带标志、不登记标记（没送达就不限制属主）", async () => {
    // 先让一个会话「在起」：首包 send 挂起——runningChats 已有占位记录，第二个 runChatSession 进来就是 already_running
    const pending = makePendingSendAgent(AGENT_A);
    mockCreate.mockResolvedValue({ agentId: AGENT_A, close: pending.close, send: pending.send });
    const first = runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "属主第一句" },
    });
    for (let i = 0; i < 50 && pending.send.mock.calls.length === 0; i++) await sleep(20);
    expect(pending.send).toHaveBeenCalledTimes(1);

    const second = await runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: FOREIGN_TEXT },
      foreignContentTurn: true,
    });

    expect(second).toBe("already_running");
    expect(isGroupNonOwnerTurnActive(TASK_ID), "没送达就不该登记标记").toBe(false);
    const queued = drainRemainingChatQueue(TASK_ID);
    expect(queued).toHaveLength(1);
    expect(
      queued[0],
      "并发首条改入队后丢了外来标志：出队送达时就没有标记（第五轮评审 N1）",
    ).toMatchObject({ agentText: FOREIGN_TEXT, foreignContentTurn: true });

    expect(cancelChatRun(TASK_ID)).toBe(true);
    pending.resolveSend(pending.fakeRun);
    await first;
  });

  it("对照：并发首条不带 foreignContentTurn → 队列项没有标志", async () => {
    const pending = makePendingSendAgent(AGENT_A);
    mockCreate.mockResolvedValue({ agentId: AGENT_A, close: pending.close, send: pending.send });
    const first = runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "属主第一句" },
    });
    for (let i = 0; i < 50 && pending.send.mock.calls.length === 0; i++) await sleep(20);
    expect(pending.send).toHaveBeenCalledTimes(1);

    const second = await runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "属主第二句" },
    });

    expect(second).toBe("already_running");
    const queued = drainRemainingChatQueue(TASK_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]).not.toHaveProperty("foreignContentTurn");

    expect(cancelChatRun(TASK_ID)).toBe(true);
    pending.resolveSend(pending.fakeRun);
    await first;
  });

  // 第十四轮评审 P3-2：chat-inject 新会话路径靠「runChatSession 回 already_running」回滚预登记的标记，读返回值只让出**一次 microtask**
  //（挂 then 之后紧跟 `await Promise.resolve()`）。这条时序靠 runner 的 already_running 分支在**第一个 await 之前**同步 return——
  // 往那条分支前面加任何 await，chat-inject 读到的标志就是空的、回滚悄悄失效，而 chat-inject 侧的用例（mock 了 runner）不会红，所以在这里用真 runner 钉住。
  it("并发首条撞上已在跑的会话：runChatSession 的 already_running 在一次 microtask 让出内即可读到（chat-inject 据此回滚预登记的标记；不是等会话收尾才有值）", async () => {
    const pending = makePendingSendAgent(AGENT_A);
    mockCreate.mockResolvedValue({ agentId: AGENT_A, close: pending.close, send: pending.send });
    const first = runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "属主第一句" },
    });
    for (let i = 0; i < 50 && pending.send.mock.calls.length === 0; i++) await sleep(20);
    expect(pending.send).toHaveBeenCalledTimes(1);

    // 与 chat-inject 同一个读法：先挂 then（另有一个 catch 在前），再让出一次 microtask
    const second = runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: FOREIGN_TEXT },
      foreignContentTurn: true,
    });
    second.catch(() => {});
    let outcome: string | undefined;
    void second.then((r) => {
      outcome = r;
    });
    await Promise.resolve();
    expect(outcome, "already_running 没有在一次 microtask 内可见：runner 在这条分支前加了 await？chat-inject 的回滚会悄悄失效").toBe("already_running");

    expect(cancelChatRun(TASK_ID)).toBe(true);
    pending.resolveSend(pending.fakeRun);
    await first;
    drainRemainingChatQueue(TASK_ID);
  });

  // 第十五轮评审 P3-3 F2 / P3-5：上面那条只是「照 chat-inject 的读法」复刻一遍时序，chat-inject 真改了读法（或 runner 真加了 await）它不一定红。
  // 下面三条分别从被调用方、调用方的源码和真链路上钉同一个依赖。
  it("源码钉（被调用方）：runChatSession 从入口到 `return \"already_running\"` 之间没有任何 await——chat-inject 的回滚依赖它同步返回", () => {
    const src = readSource("src/lib/server/chat-runner.ts");
    const head = src.indexOf("export const runChatSession = async (");
    expect(head, "找得到 runChatSession").toBeGreaterThan(-1);
    // 全文件只有这一处 `return "already_running"`：再多一处（比如在某个 await 之后又加一条同名早退），下面按「第一处」切出来的窗口就不是它了——
    // 红了说明要逐个核对新增的那一处是否同样要同步返回（第十六轮评审 P3-C4 ①：此前只取第一处，多一处也不会红）
    expect(src.match(/return "already_running";/g)?.length, 'chat-runner 里 `return "already_running"` 的处数').toBe(1);
    const ret = src.indexOf('return "already_running";', head);
    expect(ret, "找得到 already_running 的返回").toBeGreaterThan(head);
    expect(
      src.slice(head, ret),
      "入口到 already_running 返回之间出现了 await：chat-inject 在一次 microtask 让出之后读 queuedBehindOtherSession，读到的恒为 false，预登记的标记不再回滚、悄悄挂到别人的 run 上",
    ).not.toMatch(/\bawait\b/);
  });

  it("源码钉（调用方）：chat-inject 挂 then 与 `await Promise.resolve()` 之间没有别的 await，且读标志在让出之后、回滚之前", () => {
    const src = readSource("src/lib/server/chat-inject.ts");
    // chat-inject 里有两处 `const sessionPromise = runChatSession({`（队列优先启动 / 新会话路径）：取带 queuedBehindOtherSession 的那一处（新会话路径）
    const flagAt = src.indexOf("let queuedBehindOtherSession = false;");
    expect(flagAt, "找得到 queuedBehindOtherSession").toBeGreaterThan(-1);
    const call = src.lastIndexOf("const sessionPromise = runChatSession({", flagAt);
    expect(call, "找得到新会话路径对 runChatSession 的调用").toBeGreaterThan(-1);
    const thenAt = src.indexOf("void sessionPromise.then(", call);
    const yieldAt = src.indexOf("await Promise.resolve();", thenAt);
    const readAt = src.indexOf("if (queuedBehindOtherSession)", yieldAt);
    expect(thenAt, "挂 then").toBeGreaterThan(call);
    expect(yieldAt, "让出一次 microtask").toBeGreaterThan(thenAt);
    expect(readAt, "读标志并回滚").toBeGreaterThan(yieldAt);
    expect(src.slice(call, yieldAt), "调用 runChatSession 到让出之间不得有别的 await（then 要在 await 续体之前入队）").not.toMatch(/\bawait\b/);
    // 读标志之后紧跟的就是让位版回滚这一条语句（锚在 readAt 上的正则；此前取 readAt 之后 120 个字符的魔数窗口再 toContain，窗口大小一变就悄悄失效）
    expect(src.slice(readAt), "读标志之后紧跟让位版回滚").toMatch(
      /^if \(queuedBehindOtherSession\) rollbackForeignContentMidRun\(id, foreignRef\.token\);/,
    );
  });

  it("真 chat-inject + 真 runner：新会话路径预登记标记 → 别路会话在它置 running 的 await 里占了位 → runner 同步回 already_running → chat-inject 把预登记的标记回滚；首条带着标志留在队里", async () => {
    const pendingA = makePendingSendAgent(AGENT_A);
    mockCreate.mockResolvedValue({ agentId: AGENT_A, close: pendingA.close, send: pendingA.send });
    const taskFs = await import("@/lib/server/task-fs");
    const chatGate = await import("@/lib/server/chat-gate");
    const guardNs = await import("@/lib/server/non-owner-turn-guard");
    const runnerNs = await import("@/lib/server/chat-runner");
    // 只观察不改行为（默认穿透到真实现）：证明「预登记真的发生过」「chat-inject 调的 runChatSession 真回了 already_running」——
    // 否则最后「标记不在」可能只是因为根本没登记过 / 没走到这条分支（第十六轮评审 P3-C4 ②）
    const beginSpy = vi.spyOn(guardNs, "beginForeignContentMidRun");
    const runSpy = vi.spyOn(runnerNs, "runChatSession");
    const realSetStatus = taskFs.setTaskRunStatus;
    let startA: Promise<unknown> | undefined;
    // 新会话路径：snapshot / 落 user_reply 之后、runChatSession 之前有 setTaskRunStatus 这个 await——别路（属主的会话，首包 send 挂起 = 占位在、run 在跑）在这里占位
    const statusSpy = vi.spyOn(taskFs, "setTaskRunStatus").mockImplementationOnce(async (...args) => {
      startA = runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
      for (let i = 0; i < 50 && pendingA.send.mock.calls.length === 0; i++) await sleep(20);
      return realSetStatus(...args);
    });
    // 别路无 token 的启动在转正时会无条件释放启动预约（releaseChatStart 不带 token = 无条件删），把 chat-inject 这一路的 lease 也带走，
    // 那样 runner 在入口就回 lease_cancelled、走不到 already_running 这条分支。真实并发里两路各有预约，这里只是把 lease 判定固定成有效，只为走到被测分支
    const leaseSpy = vi.spyOn(chatGate, "isChatStartLeaseValid").mockReturnValue(true);
    try {
      const res = await handleChatReplyInject(
        TASK_ID,
        { text: FOREIGN_TEXT, bootArgs: { apiKey: BOOT.apiKey, model: BOOT.model } },
        { foreignContentTurn: true },
      );

      expect(statusSpy, "前置：应走到新会话路径的置 running").toHaveBeenCalled();
      expect(pendingA.send, "前置：别路的会话已占位、首包 send 在途").toHaveBeenCalledTimes(1);
      expect(res.status, "首条改入队，受理语义不变").toBe(202);
      // 前置：预登记真的发生过，且新建了标记（task 上此前没有活标记，所以不是「沿用别人的」）
      expect(beginSpy, "前置：chat-inject 应在送达前预登记标记").toHaveBeenCalled();
      const preToken = beginSpy.mock.results[0]!.value as string | undefined;
      expect(typeof preToken, "前置：预登记新建了标记").toBe("string");
      // 前置：chat-inject 调的 runChatSession 真回了 already_running（lease 被固定成有效，只为走到这条分支——见上面 leaseSpy 的说明）
      expect(runSpy, "前置：chat-inject 调了一次 runChatSession").toHaveBeenCalledTimes(1);
      await expect(runSpy.mock.results[0]!.value, "前置：runner 回的是 already_running").resolves.toBe("already_running");
      expect(
        isLiveMarkerToken(TASK_ID, preToken),
        "预登记的标记还活着：chat-inject 没读到 already_running 就把 token 交了出去——runner 在那条分支前加了 await？",
      ).toBe(false);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "预登记的标记挂到了别人（属主）那一轮上：chat-inject 没读到 already_running——runner 在那条分支前加了 await？",
      ).toBe(false);
      const queued = drainRemainingChatQueue(TASK_ID);
      expect(queued, "首条没丢：带着外来标志留在队里，出队送达时再登记").toHaveLength(1);
      expect(queued[0]).toMatchObject({ agentText: expect.stringContaining(FOREIGN_TEXT), foreignContentTurn: true });
    } finally {
      leaseSpy.mockRestore();
      statusSpy.mockRestore();
      beginSpy.mockRestore();
      runSpy.mockRestore();
      cancelChatRun(TASK_ID);
      pendingA.resolveSend(pendingA.fakeRun);
      await startA;
    }
  });
});

describe("send-now 打断重发的起点 startChatFromQueuedMessage：外来标志送进首包（第五轮评审 N1）", () => {
  // 外来内容的「立即发送」不 steer、改走 take → stop → start：start 在新会话 / resume 续接两条路径上都要把标志送到 agent.send 之前
  const makeHead = (foreign: boolean): QueuedChatMsg => ({
    itemId: `cq_start_${foreign ? "foreign" : "plain"}`,
    agentText: foreign ? FOREIGN_TEXT : "属主自己的话",
    displayText: foreign ? FOREIGN_TEXT : "属主自己的话",
    imageAbsPaths: [],
    enqueuedAt: Date.now(),
    skipPersistEvent: true,
    ...(foreign ? { foreignContentTurn: true } : {}),
  });

  it("新会话路径（meta 没有 sessionAgentId）：首包 agent.send 那一刻标记已就位；跑完被清", async () => {
    const agent = makeScriptedAgent(["finished"]);

    const res = await startChatFromQueuedMessage(TASK_ID, makeHead(true), BOOT);

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    expect(agent.atSend, "打断重发的新会话首包没带标记——外来内容无标记送达").toEqual([true]);
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "跑完标记没人摘").toBe(false), { timeout: 4_000 });
  });

  it("resume 续接路径（meta 有 sessionAgentId）：sendChatMessage 的 agent.send 之前标记已就位；跑完被清", async () => {
    await writeMeta({ ...makeMeta(TASK_ID), sessionAgentId: AGENT_A } as TaskMetaV06);
    const agent = makeScriptedAgent(["finished"]);
    mockResume.mockResolvedValue({
      agentId: AGENT_A,
      close: vi.fn().mockResolvedValue(undefined),
      send: agent.send,
    });

    const res = await startChatFromQueuedMessage(TASK_ID, makeHead(true), BOOT);

    expect(res.status).toBe(202);
    expect(await res.json(), "前置：应走 resume 续接路径").toMatchObject({ resumed: true });
    expect(agent.atSend, "resume 续接发出外来内容时没带标记——无标记送达").toEqual([true]);
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "跑完标记没人摘").toBe(false), { timeout: 4_000 });
  });

  it("对照：普通条目走新会话路径 → 首包没有标记", async () => {
    const agent = makeScriptedAgent(["finished"]);

    const res = await startChatFromQueuedMessage(TASK_ID, makeHead(false), BOOT);

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    expect(agent.atSend).toEqual([false]);
  });

  it("对照：普通条目走 resume 续接路径 → agent.send 之前没有标记", async () => {
    await writeMeta({ ...makeMeta(TASK_ID), sessionAgentId: AGENT_A } as TaskMetaV06);
    const agent = makeScriptedAgent(["finished"]);
    mockResume.mockResolvedValue({
      agentId: AGENT_A,
      close: vi.fn().mockResolvedValue(undefined),
      send: agent.send,
    });

    const res = await startChatFromQueuedMessage(TASK_ID, makeHead(false), BOOT);

    expect(res.status).toBe(202);
    expect(await res.json(), "前置：应走 resume 续接路径").toMatchObject({ resumed: true });
    expect(agent.atSend).toEqual([false]);
  });
});

// ───────────────────────── 第七轮评审 N1：强清（restart 摘表）之后，旧 run 迟到的收尾不得碰新会话的标记 ─────────────────────────
//
// 背景：旧 run 是「cancel 卡住没按期退」才被 forceClearChatRun 强清的——它的收尾（consumeChatRun / runChatSession 的 finally）
// 天然比新会话起得更晚。以前这两处 finally 都是 endMidRunForeignContent（按任务名清、不看归属）：新会话若已为新的外来内容登记了标记，
// 它会被旧 run 的收尾一并清掉，新一轮的外来内容就在无标记状态下继续（限制危险工具 / 电脑操作的保护提前失效，是安全边界）。
// 修法是分工：摘表者清（closeChatSession 在 reason=restart 的同步段里清旧会话的标记）+ 被摘的旧 run 收尾时不再碰别人的标记。
// （第七轮这里的判据是 rec.replacedReason === "restart"；第八轮评审 N2 发现只认 restart 漏了重连让位等路径，判据改成「表里是不是别的实例」，
//  见下面「第八轮评审」那组——本组的几条用例对新判据同样成立，原样保留。）
// 这里走真实的 forceClearChatRun / cancelChatRun → runChatSession / consumeChatRun，假 agent 用 gate 让旧 run 在强清之后才迟到收尾。
describe("强清（restart 摘表）之后旧 run 迟到的收尾（第七轮评审 N1）", () => {
  /** 属主一句话起会话、这一轮挂着（gated）；中途别人的内容送进来（登记标记）。返回 agent 与旧 run 的 promise */
  const startGatedRunWithForeignMark = async (turns: ScriptedTurn[]) => {
    const agent = makeScriptedAgent(turns);
    const startA = runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    // 让 consumeChatRun 真正接管这一轮（流已吐出第一段、挂在 gate 上）再登记，贴近「别人的内容送进在跑的一轮」
    await sleep(80);
    expect(beginForeignContentMidRun(TASK_ID), "前置：别人的内容送进这一轮、新建标记").toBeDefined();
    expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：标记已就位").toBe(true);
    return { agent, startA };
  };

  it("强清在摘表的同步段里就清掉旧会话的标记（摘表者清：不留给旧 run 迟到的收尾，也不等它）", async () => {
    const { agent, startA } = await startGatedRunWithForeignMark(["gated"]);
    try {
      forceClearChatRun(TASK_ID);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "强清后旧会话的标记还挂着：旧 run 的收尾已不再碰它，没人清就会拒属主下一轮的电脑操作",
      ).toBe(false);
    } finally {
      agent.releaseRound(1);
      await startA;
    }
  });

  it("C3 收口（第十八轮，过期会话闸）：强清摘表后旧 run 的电脑操作靠 callerToken 仍被拒（摘表的同一同步段里 token 一并摘了），新会话起来后旧 token 依旧被拒、新会话放行", async () => {
    const { agent, startA } = await startGatedRunWithForeignMark(["gated", "gated"]);
    // 真 registerChatNotifier 登记的 A 的会话 token
    const tokenA = getExpectedCallerToken(TASK_ID);
    expect(tokenA, "前置：A 的会话 token 已登记").toBeTruthy();
    try {
      forceClearChatRun(TASK_ID);
      expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：强清摘表时标记已清——旧 run 此刻不再被标记限制，只剩 token 这一道").toBe(false);
      expect(getExpectedCallerToken(TASK_ID), "强清摘表（closeChatSession）没把旧会话的 token 一并摘掉").toBeNull();
      // 窗口：摘表之后、新会话起来之前——旧 run（cancel 卡住没退）还能发工具调用
      const windowTool = fakeTool("desktop_screenshot");
      expect(
        textOf(await invokeFlowshipTool(windowTool as never, {}, tokenA!, { taskId: TASK_ID } as never)),
        "摘表之后旧 run 的电脑操作被放行",
      ).toBe(CALLER_MISMATCH_ERROR);
      expect(windowTool.handler).not.toHaveBeenCalled();

      // 新会话（属主一句话）起来、装好自己的 token
      const startB = runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主下一句" } });
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(2), { timeout: 4_000 });
      const tokenB = getExpectedCallerToken(TASK_ID);
      expect(tokenB, "前置：新会话装了自己的 token").toBeTruthy();
      expect(tokenB, "新会话的 token 不该与旧会话相同").not.toBe(tokenA);
      expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：属主这一轮没有标记").toBe(false);
      for (const [name, args] of [
        ["desktop_screenshot", {}],
        ["browser_evaluate", { expression: "1" }],
      ] as Array<[string, Record<string, unknown>]>) {
        const stale = fakeTool(name);
        expect(
          textOf(await invokeFlowshipTool(stale as never, args, tokenA!, { taskId: TASK_ID } as never)),
          `新会话起来之后旧 run 调 ${name} 被放行`,
        ).toBe(CALLER_MISMATCH_ERROR);
        expect(stale.handler).not.toHaveBeenCalled();
        const own = fakeTool(name);
        expect(textOf(await invokeFlowshipTool(own as never, args, tokenB!, { taskId: TASK_ID } as never)), `新会话调 ${name}`).toBe(
          `HANDLED:${name}`,
        );
      }
      agent.releaseRound(2);
      await startB;
    } finally {
      agent.releaseRound(1);
      agent.releaseRound(2);
      await startA;
    }
  });

  it("旧 run 被强清、新会话登记了外来内容标记之后，旧 run 才迟到收尾（consumeChatRun 的 finally）：新会话的标记还在，新会话自己收尾后照常清", async () => {
    const { agent, startA } = await startGatedRunWithForeignMark(["gated", "gated"]);
    try {
      forceClearChatRun(TASK_ID);
      // 新会话：外来内容做首包（runChatSession 在 agent.send 前一刻登记标记）
      const startB = runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: FOREIGN_TEXT },
        foreignContentTurn: true,
      });
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(2), { timeout: 4_000 });
      expect(agent.atSend, "前置：新会话首包送出时标记已就位（强清清掉的是旧会话那一个，新会话重新登记）").toEqual([false, true]);
      expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(true);

      // 旧 run 此刻才从强清里「醒来」收尾
      agent.releaseRound(1);
      await startA;
      await sleep(60);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "旧 run 迟到的收尾把新会话的外来内容标记按名清了：这一轮后半段无标记，限制危险工具 / 电脑操作的保护提前失效",
      ).toBe(true);

      agent.releaseRound(2);
      await startB;
      await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "新会话收尾后标记没人摘").toBe(false), {
        timeout: 4_000,
      });
    } finally {
      agent.releaseRound(1);
      agent.releaseRound(2);
    }
  });

  it("首包 send 挂起期间被强清、新会话登记标记之后旧启动才从迟到的 send 里醒来（runChatSession 的 finally）：新会话的标记还在", async () => {
    // 第一次 create（旧启动）= 首包 send 挂起的 agent；之后的 create（新会话）= 脚本化 agent
    const pendingA = makePendingSendAgent(AGENT_A);
    mockCreate.mockResolvedValueOnce({ agentId: AGENT_A, close: pendingA.close, send: pendingA.send });
    const agentB = makeScriptedAgent(["gated"]);
    const startA = runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "旧启动的首包（外来内容）" },
      foreignContentTurn: true,
    });
    try {
      await vi.waitFor(() => expect(pendingA.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：旧启动首包送出时标记已就位").toBe(true);

      forceClearChatRun(TASK_ID);
      expect(isGroupNonOwnerTurnActive(TASK_ID), "强清后旧启动登记的标记应已被摘表者清掉").toBe(false);

      const startB = runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: FOREIGN_TEXT },
        foreignContentTurn: true,
      });
      await vi.waitFor(() => expect(agentB.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      expect(agentB.atSend, "前置：新会话首包送出时标记已就位").toEqual([true]);

      // 旧启动此刻才从迟到的 send 里醒来：实例已被换，丢弃迟到 run、走 finally
      pendingA.resolveSend(pendingA.fakeRun);
      await startA;
      await sleep(60);
      expect(pendingA.fakeRun.cancel, "前置：旧启动应已丢弃迟到 run").toHaveBeenCalled();
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "旧启动的 finally 把新会话的外来内容标记按名清了（没走到 consume 的出口也不该碰别人的标记）",
      ).toBe(true);

      agentB.releaseRound(1);
      await startB;
      await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "新会话收尾后标记没人摘").toBe(false), {
        timeout: 4_000,
      });
    } finally {
      pendingA.resolveSend(pendingA.fakeRun);
      agentB.releaseRound(1);
      await startA;
    }
  });

  it("对照：懒重启的 cancel（reason=restart）由本实例自己收尾摘表：标记同样已清（摘表时清、收尾的 finally 不再碰，也没漏）", async () => {
    const { agent, startA } = await startGatedRunWithForeignMark(["gated"]);
    try {
      expect(cancelChatRun(TASK_ID, { reason: "restart" })).toBe(true);
      await startA;
      expect(isGroupNonOwnerTurnActive(TASK_ID), "懒重启取消后标记残留（会拒属主下一轮的电脑操作）").toBe(false);
    } finally {
      agent.releaseRound(1);
    }
  });

  it("对照：普通停止（不带 reason）的收尾仍由 finally 清标记——只有 restart 摘表改成了「摘表者清」", async () => {
    const { agent, startA } = await startGatedRunWithForeignMark(["gated"]);
    try {
      expect(cancelChatRun(TASK_ID)).toBe(true);
      await startA;
      expect(isGroupNonOwnerTurnActive(TASK_ID), "普通停止后标记残留").toBe(false);
    } finally {
      agent.releaseRound(1);
    }
  });

  it("对照：run 报错（不可重试，finalize error 由本实例自己摘表）收尾后标记同样由 finally 清——只有 restart 才改成了「摘表者清」", async () => {
    // 流吐一段后挂在 gate 上；登记标记后放行 → 抛确定性错误（invalid api key 不可重试，直接走 error 收尾、摘表原因是 error 而不是 restart）
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = {
      stream: vi.fn(async function* (): AsyncGenerator<unknown> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "答" }] } };
        await gate;
        throw new Error("invalid api key");
      }),
      wait: vi.fn().mockResolvedValue({ status: "error" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue({
      agentId: AGENT_A,
      close: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(run),
    });
    const startA = runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    try {
      await vi.waitFor(() => expect(run.stream).toHaveBeenCalled(), { timeout: 4_000 });
      await sleep(80);
      expect(beginForeignContentMidRun(TASK_ID), "前置：别人的内容送进这一轮、新建标记").toBeDefined();
      expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(true);

      release();
      await startA;
      expect(isGroupNonOwnerTurnActive(TASK_ID), "报错收尾后标记残留（会拒属主下一轮的电脑操作）").toBe(false);
    } finally {
      release();
      await startA;
    }
  });
});

// ───────────────────────── 第八轮评审 N2 / P3-2 / P3-3：判据从「被 restart 摘的」放宽成「表里是不是别的实例」 ─────────────────────────
//
// 背景：第七轮 N1 只让「被 restart 摘出表的旧 run」收尾时不再按名清标记，别的摘表路径照旧漏：
//   · N2（P2）自动重连的退避窗口里表是空的（坏实例先摘、过一会儿才 resume）。新会话趁虚而入并为外来内容登记了标记，
//     随后重连链醒来看见别人、让位 return true，旧 run 的 consumeChatRun 带着 replacedReason=reconnect 走到 finally 按名清——新会话的标记被清掉；
//   · P3-2 error 收尾摘表之后还要落清队通知（IO），同一类空窗；
//   · P3-3 runChatSession 的 lease 失效早退无条件按名清，不看表里是不是已经有别的会话在跑。
// 修法：三处按名清之前统一问「表里是不是别的实例在占」（isChatSlotHeldByOtherInstance）：是就不碰，表空 / 还是自己才清。
// 这里走真实的 chat-runner（真重连链、真 flush），假 SDK 用 gate 造时序；N2 用真计时器（重连退避是真的 2 s + 4 s，不用 fake timers）。

describe("别的实例占着表时，收尾 / 早退不按名清它的标记（第八轮评审 N2 / P3-2 / P3-3）", () => {
  /**
   * 第一个 create 出来的 agent（旧会话）：send 受理后 run 的流吐一段 → 挂 gate → release() 之后抛 errMessage。
   * 「fetch failed」是网络类（进自动重连）；「invalid api key」是确定性错误（直接走 error 收尾）。
   */
  const makeFailAfterGateAgent = (errMessage: string) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = {
      stream: vi.fn(async function* (): AsyncGenerator<unknown> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "断线 / 出错前的一段回复" }] } };
        await gate;
        throw new Error(errMessage);
      }),
      wait: vi.fn().mockResolvedValue({ status: "error" as const }),
      cancel: vi.fn().mockImplementation(async () => {
        release();
      }),
    };
    const send = vi.fn().mockResolvedValue(run);
    const agent = { agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send };
    return { agent, run, send, release: () => release() };
  };

  /** 已被 mock 掉的 console.<level> 目前为止所有调用的第一个参数（只取字符串） */
  const consoleLines = (level: "log" | "warn"): string[] =>
    vi
      .mocked(console[level])
      .mock.calls.map((c) => c[0])
      .filter((x): x is string => typeof x === "string");

  beforeEach(async () => {
    // 自动重连读服务端凭据（readServerChatCreds）：钉一份 config.json
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      path.join(DATA_DIR, "config.json"),
      JSON.stringify({ apiKey: "server-key", defaultModel: { id: "gpt-test", params: [] } }),
      "utf-8",
    );
  });

  it(
    "N2：自动重连退避窗口里（表空）新会话起来并登记了标记、重连链醒来让位——旧 run 的 finally 不得按名清掉它；新会话自己收尾后照常清",
    async () => {
      const a = makeFailAfterGateAgent("fetch failed");
      mockCreate.mockResolvedValueOnce(a.agent);
      const b = makeScriptedAgent(["gated"]); // 之后的 create（新会话）走它
      // 第 1 次重连：resume 抛网络类错误（非确定性、保留锚点）→ 进第 2 次退避（空窗），期间表里没有任何实例
      mockResume.mockRejectedValue(new Error("fetch failed"));
      const startA = runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
      let startB: Promise<unknown> | undefined;
      try {
        await vi.waitFor(() => expect(a.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        await sleep(80); // 让 consumeChatRun 接管这一轮、流挂在 gate 上
        a.release(); // 断流 → 自动重连
        // 第 1 次退避（2 s）醒来 → 摘 A → resume 失败 → 进第 2 次退避：此刻表是空的
        await vi.waitFor(() => expect(consoleLines("log").some((l) => l.includes("自动重连（第 2/5 次）"))).toBe(true), {
          timeout: 12_000,
          interval: 50,
        });
        expect(hasChatSession(TASK_ID), "前置：第 2 次退避窗口里表应是空的（坏实例已被重连链摘掉）").toBe(false);
        expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：新会话起来之前没有标记").toBe(false);

        // 空窗里用户（经所有者空 @ 引用别人）起了新会话：外来内容做首包，runChatSession 在 agent.send 前一刻登记标记
        startB = runChatSession({
          task: asTask(makeMeta(TASK_ID)),
          ...BOOT,
          firstMessage: { text: FOREIGN_TEXT },
          foreignContentTurn: true,
        });
        await vi.waitFor(() => expect(b.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        expect(b.atSend, "前置：新会话首包送出时标记已就位").toEqual([true]);

        // 第 2 次退避醒来：表里是新会话 → 让位 return true → 旧 run 的 consumeChatRun 走 finally（replacedReason=reconnect）
        await startA;
        expect(
          consoleLines("warn").some((l) => l.includes("自动重连让位：表内已是新会话实例")),
          "前置：重连链应已因表里是新会话而让位（没走到这条说明用例没造出 N2 的时序）",
        ).toBe(true);
        await sleep(60);
        expect(
          isGroupNonOwnerTurnActive(TASK_ID),
          "重连让位后旧 run 的 finally 把新会话的外来内容标记按名清了：新一轮后半段无标记，限制危险工具 / 电脑操作的保护提前失效",
        ).toBe(true);

        b.releaseRound(1);
        await startB;
        await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "新会话收尾后标记没人摘").toBe(false), {
          timeout: 4_000,
        });
      } finally {
        a.release();
        b.releaseRound(1);
        await startA;
        await startB;
      }
    },
    30_000,
  );

  it("P3-2：error 收尾摘表之后、清队通知落盘之前的空窗里新会话起来并登记了标记——旧 run 的 finally 不得按名清掉它", async () => {
    const a = makeFailAfterGateAgent("invalid api key"); // 确定性错误：不重连、直接走 error 收尾（摘表原因 error，不是 restart）
    mockCreate.mockResolvedValueOnce(a.agent);
    const b = makeScriptedAgent(["gated"]);
    let startB: Promise<unknown> | undefined;
    let tableEmptyInWindow: boolean | undefined;
    // 插桩：error 收尾 closeChatSession 之后、noticeQueuedItemsDropped 之前——这段现实里是落盘 IO，表是空的，新会话可以在这里起来
    setFailpoint("chat.finalize.error.afterClose", async () => {
      tableEmptyInWindow = !hasChatSession(TASK_ID);
      startB = runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: FOREIGN_TEXT },
        foreignContentTurn: true,
      });
      await vi.waitFor(() => expect(b.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    });
    const startA = runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    try {
      await vi.waitFor(() => expect(a.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      await sleep(80);
      // 队里排一条：error 收尾要清队并落「N 条排队消息未送达」通知——这就是现实里的那段 IO
      enqueueQueued(false);
      expect(getChatQueueCount(TASK_ID), "前置：队里有一条排队消息").toBe(1);
      a.release();
      await startA;

      expect(tableEmptyInWindow, "前置：插桩点应被走到、且那一刻表是空的（没走到 = 用例没造出这个空窗）").toBe(true);
      expect(b.atSend, "前置：新会话首包送出时标记已就位").toEqual([true]);
      await sleep(60);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "error 收尾空窗里新会话登记的标记被旧 run 的 finally 按名清了（摘表原因是 error、replacedReason 不是 restart，第七轮的判据拦不住）",
      ).toBe(true);

      b.releaseRound(1);
      await startB;
      await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "新会话收尾后标记没人摘").toBe(false), {
        timeout: 4_000,
      });
    } finally {
      a.release();
      b.releaseRound(1);
      await startA;
      await startB;
    }
  });

  it("P3-3：lease 失效早退时表里已有别的会话在跑并登记了标记——不得按名清它（早退没有自己的会话，表里有谁都是别人）", async () => {
    const token = tryReserveChatStart(TASK_ID);
    expect(token).not.toBeNull();
    cancelChatStart(TASK_ID); // 旧 token 作废（期间有人 stop 过）
    const b = makeScriptedAgent(["gated"]);
    // 期间新会话起来了：外来内容做首包、标记已就位
    const startB = runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: FOREIGN_TEXT },
      foreignContentTurn: true,
    });
    try {
      await vi.waitFor(() => expect(b.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      expect(b.atSend, "前置：新会话首包送出时标记已就位").toEqual([true]);

      // 迟到的旧调用（带着作废的 token）才走到 runChatSession 入口
      const result = await runChatSession({
        task: asTask(makeMeta(TASK_ID)),
        ...BOOT,
        firstMessage: { text: "迟到的调用" },
        startToken: token!,
        foreignContentTurn: true,
      });
      expect(result).toBe("lease_cancelled");
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "lease 失效早退把别的会话登记的外来内容标记按名清了：那一轮后半段无标记，保护提前失效",
      ).toBe(true);

      b.releaseRound(1);
      await startB;
      await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "占位的会话收尾后标记没人摘").toBe(false), {
        timeout: 4_000,
      });
    } finally {
      b.releaseRound(1);
      await startB;
    }
  });

  it("对照：lease 失效早退、表里没有任何会话 → 调用方补登的标记照旧被清（不残留；与上面「表里有别人」是同一处的两个分支）", async () => {
    const token = tryReserveChatStart(TASK_ID);
    cancelChatStart(TASK_ID);
    expect(beginForeignContentMidRun(TASK_ID)).toBeDefined(); // 调用方在送达前补登
    expect(hasChatSession(TASK_ID)).toBe(false);
    const result = await runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "别人写的内容" },
      startToken: token!,
    });
    expect(result).toBe("lease_cancelled");
    expect(isGroupNonOwnerTurnActive(TASK_ID), "表里没人时早退该清掉调用方补登的标记").toBe(false);
  });
});

// ───────────────────────── 第八轮评审 P3-5：consumeChatRun 入口取的 rec 不保证是本实例 ─────────────────────────
//
// consumeChatRun 入口的 `rec = runningChats.get(task.id)` 是「此刻表里的那个」。两处调用方在入口前有让出点、又没复查实例：
//   (a) sendChatMessage 的 setTaskRunStatus 失败分支：直接 consumeChatRunDetached 后 return "sent"（成功分支有复查、失败分支没有）；
//   (b) 重连接力（runReconnectAttempt）：send 受理后复查过一次，之后还有「闭合未完成工具 / 落重连成功事件」两个 await 才进 consume。
// 期间 stop / forceClear + 新会话都可以到达：run 被接到别人的记录上（改写它的 currentRun / cancel），或表空时无主地一路消费到底。
// 这里不用固定 sleep：(a) 用 task-fs 的 setTaskRunStatus spy 在那个 await 里强清 + 起新会话；(b) 用事件流订阅在「重连成功」事件 publish 的当下同步 stop。
describe("consumeChatRun 的入口复查：让出点期间实例被停止 / 替换，迟到 run 不再被消费（第八轮评审 P3-5）", () => {
  beforeEach(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      path.join(DATA_DIR, "config.json"),
      JSON.stringify({ apiKey: "server-key", defaultModel: { id: "gpt-test", params: [] } }),
      "utf-8",
    );
  });

  /** 第 n 次 agent.send 返回的那个 run（vi.fn 记录的 promise 结果） */
  const runOfSend = async (send: ReturnType<typeof vi.fn>, n: number) => {
    const p = send.mock.results[n - 1]?.value as Promise<{
      stream: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
    }>;
    expect(p, `第 ${n} 次 send 应已被调用`).toBeDefined();
    return await p;
  };

  it("(a) sendChatMessage 置 running 失败、且这个 await 期间实例被强清换成新会话：迟到 run 被丢弃（返回 owner_invalid），不接到新会话的记录上消费", async () => {
    const agent = makeScriptedAgent(["finished", "finished", "gated"]); // #1 旧会话首轮 / #2 旧会话追问（迟到 run）/ #3 新会话首轮
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(hasChatSession(TASK_ID), "前置：首轮跑完后旧会话应保留（idle）").toBe(true);

    const taskFs = await import("@/lib/server/task-fs");
    let startB: Promise<unknown> | undefined;
    const spy = vi.spyOn(taskFs, "setTaskRunStatus").mockImplementationOnce(async () => {
      // 追问的 agent.send 已受理（#2）、正在置 running：这个 await 期间强清旧会话、新会话起来并在跑
      forceClearChatRun(TASK_ID);
      startB = runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "新会话首句" } });
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(3), { timeout: 4_000 });
      await sleep(80); // 让新会话的 consumeChatRun 接管（currentRun 已就位）
      throw new Error("status boom（测试注入）");
    });
    try {
      const result = await sendChatMessage(asTask(makeMeta(TASK_ID)), "属主第二句");
      expect(
        result,
        "置 running 失败分支没复查实例：迟到 run 被当成已送达（sent）并接到新会话的记录上去消费",
      ).toBe("owner_invalid");
      const lateRun = await runOfSend(agent.send, 2);
      await sleep(60);
      expect(lateRun.stream, "迟到 run 被消费了（它被接到了别人的记录上 / 无主消费）").not.toHaveBeenCalled();
      expect(lateRun.cancel, "迟到 run 应被丢弃（cancel）").toHaveBeenCalled();
      // 新会话没被牵连：还在表里、它自己的 run 还在跑，放行后正常收尾
      expect(hasChatSession(TASK_ID), "新会话应仍在").toBe(true);
      agent.releaseRound(3);
      await startB;
    } finally {
      spy.mockRestore();
      agent.releaseRound(3);
      await startB;
    }
  });

  it("(a) 对照：置 running 失败但实例仍是本实例 → 照旧返回 sent、run 被正常消费（失败分支改成走复查，行为没变）", async () => {
    const agent = makeScriptedAgent(["finished", "finished"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    const taskFs = await import("@/lib/server/task-fs");
    const spy = vi.spyOn(taskFs, "setTaskRunStatus").mockRejectedValueOnce(new Error("status boom（测试注入）"));
    try {
      expect(await sendChatMessage(asTask(makeMeta(TASK_ID)), "属主第二句")).toBe("sent");
      const run2 = await runOfSend(agent.send, 2);
      await vi.waitFor(() => expect(run2.stream, "agent 已受理的 run 应被正常消费").toHaveBeenCalled(), { timeout: 4_000 });
    } finally {
      spy.mockRestore();
    }
  });

  it(
    "(b) 重连接力：「重连成功」事件落盘之后、consumeChatRun 入口之前 stop 到达——迟到 run 被丢弃，不无主消费",
    async () => {
      const failing = (() => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const run = {
          stream: vi.fn(async function* (): AsyncGenerator<unknown> {
            yield { type: "assistant", message: { content: [{ type: "text", text: "断线前的一段回复" }] } };
            await gate;
            throw new Error("fetch failed");
          }),
          wait: vi.fn().mockResolvedValue({ status: "error" as const }),
          cancel: vi.fn().mockImplementation(async () => {
            release();
          }),
        };
        return { agent: { agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(run) }, release };
      })();
      mockCreate.mockResolvedValueOnce(failing.agent);
      // 重连：resume 成功 → 重连实例的 reconnect prompt send 受理一个 run
      const rRun = {
        stream: vi.fn(async function* (): AsyncGenerator<unknown> {
          yield { type: "assistant", message: { content: [{ type: "text", text: "重连后的回复" }] } };
        }),
        wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      const rSend = vi.fn().mockResolvedValue(rRun);
      mockResume.mockResolvedValueOnce({ agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send: rSend });

      // 「重连成功」info 事件 publish 的当下同步 stop：此刻 await writeOwnedEventAndPublish 还没返回、consumeChatRun 还没进
      const { subscribeTaskStream } = await import("@/lib/server/task-stream");
      let stopFiredAt: number | undefined;
      const unsub = subscribeTaskStream(TASK_ID, (ev) => {
        if (stopFiredAt !== undefined) return;
        if (ev.kind === "event" && ev.event.kind === "info" && ev.event.meta?.kind === "reconnected") {
          stopFiredAt = Date.now();
          cancelChatRun(TASK_ID);
        }
      });
      const startA = runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
      try {
        await vi.waitFor(() => expect(failing.agent.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        await sleep(80);
        failing.release(); // 断流 → 自动重连（2 s 退避后 resume + send 受理）
        await startA;
        expect(stopFiredAt, "前置：应走到「重连成功」事件并在 publish 当下 stop（没走到 = 用例没造出这个时序）").toBeDefined();
        expect(rSend, "前置：重连实例的 reconnect prompt 应已被 send").toHaveBeenCalledTimes(1);
        await sleep(60);
        expect(rRun.stream, "stop 落在「重连成功」事件落盘期间：迟到 run 被无主消费了（consumeChatRun 入口没复查实例）").not.toHaveBeenCalled();
        expect(rRun.cancel, "迟到 run 应被丢弃（cancel）").toHaveBeenCalled();
        expect(hasChatSession(TASK_ID), "stop 后不应留会话").toBe(false);
      } finally {
        unsub();
        failing.release();
        await startA;
      }
    },
    30_000,
  );
});

// ───────────────────────── 第八轮评审 P3-1：非属主答 ask → chat 会话，标记紧贴 agent.send 登记 ─────────────────────────
//
// 背景：ask-inject 以前在入口（fulfillAskWait / 唤醒 / resume 之前）就为别人的答案登记标记，再调 deliverChatAskReply。
// 从入口到 agent.send 之间隔着 fulfillAskWait（最长 15 s）、resume（MCP 探活 + Agent.resume）、置 running 等一串 await，
// 上一个实例的收尾（按名清）或懒重启摘表者的清除插进来，早登记的标记就没了——答案在无标记状态下送达（安全边界）。
// 修后 deliverChatAskReply 带 foreignContentTurn，由 sendChatMessage / runChatSession 在 agent.send 前一刻（同步）登记。
// 这里走真实的 injectPendingAskText → deliverChatAskReply → sendChatMessage / runChatSession；
// 用「窗口里有人按名清」的敌意时序（Agent.resume / Agent.create 的 mock 里调 endMidRunForeignContent）证明登记确实在窗口之后。
describe("非属主答 ask 送 chat：真链路 injectPendingAskText → deliverChatAskReply（第八轮评审 P3-1）", () => {
  const ASK_ID = "ask-p31";
  const registerAsk = (): void => {
    registerPendingAsk(TASK_ID, {
      askId: ASK_ID,
      questions: [{ id: "q1", question: "要不要继续", allowText: true }],
    });
  };
  const answer = (opts: NonNullable<Parameters<typeof injectPendingAskText>[4]>) =>
    injectPendingAskText(TASK_ID, "可以，顺便截个屏", BOOT, undefined, opts);
  const makeResumeHandle = (send: unknown) => ({
    agentId: AGENT_A,
    close: vi.fn().mockResolvedValue(undefined),
    send,
  });

  beforeEach(() => {
    __resetPendingAskStateForTest();
  });
  afterEach(() => {
    __resetPendingAskStateForTest();
  });

  it("存活会话：答案经 sendChatMessage 送达——agent.send 那一刻标记已就位（属主自己的第一轮没有）；这一轮跑完被清", async () => {
    const agent = makeScriptedAgent(["finished", "finished"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(hasChatSession(TASK_ID), "前置：第一轮跑完后会话应保留").toBe(true);
    registerAsk();

    const r = await answer({ answeredBy: "李四", foreignContent: true });

    expect(r).toEqual({ ok: true });
    expect(agent.atSend, "答案送达那一刻没有标记——别人写的答案在无标记状态下送给了 agent").toEqual([false, true]);
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "跑完标记没人摘").toBe(false), { timeout: 4_000 });
  });

  it("resume 续接：入口到 agent.send 之间（Agent.resume 期间）有人按名清了标记——send 那一刻标记仍就位（登记紧贴 agent.send，不是入口早登记）", async () => {
    await writeMeta({ ...makeMeta(TASK_ID), sessionAgentId: AGENT_A } as TaskMetaV06);
    const agent = makeScriptedAgent(["finished"]);
    let resumeCalls = 0;
    mockResume.mockImplementation(async () => {
      resumeCalls += 1;
      // 旧实例迟到的收尾（按名清）恰好落在 resume 窗口里；resume 返回前再清一次（两种落点都覆盖）
      endMidRunForeignContent(TASK_ID);
      await sleep(30);
      endMidRunForeignContent(TASK_ID);
      return makeResumeHandle(agent.send);
    });
    registerAsk();

    const r = await answer({ answeredBy: "李四", foreignContent: true });

    expect(r).toEqual({ ok: true });
    expect(resumeCalls, "前置：应走 resume 续接路径").toBe(1);
    expect(agent.atSend, "resume 窗口里的按名清把标记清掉了，答案在无标记状态下送达（登记没有紧贴 agent.send）").toEqual([true]);
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "跑完标记没人摘").toBe(false), { timeout: 4_000 });
  });

  it("起新会话（没有 sessionAgentId）：Agent.create 期间有人按名清了标记——首包 agent.send 那一刻标记仍就位；跑完被清", async () => {
    const agent = makeScriptedAgent(["finished"]);
    mockCreate.mockImplementationOnce(async () => {
      endMidRunForeignContent(TASK_ID);
      await sleep(30);
      endMidRunForeignContent(TASK_ID);
      return makeResumeHandle(agent.send);
    });
    registerAsk();

    const r = await answer({ answeredBy: "李四", foreignContent: true });

    expect(r).toEqual({ ok: true });
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    expect(agent.atSend, "起新会话窗口里的按名清把标记清掉了，首包答案在无标记状态下送达").toEqual([true]);
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "跑完标记没人摘").toBe(false), { timeout: 4_000 });
  });

  it("答题人是所有者本人、但答案里引用了别人的消息（ownerQuotedOthers）：同样紧贴 agent.send 登记", async () => {
    const agent = makeScriptedAgent(["finished", "finished"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    registerAsk();

    const r = await answer({ ownerQuotedOthers: true });

    expect(r).toEqual({ ok: true });
    expect(agent.atSend).toEqual([false, true]);
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false), { timeout: 4_000 });
  });

  it("对照：所有者自己答（没传 foreignContent）：全程没有标记", async () => {
    const agent = makeScriptedAgent(["finished", "finished"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    registerAsk();

    const r = await answer({});

    expect(r).toEqual({ ok: true });
    expect(agent.atSend).toEqual([false, false]);
    expect(isGroupNonOwnerTurnActive(TASK_ID)).toBe(false);
  });

  it("会话在忙（上一轮还在跑）：答案没送达 → deliver_failed、不残留标记，属主这一轮不受限；问题放回去等重试", async () => {
    const agent = makeScriptedAgent(["finished", "gated"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(await sendChatMessage(asTask(makeMeta(TASK_ID)), "属主第二句（挂着）")).toBe("sent");
    expect(agent.atSend, "前置：属主自己的两轮都没有标记").toEqual([false, false]);
    registerAsk();

    const r = await answer({ answeredBy: "李四", foreignContent: true });

    expect(r).toMatchObject({ ok: false, reason: "deliver_failed" });
    expect(agent.send, "忙时不该有第三次 send").toHaveBeenCalledTimes(2);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "没送达却留着标记（会拒属主这一轮的电脑操作）").toBe(false);
    agent.releaseRound(2);
  });

  it("送达时 agent.send 抛错：标记回滚、不残留（resume 路径抛错后落到起新会话，首包也抛错——两次都登记过、两次都回滚）", async () => {
    await writeMeta({ ...makeMeta(TASK_ID), sessionAgentId: AGENT_A } as TaskMetaV06);
    const agent = makeScriptedAgent(["throw", "throw"]);
    mockResume.mockResolvedValue(makeResumeHandle(agent.send));
    registerAsk();

    const r = await answer({ answeredBy: "李四", foreignContent: true });

    expect(r).toEqual({ ok: true }); // 起新会话是 fire-and-forget：受理即返回，首包失败走 runChatSession 自己的出口
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(2), { timeout: 6_000 });
    expect(agent.atSend, "两次 send 都应带着标记（登记紧贴 send）").toEqual([true, true]);
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "send 抛错后标记残留").toBe(false), { timeout: 6_000 });
  });
});

// ───────────────────────── 第十轮评审 N1：ask-inject 的早登记 token 被别路沿用后，登记者的收回 / 没送达回滚不能清掉它 ─────────────────────────
//
// 背景：ask-inject 对别人的答案在入口登记标记（拿到 token），因为答案可能被 ask-wait 的 curl 带进**正在跑的那一轮**，标记必须先于写入就位；
// 之后 `await fulfillAskWait`——槽上没有 curl（模型漏跑 curl / curl 已断）时答案压在槽里等 curl，最长 ASK_WAIT_ATTACH_MS（15 秒）。
// 窗口里别路的外来内容（所有者空 @ 引用别人）到了：标记已存在，beginForeignContentMidRun 返回 undefined、沿用它（没有自己的 token），
// 会话 idle 所以直送成功，那一轮**只靠这个标记**限制 desktop_* / 写所有者备注 / 建定时。窗口到点 fulfillAskWait 回 false，
// ask-inject 以前拿 token 收回（chat 非 curl 路径）、随后 deliverChatAskReply 因会话在忙回 false 又按 token 回滚——两次都把标记清了，
// 那一轮后半程不再受限（安全边界，与 N2 同级）。修后沿用过的标记，登记者的回滚（rollbackForeignContentMidRun）让位，留给沿用者那一轮的收尾按名清。
//
// 真 injectPendingAskText + 真 fulfillAskWait（ask-wait 槽无 waiter，窗口缩到 150ms）+ 真 sendChatMessage / consumeChatRun；假 SDK。
describe("ask 答案在 ask-wait 窗口里、别路外来内容沿用了它的标记（第十轮评审 N1）", () => {
  const ASK_ID = "ask-n1";
  const registerAsk = (): void => {
    registerPendingAsk(TASK_ID, {
      askId: ASK_ID,
      questions: [{ id: "q1", question: "要不要继续", allowText: true }],
    });
  };

  beforeEach(() => {
    __resetPendingAskStateForTest();
    resetAskWaitForTest();
    askWaitTest.attachWaitMs = 150;
  });
  afterEach(() => {
    askWaitTest.attachWaitMs = undefined;
    resetAskWaitForTest();
    __resetPendingAskStateForTest();
  });

  it("窗口到点：收回 / 没送达回滚不清别路沿用的标记；别路那一轮跑着标记一直在，跑完才被清（会话 idle、槽无 waiter）", async () => {
    const agent = makeScriptedAgent(["finished", "gated"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(hasChatSession(TASK_ID), "前置：第一轮跑完后会话应保留").toBe(true);
    registerAsk();
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token: "tok-n1" });

    // A：群成员答了这个 ask——槽上没有 curl，答案压在槽里等它（窗口里标记已就位，curl 万一挂上能带着保护读到答案）
    const pA = injectPendingAskText(TASK_ID, "可以，顺便截个屏", BOOT, undefined, { answeredBy: "李四", foreignContent: true });
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：A 已在等 curl 的窗口里登记了标记").toBe(true));

    // B：窗口里所有者空 @ 引用别人——标记已存在（沿用，没有自己的 token）、会话 idle，直送成功
    expect(
      await sendChatMessage(asTask(makeMeta(TASK_ID)), FOREIGN_TEXT, undefined, undefined, { foreignContentTurn: true }),
      "前置：B 直送应成功",
    ).toBe("sent");
    expect(agent.atSend, "前置：B 送达那一刻标记在（沿用 A 的）").toEqual([false, true]);

    // 窗口到点：fulfillAskWait 回 false → ask-inject 收回早登记 → deliverChatAskReply 见会话在忙回 false → 没送达回滚
    const rA = await pA;
    expect(rA, "A 的答案没送达（B 那一轮占着会话）").toMatchObject({ ok: false, reason: "deliver_failed" });
    expect(agent.send, "A 的答案不该有第三次 send").toHaveBeenCalledTimes(2);
    expect(
      isGroupNonOwnerTurnActive(TASK_ID),
      "A 的收回 / 没送达回滚把 B 这一轮正靠着的标记清了：B 这一轮后半程 desktop_* / 写所有者备注 / 建定时不再被拒",
    ).toBe(true);

    // B 那一轮跑完：它的收尾按名清掉标记（沿用者负责收口）
    agent.releaseRound(2);
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "B 这一轮跑完标记没人摘").toBe(false), { timeout: 4_000 });
  });

  it("对照：窗口里没有别路沿用——窗口到点、没送达，照常回滚干净（不残留标记挡属主下一轮）", async () => {
    const agent = makeScriptedAgent(["finished", "gated"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    // 属主自己这一轮在跑（会话忙）：答案送不进去
    expect(await sendChatMessage(asTask(makeMeta(TASK_ID)), "属主第二句（挂着）")).toBe("sent");
    registerAsk();
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token: "tok-n1b" });

    const pA = injectPendingAskText(TASK_ID, "可以", BOOT, undefined, { answeredBy: "李四", foreignContent: true });
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：A 已在窗口里登记了标记").toBe(true));
    const rA = await pA;

    expect(rA).toMatchObject({ ok: false, reason: "deliver_failed" });
    expect(isGroupNonOwnerTurnActive(TASK_ID), "没人沿用时没送达的答案不该留着标记（会拒属主这一轮的电脑操作）").toBe(false);
    agent.releaseRound(2);
  });

  // 第十一轮评审 P3-1：让位的前提是沿用者那一轮在跑（会为标记收尾）。沿用者自己没送达（agent.send 抛错、会话被关）时没有 run，
  // 标记成了没人持有的孤儿——chat 没有「属主 send 起点清」，只剩惰性 TTL，属主下一整轮的 desktop_* / 写所有者备注 / 建定时都被多限制。
  it("沿用者没送达（直送 agent.send 抛错、会话被关）：窗口到点登记者的回滚照清——不留没人收尾的孤儿标记（第十一轮评审 P3-1）", async () => {
    const agent = makeScriptedAgent(["finished", "throw"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(hasChatSession(TASK_ID), "前置：第一轮跑完后会话应保留").toBe(true);
    registerAsk();
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token: "tok-p31" });

    // A：群成员答了这个 ask——槽上没有 curl，答案压在槽里等窗口；不带 bootArgs，窗口到点后它自己也没法唤醒 / 新起会话（deliverChatAskReply 回 false，不会另外登记）
    const pA = injectPendingAskText(TASK_ID, "可以，顺便截个屏", undefined, undefined, { answeredBy: "李四", foreignContent: true });
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：A 已在窗口里登记了标记").toBe(true));

    // B：窗口里所有者空 @ 引用别人——沿用 A 的标记（没有自己的 token），直送时 agent.send 抛错、会话被关
    expect(
      await sendChatMessage(asTask(makeMeta(TASK_ID)), FOREIGN_TEXT, undefined, undefined, { foreignContentTurn: true }),
      "前置：B 的直送应失败",
    ).toBe("send_failed");
    expect(agent.atSend, "前置：B 送达尝试那一刻标记在（沿用 A 的）").toEqual([false, true]);
    expect(hasChatSession(TASK_ID), "前置：send 失败后会话已被关、没有 run 在跑").toBe(false);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：沿用者没有 token，没送达它也清不了——标记还挂着").toBe(true);

    // 窗口到点：fulfillAskWait 回 false → ask-inject 收回早登记 → deliverChatAskReply 无会话也无凭据回 false → 没送达回滚
    const rA = await pA;
    expect(rA, "A 的答案没送达（没有会话、也没凭据起新的）").toMatchObject({ ok: false, reason: "deliver_failed" });
    expect(
      isGroupNonOwnerTurnActive(TASK_ID),
      "沿用者没送达、没有 run 在跑：登记者的回滚让位后没人再收尾这个标记，属主下一整轮的 desktop_* / 写所有者备注 / 建定时被白白限制",
    ).toBe(false);
  });

  // 第十二轮评审 P2-1（第十一轮 P3-1 的修法引入的回归）：让位判据问「此刻有没有 run 在跑」，chat 探针原先只看 runningChats 里的 runActive。
  // 可自动重连链的退避窗口里表是空的（坏实例先摘、过一会儿才 resume；resume 失败再退避，空窗可以连着好几次）——沿用者那一轮其实还在，
  // 重连接上之后会接着跑，探针却答「没在跑」：登记者的窗口恰好在空窗里到点 → 回滚照清 → 重连接上之后那一轮无标记地继续
  // （desktop_* / 写所有者备注 / 建定时 / 自动推进不再被拒；重连的 prompt 不会重新登记标记）。
  // 修后 chat 探针再算上「这个 task 有重连链在飞」（getReconnectStops().has(taskId)：tryChatAutoReconnect 注册、finally 清）。
  // 这里让 A 的窗口在重连链的某个精确时刻用 cancelAskWait 收掉——和窗口自然到点走的是同一条 fulfillAskWait → false 路径，只是时刻精确。
  //
  // 第十三轮评审 P3-3 / P3-4：原先只测了「resume 回调里」这一个时刻（表空、重连链在飞）。重连链里还有另外两个时刻靠探针另一半（runActive）或另一前提撑着：
  //   · 首次退避窗口：坏实例还在表里（退避醒来才摘）、停止闭包已登记——探针两半都为真；
  //   · tryChatAutoReconnect 里 set 之前那个 `await getTask`：停止闭包还没登记，全靠「陈旧记录仍是 runActive=true」——
  //     chat-runner 里没有任何东西钉住这个前提（原先只有一条源码顺序断言，还因为 runReconnectAttempt 物理上排在 tryChatAutoReconnect 之后而恒成立），这里用行为钉；
  //   · resume 失败再退避的递归、用户在退避里点停止、链结束后停止闭包表不残留。
  // 每个时刻共用同一套造时序（makeScriptedAgent 的 "disconnect" 轮 + 真 ask-inject / sendChatMessage + 真重连链，退避是真计时器）。

  /** 重连链的停止闭包表（chat-runner 的 getReconnectStops，globalThis 单例）里此刻有没有这个 task 的条目 */
  const reconnectStopsHas = (taskId: string): boolean =>
    ((globalThis as unknown as Record<string, Map<string, unknown> | undefined>)["__flowshipChatReconnectStopsV1__"])?.has(taskId) ?? false;

  /**
   * 造「A 的窗口在等 curl、B 沿用 A 的标记直送、B 那一轮（第 2 轮）断流进自动重连」。
   * closeWindow()：A 的窗口到点（cancelAskWait → ask-inject 收回 / 没送达回滚），并记下那一刻表是否空、前后标记是否在。
   */
  const setupForeignRoundThenDisconnect = async () => {
    // 自动重连读服务端凭据（readServerChatCreds）：钉一份 config.json；锚点 sessionAgentId 供 resume
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      path.join(DATA_DIR, "config.json"),
      JSON.stringify({ apiKey: "server-key", defaultModel: { id: "gpt-test", params: [] } }),
      "utf-8",
    );
    await writeMeta({ ...makeMeta(TASK_ID), sessionAgentId: AGENT_A } as TaskMetaV06);
    askWaitTest.attachWaitMs = 60_000; // 窗口不靠超时结束：由 closeWindow 在重连链的某个精确时刻用 cancelAskWait 收窗

    const agent = makeScriptedAgent(["finished", "disconnect", "gated"]);
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(hasChatSession(TASK_ID), "前置：第一轮跑完后会话应保留").toBe(true);
    registerAsk();
    openAskWait({ taskId: TASK_ID, askId: ASK_ID, token: "tok-p21" });

    // A：群成员答了这个 ask——槽上没有 curl，答案压在槽里等窗口；不带 bootArgs，窗口到点后它自己也没法唤醒 / 新起会话（deliverChatAskReply 回 false，不会另外登记）
    const pA = injectPendingAskText(TASK_ID, "可以，顺便截个屏", undefined, undefined, { answeredBy: "李四", foreignContent: true });
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：A 已在窗口里登记了标记").toBe(true));

    // B：窗口里所有者空 @ 引用别人——沿用 A 的标记（没有自己的 token），会话 idle、直送成功，这一轮（第 2 轮）只靠这个标记受限
    expect(
      await sendChatMessage(asTask(makeMeta(TASK_ID)), FOREIGN_TEXT, undefined, undefined, { foreignContentTurn: true }),
      "前置：B 直送应成功",
    ).toBe("sent");
    expect(agent.atSend, "前置：B 送达那一刻标记在（沿用 A 的）").toEqual([false, true]);

    const inWindow: { tableEmpty?: boolean; markerBefore?: boolean; rA?: unknown; markerAfter?: boolean } = {};
    const closeWindow = async (): Promise<void> => {
      inWindow.tableEmpty = !hasChatSession(TASK_ID);
      inWindow.markerBefore = isGroupNonOwnerTurnActive(TASK_ID);
      cancelAskWait(TASK_ID, "test：窗口到点");
      inWindow.rA = await pA;
      inWindow.markerAfter = isGroupNonOwnerTurnActive(TASK_ID);
    };
    await sleep(80); // 让 consumeChatRun 接管第 2 轮、流挂在 gate 上
    return { agent, pA, inWindow, closeWindow };
  };

  /** 窗口收掉之后的共同断言：A 没送达、标记没被它的回滚清掉；重连接上后这一轮受限直到收尾；链结束后停止闭包表不残留 */
  const expectMarkerSurvivesAndChainEnds = async (
    agent: ReturnType<typeof makeScriptedAgent>,
    inWindow: { markerBefore?: boolean; rA?: unknown; markerAfter?: boolean },
    why: string,
  ): Promise<void> => {
    expect(inWindow.markerBefore, "前置：A 的窗口到点之前标记还在").toBe(true);
    expect(inWindow.rA, "A 的答案没送达（窗口里没有会话可用、也没凭据起新的）").toMatchObject({ ok: false, reason: "deliver_failed" });
    expect(
      inWindow.markerAfter,
      `${why}：A 的回滚把标记清了——重连接上之后这一轮无标记地继续（desktop_* / 写所有者备注 / 建定时 / 自动推进不再被拒）`,
    ).toBe(true);

    // 重连接上：reconnect prompt 送达那一刻标记在（第 3 次 send），继续跑期间一直在
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(3), { timeout: 12_000 });
    expect(agent.atSend, "重连接上后的这一轮送达时没有标记").toEqual([false, true, true]);
    await sleep(150);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "重连接上后的这一轮还在跑，标记不该已经没了").toBe(true);

    // 那一轮跑完：它的收尾按名清掉标记（旧 run 的 finally 见表里是新实例、不碰）；链结束，停止闭包表里没有这个 task（不泄漏）
    agent.releaseRound(3);
    await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "重连接上的那一轮收尾后标记没人摘").toBe(false), { timeout: 4_000 });
    await vi.waitFor(() => expect(reconnectStopsHas(TASK_ID), "链结束后重连停止闭包表里还留着这个 task（泄漏：之后探针恒答「在跑」，标记只能等 TTL）").toBe(false), { timeout: 4_000 });
  };

  it("沿用者那一轮断流进自动重连、登记者的窗口恰好在表空的空窗里到点（resume 回调里）：回滚仍让位——重连接上后那一轮继续受限；那一轮收尾后标记被清（第十二轮评审 P2-1）", async () => {
    const { agent, inWindow, closeWindow } = await setupForeignRoundThenDisconnect();
    // 重连接上用的会话。resume 回调就在「表空、重连链在飞」的窗口里被调用：在这里把 A 的窗口收掉，让 A 的回滚正好落进空窗
    mockResume.mockImplementation(async () => {
      await closeWindow();
      return { agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send: agent.send };
    });

    agent.releaseRound(2); // 断流 → 自动重连：2 秒退避 → 摘坏实例（表空）→ readServerChatCreds → resume
    try {
      await vi.waitFor(() => expect(inWindow.markerAfter, "resume 回调没被调用：重连链没走到空窗").toBeDefined(), { timeout: 12_000, interval: 50 });
      expect(inWindow.tableEmpty, "前置：resume 被调用时表应是空的（坏实例已被重连链摘掉）").toBe(true);
      await expectMarkerSurvivesAndChainEnds(
        agent,
        inWindow,
        "重连空窗里：chat 探针只看 runActive，空窗里表是空的、答「没在跑」",
      );
    } finally {
      agent.releaseRound(2);
      agent.releaseRound(3);
    }
  }, 30_000);

  it("同上，窗口在首次退避里到点（坏实例还在表里、停止闭包已登记）：回滚让位，重连接上后那一轮继续受限（第十三轮评审 P3-4）", async () => {
    const { agent, inWindow, closeWindow } = await setupForeignRoundThenDisconnect();
    mockResume.mockImplementation(async () => ({ agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send: agent.send }));

    agent.releaseRound(2); // 断流 → 自动重连
    try {
      // 停止闭包已登记 = 已过 tryChatAutoReconnect 的 getTask、进了 runReconnectAttempt 的首次退避（2 秒）；此刻坏实例还在表里（退避醒来才摘）
      await vi.waitFor(() => expect(reconnectStopsHas(TASK_ID), "重连链没走到首次退避").toBe(true), { timeout: 4_000, interval: 10 });
      expect(mockResume, "前置：还在首次退避里，没走到 resume").not.toHaveBeenCalled();
      await closeWindow();
      expect(inWindow.tableEmpty, "前置：首次退避窗口里坏实例还在表里（退避醒来才摘）").toBe(false);
      await expectMarkerSurvivesAndChainEnds(agent, inWindow, "首次退避窗口里");
    } finally {
      agent.releaseRound(2);
      agent.releaseRound(3);
    }
  }, 30_000);

  it("同上，窗口在 tryChatAutoReconnect 里 set 之前那个 await getTask 期间到点（停止闭包还没登记，全靠陈旧记录仍是 runActive=true）：回滚让位（第十三轮评审 P3-3 / P3-4）", async () => {
    const { agent, inWindow, closeWindow } = await setupForeignRoundThenDisconnect();
    mockResume.mockImplementation(async () => ({ agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send: agent.send }));

    // 重连链入口的 getTask（tryChatAutoReconnect 里 getReconnectStops().set 之前的那个 await）：在它里面把 A 的窗口收掉。
    // 按调用栈认「是 tryChatAutoReconnect 调的」：getTask 在别处也会被调，只认这一处
    const taskFs = await import("@/lib/server/task-fs");
    const realGetTask = taskFs.getTask;
    let armed = false;
    let hit = false;
    let stopsHasInWindow: boolean | undefined;
    const spy = vi.spyOn(taskFs, "getTask").mockImplementation(async (...args: Parameters<typeof realGetTask>) => {
      if (armed && !hit && /tryChatAutoReconnect/.test(new Error().stack ?? "")) {
        hit = true;
        stopsHasInWindow = reconnectStopsHas(TASK_ID);
        await closeWindow();
      }
      return realGetTask(...args);
    });
    try {
      armed = true;
      agent.releaseRound(2); // 断流 → consumeChatRun 失败分支 → tryChatAutoReconnect → await getTask（被我们挂住）
      await vi.waitFor(() => expect(hit, "重连链入口的 getTask 没被调到（用例没造出这个时刻）").toBe(true), { timeout: 4_000, interval: 10 });
      await vi.waitFor(() => expect(inWindow.markerAfter, "窗口没收成").toBeDefined(), { timeout: 4_000, interval: 10 });
      expect(stopsHasInWindow, "前置：这一刻停止闭包还没登记（探针靠的是陈旧记录的 runActive，不是重连闭包）").toBe(false);
      expect(inWindow.tableEmpty, "前置：这一刻坏实例还在表里").toBe(false);
      await expectMarkerSurvivesAndChainEnds(agent, inWindow, "tryChatAutoReconnect 的 getTask 窗口里（闭包还没登记、陈旧记录是探针唯一的依据）");
    } finally {
      spy.mockRestore();
      agent.releaseRound(2);
      agent.releaseRound(3);
    }
  }, 30_000);

  it("resume 失败再退避（递归）：两次退避之间表空，窗口在第二次 resume 回调里到点——仍让位；链结束后停止闭包表不残留（第十三轮评审 P3-4）", async () => {
    const { agent, inWindow, closeWindow } = await setupForeignRoundThenDisconnect();
    let resumes = 0;
    mockResume.mockImplementation(async () => {
      resumes += 1;
      if (resumes === 1) throw new Error("fetch failed"); // 第 1 次 resume 抛网络类错误（非确定性、保留锚点）→ 递归进第 2 次退避
      await closeWindow();
      return { agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send: agent.send };
    });

    agent.releaseRound(2);
    try {
      await vi.waitFor(() => expect(inWindow.markerAfter, "第二次 resume 回调没被调用：递归没走到").toBeDefined(), { timeout: 20_000, interval: 50 });
      expect(resumes, "前置：窗口是在第 2 次 resume 里收的").toBe(2);
      expect(inWindow.tableEmpty, "前置：第 2 次 resume 时表是空的").toBe(true);
      await expectMarkerSurvivesAndChainEnds(agent, inWindow, "递归重连的空窗里");
    } finally {
      agent.releaseRound(2);
      agent.releaseRound(3);
    }
  }, 40_000);

  it("reconnect send 失败再退避（递归，send 失败分支）：两次退避之间表空，窗口在第二次 resume 回调里到点——仍让位；链结束后停止闭包表不残留（第十四轮评审 P3-5 ⑥：上一条递归只覆盖 resume 抛错分支）", async () => {
    const { agent, inWindow, closeWindow } = await setupForeignRoundThenDisconnect();
    let resumes = 0;
    mockResume.mockImplementation(async () => {
      resumes += 1;
      if (resumes === 1) {
        // 第 1 次 resume 成功（装进表、认领），但 reconnect prompt 的 send 失败（网络类）→ catch 分支：把刚装的实例摘掉（表空）→ 递归进第 2 次退避
        return {
          agentId: AGENT_A,
          close: vi.fn().mockResolvedValue(undefined),
          send: vi.fn().mockRejectedValue(new Error("fetch failed（测试注入）")),
        };
      }
      await closeWindow();
      return { agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send: agent.send };
    });

    agent.releaseRound(2);
    try {
      await vi.waitFor(() => expect(inWindow.markerAfter, "第二次 resume 回调没被调用：send 失败分支的递归没走到").toBeDefined(), { timeout: 20_000, interval: 50 });
      expect(resumes, "前置：窗口是在第 2 次 resume 里收的").toBe(2);
      expect(inWindow.tableEmpty, "前置：第 2 次 resume 时表是空的（send 失败的实例已被摘）").toBe(true);
      await expectMarkerSurvivesAndChainEnds(agent, inWindow, "递归重连（send 失败分支）的空窗里");
    } finally {
      agent.releaseRound(2);
      agent.releaseRound(3);
    }
  }, 40_000);

  it("用户在重连的退避窗口里点停止：重连链按「已接管」收尾——没有 resume、标记被清、停止闭包表不残留（第十三轮评审 P3-4）", async () => {
    const { agent } = await setupForeignRoundThenDisconnect();
    mockResume.mockImplementation(async () => ({ agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send: agent.send }));

    agent.releaseRound(2);
    try {
      await vi.waitFor(() => expect(reconnectStopsHas(TASK_ID), "重连链没走到退避").toBe(true), { timeout: 4_000, interval: 10 });
      expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：退避窗口里标记还在").toBe(true);
      // 走真实的停止收尾（stopTaskAgent：cancelChatRun + 清状态 + runStatus 回 idle + 落停止事件）——光调 cancelChatRun 只发信号，状态要等 stop 路由收尾才回 idle，
      // 断言不了「停止不被收成失败」（第十四轮评审 P3-5 ⑥）
      const { stopTaskAgent } = await import("@/lib/server/stop-task");
      const stopped = await stopTaskAgent((await getTask(TASK_ID))!);
      expect(stopped.hadAgent, "stop 应打得到重连链").toBe(true);
      await vi.waitFor(() => expect(reconnectStopsHas(TASK_ID), "停止后重连停止闭包表里还留着这个 task").toBe(false), { timeout: 6_000 });
      await vi.waitFor(() => expect(hasChatSession(TASK_ID), "停止后不该留下会话（僵尸假 busy）").toBe(false), { timeout: 4_000 });
      expect(mockResume, "用户停止在退避里被消费：不该走到 resume").not.toHaveBeenCalled();
      await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "停止之后标记残留（会白白限制属主下一轮的电脑操作）").toBe(false), { timeout: 4_000 });
      // 停止不是失败（第十四轮评审 P3-5 ⑥：原先没断言）：没有 error 事件，状态回到 idle——别把「停止」收成「重连失败」。
      // 停止闭包表清空 = 重连链的 finally 刚跑完；它之后 consumeChatRun 才接着按「放弃」收尾（若没当成已接管）——给这段收尾落盘留一点时间再看，别抢在它前面读
      await new Promise((r) => setTimeout(r, 400));
      expect((await readEvents(TASK_ID)).filter((e) => e.kind === "error"), "停止不该落 error 事件").toEqual([]);
      expect((await getTask(TASK_ID))?.runStatus, "停止之后状态应回到 idle（不是 error / running）").toBe("idle");
    } finally {
      agent.releaseRound(2);
      agent.releaseRound(3);
    }
  }, 30_000);
});

// ───────────────────────── 第十四轮评审 P3-1：sendChatMessage 的失主 / 取消 / 失败出口，登记者按 token 清不看 shared ─────────────────────────
//
// 背景：sendChatMessage（带 foreignContentTurn）在 agent.send 前一刻登记 midRun 标记（拿 token），随后 `await agent.send`（最长 SDK_SEND_TIMEOUT_MS = 120 秒）。
// 第十二轮把它归进「登记者已占住投递位」一类、没送达时用 endNonOwnerTurn(token) 回滚——前提是「占住期间别路的送达进不来」。
// 但这个 await 期间用户可以 stop：claim 型记录的 cancel 会摘表、或实例被换，**表一空，别路的外来内容就进得来了**——它见到活标记就沿用
// （没有自己的 token、shared=true），那一轮只靠这个标记限制 desktop_* / 写所有者备注 / 建定时。随后 A 的 agent.send 迟到返回（或抛错）走失主 /
// 取消 / 失败出口，按 token 一清——沿用者那一轮后半程无标记。三个出口（catch、send 返回后复查、置 running 之后复查）同一个形状。
// 修后三处都走 rollbackForeignContentMidRun（登记之后被沿用、且此刻还有 run 在跑就让位，留给沿用者那一轮收尾按名清）；
// 「摘本实例的会话」排在回滚之前——否则 A 自己还没摘的 runActive=true 记录会被探针当成「有 run 在跑」，让位后没人收尾（孤儿标记）。
//
// 造法：A = 属主第一轮跑完后留着的会话上的外来内容 send（挂起）；用 closeChatSessionUnconditional（reason=rewind，不清标记）摘掉 A 的记录，
// 代表「摘表但不清标记」的各路径（claim 型 cancel / 实例被换 / 删任务）；B = 之后到的外来内容经 runChatSession 起新会话、沿用 A 的标记。
describe("sendChatMessage 的失主 / 取消 / 失败出口：登记者的回滚不能清掉别路沿用的标记（第十四轮评审 P3-1）", () => {
  type Late = "resolve" | "reject";

  /** 第一轮属主自己的话跑完、会话留着；第二轮 A（外来内容、foreignContentTurn）的 agent.send 挂起不决 */
  const setupPendingForeignSend = async () => {
    const finished = {
      stream: vi.fn(async function* (): AsyncGenerator<unknown> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "第一轮答" }] } };
      }),
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const lateRun = {
      stream: vi.fn(async function* (): AsyncGenerator<never> {
        /* 迟到 run：被丢弃，不会被消费 */
      }),
      wait: vi.fn().mockResolvedValue({ status: "cancelled" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    let settleSecond!: (how: Late) => void;
    const secondGate = new Promise<unknown>((resolve, reject) => {
      settleSecond = (how) => (how === "resolve" ? resolve(lateRun) : reject(new Error("fetch failed（测试注入）")));
    });
    const atSend: boolean[] = [];
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        atSend.push(isGroupNonOwnerTurnActive(TASK_ID));
        return finished;
      })
      .mockImplementationOnce(() => {
        atSend.push(isGroupNonOwnerTurnActive(TASK_ID));
        return secondGate;
      });
    mockCreate.mockResolvedValueOnce({ agentId: AGENT_A, close: vi.fn().mockResolvedValue(undefined), send });
    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "属主第一句" } });
    expect(hasChatSession(TASK_ID), "前置：第一轮跑完后会话应保留").toBe(true);

    const second = sendChatMessage(asTask(makeMeta(TASK_ID)), FOREIGN_TEXT, undefined, undefined, { foreignContentTurn: true });
    for (let i = 0; i < 50 && send.mock.calls.length < 2; i++) await sleep(20);
    expect(send).toHaveBeenCalledTimes(2);
    expect(atSend, "外来内容 agent.send 之前标记必须已就位").toEqual([false, true]);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "send 挂起中：登记的标记在").toBe(true);
    return { second, settleSecond, lateRun };
  };

  /** A 的记录被摘（不清标记），B 的外来内容起新会话并沿用 A 的标记、B 这一轮在跑（gated） */
  const dropAThenStartSharingB = async () => {
    closeChatSessionUnconditional(TASK_ID);
    expect(hasChatSession(TASK_ID), "前置：A 的记录已被摘").toBe(false);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：摘表不清标记（reason=rewind 只有 restart 才在摘表时清）").toBe(true);
    const agentB = makeScriptedAgent(["gated"]);
    const startB = runChatSession({
      task: asTask(makeMeta(TASK_ID)),
      ...BOOT,
      firstMessage: { text: "B 的外来内容" },
      foreignContentTurn: true,
    });
    await vi.waitFor(() => expect(agentB.send).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    expect(agentB.atSend, "前置：B 首包送出时标记在（沿用 A 的、没有自己的 token）").toEqual([true]);
    return { agentB, startB };
  };

  it.each<[string, Late, string]>([
    ["send 返回后复查（实例已被摘）", "resolve", "owner_invalid"],
    ["send 抛错（catch 出口）", "reject", "send_failed"],
  ])(
    "A 被停 / 摘表后 B 沿用了它的标记：A 的 %s 出口回滚让位——B 这一轮标记仍在，B 收尾后才清",
    async (_name, late, expected) => {
      const { second, settleSecond } = await setupPendingForeignSend();
      const { agentB, startB } = await dropAThenStartSharingB();
      try {
        settleSecond(late);
        // A 的 send 迟到：reject 时 closeChatSession(…, 本实例号) 门控 no-op（表里已是 B）；resolve 时丢弃迟到 run
        const res = await second;
        expect(res, "A 的返回值（摘表不是用户点停止，不会是 cancelled；放宽成「二选一」会让出口走错也不红）").toBe(expected);
        await sleep(60);
        expect(
          isGroupNonOwnerTurnActive(TASK_ID),
          "A 的失主 / 失败出口按 token 把 B 正靠着的标记清了：B 这一轮后半程 desktop_* / 写所有者备注 / 建定时不再被拒",
        ).toBe(true);
        expect(hasChatSession(TASK_ID), "B 的会话不受 A 迟到出口牵连").toBe(true);

        agentB.releaseRound(1);
        await startB;
        await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "B 收尾后标记没人摘").toBe(false), { timeout: 4_000 });
      } finally {
        settleSecond(late);
        agentB.releaseRound(1);
        await startB;
      }
    },
  );

  it("A 的 send 已受理、置 running 的 await 期间被摘表且 B 沿用了标记（goneAfterStatus 出口）：回滚让位", async () => {
    const { second, settleSecond } = await setupPendingForeignSend();
    const taskFs = await import("@/lib/server/task-fs");
    let started: Awaited<ReturnType<typeof dropAThenStartSharingB>> | undefined;
    const spy = vi.spyOn(taskFs, "setTaskRunStatus").mockImplementationOnce(async () => {
      // A 的 agent.send 已受理、正在置 running：这个 await 期间 A 被摘表、B 起来并沿用标记
      started = await dropAThenStartSharingB();
      throw new Error("status boom（测试注入）"); // 落到同一道实例复查
    });
    try {
      settleSecond("resolve");
      const res = await second;
      expect(res, "置 running 期间实例被摘：迟到 run 被丢弃").toBe("owner_invalid");
      expect(started, "前置：置 running 的 await 里应已摘 A、起 B").toBeDefined();
      await sleep(60);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "goneAfterStatus 出口按 token 把 B 正靠着的标记清了",
      ).toBe(true);
      started!.agentB.releaseRound(1);
      await started!.startB;
      await vi.waitFor(() => expect(isGroupNonOwnerTurnActive(TASK_ID), "B 收尾后标记没人摘").toBe(false), { timeout: 4_000 });
    } finally {
      spy.mockRestore();
      settleSecond("resolve");
      started?.agentB.releaseRound(1);
      await started?.startB;
    }
  });

  it("对照：A 被摘表、但没有任何别路沿用——A 迟到的出口照清（不残留；与上面「有沿用者」是同一处的两个分支）", async () => {
    const { second, settleSecond } = await setupPendingForeignSend();
    closeChatSessionUnconditional(TASK_ID);
    expect(isGroupNonOwnerTurnActive(TASK_ID), "前置：摘表不清标记").toBe(true);
    settleSecond("resolve");
    expect(await second, "摘表（不是用户点停止）后 send 迟到返回：丢弃迟到 run，返回 owner_invalid").toBe("owner_invalid");
    expect(isGroupNonOwnerTurnActive(TASK_ID), "没人沿用时 A 迟到的出口该把自己登记的标记清掉").toBe(false);
  });

  it("顺序钉：A 被停止（普通记录仍在表里）、窗口里别路只是预登记后排了队（标记被置 shared，但没有 run 在跑）——A 的出口先摘本实例再回滚，照清，不留孤儿", async () => {
    const { second, settleSecond } = await setupPendingForeignSend();
    expect(cancelChatRun(TASK_ID), "stop 应打得到 A").toBe(true);
    // 别路（chat-inject 的 registerForeignMark）预登记：见到活标记 → 沿用并置 shared；随后它的送达撞上「会话在忙」入队、没有自己的 run
    expect(beginForeignContentMidRun(TASK_ID), "沿用：不新建、不返回 token").toBeUndefined();
    expect(hasChatSession(TASK_ID), "前置：普通记录 stop 后仍在表里（只置了取消信号）").toBe(true);
    settleSecond("resolve");
    expect(await second).toBe("cancelled");
    expect(hasChatSession(TASK_ID), "A 的出口应已摘掉本实例").toBe(false);
    expect(
      isGroupNonOwnerTurnActive(TASK_ID),
      "回滚排在摘本实例之前：A 自己还在表里的 runActive=true 记录被探针算成「有 run 在跑」，让位后没人收尾——标记成了孤儿",
    ).toBe(false);
  });

  it("顺序钉：A 的 send 已受理、置 running 的 await 期间被停止（普通记录仍在表里）、别路只是预登记后排了队（标记置了 shared、没有 run）——状态写入后出口先摘本实例再回滚，照清，不留孤儿", async () => {
    const { second, settleSecond } = await setupPendingForeignSend();
    const taskFs = await import("@/lib/server/task-fs");
    // 在 mock 里只记结果、不在里面断言：这里抛出的任何错误都会被 sendChatMessage 的 catch (statusErr) 吞掉，断言失败会变成「悄悄通过」
    let stopHit: boolean | undefined;
    let sharedToken: string | undefined | null = null;
    const spy = vi.spyOn(taskFs, "setTaskRunStatus").mockImplementationOnce(async () => {
      // A 的 agent.send 已受理、正在置 running：这个 await 期间用户点停止（普通记录只置取消信号、仍在表里——实例复查不命中 goneAfterStatus，
      // 走的是 cancelledDuringSend 那一支）；别路（chat-inject 的 registerForeignMark）预登记：见到活标记就沿用并置 shared，
      // 随后它的送达撞上「会话在忙」入队、没有自己的 run
      stopHit = cancelChatRun(TASK_ID);
      sharedToken = beginForeignContentMidRun(TASK_ID);
      throw new Error("status boom（测试注入）"); // 落到同一道实例复查
    });
    try {
      settleSecond("resolve");
      expect(await second, "置 running 期间被停止：迟到 run 被丢弃").toBe("cancelled");
      expect(stopHit, "前置：stop 应打得到 A").toBe(true);
      expect(sharedToken, "前置：沿用——不新建、不返回 token").toBeUndefined();
      expect(hasChatSession(TASK_ID), "A 的出口应已摘掉本实例").toBe(false);
      expect(
        isGroupNonOwnerTurnActive(TASK_ID),
        "回滚排在摘本实例之前：A 自己还在表里的 runActive=true 记录被探针算成「有 run 在跑」，让位后没人收尾——标记成了孤儿（与上一条同理，是状态写入后这个出口）",
      ).toBe(false);
    } finally {
      spy.mockRestore();
      settleSecond("resolve");
    }
  });

  it("顺序钉：A 的 agent.send 抛错、沿用者只是排了队（标记置了 shared、没有 run）——catch 出口照清（runActive 先复位再回滚）", async () => {
    const { second, settleSecond } = await setupPendingForeignSend();
    expect(beginForeignContentMidRun(TASK_ID), "沿用：不新建、不返回 token").toBeUndefined();
    settleSecond("reject");
    expect(await second).toBe("send_failed");
    expect(isGroupNonOwnerTurnActive(TASK_ID), "catch 出口没清：沿用者没有 run、没人再为这个标记收尾").toBe(false);
  });
});
