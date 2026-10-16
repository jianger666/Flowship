/**
 * 第七轮 K2-03 / K2-04 / K2-05：task 待送达队列与空闲直送幂等表的三处缝隙。
 *
 * - K2-03：重放（drain）撞上同 key 的在途直送、等满 INFLIGHT_WAIT_MAX_MS 后回 409
 *   「同一条消息上一次发送还在处理中」。`isBusy409` 只认文案里的「正在跑 / 等它说完」，认不出它 →
 *   这条排队消息被当「非忙」丢弃（写一条「没送出去」info），而第一次直送其实可能随后失败，消息就此丢了。
 *   修法：409 带结构化标记 `code: "task_busy"`，`isBusy409` 认标记（文案子串只留作兜底）。
 * - K2-04：排队路径此前只按 clientItemId 去重——同 id 不同正文被当重复吞掉。现在 (id + 正文指纹)
 *   才算重复，与空闲直送的去重 key 同口径。
 * - K2-05：已送达表只留 2 分钟，短于队列等待（30 分钟）。直送成功后若队列里还躺着同一条（响应丢了
 *   用户重发的典型场景），delivered 过期后队列重放会再注入一遍。修法：直送成功时顺手摘掉队列里
 *   同 (id, 正文) 的那一项。
 *
 * 全走真实注入链（真 opGen / 真 lifecycle / 真队列 drain / 真 route），只 mock 读盘与「真正送达
 * agent」那一下；挂起用可控 promise、时钟用 fake timers（setTimeout / clearTimeout / setInterval /
 * clearInterval / Date 全 fake——第八轮补：此前只 fake setTimeout / Date，队列的 1 秒 drain 定时器
 * 是真 setInterval，在 fake 时钟之外自己跑，测试时序不确定，afterEach 还要靠 reset 清真定时器）。
 * 契约数值写死、不从实现 import，实现改了数字测试要报。
 *
 * 第八轮 L3-02：stopping 的 409 现在也带 `code: "task_busy"`（+ `phase: "stopping"`），第七轮
 * 「停止中的 409 不带 task_busy」那条已翻转（见文件末尾的 describe）；重放对 stopping 的来源分流在
 * tests/task-talk-queue-r8.test.ts。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 模块求值时（任何 fake 之前）抓下真实的定时器函数，供 beforeEach 核对「确实被 fake 了」
const REAL_SET_INTERVAL = globalThis.setInterval;
const REAL_CLEAR_INTERVAL = globalThis.clearInterval;

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tq-r7-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { runningTasks } = await import("@/lib/server/task-stream");
const taskStream = await import("@/lib/server/task-stream");
const taskFs = await import("@/lib/server/task-fs");
const taskRunner = await import("@/lib/server/task-runner");
const {
  __resetTaskTalkQueueForTest,
  __tickTalkQueueDrainForTest,
  enqueueTalkMessage,
  listTalkQueue,
} = await import("@/lib/server/task-talk-queue");
const {
  handleTaskQuestionInject,
  __resetTaskQuestionDedupeForTest,
} = await import("@/lib/server/task-question-inject");
const questionRoute = await import("@/app/api/tasks/[id]/question/route");

/** 等待者等第一次 settle 的上限（契约值，见 task-question-inject 的 INFLIGHT_WAIT_MAX_MS） */
const WAIT_MAX_MS = 60 * 1000;
/** 已送达表 TTL（契约值）：本文件的 K2-05 就是要越过它 */
const DELIVERED_TTL_MS = 2 * 60 * 1000;

let seq = 0;
const freshTaskId = (): string => `r7q_task_${++seq}`;

const metaOf = (id: string, runStatus: "idle" | "running" = "idle") => ({
  id,
  title: "t",
  mode: "task" as const,
  runStatus,
  repoStatus: "developing" as const,
  repoPaths: [] as string[],
  actions: [] as unknown[],
  currentActionId: null,
  mrs: [],
  events: [] as unknown[],
  createdAt: 1,
  updatedAt: 1,
});

