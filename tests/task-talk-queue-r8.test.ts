/**
 * 第八轮 L3-02：「停止中」的 409 也是会自己恢复的忙类——带 `code: "task_busy"`，队列重放遇它放回队首。
 *
 * 背景：第七轮 K2-03 给「agent 正在跑 / 在途等待超时」两类 409 打了 `task_busy`，但「正在停止」的 409
 * （lifecycle=stopping，stop 收尾结束后自己放开）没打，重放时被当「非忙」丢弃并写「没送出去」info——
 * 而 stop 的清队语义是「只清 app 来源、群来源（group_owner / group_reply）保留、空闲后照常送达」
 * （stop-task.ts：`clearTalkQueue(id, { onlySources: ["app"] })`）。重放恰好落在 stop 窗口的那一条群来源消息
 * 就这样被误丢，与「群来源保留」矛盾。
 *
 * 反例（所以不是「stopping 一律放回」）：app 来源那一条。stop 的清队发生在 `joinResourceJobs` 的 await 之后，
 * 在飞重放的那一条早被 drain `shift` 出队、不在队里，stop 清不到它；若它遇 stopping 也放回队首，
 * stop 结束后就会被重放成一次**用户点了停止之后的意外新 run**。所以：stopping 409 带 `phase: "stopping"`，
 * drain 对 (stopping + app) **不放回**（照旧丢弃并写 info，等价于 stop 清掉了它），其余来源放回。
 *
 * 覆盖：
 * - 注入链所有「stop 窗口」409 点（入口 lifecycle 闸 / stale 检查点 / 等待者醒来 / 入队前复查）在 stopping 时
 *   带 task_busy + phase；deleting / finalizing / reopening / stop 已完成后的 stale 不带；
 * - drain 的分类：真实 `handleTaskQuestionInject` 在 stop 窗口返回的 409 → group_owner 放回、app 丢弃；
 *   mock 注入返回各形态 409 → 文案兜底仍在、task_busy 放回、phase=stopping 区分来源、其他 409 丢弃；
 * - 测试质量：本文件 fake 全部四个定时器 API + Date（setInterval 也 fake，drain 的 1 秒定时器由 fake 钟驱动）。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatLifecyclePhase } from "@/lib/server/chat-gate";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tq-r8-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { runningTasks } = await import("@/lib/server/task-stream");
const taskStream = await import("@/lib/server/task-stream");
const taskFs = await import("@/lib/server/task-fs");
const taskRunner = await import("@/lib/server/task-runner");
const injectModule = await import("@/lib/server/task-question-inject");
const chatGate = await import("@/lib/server/chat-gate");
const {
  __resetTaskTalkQueueForTest,
  __tickTalkQueueDrainForTest,
  enqueueTalkMessage,
  listTalkQueue,
} = await import("@/lib/server/task-talk-queue");
const { handleTaskQuestionInject, __resetTaskQuestionDedupeForTest } = injectModule;

let seq = 0;
const freshTaskId = (): string => `r8q_task_${++seq}`;

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

const arrangeDelivery = (status: () => "idle" | "running" = () => "idle") => {
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
  const infoWrites = vi
    .spyOn(taskStream, "writeEventAndPublish")
    .mockResolvedValue({ id: "ev_info" } as never);
  return { deliver, infoWrites };
};

const discardedInfos = (infoWrites: { mock: { calls: unknown[][] } }): string[] =>
  infoWrites.mock.calls
    .map((c) => String(((c[1] ?? {}) as { text?: string }).text ?? ""))
    .filter((t) => t.includes("没送出去"));

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
    error?: string;
    code?: string;
    phase?: string;
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

const resp409 = (payload: Record<string, unknown>): Response =>
  new Response(JSON.stringify(payload), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  // 全量 fake：setInterval / clearInterval 也 fake（drain 的 1 秒定时器由 fake 钟驱动，不会泄漏成真实定时器）
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(async () => {
  // 先清队列（clearInterval 走 fake 钟、清掉 drain 定时器），再还原真实定时器
  __resetTaskTalkQueueForTest();
  expect(vi.getTimerCount(), "用例结束时不该残留任何 fake 定时器").toBe(0);
  vi.useRealTimers();
  runningTasks.clear();
  vi.restoreAllMocks();
  __resetTaskQuestionDedupeForTest();
  await flush();
});

/** 用例里 begin 的 lifecycle 都要放开，免得串到下一个用例 */
const lifecycleTaskIds = new Set<string>();
const beginLife = (taskId: string, phase: ChatLifecyclePhase): void => {
  lifecycleTaskIds.add(taskId);
  chatGate.beginChatLifecycle(taskId, phase);
};
afterEach(() => {
  for (const id of lifecycleTaskIds) chatGate.clearChatGate(id);
  lifecycleTaskIds.clear();
});

