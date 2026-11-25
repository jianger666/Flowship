/**
 * 第十九轮评审 R19-2：用户 stop 与「本轮自然收尾」撞上 chat finalize 的写盘窗口 → 会话不能留成「没有 token 的空壳」。
 *
 * 背景：stop-task 一开始就**同步**摘了表里的 callerToken（`invalidateCallerToken`，首个 await 之前），之后要经过好几个 await 才轮到
 * `cancelChatRun`。如果 run 恰好在这几步里自然收尾，`finalizeChatRunIfCurrent` 的 finished 分支正停在「写 awaiting_user」的 await 上：
 * 后到的 `cancelChatRun` 看到 `runActive=true`、只发 `rec.cancel()`（对一个已经结束的 run 是空操作），finished 分支又照常「会话保留」——
 * 留下一个没有 token / notifier 的空壳。下一条消息 `sendChatMessage` 直接复用这个会话（不会重新登记 token），属主之后的
 * desktop_* / browser_evaluate / schedule / ask_user 全回「任务已被新 agent 接管」，要等下一次 stop / 换模型才自愈。
 *
 * 修法（第十九轮）：RunningChatRecord 记下本实例登记的 callerToken（冷启动与 resume 两条创建路径各写一处）；finished 分支在放 runActive 的同一个同步段里复查
 * 「表里的 token 还是不是我的」——不是 = 这一轮是在被停止的途中收的尾：按停止的本意处理（关会话并保留落盘锚点、不再 flush），
 * 下一条消息走 Agent.resume、重新登记 token。
 *
 * 第二十轮评审 R20-1 订正：这个分支**不清队**。第十九轮曾在这里 `failQueuedItems(cancelled)`——stop 摘 token（首个 await 之前）到它取文本之间隔着好几个 await，
 * 分支若在这段空窗里先清队，stop 随后 `failQueuedItemsCapturingTexts` 取到 0 条、「未送达」卡因 count=0 不写：排队的话静默消失。
 * 清队 + 取原文 + 落卡是 stop 自己的事，所以：① 摘 token 的窗口用 failpoint 造的用例只断言「分支没碰队」；② 真 `stopTaskAgent` 的链路用例
 * （用任务锁把 finalize 钉在写盘 await 里，stop 的摘 token 因此落在复查点**之前**的 await 途中、而不是回调里）断言卡里原文一条不丢。
 *
 * 第二十轮评审 R20-4 / R20-5 / R20-2 一并补在本文件：真 stopTaskAgent 链路、复查必须在写盘 await 之后（用任务锁造「途中才摘」）、
 * 「合法无 token」负例（纯函数 isRegisteredCallerTokenRevoked）、chat 两条创建路径的工具闭包 token 接线、冷启动写 MCP 提示的 await 里被强清 + 后继接管。
 *
 * 真 chat-runner + 假 SDK；窗口用 failpoint `chat.finalize.beforeStatusWrite` 造（它就在 finished 分支的写盘 await 之前）：回调里照 stop-task 的第一步摘 token。
 */