type DeliverFn = typeof taskRunner.deliverTaskQuestion;
type DeliverResult = Awaited<ReturnType<DeliverFn>>;

const arrangeDelivery = (status: () => "idle" | "running") => {
  vi.spyOn(taskFs, "getTaskMeta").mockImplementation((async (id: string) =>
    metaOf(id, status())) as never);
  vi.spyOn(taskFs, "getTaskWithTailEvents").mockImplementation((async (
    id: string,
  ) => metaOf(id, status())) as never);
  const deliver = vi
    .spyOn(taskRunner, "deliverTaskQuestion")
    .mockResolvedValue("sent" as DeliverResult);
  vi.spyOn(taskStream, "writeUserEventAndPublishStrict").mockResolvedValue({
    id: "ev_1",
  } as never);
  // drain 丢弃时写的 info 走这里：mock 掉以便断言「有没有写过『没送出去』」
  const infoWrites = vi
    .spyOn(taskStream, "writeEventAndPublish")
    .mockResolvedValue({ id: "ev_info" } as never);
  return { deliver, infoWrites };
};

const markRunning = (taskId: string): void => {
  runningTasks.set(taskId, {
    instanceId: 1,
    agentId: "a",
    startedAt: Date.now(),
    startSnapshot: { title: "" },
    cancel: () => {},
  });
};

const body = (extra: Record<string, unknown> = {}) => ({
  text: "同一句话",
  bootArgs: { apiKey: "k", model: { id: "m" } },
  ...extra,
});

const json = async (res: Response) =>
  (await res.json()) as {
    ok?: boolean;
    deduped?: boolean;
    queued?: boolean;
    itemId?: string;
    position?: number;
    error?: string;
    code?: string;
  };

/** 让所有已就绪的微任务 / mock 的 async 链跑完（setImmediate 不被 fake） */
const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
};

const untilCalled = async (
  spy: { mock: { calls: unknown[] } },
  n: number,
): Promise<void> => {
  for (let i = 0; i < 500; i++) {
    if (spy.mock.calls.length >= n) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`等不到第 ${n} 次调用（当前 ${spy.mock.calls.length}）`);
};

const gate = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** app 输入条在 agent 正在跑时的入队请求（与 route 同形：queueIfBusy.source=app + clientItemId） */
const queueApp = (taskId: string, itemId: string, text?: string) =>
  handleTaskQuestionInject(
    taskId,
    body({ clientItemId: itemId, ...(text !== undefined ? { text } : {}) }),
    { queueIfBusy: { source: "app", clientItemId: itemId } },
  );

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  // 钉住本文件自己的 fake 配置：setInterval / clearInterval 必须被接管（drain 的 1 秒定时器靠它）。
  // afterEach 里的「fake 定时器数为 0」在 setInterval 退回真的时恒成立（真定时器不进 fake 钟），
  // 单靠它抓不住这个回退——所以这里直接比对全局函数是不是已被替换成 fake 版
  expect(globalThis.setInterval, "setInterval 没被 fake").not.toBe(REAL_SET_INTERVAL);
  expect(globalThis.clearInterval, "clearInterval 没被 fake").not.toBe(REAL_CLEAR_INTERVAL);
});

afterEach(async () => {
  runningTasks.clear();
  // 先 reset 队列（用 fake 的 clearInterval 清掉 drain 定时器）、再切回真时钟：
  // 反过来会拿真 clearInterval 去清 fake 创建的 id、定时器泄漏
  __resetTaskTalkQueueForTest();
  // drain 的 setInterval 现在是 fake 的：reset 后不该还剩任何 fake 定时器（有泄漏这里直接红）
  const leftover = vi.getTimerCount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetTaskQuestionDedupeForTest();
  await flush();
  expect(leftover).toBe(0);
});