describe("L3-02：注入链里「stop 窗口」的 409 带 task_busy + phase:stopping", () => {
  it("入口 lifecycle 闸：stopping → 409 + code:task_busy + phase:stopping，文案不变", async () => {
    const taskId = freshTaskId();
    arrangeDelivery();
    beginLife(taskId, "stopping");
    const res = await handleTaskQuestionInject(taskId, body());
    expect(res.status).toBe(409);
    const j = await json(res);
    expect(j.error).toBe("正在停止、请稍后再试");
    expect(j.code).toBe("task_busy");
    expect(j.phase).toBe("stopping");
  });

  it.each(["deleting", "finalizing", "reopening"] as const)(
    "入口 lifecycle 闸：%s → 409 但不带 task_busy / phase（重放也不会好，照旧丢弃）",
    async (phase) => {
      const taskId = freshTaskId();
      arrangeDelivery();
      beginLife(taskId, phase);
      const res = await handleTaskQuestionInject(taskId, body());
      expect(res.status).toBe(409);
      const j = await json(res);
      expect(j.code).toBeUndefined();
      expect(j.phase).toBeUndefined();
    },
  );

  it("stale 检查点（deliver 返回 stale）：stop 收尾窗口内（lifecycle=stopping）带标记；stop 已完成（只剩 opGen 变化）不带", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeDelivery();

    // ① stop 窗口内：deliver 过程中 stop 开始
    deliver.mockImplementationOnce((async () => {
      beginLife(taskId, "stopping");
      return "stale";
    }) as never);
    const inWindow = await handleTaskQuestionInject(taskId, body());
    expect(inWindow.status).toBe(409);
    expect(await json(inWindow)).toMatchObject({ code: "task_busy", phase: "stopping" });
    chatGate.clearChatGate(taskId);

    // ② stop 已完成：lifecycle 放开、只剩 opGen 被 bump（世界已变，不是「稍后再试」）
    deliver.mockImplementationOnce((async () => {
      taskStream.revokeTaskOps(taskId);
      return "stale";
    }) as never);
    const afterStop = await handleTaskQuestionInject(taskId, body());
    expect(afterStop.status).toBe(409);
    const j = await json(afterStop);
    expect(j.error).toBe(taskRunner.TASK_OP_STALE_HTTP_MESSAGE);
    expect(j.code).toBeUndefined();
    expect(j.phase).toBeUndefined();
  });

  it("入队前复查（agent 在跑 + queueIfBusy，读尾部事件期间 stop 开始）：409 带标记，不入队", async () => {
    const taskId = freshTaskId();
    arrangeDelivery(() => "running");
    markRunning(taskId);
    vi.spyOn(taskFs, "getTaskWithTailEvents").mockImplementation((async (id: string) => {
      beginLife(id, "stopping");
      return metaOf(id, "running");
    }) as never);

    const res = await handleTaskQuestionInject(taskId, body(), {
      queueIfBusy: { source: "group_owner" },
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "task_busy", phase: "stopping" });
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });

  it("在途等待者醒来时 stop 已开始（lifecycle=stopping）：409 带标记", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeDelivery();
    const g = gate<DeliverResult>();
    deliver.mockImplementationOnce((() => g.promise) as never);

    const pA = handleTaskQuestionInject(taskId, body({ clientItemId: "c-w" }));
    await untilCalled(deliver, 1);
    const pB = handleTaskQuestionInject(taskId, body({ clientItemId: "c-w" }));
    await flush();

    // 等待期间 stop 开始：lifecycle=stopping，opGen 被 bump
    beginLife(taskId, "stopping");
    taskStream.revokeTaskOps(taskId);
    g.resolve("stale");

    const a = await pA;
    const b = await pB;
    expect(a.status).toBe(409);
    expect(b.status).toBe(409);
    expect(await json(b)).toMatchObject({ code: "task_busy", phase: "stopping" });
  });

  it("agent 正在跑的 409 不带 phase（它是 task_busy 但不是 stopping）", async () => {
    const taskId = freshTaskId();
    arrangeDelivery(() => "running");
    markRunning(taskId);
    const res = await handleTaskQuestionInject(taskId, body());
    expect(res.status).toBe(409);
    const j = await json(res);
    expect(j.code).toBe("task_busy");
    expect(j.phase).toBeUndefined();
  });
});

