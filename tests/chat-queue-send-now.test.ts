/**
 * send_now 编排单测：take → stop → start 顺序；404 / 400 / skipPersistEvent 透传
 */
import { describe, expect, it, vi } from "vitest";

import type { QueuedChatMsg } from "@/lib/server/chat-queue";
import {
  sendQueuedChatMessageNow,
  type SendNowDeps,
} from "@/lib/server/chat-queue-send-now";
import type { Task } from "@/lib/types";

const makeTask = (id: string): Task =>
  ({
    id,
    mode: "chat",
    title: "t",
    runStatus: "running",
    repoStatus: "active",
    repoPaths: [],
    actions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

const makeMsg = (overrides: Partial<QueuedChatMsg> = {}): QueuedChatMsg => ({
  itemId: "cq_test_1",
  agentText: "agent final text",
  displayText: "user text",
  enqueuedAt: 1,
  ...overrides,
});

const validBoot = {
  apiKey: "sk-test",
  model: { id: "composer-2" },
};

describe("sendQueuedChatMessageNow 编排", () => {
  it("调用顺序：take → stop → start，且 start 收到取出的条目", async () => {
    const order: string[] = [];
    const taken = makeMsg({ skipPersistEvent: true });
    const task = makeTask("t_order");

    const deps: SendNowDeps = {
      getTask: vi.fn(async () => task),
      take: vi.fn(() => {
        order.push("take");
        return taken;
      }),
      stop: vi.fn(async () => {
        order.push("stop");
        return { hadAgent: true, task };
      }),
      start: vi.fn(async (_id, msg) => {
        order.push("start");
        expect(msg).toBe(taken);
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }),
    };

    const res = await sendQueuedChatMessageNow(
      "t_order",
      "cq_test_1",
      validBoot,
      deps,
    );
    expect(res.status).toBe(202);
    expect(order).toEqual(["take", "stop", "start"]);
    expect(deps.take).toHaveBeenCalledWith("t_order", "cq_test_1");
    expect(deps.stop).toHaveBeenCalledWith(task);
    expect(deps.start).toHaveBeenCalledWith("t_order", taken, {
      apiKey: validBoot.apiKey,
      model: validBoot.model,
    });
  });

  it("条目不存在 → 404，且不调 stop/start", async () => {
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_404")),
      take: vi.fn(() => null),
      stop: vi.fn(async () => ({ hadAgent: false, task: makeTask("t_404") })),
      start: vi.fn(async () => new Response("should not", { status: 500 })),
    };

    const res = await sendQueuedChatMessageNow(
      "t_404",
      "missing",
      validBoot,
      deps,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/找不到/);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("缺 bootArgs.apiKey → 400，且不调 take/stop/start", async () => {
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_400")),
      take: vi.fn(() => makeMsg()),
      stop: vi.fn(async () => ({ hadAgent: false, task: makeTask("t_400") })),
      start: vi.fn(async () => new Response("should not", { status: 500 })),
    };

    const res = await sendQueuedChatMessageNow("t_400", "cq_1", undefined, deps);
    expect(res.status).toBe(400);
    expect(deps.getTask).not.toHaveBeenCalled();
    expect(deps.take).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("bootArgs.model 非法 → 400", async () => {
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_model")),
      take: vi.fn(() => makeMsg()),
      stop: vi.fn(async () => ({ hadAgent: false, task: makeTask("t_model") })),
      start: vi.fn(async () => new Response("should not", { status: 500 })),
    };

    const res = await sendQueuedChatMessageNow(
      "t_model",
      "cq_1",
      { apiKey: "sk", model: { id: "" } as never },
      deps,
    );
    expect(res.status).toBe(400);
    expect(deps.take).not.toHaveBeenCalled();
  });

  it("skipPersistEvent 透传到 start", async () => {
    const taken = makeMsg({
      skipPersistEvent: true,
      agentText: "prebuilt with skill",
    });
    let startedMsg: QueuedChatMsg | undefined;
    const start: SendNowDeps["start"] = async (_id, msg) => {
      startedMsg = msg;
      return new Response("{}", { status: 202 });
    };
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_skip")),
      take: vi.fn(() => taken),
      stop: vi.fn(async () => ({
        hadAgent: true,
        task: makeTask("t_skip"),
      })),
      start,
    };

    await sendQueuedChatMessageNow("t_skip", taken.itemId, validBoot, deps);
    expect(startedMsg?.skipPersistEvent).toBe(true);
    expect(startedMsg?.agentText).toBe("prebuilt with skill");
  });

  it("其余排队保留：stop 前救出、start 后原样塞回（顺序不变）", async () => {
    const taken = makeMsg({ itemId: "cq_target" });
    const rest = [
      makeMsg({ itemId: "cq_a", displayText: "a" }),
      makeMsg({ itemId: "cq_b", displayText: "b" }),
    ];
    let requeued: QueuedChatMsg[] = [];
    let stoppedAfterDrain: QueuedChatMsg[] | null = null;
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_keep")),
      take: vi.fn(() => taken),
      drainRest: vi.fn(() => {
        // drain 发生在 take 之后、stop 之前
        return [...rest];
      }),
      requeueRest: vi.fn((_: string, msgs: QueuedChatMsg[]) => {
        requeued = [...msgs];
      }),
      stop: vi.fn(async () => {
        // stop 时队里已没有其余条（被救出去了）——靠 drain 顺序保证
        stoppedAfterDrain = [];
        return { hadAgent: true, task: makeTask("t_keep") };
      }),
      start: vi.fn(async () => new Response("{}", { status: 202 })),
    };

    const res = await sendQueuedChatMessageNow(
      "t_keep",
      "cq_target",
      validBoot,
      deps,
    );
    expect(res.status).toBe(202);
    expect(deps.drainRest).toHaveBeenCalledWith("t_keep");
    expect(stoppedAfterDrain).toEqual([]);
    // start 之后塞回、顺序不变
    expect(requeued.map((m) => m.itemId)).toEqual(["cq_a", "cq_b"]);
    expect(requeued[0]?.displayText).toBe("a");
  });

  it("stop 抛错 → 目标条回队首、其余跟回，一条不丢", async () => {
    const taken = makeMsg({ itemId: "cq_target" });
    const rest = [makeMsg({ itemId: "cq_a" })];
    const requeued: string[] = [];
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask("t_stopfail")),
      take: vi.fn(() => taken),
      drainRest: vi.fn(() => [...rest]),
      requeueRest: vi.fn((_: string, msgs: QueuedChatMsg[]) => {
        requeued.push(...msgs.map((m) => m.itemId));
      }),
      stop: vi.fn(async () => {
        throw new Error("stop boom");
      }),
      start: vi.fn(async () => new Response("unreached", { status: 500 })),
    };
    // 真实 enqueueChatMessageFront 会写全局 map（fake task 无副作用）；
    // 这里只断言其余队走了 requeue、start 没被调到
    await expect(
      sendQueuedChatMessageNow("t_stopfail", "cq_target", validBoot, deps),
    ).rejects.toThrow("stop boom");
    expect(deps.start).not.toHaveBeenCalled();
    expect(requeued).toEqual(["cq_a"]);
  });

  it("真实队列：同 id 塞回被幂等受理、队里只剩其余条", async () => {
    const { enqueueChatMessage, listQueuedChatMessages, clearChatQueue } =
      await import("@/lib/server/chat-queue");
    const tid = `t_real_${Date.now()}`;
    clearChatQueue(tid);
    const seed = ["one", "two", "three"].map((t, i) =>
      enqueueChatMessage(tid, {
        itemId: `cq_real_${i}`,
        agentText: t,
        displayText: t,
        enqueuedAt: Date.now(),
      }),
    );
    expect(seed.every((r) => r.ok)).toBe(true);
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => makeTask(tid)),
      // take/drain/requeue 走默认真实实现，只 mock 掉 stop（不真清）与 start
      stop: vi.fn(async () => ({ hadAgent: true, task: makeTask(tid) })),
      start: vi.fn(async () => new Response("{}", { status: 202 })),
      take: (await import("@/lib/server/chat-queue")).takeQueuedChatMessage,
    };
    // 目标取中间那条
    const res = await sendQueuedChatMessageNow(
      tid,
      "cq_real_1",
      validBoot,
      deps,
    );
    expect(res.status).toBe(202);
    // 队里剩下 one/three，顺序不变；two 被 start 消费
    expect(listQueuedChatMessages(tid).map((m) => m.itemId)).toEqual([
      "cq_real_0",
      "cq_real_2",
    ]);
    clearChatQueue(tid);
  });
});

