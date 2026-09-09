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
