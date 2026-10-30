/**
 * R14 Q8-01：后台子代理结果的「空闲唤醒」不得抢在用户已排队（已 202）的消息前面
 * （真实 chat-runner + 假 SDK；harness 写法与 chat-background-result-settle / chat-flush-rewind-gate 同款）。
 *
 * 背景：run 自然收尾时 finalizeChatRunIfCurrent 先 `void flushChatQueue`、再 `void drainBackgroundResults`。
 * flush 在第一个 await 之前就已置 drainingQueues、出队队首并占 in-flight，随后才去读任务 / 落 user_reply / send；
 * 而 drain 的「空闲：唤醒一轮」只 await 一次 getTask 就能 sendChatMessage——
 * 改前后台结果因此抢在已排队的用户消息前面起下一轮（agent.send 顺序 = FIRST, BG, USERQ），用户那条还得再等一整轮。
 * 修复：drain 遇到「队列非空 / flush 正在排空 / 有出队在飞的那条」让位，用户消息送出后那一轮收尾再调 drain；
 * 兜底：flushChatQueue 收尾（队列已空、会话空闲、确有攒着的后台结果）补调一次 drain，
 * 防止「那一轮没发出任何消息（清队 / 发送失败）」时结果永远卡在「已提示将转交、却永远不送」。
 *
 * 用例分类：
 *   - 回归：改前（BF）会红，钉住「让位」本身；
 *   - 守恒：改前后都该绿，钉住「让位之后结果不丢、不重复」（改后若让位写坏了就会红）；
 *   - 对照：不涉及让位的既有行为，改前后都绿。
 *
 * 断言只认语义（send 的归类顺序 + 「未送达主 AI」），不绑死具体措辞。
 * 等异步一律「轮询直到条件成立」，不靠固定 sleep 等结果；唯一的固定 sleep 只用在「之后不会再发生什么」的负向复核。
 * 并行隔离：先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
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
import type { Task, TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-bg-vs-queue-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockResume = vi.fn();
const mockCreate = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  closeChatSessionUnconditional,
  drainBackgroundResults,
  getPendingBackgroundResultCount,
  isChatQueueDraining,
  isChatRunActive,
  resumeChatSession,
  sendChatMessage,
} = await import("@/lib/server/chat-runner");
const {
  beginChatQueueInFlight,
  clearChatQueue,
  endChatQueueInFlight,
  enqueueChatMessage,
  getChatQueueCount,
  getChatQueueInFlight,
} = await import("@/lib/server/chat-queue");
const { emitBackgroundSubagentSettled, formatBackgroundSubagentMessage } =
  await import("@/lib/server/subagent-background");
const { clearFailpoints, setFailpoint } = await import(
  "@/lib/server/failpoints"
);
const { endChatRewind, isChatRewindInProgress, tryBeginChatRewind } =
  await import("@/lib/server/chat-gate");
const { getTask } = await import("@/lib/server/task-fs");
const { subscribeTaskStream } = await import("@/lib/server/task-stream");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-bg-vs-queue DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000014000_bg_vs_queue";
const AGENT_ID = "agent_fake_bg_vs_queue";
const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

/** 三类 send 的标识文本：首轮 / 用户排队消息 / 后台子代理结果（BG 的正文经 formatBackgroundSubagentMessage 包装后仍含它） */
const FIRST_MARK = "FIRST-Q801";
const USER_MARK = "USERQ-Q801";
const BG_MARK = "BGRESULT-Q801";

type SendKind = "FIRST" | "USERQ" | "BG" | "OTHER";
const classify = (prompt: string): SendKind => {
  if (prompt.includes(BG_MARK)) return "BG";
  if (prompt.includes(USER_MARK)) return "USERQ";
  if (prompt.includes(FIRST_MARK)) return "FIRST";
  return "OTHER";
};

/** 轮询等待的统一上限（机器高负载时留足余量） */
const WAIT = { timeout: 20_000, interval: 25 } as const;
/** 单用例超时 */
const TEST_TIMEOUT = 60_000;

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `bg vs queue ${id}`,
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