describe("L3-02：drain 重放遇 409 的分类", () => {
  /** 入一条排队项（直接走入队函数；lifecycle 必须干净） */
  const enqueue = (taskId: string, source: "app" | "group_owner", text = "排队的话") =>
    enqueueTalkMessage(taskId, {
      source,
      rawBody: { text, bootArgs: { apiKey: "k", model: { id: "m" } } },
      options: {},
      preview: text,
    });

  it("真实注入链：重放落在 stop 窗口（入口 lifecycle 闸）——group_owner 放回队首、stop 结束后照常送达（不写『没送出去』）", async () => {
    const taskId = freshTaskId();
    const { deliver, infoWrites } = arrangeDelivery();
    expect(enqueue(taskId, "group_owner", "属主在群里说的话").ok).toBe(true);

    // drain 先读一次 meta（放行判断）、注入链入口再读一次——第二次读时 stop 恰好开始
    let metaReads = 0;
    vi.spyOn(taskFs, "getTaskMeta").mockImplementation((async (id: string) => {
      metaReads += 1;
      if (metaReads === 2) beginLife(id, "stopping");
      return metaOf(id, "idle");
    }) as never);

    await __tickTalkQueueDrainForTest(taskId);
    expect(metaReads).toBe(2);
    // stop 窗口里没送出去，但放回了队首、没当成「非忙」丢弃
    expect(deliver).not.toHaveBeenCalled();
    expect(listTalkQueue(taskId)).toHaveLength(1);
    expect(discardedInfos(infoWrites)).toHaveLength(0);

    // stop 收尾结束 → 下一轮重放真的送出去（群来源保留、空闲后照常送达）
    chatGate.clearChatGate(taskId);
    await __tickTalkQueueDrainForTest(taskId);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(listTalkQueue(taskId)).toHaveLength(0);
  });

  it("真实注入链：同一窗口里的 app 来源**不放回**——丢弃并写『没送出去』，stop 结束后不会被重放成意外的新 run", async () => {
    const taskId = freshTaskId();
    const { deliver, infoWrites } = arrangeDelivery();
    expect(enqueue(taskId, "app", "用户输入条排的话").ok).toBe(true);

    let metaReads = 0;
    vi.spyOn(taskFs, "getTaskMeta").mockImplementation((async (id: string) => {
      metaReads += 1;
      if (metaReads === 2) beginLife(id, "stopping");
      return metaOf(id, "idle");
    }) as never);

    await __tickTalkQueueDrainForTest(taskId);
    expect(deliver).not.toHaveBeenCalled();
    // 队里没有了（stop 的清队清不到在飞重放的这一条，所以这里必须自己丢）
    expect(listTalkQueue(taskId)).toHaveLength(0);
    const infos = discardedInfos(infoWrites);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("停止");

    // stop 收尾结束后再 tick：没有任何东西可重放，agent 一次都没被叫起
    chatGate.clearChatGate(taskId);
    await __tickTalkQueueDrainForTest(taskId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  describe("注入返回各形态 409（mock 注入、真实 drain 分类）", () => {
    const run = async (
      source: "app" | "group_owner",
      res: Response,
    ): Promise<{ queued: number; discarded: string[]; inject: ReturnType<typeof vi.fn> }> => {
      const taskId = freshTaskId();
      const { infoWrites } = arrangeDelivery();
      const inject = vi.fn(async () => res);
      vi.spyOn(injectModule, "handleTaskQuestionInject").mockImplementation(inject as never);
      expect(enqueue(taskId, source, "排队的话").ok).toBe(true);
      await __tickTalkQueueDrainForTest(taskId);
      return {
        queued: listTalkQueue(taskId).length,
        discarded: discardedInfos(infoWrites),
        inject,
      };
    };

    it("只回文案「agent 正在跑」、不带 code（老调用方 / 测试替身）：文案兜底仍认忙 → 放回", async () => {
      const r = await run("group_owner", resp409({ error: "agent 正在跑、等它说完这轮再问" }));
      expect(r.inject).toHaveBeenCalledTimes(1);
      expect(r.queued).toBe(1);
      expect(r.discarded).toHaveLength(0);
    });

    it("只回文案「等它说完」、不带 code：兜底认忙 → 放回", async () => {
      const r = await run("app", resp409({ error: "请等它说完这一轮" }));
      expect(r.queued).toBe(1);
      expect(r.discarded).toHaveLength(0);
    });

    it("code:task_busy（无 phase）：放回，app / group_owner 都一样", async () => {
      for (const source of ["app", "group_owner"] as const) {
        const r = await run(source, resp409({ error: "还在处理中", code: "task_busy" }));
        expect(r.queued, source).toBe(1);
        expect(r.discarded, source).toHaveLength(0);
        __resetTaskTalkQueueForTest();
        vi.restoreAllMocks();
      }
    });

    it("code:task_busy + phase:stopping：group_owner 放回", async () => {
      const r = await run(
        "group_owner",
        resp409({ error: "正在停止、请稍后再试", code: "task_busy", phase: "stopping" }),
      );
      expect(r.queued).toBe(1);
      expect(r.discarded).toHaveLength(0);
    });

    it("code:task_busy + phase:stopping：app **不放回**，丢弃并写 info（stop 的清队语义：app 来源被清）", async () => {
      const r = await run(
        "app",
        resp409({ error: "正在停止、请稍后再试", code: "task_busy", phase: "stopping" }),
      );
      expect(r.queued).toBe(0);
      expect(r.discarded).toHaveLength(1);
      expect(r.discarded[0]).toContain("停止");
    });

    it("非忙、非停止中的 409（状态已变 / 删除中）：丢弃并写 info，app / group_owner 都一样", async () => {
      for (const source of ["app", "group_owner"] as const) {
        const r = await run(source, resp409({ error: "任务正在删除" }));
        expect(r.queued, source).toBe(0);
        expect(r.discarded, source).toHaveLength(1);
        __resetTaskTalkQueueForTest();
        vi.restoreAllMocks();
      }
    });
  });
});

describe("测试质量：drain 的 1 秒定时器由 fake 钟驱动（setInterval 已 fake，没有真实定时器泄漏）", () => {
  it("入队后恰有 1 个 fake 定时器；推进 1 秒触发一次真实 tick 并把条目送出去；送完定时器自行清掉", async () => {
    const taskId = freshTaskId();
    const { deliver } = arrangeDelivery();
    expect(vi.getTimerCount()).toBe(0);
    expect(
      enqueueTalkMessage(taskId, {
        source: "app",
        rawBody: { text: "定时送", bootArgs: { apiKey: "k", model: { id: "m" } } },
        options: {},
      }).ok,
    ).toBe(true);
    // setInterval 若还是真的，这里是 0（定时器不在 fake 钟里）
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(listTalkQueue(taskId)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