describe("sendQueuedChatMessageNow · steer 插话路径", () => {
  /** 真实队列 + 可控 steer 依赖：断言消息状态机，不碰 SDK / 落盘 */
  const setup = async (opts?: {
    steerImpl?: () => Promise<
      "delivered" | "followup" | "cancelled" | "replaced"
    >;
    canSteer?: boolean;
    persistOk?: boolean | "task_gone";
    runActive?: boolean;
    hasSession?: boolean;
    extraMsg?: Partial<QueuedChatMsg>;
  }) => {
    const queue = await import("@/lib/server/chat-queue");
    const tid = `t_steer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    queue.clearChatQueue(tid);
    const order: string[] = [];
    const enq = (id: string, text: string, extra?: Partial<QueuedChatMsg>) =>
      queue.enqueueChatMessage(tid, {
        itemId: id,
        agentText: text,
        displayText: text,
        enqueuedAt: Date.now(),
        ...extra,
      });
    enq("cq_a", "a");
    enq("cq_target", "插话内容", opts?.extraMsg);
    enq("cq_c", "c");

    const task = makeTask(tid);
    const steerDeps = {
      canSteer: vi.fn(() => opts?.canSteer ?? true),
      flushAssistant: vi.fn(async () => {
        order.push("flushAssistant");
      }),
      persistReply: vi.fn(async (_t: Task, head: QueuedChatMsg) => {
        order.push("persist");
        if (opts?.persistOk === false) {
          return { ok: false as const, reason: "persist_failed" as const };
        }
        if (opts?.persistOk === "task_gone") {
          return { ok: false as const, reason: "task_gone" as const };
        }
        queue.markMessagePersisted(tid, head.itemId);
        return { ok: true as const };
      }),
      steer: vi.fn(async (id: string, prompt: string) => {
        void id;
        void prompt;
        order.push("steer");
        return opts?.steerImpl ? opts.steerImpl() : ("delivered" as const);
      }),
      isRunActive: vi.fn(() => opts?.runActive ?? true),
      hasSession: vi.fn(() => opts?.hasSession ?? true),
      flushQueue: vi.fn(async () => {
        order.push("flushQueue");
      }),
    };
    const deps: SendNowDeps = {
      getTask: vi.fn(async () => task),
      take: queue.takeQueuedChatMessage,
      stop: vi.fn(async () => ({ hadAgent: true, task })),
      start: vi.fn(async () => new Response("{}", { status: 202 })),
      steer: steerDeps,
    };
    return { queue, tid, order, deps, steerDeps };
  };

  /** 等 fire-and-forget 的收尾（steer 落定后的 settle / 重排）跑完 */
  const settleTail = () => new Promise((r) => setTimeout(r, 10));

  it("能 steer：不 stop、不 start；先冲半截回复再落盘再 steer；delivered → handedOff", async () => {
    const { queue, tid, order, deps, steerDeps } = await setup({
      extraMsg: {
        imageAbsPaths: ["/tmp/a.png"],
        attachmentAbsPaths: ["/tmp/b.txt"],
      },
    });

    const res = await sendQueuedChatMessageNow(
      tid,
      "cq_target",
      validBoot,
      deps,
    );
    await settleTail();

    expect(res.status).toBe(202);
    const body = (await res.json()) as { steered?: boolean; itemId?: string };
    expect(body.steered).toBe(true);
    expect(body.itemId).toBe("cq_target");
    expect(order).toEqual(["flushAssistant", "persist", "steer"]);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
    // 喂给模型的文本与普通 send 同口径（正文 + 附件段）
    const prompt = steerDeps.steer.mock.calls[0]?.[1] ?? "";
    expect(prompt).toContain("插话内容");
    expect(prompt).toContain("[ATTACHED_IMAGES]");
    expect(prompt).toContain("/tmp/a.png");
    expect(prompt).toContain("[ATTACHED_PATHS]");
    expect(prompt).toContain("/tmp/b.txt");
    // 其余排队原样保留（不像打断重发那样重新编排）
    expect(queue.listQueuedChatMessages(tid).map((m) => m.itemId)).toEqual([
      "cq_a",
      "cq_c",
    ]);
    expect(queue.isMessageHandedOff(tid, "cq_target")).toBe(true);
    queue.clearChatQueue(tid);
  });

  it("HTTP 不等 steer：steer 还挂着就已返回 202，operation 停在 persisted、落定后才 handedOff", async () => {
    let release!: (v: "delivered") => void;
    const pending = new Promise<"delivered">((r) => {
      release = r;
    });
    const { queue, tid, deps } = await setup({ steerImpl: () => pending });

    const res = await sendQueuedChatMessageNow(
      tid,
      "cq_target",
      validBoot,
      deps,
    );
    expect(res.status).toBe(202);
    await settleTail();
    expect(queue.getMessageOperation(tid, "cq_target")?.phase).toBe(
      "persisted",
    );
    expect(queue.isMessageHandedOff(tid, "cq_target")).toBe(false);

    release("delivered");
    await settleTail();
    expect(queue.isMessageHandedOff(tid, "cq_target")).toBe(true);
    queue.clearChatQueue(tid);
  });

  it("followup（run 仍在跑）：排回队首并标已落盘，不抢着 flush", async () => {
    const { queue, tid, deps, steerDeps } = await setup({
      steerImpl: async () => "followup",
      runActive: true,
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();

    expect(
      queue.listQueuedChatMessages(tid).map((m) => m.itemId),
    ).toEqual(["cq_target", "cq_a", "cq_c"]);
    // 气泡已经落过——后续 flush 不能再落一条重复的（快照不带该字段，取队首看真身）
    expect(queue.dequeueChatMessage(tid)?.skipPersistEvent).toBe(true);
    expect(steerDeps.flushQueue).not.toHaveBeenCalled();
    expect(queue.isMessageOperationTerminal(tid, "cq_target")).toBe(false);
    queue.clearChatQueue(tid);
  });

  it("followup（run 已空闲、会话还在）：排回队首并主动 flush", async () => {
    const { queue, tid, deps, steerDeps } = await setup({
      steerImpl: async () => "followup",
      runActive: false,
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();

    expect(queue.listQueuedChatMessages(tid)[0]?.itemId).toBe("cq_target");
    expect(steerDeps.flushQueue).toHaveBeenCalledWith(tid);
    queue.clearChatQueue(tid);
  });

  it("followup 但会话已没了 → 记 no_session 失败，不塞回悬空", async () => {
    const { queue, tid, deps } = await setup({
      steerImpl: async () => "followup",
      runActive: false,
      hasSession: false,
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();

    expect(queue.listQueuedChatMessages(tid).map((m) => m.itemId)).toEqual([
      "cq_a",
      "cq_c",
    ]);
    expect(queue.findRecentSettledEntry(tid, "cq_target")?.outcome).toBe(
      "no_session",
    );
    queue.clearChatQueue(tid);
  });

  it("steer 挂着期间用户停止 / 回退清了队（generation 变）→ followup 不得复活，记 stopped", async () => {
    let release!: (v: "followup") => void;
    const pending = new Promise<"followup">((r) => {
      release = r;
    });
    const { queue, tid, deps } = await setup({ steerImpl: () => pending });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    queue.clearChatQueue(tid); // 模拟 stop / rewind 清队（generation +1）
    release("followup");
    await settleTail();

    expect(queue.listQueuedChatMessages(tid)).toEqual([]);
    expect(queue.findRecentSettledEntry(tid, "cq_target")?.outcome).toBe(
      "stopped",
    );
  });

  it("cancelled（run 被停止）→ 记 stopped，不重排", async () => {
    const { queue, tid, deps } = await setup({
      steerImpl: async () => "cancelled",
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();

    expect(queue.findRecentSettledEntry(tid, "cq_target")?.outcome).toBe(
      "stopped",
    );
    expect(queue.listQueuedChatMessages(tid).map((m) => m.itemId)).toEqual([
      "cq_a",
      "cq_c",
    ]);
    queue.clearChatQueue(tid);
  });

  it("replaced（重连换掉实例、用户没停）+ 当下无会话 → 照样重排回队首，不记 no_session、不主动 flush", async () => {
    // 重连链退避 / resume 的几秒里表内没有会话是常态；此时按「会话没了」作废 = 静默丢用户的话
    const { queue, tid, deps, steerDeps } = await setup({
      steerImpl: async () => "replaced",
      runActive: false,
      hasSession: false,
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();

    expect(queue.listQueuedChatMessages(tid).map((m) => m.itemId)).toEqual([
      "cq_target",
      "cq_a",
      "cq_c",
    ]);
    // 气泡已落过：后续 flush 不能再落一条重复的
    expect(queue.dequeueChatMessage(tid)?.skipPersistEvent).toBe(true);
    expect(queue.isMessageOperationTerminal(tid, "cq_target")).toBe(false);
    // 无会话时 flushChatQueue 会按 no_session 清整队——绝不能主动调
    expect(steerDeps.flushQueue).not.toHaveBeenCalled();
    queue.clearChatQueue(tid);
  });

  it("replaced + 会话已被重连接回且空闲 → 重排并主动 flush", async () => {
    const { queue, tid, deps, steerDeps } = await setup({
      steerImpl: async () => "replaced",
      runActive: false,
      hasSession: true,
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();

    expect(queue.listQueuedChatMessages(tid)[0]?.itemId).toBe("cq_target");
    expect(steerDeps.flushQueue).toHaveBeenCalledWith(tid);
    queue.clearChatQueue(tid);
  });

  it("replaced + 新 run 已在跑 → 重排、不抢着 flush（等收尾的链式 flush）", async () => {
    const { queue, tid, deps, steerDeps } = await setup({
      steerImpl: async () => "replaced",
      runActive: true,
      hasSession: true,
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();

    expect(queue.listQueuedChatMessages(tid)[0]?.itemId).toBe("cq_target");
    expect(steerDeps.flushQueue).not.toHaveBeenCalled();
    queue.clearChatQueue(tid);
  });

  it("replaced 但期间用户停止 / 回退清了队（generation 变）→ 不得复活，记 stopped", async () => {
    let release!: (v: "replaced") => void;
    const pending = new Promise<"replaced">((r) => {
      release = r;
    });
    const { queue, tid, deps, steerDeps } = await setup({
      steerImpl: () => pending,
      hasSession: false,
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    queue.clearChatQueue(tid); // 模拟 stop / 重连放弃清队（generation +1）
    release("replaced");
    await settleTail();

    expect(queue.listQueuedChatMessages(tid)).toEqual([]);
    expect(queue.findRecentSettledEntry(tid, "cq_target")?.outcome).toBe(
      "stopped",
    );
    expect(steerDeps.flushQueue).not.toHaveBeenCalled();
  });

  it("replaced 只重排一次：队里只有一份、不会再 steer 第二次", async () => {
    const { queue, tid, deps, steerDeps } = await setup({
      steerImpl: async () => "replaced",
      runActive: true,
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();
    await settleTail();

    expect(
      queue.listQueuedChatMessages(tid).filter((m) => m.itemId === "cq_target"),
    ).toHaveLength(1);
    expect(steerDeps.steer).toHaveBeenCalledTimes(1);
    queue.clearChatQueue(tid);
  });

  it("steer 抛错也不丢消息：当 followup 排回队首", async () => {
    const { queue, tid, deps } = await setup({
      steerImpl: async () => {
        throw new Error("steer boom");
      },
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();

    expect(queue.listQueuedChatMessages(tid)[0]?.itemId).toBe("cq_target");
    expect(queue.isMessageOperationTerminal(tid, "cq_target")).toBe(false);
    queue.clearChatQueue(tid);
  });

  it("不能 steer（pi 后端 / 冷启动 / 收尾空窗）→ 回退打断重发（stop + start）", async () => {
    const { queue, tid, order, deps, steerDeps } = await setup({
      canSteer: false,
    });

    const res = await sendQueuedChatMessageNow(
      tid,
      "cq_target",
      validBoot,
      deps,
    );

    expect(res.status).toBe(202);
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(steerDeps.persistReply).not.toHaveBeenCalled();
    expect(steerDeps.steer).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    queue.clearChatQueue(tid);
  });

  it("落盘失败 → 500、消息放回队首、绝不 steer", async () => {
    const { queue, tid, deps, steerDeps } = await setup({ persistOk: false });

    const res = await sendQueuedChatMessageNow(
      tid,
      "cq_target",
      validBoot,
      deps,
    );

    expect(res.status).toBe(500);
    expect(steerDeps.steer).not.toHaveBeenCalled();
    expect(queue.listQueuedChatMessages(tid)[0]?.itemId).toBe("cq_target");
    queue.clearChatQueue(tid);
  });

  it("任务已被删（落盘 ENOENT）→ 404、记 task_gone", async () => {
    const { queue, tid, deps, steerDeps } = await setup({
      persistOk: "task_gone",
    });

    const res = await sendQueuedChatMessageNow(
      tid,
      "cq_target",
      validBoot,
      deps,
    );

    expect(res.status).toBe(404);
    expect(steerDeps.steer).not.toHaveBeenCalled();
    expect(queue.findRecentSettledEntry(tid, "cq_target")?.outcome).toBe(
      "task_gone",
    );
    queue.clearChatQueue(tid);
  });

  it("队列里没这条 → 404，什么都不动", async () => {
    const { queue, tid, deps, steerDeps } = await setup();

    const res = await sendQueuedChatMessageNow(
      tid,
      "cq_missing",
      validBoot,
      deps,
    );

    expect(res.status).toBe(404);
    expect(steerDeps.flushAssistant).not.toHaveBeenCalled();
    expect(steerDeps.persistReply).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
    queue.clearChatQueue(tid);
  });

  it("入队方已落过气泡（skipPersistEvent）→ 仍走 steer，由 persistReply 只推进 operation", async () => {
    const { queue, tid, deps, steerDeps } = await setup({
      extraMsg: { skipPersistEvent: true },
    });

    await sendQueuedChatMessageNow(tid, "cq_target", validBoot, deps);
    await settleTail();

    expect(steerDeps.persistReply).toHaveBeenCalledTimes(1);
    expect(steerDeps.persistReply.mock.calls[0]?.[1].skipPersistEvent).toBe(
      true,
    );
    expect(queue.isMessageHandedOff(tid, "cq_target")).toBe(true);
    queue.clearChatQueue(tid);
  });
});