describe("K2-04：排队去重带正文指纹（同 id 不同正文不是重复）", () => {
  it("同 clientItemId、不同正文：两条都入队（不被当重复吞掉），各自重放时送的是各自的正文", async () => {
    const taskId = freshTaskId();
    let status: "idle" | "running" = "running";
    const { deliver } = arrangeDelivery(() => status);
    markRunning(taskId);

    const a = await queueApp(taskId, "c-k4", "第一句话");
    const b = await queueApp(taskId, "c-k4", "完全不同的第二句话");
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const aj = await json(a);
    const bj = await json(b);
    expect(bj.itemId).not.toBe(aj.itemId);
    expect(bj.position).toBe(2);
    expect(listTalkQueue(taskId).map((e) => e.preview)).toEqual([
      "第一句话",
      "完全不同的第二句话",
    ]);

    // 放行后两条都真的送出去（FIFO 串行：一次 tick 一条）
    runningTasks.clear();
    status = "idle";
    await __tickTalkQueueDrainForTest(taskId);
    await __tickTalkQueueDrainForTest(taskId);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(String(deliver.mock.calls[0]?.[1])).toContain("第一句话");
    expect(String(deliver.mock.calls[1]?.[1])).toContain("完全不同的第二句话");
  });

  it("同 id 同正文（逐字重发）仍是重复：只排一条、返回同一个 itemId", async () => {
    const taskId = freshTaskId();
    arrangeDelivery(() => "running");
    markRunning(taskId);

    const a = await queueApp(taskId, "c-same", "同一句");
    const b = await queueApp(taskId, "c-same", "同一句");
    expect((await json(b)).itemId).toBe((await json(a)).itemId);
    expect(listTalkQueue(taskId)).toHaveLength(1);
  });

  it("走真实 route：同 id 不同正文各排一条", async () => {
    const taskId = freshTaskId();
    arrangeDelivery(() => "running");
    markRunning(taskId);
    const post = (text: string) =>
      questionRoute.POST(
        new Request(`http://x/api/tasks/${taskId}/question`, {
          method: "POST",
          body: JSON.stringify(
            body({ clientItemId: "c-route", queueIfBusy: true, text }),
          ),
        }),
        { params: Promise.resolve({ id: taskId }) },
      );
    expect((await post("甲")).status).toBe(202);
    expect((await post("乙")).status).toBe(202);
    expect((await post("甲")).status).toBe(202);
    expect(listTalkQueue(taskId).map((e) => e.preview)).toEqual(["甲", "乙"]);
  });

  it("入队函数本身：同 id 同 rawBody → duplicate；同 id 不同 rawBody → 新条目", () => {
    const taskId = freshTaskId();
    const first = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "a" },
      options: {},
      clientItemId: "c1",
    });
    expect(first.ok).toBe(true);
    const same = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "a" },
      options: {},
      clientItemId: "c1",
    });
    expect(same).toMatchObject({ ok: true, position: 1, duplicate: true });
    const diff = enqueueTalkMessage(taskId, {
      source: "app",
      rawBody: { text: "b" },
      options: {},
      clientItemId: "c1",
    });
    expect(diff).toMatchObject({ ok: true, position: 2 });
    expect((diff as { duplicate?: true }).duplicate).toBeUndefined();
  });
});