/** 本用例里 agent.send 收到的 prompt（按调用先后） */
let sends: string[] = [];
/** send 与插桩点按发生先后混排的时间线，用来断言「谁先谁后」 */
let timeline: string[] = [];

/** 首轮 run：gate 放行才收尾；可选带 steer（Cursor 本地 run 才有，pi 后端没有） */
const gatedRun = (steerImpl?: (prompt: string) => Promise<string>) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const run: {
    stream: () => AsyncGenerator<never>;
    wait: () => Promise<{ status: "finished" }>;
    cancel: ReturnType<typeof vi.fn>;
    steer?: ReturnType<typeof vi.fn>;
  } = {
    stream: async function* (): AsyncGenerator<never> {
      await gate;
    },
    wait: async () => {
      await gate;
      return { status: "finished" as const };
    },
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  if (steerImpl) run.steer = vi.fn(steerImpl);
  return { run, release };
};

/** 立刻自然结束的 run（用户排队消息 / 后台结果唤醒的那一轮） */
const quickRun = () => ({
  stream: async function* (): AsyncGenerator<never> {},
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/**
 * 起会话并发出 FIRST（首轮 run 停在 gate 上）：
 * 第 1 次 agent.send 给 gated run，之后的 send 都给立刻结束的 quickRun；
 * 传了 `second`（也是 gatedRun 的产物）则第 2 次 send 给它——用来让「用户排队消息那一轮」也停在门闸上、并可带 steer。
 */
const startSession = async (
  steerImpl?: (prompt: string) => Promise<string>,
  second?: ReturnType<typeof gatedRun>["run"],
) => {
  const first = gatedRun(steerImpl);
  const agent = {
    agentId: AGENT_ID,
    close: vi.fn(),
    send: vi.fn(async (prompt: string) => {
      sends.push(prompt);
      timeline.push(`send:${classify(prompt)}`);
      if (sends.length === 1) return first.run;
      if (sends.length === 2 && second) return second;
      return quickRun();
    }),
  };
  mockResume.mockResolvedValueOnce(agent);
  const task = asTask(makeMeta(TASK_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(await sendChatMessage(task, FIRST_MARK)).toBe("sent");
  return { agent, first, task };
};

/** 一条已完成的后台子代理结果（status=done，正文含 BG_MARK） */
const BG_EVT: Parameters<typeof emitBackgroundSubagentSettled>[1] = {
  jobId: "bg_q801",
  parentAgentId: AGENT_ID,
  description: "后台调研",
  status: "done",
  text: BG_MARK,
  durationMs: 5,
  detached: false,
};
/** 到达提示（事件流 info）里一定带的识别串：用 description 认，不绑「将转交」之类措辞 */
const BG_NOTICE_KEY = BG_EVT.description;

/** 后台结果到达 */
const emitBg = (): void => {
  emitBackgroundSubagentSettled(TASK_ID, BG_EVT);
};

/** 等后台结果「已攒进待送队列」：直接观察计数，不睡固定毫秒 */
const waitBgQueued = (n: number) =>
  vi.waitFor(
    () => expect(getPendingBackgroundResultCount(TASK_ID)).toBe(n),
    WAIT,
  );

/**
 * 用户排一条消息（只入队，不触发 flush——flush 由 run 收尾链路触发，与线上 202 排队同口径）。
 * suffix 用来区分同一场景里排的多条（都含 USER_MARK、归类仍是 USERQ）。
 */
const enqueueUser = (suffix = ""): void => {
  const text = `${USER_MARK}${suffix}`;
  const r = enqueueChatMessage(TASK_ID, {
    agentText: text,
    displayText: text,
    enqueuedAt: Date.now(),
  });
  expect(r.ok).toBe(true);
};

/** 等本场景收尾到稳定态：run 空闲、队列清空、没有 drain / in-flight、后台结果不再攒着 */
const waitQuiescent = () =>
  vi.waitFor(() => {
    expect(isChatRunActive(TASK_ID)).toBe(false);
    expect(getChatQueueCount(TASK_ID)).toBe(0);
    expect(getChatQueueInFlight(TASK_ID)).toBe(0);
    expect(isChatQueueDraining(TASK_ID)).toBe(false);
    expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
  }, WAIT);

/**
 * 监听 run 收尾的 done 帧。finalizeChatRunIfCurrent 在同一同步段里先 publish(done)、紧接着 `void flushChatQueue` /
 * `void drainBackgroundResults`；轮询（宏任务）看到 seen() === true 时，收尾里那两次调用必已发生——
 * 这是确定性的同步点，不用固定 sleep 去估「收尾跑完没有」。用完调 dispose。
 */
const watchRunDone = (): { seen: () => boolean; dispose: () => void } => {
  let seen = false;
  const dispose = subscribeTaskStream(TASK_ID, (ev) => {
    if (ev.kind === "done") seen = true;
  });
  return { seen: () => seen, dispose };
};

const infoTexts = async (): Promise<string[]> =>
  (await readEvents(TASK_ID))
    .filter((e: TaskEvent) => e.kind === "info")
    .map((e) => (e as { text?: string }).text ?? "");

/** 「N 条后台子代理的结果未送达主 AI」：只认语义，不绑措辞 */
const undeliveredInfos = async (): Promise<string[]> =>
  (await infoTexts()).filter((t) => /结果未送达主 AI/.test(t));

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  mockResume.mockReset();
  mockCreate.mockReset();
  sends = [];
  timeline = [];
  clearFailpoints();
  endChatRewind(TASK_ID); // 上一个用例若占着 rewind 门闩没放（失败中断），别带进这一个
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await settle();
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  // task-fs 的 boot recovery 惰性触发：在任务还是 idle 时先触发一次
  await getTask(TASK_ID);
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({
      apiKey: "server-key",
      defaultModel: { id: "gpt-test", params: [] },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  clearFailpoints();
  endChatRewind(TASK_ID);
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await settle();
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await settle(50);
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("run 收尾：用户排队消息 vs 后台结果的先后（Q8-01）", () => {
  it(
    "【回归】run 在跑时用户排了一条 + 后台结果攒着：收尾后 agent.send 顺序严格 = FIRST, USERQ, BG",
    async () => {
      // 保护：后台结果的「空闲唤醒」不能抢在已 202 的排队消息前面。
      // 改前：finalize 同步段里 flush 先占 draining / in-flight、drain 紧跟着 getTask→send，
      //   drain 的路径比 flush（读任务 + 落 user_reply + 检查点）短，BG 先到 agent.send → 顺序 = FIRST, BG, USERQ
      //   （USERQ 随后撞 busy 被塞回队首、等 BG 那一轮收尾再发）。
      const { first } = await startSession();
      emitBg();
      await waitBgQueued(1); // 首轮 run 无 steer：结果只能攒着
      enqueueUser();
      expect(getChatQueueCount(TASK_ID)).toBe(1);

      first.release();
      await vi.waitFor(
        () => expect(sends.length).toBeGreaterThanOrEqual(3),
        WAIT,
      );
      await waitQuiescent();

      // 归类后的完整顺序（失败时 diff 一眼看出谁抢了谁）
      expect(sends.map(classify)).toEqual(["FIRST", "USERQ", "BG"]);
      // 用户消息送的是原文、后台结果送的是 formatBackgroundSubagentMessage 的完整产物（以源码为准，不手写标签）
      expect(sends[1]).toContain(USER_MARK);
      expect(sends[2]).toContain(formatBackgroundSubagentMessage(BG_EVT));
    },
    TEST_TIMEOUT,
  );

  it(
    "【回归】用户排了两条 + 后台结果攒着：后台结果排在全部排队消息之后，两条用户消息保持 FIFO（FIRST, U1, U2, BG）",
    async () => {
      // 保护：让位不只是让第一条——flush 链式排空期间（U1 送出 → U1 那一轮收尾 → flush 出队 U2）每一次收尾 drain 都得继续让位，
      //   直到队列真正排空、BG 才送；同时用户消息之间的先后不被打乱。
      // 改前：收尾时 drain 不让位，BG 抢在 U1 之前 → 顺序 = FIRST, BG, U1, U2。
      const { first } = await startSession();
      emitBg();
      await waitBgQueued(1);
      enqueueUser("-1");
      enqueueUser("-2");
      expect(getChatQueueCount(TASK_ID)).toBe(2);

      first.release();
      await vi.waitFor(
        () => expect(sends.length).toBeGreaterThanOrEqual(4),
        WAIT,
      );
      await waitQuiescent();

      expect(sends.map(classify)).toEqual(["FIRST", "USERQ", "USERQ", "BG"]);
      expect(sends[1]).toContain(`${USER_MARK}-1`);
      expect(sends[2]).toContain(`${USER_MARK}-2`);
      expect(await undeliveredInfos()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    "【守恒】让位不丢结果：三条 send 都发生后，待送队列清零、BG 恰好一次、没有「未送达」提示、排队消息只落一个气泡",
    async () => {
      // 保护：drain 让位之后，后台结果仍由「用户消息那一轮收尾」再调 drain 送出——不卡死、不丢、不重复。
      // 改前后都该绿（改前顺序反了但结果也都送达）；改后若让位写成「直接丢 / 永远不再调 drain」就会红。
      const { first } = await startSession();
      emitBg();
      await waitBgQueued(1);
      enqueueUser();

      first.release();
      await vi.waitFor(
        () => expect(sends.length).toBeGreaterThanOrEqual(3),
        WAIT,
      );
      await waitQuiescent();
      // 负向复核（「之后不会再发生什么」）：稳定后不会冒出第 4 条 send / 重复送 BG
      await settle(250);

      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
      expect(sends).toHaveLength(3);
      expect(sends.filter((p) => classify(p) === "BG")).toHaveLength(1);
      expect(sends.filter((p) => classify(p) === "USERQ")).toHaveLength(1);
      expect(await undeliveredInfos()).toEqual([]);

      const events = await readEvents(TASK_ID);
      // 到达提示恰好一条（按 description 认），排队消息的 user_reply 气泡恰好一个（让位 / 重排不重复落盘）
      expect(
        (await infoTexts()).filter((t) => t.includes(BG_NOTICE_KEY)),
      ).toHaveLength(1);
      expect(
        events.filter(
          (e: TaskEvent) =>
            e.kind === "user_reply" &&
            ((e as { text?: string }).text ?? "").includes(USER_MARK),
        ),
      ).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "【回归/兜底】flush 这一轮没能发出任何消息（出队后处理抛错、整队作废）：后台结果不卡死，由 flush 收尾补调 drain 送出，且排在 flush 处理完之后",
    async () => {
      // 构造：用官方 failpoint `flushChatQueue.afterPersist` 在「落完 user_reply、send 之前」抛错——
      //   走 flush 的 flush_error 清队分支：队列清空、会话保留且空闲、**不启动新 run**，USERQ 永远不会 agent.send。
      // 保护两点：
      //   (a) 兜底：让位之后若再没有 run 收尾来调 drain，攒着的 BG 就会永远卡着（已提示「将转交」却再没人送）。
      //       由 flushChatQueue 尾部「队列已空 + 会话空闲 + 有攒着的结果」补调 drain 解决。
      //       ⚠️ 此点在改前（BF）天然不会卡（改前 drain 不让位、finalize 当场就送了），所以 (a) 是改后新增兜底的守卫、不靠 BF 红；
      //       已用变异验证：去掉 flush 尾部的补调 → 本用例红（等不到 BG 的 send）。
      //   (b) 顺序：BG 的 send 必须在 flush 处理完队首（failpoint 触发）之后——改前 drain 不让位，BG 抢在 flush 之前发出 → 本断言红。
      const hits: string[] = [];
      setFailpoint("flushChatQueue.afterPersist", () => {
        hits.push("afterPersist");
        timeline.push("flush:afterPersist");
        throw new Error("injected: flush 落盘后、send 前失败（Q8-01 兜底用例）");
      });
      // flush 的 catch 会 console.error 一行预期内的失败日志：吞掉它，其它 error 照常透出
      const origError = console.error.bind(console);
      const errSpy = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          if (!String(args[0]).includes("flushChatQueue")) origError(...args);
        });
      try {
        const { first } = await startSession();
        emitBg();
        await waitBgQueued(1);
        enqueueUser();

        first.release();
        await vi.waitFor(
          () => expect(sends.length).toBeGreaterThanOrEqual(2),
          WAIT,
        );
        await waitQuiescent();
        // 负向复核：USERQ 已作废、不会被偷偷重发；BG 也不会重复送
        await settle(250);
      } finally {
        errSpy.mockRestore();
      }

      // 场景确实走到了「flush 处理队首失败」那条路（而不是别的路径碰巧过了）
      expect(hits).toEqual(["afterPersist"]);
      // 顺序：FIRST → flush 处理队首（失败）→ BG；USERQ 从未 agent.send
      expect(timeline).toEqual([
        "send:FIRST",
        "flush:afterPersist",
        "send:BG",
      ]);
      expect(sends.map(classify)).toEqual(["FIRST", "BG"]);
      // BG 没卡死：待送队列清零、也没写「未送达」
      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
      expect(await undeliveredInfos()).toEqual([]);
      expect(getChatQueueCount(TASK_ID)).toBe(0);
      expect(getChatQueueInFlight(TASK_ID)).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "【回归】让位的条件各自单独成立就够：「出队在飞」/「队列非空」都拦得住唤醒，条件解除后再调 drain 才送出",
    async () => {
      // 保护：让位条件是 `队列非空 || 正在排空 || 有出队在飞` 三选一，任何一项被误删都应有用例红。
      // 前两项可以隔离出来单独验证（第三项 drainingQueues 只在 flush 内部同步段存在、无法与另两项拆开，由用例 1 兜住）。
      // 做法：不靠 sleep——run 收尾落定后**直接 await drainBackgroundResults**：让位是同步 return，
      //   若没让位则 getTask→sendChatMessage 都在这个 await 里完成，agent.send 当场可见。
      // 改前：收尾时 finalize 自己调的 drain 就已把 BG 唤醒送出 → 第一个断言（只有 FIRST）红。
      const { first } = await startSession();
      emitBg();
      await waitBgQueued(1);

      // 条件 A：只有「出队在飞」（队列空、没人在排空）
      const runDone = watchRunDone();
      beginChatQueueInFlight(TASK_ID, "q801_inflight_probe");
      first.release();
      try {
        // done 帧之后收尾里的 flush / drain 调用已发生（见 watchRunDone）；此后才改条件，互不串扰
        await vi.waitFor(() => expect(runDone.seen()).toBe(true), WAIT);
      } finally {
        runDone.dispose();
      }
      expect(isChatRunActive(TASK_ID)).toBe(false);
      await drainBackgroundResults(TASK_ID);
      expect(sends.map(classify)).toEqual(["FIRST"]);
      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(1);

      // 条件 B：只有「队列非空」（出队在飞已解除、没人在排空——enqueue 本身不触发 flush）
      endChatQueueInFlight(TASK_ID);
      enqueueUser();
      expect(getChatQueueInFlight(TASK_ID)).toBe(0);
      expect(isChatQueueDraining(TASK_ID)).toBe(false);
      await drainBackgroundResults(TASK_ID);
      expect(sends.map(classify)).toEqual(["FIRST"]);
      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(1);

      // 条件全部解除：再调 drain 才送出（结果一直攒着、没丢）
      clearChatQueue(TASK_ID);
      await drainBackgroundResults(TASK_ID);
      await vi.waitFor(
        () => expect(sends.map(classify)).toEqual(["FIRST", "BG"]),
        WAIT,
      );
      await waitQuiescent();
      expect(await undeliveredInfos()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

describe("让位条件「flush 正在排空」可独立成立（Q8-01）", () => {
  it(
    "【回归】flush 挂在落盘后 / send 前、期间队列被清空（in-flight 一并清零）：drain 仍因「正在排空」让位，BG 不抢在这条出队消息前面",
    async () => {
      // 保护：让位条件里的 `drainingQueues.has`——它能独立于另两项成立：
      //   flush 已占 draining 并出队队首，中途 clearChatQueue（用户停止 / 回退清队）会把队列与 in-flight 一并清零，
      //   此刻队列空、in-flight = 0，只剩 draining 在表明「flush 还在处理那一条」。去掉这一项，drain 就会抢在它前面唤醒。
      // 做法：官方 failpoint 把 flush 挂在「落完 user_reply、send 之前」，命中后清队，再直接 await drain 看有没有让位。
      // 改前：finalize 自己调的 drain 早已把 BG 从待送队列取走并唤醒（待送计数 1→0、sends 里多出 BG）→ 命中时的断言红。
      let flushHit = false;
      let letFlushGo!: () => void;
      const flushGate = new Promise<void>((r) => {
        letFlushGo = r;
      });
      setFailpoint("flushChatQueue.afterPersist", async () => {
        flushHit = true;
        await flushGate;
      });

      const { first } = await startSession();
      emitBg();
      await waitBgQueued(1);
      enqueueUser();
      first.release();
      await vi.waitFor(() => expect(flushHit).toBe(true), WAIT);

      try {
        // 此刻 flush 占着 draining、已把 USERQ 出队：模拟清队后「只剩 draining」
        expect(isChatQueueDraining(TASK_ID)).toBe(true);
        clearChatQueue(TASK_ID);
        expect(getChatQueueCount(TASK_ID)).toBe(0);
        expect(getChatQueueInFlight(TASK_ID)).toBe(0);
        expect(isChatQueueDraining(TASK_ID)).toBe(true);

        // 让位是同步 return：没让位的话 getTask→sendChatMessage 都在这个 await 里完成、agent.send 当场可见
        await drainBackgroundResults(TASK_ID);
        expect(getPendingBackgroundResultCount(TASK_ID)).toBe(1);
        expect(sends.map(classify)).toEqual(["FIRST"]);
      } finally {
        letFlushGo(); // 失败也要放行 flush，别把会话挂死
      }

      // 放行后收尾：BG 最终仍被送出——恰好一次、不丢、不写「未送达」
      await vi.waitFor(
        () => expect(sends.map(classify)).toContain("BG"),
        WAIT,
      );
      await waitQuiescent();
      await settle(250); // 负向复核：不会重复送 BG
      expect(sends.filter((p) => classify(p) === "BG")).toHaveLength(1);
      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
      expect(await undeliveredInfos()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

describe("flush 收尾的兜底只在会话空闲时介入（Q8-01）", () => {
  it(
    "【回归】flush 已把排队消息发出去、这一轮还在跑：兜底不介入——后台结果不被 steer 进这一轮、继续攒着，等这一轮收尾再单独唤醒（FIRST, USERQ, BG）",
    async () => {
      // 保护：flush 收尾的兜底（队列已空 + 有攒着的结果 → 补调 drain）必须同时要求「会话空闲」。
      //   flush 刚把排队消息发出去时，这一轮的 run 正在跑：若兜底此时也调 drain，drain 的「run 在跑」分支会把后台结果
      //   steer 进这一轮（只要这一轮可 steer）——与「等这一轮收尾再送」的口径不同，也是改前没有的行为
      //   （改前 flush 收尾根本没有这个补调，后台结果一律等收尾）。
      // 构造：首轮 run 无 steer（后台结果只能攒着）；用户排队消息那一轮是**带 steer 的门闸 run**——兜底若误介入，它的 steer 会被调到。
      // 改前（BF）：本用例天然绿（没有兜底、结果等收尾）——它是改后新增兜底的守卫，不靠 BF 红；
      //   已用变异验证：去掉兜底里的 `!isChatRunActive` → 本用例红（steer 被调到、待送计数提前归 0）。
      const second = gatedRun(async () => "complete_delivered");
      const { first } = await startSession(undefined, second.run);
      emitBg();
      await waitBgQueued(1); // 首轮 run 无 steer：结果只能攒着
      enqueueUser();

      first.release();
      // flush 把 USERQ 发给了第 2 轮（门闸 run，还在跑），随后 flush 本身收尾（不再 draining）
      await vi.waitFor(
        () => expect(sends.map(classify)).toEqual(["FIRST", "USERQ"]),
        WAIT,
      );
      await vi.waitFor(() => {
        expect(isChatQueueDraining(TASK_ID)).toBe(false);
        expect(getChatQueueInFlight(TASK_ID)).toBe(0);
      }, WAIT);
      expect(isChatRunActive(TASK_ID)).toBe(true);
      // 负向复核（「之后不会再发生什么」）：兜底没把后台结果 steer 进第 2 轮，也没把它取走
      await settle(250);
      expect(second.run.steer).not.toHaveBeenCalled();
      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(1);
      expect(sends.map(classify)).toEqual(["FIRST", "USERQ"]);

      // 第 2 轮收尾：结果这时才单独唤醒一轮（第 3 次 send），恰好一次、不写「未送达」
      second.release();
      await vi.waitFor(
        () => expect(sends.map(classify)).toEqual(["FIRST", "USERQ", "BG"]),
        WAIT,
      );
      await waitQuiescent();
      await settle(250); // 负向复核：不会重复送 BG
      expect(sends.filter((p) => classify(p) === "BG")).toHaveLength(1);
      expect(second.run.steer).not.toHaveBeenCalled();
      expect(await undeliveredInfos()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

describe("flush 收尾的兜底撞 rewind 门闩（Q8-01；审查 AI 预审 BQ11）", () => {
  it(
    "【回归/兜底】flush 收尾时 rewind 门闩占着（队列已空、会话空闲、有攒着的后台结果）：兜底仍交给 drain——门闩放开后结果被送出恰好一次",
    async () => {
      // 保护：flush 收尾的兜底不能自己拦 rewind 门闩。drain 撞门闩时（会话空闲）会 scheduleQueueDrainAfterGate，
      //   等门闩解除再补；兜底若也拦着，就再没有人调 drain——回退最终被拒（找不到检查点 / 恢复失败…）后，
      //   会话空闲、结果攒着，「已提示将转交、却永远不送」，要等下一轮收尾或用户发话。
      // 构造：官方 failpoint `flushChatQueue.afterPersist` 在「落完 user_reply、send 之前」先占 rewind 门闩、再抛错——
      //   走 flush_error 清队分支：队列清空、会话保留且空闲、不启动新 run；flush 的收尾兜底此刻正好看到「门闩占着」。
      // 门闩占着期间不往里送（回退若成功，会话马上关、结果随之作废）；放开（= 回退被拒）后补送恰好一次。
      // ⚠️ BF 红只是因为改前 drain 不让位（finalize 当场就把 BG 送了，门闩还没占）；这条用例真正的守卫对象是兜底里**没有**
      //   `!isChatRewindInProgress`——已用变异验证：加回这一句 → 本用例红（放开门闩后等不到 BG 的 send）。
      let gateTaken = false;
      setFailpoint("flushChatQueue.afterPersist", () => {
        gateTaken = tryBeginChatRewind(TASK_ID);
        timeline.push("flush:afterPersist+gate");
        throw new Error(
          "injected: flush 落盘后、send 前失败（Q8-01 兜底撞 rewind 门闩用例）",
        );
      });
      // flush 的 catch 会 console.error 一行预期内的失败日志：吞掉它，其它 error 照常透出
      const origError = console.error.bind(console);
      const errSpy = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          if (!String(args[0]).includes("flushChatQueue")) origError(...args);
        });
      try {
        const { first } = await startSession();
        emitBg();
        await waitBgQueued(1);
        enqueueUser();

        first.release();
        // flush 处理队首失败（占了门闩、清了队）并走完收尾
        await vi.waitFor(() => expect(gateTaken).toBe(true), WAIT);
        await vi.waitFor(() => {
          expect(isChatQueueDraining(TASK_ID)).toBe(false);
          expect(getChatQueueCount(TASK_ID)).toBe(0);
          expect(getChatQueueInFlight(TASK_ID)).toBe(0);
        }, WAIT);
        expect(isChatRewindInProgress(TASK_ID)).toBe(true);
        expect(isChatRunActive(TASK_ID)).toBe(false);
        // 门闩占着期间：结果不往里送、也没丢。负向复核（「门闩没放开之前不会发生什么」）：
        // 等够一个以上的补 drain 轮询周期（250ms），确认补 drain 是在等门闩、而不是抢跑
        await settle(600);
        expect(sends.map(classify)).toEqual(["FIRST"]);
        expect(getPendingBackgroundResultCount(TASK_ID)).toBe(1);
        expect(isChatRewindInProgress(TASK_ID)).toBe(true);

        // 放开门闩（= 回退最终被拒、会话还在且空闲）：攒着的结果由补 drain 送出
        endChatRewind(TASK_ID);
        await vi.waitFor(
          () => expect(sends.map(classify)).toEqual(["FIRST", "BG"]),
          WAIT,
        );
        await waitQuiescent();
        await settle(250); // 负向复核：不会重复送 BG
      } finally {
        endChatRewind(TASK_ID); // 失败也要放门闩，别把别的用例挂死
        errSpy.mockRestore();
      }

      // 场景确实走到了「flush 处理队首失败 + 门闩占着」那条路
      expect(gateTaken).toBe(true);
      expect(timeline).toEqual([
        "send:FIRST",
        "flush:afterPersist+gate",
        "send:BG",
      ]);
      expect(sends.map(classify)).toEqual(["FIRST", "BG"]);
      expect(sends.filter((p) => classify(p) === "BG")).toHaveLength(1);
      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
      expect(await undeliveredInfos()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

describe("不涉及让位的既有行为（对照）", () => {
  it(
    "【对照】没有排队消息时，后台结果照常在 run 收尾后唤醒一轮：FIRST, BG",
    async () => {
      // 保护：让位只在「用户排了队」时生效；队列为空时后台结果的空闲唤醒不能被误伤成「永远不送」。
      // 改前后都该绿。
      const { first } = await startSession();
      emitBg();
      await waitBgQueued(1);
      expect(getChatQueueCount(TASK_ID)).toBe(0);

      first.release();
      await vi.waitFor(
        () => expect(sends.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      await waitQuiescent();
      await settle(250); // 负向复核：不会重复送

      expect(sends.map(classify)).toEqual(["FIRST", "BG"]);
      expect(sends[1]).toContain("[BACKGROUND_SUBAGENT_RESULT]");
      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
      expect(await undeliveredInfos()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    "【对照】后台结果在 run 还在跑时被 steer 吸收：不单独唤醒、不攒着，随后用户排队消息照常是下一条 send",
    async () => {
      // 保护：能 steer 的 run 上，后台结果走「插进当前这一轮」那条路（delivered），
      // 既不进待送队列、也不会在收尾时多唤醒一轮；排队消息的送出不受影响。改前后都该绿。
      const { first } = await startSession(async () => "complete_delivered");
      emitBg();
      await vi.waitFor(
        () => expect(first.run.steer).toHaveBeenCalledTimes(1),
        WAIT,
      );
      expect(String(first.run.steer!.mock.calls[0]?.[0])).toContain(BG_MARK);
      // 已被这一轮收下：不在待送队列里
      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);

      enqueueUser();
      first.release();
      await vi.waitFor(
        () => expect(sends.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      await waitQuiescent();
      await settle(250); // 负向复核：BG 不会再被单独唤醒一轮

      expect(sends.map(classify)).toEqual(["FIRST", "USERQ"]);
      expect(first.run.steer).toHaveBeenCalledTimes(1);
      expect(getPendingBackgroundResultCount(TASK_ID)).toBe(0);
      expect(await undeliveredInfos()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