import { mkdtempSync, promises as fs, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";

import { blockAfter, readSource, stripComments } from "./helpers/source-text";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-stop-finish-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;
// 真 stopTaskAgent 会读任务（getTask）→ 别让它顺带触发进程级 boot recovery（会把「running」的聊天标成 error）；同 chat-stop-dropped-notice.test.ts 的做法
(globalThis as unknown as Record<string, Promise<void> | undefined>)["__flowshipBootRecoveryPromiseV2__"] = Promise.resolve();

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
// 被剔除的 MCP 清单由用例按需设置（R20-2：冷启动只有在有被剔除的 MCP 时才会真的写「已跳过」提示、才有那个 await）
const mcpProbe = vi.hoisted(() => ({
  dropped: [] as Array<{ name: string; status: string; detail?: string }>,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({ servers, dropped: mcpProbe.dropped }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
// 真 stopTaskAgent 要加载 stop-task（连带 task-runner 等）：下面三个与 chat-stop-dropped-notice.test.ts 同款桩
vi.mock("@/lib/server/kill-orphans", () => ({ reapTaskOrphans: vi.fn() }));
vi.mock("@/lib/server/update-pending", () => ({
  assertNoUpdatePendingRestart: async () => {},
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));

const { readEvents, readMetaV06, taskDir, withTaskLock, writeMeta } = await import("@/lib/server/task-fs-core");
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { clearChatQueue, enqueueChatMessage, getChatQueueCount } = await import("@/lib/server/chat-queue");
const { clearFailpoints, setFailpoint } = await import("@/lib/server/failpoints");
const { subscribeTaskStream } = await import("@/lib/server/task-stream");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const { droppedNoticeTitle, extractDroppedTexts } = await import("@/lib/chat-stream-display");
const {
  CALLER_MISMATCH_ERROR,
  getExpectedCallerToken,
  invalidateCallerToken,
  isRegisteredCallerTokenRevoked,
  matchExpectedCallerToken,
  setOneShotCallerToken,
} = await import("@/lib/server/chat-pending");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`chat-stop-finish-race DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

let TASK_ID = "t_1700000019200_stopfinish";
let taskSeq = 0;
const usedTaskIds = new Set<string>();
const AGENT_ID = "agent_fake_stopfinish";
const BOOT = { apiKey: "test-key", model: { id: "gpt-test", params: [] as never[] } };

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `stop-finish ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;
const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

const makeRun = () => ({
  stream: async function* (): AsyncGenerator<never> {
    /* 空流 */
  },
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

const makeAgent = (agentId = AGENT_ID) => ({
  agentId,
  close: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(makeRun()),
});
type FakeAgent = ReturnType<typeof makeAgent>;

type Path = "cold" | "resume";
const PATHS: Array<{ id: Path; label: string }> = [
  { id: "cold", label: "冷启动（runChatSession）" },
  { id: "resume", label: "resume（resumeChatSession + sendChatMessage）" },
];

/**
 * 起会话并让第一轮开跑：冷启动走 runChatSession（Promise 在整轮收尾后才 resolve）；resume 走 resumeChatSession + sendChatMessage。
 * ⚠️ 返回的是「整轮收尾」的 Promise（async 函数返回 Promise 会被展平，所以调用方 `await` 它 = 等到整轮收尾）——
 * 要在收尾途中做事的用例（用任务锁卡住 finalize）**不要 await 它**，先做完事再 await。
 */
const startFirstRun = async (via: Path, agent: FakeAgent): Promise<unknown> => {
  if (via === "cold") {
    mockCreate.mockResolvedValueOnce(agent);
    return runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "首包" } });
  }
  mockResume.mockResolvedValueOnce(agent);
  expect(await resumeChatSession(asTask(makeMeta(TASK_ID)), BOOT)).not.toBeNull();
  expect(await sendChatMessage(asTask(makeMeta(TASK_ID)), "首条")).toBe("sent");
  return undefined;
};

const waitSessionGone = () =>
  vi.waitFor(() => expect(hasChatSession(TASK_ID)).toBe(false), { timeout: 5000, interval: 20 });
const waitIdle = () =>
  vi.waitFor(() => expect(isChatRunActive(TASK_ID)).toBe(false), { timeout: 5000, interval: 20 });

const enqueueOne = (itemId: string) =>
  enqueueChatMessage(TASK_ID, {
    itemId,
    agentText: `排队的话 ${itemId}`,
    displayText: `排队的话 ${itemId}`,
    enqueuedAt: Date.now(),
  });

const quiesceTask = async (taskId: string): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await withTaskLock(taskId, async () => undefined);
    await new Promise((r) => setTimeout(r, 40));
  }
};

type Tool = { execute: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };

beforeEach(async () => {
  taskSeq += 1;
  TASK_ID = `t_1700000019200_stopfinish_${taskSeq}`;
  usedTaskIds.add(TASK_ID);
  mockCreate.mockReset();
  mockResume.mockReset();
  mcpProbe.dropped = [];
  clearFailpoints();
  clearChatGate(TASK_ID);
  clearChatQueue(TASK_ID);
  await writeMeta(makeMeta(TASK_ID));
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({ apiKey: "server-key", defaultModel: { id: "gpt-test", params: [] } }),
    "utf-8",
  );
});

afterEach(async () => {
  clearFailpoints();
  mcpProbe.dropped = [];
  forceClearChatRun(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  clearChatGate(TASK_ID);
  clearChatQueue(TASK_ID);
  await new Promise((r) => setTimeout(r, 40));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await Promise.all([...usedTaskIds].map((id) => quiesceTask(id)));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe.each(PATHS)("stop 摘 token 之后 run 才在写盘窗口里自然收尾——$label", ({ id: via }) => {
  it("会话被关（不留没有 token 的空壳）、落盘锚点保留、不 flush、也不清队（清队 + 取原文是 stop 的事，R20-1）；下一条消息走 resume、重新登记 token", async () => {
    const events: Array<{ kind: string; ok?: boolean; itemIds?: string[]; reason?: string }> = [];
    const unsub = subscribeTaskStream(TASK_ID, (ev) => {
      const e = ev as { kind: string; ok?: boolean; itemIds?: string[]; reason?: string };
      if (e.kind === "done" || e.kind === "queue_failed") events.push(e);
    });
    const agent = makeAgent();
    let tokenAtStop: string | null = null;
    let hits = 0;
    setFailpoint("chat.finalize.beforeStatusWrite", async () => {
      hits += 1;
      if (hits > 1) return;
      // stop-task 的第一步（beganStopping 之后、首个 await 之前）：同步摘 token；随后到的还有排队的话
      tokenAtStop = getExpectedCallerToken(TASK_ID);
      invalidateCallerToken(TASK_ID);
      expect(enqueueOne("q_stop_1").ok).toBe(true);
    });

    await startFirstRun(via, agent);
    await waitSessionGone();

    expect(tokenAtStop, "前置：窗口里取到过本会话登记的 token").not.toBeNull();
    expect(hasChatSession(TASK_ID), "stop 撞上自然收尾：会话还留在表里 = 没有 token 的空壳（要等下一次 stop / 换模型才自愈）").toBe(false);
    expect(agent.close, "会话关了就该把 agent 一并关掉").toHaveBeenCalled();
    expect(agent.send, "排队的话不能被 flush 进一个正在被停止的会话").toHaveBeenCalledTimes(1);
    expect(getChatQueueCount(TASK_ID), "收口分支不清队：队里的话留给 stop 的 failQueuedItemsCapturingTexts 取原文 + 落卡（先清了就是静默丢）").toBe(1);
    expect(
      events.filter((e) => e.kind === "queue_failed"),
      "收口分支没碰队：不该有 queue_failed（清队 + 通知是 stop 的事）",
    ).toHaveLength(0);
    expect(getExpectedCallerToken(TASK_ID), "关会话后表里不该有 token").toBeNull();
    expect(events.filter((e) => e.kind === "done" && e.ok === true), "这一轮的 done 照常发出一次").toHaveLength(1);
    // 落盘锚点保留：下一条消息 Agent.resume 接回。清锚点是 closeChatSession 里 fire-and-forget 的条件写（clearTaskSessionAgentIdIf），
    // 先等任务锁上的排队写都落定再读，否则「误清了锚点」这类回归会因为读得太早而漏过
    await quiesceTask(TASK_ID);
    expect((await readMetaV06(TASK_ID))?.sessionAgentId, "停止收尾必须保留落盘锚点（下一条消息 Agent.resume 接回）").toBe(AGENT_ID);

    // 模拟 stop 随后的清队（这条用例的 failpoint 只摘了 token、没有真 stop）：别让残留的排队项串到下面「下一条消息」的会话里
    clearChatQueue(TASK_ID);
    // 下一条消息：没有会话 → 走 resume → 重新登记 token（会话重新可用）
    const agent2 = makeAgent();
    mockResume.mockResolvedValueOnce(agent2);
    expect(await resumeChatSession(asTask(makeMeta(TASK_ID)), BOOT)).not.toBeNull();
    const renewed = getExpectedCallerToken(TASK_ID);
    expect(renewed, "resume 之后必须重新登记 token").not.toBeNull();
    expect(renewed).not.toBe(tokenAtStop);
    expect(matchExpectedCallerToken(TASK_ID, renewed!)).toBe(true);
    unsub();
  }, 30_000);

  it("真 stopTaskAgent（R20-1 / R20-4）：stop 在 finalize 写盘 await **途中**才摘 token → 分支只关会话、不清队；stop 随后取走排队原文并落「未送达」卡，一条不丢", async () => {
    const agent = makeAgent();
    // 任务锁闸：finalize 写 awaiting_user 要拿任务锁。回调里先占住它，finalize 就停在「写盘 await」里——
    // stop 的摘 token 因此确定地落在复查点**之前**的 await 途中。在 failpoint 回调里摘 token 只能证明「复查在 failpoint 之后」，
    // 证明不了「复查在写盘 await 之后」（把复查挪到 failpoint 与写盘之间，那种用例照样绿，真 stop 的窗口却漏了）
    let openLock!: () => void;
    const lockGate = new Promise<void>((r) => (openLock = r));
    let lockTaken = false;
    let hits = 0;
    setFailpoint("chat.finalize.beforeStatusWrite", async () => {
      hits += 1;
      if (hits > 1) return;
      void withTaskLock(TASK_ID, async () => {
        lockTaken = true;
        await lockGate;
      });
      expect(enqueueOne("q_real_stop_1").ok).toBe(true);
    });
    // stop 停在 afterGate（摘 token 之后、取消 / 取文本之前）：让 finalize 的复查一定先于 stop 的取文本——窗口里最坏的顺序
    let openStop!: () => void;
    const stopGate = new Promise<void>((r) => (openStop = r));
    let stopAtGate = false;
    setFailpoint("stop.afterGate", async () => {
      stopAtGate = true;
      await stopGate;
    });

    const finished = startFirstRun(via, agent); // 不 await：冷启动的 Promise 要等整轮收尾才 resolve，而收尾被下面的任务锁卡着
    await vi.waitFor(() => expect(lockTaken, "finalize 应已走到写盘前、任务锁被占住").toBe(true), { timeout: 5000, interval: 10 });
    await new Promise((r) => setTimeout(r, 50)); // 回调返回后 finalize 只隔几个微任务就会排到任务锁的队里
    expect(isChatRunActive(TASK_ID), "前置：run 的收尾还没完（runActive 撑到写盘之后）").toBe(true);

    const stopP = stopTaskAgent(asTask(makeMeta(TASK_ID)));
    await vi.waitFor(() => expect(stopAtGate, "stop 应已走到 afterGate").toBe(true), { timeout: 5000, interval: 10 });
    expect(getExpectedCallerToken(TASK_ID), "stop 的首个 await 之前已同步摘了 token").toBeNull();
    expect(hasChatSession(TASK_ID), "stop 还没取消：会话仍在表里").toBe(true);

    openLock(); // 放 finalize：写盘完成后复查——token 已被 stop 摘走 → 走收口分支
    await finished;
    await waitSessionGone();
    expect(getChatQueueCount(TASK_ID), "收口分支不清队：排队的话留给 stop 取原文（R20-1：先清了，stop 就取到 0 条、卡也不写）").toBe(1);
    expect(agent.send, "不能 flush 进被停止的会话").toHaveBeenCalledTimes(1);

    openStop(); // 放 stop 往下走：取消（无会话）→ 取文本 → 清队 → 落「用户停止了」→ 落「未送达」卡
    await stopP;

    const evs = await readEvents(TASK_ID);
    const stopIdx = evs.findIndex((e) => e.kind === "info" && e.meta?.stopped === true);
    const cardIdx = evs.findIndex((e) => e.kind === "info" && /未送达/.test(e.text ?? ""));
    expect(stopIdx, "stop 应落「用户停止了」").toBeGreaterThanOrEqual(0);
    expect(cardIdx, "stop 必须落「未送达」卡——收口分支若先清了队，这里取到 0 条、卡不写、排队的话静默消失").toBeGreaterThan(stopIdx);
    const card = evs[cardIdx]!;
    expect(droppedNoticeTitle(card.text)).toBe("已停止，1 条排队消息未送达、请重新发送");
    expect(extractDroppedTexts(card.meta), "原文一条不丢").toEqual(["排队的话 q_real_stop_1"]);
    expect(getChatQueueCount(TASK_ID)).toBe(0);
    expect(agent.send, "排队的话从头到尾没被送进 agent").toHaveBeenCalledTimes(1);
    expect(hasChatSession(TASK_ID)).toBe(false);
    expect(getExpectedCallerToken(TASK_ID), "stop 收尾后表里不该有 token").toBeNull();
  }, 30_000);

  it("对照：没有 stop（token 没动）→ 会话保留、token 不变、排队的话照常 flush 送出", async () => {
    const agent = makeAgent();
    let tokenBefore: string | null = null;
    let hits = 0;
    setFailpoint("chat.finalize.beforeStatusWrite", async () => {
      hits += 1;
      if (hits > 1) return;
      tokenBefore = getExpectedCallerToken(TASK_ID);
      expect(enqueueOne("q_ok_1").ok).toBe(true);
    });

    await startFirstRun(via, agent);
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(2), { timeout: 5000, interval: 20 });
    await waitIdle();

    expect(tokenBefore).not.toBeNull();
    expect(hasChatSession(TASK_ID), "没有 stop：会话应保留（自然结束 = 会话保留）").toBe(true);
    expect(getExpectedCallerToken(TASK_ID), "没有 stop：token 不该变").toBe(tokenBefore);
    expect(getChatQueueCount(TASK_ID)).toBe(0);
  }, 30_000);

  it("边界：stop 的摘 token 排在 finalize 同步段**之后**（会话已空闲）→ 会话照旧保留，随后 cancelChatRun 走「idle 会话 → 直接关」", async () => {
    const agent = makeAgent();
    await startFirstRun(via, agent);
    await waitIdle();
    expect(hasChatSession(TASK_ID)).toBe(true);

    invalidateCallerToken(TASK_ID);
    expect(hasChatSession(TASK_ID), "复查之后才被摘：不关会话（没有 run 在跑，这是 stop 自己的 cancelChatRun 要处理的）").toBe(true);
    expect(cancelChatRun(TASK_ID)).toBe(true);
    expect(hasChatSession(TASK_ID), "idle 会话被 cancelChatRun 直接关").toBe(false);
  }, 30_000);

  it("R20-5 · 工具闭包 token 接线：本路径建出的会话，agent 手里 Flowship 工具闭包带的 token 就是表里登记的那个——当前会话放行，摘 token 后同一个闭包被拒", async () => {
    const agent = makeAgent();
    await startFirstRun(via, agent);
    await waitIdle();
    expect(hasChatSession(TASK_ID)).toBe(true);
    // 工具闭包由 facade 在建会话时按本路径传给 Agent.create / Agent.resume 的 callerToken 建出来（挂在 local.customTools 上）
    const sdkOptions =
      via === "cold"
        ? (mockCreate.mock.calls[0]![0] as { local: { customTools: Record<string, Tool> } })
        : (mockResume.mock.calls[0]![1] as { local: { customTools: Record<string, Tool> } });
    const tool = sdkOptions.local.customTools.set_owner_note;
    expect(tool, "会话里应挂有 set_owner_note（带 token 核对、且 content 传空串只是清空备注，没有别的副作用）").toBeTruthy();
    const call = async (): Promise<string> =>
      (await tool!.execute({ task_id: TASK_ID, content: "" }, {})).content.map((c) => c.text).join("\n");

    const ok = await call();
    expect(ok, "路径登记进表的 token 与交给 SDK 工具闭包的不是同一个：当前会话的属主调用也会被拒").not.toContain(CALLER_MISMATCH_ERROR);
    expect(JSON.parse(ok)).toMatchObject({ ok: true });

    invalidateCallerToken(TASK_ID);
    expect(await call(), "摘了 token 之后，同一个闭包必须被拒（fail-closed）").toContain(CALLER_MISMATCH_ERROR);
  }, 30_000);
});

describe("冷启动：写「已跳过不可用 MCP」提示的 await 期间被强清 + 后继接管（R20-2）", () => {
  it("迟到的登记不能盖掉后继已装好的 token / notifier——后继之后每一轮自然收尾也不会被判成「被停止」而关会话", async () => {
    mcpProbe.dropped = [{ name: "demo-mcp", status: "failed", detail: "连不上" }];
    const agentA = makeAgent("agent_A_cold");
    mockCreate.mockResolvedValueOnce(agentA); // A 在 Agent.create 之前就该退出，不该走到这里
    const agentB = makeAgent("agent_B_successor");
    mockResume.mockResolvedValueOnce(agentB);
    let tokenB: string | null = null;
    setFailpoint("chat.start.afterMcpNotice", async () => {
      // A 此刻停在「写 MCP 提示」之后、登记 notifier / token 之前。模拟：A 被强清（懒重启的兜底），后继 B 接管并登记了自己的 token
      forceClearChatRun(TASK_ID);
      expect(await resumeChatSession(asTask(makeMeta(TASK_ID)), BOOT)).not.toBeNull();
      tokenB = getExpectedCallerToken(TASK_ID);
      expect(tokenB, "前置：后继已登记自己的 token").not.toBeNull();
    });

    await runChatSession({ task: asTask(makeMeta(TASK_ID)), ...BOOT, firstMessage: { text: "首包" } });

    expect(mockCreate, "A 已不是当前实例：复查后应直接退出，不再 Agent.create").not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID), "后继 B 的会话还在").toBe(true);
    expect(getExpectedCallerToken(TASK_ID), "A 迟到的登记盖掉了后继的 token（R20-2）").toBe(tokenB);

    // R19-2 把这个覆盖放大成「后继每一轮收尾都被判成被停止、会话被关」——B 发一条消息、自然收尾，会话必须还在
    expect(await sendChatMessage(asTask(makeMeta(TASK_ID)), "后继的一轮")).toBe("sent");
    await vi.waitFor(() => expect(agentB.send).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    await waitIdle();
    expect(hasChatSession(TASK_ID), "后继的会话被误判成被停止而关掉了").toBe(true);
    expect(getExpectedCallerToken(TASK_ID)).toBe(tokenB);
  }, 30_000);
});

describe("isRegisteredCallerTokenRevoked（R20-4：「合法无 token」负例 + 作废的三种形态）", () => {
  const T = "t_token_revoked_unit";
  afterEach(() => {
    invalidateCallerToken(T);
  });

  it("没登记过（undefined）不算作废：表里有别人的 token / 表是空的，都 false——没有 token 的记录不能被误判成「被停止」", () => {
    expect(isRegisteredCallerTokenRevoked(T, undefined), "表空").toBe(false);
    setOneShotCallerToken(T, "someone-else");
    expect(isRegisteredCallerTokenRevoked(T, undefined), "表里是别人的").toBe(false);
  });

  it("登记过：表里仍是它 → 有效；被摘（stop）→ 作废；被后继换了 → 作废", () => {
    setOneShotCallerToken(T, "tok-A");
    expect(isRegisteredCallerTokenRevoked(T, "tok-A")).toBe(false);
    invalidateCallerToken(T);
    expect(isRegisteredCallerTokenRevoked(T, "tok-A"), "stop 摘了").toBe(true);
    setOneShotCallerToken(T, "tok-B");
    expect(isRegisteredCallerTokenRevoked(T, "tok-A"), "后继换了 token").toBe(true);
    expect(isRegisteredCallerTokenRevoked(T, "tok-B"), "后继自己仍有效").toBe(false);
  });

  it("按 taskId 隔离：别的任务的 token 不算我的", () => {
    setOneShotCallerToken(T, "tok-A");
    expect(isRegisteredCallerTokenRevoked("t_other_task", "tok-A")).toBe(true);
  });
});

describe("源码结构（接线）", () => {
  const chat = readSource("src/lib/server/chat-runner.ts");
  const finalizeBody = blockAfter(chat, "const finalizeChatRunIfCurrent = async (");
  // finished 分支：从 `if (outcome === "finished") {` 起到 `if (outcome === "cancelled")` 前
  const finishedStart = finalizeBody.indexOf('if (outcome === "finished") {');
  const finished = finalizeBody.slice(finishedStart, finalizeBody.indexOf('if (outcome === "cancelled") {'));

  it("finished 分支：token 复查在写盘 await **之后**、与放 runActive 在同一个同步段里（之间没有 await），复查命中先关会话再 return、不 flush / drain", () => {
    expect(finishedStart).toBeGreaterThan(-1);
    const writeAt = finished.indexOf("await setTaskRunStatusIfRunOwner(");
    const checkAt = finished.indexOf("const stopRacedWithFinish =");
    const releaseAt = finished.indexOf("rec.runActive = false;");
    const doneAt = finished.indexOf('kind: "done"');
    const branchAt = finished.indexOf("if (stopRacedWithFinish) {");
    const flushAt = finished.indexOf("void flushChatQueue(taskId);");
    expect(writeAt, "找不到 finished 分支的写盘 await").toBeGreaterThan(-1);
    expect(checkAt, "找不到 token 复查").toBeGreaterThan(-1);
    expect(checkAt, "复查必须在写盘 await 之后——stop 的摘 token 落在写盘那个 await 里才是要堵的窗口（R20-4：挪到写盘之前用例也得红）").toBeGreaterThan(writeAt);
    expect(releaseAt).toBeGreaterThan(checkAt);
    expect(finished.slice(checkAt, releaseAt), "复查与放 runActive 之间不能再有 await（stop 的摘 token 与这一段之间不能再插进别的")
      .not.toMatch(/\bawait\b/);
    expect(doneAt).toBeGreaterThan(releaseAt);
    expect(branchAt).toBeGreaterThan(doneAt);
    expect(flushAt, "命中分支必须在 flush 之前 return").toBeGreaterThan(branchAt);
    const branch = blockAfter(finished.slice(branchAt), "if (stopRacedWithFinish) {");
    expect(branch).toMatch(/closeChatSession\(taskId, instanceId, \{ keepPersisted: true \}\)/);
    expect(branch).toMatch(/return true;/);
    expect(branch, "命中分支里不能有 flush / drain").not.toMatch(/flushChatQueue|drainBackgroundResults/);
    expect(
      branch,
      "命中分支不清队（R20-1）：清队要先取原文并落「未送达」卡，那是 stop 自己的事；在这里清 = stop 取到 0 条、排队的话静默消失",
    ).not.toMatch(/failQueuedItems|failQueuedItemsCapturingTexts|clearChatQueue|clearQueue/);
    expect(finished.slice(checkAt, releaseAt)).toMatch(/isRegisteredCallerTokenRevoked\(taskId, rec\.callerToken\)/);
  });

  it("两条创建路径都把本实例登记的 callerToken 记到 RunningChatRecord 上（冷启动：登记 notifier 之前；resume：runningChats.set 的字面量里）", () => {
    // 冷启动：占位记录先写进去，callerToken 在 registerChatNotifier 之前一刻写到 myRec 上
    const coldAt = chat.indexOf("myRec.callerToken = callerToken;");
    expect(coldAt, "冷启动路径没有记 callerToken").toBeGreaterThan(-1);
    const registerAfter = chat.indexOf("registerChatNotifier(task, callerToken, myInstanceId);", coldAt);
    expect(registerAfter).toBeGreaterThan(coldAt);
    expect(chat.slice(coldAt, registerAfter), "记 token 与登记 notifier 之间不能有 await").not.toMatch(/\bawait\b/);
    // resume：runningChats.set(task.id, { … callerToken, … })
    const setAt = chat.indexOf("runningChats.set(task.id, {", chat.indexOf("export const resumeChatSession = async ("));
    expect(setAt, "找不到 resume 路径的 runningChats.set").toBeGreaterThan(-1);
    const literal = blockAfter(chat.slice(setAt), "runningChats.set(task.id, {");
    expect(literal, "resume 路径的记录字面量里没有 callerToken").toMatch(/\bcallerToken,/);
  });

  it("R20-2 · 冷启动：登记 notifier / token 之前有一道同步复查（cancelled / 实例号），复查在写 MCP 提示那个 await 之后、与登记之间没有 await", () => {
    const noticeAt = chat.indexOf("已跳过 ${droppedMcp.length} 个不可用的 MCP");
    expect(noticeAt, "找不到写 MCP 提示的那段").toBeGreaterThan(-1);
    const fpAt = chat.indexOf('await failpoint("chat.start.afterMcpNotice");', noticeAt);
    expect(fpAt, "写 MCP 提示之后缺 failpoint chat.start.afterMcpNotice（测试在这个 await 里注入强清 + 后继接管）").toBeGreaterThan(noticeAt);
    const checkAt = chat.indexOf("if (cancelled || !isStartCurrent()) {", fpAt);
    const registerAt = chat.indexOf("myRec.callerToken = callerToken;", fpAt);
    expect(checkAt, "写 MCP 提示之后、登记之前缺实例复查").toBeGreaterThan(fpAt);
    expect(registerAt).toBeGreaterThan(checkAt);
    // 复查的 if 块自己里有 await（finishCancelled），块外到登记之间不能再有 await：跳过块本身再看
    const checkBlock = blockAfter(chat.slice(checkAt), "if (cancelled || !isStartCurrent()) {");
    const afterBlock = chat.slice(checkAt + chat.slice(checkAt).indexOf(checkBlock) + checkBlock.length, registerAt);
    expect(afterBlock, "复查块之后到登记之间不能有 await（否则复查与登记之间又让出了事件循环）").not.toMatch(/\bawait\b/);
    expect(checkBlock).toMatch(/return "started";/);
  });

  describe("R20-1 所依赖的 stop / DELETE 契约（分支不清队成立的前提）", () => {
    const listFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? listFiles(path.join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [path.join(dir, d.name)] : [],
      );
    const SRC_ROOT = path.resolve(import.meta.dirname, "..", "src");
    const callSites = (needle: string): string[] =>
      listFiles(SRC_ROOT)
        .filter((f) => stripComments(readFileSync(f, "utf-8")).includes(needle))
        .map((f) => path.relative(path.resolve(SRC_ROOT, ".."), f).split(path.sep).join("/"))
        .filter((f) => f !== "src/lib/server/chat-pending.ts")
        .sort();

    it("摘 callerToken 的调用点清单：invalidateCallerToken 只有 stop-task（chat / task 共用）与 task-stream 的 task 侧强清；cleanupChatTaskState 只有 stop-task 与 DELETE 路由——新增一个摘 token 的入口，必须回头看收口分支「不清队」是否仍成立", () => {
      expect(callSites("invalidateCallerToken(")).toEqual(["src/lib/server/stop-task.ts", "src/lib/server/task-stream.ts"]);
      expect(callSites("cleanupChatTaskState(")).toEqual(["src/app/api/tasks/[id]/route.ts", "src/lib/server/stop-task.ts"]);
    });

    it("stop-task：摘 token（同步段）→ 取消 → 取文本 + 清队 → 落「用户停止了」→ 落「未送达」卡，顺序固定", () => {
      const stop = readSource("src/lib/server/stop-task.ts");
      // runStopTaskAgent 是文件里的最后一个函数；参数类型里就有花括号，blockAfter 会截错，直接从函数头切到文件尾
      const startAt = stop.indexOf("const runStopTaskAgent = async (");
      expect(startAt, "找不到 runStopTaskAgent").toBeGreaterThan(-1);
      const body = stop.slice(startAt);
      const idx = (s: string) => {
        const i = body.indexOf(s);
        expect(i, `stop-task 里找不到 ${s}`).toBeGreaterThan(-1);
        return i;
      };
      const invalidate = idx("invalidateCallerToken(id);");
      const afterGate = idx('await failpoint("stop.afterGate");');
      const cancel = idx("cancelChatRun(id)");
      const capture = idx('failQueuedItemsCapturingTexts(id, "stopped")');
      const stopInfo = idx("meta: { stopped: true },");
      const card = idx("await noticeTalkQueueDropped(id, {");
      expect(invalidate).toBeLessThan(afterGate);
      expect(afterGate).toBeLessThan(cancel);
      expect(cancel).toBeLessThan(capture);
      expect(capture).toBeLessThan(stopInfo);
      expect(stopInfo).toBeLessThan(card);
      expect(body.slice(invalidate, body.indexOf("await flushingPartial;")), "摘 token 到首个 await 之间不能有别的 await").not.toMatch(/\bawait\b/);
    });

    it("DELETE：先 failQueuedItems(deleted) 清队、后 cleanupChatTaskState 摘 token——所以摘 token 的 DELETE 不会留下没人取走的队", () => {
      const route = readSource("src/app/api/tasks/[id]/route.ts");
      const clearAt = route.indexOf('failQueuedItems(id, { reason: "deleted" })');
      const cleanupAt = route.indexOf("cleanupChatTaskState(id);");
      expect(clearAt).toBeGreaterThan(-1);
      expect(cleanupAt).toBeGreaterThan(clearAt);
    });
  });
});