describe("K2-05：直送成功时顺手摘掉队列里同一条（delivered 表过期后不再重放）", () => {
  it("排队 → 响应丢了 → 空闲后用户重发直送成功（队列项当场摘掉）→ 新 run 把 drain 挡住 3 分钟 → 之后队列不再把它重放一遍", async () => {
    const taskId = freshTaskId();
    let status: "idle" | "running" = "running";
    const { deliver } = arrangeDelivery(() => status);
    markRunning(taskId);

    expect((await queueApp(taskId, "c-k5")).status).toBe(202);
    expect(listTalkQueue(taskId)).toHaveLength(1);

    // run 结束；用户没收到 202（响应丢了）、按回车重发同一条 → 直送成功
    runningTasks.clear();
    status = "idle";
    const direct = await queueApp(taskId, "c-k5");
    expect(direct.status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);
    // 同一条已经送达：队列里那份不该再留着
    expect(listTalkQueue(taskId)).toHaveLength(0);

    // 直送起了新 run：drain 被挡住；run 跑了 3 分钟——已送达表（2 分钟 TTL）早已过期，
    // 队列 TTL（30 分钟）没到
    markRunning(taskId);
    status = "running";
    await __tickTalkQueueDrainForTest(taskId);
    await vi.advanceTimersByTimeAsync(DELIVERED_TTL_MS + 60_000);
    runningTasks.clear();
    status = "idle";
    await __tickTalkQueueDrainForTest(taskId);

    // agent 只收到一遍
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });

  it("只摘 (id, 正文) 都相同的那一项：同 id 不同正文的排队项原样保留、之后照常重放", async () => {
    const taskId = freshTaskId();
    let status: "idle" | "running" = "running";
    const { deliver } = arrangeDelivery(() => status);
    markRunning(taskId);

    expect((await queueApp(taskId, "c-k5b", "排队的 B")).status).toBe(202);

    runningTasks.clear();
    status = "idle";
    // 直送的是同 id 但正文不同的 A：B 从没送达过，不能被摘掉
    expect((await queueApp(taskId, "c-k5b", "直送的 A")).status).toBe(200);
    expect(listTalkQueue(taskId).map((e) => e.preview)).toEqual(["排队的 B"]);

    await __tickTalkQueueDrainForTest(taskId);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(String(deliver.mock.calls[1]?.[1])).toContain("排队的 B");
  });

  it("直送没成功（409）不摘队：排队的那条仍在、稍后能送出去", async () => {
    const taskId = freshTaskId();
    let status: "idle" | "running" = "running";
    const { deliver } = arrangeDelivery(() => status);
    markRunning(taskId);
    expect((await queueApp(taskId, "c-k5c")).status).toBe(202);

    runningTasks.clear();
    status = "idle";
    deliver.mockResolvedValueOnce("stale" as DeliverResult);
    expect((await queueApp(taskId, "c-k5c")).status).toBe(409);
    expect(listTalkQueue(taskId)).toHaveLength(1);

    await __tickTalkQueueDrainForTest(taskId);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });

  it("不带 clientItemId 的直送不碰队列（没有幂等键，不能凭正文猜）", async () => {
    const taskId = freshTaskId();
    let status: "idle" | "running" = "running";
    arrangeDelivery(() => status);
    markRunning(taskId);
    expect(
      (
        await handleTaskQuestionInject(taskId, body(), {
          queueIfBusy: { source: "app" },
        })
      ).status,
    ).toBe(202);
    runningTasks.clear();
    status = "idle";
    expect((await handleTaskQuestionInject(taskId, body())).status).toBe(200);
    expect(listTalkQueue(taskId)).toHaveLength(1);
  });
});

describe("K2-03：忙类 409 带结构化标记，重放遇它放回队首而不是丢弃", () => {
  it("重放等同 key 的在途直送、等满上限回 409：放回队首（不写『没送出去』）；直送最终失败后下一轮重放真的送出", async () => {
    const taskId = freshTaskId();
    let status: "idle" | "running" = "running";
    const { deliver, infoWrites } = arrangeDelivery(() => status);
    markRunning(taskId);
    expect((await queueApp(taskId, "c-k3")).status).toBe(202);

    // run 结束；用户重发同一条 → 直送，挂在底层注入上（在途）
    runningTasks.clear();
    status = "idle";
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);
    const pDirect = queueApp(taskId, "c-k3");
    await untilCalled(deliver, 1);

    // drain 此刻重放同一条：同 key 在途 → 等；等满 WAIT_MAX 回 409「还在处理中」
    const pTick = __tickTalkQueueDrainForTest(taskId);
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    // 只推进到恰好等满（不留余量）：第八轮把 setInterval 也 fake 之后，放回队首会重新挂上 1 秒的 drain
    // 定时器——再多推 1 秒它就会照生产行为把刚放回的这一条又取走重放，下面「回队首」的断言就观察不到了。
    // 此前 setInterval 是真的、不随 fake 时钟走，这个余量才碰巧无害。
    await vi.advanceTimersByTimeAsync(WAIT_MAX_MS);
    await pTick;

    // 这个 409 是「忙」：条目回队首，不丢、不写「没送出去」
    expect(listTalkQueue(taskId)).toHaveLength(1);
    expect(
      infoWrites.mock.calls.filter((c) =>
        String((c as unknown[])[1] && ((c as unknown[])[1] as { text?: string }).text).includes(
          "没送出去",
        ),
      ),
    ).toHaveLength(0);

    // 直送最终失败（409）——这时队列里那条是这句话唯一的活路
    g.resolve("stale");
    expect((await pDirect).status).toBe(409);
    await __tickTalkQueueDrainForTest(taskId);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });

  it("在途等待超时的 409 带 code:task_busy（客户端 / 队列据此认忙，不靠文案子串）", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeDelivery(() => "idle");
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-k3b" }));
    await untilCalled(deliver, 1);
    const pB = handleTaskQuestionInject(taskId, body({ clientItemId: "c-k3b" }));
    await flush();
    await vi.advanceTimersByTimeAsync(WAIT_MAX_MS + 1_000);
    const b = await pB;
    expect(b.status).toBe(409);
    const bj = await json(b);
    expect(bj.error).toContain("处理中");
    expect(bj.code).toBe("task_busy");

    g.resolve("sent");
    expect((await pA).status).toBe(200);
  });

  it("agent 正在跑的 409（没带 queueIfBusy 的老调用方）同样带 code:task_busy，文案不变", async () => {
    const taskId = freshTaskId();
    arrangeDelivery(() => "running");
    markRunning(taskId);
    const res = await handleTaskQuestionInject(taskId, body());
    expect(res.status).toBe(409);
    const j = await json(res);
    expect(j.error).toBe("agent 正在跑、等它说完这轮再问");
    expect(j.code).toBe("task_busy");
  });

  it.each(["deleting", "finalizing", "reopening"] as const)(
    "非忙的 409（任务 %s）不带 task_busy：重放遇它照旧丢弃",
    async (phase) => {
      const taskId = freshTaskId();
      arrangeDelivery(() => "idle");
      const { beginChatLifecycle, clearChatGate } = await import(
        "@/lib/server/chat-gate"
      );
      beginChatLifecycle(taskId, phase);
      try {
        const res = await handleTaskQuestionInject(taskId, body());
        expect(res.status).toBe(409);
        expect((await json(res)).code).toBeUndefined();
      } finally {
        clearChatGate(taskId);
      }
    },
  );

  it("【L3-02 翻转】停止中的 409 现在带 code:task_busy（+ phase:stopping），文案不变；第七轮这里断言的是 code 缺省", async () => {
    const taskId = freshTaskId();
    arrangeDelivery(() => "idle");
    const { beginChatLifecycle, clearChatGate } = await import(
      "@/lib/server/chat-gate"
    );
    beginChatLifecycle(taskId, "stopping");
    try {
      const res = await handleTaskQuestionInject(taskId, body());
      expect(res.status).toBe(409);
      const j = (await json(res)) as { error?: string; code?: string; phase?: string };
      expect(j.error).toBe("正在停止、请稍后再试");
      expect(j.code).toBe("task_busy");
      expect(j.phase).toBe("stopping");
    } finally {
      clearChatGate(taskId);
    }
  });
});
